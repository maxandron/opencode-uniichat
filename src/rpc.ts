import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

const session = z.object({ sessionID: z.string().startsWith("ses_") });
const usage = z.object({
  input: z.number(), output: z.number(), reasoning: z.number(),
  cacheRead: z.number(), cacheWrite: z.number(), cost: z.number(),
});
const compaction = z.object({ ms: z.number() });
const totals = z.object({ calls: z.number(), ms: z.number() });
const status = z.object({
  on: z.boolean(),
  chat: z.object({
    T: z.number(), viewBytes: z.number(), compViewBytes: z.number(), lines: z.number(),
    inFlight: z.number(), pending: z.number(), failed: z.number(),
    lastError: z.string().optional(), last: compaction.optional(), total: totals,
    /** Summaries `/unii repair` would rebuild (damage from the bug fixed in v0.2.4). */
    damaged: z.number(),
  }).nullable(),
  lastTurn: usage.extend({ ms: z.number().optional() }).nullable(),
  /** The server's UniiChat version, and a newer one on GitHub when known. */
  plugin: z.object({ version: z.string(), update: z.string().optional() }),
});

// Project only wire fields; unknown/invalid usage counts follow lastUsage's zero default.
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const usageValue = (value: z.infer<typeof usage>) => ({
  input: finite(value.input), output: finite(value.output), reasoning: finite(value.reasoning),
  cacheRead: finite(value.cacheRead), cacheWrite: finite(value.cacheWrite), cost: finite(value.cost),
});
const compactionValue = (value: z.infer<typeof compaction>) => ({ ms: finite(value.ms) });
const totalsValue = (value: z.infer<typeof totals>) => ({ calls: finite(value.calls), ms: finite(value.ms) });
export function statusValue(value: z.infer<typeof status>): z.infer<typeof status> {
  const chat = value.chat;
  const lastTurn = value.lastTurn;
  return {
    on: value.on,
    chat: chat === null ? null : {
      T: finite(chat.T), viewBytes: finite(chat.viewBytes), compViewBytes: finite(chat.compViewBytes), lines: finite(chat.lines),
      inFlight: finite(chat.inFlight), pending: finite(chat.pending), failed: finite(chat.failed),
      ...(chat.lastError === undefined ? {} : { lastError: chat.lastError }),
      ...(chat.last === undefined ? {} : { last: compactionValue(chat.last) }),
      total: totalsValue(chat.total), damaged: finite(chat.damaged),
    },
    lastTurn: lastTurn === null ? null : {
      ...usageValue(lastTurn),
      ...(lastTurn.ms === undefined || !Number.isFinite(lastTurn.ms) ? {} : { ms: lastTurn.ms }),
    },
    plugin: { version: value.plugin.version, ...(value.plugin.update === undefined ? {} : { update: value.plugin.update }) },
  };
}

export const UniiChatRpc = Rpc.define({
  id: "uniichat",
  methods: {
    set: { input: session.extend({ on: z.boolean() }), output: z.object({ on: z.boolean() }) },
    status: {
      input: session,
      output: status,
    },
    view: { input: session, output: z.array(z.string()) },
    repair: {
      input: session,
      output: z.object({ dropped: z.number(), leaves: z.number() }),
      // The chat moved to a newer copy, or the store failed: the message says which.
      errors: { failed: z.undefined() },
    },
    archive: {
      input: z.union([
        session.extend({ id: z.number().int().nonnegative(), n: z.number().int().positive() }),
        session.extend({ name: z.string() }),
      ]),
      output: z.string(),
    },
  },
  events: {},
});
