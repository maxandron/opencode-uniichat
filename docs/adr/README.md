# Architecture decision records

One short record per decision made while building UniiChat. Records marked as deviations depart from the recipe.

A new decision gets the next number; a changed decision gets a new record, and the old record's status points to it.

| ADR | Decision | Status |
| --- | --- | --- |
| [0000](0000-follow-the-recipe.md) | Follow the recipe; one OpenCode session is one chat **(deviation)** | Accepted |
| [0001](0001-fresh-call-per-turn-inside-one-opencode-session.md) | Fresh call per turn inside one OpenCode session **(deviation)** | Accepted |
| [0002](0002-system-prompt.md) | System prompt **(deviation)** | Accepted |
| [0002a](0002a-tools.md) | Tools are sent as OpenCode provides them | Accepted |
| [0003](0003-compaction-model.md) | Compaction model | Amended by ADR-0048 and ADR-0052 |
| [0004](0004-compaction-transport.md) | Compaction transport | Superseded by ADR-0052 |
| [0005](0005-cache-marks.md) | Cache marks **(deviation)** | Accepted |
| [0006](0006-switch.md) | On/off switch per session **(deviation)** | Accepted |
| [0007](0007-native-compaction.md) | Native compaction | Accepted, refined by ADR-0051 |
| [0008](0008-raw-turn-overflow.md) | Raw-turn overflow | Accepted |
| [0009](0009-storage.md) | Storage | Amended by ADR-0041 |
| [0010](0010-tools.md) | zoom and date are global tools, hidden from vanilla sessions | Accepted |
| [0011](0011-no-capture-exclusions.md) | No capture exclusions | Accepted |
| [0012](0012-ui.md) | Popup | Accepted, extended by ADR-0044, ADR-0047 and ADR-0049 |
| [0013](0013-codemode-catalog.md) | Code Mode catalog in the system prompt **(deviation)** | Accepted |
| [0014](0014-subagents-always-run-in-the-background.md) | Subagents always run in the background | Accepted |
| [0015](0015-subagent-system-prompt.md) | Subagents keep their own system prompt **(deviation)** | Accepted |
| [0016](0016-long-text-split-size.md) | Long-text split size | Accepted |
| [0017](0017-compaction-failure-during-the-r-6-wait.md) | Compaction failure while a turn waits | Accepted |
| [0018](0018-turn-boundary.md) | Turn boundary | Accepted |
| [0019](0019-per-turn-state-format.md) | Per-turn state format | Accepted |
| [0020](0020-subagent-reports-in-the-request.md) | Subagent reports in the request | Accepted |
| [0021](0021-view-size.md) | View size | Accepted |
| [0022](0022-compaction-view-on-a-chat-view-merge.md) | Compaction view after a chat-view merge | Accepted |
| [0023](0023-formats.md) | Record formats | Accepted |
| [0024](0024-queue-priority.md) | Queue priority | Accepted |
| [0025](0025-shell-messages.md) | Shell messages are not logged **(deviation)** | Accepted |
| [0026](0026-frozen-render-in-memory-only.md) | Frozen view in memory only | Accepted |
| [0027](0027-system-txt-timing.md) | When system.txt is rendered | Accepted |
| [0028](0028-pending-batch-survives-a-restart.md) | Pending merges survive a restart | Accepted |
| [0029](0029-merge-task-input-lines.md) | Merge task input lines | Accepted |
| [0030](0030-echo-clip-marker.md) | Clip marker for tool output | Accepted |
| [0031](0031-long-tool-call-inputs-are-split.md) | Long tool-call inputs are split | Accepted |
| [0032](0032-subagent-native-compaction.md) | Subagents compact natively | Accepted |
| [0033](0033-compaction-reply.md) | Compaction reply | Accepted |
| [0034](0034-leaf-rule-is-strict.md) | Leaf rule is strict | Accepted |
| [0035](0035-chat-placement.md) | Where </chat> goes | Accepted |
| [0036](0036-merge-task-placeholders.md) | Merge task placeholders | Accepted |
| [0037](0037-zoom-schema.md) | zoom schema | Accepted |
| [0038](0038-effect-native-code.md) | Effect-native code | Accepted |
| [0039](0039-error-inside-the-too-long-loop.md) | Error inside the "Too long" loop | Accepted |
| [0040](0040-undo-drops-the-undone-turn.md) | Undo drops the undone turn **(deviation)** | Accepted, refined by ADR-0050 |
| [0041](0041-drop-chat-lock.md) | No lock on the log **(deviation)** | Accepted |
| [0042](0042-compaction-call-timeout.md) | Time out hung compaction calls | Accepted |
| [0043](0043-import-earlier-turns.md) | Import earlier turns on first switch-on **(deviation)** | Accepted |
| [0044](0044-sidebar-indicator.md) | Sidebar indicator; /unii on without a session | Accepted |
| [0045](0045-skills-in-system-prompt.md) | Skills list in the system prompt **(deviation)** | Accepted |
| [0046](0046-btw-from-memory.md) | /btw answers from memory | Accepted |
| [0047](0047-popup-browse.md) | Browse the view in the popup | Accepted |
| [0048](0048-compaction-effort-high.md) | Compaction effort high, not xhigh **(deviation)** | Accepted |
| [0049](0049-compaction-errors-visible.md) | Show compaction errors | Accepted |
| [0050](0050-undo-behind-checkpoint.md) | Find undone turns behind a compaction checkpoint | Accepted |
| [0051](0051-see-past-the-stub.md) | See past UniiChat's own compaction placeholder | Accepted |
| [0052](0052-model-calls-through-opencode.md) | Model calls through OpenCode's providers **(deviation)** | Accepted |
| [0053](0053-distribution.md) | Install from GitHub; ship the TUI prebuilt | Accepted |
| [0054](0054-plugin-options.md) | Everything tunable is an option | Accepted |
| [0055](0055-own-repo-mit.md) | MIT license | Accepted |
| [0056](0056-no-text-clips-the-source.md) | A compaction with no text uses its source clipped | Accepted |
| [0057](0057-compaction-prompt-fast-and-small.md) | "Fast and small" paragraph in the system prompt | Accepted |
| [0058](0058-too-long-retry-single-note.md) | "Too long" retries resend the first request with one note | Accepted |
| [0059](0059-failed-turns-leave-a-note.md) | Failed and stopped turns leave a note | Accepted |
| [0060](0060-zoom-error-lists-roots.md) | A bad zoom lists the tree's roots | Accepted |
| [0061](0061-subagent-note-explains-the-view.md) | The subagent note explains the view | Accepted |
| [0062](0062-imports-block-the-first-turn.md) | Imported turns block the first turn | Accepted |
| [0063](0063-desktop-frontend.md) | A desktop frontend beside the terminal UI | Accepted |
| [0064](0064-calls-shared-across-instances.md) | Calls in flight are shared across plugin instances, and fail closed | Accepted |
| [0065](0065-repair-command.md) | `/unii repair` rebuilds damaged summaries in place | Accepted |
| [0066](0066-update-notice.md) | Show the version and a newer one, but do not update | Accepted |
