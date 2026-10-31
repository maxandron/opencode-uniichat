import { readFileSync } from "node:fs";

// The installed version, and the newest one on GitHub's main branch, for the TUI and desktop to
// show. Nothing is installed: `opencode plugin update` does that when the user chooses to.

/** This copy's version, from its package.json. */
export const VERSION: string = (() => {
  try {
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    return typeof version === "string" ? version : "unknown";
  } catch { return "unknown"; }
})();

export const LATEST_URL = "https://raw.githubusercontent.com/maxandron/opencode-uniichat/main/package.json";
const EVERY_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 10_000;

/** a > b, comparing dotted numeric versions ("0.2.10" > "0.2.9"); a pre-release tag is ignored. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((part) => Number(part));
  const x = parse(a);
  const y = parse(b);
  if ([...x, ...y].some((n) => !Number.isFinite(n))) return false;
  for (let k = 0; k < Math.max(x.length, y.length); k++) {
    const d = (x[k] ?? 0) - (y[k] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// One check per process, shared by every plugin instance (each OpenCode location loads its own).
type State = { latest?: string; at: number; running?: Promise<void> };
const state: State = ((globalThis as Record<symbol, unknown>)[Symbol.for("opencode-uniichat.update")] ??= { at: 0 }) as State;

/**
 * The newer version on main, if one is known. Starts a check in the background when the last is
 * older than six hours; a failed check (offline, rate limit) just leaves the answer unknown.
 */
export function available(fetcher: typeof fetch = fetch, now = Date.now()): string | undefined {
  if (!state.running && now - state.at >= EVERY_MS) {
    state.at = now;
    state.running = fetcher(LATEST_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then((response) => response.ok ? response.json() : undefined)
      .then((body: { version?: unknown } | undefined) => { if (typeof body?.version === "string") state.latest = body.version; })
      .catch(() => {})
      .finally(() => { state.running = undefined; });
  }
  return state.latest !== undefined && newer(state.latest, VERSION) ? state.latest : undefined;
}

/** For tests: forget the last check. */
export function reset() {
  state.at = 0;
  state.latest = undefined;
  state.running = undefined;
}
