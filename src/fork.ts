import type { Row } from "./history.ts";

// OpenCode's fork copies the source's messages under new IDs (`msg_<fork event>_<seq>`), keeping
// each message's type, creation time and content; tool call IDs stay. Pair them by type and creation
// time, in order, so a fork can take over the source's memory with its sources renamed (ADR-0071).
const key = (row: Row) => `${row.type}:${row.time.created}`;

export interface Pairing {
  /** Source message ID → the fork's copy. */
  rename: Map<string, string>;
  /** Source IDs whose messages the fork holds, tool call IDs included: records past the last of them are cut. */
  present: Set<string>;
}

export function pair(source: readonly Row[], fork: readonly Row[]): Pairing {
  const queue = new Map<string, Row[]>();
  for (const row of source) {
    const k = key(row);
    if (!queue.has(k)) queue.set(k, []);
    queue.get(k)!.push(row);
  }
  const rename = new Map<string, string>();
  const present = new Set<string>();
  for (const row of fork) {
    const match = queue.get(key(row))?.shift();
    if (!match) continue;
    rename.set(match.id, row.id);
    present.add(match.id);
    if (match.type === "assistant") for (const part of match.content) if (part.type === "tool") present.add(part.id);
  }
  return { rename, present };
}
