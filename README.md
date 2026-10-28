# UniiChat for OpenCode

**This plugin implements Victor Taelin's UniiChat recipe: [UniiChat: one chat that never ends](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).**

This plugin follows the recipe as closely as OpenCode allows, and the [deviations](#deviations-from-the-recipe) are listed below. The code follows the recipe at revision [`3c190e0`](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/3c190e06f34aba0c69f49042c526093269604935) (Oct 8, 2026).

The recipe's idea in one line: the chat itself is the memory. Every message is logged word for word. A cheap model compresses the log into a binary tree of one-line summaries, and each turn starts a fresh call that sees a fixed-size **view** of that tree. When a line is too vague, the model **zooms** into the lines it was made from, down to the message itself. The context stays the same size and nothing is lost.

## What it does in OpenCode

UniiChat is switched on per session and is off by default (opt-in via `/unii on`). While a session has it on:

- Each model request holds only the tools, skills, Unii's system prompt, AGENTS.md, the memory view, per-turn state, and the current turn's raw messages.
- OpenCode's stored transcript is untouched, so scrollback still works.
- Old memory is compacted in the background by a cheap model.
- OpenCode's native compaction is skipped.
- Two tools are added: `zoom` (open archived memory) and `date`.
- Subagents always run in the background, and their reports come back as `work` messages.
- `/btw` answers from Unii's memory instead of the full transcript.

Memory is stored under `<OpenCode data dir>/uniichat/<sessionID>/`, normally `~/.local/share/opencode/uniichat/`, in the recipe's file layout.

## Install

The current source needs OpenCode v2.2 or later. Tagged v0.2.1–v0.2.3 releases need v2.1; v0.2.0 and earlier need v2.0.

```sh
opencode plugin add github:maxandron/opencode-uniichat
```

To pin a version, add a tag or full commit hash: `github:maxandron/opencode-uniichat#<tag-or-sha>`. To update, run `opencode plugin check`, then `opencode plugin update`.

Or add it by hand. The server part goes in `opencode.json(c)` and the terminal UI part goes in `cli.json`:

```jsonc
// opencode.json(c)
"plugins": [{ "package": "github:maxandron/opencode-uniichat", "options": { /* see Options */ } }]
// cli.json
"plugins": [{ "package": "github:maxandron/opencode-uniichat", "options": { "tui": { "sidebar": true } } }]
```

## Use

- `/unii on` switches UniiChat on for the current session, starting at the next turn. With no session open, it starts a new session with UniiChat on. The first time, the session's earlier turns are imported into memory.
- `/unii off` returns the session to vanilla OpenCode. Memory is kept, and `/unii on` resumes it.
- `/unii` opens the memory popup. It shows the status and the live view. Up/Down move, Enter or a click zooms into a line, and Esc goes back and then closes.
- The sidebar shows whether UniiChat is on, and `· compaction error (/unii)` when a compaction failed. The popup shows the error.

The system prompt (with AGENTS.md, the skills list and the Code Mode catalog) is frozen at `/unii on`. To pick up edits, run `/unii off` and then `/unii on`.

### Desktop (experimental)

The same package includes an OpenCode Desktop frontend. List it in your global `opencode.json(c)`; Desktop does not read `cli.json`. The server and terminal frontend stay available.

Open **UniiChat memory** from the command palette, the session panel's **+** menu, the session header indicator, or `/unii`. The panel shows session status, context size, and the live memory view. Enable or turn off memory with its button, select a record to zoom in, and use **Back** or **Esc** to zoom out. Subagent reports offer a link to their full transcript.

The panel follows the displayed session, including sessions on remote servers where UniiChat is installed. Requests are cancelled when you switch sessions or close the panel. Desktop's plugin API is experimental and may change between OpenCode releases.

For local development, configure the **package root**, not its `src` directory, so Desktop can discover `./gui-experimental` in `package.json`. Run `bun run build:gui` (or `bun run build:gui --watch`) after GUI edits. Desktop reloads the rebuilt bundle without restarting the server. Both `dist/gui-experimental.cjs` and `dist/tui.js` ship prebuilt; installs need no build step.

## Options

All options are optional ;)

Default configuration (`opencode.jsonc`):

```jsonc
{
  "plugins": [
    {
      "package": "github:maxandron/opencode-uniichat#main",
      "options": {
        // Enable memory by default for sessions without an explicit on/off choice.
        "defaultOn": false,
        "compaction": {
          // Compaction model (providerID/modelID). Omit to select the newest Claude Haiku.
          // "model": "anthropic/claude-haiku-...",
          // Model variant, using OpenCode's variant names.
          "variant": "high",
          // Maximum output tokens per compaction call.
          "maxTokens": 32000,
          // Provider-specific options sent with each compaction call.
          "providerOptions": {},
          // Fail and retry calls that exceed this duration, in milliseconds.
          "timeoutMs": 240000,
          // Maximum attempts per node in the "Too long" retry loop.
          "tries": 5,
          // Maximum simultaneous compaction calls.
          "concurrency": 8
        },
        "view": {
          // Main chat memory budget, in bytes.
          "chat": {
            // Start merging when the view exceeds this size.
            "high": 128000,
            // Merge down to this size.
            "low": 64000
          },
          // Memory budget used by the compactor, in bytes.
          "compaction": {
            // Start merging when the view exceeds this size.
            "high": 32000,
            // Merge down to this size.
            "low": 16000
          }
        },
        "btw": {
          // Maximum zoom/date lookup steps before answering; 0 uses only the view.
          "lookupSteps": 8,
          // Maximum output tokens per lookup call.
          "maxTokens": 4000
        },
        "prompts": {
          // Optional string overrides; omit to use built-ins from src/prompts.ts.
          // System prompt; AGENTS.md, skills and the Code Mode catalog are added.
          // "system": "...",
          // Note appended to each subagent's own system prompt.
          // "subagent": "...",
          // Instructions added to /btw questions during memory lookups.
          // "btwLookup": "..."
        },
        "tui": {
          // Popup/sidebar refresh interval in milliseconds. Set in cli.json.
          "pollMs": 2000,
          // Show the sidebar status line. Set in cli.json.
          "sidebar": true
        }
      }
    }
  ]
}
```

Prompts are plain strings. A prompt change reaches a session at its next `/unii on`.

## Deviations from the recipe

Each one is an [architecture decision record](docs/adr/README.md).

1. **One chat per OpenCode session** ([0000](docs/adr/0000-follow-the-recipe.md), [0006](docs/adr/0006-switch.md)). Each session has its own memory and its own on/off switch. Off is plain OpenCode.
2. **The fresh call happens inside the OpenCode session** ([0001](docs/adr/0001-fresh-call-per-turn-inside-one-opencode-session.md)). The recipe calls each turn "in a fresh session". Here the session stays for its UI and transcript, and only the model request is rebuilt as `[tools][system][view][state][message]` plus the turn's own steps.
3. **System prompt** ([0002](docs/adr/0002-system-prompt.md), [0013](docs/adr/0013-codemode-catalog.md), [0045](docs/adr/0045-skills-in-system-prompt.md)). This is the recipe's prompt without the "open devices" paragraph, because OpenCode tools run locally.
4. **Compaction model and effort** ([0048](docs/adr/0048-compaction-effort-high.md), [0052](docs/adr/0052-model-calls-through-opencode.md)). The default is Claude Haiku at `high` effort, not `xhigh`. At `xhigh` it sometimes spent its whole output limit thinking. Victor's released code also uses `high`.
5. **Compaction calls go through OpenCode** ([0052](docs/adr/0052-model-calls-through-opencode.md)). Each call runs in a throwaway child session, so it uses your providers and credentials.
6. **Extra cache marks** ([0005](docs/adr/0005-cache-marks.md)). OpenCode may add up to two cache marks of its own on the tools/system prefix.
7. **No lock on the log** ([0041](docs/adr/0041-drop-chat-lock.md)). The recipe says "hold a lock". A session is never open in two OpenCode servers at once, so the lock was redundant.
8. **Subagents keep their own system prompt** ([0015](docs/adr/0015-subagent-system-prompt.md)). The recipe makes a subagent a fresh call that starts with the view. Here a subagent also keeps its OpenCode agent's prompt, plus a note about the view.
9. **Undo removes messages from memory** ([0040](docs/adr/0040-undo-drops-the-undone-turn.md), [0050](docs/adr/0050-undo-behind-checkpoint.md)). The recipe says never delete a line. OpenCode's `/undo` deletes messages, so the undone records are moved to `undone/<stamp>/` and their ids are reused.
10. **User-run shell commands are not logged** ([0025](docs/adr/0025-shell-messages.md)).
11. **Earlier turns are imported as messages** ([0043](docs/adr/0043-import-earlier-turns.md)). When a session is switched on mid-way, its earlier turns are logged as ordinary messages, not as `note` memories.

These are additions the recipe does not cover:

- native-compaction placeholder ([0007](docs/adr/0007-native-compaction.md), [0051](docs/adr/0051-see-past-the-stub.md))
- compaction timeout ([0042](docs/adr/0042-compaction-call-timeout.md))
- `/btw` from memory ([0046](docs/adr/0046-btw-from-memory.md))
- the popup ([0012](docs/adr/0012-ui.md), [0047](docs/adr/0047-popup-browse.md))

Victor has since released his code, [VictorTaelin/UniiChat](https://github.com/VictorTaelin/UniiChat). These follow that code where it differs from the recipe:

- a compaction that returns no text uses its source clipped to 512 bytes ([0056](docs/adr/0056-no-text-clips-the-source.md))
- the "fast and small" paragraph at the end of the system prompt ([0057](docs/adr/0057-compaction-prompt-fast-and-small.md))
- "Too long" retries resend the first request with one note ([0058](docs/adr/0058-too-long-retry-single-note.md))
- failed and stopped turns leave a `note` in memory ([0059](docs/adr/0059-failed-turns-leave-a-note.md))
- a bad zoom lists the tree's roots ([0060](docs/adr/0060-zoom-error-lists-roots.md))
- the subagent note explains the view ([0061](docs/adr/0061-subagent-note-explains-the-view.md))
- options ([0054](docs/adr/0054-plugin-options.md))

One difference from that code is kept on purpose. Victor's turns don't wait for an import to be summarized. Here the first turn after switch-on waits, so the model sees the whole session ([0062](docs/adr/0062-imports-block-the-first-turn.md)).

## Limitations

- OpenCode's generate API returns text only. The popup shows compaction call counts and times, but not token usage or cost. When a compaction returns no text, the reason is not reported; the node uses its source clipped.
- A compaction's throwaway session may show briefly as a child session.
- If a single turn outgrows the model's context window, the request fails (recipe-strict, [0008](docs/adr/0008-raw-turn-overflow.md)).
- Tested on Linux with Bun 1.4.

## Development

```sh
bun install
bun test src          # unit tests, including a check that dist/tui.js is current
bun run check         # type check + dist/tui.js staleness
bun run build:tui       # rebuild dist/tui.js after changing src/tui.tsx or src/rpc.ts
```

For local development, point both configs at the checkout's `src/` directory, e.g. `"plugins": ["/path/to/opencode-uniichat/src"]`. Local plugins hot-reload, and the TUI loads from `src/tui.tsx` directly. Installed copies load `dist/tui.js`, because OpenCode does not compile `.tsx` under `node_modules`. So commit a rebuilt `dist/tui.js` with every TUI change.

New design decisions get an ADR in [`docs/adr/`](docs/adr/README.md).
