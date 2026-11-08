import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Chat, get, replace, type Deps, type Item } from "./chat.ts";
import { pair } from "./fork.ts";
import type { Row } from "./history.ts";
import { Store, publishFork, stagingDir } from "./store.ts";
import { last } from "./tree.ts";

const run = Effect.runPromise;
const temp = () => mkdtempSync(join(tmpdir(), "uniichat-fork-"));
const deps: Deps = { compact: () => Effect.succeed({ text: "summary", ms: 1 }) };
const row = (id: string, type: string, created: number, tools: string[] = []) => ({
  id, type, time: { created },
  ...(type === "assistant" ? { content: tools.map((tool) => ({ type: "tool", id: tool })) } : {}),
}) as unknown as Row;

test("pairs a fork's messages with the source's by type and creation time, in order", () => {
  const source = [row("msg_a", "user", 1), row("msg_b", "assistant", 2, ["toolu_1"]), row("msg_c", "idle", 2), row("msg_d", "user", 3)];
  // The fork stops before msg_d and renames the rest; equal times pair by type.
  const fork = [row("msg_f_5", "user", 1), row("msg_f_6", "assistant", 2), row("msg_f_9", "idle", 2)];
  const { rename, present } = pair(source, fork);
  expect([...rename]).toEqual([["msg_a", "msg_f_5"], ["msg_b", "msg_f_6"], ["msg_c", "msg_f_9"]]);
  expect([...present].sort()).toEqual(["msg_a", "msg_b", "msg_c", "toolu_1"]);
});

const sourceChat = async () => {
  const from = temp();
  const source = await run(Chat.open(from, deps));
  await run(source.setSystem("system"));
  await run(source.setTools([]));
  const early = source.agentName("ses_child1", "general");
  const late = source.agentName("ses_child2", "general");
  await run(source.logAgent(early, [{ kind: "user", text: "task one", date: 1791547200000, src: "ses_child1" }]));
  await run(source.logAgent(late, [{ kind: "user", text: "task two", date: 1791547200000, src: "ses_child2" }]));
  const items: Item[] = [
    { kind: "user", text: "one", date: 1791547200000, src: "msg_a" },
    { kind: "tool", text: "read {}", date: 1791547200000, src: "toolu_1:call" },
    { kind: "work", text: `[${early}] done`, date: 1791547200000, src: "msg_w1" },
    { kind: "user", text: "two", date: 1791547200000, src: "msg_b" },
    { kind: "work", text: `[${late}] done`, date: 1791547200000, src: "msg_w2" },
    { kind: "user", text: "three", date: 1791547200000, src: "msg_c" },
  ];
  await run(source.log(items));
  await run(source.awaitSummarized());
  return { from, source, early, late };
};
const rename = new Map([["msg_a", "msg_f_1"], ["msg_w1", "msg_f_2"], ["msg_b", "msg_f_3"]]);

test("a fork's copy renames the sources, keeps the summaries and agents below the fork point, and is cut there", async () => {
  const { from, source, early, late } = await sourceChat();
  const to = join(temp(), "fork");
  const present = new Set(["msg_a", "toolu_1", "msg_w1", "msg_b"]);
  expect(await run(source.forkCopy(to, rename, present))).toEqual({ keep: 4, unmatched: undefined });
  const loaded = await run(Store.open(to).pipe(Effect.flatMap((store) => store.load())));
  expect(loaded.records.map((rec) => rec.src)).toEqual(["msg_f_1:0", "toolu_1:call:0", "msg_f_2:0", "msg_f_3:0"]);
  expect(loaded.system).toBe("system");
  // Summaries over the kept records came along; none covers a cut one; the views end at the cut.
  expect(loaded.nodes.some((node) => node.l === 1 && node.i === 0)).toBe(true);
  expect(loaded.nodes.every((node) => last(node.l, node.i) < 4)).toBe(true);
  expect(last(...loaded.view!.at(-1)!)).toBe(3);
  // The agent reported before the fork point came along; the later one did not.
  expect([...loaded.agents.keys()]).toEqual([early]);
  expect(late).not.toBe(early);
  const fork = await run(Chat.open(to, deps));
  expect(fork.size()).toBe(4);
  // The source is untouched.
  const original = await run(Store.open(from).pipe(Effect.flatMap((store) => store.load())));
  expect(original.records.map((rec) => rec.src)).toEqual(["msg_a:0", "toolu_1:call:0", "msg_w1:0", "msg_b:0", "msg_w2:0", "msg_c:0"]);
});

test("a fork before the first record keeps nothing and writes nothing", async () => {
  const { source } = await sourceChat();
  const to = join(temp(), "fork");
  // Only messages the log has no record of (an idle row) were paired.
  expect(await run(source.forkCopy(to, new Map([["msg_idle", "msg_f_1"]]), new Set(["msg_idle"])))).toEqual({ keep: 0, unmatched: undefined });
  expect(existsSync(to)).toBe(false);
});

test("a fork's copy is refused when a kept record's message has no copy in the fork", async () => {
  const { source } = await sourceChat();
  const to = join(temp(), "fork");
  // The fork's history starts at a checkpoint: msg_a was not paired.
  const present = new Set(["toolu_1", "msg_w1", "msg_b"]);
  expect(await run(source.forkCopy(to, rename, present))).toEqual({ keep: 4, unmatched: "msg_a" });
  expect(existsSync(to)).toBe(false);
});

test("replace serves the published store to a concurrent get, and releases the chat when publishing fails", async () => {
  const { source } = await sourceChat();
  const dest = join(temp(), "ses_fork");
  const sessionID = `ses_fork_${Math.random()}`;
  // A status call opened the fork's empty chat before the fork was checked.
  const empty = await run(get(sessionID, deps, dest));
  expect(empty.size()).toBe(0);
  const staging = stagingDir(dest);
  await run(source.forkCopy(staging, rename, new Set(["msg_a", "toolu_1", "msg_w1", "msg_b"])));
  const [replaced, concurrent] = await Promise.all([
    run(replace(sessionID, deps, publishFork(staging, dest), dest)),
    run(get(sessionID, deps, dest)),
  ]);
  expect(replaced.size()).toBe(4);
  expect(concurrent).toBe(replaced);
  expect(existsSync(staging)).toBe(false);
  // A failed publish leaves the store as it is and the next get opens it.
  const failed = await run(replace(sessionID, deps, publishFork(join(temp(), "missing"), dest), dest).pipe(Effect.exit));
  expect(failed._tag).toBe("Failure");
  expect((await run(get(sessionID, deps, dest))).size()).toBe(4);
});
