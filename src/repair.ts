import * as tree from "./tree.ts";

// `/unii repair` finds summaries damaged by the unswapped-compaction bug (fixed in v0.2.4, ADR-0064):
// with OpenCode 2.2 a compaction call could reach a plugin instance that did not own it, so the
// model answered the bare placeholder prompt ("UniiChat") with a greeting, or returned nothing and
// the node became its source clipped. Both were saved as summaries. They are dropped and built
// again from the log, which the bug never touched.

/** Tree files written before this day cannot hold the damage (OpenCode 2.2 shipped Oct 28, 2026). */
export const DAMAGE_SINCE = "2026-10-28";

// A reply to the placeholder: a greeting or question about "UniiChat" that, unlike every real
// summary, does not open with a message kind ("user:", "echo1203:", "tool/echo:"...).
const GREETING = /(What would you like|How can I help|What can I help|What do you want|What should I do)[^\n]{0,40}UniiChat|UniiChat[^\n]{0,15}(\?|\u2014)/i;
const TAGGED = /^\W*(user|unii|tool|echo|work|note)\w*\s*[:/(+]/i;

export const isGreeting = (text: string) => GREETING.test(text) && !TAGGED.test(text);

export interface Node { l: number; i: number; text: string; day: string | undefined }
export interface Sources {
  /** A leaf's own line when its record fits the node limit (stored verbatim, never compacted). */
  verbatim: (i: number) => string | undefined;
  /** A node's source as one line cut to the limit: what the no-text fallback saved. */
  clipped: (ref: tree.Ref) => string | undefined;
}

/** The damaged nodes ("l:i"), plus every merge above one, which summarized damage. */
export function damaged(nodes: readonly Node[], sources: Sources): Set<string> {
  const present = new Set(nodes.map((node) => `${node.l}:${node.i}`));
  const bad = new Set<string>();
  for (const node of nodes) {
    if (node.day === undefined || node.day < DAMAGE_SINCE) continue;
    if (node.l === 0 && sources.verbatim(node.i) === node.text) continue;
    if (isGreeting(node.text) || node.text === sources.clipped([node.l, node.i])) bad.add(`${node.l}:${node.i}`);
  }
  // Lower levels first, so one pass carries damage all the way up.
  for (const node of [...nodes].filter((node) => node.l > 0).sort((a, b) => a.l - b.l)) {
    const id = `${node.l}:${node.i}`;
    if (bad.has(id)) continue;
    if (tree.children([node.l, node.i]).some(([l, i]) => bad.has(`${l}:${i}`) || !present.has(`${l}:${i}`))) bad.add(id);
  }
  return bad;
}
