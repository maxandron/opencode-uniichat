import type { Schema } from "effect";
import type { SessionMessage } from "@opencode/schema/session-message";
import type { ContentPart, Message, SystemPart } from "@opencode/ai/effect";
import { failureNote } from "./prompts.ts";
import { echoText, toolResultSrc, toolText, type Kind } from "./record.ts";

export type Row = Schema.Codec.Encoded<typeof SessionMessage.Info>;
export interface Segment {
  key: string;
  rows: Row[];
  ids: Set<string>;
}
export interface Item {
  kind: Kind;
  text: string;
  date: number;
  src: string;
  files?: { name: string; mime: string; data?: Uint8Array }[];
}
export type RequestMessage = Pick<Message, "id" | "role" | "content" | "metadata" | "providerMetadata" | "native">;
export interface RequestInput {
  messages: readonly RequestMessage[];
  turnIds: ReadonlySet<string>;
  view: { blocks: readonly string[]; tail: string };
  state?: string;
  reports: ReadonlyMap<string, string>;
  child?: boolean;
}

export function segments(rows: readonly Row[]): Segment[] {
  const result: Segment[] = [{ key: "start", rows: [], ids: new Set() }];
  for (const row of rows) {
    if (row.type === "idle") {
      result.push({ key: row.id, rows: [], ids: new Set() });
      continue;
    }
    const segment = result[result.length - 1]!;
    segment.rows.push(row);
    segment.ids.add(row.id);
  }
  return result;
}

export function turnKey(rows: readonly Row[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.type === "idle") return rows[i]!.id;
  }
  return "start";
}

export function subagentReport(text: string): string {
  const first = text.indexOf("\n");
  const last = text.lastIndexOf("\n");
  if (!text.startsWith("<subagent ") || !text.endsWith("</subagent>") || first < 0 || last <= first) {
    return text;
  }
  return text.slice(first + 1, last);
}

export function items(rows: readonly Row[], opts: { name: (childID: string) => string }): Item[] {
  const result: Item[] = [];
  for (const row of rows) {
    const date = row.time.created;
    if (row.type === "user") {
      const files = (row.files ?? []).map((file) => ({
        name: file.name ?? (file.source.type === "uri" ? file.source.uri : "attachment"),
        mime: file.mime,
        data: new Uint8Array(Buffer.from(file.data, "base64")),
      }));
      result.push({ kind: "user", text: row.text, date, src: row.id, ...(files.length ? { files } : {}) });
      continue;
    }
    if (row.type === "skill") {
      // A skill the user invoked directly; logged so its instructions outlive the turn.
      result.push({ kind: "user", text: row.text, date, src: row.id });
      continue;
    }
    if (row.type === "synthetic" && row.metadata?.source === "subagent") {
      if (typeof row.metadata.childID !== "string") throw new Error("Subagent report has no childID");
      result.push({ kind: "work", text: `[${opts.name(row.metadata.childID)}] ${subagentReport(row.text)}`, date, src: row.id });
      continue;
    }
    if (row.type !== "assistant") continue;
    row.content.forEach((part, index) => {
      if (part.type === "text" && part.text !== "") {
        result.push({ kind: "unii", text: part.text, date, src: `${row.id}:${index}` });
      } else if (part.type === "tool" && part.state.status !== "streaming") {
        result.push({ kind: "tool", text: toolText(part.name, part.state.input), date, src: `${part.id}:call` });
      }
    });
    for (const part of row.content) {
      if (part.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) continue;
      const content = part.state.content ?? [];
      const text = content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      const files = content.flatMap((file) => {
        if (file.type !== "file") return [];
        const base64 = /^data:[^,]*;base64,([\s\S]*)$/.exec(file.uri);
        return [{
          name: file.name ?? "attachment",
          mime: file.mime,
          ...(base64 ? { data: new Uint8Array(Buffer.from(base64[1]!, "base64")) } : {}),
        }];
      });
      result.push({
        kind: "echo",
        text: echoText(text || (part.state.status === "error" ? part.state.error.message : ""), part.state.status === "error"),
        date: part.time.completed ?? date,
        src: toolResultSrc(part.id),
        ...(files.length ? { files } : {}),
      });
    }
    // A turn that failed or was stopped leaves a note, so memory knows it ended without a reply.
    if (row.error) result.push({ kind: "note", text: failureNote(row.error.type, row.error.message), date: row.time.completed ?? date, src: `${row.id}:error` });
  }
  return result;
}

export function selectLogged(parts: readonly Segment[], hasSrcPrefix: (id: string) => boolean, currentEnabled: boolean): Segment[] {
  return parts.filter((part, index) => (currentEnabled && index === parts.length - 1) || [...part.ids].some(hasSrcPrefix));
}

// UniiChat's compaction hook answers with this stub, so OpenCode skips its own summary. OpenCode still
// records a completed compaction and starts the session's context there; UniiChat sees past stubs.
export const STUB_SUMMARY = "UniiChat is on; native compaction is skipped.";
export const STUB_METADATA = { uniichat: "skipped" } as const;

export function isStub(row: Row): boolean {
  if (row.type !== "compaction" || row.status !== "completed") return false;
  // Untagged stubs predate the tag (Oct 16).
  return row.metadata?.uniichat === STUB_METADATA.uniichat || row.summary === STUB_SUMMARY;
}

/** The current turn is cut by a real (non-stub) compaction checkpoint. */
export function cutTurn(rows: readonly Row[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type === "idle") return false;
    if (row.type === "compaction" && row.status === "completed" && !isStub(row)) return true;
  }
  return false;
}

/** The current turn holds a stub, so the context OpenCode loaded misses the turn's start. */
export function stubCut(rows: readonly Row[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type === "idle") return false;
    if (isStub(row)) return true;
  }
  return false;
}

export function buildRequest(input: RequestInput): RequestMessage[] {
  const start = input.child ? 0 : input.messages.findIndex((message) => message.id !== undefined && input.turnIds.has(message.id));
  if (start < 0) throw new Error("UniiChat turn cut by an OpenCode compaction checkpoint; the current raw turn is no longer available.");
  const messages = input.messages.slice(start).filter((message) => message.role !== "system").map((message): RequestMessage => {
    const report = message.id === undefined ? undefined : input.reports.get(message.id);
    const content: readonly ContentPart[] = report === undefined ? message.content : [{ type: "text", text: report }];
    return {
      ...message,
      content: content.map((part) => {
        // Old request-end marks must not move into the middle of a continuation.
        const { cache: _cache, ...rest } = part as ContentPart & { cache?: unknown };
        return rest as ContentPart;
      }),
    };
  });
  const prefix: ContentPart[] = input.view.blocks.map((text, index) => ({
    type: "text",
    text,
    ...(index === input.view.blocks.length - 1 ? { cache: { type: "ephemeral" as const } } : {}),
  }));
  prefix.push({ type: "text", text: input.view.tail });
  if (!input.child && input.state !== undefined) prefix.push({ type: "text", text: input.state });
  if (messages[0]?.role === "user") messages[0] = { ...messages[0], content: [...prefix, ...messages[0].content] };
  else messages.unshift({ role: "user", content: prefix });
  const last = messages[messages.length - 1]!;
  for (let i = last.content.length - 1; i >= 0; i--) {
    const part = last.content[i]!;
    if (part.type === "reasoning") continue;
    messages[messages.length - 1] = {
      ...last,
      content: last.content.map((part, index) => index === i ? { ...part, cache: { type: "ephemeral" } } as ContentPart : part),
    };
    break;
  }
  return messages;
}

// A /btw request: the view, the raw turn still in progress (if any), then the question.
// Unlike a turn request it never fails: with no turn in progress only the view precedes the question.
export function btwRequest(input: {
  messages: readonly RequestMessage[];
  turnIds: ReadonlySet<string>;
  view: { blocks: readonly string[]; tail: string };
  reports: ReadonlyMap<string, string>;
  extra?: string;
}): RequestMessage[] {
  const question = input.messages.at(-1);
  if (!question || question.role !== "user") throw new Error("UniiChat /btw request has no question.");
  const start = input.messages.findIndex((message) => message.id !== undefined && input.turnIds.has(message.id));
  const raw = start < 0 ? [] : input.messages.slice(start, -1);
  const last = input.extra === undefined ? question : { ...question, content: [...question.content, { type: "text", text: input.extra } as ContentPart] };
  // `child` builds from the first message on and adds no per-turn state, which is what a side question needs.
  return buildRequest({ messages: [...raw, last], turnIds: input.turnIds, view: input.view, reports: input.reports, child: true });
}

export const EMPTY_CATALOG = "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool.";

export function extractCatalog(systemParts: readonly (SystemPart | string)[]): string | undefined {
  for (const part of systemParts) {
    const text = typeof part === "string" ? part : part.text;
    if (!text.startsWith("# Code Mode") && !text.startsWith(EMPTY_CATALOG)) continue;
    const end = /\n\n(?=<mcp_instructions>|Project references provide additional directories|Skills provide specialized instructions|Instructions from: |Today's date: )/.exec(text);
    return end ? text.slice(0, end.index) : text;
  }
  return undefined;
}

/** OpenCode's skills section (`skill/instructions.ts` render()), or undefined when absent. */
export function extractSkills(systemParts: readonly (SystemPart | string)[]): string | undefined {
  for (const part of systemParts) {
    const text = typeof part === "string" ? part : part.text;
    const match = /(?:^|\n\n)(Skills provide specialized instructions[\s\S]*?(?:<\/available_skills>|No skills are currently available\.))/.exec(text);
    if (match) return match[1];
  }
  return undefined;
}
