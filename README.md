# pi-extensions

A workspace for **pi-prism** — a recency-graded terminal UI for the pi coding agent — and the render-truth design system that keeps it honest.

- **`AGENTS.md`** — how to work in this repo: fast loop, invariants, gotchas. Start here if you are an agent.
- **`docs/PLAN.md`** — the agreed plan: decisions, architecture, phases, risks.
- **`DESIGN.md`** — the component contract for humans and agents.
- **`design-system/`** — the gallery: real components, real ANSI, real HTML.
- **`packages/pi-prism/`** — the UI package (working name).

## Commands

```bash
bun run check        # tsgo + oxlint + biome + tests + fixture drift (~0.6s)
bun run ds           # render design-system/web/index.html + spec.json + fixtures
bun run dev          # serve the gallery and rebuild on change (localhost:4173)
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

The gallery renders against a real pi install: `PI_CODING_AGENT_ROOT` if set, otherwise the pi version pinned in `packages/pi-prism` (then `nvm` or a global install if dependencies are missing). Cards show the real thing rather than a drawing, and `ds:check` gives the same answer on every machine. Generated output lives in `design-system/web/` (untracked); the ANSI fixtures in `design-system/fixtures/` are tracked goldens.

## Layout

```
packages/pi-prism/render/   pure renderers + tests
design-system/
  lib/                      pi resolution, theme init, ANSI → HTML
  registry.ts               every card and scenario
  build.ts                  render cells, write gallery, --check drift
  serve.ts / dev.ts         Bun server, watch loop
  fixtures/                 golden ANSI snapshots (tracked)
docs/                       plan, ADRs, RFCs
```
