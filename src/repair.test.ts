import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Chat, type Item } from "./chat.ts";
import { DAMAGE_SINCE, damaged, isGreeting, type Node } from "./repair.ts";
import { Store } from "./store.ts";

const GREETING = "What would you like me to do with UniiChat?";

test("greetings to the placeholder are damage; real summaries that mention UniiChat are not", () => {
  expect(isGreeting(GREETING)).toBe(true);
  expect(isGreeting("Hi! What can I help you with in UniiChat today?")).toBe(true);
  expect(isGreeting("user: do you think we have a bug in uniichat? investigate")).toBe(false);
  expect(isGreeting("tool/echo: asked 'Which of these should I port from VictorTaelin/UniiChat?'")).toBe(false);
});

test("damage is found from the bug's first day on, verbatim leaves are kept, and merges above damage go too", () => {
  const day = DAMAGE_SINCE;
  const nodes: Node[] = [
    { l: 0, i: 0, text: GREETING, day },
    { l: 0, i: 1, text: "user: fine", day },
    { l: 1, i: 0, text: "user: built on the greeting", day },
    { l: 0, i: 2, text: "clipped source", day },
    { l: 0, i: 3, text: GREETING, day: "2026-10-27" },
    { l: 0, i: 4, text: "user: What would you like with UniiChat?", day },
    { l: 2, i: 0, text: "user: above it all", day },
    { l: 1, i: 1, text: "user: two and three", day: "2026-10-27" },
  ];
  const bad = damaged(nodes, {
    verbatim: (i) => i === 4 ? "user: What would you like with UniiChat?" : undefined,
    clipped: ([l, i]) => l === 0 && i === 2 ? "clipped source" : undefined,
  });
  // 1:1 predates the bug but summarizes the damaged 0:2.
  expect([...bad].sort()).toEqual(["0:0", "0:2", "1:0", "1:1", "2:0"]);
});

test("repair drops damaged summaries to an archive and rebuilds them live from the log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uniichat-repair-"));
  let reply: (text: string) => string = (text) => text.includes("message 0") ? GREETING : "user: a real summary";
  const chat = await Effect.runPromise(Chat.open(dir, {
    compact: (input) => Effect.succeed({ text: reply(input.turns[0]!.parts.at(-1)!.text), ms: 1 }),
  }));
  const items: Item[] = [0, 1].map((i) => ({ kind: "user", text: `message ${i} `.repeat(80), date: 1793433900000, src: `msg_${i}` }));
  await Effect.runPromise(Effect.gen(function* () {
    yield* chat.setSystem("system");
    yield* chat.setTools([]);
    yield* chat.log(items);
    yield* chat.awaitSummarized();
    for (let i = 0; i < 50; i++) yield* Effect.yieldNow; // the instant merge over both leaves
    expect(yield* chat.damaged()).toBe(2); // the greeting leaf and the merge over it

    reply = () => "user: rebuilt";
    expect(yield* chat.repair()).toMatchObject({ dropped: 2, leaves: 1 });
    yield* chat.awaitSummarized();
    expect(yield* chat.damaged()).toBe(0);
    expect(chat.renderView().tail + chat.renderView().blocks.join("")).not.toContain("UniiChat?");
  }));
  const [stamp] = readdirSync(join(dir, "repaired"));
  expect(readFileSync(join(dir, "repaired", stamp!, "tree.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).text))
    .toEqual([GREETING, `${GREETING}\nuser: a real summary`]);
  const reopened = await Effect.runPromise(Effect.gen(function* () {
    const store = yield* Store.open(dir);
    return (yield* store.load()).nodes.map((node) => node.text);
  }));
  expect(reopened).not.toContain(GREETING);
  expect(reopened).toContain("user: rebuilt");
});
