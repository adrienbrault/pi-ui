/** The generated gallery page. Static HTML, no runtime dependencies. */

export interface PagePayload {
  meta: {
    piVersion: string;
    tuiVersion: string;
    source: string;
    generatedAt: string;
    widths: number[];
    glyphs: string[];
    themes: string[];
    bodyLines: Record<string, number>;
  };
  themes: Record<string, { pageBg: string; cardBg: string; palette: Record<string, string> }>;
  entries: Array<{
    id: string;
    title: string;
    group: string;
    variant: string;
    description: string;
    states: Array<{ id: string; label: string; note?: string; frames: number }>;
    data: Record<string, Record<string, string[]>>;
  }>;
}

const CSS = `
:root {
  --bg: #121016;
  --panel: #17141d;
  --term: #0c0a11;
  --fg: #ded9e4;
  --muted: #9a93a8;
  --accent: #b184d6;
  --border: #2c2736;
  --error: #d58a72;
  --ok: #6fbf9a;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); }

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  gap: 14px 22px;
  align-items: center;
  padding: 12px 20px;
  background: var(--bg);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; flex-direction: column; gap: 2px; margin-right: auto; }
.brand h1 { margin: 0; font-size: 14px; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; }
.brand .sub { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.controls { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
.control { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.control select, .control input[type="text"] {
  background: var(--panel); color: var(--fg); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 8px; font-family: var(--mono); font-size: 11px;
}
button {
  background: var(--panel); color: var(--fg); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 10px; font-family: var(--mono); font-size: 11px; cursor: pointer;
}
button:hover { border-color: var(--muted); }
button.on { border-color: var(--accent); color: var(--accent); }

.layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; padding: 22px 20px 80px; }
nav.side { position: sticky; top: 70px; align-self: start; display: flex; flex-direction: column; gap: 14px; }
nav.side .group { display: flex; flex-direction: column; gap: 3px; }
nav.side .group h2 { margin: 0 0 2px; font-family: var(--mono); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
nav.side a { font-size: 12.5px; color: var(--fg); opacity: .85; }
nav.side a:hover { opacity: 1; }

main { display: flex; flex-direction: column; gap: 26px; min-width: 0; }

.intro { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 18px 20px; }
.intro h2 { margin: 0 0 6px; font-size: 15px; }
.intro p { margin: 0 0 12px; color: var(--muted); max-width: 78ch; }
.ladder { display: flex; flex-wrap: wrap; gap: 8px; font-family: var(--mono); font-size: 11px; }
.ladder span { border: 1px solid var(--border); border-radius: 999px; padding: 3px 9px; color: var(--muted); }
.ladder b { color: var(--fg); font-weight: 600; }
.variants { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.variants span { border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-family: var(--mono); font-size: 11px; }
.variants .ready { border-color: var(--ok); color: var(--ok); }
.variants .pending { color: var(--muted); opacity: .75; }

section.group { display: flex; flex-direction: column; gap: 14px; }
section.group > h2 { margin: 8px 0 0; font-family: var(--mono); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }

.card { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px 16px 12px; }
.card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; margin-bottom: 4px; }
.card-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.badge { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; color: var(--muted); }
.badge.ours { border-color: var(--accent); color: var(--accent); }
.badge.base { border-color: var(--muted); }
.card p.desc { margin: 0 0 10px; color: var(--muted); font-size: 12.5px; max-width: 90ch; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; align-items: center; }
.chips .range { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.chips input[type="range"] { width: 160px; accent-color: var(--accent); }

.term {
  background: var(--term);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.5;
  min-height: 3.2em;
}
.term .ansi-line { display: block; white-space: pre; min-height: 1.5em; }
.term:empty::after { content: "(no rows)"; color: var(--muted); }

.card-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; }
.card-foot .note { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.card-foot .frame { font-family: var(--mono); font-size: 11px; color: var(--muted); }

.empty-note { border: 1px dashed var(--border); border-radius: 10px; padding: 14px 16px; color: var(--muted); font-size: 12.5px; }

@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; }
  nav.side { position: static; flex-direction: row; flex-wrap: wrap; }
  nav.side .group { flex-direction: row; flex-wrap: wrap; align-items: center; }
  nav.side .group h2 { margin-right: 8px; }
}
@media (prefers-reduced-motion: reduce) {
  .term { scroll-behavior: auto; }
}
`;

const JS = `
var DS = JSON.parse(document.getElementById('ds-data').textContent);
var state = { width: 80, theme: 'dark', glyph: 'unicode', motion: true };
var active = {};
var frameIdx = {};
var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduce) state.motion = false;

function key() { return state.width + '/' + state.theme + '/' + state.glyph; }
function byId(id) {
  for (var i = 0; i < DS.entries.length; i++) if (DS.entries[i].id === id) return DS.entries[i];
  return null;
}
function stateOf(entry, id) {
  for (var i = 0; i < entry.states.length; i++) if (entry.states[i].id === id) return entry.states[i];
  return entry.states[0];
}
function framesFor(entry, stateId) {
  var cell = (entry.data[stateId] || {})[key()];
  return cell || [''];
}

function applyTheme() {
  var t = DS.themes[state.theme];
  if (!t) return;
  var root = document.documentElement;
  root.style.setProperty('--bg', t.pageBg);
  root.style.setProperty('--panel', t.cardBg);
  root.style.setProperty('--term', t.palette.toolPendingBg || t.cardBg);
  root.style.setProperty('--fg', t.palette.text || '#ded9e4');
  root.style.setProperty('--muted', t.palette.muted || '#9a93a8');
  root.style.setProperty('--accent', t.palette.accent || '#b184d6');
  root.style.setProperty('--border', t.palette.border || '#2c2736');
  root.style.setProperty('--error', t.palette.error || '#d58a72');
  root.style.setProperty('--ok', t.palette.success || '#6fbf9a');
}

function paintCard(card) {
  var entry = byId(card.getAttribute('data-entry'));
  if (!entry) return;
  var stateId = active[entry.id] || entry.states[0].id;
  var def = stateOf(entry, stateId);
  var frames = framesFor(entry, stateId);
  var idx = (frameIdx[entry.id] || 0) % frames.length;
  var term = card.querySelector('[data-term]');
  if (term) term.innerHTML = frames[idx] || '';
  var note = card.querySelector('[data-note]');
  if (note) note.textContent = def.note || '';
  var frame = card.querySelector('[data-frame]');
  if (frame) frame.textContent = frames.length > 1 ? 'frame ' + (idx + 1) + '/' + frames.length : '';
}

function paintChips(card) {
  var entry = byId(card.getAttribute('data-entry'));
  var stateId = active[entry.id] || entry.states[0].id;
  card.querySelectorAll('[data-state]').forEach(function (btn) {
    var on = btn.getAttribute('data-state') === stateId;
    btn.className = on ? 'on' : '';
  });
}

function paintAll() {
  document.querySelectorAll('[data-card]').forEach(function (card) {
    paintChips(card);
    paintCard(card);
  });
  var w = document.getElementById('width');
  if (w) w.value = String(state.width);
  var g = document.getElementById('glyph');
  if (g) g.value = state.glyph;
  var b = document.getElementById('theme-btn');
  if (b) b.textContent = 'theme: ' + state.theme;
  var m = document.getElementById('motion-btn');
  if (m) m.textContent = state.motion ? 'motion: on' : 'motion: paused';
  var meta = document.getElementById('meta');
  if (meta) meta.textContent = 'pi ' + DS.meta.piVersion + ' (' + DS.meta.source + ') · ' + DS.entries.length + ' entries · generated ' + DS.meta.generatedAt.slice(0, 16).replace('T', ' ');
}

function tick() {
  if (!state.motion) return;
  var changed = false;
  document.querySelectorAll('[data-card]').forEach(function (card) {
    if (card.offsetParent === null) return;
    var entry = byId(card.getAttribute('data-entry'));
    if (!entry) return;
    var stateId = active[entry.id] || entry.states[0].id;
    var frames = framesFor(entry, stateId);
    if (frames.length <= 1) return;
    frameIdx[entry.id] = (frameIdx[entry.id] || 0) + 1;
    paintCard(card);
    changed = true;
  });
  if (!changed) return;
}

function bind() {
  var width = document.getElementById('width');
  if (width) width.addEventListener('change', function (e) { state.width = Number(e.target.value); paintAll(); });
  var glyph = document.getElementById('glyph');
  if (glyph) glyph.addEventListener('change', function (e) { state.glyph = e.target.value; paintAll(); });
  var themeBtn = document.getElementById('theme-btn');
  if (themeBtn) themeBtn.addEventListener('click', function () { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); paintAll(); });
  var motionBtn = document.getElementById('motion-btn');
  if (motionBtn) motionBtn.addEventListener('click', function () { state.motion = !state.motion; paintAll(); });
  var search = document.getElementById('search');
  if (search) search.addEventListener('input', function (e) {
    var q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('[data-card]').forEach(function (card) {
      var entry = byId(card.getAttribute('data-entry'));
      var hay = (entry.title + ' ' + entry.description + ' ' + entry.variant + ' ' + entry.group).toLowerCase();
      card.style.display = !q || hay.indexOf(q) !== -1 ? '' : 'none';
    });
  });
  document.querySelectorAll('[data-state]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var card = btn.closest('[data-card]');
      var entry = byId(card.getAttribute('data-entry'));
      active[entry.id] = btn.getAttribute('data-state');
      frameIdx[entry.id] = 0;
      paintChips(card);
      paintCard(card);
    });
  });
  document.querySelectorAll('[data-range]').forEach(function (input) {
    input.addEventListener('input', function () {
      var card = input.closest('[data-card]');
      var entry = byId(card.getAttribute('data-entry'));
      var index = Number(input.value);
      active[entry.id] = entry.states[index].id;
      frameIdx[entry.id] = 0;
      var label = card.querySelector('[data-range-label]');
      if (label) label.textContent = entry.states[index].label;
      paintChips(card);
      paintCard(card);
    });
  });
}

applyTheme();
bind();
paintAll();
setInterval(tick, 140);
`;

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const GROUP_LABEL: Record<string, string> = {
  transcript: "Transcript",
  tools: "Tool rows",
  thinking: "Thinking",
  groups: "Groups",
  scenarios: "Scenarios",
};

const VARIANT_STATUS: Record<string, "ready" | "pending"> = {
  base: "ready",
  ours: "ready",
  "open-tui": "pending",
  "pi-code": "pending",
};

function ladder(bodyLines: Record<string, number>): string {
  const levels: Array<[string, string]> = [
    ["L0", "live"],
    ["L1", ""],
    ["L2", ""],
    ["L3", "one line"],
    ["L4", "group summary"],
  ];
  return levels
    .map(([level, note], index) => {
      const rows = bodyLines[String(index)] ?? 0;
      const label = note ? `${level} <b>${note}</b>` : `${level} <b>${1 + rows} rows</b>`;
      return `<span>${label}</span>`;
    })
    .join("");
}

export function renderPage(payload: PagePayload): string {
  const groups = [...new Set(payload.entries.map((entry) => entry.group))];
  const counts = new Map<string, number>();
  for (const entry of payload.entries) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);

  const nav = groups
    .map((group) => {
      const items = payload.entries
        .filter((entry) => entry.group === group)
        .map((entry) => `<a href="#${esc(entry.id)}">${esc(entry.title)}</a>`)
        .join("");
      return `<div class="group"><h2>${esc(GROUP_LABEL[group] ?? group)} (${counts.get(group) ?? 0})</h2>${items}</div>`;
    })
    .join("");

  const cards = groups
    .map((group) => {
      const entries = payload.entries
        .filter((entry) => entry.group === group)
        .map((entry) => {
          const useRange = entry.states.length > 6;
          const chips = useRange
            ? `<div class="range"><input type="range" data-range min="0" max="${entry.states.length - 1}" value="0"><span data-range-label>${esc(entry.states[0]?.label ?? "")}</span></div>`
            : entry.states
                .map((state) => `<button data-state="${esc(state.id)}">${esc(state.label)}</button>`)
                .join("");
          const status = VARIANT_STATUS[entry.variant] ?? "ready";
          return `
<section class="card" id="${esc(entry.id)}" data-card data-entry="${esc(entry.id)}">
  <div class="card-head"><h3>${esc(entry.title)}</h3><span class="badge ${esc(entry.variant)}">${esc(entry.variant)}</span><span class="badge">${status}</span></div>
  <p class="desc">${esc(entry.description)}</p>
  <div class="chips">${chips}</div>
  <div class="term" data-term></div>
  <div class="card-foot"><span class="note" data-note></span><span class="frame" data-frame></span></div>
</section>`;
        })
        .join("");
      return `<section class="group"><h2>${esc(GROUP_LABEL[group] ?? group)}</h2>${entries}</section>`;
    })
    .join("");

  const variants = ["base", "open-tui", "pi-code", "ours"]
    .map((variant) => {
      const ready = VARIANT_STATUS[variant] === "ready";
      const count = payload.entries.filter((entry) => entry.variant === variant).length;
      const note =
        variant === "open-tui" || variant === "pi-code" ? "P1 · vendored snapshot pending" : `${count} cards`;
      return `<span class="${ready ? "ready" : "pending"}">${esc(variant)} · ${esc(note)}</span>`;
    })
    .join("");

  const data = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi UI — design system</title>
<style>${CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <h1>pi UI — design system</h1>
    <span class="sub" id="meta"></span>
  </div>
  <div class="controls">
    <label class="control">width <select id="width">${payload.meta.widths.map((width) => `<option value="${width}"${width === 80 ? " selected" : ""}>${width}</option>`).join("")}</select></label>
    <label class="control">glyphs <select id="glyph">${payload.meta.glyphs.map((glyph) => `<option value="${esc(glyph)}"${glyph === "unicode" ? " selected" : ""}>${esc(glyph)}</option>`).join("")}</select></label>
    <label class="control"><input type="text" id="search" placeholder="filter cards" size="16"></label>
    <button id="theme-btn">theme: dark</button>
    <button id="motion-btn">motion: on</button>
  </div>
</header>
<div class="layout">
  <nav class="side">${nav}</nav>
  <main>
    <div class="intro">
      <h2>The rule</h2>
      <p>Every card is real output: base pi components from the install recorded below, ours from the renderers the extension ships. If a card looks wrong, the product looks wrong. Switch width, theme and glyph set to check the edges.</p>
      <div class="ladder">${ladder(payload.meta.bodyLines)}</div>
      <div class="variants">${variants}</div>
    </div>
    ${cards}
    <div class="empty-note">pi-open-tui and pi-code cards arrive in P1 from vendored, version-pinned snapshots. Until then this page shows base pi and ours side by side, so the comparison is honest rather than imagined.</div>
  </main>
</div>
<script id="ds-data" type="application/json">${data}</script>
<script>${JS}</script>
</body>
</html>`;
}
