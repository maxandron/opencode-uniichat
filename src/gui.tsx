import { Command, MenuItem, Panel, Plugin, Slot, Style, usePlugin, type MountedSession } from "@opencode/plugin/gui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { UniiChatRpc } from "./rpc";
import css from "./gui.css?inline";

const rpc = (session: MountedSession) => session.server.client.rpc(UniiChatRpc);
type Level = { title: string; lines: string[] } | { title: string; text: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;
const count = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);

// Sequential polling: never overlap requests, and discard every reply after unmount.
function poll<T>(load: (signal: AbortSignal) => Promise<T>, ms: number) {
  const [value, setValue] = createSignal<T>();
  const [error, setError] = createSignal<string>();
  let controller: AbortController | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (disposed) return;
    clearTimeout(timer);
    controller?.abort();
    const request = controller = new AbortController();
    try {
      const next = await load(request.signal);
      if (request.signal.aborted) return;
      setValue(() => next);
      setError(undefined);
    } catch (cause) {
      if (!request.signal.aborted) setError(message(cause));
    } finally {
      if (!request.signal.aborted) timer = setTimeout(refresh, ms);
    }
  };
  void refresh();
  onCleanup(() => { disposed = true; controller?.abort(); clearTimeout(timer); });
  return { value, error, refresh };
}

function Memory(props: { session: MountedSession }) {
  const ctx = usePlugin();
  const ui = ctx.ui;
  const session = props.session; // Parent is keyed by server + session.
  const state = poll(async (signal) => {
    const client = rpc(session);
    const input = { sessionID: session.id };
    const [status, lines] = await Promise.all([
      client.status(input, { signal }), client.view(input, { signal }),
    ]);
    return { status, lines };
  }, 2000);
  const [stack, setStack] = createSignal<Level[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [repaired, setRepaired] = createSignal<string>();
  const status = () => state.value()?.status;
  const enabled = () => status()?.on ?? false;
  const current = (): Level => stack().at(-1) ?? { title: "Live view", lines: state.value()?.lines ?? [] };
  const text = () => { const level = current(); return "text" in level ? level.text : undefined; };
  const lines = () => { const level = current(); return "lines" in level ? level.lines : []; };
  const agent = () => /^work: \[([^\]\s]+)\]/.exec(text() ?? "")?.[1];
  let content: HTMLDivElement | undefined;
  const back = () => { setError(undefined); setStack((levels) => levels.slice(0, -1)); content?.focus(); };
  const controller = new AbortController();
  onCleanup(() => controller.abort());

  async function toggle() {
    if (busy()) return;
    setBusy(true); setError(undefined);
    try {
      await rpc(session).set({ sessionID: session.id, on: !enabled() }, { signal: controller.signal });
      if (!controller.signal.aborted) await state.refresh();
    } catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function repair() {
    if (busy()) return;
    setBusy(true); setError(undefined); setRepaired(undefined);
    try {
      const result = await rpc(session).repair({ sessionID: session.id }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRepaired(result.dropped === 0 ? "No damaged summaries found."
        : `Dropped ${result.dropped} damaged summaries; rebuilding them from the log${result.leaves ? ` (${result.leaves} messages; the next prompt waits for them)` : ""}.`);
      await state.refresh();
    } catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function open(input: { id: number; n: number } | { name: string }) {
    if (busy()) return;
    setBusy(true); setError(undefined);
    try {
      const text = await rpc(session).archive({ sessionID: session.id, ...input }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const title = "name" in input ? input.name : input.n === 1 ? `Message ${input.id}` : `${input.id}+${input.n}`;
      setStack((levels) => [...levels, "n" in input && input.n > 1
        ? { title, lines: text.split("\n").filter(Boolean) }
        : { title, text: text || "(empty)" }]);
      content?.scrollTo(0, 0);
      content?.focus();
    } catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section class="unii-memory" aria-label="UniiChat memory">
    <header class="unii-toolbar">
      <div><h2>Memory</h2><span class="unii-muted">The context your agent sees<Show when={status()}>{(s) => <> · v{s().plugin.version}</>}</Show></span></div>
      <ui.Button size="small" busy={busy()} disabled={!status()} onClick={() => void toggle()}>{enabled() ? "Turn off" : "Enable"}</ui.Button>
    </header>
    <Show when={status()}>{(s) => <>
      <div class="unii-stats">
        <div><span class="unii-muted">Status</span><strong><i classList={{ "unii-dot": true, "unii-on": enabled() }} />{enabled() ? "Enabled" : "Off"}</strong></div>
        <div><span class="unii-muted">Context</span><strong>{kb(s().chat?.viewBytes ?? 0)}</strong></div>
        <div><span class="unii-muted">Records</span><strong>{(s().chat?.T ?? 0).toLocaleString()}</strong></div>
      </div>
      <details class="unii-details">
        <summary>Usage &amp; compaction</summary>
        <Show when={s().lastTurn} fallback={<p class="unii-muted">No completed turn yet.</p>}>{(usage) => <dl>
          <dt>Last turn</dt><dd>{count(usage().input)} in · {count(usage().output)} out</dd>
          <dt>Cache</dt><dd>{count(usage().cacheRead)} read · {count(usage().cacheWrite)} write</dd>
          <dt>Cost</dt><dd>${usage().cost.toFixed(2)}</dd>
          <Show when={usage().ms !== undefined}><dt>Duration</dt><dd>{((usage().ms ?? 0) / 1000).toFixed(1)} s</dd></Show>
        </dl>}</Show>
        <Show when={s().chat}>{(chat) => <dl>
          <dt>Compactions</dt><dd>{chat().total.calls.toLocaleString()} calls · {(chat().total.ms / 1000).toFixed(1)} s</dd>
          <dt>Failures</dt><dd>{chat().failed}</dd>
        </dl>}</Show>
      </details>
      <Show when={s().chat && ((s().chat!.inFlight + s().chat!.pending) > 0)}><p class="unii-muted">Compacting memory · {s().chat!.inFlight} active · {s().chat!.pending} queued</p></Show>
      <Show when={s().plugin.update}>{(version) => <p class="unii-notice" role="status"><strong>UniiChat v{version()} is available.</strong> Run <code>opencode plugin update</code>, then restart OpenCode.</p>}</Show>
      <Show when={s().chat?.damaged}>{(count) => <div class="unii-notice unii-warn" role="status">
        <p><strong>{count().toLocaleString()} damaged summaries.</strong> They are placeholders or clipped copies from a compaction bug fixed in v0.2.4; repairing rebuilds them from the intact log.</p>
        <ui.Button size="small" busy={busy()} onClick={() => void repair()}>Repair</ui.Button>
      </div>}</Show>
      <Show when={repaired()}>{(text) => <p class="unii-muted" role="status">{text()}</p>}</Show>
      <Show when={s().chat?.lastError}><p class="unii-error" role="alert">{s().chat?.lastError}</p></Show>
    </>}</Show>
    <Show when={state.error() || error()}><p class="unii-error" role="alert">{error() ?? state.error()}</p></Show>
    <Show when={state.value()} fallback={<Show when={!state.error()}><ui.Loader /></Show>}>
      <nav class="unii-nav" aria-label="Memory navigation">
        <ui.Button size="small" variant="ghost" disabled={!stack().length || busy()} onClick={back}>Back</ui.Button>
        <span>{current().title}</span>
        <Show when={stack().length}><ui.Button size="small" variant="ghost-muted" disabled={busy()} onClick={() => { setStack([]); setError(undefined); content?.focus(); }}>Live view</ui.Button></Show>
      </nav>
      <div class="unii-content" ref={content} tabindex="0" aria-busy={busy()} onKeyDown={(event) => {
        if (event.key === "Escape" && stack().length && !busy()) { event.preventDefault(); event.stopPropagation(); back(); }
      }}>
        <Show when={text()} fallback={
          <Show when={lines().length} fallback={<div class="unii-empty"><h3>No memory yet</h3><p>{enabled() ? "Send a message to begin building context." : "Enable UniiChat to keep a compact, browsable memory of this session."}</p></div>}>
            <For each={lines()}>{(line) => {
              const match = /^(\d+)\+(\d+)\|([\s\S]*)$/.exec(line);
              return match ? <button class="unii-record" disabled={busy()} onClick={() => void open({ id: Number(match[1]), n: Number(match[2]) })}>
                <span class="unii-record-id">{match[1]}<span>+{match[2]}</span></span><span>{match[3]}</span>
              </button> : <p class="unii-plain">{line}</p>;
            }}</For>
          </Show>
        }>{(text) => <><pre class="unii-message">{text()}</pre><Show when={agent()}>{(name) => <ui.Button size="small" busy={busy()} onClick={() => void open({ name: name() })}>Open {name()} transcript</ui.Button>}</Show></>}</Show>
      </div>
    </Show>
    <footer class="unii-muted">Select a record to explore · Esc to go back</footer>
  </section>;
}

function Indicator(props: { session: MountedSession; active: boolean }) {
  const ctx = usePlugin();
  return <Show when={props.active && props.session.key} keyed>{(_key) => {
    const session = props.session;
    const state = poll((signal) => rpc(session).status({ sessionID: session.id }, { signal }), 5000);
    return <button class="unii-indicator" title={state.error() ?? "Open UniiChat memory"} onClick={() => ctx.layout.open(`${ctx.id}:memory`, session)}>
      <i classList={{ "unii-dot": true, "unii-on": state.value()?.on ?? false }} />UniiChat
      <Show when={state.value()?.on}><span class="unii-muted">{kb(state.value()?.chat?.viewBytes ?? 0)}</span></Show>
      <Show when={state.value()?.chat?.damaged}><span class="unii-badge" title="Damaged summaries: open the panel to repair">repair</span></Show>
      <Show when={state.value()?.plugin.update}>{(version) => <span class="unii-badge" title={`UniiChat v${version()} is available: opencode plugin update`}>update</span>}</Show>
      <Show when={state.error()}><span aria-label="Connection error">!</span></Show>
    </button>;
  }}</Show>;
}

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, css);
    const tab = { id: "memory", title: "UniiChat", closable: "compact" as const, fallback: true };
    ctx.add(Panel, {
      id: "memory", region: "side",
      list: ({ open }) => open.includes("memory") ? [tab] : [],
      render: (props) => <Show when={props.session.key} keyed>{(_key) => <Memory session={props.session} />}</Show>,
    });
    ctx.add(Command, () => ({
      id: "memory", title: "Open UniiChat memory", group: "UniiChat", slash: { name: "unii" },
      enabled: !!ctx.sessions.current(),
      run: () => { const session = ctx.sessions.current(); if (session) ctx.layout.toggle(`${ctx.id}:memory`, session); },
    }));
    ctx.add(MenuItem, (): MenuItem => ({
      menu: "session.panel", id: "memory", title: "UniiChat memory", icon: "brain",
      opened: !!ctx.sessions.current() && ctx.layout.state(`${ctx.id}:memory`, ctx.sessions.current()!) !== "closed",
      run: () => { const session = ctx.sessions.current(); if (session) ctx.layout.open(`${ctx.id}:memory`, session); },
    }));
    ctx.add(Slot, { at: "session.header", render: (props) => <Indicator session={props.session} active={props.active} /> });
  },
});
