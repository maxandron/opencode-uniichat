import { describe, expect, test } from "bun:test";
import { COMPACTION } from "./chat.ts";
import { configure, modelRef, parse } from "./options.ts";
import { lookupCalls, lookupResults } from "./prompts.ts";
import { QUEUE } from "./queue.ts";
import { CHAT_BUDGET, COMPACTION_BUDGET } from "./view.ts";

describe("options", () => {
  test("rejects dotted property names with a nesting hint instead of using defaults", () => {
    expect(() => parse({ "compaction.model": "openai/example" })).toThrow('unknown option "compaction.model"');
    expect(() => parse({ "compaction.model": "openai/example" })).toThrow("Use nested objects");
    expect(parse({ compaction: { model: "openai/example" } }).compaction.model).toBe("openai/example");
  });

  test.each([
    [{ defaultON: true }, "options"],
    [{ compaction: { modle: "openai/example" } }, "options.compaction"],
    [{ view: { chats: {} } }, "options.view"],
    [{ view: { chat: { high: 100, low: 50, extra: 1 } } }, "options.view.chat"],
    [{ btw: { lookupStep: 1 } }, "options.btw"],
    [{ prompts: { systems: "hello" } }, "options.prompts"],
    [{ tui: { sideBar: false } }, "options.tui"],
  ])("rejects unknown keys in %j with their location", (input, location) => {
    expect(() => parse(input)).toThrow(`${location}: unknown option`);
  });

  test("preserves arbitrary provider options while validating plugin-owned keys", () => {
    const providerOptions = { customProvider: { "custom.setting": true } };
    expect(parse({ compaction: { providerOptions } }).compaction.providerOptions).toEqual(providerOptions);
  });

  test.each([{ input: null }, { input: [] }, { input: "compaction.model=openai/example" }])("rejects a non-object options value: %j", ({ input }) => {
    expect(() => parse(input)).toThrow("UniiChat options are invalid; plugin loading stopped");
  });

  test("rejects bad values with the option's path", () => {
    expect(() => parse({ compaction: { model: "haiku" } })).toThrow("compaction.model");
    expect(() => parse({ view: { chat: { high: 10, low: 20 } } })).toThrow("view.chat");
  });

  test("configure sets the engine's process-wide settings", () => {
    const saved = { chat: { ...CHAT_BUDGET }, comp: { ...COMPACTION_BUDGET }, compaction: { ...COMPACTION }, slots: QUEUE.slots };
    try {
      configure(parse({ view: { chat: { high: 2000, low: 1000 } }, compaction: { timeoutMs: 1000, tries: 2, concurrency: 3 } }));
      expect(CHAT_BUDGET).toEqual({ high: 2000, low: 1000 });
      expect(COMPACTION).toEqual({ timeoutMs: 1000, tries: 2 });
      expect(QUEUE.slots).toBe(3);
    } finally {
      Object.assign(CHAT_BUDGET, saved.chat);
      Object.assign(COMPACTION_BUDGET, saved.comp);
      Object.assign(COMPACTION, saved.compaction);
      QUEUE.slots = saved.slots;
    }
  });

  test("modelRef splits at the first slash", () => {
    expect(modelRef("openrouter/anthropic/claude-haiku", "high")).toEqual({ providerID: "openrouter", id: "anthropic/claude-haiku", variant: "high" });
  });
});

describe("/btw lookup protocol", () => {
  test("reads one call per line and ignores everything else", () => {
    expect(lookupCalls("READY")).toEqual([]);
    expect(lookupCalls("zoom(40, 4)\n`date(12)`\nzoom(\"Explore\")\nzoom(7)\ndate(1, 2)\nsure: zoom(1, 2)")).toEqual([
      { name: "zoom", id: 40, n: 4, text: "zoom(40, 4)" },
      { name: "date", id: 12, text: "date(12)" },
      { name: "zoom", id: "Explore", text: "zoom(\"Explore\")" },
      { name: "zoom", id: 7, text: "zoom(7)" },
    ]);
    expect(lookupResults([{ call: "date(1)", text: "2026-10-17" }])).toStartWith("> date(1)\n2026-10-17\n\n[Reply");
  });
});
