# Design system contract

This file is for both audiences. Humans use the gallery to judge; agents use the contract to change code without inventing a second visual language.

## The rule that keeps it honest

The gallery renders the **real** components:

- base pi components come from the pi install resolved at build time;
- pi-code and pi-open-tui come from vendored snapshots pinned by version;
- ours comes from `packages/pi-prism/render/*`, the exact module the extension ships.

A card is therefore a fixture, not an illustration. If the implementation changes, `bun run ds` changes the card. If a card looks wrong, the product looks wrong.

## Adding a component

1. Pick the semantic token first. Use pi's theme tokens (`accent`, `muted`, `dim`, `success`, `error`, `warning`, `toolTitle`, `toolOutput`, `thinkingText`, …). Never hardcode a hex value.
2. Put the pure renderer in `packages/pi-prism/render/`. It takes data + a render context (`theme`, `width`, `detail`, `expanded`) and returns a `Component` (or lines). No I/O, no timers, no global state.
3. Register it in `design-system/registry.ts`: id, title, group, description, and one render function per state (`pending`, `running`, `success`, `error`, `partial`, `expanded`, `aged0`…`aged5`).
4. Render it. `bun run ds`. Check it at 40/80/120 columns, dark and light.
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
| `aged0..5` | distance from the tail; 0 is live |

## Detail model

```
L0 live      7 rows, streaming
L1           6 rows
…            one fewer per turn
L6           1 row
distance ≥ 8 folded into a group summary
```

The tail budget (7 above) is configurable: `setTailLines()` moves the whole
ladder, and the gallery exposes it as a live slider (`/api/cells`).

Rules:

- Distance counts within the current run.
- One-line blocks hold their line until the fold distance: they do not vanish
  the turn after they shrink.
- Thinking sheds one row per turn and bottoms out at one inline line; it never
  folds into a group.
- Errors and the live block keep their own rows; a failure never joins a group.
- Recompute on structural events only; never per token.
- Hysteresis: two consecutive recomputes must agree before a level changes.
- Bodies spend their budget on evidence: diffs shed unchanged context lines
  before hiding any hunk, reads keep their opening and their end with a
  `< N more lines >` notice between, and logs keep the newest lines.
- A click opens a block, and what it opens is graded like the tail: a folded
  member shows its header, then roughly five body rows with a "show all" cue,
  then the whole body; the next click folds it back. Any block with a truncated
  body (a kept tool row, a one-line thinking run) opens the same way, and the
  pin holds until the next turn. In the session the row under the pointer says
  what the click will do — `click · expand`, `click · show all`,
  `click · collapse` — in an inverted chip at its right edge.

## Width and glyphs

- Measure with `visibleWidth`/`truncateToWidth`; never `String.length`.
- Every line must fit the supplied width exactly; no overflow, no ANSI bleed across lines.
- Glyph sets: `nerd`, `unicode`, `ascii`. A card must render in all three; ASCII is the accessibility floor.
- Motion: spinner frames and pulse cadence are data, not CSS. The gallery plays them back; `prefers-reduced-motion` freezes them.

## Definitions

- **Run**: everything between user messages.
- **Turn**: one model response plus the tool calls it made.
- **Block**: a rendered transcript unit (assistant text, thinking run, tool row, group summary, notice).
- **Group**: contiguous collapsed tool rows of one class, summarised on one line.
