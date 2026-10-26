import { Plugin } from "@opencode/plugin/effect";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { Message } from "@opencode/ai";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Tool } from "@opencode/schema/tool";
import { Cause, Data, DateTime, Effect, Exit, Layer, Schema, Semaphore, Stream } from "effect";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as engine from "./chat.ts";
import * as compactor from "./compactor.ts";
import * as transports from "./transport.ts";
import * as config from "./options.ts";
import * as env from "./env.ts";
import * as history from "./history.ts";
import * as turn from "./turn.ts";
import { hostMessages, toMessages } from "./messages.ts";
import { chatDir } from "./store.ts";
import { btwMemory, lookupCalls, lookupResults, systemText, stateText, ZOOM_DESCRIPTION, DATE_DESCRIPTION } from "./prompts.ts";
import { UniiChatRpc, statusValue } from "./rpc.ts";

export class IntegrationError extends Data.TaggedError("UniiChatIntegrationError")<{ message: string }> {}
type Chat = Pick<engine.Chat, "log" | "logAgent" | "agentName" | "system" | "setSystem" | "setTools" | "awaitSummarized" | "renderView" | "zoom" | "date" | "status" | "latestSource" | "undoneFrom" | "rewind">;
export interface IntegrationOptions {
  /** Plugin options; defaults to `ctx.options`. */
  options?: unknown;
  /** Replaces OpenCode-backed model calls (tests). */
  transport?: Pick<transports.Transport, "run" | "apply" | "owns">;
  get?: (sessionID: string, deps: engine.Deps) => Effect.Effect<Chat, unknown>;
  sources?: (sessionID: string) => Effect.Effect<Set<string>, unknown>;
  older?: (sessionID: string, has: (row: history.Row) => boolean) => Effect.Effect<readonly history.Row[] | undefined, unknown>;
}
const memos = new Map<string, turn.Memo>();
const parents = new Map<string, string | undefined>();
const locks = new Map<string, Semaphore.Semaphore>();
const indexes = new Map<string, { sources: Set<string>; recovered: boolean }>();
const error = (cause: unknown) => new IntegrationError({ message: cause instanceof Error ? cause.message : String(cause) });
const id = (sessionID: string) => Session.ID.make(sessionID);

function serialized<A, E, R>(sessionID: string, effect: Effect.Effect<A, E, R>) {
  let lock = locks.get(sessionID);
  if (!lock) locks.set(sessionID, lock = Semaphore.makeUnsafe(1));
  return lock.withPermits(1)(effect);
}

function sources(sessionID: string) {
  return Effect.try({
    try: () => {
      const dir = join(chatDir(sessionID), "main");
      const bases = new Set<string>();
      for (const file of readdirSync(dir).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort()) {
        for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
          let row: { src?: string };
          try { row = JSON.parse(line); } catch { continue; }
          if (typeof row.src === "string") bases.add(row.src.split(":")[0]!);
        }
      }
      return bases;
    },
    catch: error,
  });
}

// Our schema copy can lag the running OpenCode (2.1.0 dropped compaction `recent`, failing every step).
// If it rejects a row, convert decoded values by hand instead of failing the session.
const encodeRow = Schema.encodeSync(SessionMessage.Info);
export function toWire(row: SessionMessage.Info): history.Row {
  try { return encodeRow(row); } catch { return plain(row) as history.Row; }
}
export function plain(value: unknown): unknown {
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value);
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, plain(v)]));
  return value;
}

function older(sessionID: string, has: (row: history.Row) => boolean) {
  return Effect.tryPromise({
    try: async () => {
      const endpoint = await Service.discover();
      if (!endpoint) return undefined;
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
      if ((await client.server.info()).pid !== process.pid) return undefined;
      const rows: history.Row[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "desc" as const }) });
        for (const row of page.data) {
          rows.push(row as history.Row);
          if (has(row as history.Row)) return rows.reverse();
        }
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
      return rows.reverse();
    },
    catch: error,
  });
}

/**
 * The request for a turn read past a stub: the turn's rows before the latest stub, rebuilt as OpenCode
 * would send them, then OpenCode's own messages from the stub on, without the stub's checkpoint message.
 */
export function restoreTurn(rows: readonly history.Row[], messages: readonly Message[], model: { providerID: string; id: string; variant?: string }): Message[] {
  const at = rows.findLastIndex(history.isStub);
  const stubs = new Set(rows.filter(history.isStub).map((row) => row.id));
  const before = toMessages(rows.slice(0, at).filter((row) => row.type !== "compaction"), model);
  return [...before, ...messages.filter((message) => message.id === undefined || !stubs.has(message.id))];
}

export const integrate = (ctx: Plugin.Context, options: IntegrationOptions = {}) => Effect.gen(function* () {
  const settings = config.parse(options.options ?? ctx.options);
  config.configure(settings);
  const transport = options.transport ?? transports.make(ctx);
  // The compaction model: the configured one, else the newest Anthropic Claude Haiku OpenCode lists.
  let chosen: compactor.Model | undefined;
  const compactionModel = Effect.gen(function* () {
    if (chosen) return chosen;
    if (settings.compaction.model) return chosen = config.modelRef(settings.compaction.model, settings.compaction.variant);
    const haiku = env.latestHaiku((yield* ctx.model.list()).data);
    if (!haiku) return yield* Effect.fail(error("UniiChat found no Claude Haiku model for compaction; set the plugin option compaction.model to \"providerID/modelID\"."));
    return chosen = { providerID: "anthropic", id: haiku.modelID, ...(settings.compaction.variant ? { variant: settings.compaction.variant } : {}) };
  });
  const depsFor = (sessionID: string): engine.Deps => ({
    compact: (input) => Effect.gen(function* () {
      const model = yield* compactionModel;
      const providerOptions = settings.compaction.providerOptions ?? {};
      return yield* compactor.generate(transport, {
        ...input, parentID: sessionID, model,
        options: { maxTokens: settings.compaction.maxTokens, ...structuredClone(providerOptions) },
      });
    }),
  });
  const get = (sessionID: string) => (options.get ?? engine.get)(sessionID, depsFor(sessionID));
  const state = (sessionID: string) => ctx.storage.get(`session/${sessionID}`).pipe(Effect.map((value): turn.Switch => {
    // A session never switched follows the defaultOn option.
    if (!value || typeof value !== "object" || Array.isArray(value)) return settings.defaultOn ? { on: true, render: true } : { on: false };
    const record = value as { on?: unknown; render?: unknown };
    return { on: record.on === true, render: record.render === true };
  }));
  // Effect APIs return decoded DateTime values. The log mapper accepts wire rows.
  const readHistory = (sessionID: string) => ctx.session.context({ sessionID: id(sessionID) }).pipe(
    Effect.map((rows) => rows.map(toWire)),
  );
  // A UniiChat stub compaction inside the current turn makes OpenCode's context start at the stub,
  // so the turn's start is missing. Read the turn from its opening idle on, from the full list.
  // `rebuilt` is false when the full list is unreachable; then only the latest context is known.
  const turnHistory = Effect.fn(function* (sessionID: string) {
    const rows = yield* readHistory(sessionID);
    if (!history.stubCut(rows)) return { rows, rebuilt: false };
    const full = yield* (options.older ?? older)(sessionID, (row) => row.type === "idle").pipe(
      Effect.catchCause((cause) => Effect.logWarning("UniiChat could not read the turn behind a compaction stub", cause).pipe(Effect.as(undefined))),
    );
    if (!full || !rows.every((row) => full.some((other) => other.id === row.id))) return { rows, rebuilt: false };
    return { rows: full, rebuilt: true };
  });
  const parent = Effect.fn(function* (sessionID: string) {
    if (!parents.has(sessionID)) parents.set(sessionID, (yield* ctx.session.get({ sessionID: id(sessionID) })).parentID);
    return parents.get(sessionID);
  });
  const isEnabled = Effect.fn(function* (sessionID: string) {
    return turn.enabled(yield* state(sessionID), memos.get(sessionID));
  });
  const target = Effect.fn(function* (sessionID: string) {
    return (yield* parent(sessionID)) ?? sessionID;
  });
  const nameFor = (chat: Chat, rows: readonly history.Row[], childID: string) => {
    const report = rows.find((row) => row.type === "synthetic" && row.metadata?.childID === childID);
    const agent = report?.metadata?.agent;
    return chat.agentName(childID, typeof agent === "string" ? agent : "agent");
  };
  const log = Effect.fn(function* (sessionID: string, chat: Chat, rows: readonly history.Row[]) {
    const items = history.items(rows, { name: (childID) => nameFor(chat, rows, childID) });
    const index = indexes.get(sessionID)!;
    const result = yield* chat.log(items).pipe(Effect.exit);
    if (Exit.isFailure(result)) {
      // A failed append can still leave flushed pages that must select this segment.
      const persisted = yield* (options.sources ?? sources)(sessionID);
      for (const src of persisted) index.sources.add(src);
      return yield* Effect.failCause(result.cause);
    }
    for (const item of items) index.sources.add(item.src.split(":")[0]!);
  });
  const reconcile = Effect.fn(function* (sessionID: string, chat: Chat, rows: readonly history.Row[], current: boolean, excluded: ReadonlySet<string> = new Set()) {
    let index = indexes.get(sessionID);
    if (!index) {
      index = { sources: yield* (options.sources ?? sources)(sessionID), recovered: false };
      indexes.set(sessionID, index);
    }
    const has = (row: history.Row) => index!.sources.has(row.id) || (row.type === "assistant" && row.content.some((part) => part.type === "tool" && index!.sources.has(part.id)));
    const selected = (rows: readonly history.Row[], current: boolean) => {
      const parts = history.segments(rows);
      const recorded = new Set(parts.filter((part) => part.rows.some(has)).flatMap((part) => [...part.ids]));
      return history.selectLogged(parts, (id) => recorded.has(id), current);
    };
    if (!index.recovered) {
      if (index.sources.size === 0) {
        // First switch-on: an empty store means earlier turns of this session ran vanilla.
        // Import them, from before any native compaction checkpoint when the full list is reachable,
        // so memory starts at the start of the session rather than at /unii on.
        const full = yield* (options.older ?? older)(sessionID, () => false).pipe(
          Effect.catchCause((cause) => Effect.logWarning("UniiChat earlier-turn import fell back to the latest context", cause).pipe(Effect.as(undefined))),
        );
        const now = history.segments(rows).at(-1)!.ids;
        const earlier = history.segments(full ?? rows).filter((part) => ![...part.ids].some((id) => now.has(id)));
        for (const part of earlier) {
          yield* log(sessionID, chat, part.rows.filter((row) => !excluded.has(row.id) && !now.has(row.id)));
        }
        index.recovered = true;
      } else {
        const full = yield* (options.older ?? older)(sessionID, has);
        if (full) {
          for (const part of selected(full, false)) {
            yield* log(sessionID, chat, part.rows.filter((row) => !excluded.has(row.id)));
          }
          index.recovered = true;
        } else if (rows.some(has)) {
          // An anchor in the latest context proves that the missed tail is in it.
          index.recovered = true;
        } else {
          yield* Effect.logWarning("UniiChat older-history recovery skipped: no discoverable OpenCode service belongs to this server process. A crash tail before the latest checkpoint may be missing.");
          index.recovered = true;
        }
      }
    }
    for (const part of selected(rows, current)) yield* log(sessionID, chat, part.rows.filter((row) => !excluded.has(row.id)));
  });
  // OpenCode's /undo deletes the undone messages when the next prompt commits it. Drop their
  // records too, so memory matches the session and the restored files (amends "never delete").
  const dropUndone = Effect.fn(function* (sessionID: string, chat: Chat, rows: readonly history.Row[]) {
    const present = new Set<string>();
    const add = (rows: readonly history.Row[]) => {
      for (const row of rows) {
        present.add(row.id);
        if (row.type === "assistant") for (const part of row.content) if (part.type === "tool") present.add(part.id);
      }
    };
    add(rows);
    const latest = chat.latestSource();
    if (latest === undefined || present.has(latest)) return;
    let k = chat.undoneFrom((base) => present.has(base));
    if (k === undefined) {
      // The context starts at a compaction checkpoint and holds no logged message, so the undo
      // anchor (the latest logged message still in the session) is further back: page for it.
      const logged = indexes.get(sessionID)?.sources ?? (yield* (options.sources ?? sources)(sessionID));
      const has = (row: history.Row) => logged.has(row.id) || (row.type === "assistant" && row.content.some((part) => part.type === "tool" && logged.has(part.id)));
      const full = yield* (options.older ?? older)(sessionID, has).pipe(
        Effect.catchCause((cause) => Effect.logWarning("UniiChat undo check could not read the session past its checkpoint", cause).pipe(Effect.as(undefined))),
      );
      if (!full?.some(has)) return;
      add(full);
      k = chat.undoneFrom((base) => present.has(base));
    }
    if (k === undefined) return;
    const dropped = yield* chat.rewind(k);
    const index = indexes.get(sessionID);
    if (index) for (const base of dropped) index.sources.delete(base);
    yield* Effect.logInfo(`UniiChat dropped records from ${k} on: their messages were undone`);
  });
  const set = (sessionID: string, on: boolean) => serialized(sessionID, Effect.gen(function* () {
    const rows = on ? yield* readHistory(sessionID) : [];
    const memo = turn.switchMemo(on, history.turnKey(rows), rows, memos.get(sessionID));
    if (memo) memos.set(sessionID, memo);
    else memos.delete(sessionID);
    yield* ctx.storage.set(`session/${sessionID}`, on ? { on: true, render: true } : { on: false });
    return { on };
  })).pipe(Effect.orDie);

  yield* ctx.session.hook("context", (event) => serialized(event.sessionID, Effect.gen(function* () {
    const sessionID = event.sessionID;
    if (transport.owns(sessionID)) return;
    const switchState = yield* state(sessionID);
    const parentID = yield* parent(sessionID);
    const child = parentID !== undefined && (yield* isEnabled(parentID));
    const removeTools = () => { delete event.tools.zoom; delete event.tools.date; };
    if (parentID && !child || !parentID && !turn.enabled(switchState, memos.get(sessionID))) {
      removeTools();
      return;
    }
    const { rows, rebuilt } = child ? { rows: yield* readHistory(sessionID), rebuilt: false } : yield* turnHistory(sessionID);
    const decision = turn.begin(history.turnKey(rows), child ? { on: true } : switchState, memos.get(sessionID));
    const memo = decision.memo;
    memos.set(sessionID, memo);
    if (!memo.enabled) { removeTools(); return; }
    const chatID = child ? parentID! : sessionID;
    const chat = yield* get(chatID);
    const session = yield* ctx.session.get({ sessionID });
    const location = { directory: session.location.directory, projectDirectory: ctx.location.project.directory };
    const parts = history.segments(rows);
    const current = parts.at(-1)!;
    const first = decision.first || memo.frozen === undefined;
    if (child) {
      if (decision.first || !memo.frozen) memo.frozen = chat.renderView();
      const name = chat.agentName(sessionID, event.agent);
      yield* chat.logAgent(name, turn.childItems(sessionID, history.items(rows, { name: (childID) => nameFor(chat, rows, childID) })));
    } else {
      if (first && (switchState.render || chat.system() === undefined)) {
        yield* chat.setSystem(systemText(settings.prompts.system, history.extractCatalog(event.system), yield* env.agentsMd(location), history.extractSkills(event.system)));
        yield* ctx.storage.set(`session/${sessionID}`, { on: switchState.on });
      }
      yield* chat.setTools(Object.entries(event.tools).map(([name, tool]) => ({ name, ...tool })));
      yield* dropUndone(sessionID, chat, rows);
      if (first) {
        // The current input must not enter the view frozen for this turn.
        yield* reconcile(sessionID, chat, rows, false, current.ids);
        yield* chat.awaitSummarized();
        memo.frozen = chat.renderView();
      }
      yield* reconcile(sessionID, chat, rows, true);
    }
    if (child) {
      // A child keeps its own agent's system prompt (D15, revised Oct 12); only a note on the view is added.
      event.system = [...event.system, { type: "text", text: settings.prompts.subagent }];
    } else {
      const system = chat.system();
      if (system === undefined) return yield* Effect.fail(error("UniiChat's system prompt is not initialized."));
      event.system = [{ type: "text", text: system }];
    }
    if (!child && history.cutTurn(rows)) return yield* Effect.fail(error("UniiChat turn cut by an OpenCode compaction checkpoint; the current raw turn is no longer available."));
    const reports = new Map(history.items(current.rows, { name: (childID) => nameFor(chat, current.rows, childID) })
      .filter((item) => item.kind === "work").map((item) => [item.src, item.text]));
    const perTurnState = child ? undefined : stateText(yield* env.stateInput(location));
    const messages = rebuilt ? restoreTurn(rows, event.messages, event.model) : event.messages;
    event.messages = (yield* Effect.try({
      try: () => history.buildRequest({ messages, turnIds: current.ids, view: memo.frozen!, reports, child, state: perTurnState }),
      catch: error,
    })).map(hostMessages(event.messages));
  })).pipe(Effect.orDie));

  // /btw (session.generate) runs one model call with no tool loop. Give it Unii's prompt, the view
  // and the raw turn in progress instead of OpenCode's whole uncompacted history, which Unii keeps
  // growing because native compaction is skipped. Before it, the model may open memory: zoom/date
  // calls written as text (OpenCode's generate API returns text only), answered here, in a loop.
  const lookup = Effect.fn(function* (chat: Chat, input: { sessionID: string; model: compactor.Model; system: string; messages: Message[] }) {
    const convo = [...input.messages];
    const opened: { call: string; text: string }[] = [];
    for (let i = 0; i < settings.btw.lookupSteps; i++) {
      const reply = yield* transport.run({
        parentID: input.sessionID, model: input.model, system: input.system, messages: convo, tools: [],
        options: { maxTokens: settings.btw.maxTokens },
      });
      const calls = lookupCalls(reply);
      if (calls.length === 0) break;
      const results: { call: string; text: string }[] = [];
      for (const call of calls) {
        const text = yield* (call.name === "zoom" ? chat.zoom(call.id, call.n) : chat.date(call.id as number)).pipe(
          Effect.map((result) => result.text),
          Effect.catchCause((cause) => Effect.succeed(`Error: ${Cause.pretty(cause)}`)),
        );
        results.push({ call: call.text, text });
      }
      opened.push(...results);
      convo.push(transports.textMessage("assistant", [{ text: reply }]), transports.userMessage([{ text: lookupResults(results) }]));
    }
    return opened;
  });
  yield* ctx.session.hook("generate", (event) => Effect.gen(function* () {
    if (transport.apply(event as transports.GenerateEvent)) return;
    const sessionID = event.sessionID;
    if ((yield* parent(sessionID)) !== undefined || !(yield* isEnabled(sessionID))) return;
    const { rows, rebuilt } = yield* turnHistory(sessionID);
    const memo = memos.get(sessionID);
    // A running turn keeps the mode it started in; otherwise the switch decides, as the next turn would.
    if (!(memo?.key === history.turnKey(rows) ? memo.enabled : (yield* state(sessionID)).on)) return;
    const chat = yield* get(sessionID);
    const system = chat.system();
    if (system === undefined) return;
    const current = history.segments(rows).at(-1)!;
    // Mid-turn, the view frozen for this turn excludes its raw messages; between turns they are all in the log.
    const view = current.rows.length > 0 && memo?.key === history.turnKey(rows) && memo.frozen ? memo.frozen : chat.renderView();
    const reports = new Map(history.items(current.rows, { name: (childID) => nameFor(chat, current.rows, childID) })
      .filter((item) => item.kind === "work").map((item) => [item.src, item.text]));
    const raw = rebuilt ? restoreTurn(rows, event.messages, event.model) : event.messages;
    const build = (extra?: string) => history.btwRequest({ messages: raw, turnIds: current.ids, view, reports, extra }).map(hostMessages(event.messages));
    const opened = settings.btw.lookupSteps > 0
      ? yield* lookup(chat, { sessionID, model: event.model, system, messages: build(settings.prompts.btwLookup) }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("UniiChat /btw memory lookup failed; answering from the view", cause).pipe(Effect.as([]))),
      )
      : [];
    event.system = [{ type: "text", text: system }];
    event.messages = build(btwMemory(opened));
  }).pipe(Effect.orDie));

  yield* ctx.session.hook("compaction", Effect.fn(function* (event) {
    if (!(yield* parent(event.sessionID)) && (yield* isEnabled(event.sessionID))) event.result = { summary: history.STUB_SUMMARY, metadata: { ...history.STUB_METADATA } };
  }, Effect.orDie));
  yield* ctx.tool.hook("execute.before", Effect.fn(function* (event) {
    if (event.tool !== "subagent") return;
    if (yield* isEnabled(yield* target(event.sessionID))) {
      if (event.input && typeof event.input === "object") (event.input as { background?: boolean }).background = true;
    }
  }, Effect.orDie));
  const toolResult = (effect: Effect.Effect<engine.ToolResult, unknown>) => effect.pipe(
    Effect.map((result): Tool.Result => ({
      content: [{ type: "text", text: result.text }, ...(result.files ?? []).map((file) => ({
        type: "file" as const, mime: file.mime, uri: `data:${file.mime};base64,${Buffer.from(file.data).toString("base64")}`,
      }))],
      metadata: { truncated: false },
    })),
    Effect.catchCause((cause) => Effect.fail(new Tool.Error({ message: Cause.pretty(cause) }))),
  );
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "zoom", description: ZOOM_DESCRIPTION, options: { codemode: false },
      input: { type: "object", properties: { id: { anyOf: [{ type: "integer" }, { type: "string" }] }, n: { type: "integer" } }, required: ["id"], additionalProperties: false },
      execute: (input, context) => toolResult(Effect.gen(function* () {
        const args = input as { id: number | string; n?: number };
        const chat = yield* get(yield* target(context.sessionID));
        return yield* chat.zoom(args.id, args.n);
      })),
    });
    editor.add({
      name: "date", description: DATE_DESCRIPTION, options: { codemode: false },
      input: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
      execute: (input, context) => toolResult(Effect.gen(function* () {
        const chat = yield* get(yield* target(context.sessionID));
        return yield* chat.date((input as { id: number }).id);
      })),
    });
  });
  yield* ctx.rpc.register(UniiChatRpc, {
    set: ({ sessionID, on }) => set(sessionID, on),
    status: ({ sessionID }) => Effect.gen(function* () {
      const on = (yield* state(sessionID)).on;
      const rows = yield* readHistory(sessionID);
      const chatID = yield* target(sessionID);
      const chat = yield* get(chatID);
      return statusValue({ on, chat: chat.status(), lastTurn: turn.lastUsage(rows) });
    }).pipe(Effect.orDie),
    view: ({ sessionID }) => Effect.gen(function* () {
      const view = (yield* get(yield* target(sessionID))).renderView();
      return [...view.blocks, view.tail].join("").replace(/^<chat>\n/, "").replace(/\n?<\/chat>$/, "").split("\n").filter(Boolean);
    }).pipe(Effect.orDie),
    archive: (input) => Effect.gen(function* () {
      const chat = yield* get(yield* target(input.sessionID));
      return (yield* ("name" in input ? chat.zoom(input.name) : chat.zoom(input.id, input.n))).text;
    }).pipe(Effect.orDie),
  });
  yield* ctx.event.subscribe().pipe(Stream.runForEach((event) => {
    if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed" && event.type !== "session.execution.interrupted") return Effect.void;
    const sessionID = event.data.sessionID;
    if (transport.owns(sessionID)) return Effect.void;
    return serialized(sessionID, Effect.gen(function* () {
      const parentID = yield* parent(sessionID);
      const child = parentID !== undefined && (yield* isEnabled(parentID));
      if (!child && memos.get(sessionID)?.enabled !== true) return;
      const session = yield* ctx.session.get({ sessionID });
      if (session.location.directory !== ctx.location.directory || session.location.workspaceID !== ctx.location.workspaceID) return;
      const chat = yield* get(child ? parentID! : sessionID);
      const rows = yield* readHistory(sessionID);
      if (child) {
        const name = chat.agentName(sessionID, session.agent ?? "agent");
        yield* chat.logAgent(name, turn.childItems(sessionID, history.items(rows, { name: (childID) => nameFor(chat, rows, childID) })));
      } else yield* reconcile(sessionID, chat, rows, false);
    })).pipe(Effect.catchCause((cause) => Effect.logWarning("UniiChat reconciliation failed", cause)));
  }), Effect.forkScoped);
});

export default Plugin.define({ id: "uniichat", effect: (ctx) => integrate(ctx).pipe(Effect.orDie) });
