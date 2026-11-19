# Plan: a recency-graded pi UI, with a design system both humans and agents can work from

Status: agreed direction. Working package name `pi-prism` (rename later; nothing depends on it).

## Locked decisions

| Decision | Choice |
|---|---|
| Transcript control | Runtime decorator over the live TUI layout root, behind capability probes and version guards |
| Design system | Render-truth: real components rendered to ANSI → HTML, no hand-drawn mockups |
| Packaging | Standalone full replacement of the pi UI (staged; transcript first, chrome later) |
| Decay unit | Block index within the current run; whole runs collapse and group beyond it |

## Goal

Make a long agentic session readable at a glance without losing the live detail:

- The newest block streams with a bounded tail (max 8 lines).
- Completed previews age as newer blocks arrive, including on screen. Visible previews step down one at a time before joining a group.
- Older runs stop being a pile of one-liners and become one grouped summary: `Read 4 files · Ran 2 commands · 1 failed`.
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
  lib/pi.ts        resolve the pi install actually in use (env → `which pi` → repo node_modules)
  lib/theme.ts     load dark/light theme JSON, resolve vars, initTheme + setThemeInstance
  lib/surface.ts   component → string[] → ANSI→HTML; width/theme cache
  registry.ts      variant × component × state × width × theme
  scenarios.ts     compositions: cold start, long run, failing bash, thinking-heavy, MCP, compaction…
  build.ts         writes web/index.html, spec.json, fixtures/*.ansi.json
  web/             generated output (gitignored or committed, decide)
```

Every card is real output, not a drawing: base pi components from the resolved install, pi-code and pi-open-tui from vendored snapshots pinned by version, ours from the same `packages/pi-prism/render` module the extension will ship. That last point is the contract: **the design system and the implementation share one renderer module**, so the gallery cannot drift from the product.

Axes exposed in the UI:

- variant: base / open-tui / pi-code / ours
- state: pending, running (animated), success, error, partial, expanded, aged L0–L5
- width: 40 / 80 / 120
- theme: dark / light / system
- motion: play/pause (spinner frames, pulse cadence, streaming tail)

Scenarios get a turn scrubber so you can watch 12 rows fold into 3 summary lines as turns accrue.

Outputs for agents:

- `spec.json`: tokens, component ids, props, states, max-line budgets, glyph sets, scenario ids.
- `fixtures/*.ansi.json`: golden frames, consumed by tests so rendering changes are reviewable.
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
Standalone body budget: 7 → 6 → 5 → 4 → group
The four-row preview fits three content lines and one omission notice.
```

- Count newer blocks across the whole transcript. Show eight 90 ms fade frames per departing visible row, including each row of a folding block and apply offscreen changes immediately.
- The live block is pinned to L0 regardless of its own length.
- Recompute on structural events only: `message_start`, `tool_execution_start/end`, `turn_end`, `agent_settled`. Never per token.
- Hysteresis: a block must cross the boundary for two consecutive recomputes before changing level, so stream chatter does not flicker heights.
- Clicking a standalone tool pins it at its expanded form until clicked again; the pin is keyed by tool call id or message id, so it survives re-render and restore.

#### Taxonomy

| Class | Members | Collapsed form | Grouped summary |
|---|---|---|---|
| read | read, ls | `Read 3 lines · src/a.ts` | `Read 4 files` |
| search | grep, find, ffgrep, fffind | `Grep 12 matches · "foo"` | `Searched 3 times` |
| write | write | `Wrote 42 lines · b.ts` | `Wrote 2 files` |
| edit | edit | `Edited +8/-2 · c.ts` | `Edited 3 files` |
| shell | bash, powershell | last tail line + exit | `Ran 2 commands` |
| web | web_fetch, web_search | `Fetched example.com` | `Fetched 2 URLs` |
| mcp | `mcp__*` | `mcp · server/tool` | `Called 2 MCP tools` |
| code | codemode, tool_search | nested-call rollup | `Ran 1 script` |
| think | thinking runs | tail lines + duration | `Thought 12s` |

Failed calls fold with their peers. Each affected summary segment includes its failure count, and opening the group reveals the failed calls in order.

#### Coexistence and conflict

The standalone build owns chrome, so v1 must not double-install with pi-open-tui. Detection rules:

- If pi-open-tui's footer/editor is detected, warn and leave it alone until its features are disabled (or offer a `/prism takeover` command).
- pi-code's renderers (todo, question, subagent) are left untouched; the decorator only touches tool rows it owns.
- Two copies of `pi-coding-agent` would break `instanceof`; the decorator duck-types (as pi-open-tui does) and probes methods before wrapping.

#### Edge cases to handle explicitly

- Session restore: pi rebuilds the transcript before `session_start`; settings must load early.
- Width and theme changes invalidate caches; re-render at the new width.
- Image rows render below the row; collapsing must not hide images.
- Compaction and branch summaries are boundaries: groups do not span them.
- Fullscreen mode wraps the transcript in a `ScrollView`; the decorator resolves the layout root, not just `chatContainer.children`.
- Errors and aborts stay visible at every level.

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
| P0 | Repo skeleton, render-truth harness, first gallery (thinking + read/bash/edit rows + decay demo) | `bun run ds` emits a working `index.html`; base-pi rows match the terminal |
| P1 | Full component coverage + 4 variants + scenarios + fixtures + `spec.json` | Every block we intend to own is in the gallery; agents have DESIGN.md + spec |
| P2 | Decay engine + tool renderers + thinking tails (extension, decorator for per-message only) | A real session folds rows by age; widths/themes/restore behave |
| P3 | Grouping + click-to-expand + pins | `Read 4 files · Ran 2 commands` collapses and expands in a live session |
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
- Whether to expose the decay curve as a setting (`/prism decay 7,5,3,1`) or keep it fixed for v1.
