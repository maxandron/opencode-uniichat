import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit } from "effect";
import { describeStream, make, withoutToolUse, type GenerateEvent, type Registry } from "./transport.ts";

const fresh = (): Registry => ({ pending: new Map(), known: new Set() });

/** A host whose `session.generate` runs the `generate` hooks currently registered, as OpenCode does. */
function host(id = "ses_tmp") {
  const hooks = new Set<(event: GenerateEvent) => void>();
  const created: unknown[] = [];
  const removed: string[] = [];
  const prompts: string[] = [];
  const seen: GenerateEvent[] = [];
  const registered: string[] = [];
  const ctx = {
    session: {
      create: (input: unknown) => Effect.sync(() => { created.push(input); return { id }; }),
      remove: ({ sessionID }: { sessionID: string }) => Effect.sync(() => { removed.push(sessionID); }),
      hook: (name: string) => Effect.sync(() => { registered.push(name); }),
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
  return { ctx, hooks, created, removed, prompts, seen, registered };
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

  test("forbids tool use only on calls that carry tools", async () => {
    for (const [tools, expected] of [[call.tools, ["http.request", "http.response"]], [[], ["http.response"]]] as const) {
      const h = host();
      const transport = make(h.ctx, fresh());
      h.hooks.add((event) => { transport.apply(event); });
      await Effect.runPromise(transport.run({ ...call, tools }));
      expect(h.registered).toEqual([...expected]);
    }
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

describe("withoutToolUse", () => {
  const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const tools = [{ name: "zoom" }];

  test("forbids tool use in each known API's terms and keeps the rest of the body", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["https://api.anthropic.com/v1/messages", { tool_choice: { type: "none" } }],
      ["https://api.openai.com/v1/responses", { tool_choice: "none" }],
      ["https://openrouter.ai/api/v1/chat/completions", { tool_choice: "none" }],
      ["https://generativelanguage.googleapis.com/v1beta/models/g:streamGenerateContent", { toolConfig: { functionCallingConfig: { mode: "NONE" } } }],
    ];
    for (const [url, expected] of cases) {
      const out = await withoutToolUse(post(url, { model: "m", tools, tool_choice: "auto", tool_config: {} }));
      const body = await out.json() as Record<string, unknown>;
      expect(body).toMatchObject({ model: "m", tools, ...expected });
      expect(out.headers.get("content-type")).toBe("application/json");
    }
  });

  test("leaves requests without tools, of unknown APIs, or not JSON unchanged", async () => {
    for (const request of [
      post("https://api.openai.com/v1/responses", { model: "m" }),
      post("https://bedrock.example/model/x/converse-stream", { tools }),
      new Request("https://api.openai.com/v1/responses", { method: "POST", body: "not json" }),
    ]) expect(await withoutToolUse(request)).toBe(request);
  });
});

describe("describeStream", () => {
  test("names why a response ended and the tool it called instead of answering", () => {
    const sse = [
      'data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"r"}}',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c","name":"zoom","arguments":"{}"}}',
      'data: {"type":"response.completed","response":{"status":"completed"}}',
    ].join("\n\n");
    expect(describeStream(sse)).toBe("ends: completed×1; items: reasoning×1, function_call×1; tool calls: zoom×1");
    expect(describeStream("")).toBe("response body unavailable");
  });
});
