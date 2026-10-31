/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context";
import { Plugin } from "@opencode/plugin/tui";
import { RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { UniiChatRpc } from "./rpc.ts";

// The `tui` plugin options (see options.ts, which the server side validates).
let POLL_INTERVAL_MS = 2_000;
function tuiOptions(options: Readonly<Record<string, unknown>> | undefined) {
  const tui = (options?.tui ?? {}) as { pollMs?: unknown; sidebar?: unknown };
  return {
    pollMs: typeof tui.pollMs === "number" && tui.pollMs > 0 ? tui.pollMs : 2_000,
    sidebar: tui.sidebar !== false,
  };
}
const rpcClient = (ctx: Context) => ctx.client.rpc(UniiChatRpc);
type Status = Awaited<ReturnType<ReturnType<typeof rpcClient>["status"]>>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

const tokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
const duration = (ms: number) => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const kilobytes = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;

function usageLabel(usage: Status["lastTurn"]): string {
  if (!usage) return "none yet";
  const parts = [
    `${tokens(usage.input)} in`,
    `${tokens(usage.output)} out`,
    `cache ${tokens(usage.cacheRead)} read / ${tokens(usage.cacheWrite)} write`,
  ];
  if (Number.isFinite(usage.cost) && usage.cost > 0) parts.push(`$${usage.cost.toFixed(2)}`);
  if (usage.ms !== undefined) parts.push(duration(usage.ms));
  return parts.join("  ·  ");
}

const LINE = /^(\d+)\+(\d+)\|/;
// A summary or message starts with its kind ("user:", "echo1269:", "tool1203:"...).
const KIND = /^(user|unii|tool|echo|work|note)(\d*):/;
// Blank rows between list entries, so wrapped lines don't run into each other.
const ROW_GAP = 1;
const WORK = /^work: \[([^\]\s]+)\]/;

// One screen of the browser: the live view, the two lines a zoom opened, or a whole message.
type Level =
  | { kind: "list"; title: string; lines: string[]; selected: number }
  | { kind: "text"; title: string; text: string; agent?: string };

function Popup(props: { ctx: Context; sessionID: string }) {
  const ctx = props.ctx;
  const rpc = rpcClient(ctx);
  const controller = new AbortController();
  const options = { location: ctx.location, signal: controller.signal };
  const dimensions = useTerminalDimensions();
  // The dialog is centered and adds one row of top padding. Give the popup a fixed
  // height that fits the terminal and let the scrollbox take what the header leaves,
  // so the bottom of the view is never drawn past the screen.
  const outer = () => Math.max(12, dimensions().height - 6);
  const page = () => Math.max(1, (scroll?.viewport.height ?? outer()) - 1);
  const [status, setStatus] = createSignal<Status>();
  const [lines, setLines] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [statusError, setStatusError] = createSignal<string>();
  const [viewError, setViewError] = createSignal<string>();
  // The live view is the root; Enter pushes a zoom, Escape pops it.
  const [rootSelected, setRootSelected] = createSignal<number>();
  const [stack, setStack] = createSignal<Level[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [zoomError, setZoomError] = createSignal<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scroll: ScrollBoxRenderable | undefined;

  const top = () => stack().at(-1);
  const current = (): Level => top() ?? {
    kind: "list",
    title: "View",
    lines: lines(),
    selected: Math.min(rootSelected() ?? lines().length - 1, lines().length - 1),
  };
  const select = (index: number) => {
    const level = current();
    if (level.kind !== "list" || level.lines.length === 0) return;
    const next = Math.max(0, Math.min(level.lines.length - 1, index));
    if (stack().length === 0) setRootSelected(next >= lines().length - 1 ? undefined : next);
    else setStack((levels) => [...levels.slice(0, -1), { ...level, selected: next }]);
  };

  // Keep the selected line on screen, but only when the selection or level changes, so a
  // poll does not undo mouse-wheel scrolling.
  const focus = createMemo(() => {
    const level = current();
    return level.kind === "list" ? `${stack().length}:${level.selected}` : undefined;
  });
  createEffect(on(focus, (key) => {
    if (key === undefined) return;
    const index = Number(key.split(":")[1]);
    // Rows of a new level or a first load are laid out after this effect runs.
    setTimeout(() => {
      const row = scroll?.getChildren()[index];
      if (row) scroll?.scrollChildIntoView(row.id);
    }, 0);
  }));

  // PgUp/PgDn move the selection by about a screen of rows; lines wrap, so count rows, not lines.
  const pageSelect = (direction: 1 | -1) => {
    const level = current();
    if (level.kind !== "list") return;
    const rows = scroll?.getChildren() ?? [];
    let budget = page();
    let index = level.selected;
    while (budget > 0) {
      const next = index + direction;
      if (next < 0 || next >= rows.length) break;
      budget -= Math.max(1, rows[next]!.height) + ROW_GAP;
      index = next;
    }
    select(index);
  };

  const refresh = async () => {
    const input = { sessionID: props.sessionID };
    await Promise.allSettled([
      rpc.status(input, options).then((next) => {
        if (controller.signal.aborted) return;
        setStatus(next);
        setStatusError(undefined);
      }).catch((cause) => {
        if (!controller.signal.aborted) setStatusError(errorMessage(cause));
      }),
      rpc.view(input, options).then((view) => {
        if (controller.signal.aborted) return;
        setLines(view);
        setViewError(undefined);
      }).catch((cause) => {
        if (!controller.signal.aborted) setViewError(errorMessage(cause));
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      }),
    ]);
    if (!controller.signal.aborted) {
      timer = setTimeout(() => void refresh(), POLL_INTERVAL_MS);
    }
  };

  const open = async (title: string, input: { id: number; n: number } | { name: string }) => {
    if (busy()) return;
    setBusy(true);
    setZoomError(undefined);
    try {
      const text = await rpc.archive({ sessionID: props.sessionID, ...input }, options);
      if (controller.signal.aborted) return;
      const level: Level = "n" in input && input.n > 1
        ? { kind: "list", title, lines: text.split("\n").filter(Boolean), selected: 0 }
        : { kind: "text", title, text: text || "(empty)", agent: "n" in input ? WORK.exec(text)?.[1] : undefined };
      setStack((levels) => [...levels, level]);
      scroll?.scrollTo(0);
    } catch (cause) {
      if (!controller.signal.aborted) setZoomError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const zoomIn = () => {
    const level = current();
    if (level.kind === "text") {
      if (level.agent) void open(`agent ${level.agent}`, { name: level.agent });
      return;
    }
    const match = LINE.exec(level.lines[level.selected] ?? "");
    if (match) void open(`${match[1]}+${match[2]}`, { id: Number(match[1]), n: Number(match[2]) });
  };

  const back = () => {
    setZoomError(undefined);
    if (stack().length === 0) {
      ctx.ui.dialog.clear();
      return;
    }
    setStack((levels) => levels.slice(0, -1));
  };

  // Bound in the modal layer, like OpenCode's own dialogs: a raw key handler loses
  // PgUp/PgDn to the session's global page commands, which also close the dialog.
  // Priority lets Escape step back out of a zoom before the dialog's own Escape closes it.
  const isList = () => current().kind === "list";
  ctx.keymap.layer(() => ({
    mode: "modal",
    priority: 10,
    commands: [
      { bind: "escape", title: "Back / close", group: "UniiChat", run: back },
      { bind: "return", title: "Zoom in", group: "UniiChat", run: zoomIn },
      { bind: "up", title: "Previous line", group: "UniiChat", run: () => isList() ? select((current() as { selected: number }).selected - 1) : scroll?.scrollBy(-1) },
      { bind: "down", title: "Next line", group: "UniiChat", run: () => isList() ? select((current() as { selected: number }).selected + 1) : scroll?.scrollBy(1) },
      { bind: "pageup", title: "Previous page", group: "UniiChat", run: () => isList() ? pageSelect(-1) : scroll?.scrollBy(-page()) },
      { bind: "pagedown", title: "Next page", group: "UniiChat", run: () => isList() ? pageSelect(1) : scroll?.scrollBy(page()) },
      { bind: "home", title: "Top", group: "UniiChat", run: () => isList() ? select(0) : scroll?.scrollTo(0) },
      { bind: "end", title: "Bottom", group: "UniiChat", run: () => isList() ? select(Infinity) : scroll?.scrollTo(scroll.scrollHeight) },
    ],
  }));

  onMount(() => void refresh());
  onCleanup(() => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  });

  const theme = ctx.theme;
  const titles = () => ["View", ...stack().map((level) => level.title)];
  const position = () => {
    const level = current();
    return level.kind === "list" && level.lines.length > 0 ? `${level.selected + 1} / ${level.lines.length}` : "";
  };
  const keys = (): [string, string][] => {
    const level = current();
    const esc: [string, string] = ["esc", stack().length ? "back" : "close"];
    if (level.kind === "list") return [["↑↓", "select"], ["pgup/pgdn", "page"], ["enter", "zoom in"], esc];
    return [["↑↓", "scroll"], ...(level.agent ? [["enter", `open agent ${level.agent}`] as [string, string]] : []), esc];
  };
  const notice = () => busy() ? "Loading…"
    : zoomError() ? `Zoom error: ${zoomError()}`
    : stack().length === 0 && viewError() ? `View error: ${viewError()}`
    : stack().length === 0 && loading() ? "Loading view…"
    : stack().length === 0 && lines().length === 0 ? "The view is empty. It fills up as the chat goes on."
    : undefined;

  // One label/value row of the status block.
  const Stat = (row: { label: string; children: any }) => (
    <box flexDirection="row" flexShrink={0}>
      <text width={13} flexShrink={0} fg={theme.text.muted}>{row.label}</text>
      <text flexGrow={1} fg={theme.text.base} wrapMode="none">{row.children}</text>
    </box>
  );
  // A function, not one shared node: Solid would move a reused node to its last place.
  const dot = () => <span style={{ fg: theme.text.muted }}>{"  ·  "}</span>;

  // The id+n head of a line, padded so the text column lines up.
  const gutter = (lines: string[]) => Math.max(4, ...lines.map((line) => LINE.exec(line)?.[0].length ?? 0)) + 1;
  const Line = (row: { line: string; selected: boolean; width: number }) => {
    const head = LINE.exec(row.line);
    const body = head ? row.line.slice(head[0].length) : row.line;
    const kind = KIND.exec(body);
    const fg = () => row.selected ? theme.text.action.primary.focused : theme.text.base;
    const kindColor = () => row.selected ? theme.text.action.primary.focused
      : kind?.[1] === "user" ? theme.text.action.primary.base
      : kind?.[1] === "unii" ? theme.text.feedback.success.base
      : kind?.[1] === "work" ? theme.text.feedback.warning.base
      : theme.text.muted;
    return (
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text width={row.width} flexShrink={0} fg={row.selected ? theme.text.action.primary.focused : theme.text.muted}>
          {head ? `${head[1]}+${head[2]}` : ""}
        </text>
        <text flexGrow={1} flexShrink={1} fg={fg()}>
          {kind ? <span style={{ fg: kindColor() }}><b>{kind[0]}</b></span> : null}
          {kind ? body.slice(kind[0].length) : body}
        </text>
      </box>
    );
  };

  return (
    <box height={outer() - 1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      {/* Title bar */}
      <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingBottom={1}>
        <text>
          <span style={{ fg: theme.text.base }}><b>UniiChat</b></span>
          <Show when={status()}>{(current) => <span style={{ fg: theme.text.muted }}>{` v${current().plugin.version}`}</span>}</Show>
          <Show when={status()}>
            {(current) => current().on
              ? <span style={{ fg: theme.text.feedback.success.base }}>{"   ● on"}</span>
              : <span style={{ fg: theme.text.muted }}>{"   ○ off"}</span>}
          </Show>
        </text>
        <text fg={theme.text.muted} onMouseUp={() => ctx.ui.dialog.clear()}>esc</text>
      </box>

      {/* Status */}
      <Show when={status()} fallback={
        <text flexShrink={0} fg={statusError() ? theme.text.feedback.error.base : theme.text.muted}>
          {statusError() ? `Status error: ${statusError()}` : "Loading status…"}
        </text>
      }>
        {(current) => {
          const chat = () => current().chat;
          const active = () => (chat()?.pending ?? 0) + (chat()?.inFlight ?? 0) > 0;
          return (
            <box flexShrink={0}>
              <Stat label="Memory">
                {chat() ? `${kilobytes(chat()!.viewBytes)} view` : "not started"}
                {chat() ? dot() : null}
                {chat() ? `${chat()!.lines} lines` : null}
              </Stat>
              <Stat label="Compaction">
                <span style={{ fg: active() ? theme.text.feedback.warning.base : theme.text.muted }}>
                  {active() ? `${chat()!.inFlight} running, ${chat()!.pending} queued` : "idle"}
                </span>
                {dot()}
                {chat()?.last ? `last took ${duration(chat()!.last!.ms)}` : "no call yet"}
                {dot()}
                {`${chat()?.total.calls ?? 0} calls`}
              </Stat>
              <Stat label="Last turn">{usageLabel(current().lastTurn)}</Stat>
              <Show when={chat()?.damaged}>
                {(count) => (
                  <Stat label="Repair">
                    <span style={{ fg: theme.text.feedback.warning.base }}>{`${count()} damaged summaries`}</span>
                    {dot()}
                    {"run /unii repair to rebuild them from the log"}
                  </Stat>
                )}
              </Show>
              <Show when={current().plugin.update}>
                {(version) => (
                  <Stat label="Update">
                    <span style={{ fg: theme.text.feedback.success.base }}>{`v${version()} available`}</span>
                    {dot()}
                    {"opencode plugin update, then opencode service restart"}
                  </Stat>
                )}
              </Show>
              <Show when={chat()?.lastError}>
                {(message) => (
                  <Stat label="Error">
                    <span style={{ fg: theme.text.feedback.error.base }}>{message().split("\n")[0]}</span>
                  </Stat>
                )}
              </Show>
              <Show when={statusError()}>
                {(message) => <Stat label="Status"><span style={{ fg: theme.text.feedback.error.base }}>{message()}</span></Stat>}
              </Show>
            </box>
          );
        }}
      </Show>

      {/* Breadcrumbs and position, over a rule */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        flexShrink={0}
        marginTop={1}
        border={["bottom"]}
        borderColor={theme.border.base}
      >
        <text>
          <For each={titles()}>
            {(title, index) => (
              <>
                {index() > 0 ? <span style={{ fg: theme.text.muted }}>{"  ›  "}</span> : null}
                {index() === titles().length - 1
                  ? <span style={{ fg: theme.text.base }}><b>{title}</b></span>
                  : <span style={{ fg: theme.text.muted }}>{title}</span>}
              </>
            )}
          </For>
        </text>
        <text fg={theme.text.muted}>{position()}</text>
      </box>

      <Show when={notice()}>
        {(message) => (
          <text flexShrink={0} paddingTop={1} fg={zoomError() || viewError() ? theme.text.feedback.error.base : theme.text.muted}>
            {message()}
          </text>
        )}
      </Show>

      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        flexGrow={1}
        flexShrink={1}
        minHeight={1}
        marginTop={1}
        scrollX={false}
        contentOptions={{ minHeight: 0, gap: ROW_GAP }}
        scrollbarOptions={{ visible: false }}
      >
        <Show when={current().kind === "list" ? current() as Extract<Level, { kind: "list" }> : undefined} fallback={
          <text paddingLeft={1} paddingRight={1} fg={theme.text.base}>{(current() as Extract<Level, { kind: "text" }>).text}</text>
        }>
          {(level) => (
            <For each={level().lines}>
              {(line, index) => (
                <box
                  backgroundColor={index() === level().selected ? theme.background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}
                  onMouseDown={() => select(index())}
                  onMouseUp={() => {
                    select(index());
                    zoomIn();
                  }}
                >
                  <Line line={line} selected={index() === level().selected} width={gutter(level().lines)} />
                </box>
              )}
            </For>
          )}
        </Show>
      </scrollbox>

      {/* Key hints */}
      <box flexDirection="row" flexShrink={0} gap={3} paddingTop={1} border={["top"]} borderColor={theme.border.base}>
        <For each={keys()}>
          {([key, label]) => (
            <text>
              <span style={{ fg: theme.text.base }}><b>{key}</b></span>
              <span style={{ fg: theme.text.muted }}>{` ${label}`}</span>
            </text>
          )}
        </For>
      </box>
    </box>
  );
}

// Bumped after /unii on|off so the sidebar refreshes at once instead of at the next poll.
const [stateVersion, bumpState] = createSignal(0);

function SidebarIndicator(props: { ctx: Context; sessionID: string }) {
  const ctx = props.ctx;
  const [on, setOn] = createSignal<boolean>();
  const [failed, setFailed] = createSignal(false);
  const [chatError, setChatError] = createSignal(false);
  const [damaged, setDamaged] = createSignal(0);
  const [update, setUpdate] = createSignal<string>();

  createEffect(() => {
    const sessionID = props.sessionID;
    stateVersion();
    setOn(undefined);
    setFailed(false);
    setChatError(false);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await rpcClient(ctx).status(
          { sessionID },
          { location: ctx.location, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setOn(status.on);
        setChatError(status.chat?.lastError !== undefined);
        setDamaged(status.chat?.damaged ?? 0);
        setUpdate(status.plugin.update);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    void poll();
    onCleanup(() => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    });
  });

  const label = () => failed() ? "error" : on() === undefined ? "…" : on() ? "enabled" : "disabled";
  const color = () => failed()
    ? ctx.theme.text.feedback.error.base
    : on() ? ctx.theme.text.feedback.success.base : ctx.theme.text.muted;

  return (
    <text>
      <span style={{ fg: ctx.theme.text.muted }}>UniiChat: </span>
      <span style={{ fg: color() }}>{label()}</span>
      {chatError() && !failed()
        ? <span style={{ fg: ctx.theme.text.feedback.error.base }}>{" · compaction error (/unii)"}</span>
        : null}
      {damaged() && !failed()
        ? <span style={{ fg: ctx.theme.text.feedback.warning.base }}>{` · ${damaged()} to repair (/unii repair)`}</span>
        : null}
      {update() && !failed()
        ? <span style={{ fg: ctx.theme.text.muted }}>{` · v${update()} available`}</span>
        : null}
    </text>
  );
}

export default Plugin.define({
  id: "uniichat",
  setup(ctx) {
    if (!ctx.ui || typeof ctx.ui.slot !== "function") return;
    const settings = tuiOptions(ctx.options);
    POLL_INTERVAL_MS = settings.pollMs;
    const removeSidebar = settings.sidebar ? ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => <SidebarIndicator ctx={ctx} sessionID={input.sessionID} />,
    }) : () => {};
    const removeCommand = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "plugin.uniichat.open",
            title: "UniiChat",
            description: "View UniiChat memory, switch it on or off, or repair it",
            group: "Plugin",
            palette: true,
            slash: { name: "unii", arguments: true },
            async run(input) {
              const argument = input?.trim().toLowerCase() ?? "";
              if (argument !== "" && argument !== "on" && argument !== "off" && argument !== "repair") {
                ctx.ui.toast.show({ variant: "warning", message: "Use /unii, /unii on, /unii off, or /unii repair." });
                return;
              }
              const route = ctx.ui.router.current();
              if (route.type !== "session") {
                if (argument === "off" || argument === "repair") {
                  ctx.ui.toast.show({ variant: "warning", message: `No session open: nothing to ${argument === "off" ? "turn off" : "repair"}.` });
                  return;
                }
                // No session yet: start one with UniiChat already on, then open it.
                try {
                  const session = await ctx.client.session.create(ctx.location ? { location: ctx.location } : {});
                  await rpcClient(ctx).set({ sessionID: session.id, on: true }, { location: ctx.location });
                  ctx.ui.router.navigate({ type: "session", sessionID: session.id });
                  ctx.ui.toast.show({ variant: "success", message: "New session with UniiChat on" });
                } catch (cause) {
                  ctx.ui.toast.show({ variant: "error", message: errorMessage(cause) });
                }
                return;
              }
              if (argument === "repair") {
                ctx.ui.toast.show({ variant: "info", message: "UniiChat repair: waiting for running summaries to finish…" });
                try {
                  const result = await rpcClient(ctx).repair({ sessionID: route.sessionID }, { location: ctx.location });
                  bumpState((n) => n + 1);
                  ctx.ui.toast.show(result.dropped === 0
                    ? { variant: "success", message: "UniiChat: no damaged summaries found" }
                    : { variant: "success", message: `UniiChat dropped ${result.dropped} damaged summaries; rebuilding them now${result.leaves ? ` (${result.leaves} messages; the next prompt waits for them)` : ""}` });
                } catch (cause) {
                  ctx.ui.toast.show({ variant: "error", message: errorMessage(cause) });
                }
                return;
              }
              if (!argument) {
                ctx.ui.dialog.show(() => <Popup ctx={ctx} sessionID={route.sessionID} />);
                ctx.ui.dialog.set({ size: "large", centered: true });
                return;
              }
              try {
                const result = await rpcClient(ctx).set(
                  { sessionID: route.sessionID, on: argument === "on" },
                  { location: ctx.location },
                );
                bumpState((n) => n + 1);
                ctx.ui.toast.show({
                  variant: "success",
                  message: `UniiChat ${result.on ? "on" : "off"} - takes effect at the next turn`,
                });
              } catch (cause) {
                ctx.ui.toast.show({ variant: "error", message: errorMessage(cause) });
              }
            },
          }],
        }));
        return null;
      },
    });
    return () => {
      removeSidebar();
      removeCommand();
    };
  },
});
