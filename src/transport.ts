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
    if (started) {
      // Only while this call runs, and only for its provider: OpenCode wraps every request to a
      // provider that has HTTP hooks.
      yield* ctx.session.hook("http.response", (event) =>
        event.sessionID === session.id ? Deferred.succeed(started, undefined).pipe(Effect.asVoid) : Effect.void,
      { providerID: call.model.providerID });
    }
    // The placeholder names the call, so a request that went out unswapped is traceable in logs.
    const result = yield* ctx.session.generate({ sessionID: session.id, prompt: `UniiChat call ${session.id}` });
    // Fail closed: without the swap the model answered the placeholder, and its text is junk.
    if (!entry.applied) {
      return yield* Effect.fail(new TransportError({ message: `UniiChat call ${session.id} went out without its request: no UniiChat generate hook applied it` }));
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
