/* app.js: the VS Code-style window around the shell (terminal, explorer, editor, GitHub graph). */
'use strict';
(function () {
const { Shell, buildFS, parse, Incomplete, ExitSig, Interrupt, HOME } = window.Bash;
const $ = id => document.getElementById(id);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const GH_USER = 'mattkoco';

/* ================================================================ */
/* ANSI -> DOM                                                      */
/* ================================================================ */
const ANSI = ['--ansi-black', '--red', '--green', '--yellow', '--blue', '--purple', '--aqua', '--fg'];
const ansiVar = k => `var(${k < 8 ? ANSI[k] : k === 8 ? '--muted' : ANSI[k - 8]})`;
const URL_RE = /(https?:\/\/[^\s)'"<>]+)/g;

function renderAnsi(text, st) {
  const frag = document.createDocumentFragment();
  const re = /\x1b\[([0-9;]*)([A-Za-z])/g;
  let last = 0, m;
  const emit = s => {
    s = s.replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!s) return;
    const styled = st.fg || st.bg || st.b || st.i || st.u;
    const parent = styled ? document.createElement('span') : frag;
    if (styled) {
      if (st.fg) parent.style.color = st.fg;
      if (st.bg) parent.style.background = st.bg;
      if (st.b) parent.classList.add('a-b');
      if (st.i) parent.classList.add('a-i');
      if (st.u) parent.classList.add('a-u');
    }
    let k = 0, um;
    URL_RE.lastIndex = 0;
    while ((um = URL_RE.exec(s))) {
      if (um.index > k) parent.append(s.slice(k, um.index));
      const a = document.createElement('a');
      a.href = um[1]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = um[1];
      parent.append(a);
      k = um.index + um[1].length;
    }
    if (k < s.length) parent.append(s.slice(k));
    if (styled) frag.append(parent);
  };
  while ((m = re.exec(text))) {
    emit(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== 'm') continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { st.fg = st.bg = null; st.b = st.i = st.u = false; }
      else if (c === 1) st.b = true;
      else if (c === 3) st.i = true;
      else if (c === 4) st.u = true;
      else if (c === 22) st.b = false;
      else if (c === 23) st.i = false;
      else if (c === 24) st.u = false;
      else if (c >= 30 && c <= 37) st.fg = ansiVar(c - 30);
      else if (c >= 90 && c <= 97) st.fg = ansiVar(c - 90 + 8);
      else if (c >= 40 && c <= 47) st.bg = ansiVar(c - 40);
      else if (c >= 100 && c <= 107) st.bg = ansiVar(c - 100 + 8);
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        if (c === 38) st.fg = col; else st.bg = col;
        i += 4;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 5) i += 2;
    }
  }
  emit(text.slice(last));
  return frag;
}

/* ================================================================ */
/* GitHub contributions                                             */
/* ================================================================ */
const contribCache = new Map();
async function loadContrib(user) {
  if (contribCache.has(user)) return contribCache.get(user);
  const p = (async () => {
    try {
      const r = await fetch(`https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(user)}?y=last`);
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.contributions) && j.contributions.length) {
          const d = new Date();
          return { user, contributions: j.contributions, live: true, fetched: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` };
        }
      }
    } catch (e) { /* offline or blocked: fall through to the snapshot */ }
    if (user !== GH_USER) throw new Error('unreachable');
    const r = await fetch('data/contrib.json');
    const j = await r.json();
    return { user, contributions: j.contributions, live: false, fetched: j.fetched };
  })();
  contribCache.set(user, p);
  p.catch(() => contribCache.delete(user));
  return p;
}

function contribStats(days) {
  const total = days.reduce((t, d) => t + d.count, 0);
  let longest = 0, run = 0, busiest = days[0];
  for (const d of days) {
    run = d.count ? run + 1 : 0;
    longest = Math.max(longest, run);
    if (d.count > busiest.count) busiest = d;
  }
  let current = 0;
  for (let k = days.length - 1; k >= 0; k--) {
    if (days[k].count) current++;
    else if (k === days.length - 1) continue; // today may not have activity yet
    else break;
  }
  return { total, longest, current, busiest, active: days.filter(d => d.count).length };
}
const fmtDay = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

function renderContrib(el, data) {
  const days = data.contributions;
  const s = contribStats(days);
  const offset = new Date(days[0].date + 'T00:00:00').getDay();
  const cells = [];
  for (let k = 0; k < offset; k++) cells.push('<i class="pad"></i>');
  for (const d of days) cells.push(`<i class="l${d.level}" title="${d.count || 'No'} contribution${d.count === 1 ? '' : 's'} on ${fmtDay(d.date)}"></i>`);
  const months = [];
  let lastMonth = -1, lastCol = -9;
  days.forEach((d, k) => {
    const dt = new Date(d.date + 'T00:00:00');
    const col = Math.floor((k + offset) / 7);
    if (dt.getMonth() !== lastMonth && dt.getDate() <= 7 && col - lastCol >= 3) {
      months.push(`<span style="grid-column:${col + 1}">${dt.toLocaleDateString('en-US', { month: 'short' })}</span>`);
      lastCol = col;
    }
    lastMonth = dt.getMonth();
  });
  el.innerHTML = `
  <div class="gh">
    <div class="gh-head"><h2>${esc(data.user)}</h2><a href="https://github.com/${esc(data.user)}" target="_blank" rel="noopener">github.com/${esc(data.user)} ↗</a></div>
    <div class="gh-total"><b>${s.total}</b> contributions in the last year</div>
    <div class="gh-scroll">
      <div class="gh-graph">
        <div class="gh-months">${months.join('')}</div>
        <div class="gh-days"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>
        <div class="gh-cells">${cells.join('')}</div>
      </div>
    </div>
    <div class="gh-legend"><span>Less<span class="sw"><i style="background:var(--gh0)"></i><i style="background:var(--gh1)"></i><i style="background:var(--gh2)"></i><i style="background:var(--gh3)"></i><i style="background:var(--gh4)"></i></span>More</span>
      <span>${data.live ? 'live from GitHub' : `snapshot from ${esc(data.fetched)}; live data loads when the site is hosted`}</span></div>
    <dl class="gh-stats">
      <div><dt>Active days</dt><dd>${s.active} / ${days.length}</dd></div>
      <div><dt>Busiest day</dt><dd>${s.busiest.count} · ${new Date(s.busiest.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</dd></div>
      <div><dt>Longest streak</dt><dd>${s.longest} day${s.longest === 1 ? '' : 's'}</dd></div>
      <div><dt>Current streak</dt><dd>${s.current} day${s.current === 1 ? '' : 's'}</dd></div>
    </dl>
    <div class="gh-hint">in the terminal: <code>contrib</code> or <code>ghcontrib &lt;user&gt;</code></div>
  </div>`;
}

/* ================================================================ */
/* syntax highlighting for the editor                               */
/* ================================================================ */
const RULES = {
  md: [
    [/\[([^\]]+)\]\(([^)\s]+)\)/, 'u', m => mdLink(m[1], m[2])],
    [/^#{1,6}\s.*$/, 'h'], [/^[=-]{3,}$/, 'h'], [/^ {4}.*$/, 's'], [/^\s*(?:[-*]|\d+\.)(?=\s)/, 'm'],
    [/`[^`]+`/, 's'], [/\*\*[^*]+\*\*/, 'b'], [/https?:\/\/[^\s)]+/, 'u'], [/[\w.+-]+@[\w-]+\.[\w.]+/, 'v'],
  ],
  sh: [
    [/(?:^|(?<=\s))#.*$/, 'c'], [/'[^']*'|"(?:[^"\\]|\\.)*"/, 's'], [/\$\{[^}]*\}|\$\w+|\$[?@#$*]/, 'n'],
    [/\b(?:if|then|elif|else|fi|for|in|do|done|while|until|function|return|local|export|alias|case|esac)\b/, 'k'],
    [/^\s*[A-Za-z_]\w*(?==)/, 'v'], [/\b\d+\b/, 'n'],
  ],
  json: [[/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'], [/"(?:[^"\\]|\\.)*"/, 's'], [/-?\b\d+(?:\.\d+)?\b/, 'n'], [/\b(?:true|false|null)\b/, 'o']],
  txt: [[/https?:\/\/[^\s)]+/, 'u'], [/[\w.+-]+@[\w-]+\.[\w.]+/, 'v'], [/^[=-]{3,}$/, 'h'], [/^\S.*:$/, 'o'], [/^[a-z]+:(?=\s)/, 'key']],
};
const LANG_NAME = { md: 'Markdown', sh: 'Shell Script', json: 'JSON', txt: 'Plain Text' };
function langOf(path, text) {
  if (/\.md$/i.test(path)) return 'md';
  if (/\.json$/i.test(path)) return 'json';
  if (/\.(sh|bash)$|\/\.(bashrc|profile|bash_profile)$/.test(path) || /^#!.*\b(ba)?sh\b/.test(text)) return 'sh';
  return 'txt';
}
/* [text](url): show the text as a link. Site-relative links (blog.html#...)
   open in this tab; anything with a scheme opens in a new one. */
function mdLink(text, url) {
  const ext = /^[a-z][a-z0-9+.-]*:/i.test(url);
  return `<a class="u" href="${esc(url)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${esc(text)}</a>`;
}
function highlightLine(line, rules) {
  let out = '', pos = 0;
  while (pos <= line.length) {
    let best = null;
    for (const [re, cls, render] of rules) {
      const r = new RegExp(re.source, 'g' + (re.flags.replace('g', '')));
      r.lastIndex = pos;
      const m = r.exec(line);
      if (m && m[0] && (!best || m.index < best.index)) best = { index: m.index, m, cls, render };
    }
    if (!best) { out += esc(line.slice(pos)); break; }
    out += esc(line.slice(pos, best.index));
    const text = best.m[0];
    if (best.render) out += best.render(best.m);
    else {
      const t = esc(text);
      out += best.cls === 'u' ? `<a class="u" href="${t}" target="_blank" rel="noopener">${t}</a>` : `<span class="${best.cls}">${t}</span>`;
    }
    pos = best.index + text.length;
  }
  return out;
}
const fileIcon = (name, n) => {
  if (n.bin || /^#!/.test(n.content || '') || n.mode & 0o111) return ['$', 'sh'];
  if (/\.md$/.test(name)) return ['M', 'md'];
  if (/\.json$/.test(name)) return ['{}', 'json'];
  if (name[0] === '.') return ['⚙', 'cfg'];
  return ['≡', 'txt'];
};

/* ================================================================ */
/* app                                                              */
/* ================================================================ */
let fs, sh;
const ui = {
  expanded: new Set([HOME, HOME + '/experience', HOME + '/projects']),
  tabs: [], active: null,
};

/* ---------------------------- explorer --------------------------- */
const CHEV = open => `<span class="chev"><svg viewBox="0 0 16 16"><path d="${open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'}"/></svg></span>`;
function renderTree() {
  const root = fs.get(HOME);
  const rows = [];
  const walk = (dir, path, depth) => {
    const ents = [...dir.children].filter(([k]) => k[0] !== '.')
      .sort((a, b) => (a[1].type === 'dir') !== (b[1].type === 'dir') ? (a[1].type === 'dir' ? -1 : 1) : a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1);
    for (const [k, n] of ents) {
      const p = path + '/' + k;
      const pad = `padding-left:${8 + depth * 12}px`;
      if (n.type === 'dir') {
        const open = ui.expanded.has(p);
        rows.push(`<button class="ti" role="treeitem" aria-expanded="${open}" data-dir="${esc(p)}" style="${pad}">${CHEV(open)}<span class="nm">${esc(k)}</span></button>`);
        if (open && fs.can(n, 5)) walk(n, p, depth + 1);
      } else {
        const [g, cls] = fileIcon(k, n);
        rows.push(`<button class="ti${ui.active === p ? ' sel' : ''}" role="treeitem" data-file="${esc(p)}" style="${pad}"><span class="chev"></span><span class="ic ${cls}">${g}</span><span class="nm">${esc(k)}</span></button>`);
      }
    }
  };
  if (root) walk(root, HOME, 0);
  $('tree').innerHTML = rows.join('');
}
$('tree').addEventListener('click', e => {
  const b = e.target.closest('.ti');
  if (!b) return;
  if (b.dataset.dir) { const p = b.dataset.dir; ui.expanded.has(p) ? ui.expanded.delete(p) : ui.expanded.add(p); renderTree(); }
  else openFile(b.dataset.file);
});

/* ----------------------------- editor ---------------------------- */
function tabTitle(id) { return id === 'gh' ? 'contributions' : id.slice(id.lastIndexOf('/') + 1); }
async function openFile(path) {
  if (!ui.tabs.includes(path)) ui.tabs.push(path);
  ui.active = path;
  await renderEditor();
}
async function openGh() {
  if (!ui.tabs.includes('gh')) ui.tabs.push('gh');
  ui.active = 'gh';
  await renderEditor();
}
function closeTab(id) {
  const k = ui.tabs.indexOf(id);
  ui.tabs.splice(k, 1);
  if (ui.active === id) ui.active = ui.tabs[Math.min(k, ui.tabs.length - 1)] || null;
  renderEditor();
}
function renderTabs() {
  $('tabs').innerHTML = ui.tabs.map(id => {
    const gone = id !== 'gh' && !fs.get(id);
    const icon = id === 'gh' ? '<span class="ic sh" style="color:var(--green)">■</span>' : (() => { const n = fs.get(id); const [g, c] = n ? fileIcon(tabTitle(id), n) : ['≡', 'txt']; return `<span class="ic ${c}">${g}</span>`; })();
    return `<div class="tab${ui.active === id ? ' on' : ''}${gone ? ' gone' : ''}" role="tab" aria-selected="${ui.active === id}" data-id="${esc(id)}" tabindex="0">${icon}<span class="label">${esc(tabTitle(id))}</span><button class="x" data-close="${esc(id)}" aria-label="Close ${esc(tabTitle(id))}">×</button></div>`;
  }).join('');
}
$('tabs').addEventListener('click', e => {
  const x = e.target.closest('[data-close]');
  if (x) { e.stopPropagation(); closeTab(x.dataset.close); return; }
  const t = e.target.closest('.tab');
  if (t) { ui.active = t.dataset.id; renderEditor(); }
});
$('tabs').addEventListener('keydown', e => {
  const t = e.target.closest('.tab');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ui.active = t.dataset.id; renderEditor(); }
});
let renderSeq = 0;
async function renderEditor() {
  const seq = ++renderSeq;
  renderTabs();
  renderTree();
  const ed = $('editor');
  const id = ui.active;
  $('wtitle').textContent = id ? `${tabTitle(id)} - matt` : 'matt';
  if (!id) { ed.innerHTML = '<div class="note">No editor open. Try <code>code about.txt</code> in the terminal.</div>'; $('crumbs').innerHTML = ''; return; }
  if (id === 'gh') {
    $('crumbs').innerHTML = '<span>github</span><span class="sep">›</span><span>' + GH_USER + '</span>';
    $('st-lang').textContent = 'GitHub';
    try { const d = await loadContrib(GH_USER); if (seq === renderSeq) renderContrib(ed, d); }
    catch (e) { if (seq === renderSeq) ed.innerHTML = '<div class="note">Couldn\'t load contribution data.</div>'; }
    return;
  }
  const rel = id.startsWith(HOME + '/') ? id.slice(HOME.length + 1) : id;
  $('crumbs').innerHTML = rel.split('/').map(esc).join('<span class="sep">›</span>');
  const n = fs.get(id);
  if (!n) { ed.innerHTML = '<div class="note">This file was deleted from the shell. Reload the page to restore it.</div>'; return; }
  if (n.bin) { ed.innerHTML = '<div class="note">The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.</div>'; $('st-lang').textContent = 'Binary'; return; }
  let text;
  try { text = await fs.read(n); } catch (e) { text = ''; }
  if (seq !== renderSeq) return;
  const lang = langOf(id, text);
  $('st-lang').textContent = LANG_NAME[lang];
  const lines = text.replace(/\n$/, '').split('\n');
  ed.innerHTML = `<div class="code">${lines.map((l, k) => `<div class="ln">${k + 1}</div><div class="lc">${highlightLine(l, RULES[lang]) || ' '}</div>`).join('')}</div>`;
  ed.scrollTop = 0;
}

/* ---------------------------- terminal --------------------------- */
const term = {
  out: $('tout'), row: $('tin'), ps: $('ps'), input: $('cmd'), box: $('term'),
  st: {}, running: false, intr: false, reading: null, buffer: '', hist: [], hpos: 0, draft: '', ended: false,
  write(s) { this.out.append(renderAnsi(s, this.st)); this.scroll(); },
  scroll() { this.box.scrollTop = this.box.scrollHeight; },
  setPrompt(p) { this.ps.textContent = ''; this.ps.append(renderAnsi(p, {})); this.promptText = p; },
  show(on) { this.row.hidden = !on; if (on) { this.scroll(); focusTerm(); } },
  clear() { this.out.textContent = ''; },
  cols() {
    const cw = $('measure').getBoundingClientRect().width / 10 || 8;
    const w = this.box.clientWidth - parseFloat(getComputedStyle(this.box).paddingLeft) - parseFloat(getComputedStyle(this.box).paddingRight);
    return Math.max(20, Math.floor(w / cw) - 1);
  },
  readLine(prompt, opts = {}) {
    return new Promise((resolve, reject) => {
      this.reading = { resolve, reject, secret: !!opts.secret, prompt };
      this.setPrompt(prompt);
      this.input.type = opts.secret ? 'password' : 'text';
      this.show(true);
    });
  },
};
function focusTerm() {
  const sel = window.getSelection();
  if (sel && String(sel).length) return;
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.tabs, .tree')) return;
  term.input.focus({ preventScroll: true });
}
const env = {
  write: s => term.write(s),
  clear: () => term.clear(),
  cols: () => term.cols(),
  readLine: (p, o) => term.readLine(p, o),
  interrupted: () => term.intr,
  openFile: p => openFile(p),
  revealDir: p => { let q = p; while (q.startsWith(HOME)) { ui.expanded.add(q); q = q.slice(0, q.lastIndexOf('/')); } renderTree(); },
  contrib: u => loadContrib(u),
  themes: window.Themes,
  contribColors: () => window.Themes.ramp(),
  goBlog: () => { location.href = 'blog.html'; },
};
const ioTerm = { in: null, out: s => term.write(s), err: s => term.write(s), tty: true };

function echoLine(text) { term.write(term.promptText + text + '\n'); }

async function boot() {
  term.clear();
  term.ended = false;
  sh = new Shell(fs, env);
  sh.history = term.hist;
  term.running = true; term.show(false);
  await sh.runInteractive('cat /etc/motd 2>/dev/null; echo; source ~/.bashrc', ioTerm);
  term.running = false;
  term.setPrompt(sh.prompt('PS1'));
  term.show(true);
}

function historyExpand(src) {
  if (!/!(!|-?\d+)/.test(src)) return src;
  let changed = false;
  const out = src.replace(/!(!|-?\d+)/g, (m, x) => {
    const h = term.hist;
    const v = x === '!' ? h[h.length - 1] : +x < 0 ? h[h.length + +x] : h[+x - 1];
    if (v == null) throw new Error(`bash: ${m}: event not found`);
    changed = true; return v;
  });
  if (changed) term.write(out + '\n');
  return out;
}

async function submit() {
  const line = term.input.value;
  term.input.value = '';
  if (term.reading) {
    const r = term.reading; term.reading = null;
    term.input.type = 'text';
    term.write(r.prompt + (r.secret ? '' : line) + '\n');
    term.show(false);
    r.resolve(line);
    return;
  }
  if (term.ended) { boot(); return; }
  echoLine(line);
  let src = term.buffer ? term.buffer + '\n' + line : line;
  try { src = historyExpand(src); } catch (e) { term.write(e.message + '\n'); term.buffer = ''; term.setPrompt(sh.prompt('PS1')); return; }
  try { parse(src); }
  catch (e) {
    if (e instanceof Incomplete) { term.buffer = src; term.setPrompt(sh.prompt('PS2')); return; }
  }
  term.buffer = '';
  if (src.trim()) {
    if (term.hist[term.hist.length - 1] !== src) term.hist.push(src);
    term.hpos = term.hist.length;
    term.running = true; term.intr = false; term.show(false);
    try { await sh.runInteractive(src, ioTerm); }
    catch (e) {
      if (e instanceof ExitSig) {
        term.running = false;
        term.write('logout\n\nSession ended. Press Enter to start a new one.\n');
        term.ended = true; term.setPrompt(''); term.show(true);
        return;
      }
      term.write(`bash: ${e && e.message}\n`);
    }
    term.running = false;
  }
  term.intr = false;
  term.setPrompt(sh.prompt('PS1'));
  term.show(true);
}

function interrupt() {
  if (term.reading) {
    const r = term.reading; term.reading = null;
    term.input.type = 'text';
    term.write(r.prompt + term.input.value + '^C\n');
    term.input.value = '';
    term.intr = true;
    term.show(false);
    r.reject(new Interrupt());
    return;
  }
  if (term.running) { term.write('^C\n'); term.intr = true; return; }
  echoLine(term.input.value + '^C');
  term.input.value = ''; term.buffer = '';
  term.setPrompt(sh.prompt('PS1'));
}

term.input.addEventListener('keydown', e => {
  const k = e.key;
  if (k === 'Enter') { e.preventDefault(); submit(); return; }
  if (e.ctrlKey && (k === 'c' || k === 'C') && !String(window.getSelection())) { e.preventDefault(); interrupt(); return; }
  if (e.ctrlKey && (k === 'l' || k === 'L')) { e.preventDefault(); term.clear(); return; }
  if (e.ctrlKey && (k === 'd' || k === 'D')) {
    if (!term.input.value) {
      e.preventDefault();
      if (term.reading) { const r = term.reading; term.reading = null; term.write(r.prompt + '\n'); term.show(false); r.resolve(null); }
      else if (!term.running && !term.ended) { term.input.value = 'exit'; submit(); }
    }
    return;
  }
  if (e.ctrlKey && (k === 'u' || k === 'U')) { e.preventDefault(); term.input.value = term.input.value.slice(term.input.selectionStart); term.input.setSelectionRange(0, 0); return; }
  if (term.reading) return;
  if (k === 'Tab') {
    e.preventDefault();
    if (!sh) return;
    const pos = term.input.selectionStart;
    const head = term.input.value.slice(0, pos), tail = term.input.value.slice(pos);
    const r = sh.complete(head);
    if (r.list.length) {
      echoLine(term.input.value);
      const w = Math.max(...r.list.map(s => s.length)) + 2;
      const per = Math.max(1, Math.floor(term.cols() / w));
      let s = '';
      r.list.forEach((x, i) => { s += (i % per === per - 1 || i === r.list.length - 1) ? x + '\n' : x.padEnd(w); });
      term.write(s);
    }
    term.input.value = r.line + tail;
    term.input.setSelectionRange(r.line.length, r.line.length);
    return;
  }
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault();
    if (term.hpos === term.hist.length) term.draft = term.input.value;
    term.hpos = Math.max(0, Math.min(term.hist.length, term.hpos + (k === 'ArrowUp' ? -1 : 1)));
    term.input.value = term.hpos === term.hist.length ? term.draft : term.hist[term.hpos];
    const L = term.input.value.length;
    requestAnimationFrame(() => term.input.setSelectionRange(L, L));
  }
});
document.addEventListener('keydown', e => {
  if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && term.running && !term.reading && !String(window.getSelection())) { e.preventDefault(); interrupt(); }
});
term.box.addEventListener('mouseup', () => focusTerm());
term.box.addEventListener('click', e => { if (!e.target.closest('a')) focusTerm(); });

/* ------------------------------ sash ----------------------------- */
(() => {
  const sash = $('sash'), work = $('work');
  let drag = false;
  const KEY = 'mk.panelPx';
  const apply = px => {
    const mobile = matchMedia('(max-width: 760px)').matches;
    work.style.gridTemplateRows = `35px ${mobile ? 0 : 22}px minmax(0, 1fr) 5px ${px}px`;
  };
  try { const v = +localStorage.getItem(KEY); if (v > 60) apply(v); } catch (e) {}
  sash.addEventListener('pointerdown', e => { drag = true; sash.classList.add('drag'); sash.setPointerCapture(e.pointerId); });
  sash.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = work.getBoundingClientRect();
    const px = Math.round(Math.max(90, Math.min(r.height - 120, r.bottom - e.clientY)));
    apply(px);
    try { localStorage.setItem(KEY, String(px)); } catch (err) {}
  });
  const end = () => { drag = false; sash.classList.remove('drag'); term.scroll(); };
  sash.addEventListener('pointerup', end);
  sash.addEventListener('pointercancel', end);
})();

/* ---------------------------- wiring ----------------------------- */
$('act-gh').addEventListener('click', openGh);
$('st-gh').addEventListener('click', openGh);
$('act-files').addEventListener('click', () => openFile(HOME + '/README.md'));
$('act-theme').addEventListener('click', () => window.Themes.pick());
$('st-theme').addEventListener('click', () => window.Themes.pick());

let fsTimer = null;
function onFsChange() {
  clearTimeout(fsTimer);
  fsTimer = setTimeout(() => {
    renderTree();
    if (ui.active && ui.active !== 'gh') renderEditor(); else renderTabs();
  }, 30);
}

(async function start() {
  try {
    fs = await buildFS('fs.json', 'fs/');
  } catch (e) {
    term.write('\x1b[31mCould not load the filesystem (fs.json).\x1b[0m\nIf you opened index.html straight from disk, serve the folder instead:\n  python3 -m http.server\n');
    return;
  }
  fs.listeners.push(onFsChange);
  ui.tabs = [HOME + '/README.md', 'gh'];
  ui.active = HOME + '/README.md';
  renderEditor();
  loadContrib(GH_USER).then(d => {
    const total = d.contributions.reduce((t, x) => t + x.count, 0);
    $('st-gh-text').textContent = `${GH_USER} · ${total} contributions`;
  }).catch(() => {});
  await boot();
})();
})();
