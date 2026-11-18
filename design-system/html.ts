/** The generated gallery page. Static HTML, no runtime dependencies. */

/** Frames are HTML strings, or a row pool shared by many frames. */
export type CellData = string[] | { rows: string[]; frames: number[][] };

/** A revealed group: header rows, plus members in collapsed/preview/full states. */
export interface RevealCellHtml {
  header: string;
  members: Array<{ collapsed: string; preview: string; expanded: string }>;
}

/** Reveal arrangements repeat across frames; frames index into a pool. */
export interface RevealStoreHtml {
  pool: RevealCellHtml[][];
  frames: number[];
}

/** Blocks outside a group: the collapsed span and the body that replaces it. */
export interface BlockCellHtml {
  pool: Record<string, string>;
  frames: Array<Array<{ row: number; count: number; id: string; keys: string[] }>>;
}

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
    data: Record<string, Record<string, CellData>>;
    reveal?: Record<string, Record<string, RevealStoreHtml>>;
    blocks?: Record<string, Record<string, BlockCellHtml>>;
    sync?: string;
    stage?: string;
    frameLabels?: string[];
    frameCosts?: number[];
    fixedWidth?: number;
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
/* Hover hint: the chip says what a click will do, at the row it applies to. */
.term [data-hint] { position: relative; }
/* The header's text lights up; the chip is the action, the tint is the target. */
.term .ansi-line.hot .lamp {
  background-image: linear-gradient(color-mix(in srgb, var(--accent) 16%, transparent), color-mix(in srgb, var(--accent) 16%, transparent));
}
/* Pinned to the block's header row: brackets and a background colour, no chrome. */
.term [data-hint].hot::after {
  content: "[ " attr(data-hint) " ]";
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 4;
  pointer-events: none;
  background: var(--accent);
  color: var(--bg);
  font: inherit;
  white-space: nowrap;
}
.term:empty::after { content: "(no rows)"; color: var(--muted); }

.card-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; }
.card-foot .note { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.card-foot .frame { font-family: var(--mono); font-size: 11px; color: var(--muted); }


.stage { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px; margin-bottom: 18px; }
.stage-head { display: flex; flex-wrap: wrap; gap: 4px 18px; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
.stage-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.stage-head p.desc { margin: 0; color: var(--muted); font-size: 12.5px; flex: 1 1 420px; }
.stage-controls { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.stage-controls input[type="range"] { width: 220px; accent-color: var(--accent); }
.stage-controls .step { min-width: 24ch; }
.stage-controls .rows { min-width: 16ch; margin-left: auto; }
.stage-lanes { display: grid; grid-template-columns: 1fr; gap: 14px; align-items: start; }
.stage-lanes .card { padding: 10px 12px 8px; }
.stage-lanes .chips, .stage-lanes p.desc, .stage-lanes .card-foot { display: none; }
.term .reveal-members .ansi-line { padding-left: 2ch; }
/* Pinned headings: the group stays at the top, its member just below, and a
   nested block below that. Each pins inside its own box, so it lets go once its
   body has scrolled past. Opaque, because rows scroll underneath. */
.term .gblock > [data-collapse],
.term > .block > [data-block] {
  position: sticky; top: 0; z-index: 3; background: var(--term);
}
.term .reveal-members > .member > [data-turn] {
  position: sticky; top: 1.5em; z-index: 2; background: var(--term);
}
.term .reveal-members > .member > .block > [data-block] {
  position: sticky; top: 3em; z-index: 1; background: var(--term);
}
.term .reveal-members .ansi-line:hover { background: rgba(255, 255, 255, 0.03); }
.term [data-expand], .term [data-turn], .term [data-collapse], .term [data-block] { cursor: pointer; }

.stage-lanes .term { font-size: 10.5px; line-height: 1.5; padding: 8px 10px; height: 560px; overflow-y: auto; }

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
var state = { width: 80, theme: 'dark', glyph: 'unicode', motion: true, lane: 'ours', query: '', tail: 7 };
var active = {};
var frameIdx = {};
var syncIdx = {};
var playback = {};
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
function frameKey(entry) { return (entry.fixedWidth || state.width) + '/' + state.theme + '/' + state.glyph; }
function decodeCell(cell) {
  if (!cell) return null;
  if (Array.isArray(cell)) return cell;
  if (cell.frames && cell.rows) {
    if (!cell.decoded) {
      cell.decoded = cell.frames.map(function (idx) {
        return idx.map(function (i) { return cell.rows[i]; }).join('');
      });
    }
    return cell.decoded;
  }
  return null;
}
function framesFor(entry, stateId) {
  return decodeCell((entry.data[stateId] || {})[frameKey(entry)]) || [''];
}
var revealCache = {};
function revealFor(entry, stateId) {
  var cell = ((entry.reveal || {})[stateId] || {})[frameKey(entry)];
  if (!cell) return [];
  var key = entry.id + ':' + stateId + ':' + frameKey(entry);
  var hit = revealCache[key];
  if (hit && hit.cell === cell) return hit.frames;
  var frames = cell.frames.map(function (at) { return cell.pool[at] || []; });
  revealCache[key] = { cell: cell, frames: frames };
  return frames;
}
function blocksFor(entry, stateId) {
  return ((entry.blocks || {})[stateId] || {})[frameKey(entry)] || null;
}
function frameIndex(entry) {
  if (entry.sync) return syncIdx[entry.sync] || 0;
  return frameIdx[entry.id] || 0;
}
function paintStage(sync) {
  document.querySelectorAll('[data-stage]').forEach(function (stage) {
    if (stage.getAttribute('data-sync') !== sync) return;
    // One replay, one lane on screen: the toggle picks which renderer you see.
    stage.querySelectorAll('[data-card]').forEach(function (card) {
      var lane = byId(card.getAttribute('data-entry'));
      card.style.display = lane && lane.variant === state.lane ? '' : 'none';
      paintCard(card);
    });
    var card = stage.querySelector('[data-card]');
    if (!card) return;
    var entry = byId(card.getAttribute('data-entry'));
    if (!entry) return;
    var frames = framesFor(entry, entry.states[0].id).length;
    var idx = Math.min(syncIdx[sync] || 0, frames - 1);
    var step = stage.querySelector('[data-step]');
    if (step) step.textContent = 'frame ' + (idx + 1) + '/' + frames + ' · ' + ((entry.frameLabels || [])[idx] || '');
    var scrub = stage.querySelector('[data-scrub]');
    if (scrub) scrub.value = String(idx);
    var play = stage.querySelector('[data-play]');
    var st = playback[sync];
    if (play) play.textContent = st && st.playing ? '⏸ pause' : idx >= frames - 1 ? '↻ replay' : '▶ play';
    // Row accounting stays visible even when a lane is hidden: that is the diff.
    var lanes = stage.querySelectorAll('[data-term]');
    var counts = [];
    lanes.forEach(function (term) {
      var rows = term.querySelectorAll('.ansi-line').length;
      // A hidden lane is not repainted; count its frame instead of its empty DOM.
      if (!rows) {
        var card = term.closest('[data-card]');
        var lane = card ? byId(card.getAttribute('data-entry')) : null;
        if (lane) {
          var laneFrames = framesFor(lane, lane.states[0].id);
          var at = frameIndex(lane) % laneFrames.length;
          rows = (laneFrames[at].match(/class="ansi-line"/g) || []).length;
        }
      }
      counts.push(rows);
    });
    var rows = stage.querySelector('[data-rows]');
    if (rows) rows.textContent = 'base ' + counts[0] + ' · ours ' + counts[1] + ' rows';
    // A live transcript follows the tail; a scrubbed one stays where it was put.
    if (st && st.playing) {
      stage.querySelectorAll('[data-term]').forEach(function (term) { term.scrollTop = term.scrollHeight; });
    }
  });
}

var tailDirty = false;
var revealOpenState = {};
var groupOpenState = {};
var blockOpenState = {};

// Members cycle: header only, then a taste with a "show all" cue, then the body.
// Each member owns a box: its heading pins while its own body is in view, and
// lets go as the next member arrives. Groups nest the same way one level up.
function groupHtml(prefix, group, gi) {
  var body = '';
  group.members.forEach(function (member, mi) {
    var st = revealOpenState[prefix + ':' + gi + ':' + mi] || 0;
    body += '<div class="member">' + (st === 2 ? member.expanded : st === 1 ? member.preview : member.collapsed) + '</div>';
  });
  return '<div class="gblock">' + group.header + '<div class="reveal-members">' + body + '</div></div>';
}

// Compose in place: rows keep their position, only the rows a click owns are
// swapped. Replacements run back to front so earlier indices stay valid.
function composeFrame(entry, idx, frameHtml, stateId) {
  var prefix = entry.id + ':' + idx;
  var rows = frameHtml.split(/(?=<div class="ansi-line")/);
  var ops = [];
  var groups = revealFor(entry, stateId)[idx] || [];
  rows.forEach(function (row, index) {
    var match = row.match(/data-expand="(\\d+)"/);
    if (!match) return;
    var gi = Number(match[1]);
    if (!groupOpenState[prefix + ':' + gi]) return;
    var group = groups[gi];
    if (group) ops.push({ from: index, count: 1, html: groupHtml(prefix, group, gi) });
  });
  var blocks = blocksFor(entry, stateId);
  if (blocks) {
    (blocks.frames[idx] || []).forEach(function (spec) {
      var step = blockOpenState[prefix + ':' + spec.id] || 0;
      if (step > 0) {
        ops.push({ from: spec.row, count: spec.count, html: '<div class="block">' + blocks.pool[spec.keys[step - 1]] + '</div>' });
      }
    });
  }
  ops.sort(function (a, b) { return b.from - a.from; });
  ops.forEach(function (op) { rows.splice(op.from, op.count, op.html); });
  return rows.join('');
}
var tailTimer = 0;
var tailCache = {};

function applyTail(res) {
  var meta = res.meta || {};
  var cellKey = meta.cell;
  res.entries.forEach(function (incoming) {
    var entry = byId(incoming.id);
    if (!entry) return;
    Object.keys(incoming.data).forEach(function (stateId) {
      entry.data[stateId] = entry.data[stateId] || {};
      var cells = incoming.data[stateId];
      Object.keys(cells).forEach(function (key) {
        entry.data[stateId][key] = cells[key];
      });
    });
  });
  if (meta.bodyLines) DS.meta.bodyLines = meta.bodyLines;
  paintAll();
}

function setTailStatus(text) {
  var label = document.getElementById('tail-value');
  if (label) label.title = text;
}

function loadTail(tail) {
  var key = tail + '/' + state.theme + '/' + state.glyph;
  if (tailCache[key]) return applyTail(tailCache[key]);
  var url = '/api/cells?tail=' + tail + '&theme=' + state.theme + '&glyph=' + state.glyph;
  fetch(url)
    .then(function (res) {
      if (!res.ok) throw new Error('status ' + res.status);
      return res.json();
    })
    .then(function (body) {
      tailCache[key] = body;
      applyTail(body);
    })
    .catch(function () {
      setTailStatus('live tail needs bun run dev');
    });
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

// Say what a click does, on the row it applies to: open, preview, show all, fold.
// One inline wrapper: the tint covers the text, never the row's remaining width.
function lamp(row) {
  if (row.querySelector(':scope > .lamp')) return;
  row.innerHTML = '<span class="lamp">' + row.innerHTML + '</span>';
}

function annotateHints(term, entry, idx, stateId) {
  var prefix = entry.id + ':' + idx;
  var rows = [].slice.call(term.querySelectorAll('.ansi-line'));

  term.querySelectorAll('[data-expand]').forEach(function (row) {
    row.setAttribute('data-hint', 'click · open group');
    lamp(row);
  });
  term.querySelectorAll('[data-collapse]').forEach(function (row) {
    row.setAttribute('data-hint', 'click · fold group');
    lamp(row);
  });

  // A member's hint lives on its header; its body points the hover back there.
  var turnGroups = {};
  rows.forEach(function (row) {
    var key = row.getAttribute('data-turn');
    if (!key) return;
    turnGroups[key] = turnGroups[key] || [];
    turnGroups[key].push(row);
  });
  Object.keys(turnGroups).forEach(function (key) {
    var st = revealOpenState[prefix + ':' + key] || 0;
    var hint = st === 0 ? 'click · preview' : st === 1 ? 'click · show all' : 'click · collapse';
    turnGroups[key].forEach(function (row, order) {
      if (order === 0) {
        row.setAttribute('data-hint', hint);
        lamp(row);
      } else row.setAttribute('data-anchor', 'turn:' + key);
    });
  });

  // Blocks: the header owns the chip whether the body is open or closed.
  var cell = blocksFor(entry, stateId);
  (cell ? cell.frames[idx] || [] : []).forEach(function (spec) {
    var owned = [].slice.call(term.querySelectorAll('[data-block="' + spec.id + '"]'));
    var header = owned[0];
    if (!header) return;
    var st = blockOpenState[prefix + ':' + spec.id] || 0;
    header.setAttribute('data-hint', st === 0 ? 'click · expand' : st < spec.keys.length ? 'click · show all' : 'click · collapse');
    lamp(header);
    owned.forEach(function (row) {
      if (row !== header) row.setAttribute('data-anchor', 'block:' + spec.id);
    });
  });
}

function paintCard(card) {
  // Hidden lanes keep their DOM but skip repaint: playback should cost one lane.
  if (card.style.display === 'none') return;
  var entry = byId(card.getAttribute('data-entry'));
  if (!entry) return;
  var stateId = active[entry.id] || entry.states[0].id;
  var def = stateOf(entry, stateId);
  var frames = framesFor(entry, stateId);
  var idx = frameIndex(entry) % frames.length;
  var term = card.querySelector('[data-term]');
  if (term) {
    term.innerHTML = composeFrame(entry, idx, frames[idx] || '', stateId);
    annotateHints(term, entry, idx, stateId);
  }
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

function refreshVisibility() {
  var q = state.query;
  document.querySelectorAll('[data-card]').forEach(function (card) {
    var entry = byId(card.getAttribute('data-entry'));
    if (!entry) return;
    // Stage cards are the two lanes of one replay: their own toggle owns them.
    var laneOk = entry.stage ? true : entry.variant === state.lane;
    var hay = (entry.title + ' ' + entry.description + ' ' + entry.variant + ' ' + entry.group).toLowerCase();
    var searchOk = !q || hay.indexOf(q) !== -1;
    card.style.display = laneOk && searchOk ? '' : 'none';
  });
}

function paintLadder() {
  var el = document.getElementById('ladder');
  if (!el) return;
  var bl = DS.meta.bodyLines || {};
  var rungs = Object.keys(bl).toSorted(function (a, b) { return Number(a) - Number(b); }).map(function (level) {
    return '<span>L' + level + ' <b>' + (1 + bl[level]) + ' rows</b></span>';
  });
  rungs.push('<span>L8+ <b>group summary</b></span>');
  el.innerHTML = rungs.join('');
}

function paintAll() {
  document.querySelectorAll('[data-card]').forEach(function (card) {
    paintChips(card);
    paintCard(card);
  });
  document.querySelectorAll('[data-stage]').forEach(function (stage) {
    paintStage(stage.getAttribute('data-sync'));
  });
  refreshVisibility();
  paintLadder();
  var w = document.getElementById('width');
  if (w) w.value = String(state.width);
  var g = document.getElementById('glyph');
  if (g) g.value = state.glyph;
  var b = document.getElementById('theme-btn');
  if (b) b.textContent = 'theme: ' + state.theme;
  var lane = document.getElementById('lane-btn');
  if (lane) lane.textContent = 'lane: ' + (state.lane === 'base' ? 'bare pi' : 'pi-prism');
  var m = document.getElementById('motion-btn');
  if (m) m.textContent = state.motion ? 'motion: on' : 'motion: paused';
  var meta = document.getElementById('meta');
  if (meta) meta.textContent = 'pi ' + DS.meta.piVersion + ' (' + DS.meta.source + ') · ' + DS.entries.length + ' entries · generated ' + DS.meta.generatedAt.slice(0, 16).replace('T', ' ');
}

function playbackTick(now) {
  Object.keys(playback).forEach(function (sync) {
    var st = playback[sync];
    if (!st.playing) return;
    var stage = document.querySelector('[data-stage][data-sync="' + sync + '"]');
    if (!stage) return;
    var card = stage.querySelector('[data-card]');
    var entry = card ? byId(card.getAttribute('data-entry')) : null;
    if (!entry) return;
    var frames = framesFor(entry, entry.states[0].id).length;
    var idx = syncIdx[sync] || 0;
    if (idx >= frames - 1) { st.playing = false; return; }
    if (!st.last) { st.last = now; return; }
    // Tokens arrive at 100 tok/s; paint whenever enough time has accumulated.
    st.acc = (st.acc || 0) + (now - st.last);
    st.last = now;
    var costs = entry.frameCosts || [];
    var advanced = false;
    while (idx < frames - 1) {
      var cost = (costs[idx] || 10) / (st.rate || 1);
      if (st.acc < cost) break;
      st.acc -= cost;
      idx += 1;
      advanced = true;
    }
    syncIdx[sync] = idx;
    if (idx >= frames - 1) st.playing = false;
    if (advanced) paintStage(sync);
  });
}

var lastMotion = 0;
function tick() {
  var now = Date.now();
  playbackTick(now);
  if (!state.motion) return;
  if (now - lastMotion < 120) return;
  lastMotion = now;
  document.querySelectorAll('[data-card]').forEach(function (card) {
    if (card.offsetParent === null) return;
    var entry = byId(card.getAttribute('data-entry'));
    if (!entry) return;
    // Session lanes ride their own playhead; motion must not double-drive them.
    if (entry.sync) return;
    var stateId = active[entry.id] || entry.states[0].id;
    var frames = framesFor(entry, stateId);
    if (frames.length <= 1) return;
    frameIdx[entry.id] = (frameIdx[entry.id] || 0) + 1;
    paintCard(card);
  });
}

function onTermClick(event) {
  var term = event.currentTarget;
  var card = term.closest('[data-card]');
  var entry = card ? byId(card.getAttribute('data-entry')) : null;
  if (!entry) return;
  var idx = frameIndex(entry);
  var stateId = active[entry.id] || entry.states[0].id;
  var prefix = entry.id + ':' + idx;
  function hold() {
    if (entry.sync && playback[entry.sync]) playback[entry.sync].playing = false;
  }

  var turn = event.target.closest('[data-turn]');
  if (turn) {
    var memberKey = prefix + ':' + turn.getAttribute('data-turn');
    var st = revealOpenState[memberKey] || 0;
    revealOpenState[memberKey] = st === 0 ? 1 : st === 1 ? 2 : 0;
    hold();
    paintCard(card);
    return;
  }
  if (event.target.closest('[data-collapse]')) {
    var folded = event.target.closest('[data-collapse]').getAttribute('data-collapse');
    delete groupOpenState[prefix + ':' + folded];
    paintCard(card);
    return;
  }
  var block = event.target.closest('[data-block]');
  if (block) {
    var id = block.getAttribute('data-block');
    var cell = blocksFor(entry, stateId);
    var spec = cell ? (cell.frames[idx] || []).filter(function (s) { return s.id === id; })[0] : null;
    var steps = spec ? spec.keys.length : 0;
    var blockKey = prefix + ':' + id;
    blockOpenState[blockKey] = ((blockOpenState[blockKey] || 0) + 1) % (steps + 1);
    hold();
    paintCard(card);
    return;
  }
  var row = event.target.closest('[data-expand]');
  if (!row) return;
  var groups = revealFor(entry, stateId)[idx] || [];
  if (!groups.length) return;
  hold();
  groupOpenState[prefix + ':' + row.getAttribute('data-expand')] = true;
  paintCard(card);
}

function bind() {
  var width = document.getElementById('width');
  if (width) width.addEventListener('change', function (e) { state.width = Number(e.target.value); paintAll(); });
  var glyph = document.getElementById('glyph');
  if (glyph) glyph.addEventListener('change', function (e) {
    state.glyph = e.target.value;
    paintAll();
    if (tailDirty) loadTail(state.tail);
  });
  var themeBtn = document.getElementById('theme-btn');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    paintAll();
    if (tailDirty) loadTail(state.tail);
  });
  var motionBtn = document.getElementById('motion-btn');
  if (motionBtn) motionBtn.addEventListener('click', function () { state.motion = !state.motion; paintAll(); });
  var search = document.getElementById('search');
  if (search) search.addEventListener('input', function (e) {
    state.query = e.target.value.trim().toLowerCase();
    refreshVisibility();
  });
  var tail = document.getElementById('tail');
  if (tail) state.tail = Number(tail.value) || 7;
  if (tail) tail.addEventListener('input', function (e) {
    state.tail = Number(e.target.value);
    tailDirty = true;
    var label = document.getElementById('tail-value');
    if (label) label.textContent = String(state.tail);
    clearTimeout(tailTimer);
    tailTimer = setTimeout(function () { loadTail(state.tail); }, 80);
  });
  var laneBtn = document.getElementById('lane-btn');
  if (laneBtn) laneBtn.addEventListener('click', function () {
    state.lane = state.lane === 'base' ? 'ours' : 'base';
    paintAll();
  });
  document.querySelectorAll('[data-term]').forEach(function (term) {
    term.addEventListener('click', onTermClick);
    // Hover is explicit: any interaction hint belongs to the row under the cursor.
    term.addEventListener('mouseover', function (event) {
      var row = event.target.closest('[data-hint]');
      if (!row) {
        // Hovering a block's details still lights its header: one chip per block.
        var anchor = event.target.closest('[data-anchor]');
        if (anchor) {
          var key = anchor.getAttribute('data-anchor');
          var id = key.slice(key.indexOf(':') + 1);
          row = key.indexOf('turn:') === 0 ? term.querySelector('[data-turn="' + id + '"]') : term.querySelector('[data-block="' + id + '"]');
        }
      }
      term.querySelectorAll('.ansi-line.hot').forEach(function (old) { old.classList.remove('hot'); });
      if (row) row.classList.add('hot');
    });
    term.addEventListener('mouseleave', function () {
      term.querySelectorAll('.ansi-line.hot').forEach(function (old) { old.classList.remove('hot'); });
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

  document.querySelectorAll('[data-stage]').forEach(function (stage) {
    var sync = stage.getAttribute('data-sync');
    playback[sync] = { playing: false, rate: 1, acc: 0, last: 0, played: false };
    var play = stage.querySelector('[data-play]');
    if (play) play.addEventListener('click', function () {
      var st = playback[sync];
      var card = stage.querySelector('[data-card]');
      var entry = byId(card.getAttribute('data-entry'));
      var frames = framesFor(entry, entry.states[0].id).length;
      if ((syncIdx[sync] || 0) >= frames - 1) syncIdx[sync] = 0;
      st.playing = !st.playing;
      st.last = 0;
      st.acc = 0;
      paintStage(sync);
    });
    var reset = stage.querySelector('[data-reset]');
    if (reset) reset.addEventListener('click', function () {
      syncIdx[sync] = 0;
      playback[sync].playing = false;
      paintStage(sync);
    });
    var speed = stage.querySelector('[data-speed]');
    if (speed) speed.addEventListener('click', function () {
      var st = playback[sync];
      st.rate = st.rate === 1 ? 2 : 1;
      speed.textContent = st.rate * 100 + ' tok/s';
      st.last = 0;
    });
    var scrub = stage.querySelector('[data-scrub]');
    if (scrub) scrub.addEventListener('input', function () {
      syncIdx[sync] = Number(scrub.value);
      playback[sync].playing = false;
      paintStage(sync);
    });
    // Play once when the stage is actually on screen; reduced motion stays still.
    if (!reduce && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (records) {
        if (!records.some(function (record) { return record.isIntersecting; })) return;
        var st = playback[sync];
        if (st.played) return;
        st.played = true;
        st.playing = true;
        st.last = 0;
        st.acc = 0;
        paintStage(sync);
        io.disconnect();
      }, { threshold: 0.3 });
      io.observe(stage);
    }
  });
}

applyTheme();
bind();
paintAll();
setInterval(tick, 8);
`;

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const GROUP_LABEL: Record<string, string> = {
  session: "Session",
  transcript: "Transcript",
  tools: "Tool rows",
  thinking: "Thinking",
  groups: "Groups",
  glyphs: "Glyph lab",
  scenarios: "Scenarios",
};

const VARIANT_STATUS: Record<string, "ready" | "pending"> = {
  base: "ready",
  ours: "ready",
  "open-tui": "pending",
  "pi-code": "pending",
};

function ladder(bodyLines: Record<string, number>): string {
  const rungs = Object.keys(bodyLines)
    .toSorted((a, b) => Number(a) - Number(b))
    .map((level) => `<span>L${level} <b>${1 + (bodyLines[level] ?? 0)} rows</b></span>`);
  rungs.push("<span>L8+ <b>group summary</b></span>");
  return rungs.join("");
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

  const cardMarkup = (entry: (typeof payload.entries)[number]): string => {
    const useRange = entry.states.length > 6;
    const chips = useRange
      ? `<div class="range"><input type="range" data-range min="0" max="${entry.states.length - 1}" value="0"><span data-range-label>${esc(entry.states[0]?.label ?? "")}</span></div>`
      : entry.states.map((state) => `<button data-state="${esc(state.id)}">${esc(state.label)}</button>`).join("");
    const status = VARIANT_STATUS[entry.variant] ?? "ready";
    return `
<section class="card" id="${esc(entry.id)}" data-card data-entry="${esc(entry.id)}">
  <div class="card-head"><h3>${esc(entry.title)}</h3><span class="badge ${esc(entry.variant)}">${esc(entry.variant)}</span><span class="badge">${status}</span></div>
  <p class="desc">${esc(entry.description)}</p>
  <div class="chips">${chips}</div>
  <div class="term" data-term></div>
  <div class="card-foot"><span class="note" data-note></span><span class="frame" data-frame></span></div>
</section>`;
  };

  const stageMarkup = (stage: string, lanes: string[]): string => {
    const first = payload.entries.find((entry) => entry.stage === stage);
    const frames = first?.states[0]?.frames ?? 1;
    const labels = first?.frameLabels ?? [];
    return `
<div class="stage" id="stage-${esc(stage)}" data-stage="${esc(stage)}" data-sync="${esc(first?.sync ?? stage)}">
  <div class="stage-head">
    <h3>Session replay</h3>
    <p class="desc">One script, ${frames} frames, one playhead: prefill lands at 4000 tok/s, thinking streams at 100 tok/s, and slow tools visibly wait before output. Toggle the lane above to swap renderers without losing your place.</p>
    <div class="stage-controls">
      <button data-play>▶ play</button>
      <button data-reset>↻ reset</button>
      <button data-speed>100 tok/s</button>
      <input type="range" data-scrub min="0" max="${frames - 1}" value="0">
      <span class="step" data-step>frame 1/${frames} · ${esc(labels[0] ?? "")}</span>
      <span class="rows" data-rows>base · ours rows</span>
    </div>
  </div>
  <div class="stage-lanes">${lanes.join("")}</div>
</div>`;
  };

  const cards = groups
    .map((group) => {
      const groupEntries = payload.entries.filter((entry) => entry.group === group);
      const merged: string[] = [];
      let openStage: string | undefined;
      let stageCards: string[] = [];
      const flushStage = () => {
        if (openStage === undefined) return;
        merged.push(stageMarkup(openStage, stageCards));
        openStage = undefined;
        stageCards = [];
      };
      for (const entry of groupEntries) {
        if (entry.stage) {
          if (openStage !== entry.stage) {
            flushStage();
            openStage = entry.stage;
          }
          stageCards.push(cardMarkup(entry));
          continue;
        }
        flushStage();
        merged.push(cardMarkup(entry));
      }
      flushStage();

      return `<section class="group"><h2>${esc(GROUP_LABEL[group] ?? group)}</h2>${merged.join("")}</section>`;
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
    <label class="control">tail <input type="range" id="tail" min="3" max="12" step="1" value="${payload.meta.bodyLines["0"]}"><b id="tail-value">${payload.meta.bodyLines["0"]}</b></label>
    <label class="control"><input type="text" id="search" placeholder="filter cards" size="16"></label>
    <button id="lane-btn">lane: pi-prism</button>
    <button id="theme-btn">theme: dark</button>
  </div>
</header>
<div class="layout">
  <nav class="side">${nav}</nav>
  <main>
    <div class="intro">
      <h2>The rule</h2>
      <p>Every card is real output: base pi components from the install recorded below, ours from the renderers the extension ships. If a card looks wrong, the product looks wrong. Switch width, theme and glyph set to check the edges.</p>
      <div class="ladder" id="ladder">${ladder(payload.meta.bodyLines)}</div>
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
