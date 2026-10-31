import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import { Chat, COMPACTION, ChatError, get, type Deps, type Item } from "./chat.ts";
import type { Input, Output } from "./compactor.ts";
import { Store, StoreError } from "./store.ts";
import { clipEcho, formatDate, utf8Size } from "./record.ts";
import { leafTask, mergeTask, tooLong } from "./prompts.ts";

const run = Effect.runPromise;
const temp = () => mkdtempSync(join(tmpdir(), "uniichat-chat-"));
const item = (i: number, text = `message ${i}`, kind: Item["kind"] = "user"): Item => ({ kind, text, date: 1791547200000, src: `msg_${i}` });
const output = (text: string | undefined): Output => ({ text, ms: 7 });
const deps = (compact: Deps["compact"] = () => Effect.succeed(output("summary"))): Deps => ({ compact });
const flush = Effect.gen(function* () { for (let i = 0; i < 50; i++) yield* Effect.yieldNow; });
const ready = Effect.fn("ready")(function* (chat: Chat) {
  yield* chat.setSystem("frozen system");
  yield* chat.setTools([]);
});
const load = (dir: string) => Store.open(dir).pipe(Effect.flatMap((store) => store.load()));
type Call = { input: Input; reply: Deferred.Deferred<Output, unknown> };
const controlled = Effect.fn("controlled")(function* (autoStart = true) {
  const calls = yield* Queue.unbounded<Call>();
  const seen: Input[] = [];
  const compact: Deps["compact"] = (input) => Effect.gen(function* () {
    seen.push({ ...input, turns: structuredClone(input.turns) });
    if (autoStart && input.started) yield* Deferred.succeed(input.started, undefined);
    const reply = yield* Deferred.make<Output, unknown>();
    yield* Queue.offer(calls, { input, reply });
    return yield* Deferred.await(reply);
  });
  return { calls, seen, deps: deps(compact) };
});

test("replay is deduplicated, non-echo text splits, only echo clips", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  const items = [item(0, "a".repeat(30001)), item(1, "b".repeat(30001), "tool"), item(2, "c".repeat(31000), "echo")];
  await run(Effect.all([chat.log(items), chat.log(items)], { concurrency: "unbounded" }));
  const loaded = await run(load(dir));
  expect(loaded.records.map((rec) => rec.src)).toEqual(["msg_0:0", "msg_0:1", "msg_1:0", "msg_1:1", "msg_2"]);
  expect(loaded.records.map((rec) => rec.text)).toEqual(["a".repeat(30000), "a", "b".repeat(30000), "b", clipEcho("c".repeat(31000))]);
  expect(chat.status().pending).toBe(5);
  expect(chat.status().inFlight).toBe(0);
});

test("a replay resumes the missing pages with the original attachment id", async () => {
  const dir = temp();
  const store = await run(Store.open(dir));
  const first = { i: 0, kind: "user" as const, text: "a".repeat(30000), size: 30000, date: new Date(item(0).date).toISOString(), src: "msg_0:0" };
  await run(store.appendRecord(first));
  await run(store.saveViews([[0, 0]], [[0, 0]], { chat: false, compaction: false }));
  const chat = await run(Chat.open(dir, deps()));
  await run(chat.log([item(0, "a".repeat(30001))]));
  expect((await run(load(dir))).records.map((rec) => [rec.i, rec.src, rec.text.length])).toEqual([[0, "msg_0:0", 30000], [1, "msg_0:1", 1]]);
});

test("files survive replay and reopen", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  const attached = { ...item(0), files: [{ name: "picture.png", mime: "image/png", data: new Uint8Array([1, 2, 255]) }, { name: "lost.pdf", mime: "application/pdf" }] };
  await run(chat.log([attached]));
  await run(chat.log([attached]));
  const reopened = await run(Chat.open(dir, deps()));
  const result = await run(reopened.zoom(0, 1));
  expect(result.text).toBe("user: message 0\n[file: picture.png image/png → files/0-0.png]\n[file: lost.pdf application/pdf, not available]");
  expect(Array.from(result.files![0]!.data)).toEqual([1, 2, 255]);
  expect(result.files![0]!.mime).toBe("image/png");
});

test("date gives a message's time and rejects ids outside the log", async () => {
  const chat = await run(Chat.open(temp(), deps()));
  await run(chat.log([item(0)]));
  expect(await run(chat.date(0))).toEqual({ text: formatDate(item(0).date) });
  for (const id of [-1, 1]) expect((await run(Effect.result(chat.date(id))))._tag).toBe("Failure");
});

test("zoom rejects a missing n, ids past the log and lines that are not nodes", async () => {
  const chat = await run(Chat.open(temp(), deps()));
  await run(chat.log([item(0)]));
  for (const [id, n] of [[0, undefined], [1, 1], [1, 2], [0, 3]]) expect((await run(Effect.result(chat.zoom(id!, n))))._tag).toBe("Failure");
});

test("instant leaves and merge cascades use no calls and each node is persisted once", async () => {
  const dir = temp();
  let calls = 0;
  const chat = await run(Chat.open(dir, deps(() => Effect.sync(() => { calls++; return output("summary"); }))));
  await run(chat.log(Array.from({ length: 8 }, (_, i) => item(i, String(i)))));
  await run(ready(chat));
  await run(chat.awaitSummarized());
  const nodes = (await run(load(dir))).nodes;
  expect(calls).toBe(0);
  expect(nodes).toHaveLength(15);
  expect(nodes.find((node) => node.l === 3)!.text).toBe(Array.from({ length: 8 }, (_, i) => `user: ${i}`).join("\n"));
  expect(nodes.filter((node) => node.l === 0).map((node) => node.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  await run(chat.log([item(0, "0")]));
  expect((await run(load(dir))).nodes).toHaveLength(15);
  expect(await run(chat.zoom(0, 8))).toEqual({ text: "0+4|user: 0 user: 1 user: 2 user: 3\n4+4|user: 4 user: 5 user: 6 user: 7" });
  await run(chat.log([item(8), item(9), item(10)]));
  const wrong = await run(Effect.flip(chat.zoom(0, 16)));
  expect(wrong.message).toContain("The tree's roots: 0+8, 8+2, 10+1.");
});

test("requires both system and tools, then sends exact context blocks and merge tasks", async () => {
  await run(Effect.gen(function* () {
    const fake = yield* controlled();
    const chat = yield* Chat.open(temp(), fake.deps);
    yield* chat.log(Array.from({ length: 7 }, (_, i) => item(i, String(i))));
    yield* chat.log([item(7, "long".repeat(200))]);
    yield* chat.setSystem("system");
    yield* flush;
    expect(fake.seen).toHaveLength(0);
    const tools = [{ name: "zoom", description: "zoom tool", input: { type: "object" } }];
    yield* chat.setTools(tools);
    tools[0]!.description = "changed externally";
    const call = yield* Queue.take(fake.calls);
    expect(call.input.system).toBe("system");
    expect(call.input.tools[0]!.description).toBe("zoom tool");
    expect(call.input.turns).toEqual([{ role: "user", parts: [
      { text: "<chat>\n0+1|user: 0\n1+1|user: 1\n2+1|user: 2\n3+1|user: 3\n", cache: true },
      { text: "4+1|user: 4\n5+1|user: 5\n6+1|user: 6\n</chat>" },
      { text: leafTask(7, "user", "long".repeat(200)), cache: true },
    ] }]);
    yield* Deferred.succeed(call.reply, output("x".repeat(510)));
    yield* chat.awaitSummarized();
    const merge = yield* Queue.take(fake.calls);
    expect(merge.input.turns[0]!.parts.at(-1)!.text).toBe(mergeTask("6+1", "7+1", 6, 7, "6+1|user: 6", `7+1|${"x".repeat(510)}`));
    yield* Deferred.succeed(merge.reply, output("short"));
    yield* flush;
    expect(chat.status().inFlight).toBe(0);
  }));
});

test("eight-call cap and strict earlier-leaf rule include fitting leaves", async () => {
  await run(Effect.gen(function* () {
    const fake = yield* controlled();
    const dir = temp();
    const chat = yield* Chat.open(dir, fake.deps);
    yield* ready(chat);
    yield* chat.log([...Array.from({ length: 8 }, (_, i) => item(i, "L".repeat(600))), item(8, "fits")]);
    const calls: Call[] = [];
    for (let i = 0; i < 8; i++) calls.push(yield* Queue.take(fake.calls));
    expect(chat.status().inFlight).toBe(8);
    expect(fake.seen).toHaveLength(8);
    expect((yield* load(dir)).nodes.some((node) => node.l === 0 && node.i === 8)).toBe(false);
    yield* Deferred.succeed(calls[7]!.reply, output("seven"));
    yield* flush;
    expect((yield* load(dir)).nodes.some((node) => node.l === 0 && node.i === 8)).toBe(true);
    for (const call of calls.slice(0, 7)) yield* Deferred.succeed(call.reply, output("short"));
    yield* chat.awaitSummarized();
    yield* flush;
    expect(fake.seen).toHaveLength(8);
    expect(chat.status().pending).toBe(0);
    expect(chat.status().inFlight).toBe(0);
  }));
});

test("same-prefix calls wait for response start, not response completion", async () => {
  await run(Effect.gen(function* () {
    const fake = yield* controlled(false);
    const chat = yield* Chat.open(temp(), fake.deps);
    yield* ready(chat);
    yield* chat.log([item(0, "L".repeat(600)), item(1, "M".repeat(600)), item(2, "N".repeat(600))]);
    const a = yield* Queue.take(fake.calls);
    yield* flush;
    expect(fake.seen).toHaveLength(1);
    yield* Deferred.succeed(a.input.started!, undefined);
    const b = yield* Queue.take(fake.calls);
    yield* flush;
    expect(fake.seen).toHaveLength(2);
    yield* Deferred.succeed(b.input.started!, undefined);
    const c = yield* Queue.take(fake.calls);
    expect(chat.status().pending).toBe(3);
    for (const call of [c, b, a]) yield* Deferred.succeed(call.reply, output("short"));
    yield* chat.awaitSummarized();
    yield* flush;
    expect(chat.status().inFlight).toBe(0);
  }));
});

test("only the last whole block is marked, and an empty tail closes chat", async () => {
  const seen: Input[] = [];
  const chat = await run(Chat.open(temp(), deps((input) => Effect.sync(() => {
    seen.push(input);
    return output("short");
  }))));
  await run(chat.log([...Array.from({ length: 8 }, (_, i) => item(i, String(i))), item(8, "L".repeat(600))]));
  await run(ready(chat));
  await run(chat.awaitSummarized());
  expect(seen).toHaveLength(1);
  const parts = seen[0]!.turns[0]!.parts;
  expect(parts).toEqual([
    { text: "<chat>\n0+1|user: 0\n1+1|user: 1\n2+1|user: 2\n3+1|user: 3\n" },
    { text: "4+1|user: 4\n5+1|user: 5\n6+1|user: 6\n7+1|user: 7\n", cache: true },
    { text: "</chat>" },
    { text: leafTask(8, "user", "L".repeat(600)), cache: true },
  ]);
});

test("too-long loop keeps the shortest of five, one end mark, calls and time", async () => {
  const dir = temp();
  const requests: Input[] = [];
  const sizes = [600, 550, 700, 520, 530];
  const chat = await run(Chat.open(dir, deps((input) => Effect.sync(() => {
    requests.push({ ...input, turns: structuredClone(input.turns) });
    return output("x".repeat(sizes[requests.length - 1]!));
  }))));
  await run(chat.log([...Array.from({ length: 4 }, (_, i) => item(i, "short")), item(4, "source".repeat(100))]));
  await run(ready(chat));
  await run(chat.awaitSummarized());
  expect(requests).toHaveLength(5);
  expect((await run(load(dir))).nodes.find((node) => node.l === 0 && node.i === 4)!.text).toBe("x".repeat(520));
  for (const [attempt, request] of requests.entries()) {
    // Every try is the first request, plus a note on the last line only: never an earlier try's words.
    expect(request.turns).toHaveLength(1);
    expect(request.turns[0]!.parts.slice(0, requests[0]!.turns[0]!.parts.length)).toEqual([...requests[0]!.turns[0]!.parts]);
    const endMarks = request.turns[0]!.parts.filter((part, p) => part.cache && p !== 0);
    expect(endMarks).toHaveLength(1);
    if (attempt) {
      const prior = "x".repeat(sizes[attempt - 1]!);
      expect(request.turns[0]!.parts.at(-1)).toEqual({ text: tooLong(utf8Size(prior), prior) });
      expect(request.turns[0]!.parts).toHaveLength(requests[0]!.turns[0]!.parts.length + 1);
    }
  }
  const status = chat.status();
  expect(status.last).toEqual({ ms: 7 });
  expect(status.total.calls).toBe(5);
  expect(status.total.ms).toBe(35);
});

for (const failure of ["error", "no text"] as const) {
  test(`D39 uses the shortest line if a later try has ${failure}`, async () => {
    const dir = temp();
    let calls = 0;
    const chat = await run(Chat.open(dir, deps(() => {
      calls++;
      return calls === 1 ? Effect.succeed(output("x".repeat(600))) : failure === "error" ? Effect.fail("broken") : Effect.succeed(output(undefined));
    })));
    await run(ready(chat));
    await run(chat.log([item(0, "L".repeat(600))]));
    await run(chat.awaitSummarized());
    expect(calls).toBe(2);
    expect(chat.status().failed).toBe(0);
    expect((await run(load(dir))).nodes[0]!.text).toBe("x".repeat(600));
  });
}

test("a failed first try retries at the next new record", async () => {
  await run(Effect.gen(function* () {
    let calls = 0;
    const chat = yield* Chat.open(temp(), deps(() => ++calls === 1 ? Effect.fail("broken") : Effect.succeed(output("summary"))));
    yield* ready(chat);
    yield* chat.log([item(0, "L".repeat(600))]);
    yield* flush;
    expect(chat.status().failed).toBe(1);
    expect(chat.status().lastError).toContain("broken");
    yield* chat.log([item(1)]);
    yield* chat.awaitSummarized();
    expect(calls).toBe(2);
    expect(chat.status().failed).toBe(0);
  }));
});

test("a no-text reply makes the node its source clipped, with no retry", async () => {
  const dir = temp();
  let calls = 0;
  const chat = await run(Chat.open(dir, deps(() => Effect.sync(() => (calls++, output(undefined))))));
  await run(ready(chat));
  await run(chat.log([item(0, "L".repeat(300) + "\n" + "M".repeat(300))]));
  await run(chat.awaitSummarized());
  expect(calls).toBe(1);
  expect(chat.status().failed).toBe(0);
  const text = (await run(load(dir))).nodes[0]!.text;
  expect(text).toBe(`user: ${"L".repeat(300)} ${"M".repeat(300)}`.slice(0, 512));
});

test("awaitSummarized retries with 1s then 2s backoff under TestClock", async () => {
  await run(Effect.gen(function* () {
    let calls = 0;
    const chat = yield* Chat.open(temp(), deps(() => ++calls < 3 ? Effect.fail("retry") : Effect.succeed(output("summary"))));
    yield* ready(chat);
    yield* chat.log([item(0, "L".repeat(600))]);
    yield* flush;
    const wait = yield* Effect.forkChild(chat.awaitSummarized());
    yield* flush;
    yield* TestClock.adjust(999);
    expect(calls).toBe(1);
    yield* TestClock.adjust(1);
    yield* flush;
    expect(calls).toBe(2);
    yield* TestClock.adjust(1999);
    expect(calls).toBe(2);
    yield* TestClock.adjust(1);
    yield* Fiber.join(wait);
    expect(calls).toBe(3);
    expect(chat.status().pending).toBe(0);
  }).pipe(Effect.provide(TestClock.layer())));
});

test("a hung compaction call times out and is retried instead of blocking awaitSummarized", async () => {
  await run(Effect.gen(function* () {
    let calls = 0;
    const chat = yield* Chat.open(temp(), deps(() => ++calls === 1 ? Effect.never : Effect.succeed(output("summary"))));
    yield* ready(chat);
    yield* chat.log([item(0, "L".repeat(600))]);
    yield* flush;
    expect(chat.status().inFlight).toBe(1);
    const wait = yield* Effect.forkChild(chat.awaitSummarized());
    yield* flush;
    yield* TestClock.adjust(COMPACTION.timeoutMs - 1);
    yield* flush;
    expect(chat.status().failed).toBe(0);
    yield* TestClock.adjust(1);
    yield* flush;
    expect(chat.status().failed).toBe(1);
    expect(chat.status().lastError).toContain("timed out");
    yield* TestClock.adjust(1000);
    yield* Fiber.join(wait);
    expect(calls).toBe(2);
    expect(chat.status().pending).toBe(0);
  }).pipe(Effect.provide(TestClock.layer())));
});

test("retry backoff doubles and caps at thirty seconds", async () => {
  await run(Effect.gen(function* () {
    let calls = 0;
    const chat = yield* Chat.open(temp(), deps(() => ++calls <= 7 ? Effect.fail("retry") : Effect.succeed(output("summary"))));
    yield* ready(chat);
    yield* chat.log([item(0, "L".repeat(600))]);
    yield* flush;
    const wait = yield* Effect.forkChild(chat.awaitSummarized());
    yield* flush;
    for (const [i, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
      yield* TestClock.adjust(delay - 1);
      expect(calls).toBe(i + 1);
      yield* TestClock.adjust(1);
      yield* flush;
      expect(calls).toBe(i + 2);
    }
    yield* Fiber.join(wait);
    expect(chat.status().failed).toBe(0);
  }).pipe(Effect.provide(TestClock.layer())));
});

test("interrupting the waiter does not stop background compactions", async () => {
  await run(Effect.gen(function* () {
    const fake = yield* controlled();
    const chat = yield* Chat.open(temp(), fake.deps);
    yield* ready(chat);
    yield* chat.log([item(0, "L".repeat(600))]);
    const call = yield* Queue.take(fake.calls);
    const waiter = yield* Effect.forkChild(chat.awaitSummarized());
    yield* Fiber.interrupt(waiter);
    expect(chat.status().pending).toBe(1);
    yield* Deferred.succeed(call.reply, output("summary"));
    yield* chat.awaitSummarized();
    expect(chat.status().pending).toBe(0);
  }));
});

test("a build completed by the next log releases a backoff waiter at once", async () => {
  await run(Effect.gen(function* () {
    let calls = 0;
    const chat = yield* Chat.open(temp(), deps(() => ++calls === 1 ? Effect.fail("retry") : Effect.succeed(output("summary"))));
    yield* ready(chat);
    yield* chat.log([item(0, "L".repeat(600))]);
    yield* flush;
    const waiter = yield* Effect.forkChild(chat.awaitSummarized());
    yield* flush;
    yield* chat.log([item(1)]);
    yield* Fiber.join(waiter);
    expect(calls).toBe(2);
    expect(yield* Effect.clockWith((clock) => clock.currentTimeMillis)).toBe(0);
  }).pipe(Effect.provide(TestClock.layer())));
});

test("restart loads byte-identical rendered views", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  await run(chat.log([item(0), item(1)]));
  await run(ready(chat));
  await run(chat.awaitSummarized());
  await run(chat.log([item(2, "L".repeat(600))]));
  await run(chat.awaitSummarized());
  const before = chat.renderView();
  const reopen = await run(Chat.open(dir, deps()));
  expect(reopen.renderView()).toEqual(before);
  expect(reopen.status().viewBytes).toBe(utf8Size("0+1|user: message 0\n1+1|user: message 1\n2+1|summary\n"));
  expect(reopen.hasTools()).toBe(false);
});

test("a replaced system prompt survives restart", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  await run(chat.setSystem("frozen system"));
  await run(chat.setSystem("replacement system"));
  expect((await run(Chat.open(dir, deps()))).system()).toBe("replacement system");
});

test("restart resumes only unbuilt work", async () => {
  const pendingDir = temp();
  const pending = await run(Chat.open(pendingDir, deps()));
  await run(pending.log([item(0, "L".repeat(600))]));
  const resumed = await run(Chat.open(pendingDir, deps()));
  expect(resumed.renderView()).toEqual(pending.renderView());
  await run(ready(resumed));
  await run(resumed.awaitSummarized());
  expect(resumed.status().pending).toBe(0);
  expect((await run(load(pendingDir))).nodes).toHaveLength(1);
});

test("missing views replay durable leaves on restart and pending batch flags are preserved", async () => {
  const dir = temp();
  const store = await run(Store.open(dir));
  await run(store.appendRecord({ i: 0, kind: "user", text: "x", size: 1, date: new Date(item(0).date).toISOString(), src: "x:0" }));
  const chat = await run(Chat.open(dir, deps()));
  expect(chat.renderView()).toEqual({ blocks: [], tail: "<chat>\n0+1|(not summarized yet: zoom it)\n</chat>" });
  await run(store.saveViews([[0, 0]], [[0, 0]], { chat: true, compaction: true }));
  const restored = await run(Chat.open(dir, deps()));
  await run(restored.log([item(1)]));
  expect((await run(load(dir))).batch).toEqual({ chat: false, compaction: false });
});

test("a crash after record append replays only the missing saved-view suffix", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  await run(chat.log([item(0), item(1)]));
  const original = Store.prototype.saveViews;
  const fault = spyOn(Store.prototype, "saveViews").mockImplementation(function (this: Store, ...args) {
    return this.dir === dir ? Effect.fail(new StoreError({ op: "saveViews", path: dir, cause: "crash" })) : original.apply(this, args);
  });
  try {
    expect((await run(Effect.result(chat.log([item(2)]))))._tag).toBe("Failure");
  } finally { fault.mockRestore(); }
  const reopened = await run(Chat.open(dir, deps()));
  await run(reopened.log([item(2), item(3)]));
  const saved = await run(load(dir));
  expect(saved.records.map((rec) => rec.i)).toEqual([0, 1, 2, 3]);
  expect(saved.view).toEqual([[0, 0], [0, 1], [0, 2], [0, 3]]);
  expect(saved.compView).toEqual(saved.view);
});

for (const behind of ["chat", "compaction"] as const) {
  test(`${behind} view behind after a rename crash keeps its saved prefix`, async () => {
    const dir = temp();
    const store = await run(Store.open(dir));
    for (let i = 0; i < 4; i++) {
      await run(store.appendRecord({ i, kind: "user", text: String(i), size: 1, date: new Date(item(i).date).toISOString(), src: `msg_${i}:0` }));
    }
    await run(store.appendNode({ l: 1, i: 0, text: "saved pair", size: 10 }));
    const short: [number, number][] = [[1, 0]];
    const full: [number, number][] = [[1, 0], [0, 2], [0, 3]];
    await run(store.saveViews(behind === "chat" ? short : full, behind === "compaction" ? short : full, { chat: false, compaction: false }));
    const chat = await run(Chat.open(dir, deps()));
    const recovered = await run(store.load());
    expect(recovered.view).toEqual(full);
    expect(recovered.compView).toEqual(full);
    expect(chat.renderView().tail.startsWith("<chat>\n0+2|saved pair\n")).toBe(true);
    expect((await run(Chat.open(dir, deps()))).renderView()).toEqual(chat.renderView());
  });
}

test("instant write failure blocks the wait and releases reserved model calls", async () => {
  const dir = temp();
  let calls = 0;
  const original = Store.prototype.appendNode;
  const fault = spyOn(Store.prototype, "appendNode").mockImplementation(function (this: Store, node) {
    return this.dir === dir ? Effect.fail(new StoreError({ op: "appendNode", path: dir, cause: "disk" })) : original.call(this, node);
  });
  try {
    await run(Effect.gen(function* () {
      const chat = yield* Chat.open(dir, deps(() => Effect.sync(() => { calls++; return output("summary"); })));
      yield* chat.log([item(0, "short"), item(1, "L".repeat(600))]);
      yield* ready(chat);
      expect(chat.status().pending).toBe(2);
      expect(chat.status().failed).toBe(2);
      expect(chat.status().inFlight).toBe(0);
      expect(calls).toBe(0);
      let returned = false;
      const waiter = yield* Effect.forkChild(chat.awaitSummarized().pipe(Effect.tap(() => Effect.sync(() => { returned = true; }))));
      yield* flush;
      yield* TestClock.adjust(999);
      expect(returned).toBe(false);
      expect((yield* load(dir)).nodes).toEqual([]);
      fault.mockRestore();
      yield* TestClock.adjust(1);
      yield* Fiber.join(waiter);
      yield* flush;
      expect(chat.status().pending).toBe(0);
      expect(chat.status().failed).toBe(0);
      expect(calls).toBe(1);
      expect((yield* load(dir)).nodes).toHaveLength(3);
    }).pipe(Effect.provide(TestClock.layer())));
  } finally { fault.mockRestore(); }
});

for (const retry of ["log", "backoff", "pump"] as const) test(`an ambiguous compaction write retries the same text on ${retry}`, async () => {
  const dir = temp();
  let calls = 0;
  const changing = deps(() => Effect.sync(() => output(`summary-${++calls}`)));
  const chat = await run(Chat.open(dir, changing));
  await run(ready(chat));
  const original = Store.prototype.appendNode;
  let failed = false;
  let attempts = 0;
  const fault = spyOn(Store.prototype, "appendNode").mockImplementation(function (this: Store, node) {
    const write = original.call(this, node);
    if (this.dir === dir && node.l === 0 && node.i === 0 && ++attempts === 2 && retry === "backoff") {
      return Effect.fail(new StoreError({ op: "appendNode", path: dir, cause: "disk still unavailable" }));
    }
    if (this.dir !== dir || failed) return write;
    failed = true;
    return write.pipe(Effect.andThen(Effect.fail(new StoreError({ op: "appendNode", path: dir, cause: "ambiguous fsync" }))));
  });
  try {
    await run(chat.log([item(0, "L".repeat(600))]));
    await run(flush);
    expect(chat.status().pending).toBe(1);
    expect(chat.status().failed).toBe(1);
    if (retry === "log") await run(chat.log([item(1, "next")]));
    if (retry === "pump") await run(chat.setTools([]));
    await run(chat.awaitSummarized());
    const saved = await run(load(dir));
    expect(calls).toBe(1);
    expect(attempts).toBe(retry === "backoff" ? 3 : 2);
    expect(saved.nodes.find((node) => node.l === 0 && node.i === 0)?.text).toBe("summary-1");
    const reopened = await run(Chat.open(dir, changing));
    await run(ready(reopened));
    await run(reopened.awaitSummarized());
    expect((await run(load(dir))).nodes).toEqual(saved.nodes);
    expect(reopened.renderView()).toEqual(chat.renderView());
  } finally { fault.mockRestore(); }
});

test("an ambiguous instant write is not built until the retained text is flushed", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  await run(ready(chat));
  const original = Store.prototype.appendNode;
  let failed = false;
  const fault = spyOn(Store.prototype, "appendNode").mockImplementation(function (this: Store, node) {
    const write = original.call(this, node);
    if (this.dir !== dir || failed) return write;
    failed = true;
    return write.pipe(Effect.andThen(Effect.fail(new StoreError({ op: "appendNode", path: dir, cause: "ambiguous fsync" }))));
  });
  try {
    await run(chat.log([item(0, "short")]));
    expect(chat.status().pending).toBe(1);
    expect(chat.renderView().tail).toContain("not summarized yet");
    await run(chat.setTools([]));
    expect(chat.status().pending).toBe(0);
    expect((await run(Chat.open(dir, deps()))).renderView()).toEqual(chat.renderView());
    expect((await run(load(dir))).nodes).toEqual([{ l: 0, i: 0, text: "user: short", size: 11 }]);
  } finally { fault.mockRestore(); }
});

test("a pre-header failure releases later same-prefix compactions", async () => {
  await run(Effect.gen(function* () {
    const fake = yield* controlled(false);
    const chat = yield* Chat.open(temp(), fake.deps);
    yield* ready(chat);
    yield* chat.log([item(0, "L".repeat(600)), item(1, "M".repeat(600))]);
    const first = yield* Queue.take(fake.calls);
    yield* flush;
    expect(fake.seen).toHaveLength(1);
    yield* Deferred.fail(first.reply, "before headers");
    const second = yield* Queue.take(fake.calls);
    expect(Deferred.isDoneUnsafe(first.input.started!)).toBe(true);
    yield* Deferred.succeed(second.reply, output("second"));
    yield* flush;
    expect(chat.status().failed).toBe(1);
    yield* chat.log([item(2, "next")]);
    const retry = yield* Queue.take(fake.calls);
    yield* Deferred.succeed(retry.reply, output("first"));
    yield* chat.awaitSummarized();
    yield* flush;
    expect(chat.status().pending).toBe(0);
  }));
});

test("out-of-order completions keep a gap-free view and merges wait for both halves", async () => {
  await run(Effect.gen(function* () {
    const dir = temp();
    const fake = yield* controlled();
    const chat = yield* Chat.open(dir, fake.deps);
    yield* ready(chat);
    yield* chat.log(Array.from({ length: 4 }, (_, i) => item(i, "L".repeat(600))));
    const calls: Call[] = [];
    for (let i = 0; i < 4; i++) calls.push(yield* Queue.take(fake.calls));
    yield* Deferred.succeed(calls[3]!.reply, output("s".repeat(300)));
    yield* flush;
    expect(fake.seen).toHaveLength(4);
    yield* Deferred.succeed(calls[2]!.reply, output("t".repeat(300)));
    const merge = yield* Queue.take(fake.calls);
    expect(merge.input.turns[0]!.parts.at(-1)!.text).toContain("merge lines 2+1 and 3+1");
    yield* Deferred.succeed(merge.reply, output("right"));
    for (const call of calls.slice(0, 2)) yield* Deferred.succeed(call.reply, output("short"));
    yield* chat.awaitSummarized();
    yield* flush;
    const rendered = chat.renderView().blocks.join("") + chat.renderView().tail;
    expect(rendered).toBe("<chat>\n0+1|short\n1+1|short\n2+1|" + "t".repeat(300) + "\n3+1|" + "s".repeat(300) + "\n</chat>");
    const refs = (yield* load(dir)).view!;
    let next = 0;
    for (const [l, i] of refs) { expect(i * 2 ** l).toBe(next); next += 2 ** l; }
    expect(next).toBe(4);
  }));
});

test("agent names are numbered per type and stay fixed per child", async () => {
  const chat = await run(Chat.open(temp(), deps()));
  expect(chat.agentName("childA", "explore")).toBe("explore-1");
  expect(chat.agentName("childA", "different")).toBe("explore-1");
  expect(chat.agentName("childB", "explore")).toBe("explore-2");
});

test("an agent's name survives restart once it has a log", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  expect(chat.agentName("childA", "explore")).toBe("explore-1");
  await run(chat.logAgent("explore-1", [{ ...item(0), src: "childA:msg_a" }]));
  const reopened = await run(Chat.open(dir, deps()));
  expect(reopened.agentName("childA", "other")).toBe("explore-1");
  expect(reopened.agentName("childC", "explore")).toBe("explore-2");
});

test("agent logs split long text, clip echoes, dedupe replays and stay out of the main chat", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  chat.agentName("childA", "explore");
  const items = [{ ...item(0, "L".repeat(30001)), src: "childA:msg_a" }, { ...item(1, "E".repeat(31000), "echo"), src: "childA:echo" }];
  await run(chat.logAgent("explore-1", items));
  await run(chat.logAgent("explore-1", items));
  const reopened = await run(Chat.open(dir, deps()));
  expect((await run(reopened.zoom("explore-1"))).text).toBe(`0|user: ${"L".repeat(30000)}\n1|user: L\n2|echo: ${clipEcho("E".repeat(31000))}`);
  expect(reopened.status().T).toBe(0);
});

test("zooming an unknown agent fails", async () => {
  const chat = await run(Chat.open(temp(), deps()));
  expect((await run(Effect.result(chat.zoom("missing"))))._tag).toBe("Failure");
});

test("agent name gaps after restart cannot reuse an existing log", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  chat.agentName("unused", "explore");
  expect(chat.agentName("child", "explore")).toBe("explore-2");
  await run(chat.logAgent("explore-2", [{ ...item(0), src: "child:msg" }]));
  const reopened = await run(Chat.open(dir, deps()));
  expect(reopened.agentName("new", "explore")).toBe("explore-3");
  expect(reopened.agentName("child", "other")).toBe("explore-2");
});

test("undoneFrom finds the first record whose source is gone", async () => {
  const chat = await run(Chat.open(temp(), deps()));
  await run(chat.log([item(0), item(1), item(2), item(3), item(4), item(5)]));
  expect(chat.undoneFrom(() => true)).toBeUndefined();
  expect(chat.undoneFrom(() => false)).toBeUndefined();
  expect(chat.undoneFrom((base) => base !== "msg_4" && base !== "msg_5")).toBe(4);
  expect(chat.undoneFrom((base) => ["msg_0", "msg_1", "msg_2"].includes(base))).toBe(3);
});

test("rewind drops undone records and their nodes, and the slot is rebuilt from the redo", async () => {
  const dir = temp();
  const chat = await run(Chat.open(dir, deps()));
  await run(ready(chat));
  const pic = { name: "p.png", mime: "image/png", data: new Uint8Array([7]) };
  await run(chat.log([item(0), item(1), item(2), item(3), item(4), { ...item(5), files: [pic] }]));
  await run(chat.awaitSummarized());
  expect(await run(chat.rewind(3))).toEqual(["msg_3", "msg_4", "msg_5"]);
  expect(chat.status().T).toBe(3);
  expect(chat.renderView().tail).not.toContain("message 3");
  await run(chat.log([item(6, "redo")]));
  await run(chat.awaitSummarized());
  const loaded = await run(load(dir));
  expect(loaded.records.map((rec) => [rec.i, rec.src])).toEqual([[0, "msg_0:0"], [1, "msg_1:0"], [2, "msg_2:0"], [3, "msg_6:0"]]);
  expect(loaded.nodes.every((node) => node.l > 0 || node.i < 4)).toBe(true);
  expect(loaded.nodes.find((node) => node.l === 0 && node.i === 3)!.text).toBe("user: redo");
  const reopened = await run(Chat.open(dir, deps()));
  expect(reopened.renderView()).toEqual(chat.renderView());
  expect((await run(reopened.zoom(3, 1))).text).toBe("user: redo");
  expect(reopened.status().T).toBe(4);
});

test("a compaction started before a rewind is dropped, and its slot is rebuilt from the new record", async () => {
  await run(Effect.gen(function* () {
    const fake = yield* controlled();
    const chat = yield* Chat.open(temp(), fake.deps);
    yield* ready(chat);
    yield* chat.log([item(0), item(1, "L".repeat(600))]);
    const stale = yield* Queue.take(fake.calls);
    yield* chat.rewind(1);
    yield* chat.log([item(2, "M".repeat(600))]);
    const fresh = yield* Queue.take(fake.calls);
    yield* Deferred.succeed(stale.reply, output("stale summary"));
    yield* flush;
    yield* Deferred.succeed(fresh.reply, output("fresh summary"));
    yield* chat.awaitSummarized();
    expect(chat.renderView().tail).toContain("1+1|fresh summary");
    expect(chat.renderView().tail).not.toContain("stale");
  }));
});

test("a newer copy of the module takes a chat over: the older one stops writing and its summaries are built again", async () => {
  // A second import of the module, as when OpenCode loads an updated copy of the package.
  const copy: string = "./chat.ts?copy=newer";
  const newer = await import(copy) as typeof import("./chat.ts");
  expect(newer.get).not.toBe(get);
  const dir = temp();
  await run(Effect.gen(function* () {
    const oldFake = yield* controlled();
    const old = yield* get("ses_takeover", oldFake.deps, dir);
    yield* ready(old);
    yield* old.log([item(0, "L".repeat(600))]);
    const stale = yield* Queue.take(oldFake.calls);

    const newFake = yield* controlled();
    const chat = yield* newer.get("ses_takeover", newFake.deps, dir);
    expect(chat).not.toBe(old);
    // The older copy's summary arrives after the takeover: it is dropped, not written.
    yield* Deferred.succeed(stale.reply, output("from the old copy"));
    yield* flush;
    expect((yield* load(dir)).nodes).toHaveLength(0);
    expect((yield* old.log([item(1)]).pipe(Effect.flip))).toBeInstanceOf(ChatError);
    expect((yield* get("ses_takeover", oldFake.deps, dir).pipe(Effect.flip))).toBeInstanceOf(ChatError);
    // Waiting on the closed chat returns instead of hanging.
    yield* old.awaitSummarized();

    // The newer copy reopened the chat from the store and builds the node itself.
    expect(yield* newer.get("ses_takeover", newFake.deps, dir)).toBe(chat);
    yield* ready(chat);
    const fresh = yield* Queue.take(newFake.calls);
    yield* Deferred.succeed(fresh.reply, output("from the new copy"));
    yield* chat.awaitSummarized();
    expect((yield* load(dir)).nodes.map((node) => node.text)).toEqual(["from the new copy"]);
    expect((yield* load(dir)).records).toHaveLength(1);
  }));
});
