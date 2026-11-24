# pi-ui

pi-ui (`@adrienbrault/pi-ui`) is an extension for the [pi coding agent](https://pi.dev) that changes how pi draws tool calls and thinking blocks in the terminal.

## What it changes

- **Older blocks get shorter.** The newest tool call or thought shows up to 8 lines of output. Every two newer blocks, an older block loses one line, down to 3 lines and a `⋮ N more lines` notice. Lines leave one at a time instead of all at once.
- **Images shrink too.** An image in a tool result shows whole in the newest block, gets smaller as the block ages, and disappears when the block folds; opening the block shows it whole again. Clicking an image opens it large and centred; the left and right arrows step through the session's images, and Escape or a click anywhere in the viewer closes it.
- **Old runs fold into one line.** About ten blocks back, or when you send a new prompt, consecutive thoughts and tool calls fold into a summary such as `Thought for 6.3s, read 1 file, ran 1 shell command · 1 failed`. Failed calls fold with the others, and the summary keeps their count.
- **Click to open, hover to see what a click does.** Clicking a block opens its full output (up to 400 lines) and its full command or path. Clicking a summary lists its members in aligned columns, and each member opens on its own. Hovering any block lights its title and, when it can open, its notices and its scroll bar in the left margin.
- **Thinking blocks per message.** Each thought shows its elapsed time, token count and rate, and the end of its text while it streams. pi's own thinking label is global; pi-ui sets it per message.
- **The todo list, in pi-ui's vocabulary.** The session's todos show above the editor: a heading that counts them and draws its share (`● Todos 1/4 ▰▱▱▱`), a row per todo keeping the `#id` its calls use in the transcript, the running step's spinner, and finished steps dimmed to a check. Past ten lines the finished steps leave first and one `⋮ N more` notice counts them. `todo` calls are pi-ui rows too, so they age, fold and open like any other.
- **Scripts and tool lookups.** A `codemode` call is a pi-ui row: its first statement names it, the calls the script made — each with its mark, its arguments and its time — lead its output, a `⋮ 4 more calls · 1 failed` folds the rest, and opening it shows every call. `tool_search` names the tools it loaded; a lookup that found nothing keeps its label, and the words it searched for stay its body.
- **Delegated children.** A `subagent` call is a pi-ui row: the brief it was handed streams while the model writes it, the child's last message becomes the body when it lands, the header counts the child's own tokens, and a dim `3 tools · 2 turns` closes it. A background run that comes back draws its own block (`✓ subagent · scout completed`), the answer under it and a click for the rest.
- **Question prompts read as questions.** pi's `ask_user_question` rows are pi-ui rows: `● ask · Next action` with the chosen answer checked under it. Opening the row lists every option it offered, with the trade-offs the model wrote under each label, and a prompt still waiting for you lists them straight away.
- **The last prompt stays at the top.** Once your prompt has scrolled out of the transcript, it comes back on one banded row at the top of the screen — `❯ review this repo, and also write/update .md…` — and leaves the moment you scroll back up to it, so it is never on screen twice. A prompt that fits the width shows whole; a longer one keeps its opening. A terminal that scrolls itself, rather than pi's fullscreen view, pins nothing.
- **Compactions and branch switches read as blocks.** pi's summary bands are pi-ui blocks: `▸ compaction · 128.4k tokens` with the summary's opening rows under it and a `⋮ N more lines` for the rest, a click for all of it. A branch summary reads `▸ branch` — pi's context message carries no count.
- **Tool calls stream as they are written.** While the model writes a call, its block shows the arguments arriving: an `edit`'s replacements as red and green diff lines, a long shell command or script line by line, and any other argument the header does not show. The output replaces them when it arrives.
- **Line numbers and highlighting.** `read` output and `edit` diffs are numbered and syntax-highlighted. Shell commands that print one file (`cat`, `head`, `tail`, `sed -n`, `bat`, `nl`, …) or search results (`rg`, `grep`, `git grep`, `ag`) get line numbers in a gutter, file headers and highlighting. If you edit by anchors (`pi-hashline-edit`), its `LINE#HASH:` prefixes never reach a row: the gutter numbers the lines and the diff's signs mark the changes.
- **Diffs for files a shell command changed.** In a git work tree, pi-ui records which files a `bash` command created, changed or deleted, and shows their diffs under the command's output. The diffs are saved with the session.
- **Tokens and rates.** Headers show input and output tokens with their rates, marked as pi's footer marks them (`↑` sent, `↓` received), for example `↑60 @ 2.4k/s · ↓26 @ 48/s`. A status item shows the prefill rate when the provider reports it. pi-ui asks llama.cpp providers for their timings; set `PI_UI_LLAMA_TIMINGS=<provider id>` when your llama.cpp provider has another id.

## Demo

These recordings are a real pi session (deepseek reviewing this repository) replayed in pi with pi-ui, at the session's recorded pace, sped up slightly. They were made with `bun run replay` (see Development).

A long thought as it streams. The newest lines stay at the bottom, the header counts its tokens, rate and time, and the shell commands it decides to run follow.

![A thought streaming, then shell output](https://raw.githubusercontent.com/adrienbrault/pi-ui/main/docs/media/thinking.gif)

The start of a session. Tool rows show their output, and older blocks lose lines as newer ones arrive.

![A pi session streaming with pi-ui](https://raw.githubusercontent.com/adrienbrault/pi-ui/main/docs/media/session.gif)

Older blocks folded into one summary. Clicking the summary lists its members in columns; clicking a member opens its full command and output.

![Opening a folded summary and one of its members](https://raw.githubusercontent.com/adrienbrault/pi-ui/main/docs/media/open.gif)

A long block opened and scrolled. Hovering a block lights its title and, when it can open, shows a scroll bar in its left margin, filled where the preview hides lines. Clicking opens the whole file, and while you scroll, the bar's thumb shows which part of the block is on screen.

![Opening a long read and scrolling through it](https://raw.githubusercontent.com/adrienbrault/pi-ui/main/docs/media/scroll.gif)

## Install

```bash
pi install npm:@adrienbrault/pi-ui
# or from GitHub
pi install git:github.com/adrienbrault/pi-ui
```

To try it for one session without installing it:

```bash
pi -e npm:@adrienbrault/pi-ui
# or from a local checkout
pi -e /path/to/pi-ui/packages/pi-ui/extensions/index.ts
```

Add `--no-extensions` to load pi-ui without your other extensions.

Hover and click need pi's fullscreen mode, which is the default. In regular mode (`--tui-mode regular`), the terminal keeps the mouse and its scrollback: blocks still shorten and fold, but there is no hover, click or scroll bar.

## Requirements

- pi 1.5. pi-ui is developed and tested against `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` 1.5.2.
- git, for the file diffs under shell commands. Without git, or outside a git work tree, pi-ui skips them.
- Bun, only to work on this repository.

## Compatibility

- **pi internals.** Tool rows use pi's public `registerToolRenderer`. Per-message thinking, folding across rows, the scroll bar, user messages and the compaction and branch summaries also read and wrap internal pi components. pi-ui checks for each method it uses before using it; when one is missing, that part keeps pi's default rendering. A new pi version can still change how these parts look.
- **Tools pi-ui draws.** `read`, `ls`, `grep`, `find`, `ffgrep`, `fffind`, `multi_grep`, `write`, `edit`, `bash`, `powershell`, `web_fetch`, `web_search`, `fetch_content`, `codemode`, `tool_search`, `todo`, `ask_user_question`, `subagent` and every `mcp__*` tool. Other tools keep their own renderers and end a folded run. pi's user prompt band and its own `compactionSummary`/`branchSummary` blocks are restyled in place too. Another extension that renders the same tools, or changes pi's thinking labels, will conflict with pi-ui; which one wins depends on load order.
- **File diffs.** Before a shell command runs, pi-ui snapshots the work tree. It skips repositories with more than 20,000 files and stops after 1 second. pi runs a message's tool calls in parallel: a file that an `edit` or `write` call changes while a shell command runs is left out of the command's diffs, but two shell commands running at the same time in one work tree can each show the other's changes.

## Development

```bash
bun install
bun run check        # typecheck, lint, format, tests and fixture drift; under a second
bun run ds           # regenerate the golden fixtures in design-system/fixtures/
bun run ds:show read # print the cards whose id contains "read" (--width N, --theme dark|light, --ascii)
bun run e2e          # drive a real pi in tmux through scripted, offline sessions (needs tmux)
bun run replay -- ~/.pi/agent/sessions/<project>/<session>.jsonl --list                         # numbered turns, messages and tool calls
bun run replay -- <session.jsonl> --until message:7@50% --shot thinking.png                      # pause mid-stream, save a PNG
bun run replay -- <session.jsonl> --speed 2 --from message:5@0% --until tool:12:end --gif run.gif # record a GIF between two points
bun run states       # render the key UI states into docs/states/ (PNG and ANSI per state, a mosaic, an index)
bun run states:check # render them again into a scratch directory and list every file that differs
```

The design system renders real pi components and pi-ui's renderers to ANSI fixtures, which are committed. `ds:check`, part of `check`, fails when a renderer change is not reflected in the fixtures. Cards render against the pi version installed in `packages/pi-ui`; set `PI_CODING_AGENT_ROOT` to render against another pi install.

`bun run replay` plays a recorded pi session again in a real pi with pi-ui, offline, in its own tmux pane: the recorded messages stream at about their recorded pace, tools return their recorded results after their recorded time, and nothing runs or touches files. It pauses at a stop point (`turn:N`, `message:N[@P%]`, `tool:N|ID[:start|:end]` or `end`, each reached once it has happened: `turn:2` when pi settles after turn 2), can hover or click a row by its text, and saves the screen as a PNG, ANSI text or a GIF (needs tmux, `agg` and `ffmpeg`). `bun run replay -- --help` lists the options; `bun run replay:smoke` checks the loop on a synthetic session.

pi runs on a virtual clock during a replay, so a capture is the same bytes on every run. `bun run states` uses that to render key UI states from recorded and synthetic sessions into [docs/states/](https://github.com/adrienbrault/pi-ui/blob/main/docs/states/README.md), which is committed: a UI change shows up there as an image diff. It takes about a minute and needs tmux, `agg`, `ffmpeg` and ImageMagick.

[AGENTS.md](https://github.com/adrienbrault/pi-ui/blob/main/AGENTS.md) describes the workflow and the rules the code must keep. [DESIGN.md](https://github.com/adrienbrault/pi-ui/blob/main/DESIGN.md) is the component contract, and [docs/PLAN.md](https://github.com/adrienbrault/pi-ui/blob/main/docs/PLAN.md) records the decisions and the roadmap.

## Repository layout

```
packages/pi-ui/render/      pure renderers: tool rows, thinking blocks, group summaries, shell output
packages/pi-ui/extensions/  the pi extension: folding, fades, hover, scroll bar, throughput, file diffs
design-system/              card registry, fixture builder, terminal card viewer, golden fixtures
dev/                        tmux end-to-end harness and its offline provider
dev/replay/                 replay of recorded sessions in pi, with PNG and GIF capture, and the key states
docs/states/                the key states, rendered: a PNG and ANSI text each, a mosaic and an index
```

## License

MIT. See [LICENSE](https://github.com/adrienbrault/pi-ui/blob/main/LICENSE).
