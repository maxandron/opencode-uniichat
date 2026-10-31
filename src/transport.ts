import type { Plugin } from "@opencode/plugin/effect";
import { Message, type SystemPart } from "@opencode/ai/effect";
import { Session } from "@opencode/schema/session";
import { Data, Deferred, Effect } from "effect";

// Model calls of UniiChat's own (compactions and /btw memory lookups) go through OpenCode, with the
// user's own providers and credentials. OpenCode lets a plugin set a request's system, messages and
// options only in a hook, so each call gets a throwaway child session: `session.generate` on it,
// UniiChat's `generate` hook swaps in the prepared request, and the session is removed after.

export interface Call {
  /** The chat's session; the throwaway session is its child, so it shares the chat's cache key. */
  parentID: string;
  model: { providerID: string; id: string; variant?: string };
  system: string;
  messages: readonly Message[];
  /** Tool names to keep, in this order, from what OpenCode offers the throwaway session. */
  tools: readonly string[];
  /** Generation settings (e.g. maxTokens) and provider options, as OpenCode's request options. */
  options: Record<string, unknown>;
  /** Succeeds when the provider's response headers arrive. */
  started?: Deferred.Deferred<void>;
}

/** The fields of OpenCode's `generate` hook event that a call replaces. */
export interface GenerateEvent {
  readonly sessionID: string;
  system: SystemPart[];
  messages: Message[];
  tools: Record<string, { description: string; input: unknown }>;
  options: Record<string, unknown>;
}

export const METADATA = { uniichat: "call" } as const;

export class TransportError extends Data.TaggedError("UniiChatTransportError")<{ message: string }> {}

/** Calls in flight and every throwaway session ever made, shared by all UniiChat instances in the process. */
export interface Registry {
  readonly pending: Map<string, { call: Call; applied: boolean }>;
  /** So late events about a throwaway session are never taken for a subagent's. */
  readonly known: Set<string>;
}

// OpenCode can integrate the plugin more than once in a server process (location boots, config
// reloads, a package update), and a chat keeps the instance that first opened it. The `generate`
// hook that answers a call may belong to another instance, so every instance must find every call.
const REGISTRY = Symbol.for("opencode-uniichat.transport.v1");
export function registry(): Registry {
  const global = globalThis as { [REGISTRY]?: Registry };
  return global[REGISTRY] ??= { pending: new Map(), known: new Set() };
}

export function make(ctx: Plugin.Context, { pending, known }: Registry = registry()) {

  const run = (call: Call) => Effect.scoped(Effect.gen(function* () {
    const session = yield* ctx.session.create({
      parentID: Session.ID.make(call.parentID),
      title: "UniiChat",
      model: call.model as never,
      metadata: { ...METADATA },
    });
    const entry = { call, applied: false };
    pending.set(session.id, entry);
    known.add(session.id);
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      pending.delete(session.id);
      yield* ctx.session.remove({ sessionID: session.id }).pipe(Effect.ignore);
    }));
    const started = call.started;
    // Only while this call runs, and only for its provider: OpenCode wraps every request to a
    // provider that has HTTP hooks.
    const scope = { providerID: call.model.providerID };
    // Tools ride along only so the call shares the chat's cache; OpenCode's generate returns text
    // alone, so a tool call would come back empty. Forbid tool use in the provider's own terms.
    if (call.tools.length > 0) {
      yield* ctx.session.hook("http.request", (event) => event.sessionID !== session.id ? Effect.void : Effect.promise(() => withoutToolUse(event.request)).pipe(
        Effect.map((request) => { event.request = request; }),
      ), scope);
    }
    let stream: Promise<string> | undefined;
    let status = 0;
    yield* ctx.session.hook("http.response", (event) => Effect.suspend(() => {
      if (event.sessionID !== session.id) return Effect.void;
      status = event.response.status;
      // Kept to explain an empty answer: OpenCode's generate returns the text alone.
      try { stream = streamTail(event.response.clone()); } catch { /* body already taken */ }
      return started ? Deferred.succeed(started, undefined).pipe(Effect.asVoid) : Effect.void;
    }), scope);
    // The placeholder names the call, so a request that went out unswapped is traceable in logs.
    const result = yield* ctx.session.generate({ sessionID: session.id, prompt: `UniiChat call ${session.id}` });
    // Fail closed: without the swap the model answered the placeholder, and its text is junk.
    if (!entry.applied) {
      return yield* Effect.fail(new TransportError({ message: `UniiChat call ${session.id} went out without its request: no UniiChat generate hook applied it` }));
    }
    if (result.text.trim() === "") {
      const tail = stream ? yield* Effect.promise(() => Promise.race([stream!, new Promise<string>((done) => setTimeout(() => done(""), 2000))])) : "";
      yield* Effect.logWarning(`UniiChat call ${session.id} (${call.model.providerID}/${call.model.id}) returned no text; HTTP ${status || "none"}; ${describeStream(tail)}`);
    }
    return result.text;
  }));

  /** Applies a pending call to its `generate` request; false if the session is not one of ours. */
  const apply = (event: GenerateEvent): boolean => {
    const entry = pending.get(event.sessionID);
    if (!entry) return false;
    const call = entry.call;
    event.system = [{ type: "text", text: call.system }];
    event.messages = [...call.messages];
    const offered = event.tools;
    event.tools = Object.fromEntries(call.tools.flatMap((name) => offered[name] ? [[name, offered[name]] as const] : []));
    for (const key of Object.keys(event.options)) delete event.options[key];
    Object.assign(event.options, call.options);
    entry.applied = true;
    return true;
  };

  return { run, apply, owns: (sessionID: string) => known.has(sessionID) };
}

export type Transport = ReturnType<typeof make>;

/**
 * The request with tool use forbidden, for the APIs whose shape is known: Anthropic Messages,
 * OpenAI Responses and Chat Completions, Gemini. Anything else goes out unchanged.
 */
export async function withoutToolUse(request: Request): Promise<Request> {
  if (request.method !== "POST") return request;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await request.clone().text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return request;
    body = parsed as Record<string, unknown>;
  } catch {
    return request;
  }
  if (body.tools === undefined) return request;
  const path = new URL(request.url).pathname;
  if (path.endsWith("/messages")) body.tool_choice = { type: "none" };
  else if (path.endsWith("/responses") || path.endsWith("/chat/completions")) body.tool_choice = "none";
  else if (/:(stream)?generateContent$/i.test(path)) {
    delete body.tool_config;
    body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  } else return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal });
}

const TAIL = 64_000;

/** The last part of a response body, read beside OpenCode's own reading of it; "" if it fails. */
export async function streamTail(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-TAIL);
    }
  } catch {
    // The call was interrupted; keep what arrived.
  }
  return tail;
}

/** What a response body says about why it ended and what it held, for a log line. */
export function describeStream(body: string): string {
  if (body === "") return "response body unavailable";
  const count = (pattern: RegExp) => {
    const seen = new Map<string, number>();
    for (const match of body.matchAll(pattern)) seen.set(match[1]!, (seen.get(match[1]!) ?? 0) + 1);
    return [...seen].map(([key, n]) => `${key}×${n}`).join(", ") || "none";
  };
  const ends = count(/"(?:stop_reason|finish_reason|finishReason|status)"\s*:\s*"([A-Za-z_]+)"/g);
  const items = count(/"type"\s*:\s*"(function_call|tool_use|tool_call|custom_tool_call|message|output_text|text|reasoning|thinking|refusal)"/g);
  const tools = count(/"(?:type)"\s*:\s*"(?:function_call|tool_use|custom_tool_call)"[^}]*?"name"\s*:\s*"([^"]+)"/g);
  return `ends: ${ends}; items: ${items}; tool calls: ${tools}`;
}

/** One user message of text parts, with cache marks where asked. */
export function userMessage(parts: ReadonlyArray<{ text: string; cache?: boolean }>) {
  return new Message({
    role: "user",
    content: parts.map((part) => ({ type: "text" as const, text: part.text, ...(part.cache ? { cache: { type: "ephemeral" as const } } : {}) })),
  });
}

export function textMessage(role: "user" | "assistant", parts: ReadonlyArray<{ text: string; cache?: boolean }>) {
  return role === "user" ? userMessage(parts) : new Message({ role, content: parts.map((part) => ({ type: "text" as const, text: part.text })) });
}
