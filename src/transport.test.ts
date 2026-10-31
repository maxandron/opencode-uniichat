import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit } from "effect";
import { make, type GenerateEvent, type Registry } from "./transport.ts";

const fresh = (): Registry => ({ pending: new Map(), known: new Set() });

/** A host whose `session.generate` runs the `generate` hooks currently registered, as OpenCode does. */
function host(id = "ses_tmp") {
  const hooks = new Set<(event: GenerateEvent) => void>();
  const created: unknown[] = [];
  const removed: string[] = [];
  const prompts: string[] = [];
  const seen: GenerateEvent[] = [];
  const ctx = {
    session: {
      create: (input: unknown) => Effect.sync(() => { created.push(input); return { id }; }),
      remove: ({ sessionID }: { sessionID: string }) => Effect.sync(() => { removed.push(sessionID); }),
      hook: () => Effect.void,
      generate: ({ sessionID, prompt }: { sessionID: string; prompt: string }) => Effect.sync(() => {
        prompts.push(prompt);
        const event: GenerateEvent = {
          sessionID, system: [{ type: "text", text: "opencode" }], messages: [],
          tools: { read: { description: "read", input: {} }, zoom: { description: "zoom", input: {} }, bash: { description: "bash", input: {} } },
          options: { stray: 1 },
        };
        for (const hook of hooks) hook(event);
        seen.push(event);
        return { text: " line " };
      }),
    },
  } as never;
  return { ctx, hooks, created, removed, prompts, seen };
}

const call = { parentID: "ses_chat", model: { providerID: "anthropic", id: "claude-haiku-9" }, system: "unii", messages: [], tools: ["zoom", "read", "gone"], options: { maxTokens: 10 } };

describe("transport", () => {
  test("runs a call in a throwaway child session and swaps in its request", async () => {
    const h = host();
    const transport = make(h.ctx, fresh());
    h.hooks.add((event) => { transport.apply(event); });
    const started = Deferred.makeUnsafe<void>();
    expect(await Effect.runPromise(transport.run({ ...call, started }))).toBe(" line ");
    expect(h.created).toEqual([expect.objectContaining({ parentID: "ses_chat", model: { providerID: "anthropic", id: "claude-haiku-9" } })]);
    expect(h.prompts).toEqual(["UniiChat call ses_tmp"]);
    expect(h.removed).toEqual(["ses_tmp"]);
    expect(h.seen[0]!.system).toEqual([{ type: "text", text: "unii" }]);
    expect(Object.keys(h.seen[0]!.tools)).toEqual(["zoom", "read"]);
    expect(h.seen[0]!.options).toEqual({ maxTokens: 10 });
    expect(transport.owns("ses_tmp")).toBe(true);
    expect(transport.apply({ ...h.seen[0]!, sessionID: "ses_other" })).toBe(false);
  });

  test("fails instead of returning the answer to an unswapped placeholder", async () => {
    const h = host();
    const transport = make(h.ctx, fresh());
    const exit = await Effect.runPromiseExit(transport.run(call));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("went out without its request");
    expect(h.seen[0]!.system).toEqual([{ type: "text", text: "opencode" }]);
    expect(h.removed).toEqual(["ses_tmp"]);
  });

  test("a call made by a disposed instance is applied by the live instance's hook, across module copies", async () => {
    // A second import of the module, as when OpenCode loads an updated copy of the package.
    const copy: string = "./transport.ts?copy=live";
    const other = await import(copy) as typeof import("./transport.ts");
    expect(other.make).not.toBe(make);
    const h = host("ses_tmp_shared");
    const stale = make(h.ctx);
    const live = other.make(h.ctx);
    // Only the live instance's hook is registered: the instance that opened the chat is gone.
    h.hooks.add((event) => { live.apply(event); });
    expect(await Effect.runPromise(stale.run(call))).toBe(" line ");
    expect(h.seen[0]!.system).toEqual([{ type: "text", text: "unii" }]);
    expect(live.owns("ses_tmp_shared")).toBe(true);
  });
});
