# Design system contract

This file is for both audiences. Humans review cards in the terminal with `bun run ds:show`; agents use the contract to change code without inventing a second visual language.

## The rule that keeps it honest

Every card renders the **real** components:

- base pi components come from the pi install resolved at build time;
- pi-code and pi-open-tui come from vendored snapshots pinned by version;
- ours comes from `packages/pi-prism/render/*`, the exact module the extension ships.
- fold layouts are planned by `packages/pi-prism/extensions/fold.ts`, the module the live session uses, with distances from `blockDistances` in `render/layout.ts`.

A card is therefore a fixture, not an illustration. If the implementation changes, `bun run ds` changes the card's fixture. If a card looks wrong, the product looks wrong.

## Adding a component

1. Pick the semantic token first. Use pi's theme tokens (`accent`, `muted`, `dim`, `success`, `error`, `warning`, `toolTitle`, `toolOutput`, `thinkingText`, …). Never hardcode a hex value.
2. Put the pure renderer in `packages/pi-prism/render/`. It takes data + a render context (`theme`, `width`, `detail`, `expanded`) and returns a `Component` (or lines). No I/O, no timers, no global state.
3. Register it in `design-system/registry.ts`: id, title, group, description, and one render function per state (`pending`, `running`, `success`, `error`, `partial`, `expanded`, `aged0`…`aged6`).
4. Render it. `bun run ds:show <id> --width 40` (and 80, 120), dark and `--theme light`.
5. Add a fixture. The build writes `design-system/fixtures/frames.json`, keyed `<state>/<theme>/<width>/<glyph>`; commit it. `bun run ds:check` fails when the goldens no longer match what the renderers produce.
6. If the component participates in a story, add it to a scenario in `design-system/registry.ts`.

## States every block must survive

| State | Meaning |
|---|---|
| `pending` | called, not started |
| `running` | partial result, animated |
| `success` | completed, no error |
| `error` | failed; must stay legible at every detail level |
| `partial` | streaming arguments or output |
| `expanded` | user pinned it open |
| `aged0..6` | distance from the tail; 0 is live |

## Detail model

```
L0 live       8 body rows plus the header, streaming
L1            7 rows
L2–L3         one fewer row at each step
L4            4 rows (3 content lines plus the omission notice when truncated)
distance ≥ 5 folded into a group: one row per member while the newest
              group of the run has at most 5 rows, then one summary row
```

The tail budget (8 above), the fold distance (5) and the forming size (5 rows) are constants in `render/detail.ts`; nothing in the product changes them.

Rules:

- Completed previews age as newer blocks arrive, including on screen. Visible previews step down one at a time. Each departing line fades in place. A departing row fades over a quarter of the recent gap between new blocks in the run, between 80 and 480 ms, and over 360 ms until that pace is known, so a fast model's transcript settles quickly and a slow one's steps are easy to follow. A block folds from bottom to top, one row at a time, ending with its heading. A block joining a group that lists its members (a forming group the user has not closed, or a group the user opened) folds only its body and keeps its heading, which becomes its member row.
- The newest group of the current run forms: under its summary it lists one row per member (a tool is one row, a thought one per run) while it has at most five rows, and collapses to the summary at the sixth. A group stops forming when a newer group starts or a user message follows it, so at most one forming group is on screen. Forming follows the member count directly, without hysteresis. When a visible forming group stops forming, its member rows leave from the bottom, each over one fade like any departing row, until only the summary is left; a block whose arrival makes the sixth row first folds through its heading. New blocks arriving mid-collapse let the fading row finish and close the rest at once. An offscreen group collapses at once.
- With the default budget, a long preview keeps at least three content lines until it joins its group. Short outputs use only the lines they have. Tool calls and thoughts fold together.
- The group timer spans the earliest member start through the latest finish, including model responses and overlapping tools. Sessions with incomplete timing omit the group timer.
- Failed calls fold with their peers. Each affected summary segment includes its failure count, and opening the group reveals the failed calls in order.
- A group summary reads as one sentence: `Thought for 3m 40s, searched for 1 pattern, listed 3 directories, ran 30 shell commands for 2m 05s (4 failed)`. Thinking reads as its recorded thinking time and shell commands carry their summed runtime, so time spent reasoning and time spent running can be compared at a glance. Either appears only when every member was timed; untimed thinking reads as a count (`thought 3 times`). Token count and total elapsed time stay right-aligned.
- A group summary that does not fit drops its duration, then its token count, before cutting any segment. When segments must be cut, the per-segment failure counts give way to one right-aligned total (`3 failed`), so failures are the last thing to leave the row.
- Recompute on structural events only; never per token.
- Hysteresis: two consecutive recomputes must agree before an unanimated level change. A completed fade commits its step directly.
- Visible blocks fade one step at a time, in order. A block more than one step behind its target when the plan is recomputed catches up without animation, as offscreen blocks do; the block mid-fade finishes its row first, then takes its target, so a burst of new blocks never queues more than one animated step per block.
- Bodies spend their budget on evidence: diffs shed unchanged context lines
  before hiding any hunk, reads keep their opening and their end, and logs and thinking previews keep their newest lines.
  An omission notice sits where lines were removed: below a tail, and between the opening and the end of a read.
- A preview gives each output line one row and cuts it at the terminal width; a cut line makes the row openable even when every line is present. An opened tool row wraps long lines instead. Its full command, its wrapped output and any omission notices share one cap of 400 body rows; the command takes at most half of the cap when there is output to show.
- Under an open group summary, member headers occupy consecutive rows two columns in,
  starting immediately below the summary. Tool and thinking bodies begin four columns past their own heading marker, two columns past the heading label. Output, omission notices, and wrapped Markdown share this inset.
- A click opens a block all the way, and the next click folds it back: a folded
  member shows its header until clicked, then its whole body. Any block with a
  truncated body (a kept tool row, a one-line thinking run) toggles the same
  way. Standalone tools stay expanded until clicked again. An opened group member stays
  expanded as turns finish and new members join the group. Every block kind behaves the same: tool rows, thoughts, group summaries and group members. A block that can open opens on a click on any of its rows, and an open block closes on a click on any of its rows; a click anywhere on a summary row opens or closes its group. Hovering a block paints nothing but its scroll bar: no heading highlight, no tint and no `click` chip; an open group carries no mark of its own, only the hover cell on its summary. Clicking the summary of a forming group closes it, and it stays closed as it grows; opening one of its members keeps the group open past six rows. When merging groups disagree, any open member opens the result, else any closed member closes it.
- Column 1, the second cell of each row, is a block's scroll bar, in pi's `scrollbarThumb` and `scrollbarTrack` colours. Column 0 keeps the heading marker or indent; every block kind has a space in column 1, after its marker or inside its indent, and a row with a glyph there keeps it unpainted. Hovering a block that can open paints its preview rows, the omission notice included, as a proportional map of the whole output or thought: each cell stands for an equal share of the source lines and is filled where the preview shows some of them, so a log tail fills the bottom and a read fills both ends. A hovered one-row item (a group summary, a collapsed member, an inline thought, the header of a clipped command with no output) gets one filled cell. A block that shows everything it has gets no bar and ignores clicks. An open block in fullscreen paints the bar on its visible rows like a real scroll bar: track on every visible row and one thumb cell marking the reader's position, on the first visible row at the block's top, on the last at its end, and moving down as the reader scrolls down. A block that fits on screen keeps its thumb on its first row. Inline mode cannot see the terminal's scroll position, so open blocks there have no bar.
- Thinking runs decay on the same visual ladder: the number of blocks that
  follow them in the run sets their level, so an older thought keeps a tail
  instead of collapsing to one line prematurely. A streaming preview clamps
  each source line to the terminal width instead of wrapping it, so arriving
  tokens extend the last row rather than reflowing the tail; once the run
  settles, body text wraps instead of ending in an ellipsis. A terminal row is
  a layout unit, not a truncation point. During streaming the omission count sits directly below the heading and the newest line stays at the bottom. The preview skips intermediate rows that never reached the screen. When it sheds previously visible rows, it drops
  one per tick. The fade applies only after streaming finishes. Hover is neutral for thinking and tool rows alike: the scroll bar in column 1 carries the
  affordance, the status glyph keeps the outcome colour.
- Opening a group shows each collapsed thinking member as one inline row, regardless of its age. Clicking a truncated thought opens its body.
- A fully visible thought has no hover bar or click action. An inline
  thought with omitted opening lines marks its tail with an ellipsis. Opening it
  shows the source in reading order, up to 400 body rows including any omission notice.
- Edit diffs use the file’s syntax colors for code. Added and removed lines retain their signs and use the theme’s success and error backgrounds.
- Header token counts, rates and latency align to the right. Tool headers use normal text contrast for numbers, the theme’s keyword color for `out` and type color for `in`, and muted units and separators.
- Tool headers estimate the model’s output tokens for the invocation and input tokens for the returned content. Partial arguments and results update the counts.
- With throughput available, a tool header reads `out 26 @ 73/s · in 5.5k @ 2.5k/s`. Tool headers retain the duration alongside throughput. Output is model output for the tool invocation. Prism measures arriving argument deltas and can also use the provider’s decode timing. Input is the tool result sent back to the model. Its rate is the **whole consuming request’s prefill speed**. Results batched in one prompt share that rate.
- A live `prefill 4.2k tok/s` status appears when the provider streams processed and cached prompt-token counts and elapsed prefill time. Final server timings can supply a rate after completion. A prompt with no tool results retains its last measured prefill speed in the status line. For OpenAI-compatible streaming requests without server timing, the first generated text, reasoning or tool-argument delta freezes a client estimate, marked with `~` in tool headers (`in 1.7k @ ~4.2k/s`) and `est.` in the status line. It divides estimated new prompt text tokens since the preceding assistant message by request-to-first-output time, including transport and queueing, assuming reuse of the preceding prefix. Server timing supersedes the estimate. Recorded rates survive session reloads.
- Prism requests progress automatically for llama.cpp provider IDs. For a custom llama.cpp provider ID, set `PI_PRISM_LLAMA_TIMINGS` to that ID. Other providers’ request payloads pass through as configured.
- Group headers total the tokens of their folded members. Thinking and tool invocation arguments count as model output. Tool results count as model input. A failed call with its own row contributes only to that row.
- Write calls preview the file content as arguments arrive, follow its tail during generation, and retain the source for expansion after completion.
- File reads and single-file shell previews use pi’s filename-based syntax highlighting. Structured JSON results use its JSON grammar, and unified diffs retain semantic change colours. Ordinary logs use the tool output theme.
- Thinking bodies render Markdown with pi’s theme, including inline code, lists and fenced code. The detail budget applies after wrapping. Rich formatting falls back to plain text above 64 Ki UTF-16 code units to bound parser work.
- Thinking headers show elapsed time and one token count. Streaming text supplies an estimate until a provider reports reasoning usage attributable to that run. Throughput samples use text arriving after the first chunk and the interval between those arrivals. A pause leaves the last sample on screen. Newly recorded runs retain their final rates and individual durations after restore. Older messages with only response timing label it as turn time.
- Moving onto a blank separator clears the hover bar immediately. Clicking the separator leaves the adjacent blocks in their current state.
- Tool, thinking, and group durations show milliseconds below one second and seconds thereafter.
- A running bash header shows elapsed execution time and refreshes every 100 ms, even while the command is silent. Long commands shorten to leave room for the timer. Expanding a clipped bash command shows its complete invocation, wrapped above the output, even for a silent command. On completion the header uses pi’s recorded duration.
- A one-row shell preview uses the latest substantive line when trailing output
  consists of single characters or closing delimiters. A single-value result stays visible.
- A failed shell puts the exit status in its header and stderr in the body:
  the outcome stays scannable while the evidence stays readable.
- Long shell commands truncate in the middle, keeping the opening verb and the
  end target; paths keep their basename instead.

## Width and glyphs

- Measure with `visibleWidth`/`truncateToWidth`; never `String.length`.
- Every line must fit the supplied width exactly; no overflow, no ANSI bleed across lines.
- Glyph sets: `nerd`, `unicode`, `ascii`. A card must render in all three; ASCII is the accessibility floor.
- Motion: spinner frames and pulse cadence are data. Registry states carry them as frames; `ds:show` prints the last frame and the fixtures record the first.

## Definitions

- **Run**: everything between user messages.
- **Turn**: one model response plus the tool calls it made.
- **Block**: a rendered transcript unit (assistant text, thinking run, tool row, group summary, notice).
- **Group**: contiguous collapsed tool rows of one class, summarised on one line.
