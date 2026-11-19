# pi-extensions

A workspace for **pi-prism** — a recency-graded terminal UI for the pi coding agent — and the render-truth design system that keeps it honest.

- **`AGENTS.md`** — how to work in this repo: fast loop, invariants, gotchas. Start here if you are an agent.
- **`docs/PLAN.md`** — the agreed plan: decisions, architecture, phases, risks.
- **`DESIGN.md`** — the component contract for humans and agents.
- **`design-system/`** — the card registry and golden ANSI fixtures: real components, rendered to the terminal.
- **`packages/pi-prism/`** — the UI package (working name).

## Commands

```bash
bun run check        # tsgo + oxlint + biome + tests + fixture drift (~0.6s)
bun run ds           # regenerate the golden fixtures in design-system/fixtures/
bun run ds:show read # print matching cards as ANSI (--width N, --theme dark|light, --ascii)
bun run ds:check     # fail if committed fixtures no longer match the renderers
bun run typecheck    # native tsgo; typecheck:slow falls back to tsc
bun run lint         # oxlint, warnings are errors
bun run format       # biome format
bun test             # bun:test, renderer behaviour and row budgets
bun run e2e          # drive a real pi in tmux through scripted sessions (offline)
```

## Trying it in pi

```bash
pi -e /path/to/pi-extensions/packages/pi-prism/extensions/index.ts
pi --tui-mode fullscreen -e /path/to/pi-extensions/packages/pi-prism/extensions/index.ts
```

Add `--no-extensions` to load pi-prism alone, plus `-e` for any provider extension you need.

Cards render against a real pi install: `PI_CODING_AGENT_ROOT` if set, otherwise the pi version pinned in `packages/pi-prism` (then `nvm` or a global install if dependencies are missing). Cards show the real thing rather than a drawing, and `ds:check` gives the same answer on every machine. The ANSI fixtures in `design-system/fixtures/` are tracked goldens. Review a card in the terminal with `bun run ds:show <id substring>`.

## Layout

```
packages/pi-prism/render/   pure renderers + tests
design-system/
  lib/                      pi resolution, theme init, render kit
  registry.ts               every card and scenario
  build.ts                  render cells, write fixtures, --check drift
  show.ts                   print cards to the terminal
  fixtures/                 golden ANSI snapshots (tracked)
docs/                       plan, ADRs, RFCs
```
