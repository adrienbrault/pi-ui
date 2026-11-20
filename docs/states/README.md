# pi-ui states

Key states of pi-ui, rendered from replays of real sessions in real pi (see `dev/replay/states.ts`). Each state has a PNG and its `.ans` text capture. `bun run states` writes this directory and `bun run states:check` compares a fresh render with it, byte for byte. Do not edit these files by hand.

![Every state](mosaic.png)

## Session start

The prompt, the first reply, and the first two shell commands with their output.

![Session start](session-start.png)

## Read with line numbers

A read shows the file's first and last lines, numbered, with a notice for the lines between.

![Read with line numbers](read-line-numbers.png)

## Running shell command

A shell command still running: its spinner, its clock, and the output printed so far.

![Running shell command](bash-running.png)

## Thought streaming

A long thought as it streams: its token count, rate and time, and its newest words at the bottom.

![Thought streaming](thought-streaming.png)

## Failed shell command

A failed command shows its exit code in the header, after a settled thought.

![Failed shell command](bash-failed.png)

## Search output

grep output under its command, after older blocks lost lines.

![Search output](grep-output.png)

## Write

A write shows the start and the end of the new file, numbered.

![Write](write-preview.png)

## Edit

An edit shows its diff with the old and new line numbers.

![Edit](edit-diff.png)

## Session end

The final answer, after every block above it folded.

![Session end](session-end.png)

## Group forming

The newest folded group lists its members under its summary while it has five or fewer.

![Group forming](group-forming.png)

## Folded summary

Older blocks folded into one summary line, scrolled to the top of the transcript.

![Folded summary](summary-folded.png)

## Summary under the mouse

Hovering the summary lights its marker: a click opens it.

![Summary under the mouse](summary-hovered.png)

## Summary opened

A click on the summary lists its members in aligned columns.

![Summary opened](summary-opened.png)

## Member opened

A click on one member opens its full command and output inside the group.

![Member opened](member-opened.png)

## Block under the mouse

Hovering a block that can open lights its notice and shows its scroll bar in the left margin.

![Block under the mouse](block-hovered.png)

## Block opened

A click opens the block's full output; the scroll bar's thumb shows how much is on screen.

![Block opened](block-opened.png)

## Long command opened

A command clipped in its header shows in full, wrapped, once its block is open.

![Long command opened](command-opened.png)

## Files a command changed

A shell command opened: under its output, the diffs of the files it changed, created and deleted.

![Files a command changed](bash-file-changes.png)

## Light theme

The same session in pi's light theme.

![Light theme](light-theme.png)

## Narrow terminal

A 70-column terminal: headers shorten their commands and wrap thoughts to fit.

![Narrow terminal](narrow-width.png)
