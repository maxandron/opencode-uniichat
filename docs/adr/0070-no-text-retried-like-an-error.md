# 0070: A no-text reply is retried like an error

Supersedes [0069](0069-clipped-summaries-retry-later.md).

A summary call had three retry paths: an error or timeout failed the node, which was retried at the next record or by `awaitSummarized`'s backoff (1 s doubling to 30 s); a line over 512 bytes was asked again at once ("Too long", ADR-0058); and a reply with no text was saved as its source clipped at once, with a repair scheduled 60 s, 120 s and 240 s later (0069). The third path was the odd one: it saved damage on purpose, archived and rebuilt it through `/unii repair`, kept its own timer, and hid the node from the repair count while it waited.

Now a reply with no text fails the node like an error and takes the same retries. Only after `compaction.tries` such replies does the node become its source clipped (ADR-0056), so a model that refuses a node never blocks the chat; that node then counts for `/unii repair`. The count is per node and per open of the chat, not stored.

VictorTaelin/UniiChat retries errors every 60 s forever and treats a reply with no text as a refusal, clipping the source at once with no retry. Our empty replies were mostly not refusals (tool calls, thinking using the output limit), and a retry usually succeeds, so they get the error path.
