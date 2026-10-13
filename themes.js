/* themes.js: color themes + the "Select Color Theme" quick pick.
 *
 * Each theme sets the window palette (which doubles as the terminal's ANSI
 * colors) and the syntax roles used by the editor. `gh` is an optional
 * contribution-graph ramp; otherwise one is mixed from the theme's green.
 */
'use strict';
(function () {

const THEMES = [
  { id: 'gruvbox-material', name: 'Gruvbox Material', type: 'dark',
    c: { bg: '#292828', deep: '#242322', hover: '#32302f', sel: '#45403d', line: '#3a3735', fg: '#d4be98', bright: '#ddc7a1', muted: '#928374', dim: '#7c6f64',
      red: '#ea6962', orange: '#e78a4e', yellow: '#d8a657', green: '#a9b665', aqua: '#89b482', blue: '#7daea3', purple: '#d3869b', black: '#32302f' },
    syn: { kw: '#ea6962', str: '#a9b665', var: '#7daea3', num: '#d3869b', com: '#928374', head: '#e78a4e', bold: '#d8a657', mark: '#ea6962', link: '#7daea3', key: '#89b482', con: '#e78a4e' } },

  { id: 'dark-modern', name: 'Dark Modern', type: 'dark',
    c: { bg: '#1f1f1f', deep: '#181818', hover: '#2a2d2e', sel: '#37373d', line: '#2b2b2b', fg: '#cccccc', bright: '#e7e7e7', muted: '#8b8b8b', dim: '#6e7681',
      red: '#f14c4c', orange: '#ce9178', yellow: '#e5e510', green: '#23d18b', aqua: '#29b8db', blue: '#3b8eea', purple: '#d670d6', black: '#2a2a2a' },
    syn: { kw: '#569cd6', str: '#ce9178', var: '#9cdcfe', num: '#b5cea8', com: '#6a9955', head: '#569cd6', bold: '#569cd6', mark: '#6796e6', link: '#4daafc', key: '#9cdcfe', con: '#569cd6' } },

  { id: 'monokai', name: 'Monokai', type: 'dark',
    c: { bg: '#272822', deep: '#1e1f1c', hover: '#3e3d32', sel: '#49483e', line: '#3b3c35', fg: '#f8f8f2', bright: '#ffffff', muted: '#88846f', dim: '#75715e',
      red: '#f92672', orange: '#fd971f', yellow: '#e6db74', green: '#a6e22e', aqua: '#a1efe4', blue: '#66d9ef', purple: '#ae81ff', black: '#333333' },
    syn: { kw: '#f92672', str: '#e6db74', var: '#fd971f', num: '#ae81ff', com: '#88846f', head: '#a6e22e', bold: '#fd971f', mark: '#f92672', link: '#66d9ef', key: '#66d9ef', con: '#ae81ff' } },

  { id: 'tokyo-night', name: 'Tokyo Night', type: 'dark',
    c: { bg: '#1a1b26', deep: '#16161e', hover: '#1f2335', sel: '#283457', line: '#232433', fg: '#a9b1d6', bright: '#c0caf5', muted: '#565f89', dim: '#3b4261',
      red: '#f7768e', orange: '#ff9e64', yellow: '#e0af68', green: '#9ece6a', aqua: '#7dcfff', blue: '#7aa2f7', purple: '#bb9af7', black: '#32344a' },
    syn: { kw: '#bb9af7', str: '#9ece6a', var: '#7dcfff', num: '#ff9e64', com: '#565f89', head: '#7aa2f7', bold: '#e0af68', mark: '#ff9e64', link: '#73daca', key: '#73daca', con: '#ff9e64' } },

  { id: 'one-dark-pro', name: 'One Dark Pro', type: 'dark',
    c: { bg: '#282c34', deep: '#21252b', hover: '#2c313a', sel: '#3e4451', line: '#181a1f', fg: '#abb2bf', bright: '#d7dae0', muted: '#7f848e', dim: '#5c6370',
      red: '#e06c75', orange: '#d19a66', yellow: '#e5c07b', green: '#98c379', aqua: '#56b6c2', blue: '#61afef', purple: '#c678dd', black: '#3f4451' },
    syn: { kw: '#c678dd', str: '#98c379', var: '#e06c75', num: '#d19a66', com: '#7f848e', head: '#e06c75', bold: '#d19a66', mark: '#e06c75', link: '#61afef', key: '#e06c75', con: '#d19a66' } },

  { id: 'dracula', name: 'Dracula', type: 'dark',
    c: { bg: '#282a36', deep: '#21222c', hover: '#343746', sel: '#44475a', line: '#191a21', fg: '#f8f8f2', bright: '#ffffff', muted: '#6272a4', dim: '#545b80',
      red: '#ff5555', orange: '#ffb86c', yellow: '#f1fa8c', green: '#50fa7b', aqua: '#8be9fd', blue: '#bd93f9', purple: '#ff79c6', black: '#21222c' },
    syn: { kw: '#ff79c6', str: '#f1fa8c', var: '#bd93f9', num: '#bd93f9', com: '#6272a4', head: '#bd93f9', bold: '#ffb86c', mark: '#ff79c6', link: '#8be9fd', key: '#8be9fd', con: '#bd93f9' } },

  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', type: 'dark',
    c: { bg: '#1e1e2e', deep: '#181825', hover: '#313244', sel: '#45475a', line: '#11111b', fg: '#cdd6f4', bright: '#f5e0dc', muted: '#9399b2', dim: '#6c7086',
      red: '#f38ba8', orange: '#fab387', yellow: '#f9e2af', green: '#a6e3a1', aqua: '#94e2d5', blue: '#89b4fa', purple: '#f5c2e7', black: '#45475a' },
    syn: { kw: '#cba6f7', str: '#a6e3a1', var: '#f2cdcd', num: '#fab387', com: '#9399b2', head: '#f38ba8', bold: '#f38ba8', mark: '#94e2d5', link: '#89b4fa', key: '#89b4fa', con: '#fab387' } },

  { id: 'nord', name: 'Nord', type: 'dark',
    c: { bg: '#2e3440', deep: '#2b303b', hover: '#3b4252', sel: '#434c5e', line: '#3b4252', fg: '#d8dee9', bright: '#eceff4', muted: '#7b88a1', dim: '#616e88',
      red: '#bf616a', orange: '#d08770', yellow: '#ebcb8b', green: '#a3be8c', aqua: '#8fbcbb', blue: '#81a1c1', purple: '#b48ead', black: '#3b4252' },
    syn: { kw: '#81a1c1', str: '#a3be8c', var: '#88c0d0', num: '#b48ead', com: '#616e88', head: '#88c0d0', bold: '#d08770', mark: '#81a1c1', link: '#88c0d0', key: '#8fbcbb', con: '#81a1c1' } },

  { id: 'github-dark', name: 'GitHub Dark', type: 'dark',
    c: { bg: '#0d1117', deep: '#010409', hover: '#161b22', sel: '#21262d', line: '#30363d', fg: '#e6edf3', bright: '#ffffff', muted: '#848d97', dim: '#6e7681',
      red: '#ff7b72', orange: '#ffa657', yellow: '#d29922', green: '#3fb950', aqua: '#39c5cf', blue: '#58a6ff', purple: '#bc8cff', black: '#484f58' },
    syn: { kw: '#ff7b72', str: '#a5d6ff', var: '#ffa657', num: '#79c0ff', com: '#8b949e', head: '#79c0ff', bold: '#e6edf3', mark: '#ffa657', link: '#a5d6ff', key: '#7ee787', con: '#79c0ff' },
    gh: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'] },

  { id: 'github-light', name: 'GitHub Light', type: 'light',
    c: { bg: '#ffffff', deep: '#f6f8fa', hover: '#eef1f4', sel: '#dde3e9', line: '#d0d7de', fg: '#1f2328', bright: '#1f2328', muted: '#656d76', dim: '#8c959f',
      red: '#cf222e', orange: '#bc4c00', yellow: '#9a6700', green: '#116329', aqua: '#1b7c83', blue: '#0969da', purple: '#8250df', black: '#6e7781' },
    syn: { kw: '#cf222e', str: '#0a3069', var: '#953800', num: '#0550ae', com: '#6e7781', head: '#0550ae', bold: '#24292f', mark: '#953800', link: '#0a3069', key: '#116329', con: '#0550ae' },
    gh: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'] },

  { id: 'solarized-light', name: 'Solarized Light', type: 'light',
    c: { bg: '#fdf6e3', deep: '#eee8d5', hover: '#eee8d5', sel: '#e4ddc8', line: '#ddd6c1', fg: '#657b83', bright: '#586e75', muted: '#93a1a1', dim: '#a8b2b2',
      red: '#dc322f', orange: '#cb4b16', yellow: '#b58900', green: '#859900', aqua: '#2aa198', blue: '#268bd2', purple: '#d33682', black: '#073642' },
    syn: { kw: '#859900', str: '#2aa198', var: '#268bd2', num: '#d33682', com: '#93a1a1', head: '#268bd2', bold: '#cb4b16', mark: '#cb4b16', link: '#268bd2', key: '#268bd2', con: '#b58900' } },
];

const KEY = 'mk.theme';
const DEFAULT = 'gruvbox-material';
let current = DEFAULT;
const listeners = [];

/* mix two #rrggbb colors; t = share of a */
function mix(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
}
function ramp(t) {
  if (t.gh) return t.gh;
  return [mix(t.c.fg, t.c.bg, 0.08), mix(t.c.green, t.c.bg, 0.32), mix(t.c.green, t.c.bg, 0.55), mix(t.c.green, t.c.bg, 0.78), t.c.green];
}
const byId = id => THEMES.find(t => t.id === id);
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function apply(id, { save = true } = {}) {
  const t = byId(id);
  if (!t) return false;
  const s = document.documentElement.style;
  const c = t.c;
  const vars = {
    '--bg': c.bg, '--bg-deep': c.deep, '--bg-hover': c.hover, '--bg-sel': c.sel, '--line': c.line,
    '--fg': c.fg, '--fg-bright': c.bright, '--muted': c.muted, '--dim': c.dim,
    '--red': c.red, '--orange': c.orange, '--yellow': c.yellow, '--green': c.green, '--aqua': c.aqua, '--blue': c.blue, '--purple': c.purple,
    '--ansi-black': c.black,
  };
  for (const [k, v] of Object.entries(t.syn)) vars['--syn-' + k] = v;
  ramp(t).forEach((v, i) => { vars['--gh' + i] = v; });
  for (const [k, v] of Object.entries(vars)) s.setProperty(k, v);
  s.colorScheme = t.type;
  document.documentElement.dataset.theme = t.type;
  if (save) {
    current = id;
    try { localStorage.setItem(KEY, id); } catch (e) {}
  }
  const label = document.getElementById('st-theme-text');
  if (label) label.textContent = byId(save ? id : current).name;
  for (const f of listeners) f(t);
  return true;
}

/* ------------------------------ quick pick ------------------------------ */
const qp = { open: false, items: [], idx: 0, before: null, returnFocus: null };
const $ = id => document.getElementById(id);
const esc = s => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

function renderList() {
  const q = norm($('qp-in').value);
  qp.items = THEMES.filter(t => !q || norm(t.name).includes(q));
  if (qp.idx >= qp.items.length) qp.idx = Math.max(0, qp.items.length - 1);
  let html = '', lastType = null;
  qp.items.forEach((t, i) => {
    const sep = t.type !== lastType;
    lastType = t.type;
    const dots = [t.c.bg, t.syn.kw, t.syn.str, t.syn.var, t.syn.num].map(col => `<i style="background:${col}"></i>`).join('');
    html += `<div class="qp-item${i === qp.idx ? ' act' : ''}${sep && i ? ' sep' : ''}" role="option" id="qp-o${i}" aria-selected="${i === qp.idx}" data-i="${i}">
      <span class="qp-dots">${dots}</span><span class="qp-name">${esc(t.name)}</span>${t.id === qp.before ? '<span class="qp-cur">current</span>' : ''}${sep ? `<span class="qp-grp">${t.type} themes</span>` : ''}</div>`;
  });
  if (!qp.items.length) html = '<div class="qp-empty">No matching themes</div>';
  $('qp-list').innerHTML = html;
  $('qp-in').setAttribute('aria-activedescendant', qp.items.length ? 'qp-o' + qp.idx : '');
  const a = $('qp-list').querySelector('.act');
  if (a) a.scrollIntoView({ block: 'nearest' });
}
function preview() { const t = qp.items[qp.idx]; if (t) apply(t.id, { save: false }); }
function openPick() {
  if (qp.open) return;
  qp.open = true; qp.before = current; qp.returnFocus = document.activeElement;
  $('qp').hidden = false;
  $('qp-in').value = '';
  qp.idx = Math.max(0, THEMES.findIndex(t => t.id === current));
  renderList();
  $('qp-in').focus();
}
function closePick(accept) {
  if (!qp.open) return;
  qp.open = false;
  $('qp').hidden = true;
  const t = qp.items[qp.idx];
  if (accept && t) apply(t.id); else apply(qp.before);
  if (qp.returnFocus && qp.returnFocus.focus) qp.returnFocus.focus({ preventScroll: true });
}

$('qp-in').addEventListener('input', () => { qp.idx = 0; renderList(); preview(); });
$('qp-in').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!qp.items.length) return;
    qp.idx = (qp.idx + (e.key === 'ArrowDown' ? 1 : -1) + qp.items.length) % qp.items.length;
    renderList(); preview();
  } else if (e.key === 'Enter') { e.preventDefault(); closePick(true); }
  else if (e.key === 'Escape') { e.preventDefault(); closePick(false); }
  else if (e.key === 'Tab') e.preventDefault();
});
$('qp-list').addEventListener('mousemove', e => {
  const it = e.target.closest('.qp-item');
  if (it && +it.dataset.i !== qp.idx) { qp.idx = +it.dataset.i; renderList(); preview(); }
});
$('qp-list').addEventListener('mousedown', e => e.preventDefault());
$('qp-list').addEventListener('click', e => {
  const it = e.target.closest('.qp-item');
  if (it) { qp.idx = +it.dataset.i; closePick(true); }
});
$('qp').addEventListener('mousedown', e => { if (e.target === $('qp')) closePick(false); });

/* ------------------------------- boot ------------------------------- */
let saved = null;
try { saved = localStorage.getItem(KEY); } catch (e) {}
apply(byId(saved) ? saved : DEFAULT);

window.Themes = {
  list: () => THEMES.map(t => ({ id: t.id, name: t.name, type: t.type })),
  current: () => byId(current),
  /* fuzzy set: "tokyo", "Tokyo Night", "tokyo-night" all work */
  set(q) {
    const n = norm(q);
    const t = THEMES.find(x => norm(x.id) === n || norm(x.name) === n) || THEMES.find(x => norm(x.name).startsWith(n)) || THEMES.find(x => norm(x.name).includes(n));
    if (!t || !n) return null;
    apply(t.id);
    return t;
  },
  pick: openPick,
  ramp: () => ramp(byId(current)),
  onChange: f => listeners.push(f),
};
})();
