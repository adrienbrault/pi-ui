# AGENTS.md

`pi-extensions` builds **pi-prism**, a recency-graded replacement terminal UI for the pi coding agent, and the design system that keeps it honest. Everything here is Bun-first.

## Fast loop

```bash
bun run check        # tsgo + oxlint + biome + bun test + fixture drift — under a second
bun run ds           # regenerate the golden fixtures
bun run ds:show read # print cards whose id contains "read" as ANSI (--width N, --theme dark|light, --ascii)
```

`check` runs, in order: `tsgo` (native TypeScript preview) → `oxlint` → `biome format` → `bun test` → `ds:check`. A red gate means do not commit. If `tsgo` disagrees with an editor, `bun run typecheck:slow` falls back to classic `tsc`.

## Layout

| Path | What lives there |
|---|---|
| `packages/pi-prism/render/` | Pure renderers: detail ladder, tool rows, group rows, thinking labels. No I/O, no timers, no globals. |
| `packages/pi-prism/extensions/` | The live session: a tool-renderer resolver that owns tool rows, paints the hover hint, and cycles expansion on click. |
| `design-system/registry.ts` | Every card and scenario, declared once. |
| `design-system/lib/` | Resolving the pi install, theme init, the render kit and `stack`. |
| `design-system/build.ts` | Renders every cell and writes the fixtures. `--check` guards drift. |
| `design-system/show.ts` | Prints matching cards to the terminal as raw ANSI, for review. A multi-frame state prints its last frame. |
| `design-system/fixtures/` | Golden ANSI snapshots. Tracked. Never hand-edit. |
| `docs/PLAN.md` | Decisions, architecture, phases P0–P5, risks. |
| `DESIGN.md` | Component contract for both audiences. |

## Invariants

Breaking any of these is a design regression, not a style preference.

1. **Render truth.** Every card renders real components: base pi from the resolved install, ours from `packages/pi-prism/render`. No mockups, no screenshots of mockups. Fold layouts in fixtures are planned by `extensions/fold.ts`, the module the live session uses. If the implementation changes, `bun run ds` changes the card's fixture and `bun run ds:show` prints the new card.
2. Failed calls fold with their peers. Each affected summary segment includes its failure count, and opening the group reveals the failed calls in order.
3. **The body budget is total.** A row's height is capped by its detail level; an expanded row's "… N more lines" notice counts against that cap, not on top of it.
4. **Fixtures are golden.** `ds:check` fails when committed fixtures disagree with what the renderers produce. Change a renderer → `bun run ds` → commit the fixtures in the same change.
5. **Decay only on structural events.** Recompute transcript heights on `message_start`, `tool_execution_start/end`, `turn_end`, `agent_settled` — never per token. A level change requires two agreeing recomputes (hysteresis); a click pins a block expanded until clicked again.
6. **Theme tokens only.** Use pi's semantic tokens (`accent`, `muted`, `dim`, `success`, `error`, `warning`, `toolTitle`, `toolOutput`, `thinkingText`, …). Never hardcode hex.
7. **Duck-type pi internals.** Multiple `pi-tui` copies can be loaded at once; `instanceof` lies across them. Probe capabilities and guard versions instead.

## Gotchas

- **Theme init order.** pi's theme needs `initTheme('dark')` and a `Theme` instance installed before any component renders; see `design-system/lib/theme.ts`.
- **Per-message thinking tails** require walking the TUI tree and calling `AssistantMessageComponent.setHideThinkingBlock()` / `setHiddenThinkingLabel()`. pi's own `setHiddenThinkingLabel` on `ctx.ui` is global-only.
- **Grouping needs a spacer fix.** pi tool rows emit a leading `Spacer(1)`; a group row must neutralise it rather than delete real layout children.
- **Bun, not npm.** `bun.lock` is tracked; `bun.lockb` is ignored. Scripts assume Bun's runtime.

## Adding a component

1. Pick the semantic token and the detail ladder slots it must survive (`pending`, `running`, `success`, `error`, `expanded`, `aged0..5`).
2. Write the pure renderer in `packages/pi-prism/render/`, returning a `ComponentLike` via `RenderKit`.
3. Add a test in `render.test.ts` — row counts, width fitting, and the failure cases.
4. Register the card in `design-system/registry.ts` (id, title, group, description, one render fn per state).
5. `bun run ds`, inspect with `bun run ds:show <id> --width 40|80|120`, with and without `--theme light`, then `bun run check`.

## Where decisions live

`docs/PLAN.md` is the agreed plan; `DESIGN.md` is the component contract. When a decision changes, update the doc in the same commit as the code. ADRs and RFCs go under `docs/adr/` and `docs/rfc/` when a decision is worth its own record.
