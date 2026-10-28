import { expect, test } from "bun:test";
import { Message } from "@opencode/ai/effect";
import type { Plugin } from "@opencode/plugin/effect";
import type { SessionContext, SessionCompaction } from "@opencode/plugin/effect/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Session } from "@opencode/schema/session";
import { DateTime, Deferred, Effect, Queue, Schema, Stream } from "effect";
import { integrate, toWire, type IntegrationOptions } from "./index.ts";
import type { Row, Item } from "./history.ts";
import { blocks } from "./view.ts";
import { SUBAGENT_NOTE, SYSTEM_PROMPT } from "./prompts.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chat } from "./chat.ts";
import { UniiChatRpc } from "./rpc.ts";

const user = (id: string, text = "task"): Row => ({ type: "user", id, text, time: { created: 1000 } });
const idle = (id: string): Row => ({ type: "idle", id, outcome: "succeeded", time: { created: 1000 } });
const msg = (role: "user" | "assistant", text: string, id: string) => Message.make({ role, id, content: [{ type: "text", text }] });

test("invalid configuration stops plugin loading before installing hooks", async () => {
  const ctx = { options: { "compaction.model": "openai/example" } } as unknown as Plugin.Context;
  await expect(Effect.runPromise(Effect.scoped(integrate(ctx)))).rejects.toThrow('unknown option "compaction.model"');
});
type Callback = (event: SessionContext) => Effect.Effect<void>;
let serial = 0;

function fixture(initial: Row[], on = true) {
  const sessionID = Session.ID.make(`ses_test_${++serial}`);
  let rows = initial;
  let system: string | undefined;
  let lines = ["0+1|old", "1+1|old", "2+1|old", "3+1|old"];
  const logged: Item[] = [];
  const agentLogged: Item[] = [];
  const events = Effect.runSync(Queue.unbounded<any>());
  const finalLogged = Deferred.makeUnsafe<void>();
  const storage = new Map<string, unknown>([[`session/${sessionID}`, { on, render: on }]]);
  const hooks = new Map<string, Callback>();
  const toolHooks = new Map<string, (event: unknown) => Effect.Effect<void>>();
  const tools = new Map<string, { execute: (input: unknown, context: { sessionID: string }) => Effect.Effect<unknown, unknown> }>();
  let handlers: Record<string, (input: any) => Effect.Effect<any>>;
  const chat = {
    // Like the engine, a source already logged is skipped.
    log: (items: readonly Item[]) => Effect.sync(() => { logged.push(...items.filter((item) => !logged.some((seen) => seen.src === item.src))); }).pipe(
      Effect.tap(() => items.some((item) => item.text === "last reply") ? Deferred.succeed(finalLogged, undefined) : Effect.void),
    ),
    logAgent: (_name: string, items: readonly Item[]) => Effect.sync(() => { agentLogged.push(...items); return undefined; }),
    agentName: () => "explore-1",
    system: () => system,
    setSystem: (text: string) => Effect.sync(() => { system = text; }),
    setTools: () => Effect.void,
    awaitSummarized: () => Effect.void,
    renderView: () => blocks(lines),
    zoom: () => Effect.succeed({ text: "original", files: [{ mime: "image/png", data: new Uint8Array([1, 2]) }] }),
    date: () => Effect.succeed({ text: "date" }),
    latestSource: () => logged.at(-1)?.src.split(":")[0],
    undoneFrom: (present: (base: string) => boolean) => {
      for (let i = logged.length - 1; i >= 0; i--) if (present(logged[i]!.src.split(":")[0]!)) return i + 1 < logged.length ? i + 1 : undefined;
      return undefined;
    },
    rewind: (k: number) => Effect.sync(() => logged.splice(k).map((item) => item.src.split(":")[0]!)),
    status: () => ({ T: 0, viewBytes: 0, compViewBytes: 0, lines: 0, inFlight: 0, pending: 0, failed: 0, lastError: undefined, last: undefined, total: { calls: 0, ms: 0 } }),
  };
  let contextReads = 0;
  const childID = Session.ID.make(`${sessionID}_child`);
  const ctx = {
    location: { directory: process.cwd(), project: { directory: process.cwd() } },
    storage: {
      get: (key: string) => Effect.succeed(storage.get(key)),
      set: (key: string, value: unknown) => Effect.sync(() => { storage.set(key, value); }),
    },
    session: {
      get: ({ sessionID: sid }: { sessionID: string }) => Effect.succeed({ location: { directory: process.cwd() }, parentID: sid === childID ? sessionID : undefined, agent: "explore" }),
      context: () => Effect.sync(() => { contextReads++; return rows.map((row) => Schema.decodeUnknownSync(SessionMessage.Info)(row)); }),
      hook: (name: string, callback: Callback) => Effect.sync(() => { hooks.set(name, callback); }),
    },
    tool: {
      hook: (name: string, callback: (event: unknown) => Effect.Effect<void>) => Effect.sync(() => { toolHooks.set(name, callback); }),
      transform: (callback: (editor: { add: (tool: { name: string }) => void }) => void) => Effect.sync(() => callback({ add: (tool) => { tools.set(tool.name, tool as any); } })),
    },
    rpc: { register: (_def: unknown, methods: typeof handlers) => Effect.sync(() => { handlers = methods; }) },
    event: { subscribe: () => Stream.fromQueue(events) },
  } as unknown as Plugin.Context;
  const options: IntegrationOptions = { get: () => Effect.succeed(chat), sources: () => Effect.succeed(new Set()), older: () => Effect.succeed(undefined) };
  const event = (messages: Message[] = [msg("user", "task", "msg_new")], sid = sessionID): SessionContext => ({
    sessionID: sid, agent: "build" as SessionContext["agent"], model: {} as SessionContext["model"],
    system: [{ type: "text", text: "vanilla" }, { type: "text", text: "# Code Mode\n\ncatalog\n\nToday's date: ignore" }],
    messages, tools: { zoom: { description: "zoom", input: {} }, date: { description: "date", input: {} }, read: { description: "read", input: {} } }, options: {},
  });
  return { sessionID, childID, hooks, toolHooks, tools, ctx, options, event, logged, agentLogged, storage,
    rows: (next: Row[]) => { rows = next; }, lines: (next: string[]) => { lines = next; }, system: () => system,
    reads: () => contextReads, rpc: () => handlers!, events, finalLogged,
  };
}

test("first request drops old turns; continuation keeps the frozen view and step history", async () => {
  const f = fixture([user("msg_old"), idle("msg_idle"), user("msg_new")]);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    const first = f.event([msg("user", "old", "msg_old"), msg("user", "task", "msg_new")]);
    yield* f.hooks.get("context")!(first);
    expect(first.system[0]!.text).toStartWith(SYSTEM_PROMPT);
    expect(first.system[0]!.text).toContain("# Code Mode\n\ncatalog");
    expect(first.system[0]!.text).not.toContain("Today's date:");
    expect(first.messages.map((message) => message.id)).toEqual(["msg_new"]);
    const firstTexts = first.messages[0]!.content.filter((part) => part.type === "text").map((part) => part.text);
    expect(firstTexts[0]).toContain("0+1|old");
    expect(firstTexts[2]).toStartWith("Today's date:");
    expect(firstTexts.at(-1)).toBe("task");
    expect(Object.keys(first.tools)).toContain("zoom");
    // The raw request drops the old turn; first switch-on imports it into memory instead.
    expect(f.logged.map((item) => item.src)).toEqual(["msg_old", "msg_new"]);
    f.lines(["changed"]);
    f.rows([idle("msg_idle"), user("msg_new"), { type: "assistant", id: "msg_reply", content: [{ type: "text", text: "reply" }], agent: "build", model: { id: "model", providerID: "anthropic" }, time: { created: 1001 } }]);
    const next = f.event([msg("user", "task", "msg_new"), msg("assistant", "reply", "msg_reply")]);
    yield* f.hooks.get("context")!(next);
    expect(next.messages[0]!.content[0]).toEqual(first.messages[0]!.content[0]);
    expect(next.messages[1]!.id).toBe("msg_reply");
    expect(f.logged.at(-1)?.text).toBe("reply");
    yield* f.rpc().set({ sessionID: f.sessionID, on: false });
    const afterOff = f.event();
    yield* f.hooks.get("context")!(afterOff);
    expect(afterOff.system[0]!.text).toBe(f.system()!);
    f.rows([idle("msg_end"), user("msg_next")]);
    const vanilla = f.event([msg("user", "next", "msg_next")]);
    yield* f.hooks.get("context")!(vanilla);
    expect(vanilla.system[0]!.text).toBe("vanilla");
    expect(Object.keys(vanilla.tools)).toEqual(["read"]);
  })));
});

test("disabled requests do not read history; on while busy waits for idle", async () => {
  const f = fixture([user("msg_new")], false);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    const vanilla = f.event();
    yield* f.hooks.get("context")!(vanilla);
    expect(f.reads()).toBe(0);
    expect(Object.keys(vanilla.tools)).toEqual(["read"]);
    yield* f.rpc().set({ sessionID: f.sessionID, on: true });
    const busy = f.event();
    yield* f.hooks.get("context")!(busy);
    expect(busy.system[0]!.text).toBe("vanilla");
    f.rows([user("msg_new"), idle("msg_idle"), user("msg_next")]);
    const enabled = f.event([msg("user", "next", "msg_next")]);
    yield* f.hooks.get("context")!(enabled);
    expect(enabled.system[0]!.text).toStartWith(SYSTEM_PROMPT);
    expect(f.logged.map((item) => item.src)).toEqual(["msg_new", "msg_next"]);
  })));
});

test("children keep their own prompt, get the view, omit state, and retain native compaction", async () => {
  const f = fixture([user("msg_new")]);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    yield* f.hooks.get("context")!(f.event());
    f.rows([user("msg_child")]);
    const child = f.event([Message.system("explore prompt"), msg("user", "child task", "msg_child")], f.childID);
    yield* f.hooks.get("context")!(child);
    expect(child.system.map((part) => part.text)).toEqual(["vanilla", "# Code Mode\n\ncatalog\n\nToday's date: ignore", SUBAGENT_NOTE]);
    expect(child.system.some((part) => part.text.includes(SYSTEM_PROMPT))).toBe(false);
    expect(child.messages).toHaveLength(1);
    const text = child.messages[0]!.content.flatMap((part) => part.type === "text" ? [part.text] : []);
    expect(text.at(-1)).toBe("child task");
    expect(text.some((text) => text.startsWith("Today's date:"))).toBe(false);
    expect(f.agentLogged[0]!.src).toBe(`${f.childID}:msg_child`);
    const compaction: SessionCompaction = { ...child };
    yield* f.hooks.get("compaction")!(compaction);
    expect(compaction.result).toBeUndefined();
    const master: SessionCompaction = { ...f.event() };
    yield* f.hooks.get("compaction")!(master);
    expect(master.result?.summary).toContain("skipped");
    const call = { tool: "subagent", sessionID: f.sessionID, input: { background: false } };
    yield* f.toolHooks.get("execute.before")!(call);
    expect(call.input.background).toBe(true);
    const output = yield* f.tools.get("zoom")!.execute({ id: 0, n: 1 }, { sessionID: f.childID });
    expect(output).toEqual({ content: [{ type: "text", text: "original" }, { type: "file", mime: "image/png", uri: "data:image/png;base64,AQI=" }], metadata: { truncated: false } });
    yield* f.rpc().set({ sessionID: f.sessionID, on: false });
  })));
});

test("a child of a disabled parent stays vanilla", async () => {
  const f = fixture([user("msg_child")], false);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    const child = f.event([msg("user", "task", "msg_child")], f.childID);
    yield* f.hooks.get("context")!(child);
    expect(Object.keys(child.tools)).toEqual(["read"]);
    expect(child.system[0]!.text).toBe("vanilla");
    expect(f.agentLogged).toHaveLength(0);
  })));
});

test("restart recovery logs only anchored segments, before freezing the new input", async () => {
  const checkpoint: Row = { type: "compaction", id: "msg_cp", status: "completed", reason: "auto", summary: "summary", time: { created: 1000 } };
  const f = fixture([checkpoint, idle("msg_after_cp"), user("msg_new", "new input")]);
  f.options.sources = () => Effect.succeed(new Set(["msg_recorded"]));
  f.options.older = () => Effect.succeed([
    user("msg_pre_on"), idle("msg_i1"), user("msg_recorded"), user("msg_missed", "missed steering"),
    idle("msg_i2"), user("msg_off"), idle("msg_i3"), checkpoint, idle("msg_after_cp"), user("msg_new", "new input"),
  ]);
  const get = f.options.get!;
  f.options.get = (sessionID, deps) => get(sessionID, deps).pipe(Effect.map((chat) => ({
    ...chat,
    renderView: () => blocks(f.logged.map((item, i) => `${i}+1|${item.text}`)),
  })));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    const event = f.event();
    yield* f.hooks.get("context")!(event);
    expect(f.logged.map((item) => item.src)).toEqual(["msg_recorded", "msg_missed", "msg_new"]);
    const text = event.messages[0]!.content[0];
    expect(text.type === "text" && text.text).toContain("missed steering");
    expect(text.type === "text" && text.text).not.toContain("new input");
  })));
});

test("first switch-on imports earlier vanilla turns, even before a checkpoint, into the frozen view", async () => {
  const checkpoint: Row = { type: "compaction", id: "msg_cp", status: "completed", reason: "auto", summary: "summary", time: { created: 1000 } };
  const f = fixture([checkpoint, idle("msg_after_cp"), user("msg_new", "new input")]);
  let asked = 0;
  f.options.older = () => Effect.sync(() => {
    asked++;
    return [user("msg_v1", "first vanilla"), idle("msg_i1"), user("msg_v2", "second vanilla"), idle("msg_i2"), checkpoint, idle("msg_after_cp"), user("msg_new", "new input")];
  });
  const get = f.options.get!;
  f.options.get = (sessionID, deps) => get(sessionID, deps).pipe(Effect.map((chat) => ({
    ...chat,
    renderView: () => blocks(f.logged.map((item, i) => `${i}+1|${item.text}`)),
  })));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    const event = f.event();
    yield* f.hooks.get("context")!(event);
    expect(f.logged.map((item) => item.src)).toEqual(["msg_v1", "msg_v2", "msg_new"]);
    const text = event.messages[0]!.content[0];
    expect(text.type === "text" && text.text).toContain("first vanilla");
    expect(text.type === "text" && text.text).toContain("second vanilla");
    expect(text.type === "text" && text.text).not.toContain("new input");
    yield* f.hooks.get("context")!(f.event());
    expect(asked).toBe(1);
  })));
});

test("first switch-on falls back to the latest context when the full history is unreachable", async () => {
  const f = fixture([user("msg_v1"), idle("msg_i1"), user("msg_new")]);
  f.options.older = () => Effect.fail(new Error("no service"));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    yield* f.hooks.get("context")!(f.event());
    expect(f.logged.map((item) => item.src)).toEqual(["msg_v1", "msg_new"]);
  })));
});

test("execution completion captures the last reply without another context hook", async () => {
  const f = fixture([user("msg_new")]);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    yield* f.hooks.get("context")!(f.event());
    f.rows([user("msg_new"), { type: "assistant", id: "msg_last", content: [{ type: "text", text: "last reply" }], agent: "build", model: { id: "model", providerID: "anthropic" }, time: { created: 1001, completed: 1501 } }, idle("msg_end")]);
    yield* Queue.offer(f.events, { type: "session.execution.succeeded", data: { sessionID: f.sessionID } });
    yield* Deferred.await(f.finalLogged);
    expect(f.logged.at(-1)?.text).toBe("last reply");
    const status = yield* f.rpc().status({ sessionID: f.sessionID });
    expect(status.on).toBe(true);
    expect(status.lastTurn).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ms: 500 });
  })));
});

test("off, vanilla compaction, and on proceed after restart without discovery or an anchor", async () => {
  const f = fixture([user("msg_vanilla")], false);
  f.options.sources = () => Effect.succeed(new Set(["msg_before_off"]));
  let discoveries = 0;
  f.options.older = () => Effect.sync(() => { discoveries++; return undefined; });
  const checkpoint: Row = { type: "compaction", id: "msg_cp", status: "completed", reason: "auto", summary: "vanilla summary", time: { created: 1000 } };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    yield* f.rpc().set({ sessionID: f.sessionID, on: false });
    const vanilla = f.event([msg("user", "vanilla task", "msg_vanilla")]);
    yield* f.hooks.get("context")!(vanilla);
    expect(vanilla.system[0]!.text).toBe("vanilla");
    const compaction: SessionCompaction = { ...vanilla };
    yield* f.hooks.get("compaction")!(compaction);
    expect(compaction.result).toBeUndefined();
    f.rows([checkpoint, idle("msg_after_cp")]);
    yield* f.rpc().set({ sessionID: f.sessionID, on: true });
    f.rows([checkpoint, idle("msg_after_cp"), user("msg_new")]);
    const enabled = f.event();
    yield* f.hooks.get("context")!(enabled);
    expect(enabled.system[0]!.text).toStartWith(SYSTEM_PROMPT);
    expect(enabled.messages.map((message) => message.id)).toEqual(["msg_new"]);
    expect(f.logged.map((item) => item.src)).toEqual(["msg_new"]);
    yield* f.hooks.get("context")!(f.event());
    expect(discoveries).toBe(1);
  })));
});

test("checkpoint cuts and chat open failures fail with a user-facing message", async () => {
  const f = fixture([user("msg_new"), { type: "compaction", id: "msg_cp", status: "completed", reason: "auto", summary: "summary", time: { created: 1000 } }]);
  await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    yield* f.hooks.get("context")!(f.event());
  })))).rejects.toThrow("turn cut");
  const broken = fixture([user("msg_new")]);
  broken.options.get = () => Effect.fail(new Error("UniiChat cannot open the chat store."));
  await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(broken.ctx, broken.options);
    yield* broken.hooks.get("context")!(broken.event());
  })))).rejects.toThrow("cannot open the chat store");
});

for (const state of ["fresh", "compacted", "failed"] as const) {
  test(`all RPC outputs are JSON values with a ${state} chat`, async () => {
    const f = fixture([]);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const chat = yield* Chat.open(mkdtempSync(join(tmpdir(), "uniichat-rpc-")), {
        compact: () => state === "failed" ? Effect.fail("compaction failed") : Effect.succeed({
          text: "summary", ms: 7,
        }),
      });
      f.options.get = () => Effect.succeed(chat);
      yield* integrate(f.ctx, f.options);
      if (state !== "fresh") {
        yield* chat.setSystem("system");
        yield* chat.setTools([]);
      }
      yield* chat.log([{ kind: "user", text: state === "fresh" ? "task" : "L".repeat(600), date: 1000, src: "msg_task" }]);
      if (state === "compacted") yield* chat.awaitSummarized();
      if (state === "failed") {
        for (let i = 0; i < 100 && chat.status().failed === 0; i++) yield* Effect.yieldNow;
        expect(chat.status().failed).toBe(1);
      }
      const outputs = [
        yield* f.rpc().set({ sessionID: f.sessionID, on: true }),
        yield* f.rpc().status({ sessionID: f.sessionID }),
        yield* f.rpc().view({ sessionID: f.sessionID }),
        yield* f.rpc().archive({ sessionID: f.sessionID, id: 0, n: 1 }),
      ];
      for (const [i, method] of ["set", "status", "view", "archive"].entries()) {
        const output = outputs[i];
        expect(output).toStrictEqual(JSON.parse(JSON.stringify(output)));
        expect(UniiChatRpc.methods[method as keyof typeof UniiChatRpc.methods].output.parse(output)).toStrictEqual(output);
      }
      expect(chat.status()).toStrictEqual(JSON.parse(JSON.stringify(chat.status())));
      const status = outputs[1];
      expect(status.lastTurn).toBeNull();
      if (state === "compacted") expect(status.chat.last.ms).toBe(7);
      if (state === "failed") expect(status.chat.lastError).toContain("compaction failed");
    })));
  });
}

test("status projects finite wire usage without leaking undefined, DateTime, or Map values", async () => {
  const f = fixture([]);
  const get = f.options.get!;
  f.options.get = (sessionID, deps) => get(sessionID, deps).pipe(Effect.map((chat) => ({
    ...chat,
    status: () => ({
      ...chat.status(),
      last: { ms: NaN, date: DateTime.makeUnsafe(1000), map: new Map([["secret", "value"]]) } as unknown as { ms: number },
      total: { calls: 2, ms: Infinity },
    }),
  })));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    for (const completed of [undefined, 1500]) {
      f.rows([{ type: "assistant", id: "msg_reply", content: [], agent: "build", model: { id: "fake", providerID: "anthropic" }, time: { created: 1000, ...(completed === undefined ? {} : { completed }) } }]);
      const status = yield* f.rpc().status({ sessionID: f.sessionID });
      expect(status).toStrictEqual(JSON.parse(JSON.stringify(status)));
      expect(UniiChatRpc.methods.status.output.parse(status)).toStrictEqual(status);
      expect(status.chat.last).toEqual({ ms: 0 });
      expect(status.chat.total).toEqual({ calls: 2, ms: 0 });
      expect(status.lastTurn).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...(completed === undefined ? {} : { ms: 500 }) });
    }
  })));
});

test("an undone turn is dropped from memory before the next turn, and the redo is logged", async () => {
  const reply = (id: string, text: string): Row => ({ type: "assistant", id, content: [{ type: "text", text }], agent: "build", model: { id: "model", providerID: "anthropic" }, time: { created: 1001 } });
  const f = fixture([user("msg_a")]);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    yield* f.hooks.get("context")!(f.event([msg("user", "task", "msg_a")]));
    f.rows([user("msg_a"), reply("msg_ra", "a done"), idle("msg_i1"), user("msg_b"), reply("msg_rb", "b done")]);
    yield* f.hooks.get("context")!(f.event([msg("user", "task", "msg_b")]));
    expect(f.logged.map((item) => item.text)).toEqual(["task", "a done", "task", "b done"]);
    // /undo of msg_b, committed by the next prompt: OpenCode deleted msg_b and its reply.
    f.rows([user("msg_a"), reply("msg_ra", "a done"), idle("msg_i1"), user("msg_c", "redo")]);
    const redo = f.event([msg("user", "redo", "msg_c")]);
    yield* f.hooks.get("context")!(redo);
    expect(f.logged.map((item) => item.text)).toEqual(["task", "a done", "redo"]);
    expect(redo.messages.map((message) => message.id)).toEqual(["msg_c"]);
  })));
});

test("an undo before a compaction checkpoint is found in the full message list", async () => {
  const reply = (id: string, text: string): Row => ({ type: "assistant", id, content: [{ type: "text", text }], agent: "build", model: { id: "model", providerID: "anthropic" }, time: { created: 1001 } });
  const checkpoint: Row = { type: "compaction", id: "msg_cp", status: "completed", reason: "auto", summary: "UniiChat is on; native compaction is skipped.", time: { created: 1002 } };
  const f = fixture([user("msg_a")]);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    yield* f.hooks.get("context")!(f.event([msg("user", "task", "msg_a")]));
    f.rows([user("msg_a"), reply("msg_ra", "a done"), idle("msg_i1"), user("msg_b"), reply("msg_rb", "b done")]);
    yield* f.hooks.get("context")!(f.event([msg("user", "task", "msg_b")]));
    expect(f.logged.map((item) => item.text)).toEqual(["task", "a done", "task", "b done"]);
    // msg_b was undone; the redo hit a checkpoint, so the context holds no logged message at all.
    f.options.older = () => Effect.succeed([user("msg_a"), reply("msg_ra", "a done"), idle("msg_i1"), user("msg_c", "redo"), checkpoint, idle("msg_fail")]);
    f.rows([checkpoint, idle("msg_fail"), user("msg_d", "again")]);
    yield* f.hooks.get("context")!(f.event([msg("user", "again", "msg_d")]));
    expect(f.logged.map((item) => item.text)).not.toContain("b done");
    expect(f.logged.map((item) => item.text)).toContain("again");
  })));
});

test("a UniiChat compaction stub mid-turn: the turn is rebuilt from the full message list", async () => {
  const reply = (id: string, text: string): Row => ({ type: "assistant", id, content: [{ type: "text", text }], agent: "build", model: { id: "model", providerID: "anthropic" }, time: { created: 1001 } });
  const stub: Row = { type: "compaction", id: "msg_stub", status: "completed", reason: "auto", summary: "UniiChat is on; native compaction is skipped.", metadata: { uniichat: "skipped" }, time: { created: 1002 } };
  const f = fixture([user("msg_old"), idle("msg_idle"), user("msg_new")]);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    yield* f.hooks.get("context")!(f.event([msg("user", "old", "msg_old"), msg("user", "task", "msg_new")]));
    const compaction: SessionCompaction = { ...f.event() };
    yield* f.hooks.get("compaction")!(compaction);
    expect(compaction.result?.metadata).toEqual({ uniichat: "skipped" });
    // OpenCode's context now starts at the stub; the full list still has the turn.
    f.rows([stub, reply("msg_r2", "step 2")]);
    f.options.older = (_sid, has) => Effect.sync(() => {
      const all = [user("msg_old"), idle("msg_idle"), user("msg_new"), reply("msg_r1", "step 1"), stub, reply("msg_r2", "step 2")];
      const out: Row[] = [];
      for (const row of [...all].reverse()) { out.push(row); if (has(row)) break; }
      return out.reverse();
    });
    const next = f.event([Message.make({ id: "msg_stub", role: "user", content: [{ type: "text", text: "<conversation-checkpoint>" }] }), msg("assistant", "step 2", "msg_r2")]);
    yield* f.hooks.get("context")!(next);
    expect(next.messages.map((message) => message.id)).toEqual(["msg_new", "msg_r1", "msg_r2"]);
    const texts = next.messages.map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []));
    expect(texts[0]!.at(-1)).toBe("task");
    expect(texts[0]![0]).toContain("0+1|old");
    expect(texts.flat().some((text) => text.includes("conversation-checkpoint"))).toBe(false);
    // Unreachable full list: no throw, the request starts at the stub's checkpoint.
    f.options.older = () => Effect.succeed(undefined);
    const fallback = f.event([Message.make({ id: "msg_stub", role: "user", content: [{ type: "text", text: "<conversation-checkpoint>" }] }), msg("assistant", "step 2", "msg_r2")]);
    yield* f.hooks.get("context")!(fallback);
    expect(fallback.messages[0]!.id).toBe("msg_stub");
  })));
});

test("/btw gets Unii's prompt and memory instead of the whole session; off or child stays vanilla", async () => {
  const f = fixture([user("msg_old"), idle("msg_idle"), user("msg_new")]);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* integrate(f.ctx, f.options);
    yield* f.hooks.get("context")!(f.event([msg("user", "old", "msg_old"), msg("user", "task", "msg_new")]));
    f.rows([user("msg_old"), idle("msg_idle"), user("msg_new"), { type: "assistant", id: "msg_reply", content: [{ type: "text", text: "reply" }], agent: "build", model: { id: "model", providerID: "anthropic" }, time: { created: 1001 } }, idle("msg_end")]);
    const btw = f.event([msg("user", "old", "msg_old"), msg("user", "task", "msg_new"), msg("assistant", "reply", "msg_reply"), Message.user("side question?")]);
    yield* f.hooks.get("generate")!(btw);
    expect(btw.system).toEqual([{ type: "text", text: f.system()! }]);
    expect(btw.messages).toHaveLength(1);
    const parts = btw.messages[0]!.content.flatMap((part) => part.type === "text" ? [part.text] : []);
    expect(parts[0]).toContain("0+1|old");
    expect(parts.at(-1)).toBe("side question?");
    expect(parts.join("")).not.toContain("reply");
    yield* f.rpc().set({ sessionID: f.sessionID, on: false });
    f.rows([idle("msg_x"), user("msg_y")]);
    const off = f.event([msg("user", "old", "msg_old"), Message.user("q")]);
    yield* f.hooks.get("generate")!(off);
    expect(off.system[0]!.text).toBe("vanilla");
    expect(off.messages).toHaveLength(2);
  })));
});

test("a row our schema copy rejects still reaches the log as a wire row", () => {
  const decoded = Schema.decodeUnknownSync(SessionMessage.Info)(user("msg_u", "hi"));
  expect(toWire(decoded)).toEqual(user("msg_u", "hi"));
  // A newer OpenCode row: a compaction from a schema with an extra required key we lack, and a missing one.
  const newer = { type: "compaction", id: "msg_cp", status: "completed", reason: "auto", time: { created: DateTime.makeUnsafe(1000) }, future: { at: DateTime.makeUnsafe(2000) } };
  expect(toWire(newer as unknown as SessionMessage.Info)).toEqual({ type: "compaction", id: "msg_cp", status: "completed", reason: "auto", time: { created: 1000 }, future: { at: 2000 } } as unknown as Row);
});
