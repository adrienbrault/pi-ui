# Plan: a recency-graded pi UI, with a design system both humans and agents can work from

Status: agreed direction. Working package name `pi-prism` (rename later; nothing depends on it).

## Locked decisions

| Decision | Choice |
|---|---|
| Transcript control | Runtime decorator over the live TUI layout root, behind capability probes and version guards |
| Design system | Render-truth: real components rendered to ANSI, no hand-drawn mockups; reviewed in the terminal |
| Packaging | Standalone full replacement of the pi UI (staged; transcript first, chrome later) |
| Decay unit | Block index within the current run, one level per two blocks; whole runs collapse and group beyond it |

## Goal

Make a long agentic session readable at a glance without losing the live detail:

- The newest block streams with a bounded tail (max 8 lines).
- Completed previews age as newer blocks arrive, including on screen. Visible previews step down one level at a time, a level every two newer blocks, before joining a group ten blocks back. A new group lists its members, one row each, until it holds six rows, so the reader sees what opening a group looks like and the transcript shrinks gradually.
- Older runs stop being a pile of one-liners and become one grouped summary that reads as a sentence: `Thought for 3m 40s, listed 3 directories, ran 30 shell commands for 2m 05s (4 failed)`.
- Clicking a collapsed group member opens it until clicked again. A standalone tool pin lasts until clicked again.
- The same rules apply to thinking, tool calls (builtin + MCP + codemode), reads, writes, edits, and shell output.
- The design system shows base pi, pi-open-tui, pi-code, and ours side by side, in every state, so design decisions are made against truth.

## Non-goals (v1)

- Per-thinking-block LLM summaries. Parked: the machinery to generate them is orthogonal to rendering; revisit after the decay engine ships.
- Mouse-driven drag/selection changes beyond existing click-to-expand.
- Reimplementing pi-code's todo/subagent tools in v1 (they come with the standalone chrome phase).

## What pi actually allows (verified against 1.5.x)

| Surface | Public API | Consequence |
|---|---|---|
| Tool rows, incl. `mcp__*` | `pi.registerToolRenderer((name, next) => ...)` | Full control of render, no execution override |
| Thinking visibility + label | `ctx.ui.setHiddenThinkingLabel()` — global only | Per-message control requires the instance (below) |
| Footer / header / editor | `ctx.ui.setFooter/setHeader/setEditorComponent` | Chrome replacement is fully supported |
| Widgets, overlays, custom screens | `ctx.ui.setWidget/custom` | Not the transcript |
| Transcript rows as a group | none | Needs decorator splicing |
| Session entries (durable, TUI-only) | `pi.appendEntry` + `registerEntryRenderer` | Rows can be added, not merged |

Two things make the hard parts tractable:

1. `AssistantMessageComponent` and `ToolExecutionComponent` are exported. They render headlessly, so the design system can display real output and fixture it.
2. `AssistantMessageComponent` exposes instance methods `setHideThinkingBlock()` and `setHiddenThinkingLabel()`. pi-open-tui already walks the live TUI tree to mutate the newest one. Walking the same tree lets us give **every** message its own tail label and its own hidden/shown state.

The remaining hard part is grouping across rows: each `ToolExecutionComponent` owns a leading `Spacer(1)`, so N collapsed rows still leave N blank lines. The decorator neutralizes that by wrapping child `render()` (return `[]` for swallowed rows, splice the summary into the host row).

## Architecture

### A. Design system (render-truth)

```
design-system/
  lib/pi.ts        resolve the pi install to render against (env → pinned repo install → nvm/global)
  lib/theme.ts     load dark/light theme JSON, resolve vars, initTheme + setThemeInstance
  lib/surface.ts   render kit + stack: component → string[]
  registry.ts      variant × component × state × width × theme
  scenarios.ts     compositions: cold start, long run, failing bash, thinking-heavy, MCP, compaction…
  build.ts         writes fixtures/frames.json; --check guards drift
  show.ts          prints cards to the terminal as raw ANSI
```

Every card is real output, not a drawing: base pi components from the resolved install, pi-code and pi-open-tui from vendored snapshots pinned by version, ours from the same `packages/pi-prism/render` module the extension will ship. That last point is the contract: **the design system and the implementation share one renderer module**, so the cards cannot drift from the product.

Axes every card renders across:

- variant: base / open-tui / pi-code / ours
- state: pending, running (animated), success, error, partial, expanded, aged L0–L5
- width: 40 / 60 / 80 / 100 / 120
- theme: dark / light
- glyphs: unicode / ascii

The browser gallery (HTML page, tail slider, session playback scrubber on localhost:4173) was removed: it was too far from the terminal experience. Cards are now reviewed in the terminal with `bun run ds:show [filter] [--width N] [--theme dark|light] [--ascii]`.

Outputs for agents:

- `fixtures/frames.json`: golden frames, checked by `ds:check` so rendering changes are reviewable.
- `DESIGN.md`: how to add a component (token → renderer → registry entry → fixture → scenario).

### B. Implementation: `packages/pi-prism`

```
extensions/prism/index.ts        wiring, settings, feature detection
extensions/prism/detail.ts       DetailLevel, decay curve, hysteresis, pins
extensions/prism/tool-rows.ts    registerToolRenderer over the taxonomy
extensions/prism/thinking.ts     per-message label tails + visibility
extensions/prism/groups.ts       grouping taxonomy + summaries
extensions/prism/decorator.ts    layout-root walk, child render wrapping, splice
extensions/prism/chrome/*        footer, editor, header (phase 4)
render/                          pure renderers shared with the design system
```

#### Detail model

```
Standalone body budget: 8 → 7 → 6 → 5 → 4 → group
The four-row preview fits three content lines and one omission notice.
```

- Count newer blocks across the whole transcript. Show four fade frames per departing visible row, including each row of a folding block, and apply offscreen changes immediately. A backlog (a visible block more than one level behind, or a run a user message ended) drops its rows without fade frames, one at a time, oldest block first: the interval spreads the whole backlog over `BACKLOG_TOTAL_MS` (1.5 s), between `BACKLOG_MIN_MS` (25 ms) and one fade per row. A row fades over a quarter of the recent gap between new blocks (a moving average over the walks that find new blocks, as the planner counts them, reset when a user message starts a new run, counting blocks that arrive within one 20 ms frame of each other once and ignoring pauses over a minute), clamped to 80–480 ms; 360 ms until the pace is known.
- The newest group of the run lists one row per member up to five rows (`FORMING_ROWS`). At the sixth it collapses: its member rows leave bottom to top, one fade per row, as any departing row does; after a user message, or during a backlog, at the backlog's pace.
- The live block is pinned to L0 regardless of its own length.
- Recompute on structural events only: `message_start`, `tool_execution_start/end`, `turn_end`, `agent_settled`, plus once when a fade step or a block's backlog completes. Never per token. A fade or backlog tick repaints only the block that moves; it never walks the transcript.
- Hysteresis: an unanimated level change (an offscreen block) needs two consecutive recomputes that agree, so stream chatter does not flicker heights. A completed fade and each backlog step commit directly, and a group's forming state follows its member count directly.
- Clicking a standalone tool pins it at its expanded form until clicked again; the pin is keyed by tool call id or message id, so it survives re-render and restore.

#### Taxonomy

| Class | Members | Collapsed form | Grouped summary |
|---|---|---|---|
| read | read | `Read 3 lines · src/a.ts` | `read 4 files` |
| list | ls | `ls · src/` | `listed 3 directories` |
| search | grep, find, ffgrep, fffind, multi_grep | `Grep 12 matches · "foo"` | `searched for 3 patterns` |
| write | write | `Wrote 42 lines · b.ts` | `Wrote 2 files` |
| edit | edit | `Edited +8/-2 · c.ts` | `Edited 3 files` |
| shell | bash, powershell | last tail line + exit | `ran 2 shell commands for 9.3s` |
| web | web_fetch, web_search, fetch_content | `Fetched example.com` | `Fetched 2 URLs` |
| mcp | `mcp__*` | `mcp · server/tool` | `Called 2 MCP tools` |
| code | codemode, tool_search | nested-call rollup (not built; not owned yet) | `Ran 1 script` |
| think | thinking runs | tail lines + duration | `thought for 12s` (`thought 3 times` when untimed) |

Segments join into one sentence in encounter order, the first capitalised. A segment's time is the sum of its members' thinking or running time and appears only when every member was timed; thinking without time falls back to a count. Failed calls fold with their peers. Each affected summary segment includes its failure count, and opening the group reveals the failed calls in order.

#### Coexistence and conflict

The standalone build owns chrome, so v1 must not double-install with pi-open-tui. Detection rules:

- If pi-open-tui's footer/editor is detected, warn and leave it alone until its features are disabled (or offer a `/prism takeover` command).
- pi-code's renderers (todo, question, subagent) are left untouched; the decorator only touches tool rows it owns. It owns every tool in the taxonomy above except the code class, plus every `mcp__*` tool (`ownsTool` in `render/tools.ts`, the single source). Any other tool keeps its own renderer and ends a fold group.
- Two copies of `pi-coding-agent` would break `instanceof`; the decorator duck-types (as pi-open-tui does) and probes methods before wrapping.

#### Edge cases to handle explicitly

- Session restore: pi rebuilds the transcript before `session_start`; settings must load early.
- Width and theme changes invalidate caches; re-render at the new width.
- Image rows render below the row; collapsing must not hide images.
- Compaction and branch summaries are boundaries: groups do not span them.
- Fullscreen mode wraps the transcript in a `ScrollView`; the decorator resolves the layout root, not just `chatContainer.children`.
- Errors and aborts stay visible at every level.
- Files a shell command changes (`extensions/changes.ts`): a `tool_call` hook, which pi awaits after the row has started painting and before the command runs, snapshots the git work tree within a 1 s deadline: `git rev-parse --show-toplevel --show-prefix`, `git ls-files -z --stage`, `git ls-files -z --others --exclude-standard` and `git diff-files --name-only -z`, all with `--no-optional-locks` (about 10 ms together on this repository), then an `lstat` of every listed file and a read of the files git does not hold as they are (untracked, or differing from the index). A `tool_result` hook re-lists and re-stats, reads the old content of clean tracked files from their index blobs (`git cat-file --batch`), diffs as pi's `generateUnifiedPatch` does (jsdiff's `createTwoFilesPatch`, a dependency of pi-prism pinned to the version pi ships, with file headers only and four lines of context) but bounded, and adds `prismChanges` to the result's `details`, which pi persists. Nothing writes to the repository: `git stash create` was rejected because it writes loose objects on every call. Limits: more than 20,000 files skips the snapshot; files over 256 KB, past 4 MB or 2,000 files read in total, or past 256 KB of recorded patch text are reported without a diff; so is a change whose diff jsdiff gives up on: it runs synchronously and a deadline cannot interrupt it (reversing 12,000 lines, 132 KB, took 53 s), so each diff gets jsdiff's own `timeout` of 50 ms, or what is left of the 1 s deadline when less, and a `maxEditLength` of 131,072 lines removed plus added (a patch longer than that cannot fit the 256 KB of patch text, at two bytes or more per changed line); at most 50 files are listed per call, the rest counted. Concurrent shell calls each see the others' changes, since a change cannot be attributed to one process.

### C. Upstream RFC (parallel, low effort)

Propose `pi.registerTranscriptRenderer` / per-message thinking renderer with an age context / row grouping. Goal: turn the decorator into a compatibility shim. File it after the decorator proves the semantics.

## Repo layout

```
pi-extensions/
  docs/PLAN.md
  docs/adr/0001-transcript-control.md
  docs/rfc/transcript-api.md
  DESIGN.md
  design-system/…
  packages/pi-prism/…
```

## Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| P0 | Repo skeleton, render-truth harness, first gallery (thinking + read/bash/edit rows + decay demo) | `bun run ds` emits a working `index.html`; base-pi rows match the terminal (the gallery was later replaced by `ds:show`) |
| P1 | Full component coverage + 4 variants + scenarios + fixtures + `spec.json` | Every block we intend to own is in the gallery; agents have DESIGN.md + spec (`spec.json` went with the gallery; the registry and fixtures carry the spec) |
| P2 | Decay engine + tool renderers + thinking tails (extension, decorator for per-message only) | A real session folds rows by age; widths/themes/restore behave |
| P3 | Grouping + click-to-expand + pins | `Read 4 files, ran 2 shell commands` collapses and expands in a live session |
| P4 | Chrome: footer ladder, inline footer, editor frame, header | Standalone replaces open-tui's chrome; feature parity checklist green |
| P5 | Vision-floor parity, RFC, guards | Behaviour verified on two pi minor versions |

## Risks

| Risk | Mitigation |
|---|---|
| pi internals shift (class fields, render caching) | capa probes + duck typing + guarded fallbacks; fixtures catch drift |
| Decorator splicing breaks mouse regions / scroll | wrap per-child `render()`, keep host row's own `MouseRegion`; fullscreen test matrix |
| Two copies of pi-tui (identity mismatch) | resolve everything from one install; never `instanceof`, probe shape |
| Flicker/hysteresis bugs in decay | recompute only on structural events; snapshot tests across event sequences |
| Render cost on long transcripts | cache by (component, width, level); only invalidate affected rows |

## Open questions

- Package name and branding.
- Whether "ours" absorbs pi-code's todo/subagent/tool renderers by import or reimplementation in P4.
- Whether to expose the decay curve as a setting (`/prism decay 7,5,3,1`) or keep it fixed for v1. For now the tail budget, the blocks per step, the fold distance and the forming size are constants in `render/detail.ts`; a setting should arrive as explicit parameters with its own design, including the floor a separate fold distance needs.
