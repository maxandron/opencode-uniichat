import { describe, expect, test } from "bun:test";
import { Message } from "@opencode/ai/effect";
import { blocks } from "./view.ts";
import { btwRequest, buildRequest, cutTurn, isStub, stubCut, STUB_SUMMARY, EMPTY_CATALOG, extractCatalog, extractSkills, items, segments, selectLogged, subagentReport, turnKey, type RequestMessage, type Row } from "./history.ts";

const time = { created: 1700000000000 };
const model = { id: "claude-sonnet-4-5", providerID: "anthropic" };
const user = (id: string, text = "task"): Row => ({ type: "user", id, text, time });
const idle = (id: string): Row => ({ type: "idle", id, outcome: "succeeded", time });
type Tool = Extract<Extract<Row, { type: "assistant" }> ["content"][number], { type: "tool" }>;
const tool = (id: string, state: Tool["state"]): Tool => ({ type: "tool", id, name: "read", state, time: { ...time, completed: time.created + 10 } });
const assistant = (content: Extract<Row, { type: "assistant" }> ["content"], id = "msg_a"): Row => ({ type: "assistant", id, agent: "build", model, content, time });
const checkpoint = (status: "completed" | "running" = "completed"): Row => ({ type: "compaction", id: "msg_checkpoint", status, reason: "auto", summary: "summary", time });
const wrapper = (report: string) => `<subagent sessionID="ses_child" state="completed" description="task">\n${report}\n</subagent>`;
const name = (id: string) => id === "ses_child" ? "explore-1" : "unknown";
const msg = (role: RequestMessage["role"], id?: string, text = "task"): RequestMessage => ({ role, id, content: [{ type: "text", text }] });
const request = (messages: RequestMessage[], extra: Partial<Parameters<typeof buildRequest>[0]> = {}) => buildRequest({ messages, turnIds: new Set(["msg_new", "msg_a", "msg_report"]), view: blocks(["0+1|old", "1+1|old", "2+1|old", "3+1|old"]), reports: new Map(), state: "state", ...extra });
const texts = (message: RequestMessage) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
const marked = (messages: readonly RequestMessage[]) => messages.flatMap((message) => message.content.filter((part) => "cache" in part && part.cache !== undefined));

describe("durable turn boundaries", () => {
  test("steered user and synthetic input stay in the turn until idle", () => {
    const steer = { ...user("msg_steer"), metadata: { delivery: "steer" } };
    const rows: Row[] = [user("msg_old"), idle("msg_idle"), user("msg_new"), assistant([]), steer, { type: "synthetic", id: "msg_report", text: wrapper("done"), metadata: { source: "subagent", childID: "ses_child" }, time }];
    const parts = segments(rows);
    expect(parts.map((part) => [part.key, [...part.ids]])).toEqual([["start", ["msg_old"]], ["msg_idle", ["msg_new", "msg_a", "msg_steer", "msg_report"]]]);
    expect(turnKey(rows)).toBe("msg_idle");
    expect(turnKey([])).toBe("start");
    expect(turnKey([steer])).toBe("start");
    expect(segments([...rows, idle("msg_end")]).at(-1)).toEqual({ key: "msg_end", ids: new Set(), rows: [] });
  });

  test("only already logged segments and the current enabled segment are selected", () => {
    const parts = segments([user("msg_before"), idle("msg_i1"), user("msg_logged"), idle("msg_i2"), user("msg_off"), idle("msg_i3"), user("msg_new")]);
    const recorded = new Set(["msg_logged:0"]);
    const has = (id: string) => [...recorded].some((src) => src.startsWith(`${id}:`));
    expect(selectLogged(parts, has, true).map((part) => part.key)).toEqual(["msg_i1", "msg_i3"]);
    expect(selectLogged(parts, has, false).map((part) => part.key)).toEqual(["msg_i1"]);
  });

  test("only a completed checkpoint after the last idle cuts the turn", () => {
    expect(cutTurn([user("msg_new"), checkpoint()])).toBe(true);
    expect(cutTurn([idle("msg_idle"), checkpoint(), user("msg_new")])).toBe(true);
    expect(cutTurn([checkpoint(), idle("msg_idle"), user("msg_new")])).toBe(false);
    expect(cutTurn([checkpoint("running"), user("msg_new")])).toBe(false);
    expect(cutTurn([])).toBe(false);
    expect(cutTurn([{ type: "compaction", id: "msg_failed", status: "failed", reason: "auto", error: { type: "unknown", message: "failed" }, time }])).toBe(false);
    // UniiChat's own stub, tagged or (older) recognised by its text, does not cut the turn.
    const tagged: Row = { type: "compaction", id: "msg_stub", status: "completed", reason: "auto", summary: "x", metadata: { uniichat: "skipped" }, time };
    const legacy: Row = { type: "compaction", id: "msg_stub2", status: "completed", reason: "auto", summary: STUB_SUMMARY, time };
    expect(isStub(tagged) && isStub(legacy) && !isStub(checkpoint())).toBe(true);
    expect(cutTurn([idle("msg_idle"), user("msg_new"), tagged])).toBe(false);
    expect(cutTurn([idle("msg_idle"), user("msg_new"), legacy, checkpoint()])).toBe(true);
    expect(stubCut([idle("msg_idle"), user("msg_new"), tagged, assistant([])])).toBe(true);
    expect(stubCut([tagged, idle("msg_idle"), user("msg_new")])).toBe(false);
  });
});

describe("history log items", () => {
  test("content order precedes result order, with source bases and result times", () => {
    const rows = [assistant([
      { type: "text", text: "before" },
      tool("call_1", { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "one" }] }),
      { type: "reasoning", text: "private" },
      { type: "text", text: "between" },
      tool("call_2", { status: "error", input: { path: "b" }, error: { type: "unknown", message: "missing" } }),
      { type: "text", text: "partial interrupted text" },
    ])];
    expect(items(rows, { name })).toEqual([
      { kind: "unii", text: "before", date: time.created, src: "msg_a:0" },
      { kind: "tool", text: 'read {"path":"a"}', date: time.created, src: "call_1:call" },
      { kind: "unii", text: "between", date: time.created, src: "msg_a:3" },
      { kind: "tool", text: 'read {"path":"b"}', date: time.created, src: "call_2:call" },
      { kind: "unii", text: "partial interrupted text", date: time.created, src: "msg_a:5" },
      { kind: "echo", text: "one", date: time.created + 10, src: "call_1:result" },
      { kind: "echo", text: "error: missing", date: time.created + 10, src: "call_2:result" },
    ]);
  });

  test("a failed or stopped assistant message leaves a note after its results", () => {
    const failed = { ...assistant([{ type: "text", text: "partial" }]), error: { type: "provider.content-filter", message: "Provider blocked the response" } } as Row;
    const stopped = { ...assistant([]), id: "msg_b", error: { type: "aborted", message: "Step interrupted" } } as Row;
    expect(items([failed, stopped], { name }).filter((item) => item.kind === "note").map((item) => [item.src, item.text])).toEqual([
      ["msg_a:error", "No reply: Provider blocked the response. Send a message to try again."],
      ["msg_b:error", "Stopped: this turn was interrupted."],
    ]);
  });

  test("streaming calls and pending results are not logged", () => {
    const rows = [assistant([tool("stream", { status: "streaming", input: '{"path":' }), tool("running", { status: "running", input: { path: "a" }, metadata: {} }), { type: "text", text: "" }, { type: "reasoning", text: "secret" }])];
    expect(items(rows, { name }).map((item) => item.src)).toEqual(["running:call"]);
  });

  test("typed and steered input retain files as bytes, including empty files", () => {
    const row: Row = { ...user("msg_new", "look"), type: "user", text: "look", files: [{ name: "a.png", mime: "image/png", source: { type: "inline" }, data: "AQID" }, { mime: "text/plain", source: { type: "uri", uri: "file:///empty" }, data: "" }], metadata: { delivery: "steer" } };
    expect(items([row], { name })).toEqual([{ kind: "user", text: "look", date: time.created, src: "msg_new", files: [{ name: "a.png", mime: "image/png", data: new Uint8Array([1, 2, 3]) }, { name: "file:///empty", mime: "text/plain", data: new Uint8Array() }] }]);
  });

  test("tool files are separate from text; unavailable URI files remain explicit", () => {
    const row = assistant([tool("files", { status: "completed", input: {}, content: [{ type: "text", text: "first" }, { type: "file", uri: "data:image/png;base64,AQID", name: "pic", mime: "image/png" }, { type: "text", text: "last" }, { type: "file", uri: "file:///not-read", mime: "application/pdf" }] })]);
    expect(items([row], { name }).at(-1)).toEqual({ kind: "echo", text: "first\nlast", date: time.created + 10, src: "files:result", files: [{ name: "pic", mime: "image/png", data: new Uint8Array([1, 2, 3]) }, { name: "attachment", mime: "application/pdf" }] });
    const error = assistant([tool("error", { status: "error", input: {}, error: { type: "unknown", message: "fallback" }, content: [{ type: "text", text: "detail" }] })]);
    expect(items([error], { name }).at(-1)?.text).toBe("error: detail");
  });

  test("subagent reports are work; user-invoked skills are user; shell and other control rows are omitted", () => {
    const rows: Row[] = [
      { type: "synthetic", id: "msg_report", text: wrapper("line one\n\nline two"), metadata: { source: "subagent", childID: "ses_child" }, time },
      { type: "synthetic", id: "msg_other", text: "ignore", time },
      { type: "system", id: "msg_system", text: "update", time },
      { type: "skill", id: "msg_skill", skill: "skill", name: "skill", text: "instructions", time },
      { type: "shell", id: "msg_shell", shellID: "shell_1", command: "pwd", status: "exited", time },
      { type: "agent-switched", id: "msg_agent", agent: "explore", time },
      { type: "model-switched", id: "msg_model", model, time },
      { type: "location-switched", id: "msg_location", location: { directory: "/work" }, time },
      checkpoint(), idle("msg_idle"),
    ];
    expect(items(rows, { name })).toEqual([
      { kind: "work", text: "[explore-1] line one\n\nline two", date: time.created, src: "msg_report" },
      { kind: "user", text: "instructions", date: time.created, src: "msg_skill" },
    ]);
    for (const report of ["Subagent cancelled", "failed", "\n spaced \n", ""]) expect(subagentReport(wrapper(report))).toBe(report);
    for (const text of ["not wrapped", "<subagent broken>", "<subagent broken>\npartial"]) {
      expect(subagentReport(text)).toBe(text);
    }
  });
});

describe("context request", () => {
  test("earlier turns and system updates are dropped; call-result pairs survive", () => {
    const call = { type: "tool-call" as const, id: "call_1", name: "read", input: { path: "a" } };
    const result = { type: "tool-result" as const, id: "call_1", name: "read", result: { type: "text" as const, value: "output" } };
    const source: RequestMessage[] = [msg("user", "msg_old"), msg("assistant", "msg_old_a"), msg("user", "msg_new"), msg("system", undefined, "new instructions"), { role: "assistant", id: "msg_a", content: [call] }, { role: "tool", content: [result] }];
    const before = JSON.stringify(source);
    const output = request(source);
    expect(output.map((message) => [message.role, message.id])).toEqual([["user", "msg_new"], ["assistant", "msg_a"], ["tool", undefined]]);
    expect(output[1]!.content).toEqual([call]);
    expect(output[2]!.content).toEqual([{ ...result, cache: { type: "ephemeral" } }]);
    expect(marked(output)).toHaveLength(2);
    expect(JSON.stringify(source)).toBe(before);
    expect(() => request([msg("user", "msg_old")])).toThrow("turn cut");
  });

  test("user-first content gets view then state then original parts", () => {
    const original = Message.make({ id: "msg_new", role: "user", content: [{ type: "text", text: "task", cache: { type: "ephemeral" } }] });
    const output = request([original]);
    expect(texts(output[0]!)).toEqual(["<chat>\n0+1|old\n1+1|old\n2+1|old\n3+1|old\n", "</chat>", "state", "task"]);
    expect(marked(output)).toHaveLength(2);
    const normalized = Message.make(output[0]!);
    expect(normalized.id).toBe("msg_new");
    expect(normalized.content).toEqual(output[0]!.content);
  });

  test("assistant-first inserts a user prefix and end mark skips reasoning", () => {
    const output = request([{ role: "assistant", id: "msg_a", content: [{ type: "text", text: "reply" }, { type: "reasoning", text: "secret" }] }]);
    expect(output.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(texts(output[0]!).at(-1)).toBe("state");
    expect(output[1]!.content).toEqual([{ type: "text", text: "reply", cache: { type: "ephemeral" } }, { type: "reasoning", text: "secret" }]);
  });

  test("report rewrite keeps the synthetic id and the full report in one part", () => {
    const report = `[explore-1] ${"r".repeat(30001)}`;
    const output = request([msg("user", "msg_new"), msg("user", "msg_report", wrapper("old"))], { reports: new Map([["msg_report", report]]) });
    expect(output[1]).toEqual({ role: "user", id: "msg_report", content: [{ type: "text", text: report, cache: { type: "ephemeral" } }] });
  });

  for (const tail of [0, 1, 2, 3]) test(`view with ${tail} tail lines marks only last whole block and request end`, () => {
    const view = blocks(Array.from({ length: 8 + tail }, (_, i) => `${i}+1|line`));
    const output = request([msg("user", "msg_new")], { view });
    expect(output[0]!.content.slice(0, 3)).toEqual([{ type: "text", text: view.blocks[0] }, { type: "text", text: view.blocks[1], cache: { type: "ephemeral" } }, { type: "text", text: view.tail }]);
    expect(marked(output)).toHaveLength(2);
  });

  test("a view with no whole block has only the end mark", () => {
    const output = request([msg("user", "msg_new")], { view: blocks(["0+1|old"]) });
    expect(marked(output)).toHaveLength(1);
    expect(texts(output[0]!)[0]).toBe("<chat>\n0+1|old\n</chat>");
  });

  test("children keep all checkpoint-selected history and omit state and system rows", () => {
    const output = request([msg("system"), msg("user", "msg_checkpoint"), msg("assistant", "msg_old_a"), msg("user", "msg_new")], { child: true, turnIds: new Set() });
    expect(output.map((message) => message.id)).toEqual(["msg_checkpoint", "msg_old_a", "msg_new"]);
    expect(texts(output[0]!)).toEqual(["<chat>\n0+1|old\n1+1|old\n2+1|old\n3+1|old\n", "</chat>", "task"]);
    expect(request([msg("assistant", "msg_old_a")], { child: true })[0]!.role).toBe("user");
  });
});

describe("Code Mode catalog", () => {
  const catalog = "# Code Mode\n\nUse the `execute` tool.\n\n## Available tools\n\n- tools.read";
  for (const next of ["<mcp_instructions>", "Project references provide additional directories", "Skills provide specialized instructions", "Instructions from: /work/AGENTS.md", "Today's date: Fri Oct 09 2026"]) {
    test(`ends before ${next}`, () => {
      expect(extractCatalog([{ type: "text", text: "base" }, { type: "text", text: `${catalog}\n\n${next}\nignored` }])).toBe(catalog);
      expect(extractCatalog([`${EMPTY_CATALOG}\n\n${next}`])).toBe(EMPTY_CATALOG);
    });
  }
  test("handles a terminal catalog, exact empty catalog, and absent inventory", () => {
    expect(extractCatalog([catalog])).toBe(catalog);
    expect(extractCatalog([EMPTY_CATALOG])).toBe(EMPTY_CATALOG);
    expect(extractCatalog(["base", "Instructions from: /work/AGENTS.md"])).toBeUndefined();
    expect(extractCatalog([`base\n\n${catalog}`])).toBeUndefined();
    expect(extractCatalog(["No Code Mode tools are currently available."])).toBeUndefined();
  });
});

describe("skills section", () => {
  const skills = [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "<available_skills>",
    "  <skill>",
    "    <id>research</id>",
    "    <name>research</name>",
    "    <description>Look things up.\n\nThoroughly.</description>",
    "  </skill>",
    "</available_skills>",
  ].join("\n");
  const none = "Skills provide specialized instructions and workflows for specific tasks.\nNo skills are currently available.";
  test("is cut from the combined instructions", () => {
    expect(extractSkills(["base", `# Code Mode\n\ncatalog\n\n${skills}\n\nInstructions from: /work/AGENTS.md\nignored`])).toBe(skills);
    expect(extractSkills([{ type: "text", text: `${none}\n\nToday's date: Fri Oct 09 2026` }])).toBe(none);
  });
  test("is absent without a skills header", () => {
    expect(extractSkills(["base", "# Code Mode\n\ncatalog"])).toBeUndefined();
    expect(extractSkills(["see Skills provide specialized instructions inline </available_skills>"])).toBeUndefined();
  });
});

describe("btw request", () => {
  const view = blocks(["0+1|old", "1+1|old", "2+1|old", "3+1|old"]);
  test("mid-turn: view, raw turn, question; earlier history dropped", () => {
    const out = btwRequest({ messages: [msg("user", "msg_old", "old"), msg("user", "msg_new"), msg("assistant", "msg_a", "working"), msg("user", undefined, "side?")], turnIds: new Set(["msg_new", "msg_a"]), view, reports: new Map() });
    expect(out.map((message) => message.id)).toEqual(["msg_new", "msg_a", undefined]);
    expect(texts(out[0]!)[0]).toContain("0+1|old");
    expect(texts(out[0]!).at(-1)).toBe("task");
    expect(texts(out[2]!)).toEqual(["side?"]);
  });
  test("between turns: only the view and the question, with extra text appended", () => {
    const out = btwRequest({ messages: [msg("user", "msg_old", "old"), msg("assistant", "msg_r", "reply"), msg("user", undefined, "side?")], turnIds: new Set(), view, reports: new Map(), extra: "note" });
    expect(out).toHaveLength(1);
    expect(texts(out[0]!)[0]).toContain("0+1|old");
    expect(texts(out[0]!).slice(-2)).toEqual(["side?", "note"]);
    expect(texts(out[0]!).join("")).not.toContain("reply");
  });
});
