import { z } from "zod";
import { BTW_LOOKUP_NOTE, SUBAGENT_NOTE, SYSTEM_PROMPT } from "./prompts.ts";
import { COMPACTION } from "./chat.ts";
import { QUEUE } from "./queue.ts";
import { CHAT_BUDGET, COMPACTION_BUDGET } from "./view.ts";

// Plugin options, from the `options` object of the plugin's entry in opencode.json(c):
//   "plugins": [{ "package": "github:maxandron/opencode-uniichat", "options": { ... } }]
// Every field is optional; README.md documents them.

const positive = z.number().int().positive();
const budget = z.strictObject({ high: positive, low: positive }).refine((value) => value.low < value.high, "low must be below high");

export const Schema = z.strictObject({
  /** Switch new sessions on without `/unii on`. Sessions switched off stay off. */
  defaultOn: z.boolean().default(false),
  compaction: z.strictObject({
    /** "providerID/modelID". Default: the newest Anthropic Claude Haiku that OpenCode lists. */
    model: z.string().regex(/^[^/]+\/.+$/, "use providerID/modelID").optional(),
    /** A model variant as OpenCode names them. */
    variant: z.string().default("high"),
    /** Output token limit for one compaction call. */
    maxTokens: positive.default(32000),
    /** Extra provider options sent with each compaction call. */
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    /** A call that has not answered by then fails and is retried. */
    timeoutMs: positive.default(4 * 60_000),
    /** Tries per node in the recipe's "Too long" loop. */
    tries: positive.default(5),
    /** Compaction calls in flight at once. */
    concurrency: positive.default(8),
  }).prefault({}),
  view: z.strictObject({
    /** Chat view byte budget: merge down to `low` when it passes `high` (recipe: 128000/64000). */
    chat: budget.default({ high: 128000, low: 64000 }),
    /** Compaction view byte budget (recipe: 32000/16000). */
    compaction: budget.default({ high: 32000, low: 16000 }),
  }).prefault({}),
  btw: z.strictObject({
    /** Memory lookups (zoom/date) before a /btw answer; 0 answers from the view only. */
    lookupSteps: z.number().int().nonnegative().default(8),
    /** Output token limit for one lookup call. */
    maxTokens: positive.default(4000),
  }).prefault({}),
  prompts: z.strictObject({
    /** Replaces the recipe's system prompt (agent name "Unii"). */
    system: z.string().default(SYSTEM_PROMPT),
    /** Appended to a subagent's own system prompt. */
    subagent: z.string().default(SUBAGENT_NOTE),
    /** Added to a /btw question during memory lookups. */
    btwLookup: z.string().default(BTW_LOOKUP_NOTE),
  }).prefault({}),
  tui: z.strictObject({
    /** How often the popup and sidebar refresh, in ms. */
    pollMs: positive.default(2000),
    /** Show the on/off line in the session sidebar. */
    sidebar: z.boolean().default(true),
  }).prefault({}),
});

export type Options = z.infer<typeof Schema>;

export function parse(input: unknown): Options {
  const result = Schema.safeParse(input === undefined ? {} : input);
  if (result.success) return result.data;
  const issues = result.error.issues.flatMap((issue) => {
    if (issue.code !== "unrecognized_keys") return [`${["options", ...issue.path].join(".")}: ${issue.message}`];
    return issue.keys.map((key) => {
      const location = ["options", ...issue.path].join(".");
      const hint = key.includes(".") ? " Use nested objects, not dotted property names (e.g. compaction: { model: \"providerID/modelID\" })." : " Check the option name in the README.";
      return `${location}: unknown option ${JSON.stringify(key)}.${hint}`;
    });
  });
  throw new Error(`UniiChat options are invalid; plugin loading stopped: ${issues.join("; ")}`);
}

/** The model ref from "providerID/modelID". */
export function modelRef(spec: string, variant?: string) {
  const at = spec.indexOf("/");
  return { providerID: spec.slice(0, at), id: spec.slice(at + 1), ...(variant ? { variant } : {}) };
}

/** Applies the process-wide settings that the recipe's engine reads. */
export function configure(options: Options) {
  Object.assign(CHAT_BUDGET, options.view.chat);
  Object.assign(COMPACTION_BUDGET, options.view.compaction);
  COMPACTION.timeoutMs = options.compaction.timeoutMs;
  COMPACTION.tries = options.compaction.tries;
  QUEUE.slots = options.compaction.concurrency;
}
