/* shell.js: a small bash interpreter over a virtual filesystem.
 *
 * Files listed in fs.json are real files under fs/; their contents are
 * fetched the first time something reads them. Everything else
 * (/usr/bin, /tmp, /dev/null, ...) is created here at boot.
 */
'use strict';
(function (global) {

const USER = 'matt', HOME = '/home/matt', HOST_FALLBACK = 'kocorowski';
const VERSION = '5.2.21(1)-release';

class ShErr extends Error { constructor(m, code = 1) { super(m); this.code = code; } }
class Incomplete extends Error {}
class BreakSig { constructor(n) { this.n = n; } }
class ContinueSig { constructor(n) { this.n = n; } }
class ReturnSig { constructor(c) { this.code = c; } }
class ExitSig { constructor(c) { this.code = c; } }
class Interrupt {}

/* ================================================================ */
/* paths + filesystem                                                */
/* ================================================================ */

function normPath(p, cwd) {
  const abs = p.startsWith('/') ? p : (cwd === '/' ? '' : cwd) + '/' + p;
  const out = [];
  for (const s of abs.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop(); else out.push(s);
  }
  return '/' + out.join('/');
}
const dirOf = p => { if (p === '/') return '/'; const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const baseOf = p => p === '/' ? '/' : p.replace(/\/+$/, '').slice(p.replace(/\/+$/, '').lastIndexOf('/') + 1);

class VFS {
  constructor() {
    this.root = this.node('dir', { owner: 'root', mode: 0o755 });
    this.listeners = [];
  }
  node(type, o = {}) {
    return Object.assign({
      type, mode: type === 'dir' ? 0o755 : 0o644, owner: 'root', mtime: Date.now(),
      children: type === 'dir' ? new Map() : undefined, content: null, size: 0,
    }, o);
  }
  changed() { for (const f of this.listeners) f(); }
  /* walk a path, enforcing search permission on each directory */
  lookup(abs) {
    let n = this.root;
    for (const s of abs.split('/').filter(Boolean)) {
      if (n.type !== 'dir') throw new ShErr('Not a directory');
      if (!this.can(n, 1)) throw new ShErr('Permission denied');
      const c = n.children.get(s);
      if (!c) throw new ShErr('No such file or directory');
      n = c;
    }
    return n;
  }
  get(abs) { try { return this.lookup(abs); } catch (e) { return null; } }
  can(n, bit) { const m = n.owner === USER ? (n.mode >> 6) & 7 : n.mode & 7; return (m & bit) !== 0; }
  mkdirp(abs, o = {}) {
    let n = this.root, path = '';
    for (const s of abs.split('/').filter(Boolean)) {
      path += '/' + s;
      let c = n.children.get(s);
      if (!c) { c = this.node('dir', Object.assign({ owner: path.startsWith(HOME) ? USER : 'root' }, o)); n.children.set(s, c); }
      n = c;
    }
    return n;
  }
  addFile(abs, o) { const d = this.mkdirp(dirOf(abs)); const f = this.node('file', o); d.children.set(baseOf(abs), f); return f; }
  async read(n) {
    if (n.bin) return '\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x03\x00>\x00\x01\x00\x00\x00\x10\x6f\n';
    if (n.content == null && n.src) {
      let r;
      try { r = await fetch(n.src); } catch (e) { throw new ShErr('Input/output error'); }
      if (!r.ok) throw new ShErr('Input/output error');
      n.content = await r.text();
    }
    return n.content == null ? '' : n.content;
  }
  size(n) {
    if (n.type === 'dir') return 4096;
    if (n.bin) return n.size || 141936;
    if (n.content != null) return new TextEncoder().encode(n.content).length;
    return n.size;
  }
  parentOf(abs) {
    const d = this.lookup(dirOf(abs));
    if (d.type !== 'dir') throw new ShErr('Not a directory');
    return d;
  }
  async write(abs, data, append = false) {
    if (abs === '/dev/null') return;
    const d = this.parentOf(abs), name = baseOf(abs);
    let f = d.children.get(name);
    if (f) {
      if (f.type === 'dir') throw new ShErr('Is a directory');
      if (!this.can(f, 2)) throw new ShErr('Permission denied');
    } else {
      if (!this.can(d, 2)) throw new ShErr('Permission denied');
      f = this.node('file', { owner: USER, content: '' });
      d.children.set(name, f);
    }
    const prev = append ? await this.read(f) : '';
    f.content = prev + data; f.src = null; f.bin = null; f.mtime = Date.now();
    d.mtime = Date.now();
    this.changed();
  }
  clone(n) {
    const c = Object.assign({}, n, { owner: USER, mtime: Date.now() });
    if (n.type === 'dir') { c.children = new Map(); for (const [k, v] of n.children) c.children.set(k, this.clone(v)); }
    return c;
  }
}

/* ================================================================ */
/* lexer                                                            */
/* ================================================================ */

const META = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);

function lex(src) {
  const toks = [];
  const n = src.length;
  let i = 0;

  function matchParen(start) {          // index of the ')' closing a '(' just before start
    let d = 1, k = start;
    while (k < n) {
      const ch = src[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === "'") { const j = src.indexOf("'", k + 1); if (j < 0) throw new Incomplete(); k = j + 1; continue; }
      if (ch === '"') {
        k++;
        while (k < n && src[k] !== '"') { if (src[k] === '\\') k++; k++; }
        if (k >= n) throw new Incomplete();
        k++; continue;
      }
      if (ch === '(') d++;
      else if (ch === ')') { d--; if (d === 0) return k; }
      k++;
    }
    throw new Incomplete();
  }

  /* reads $..., ${...}, $(...), $((...)), `...` at src[i]; returns a part or null */
  function readDollar(q) {
    const c = src[i];
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw new Incomplete();
      const s = src.slice(i + 1, j); i = j + 1;
      return { k: 'sub', src: s, q };
    }
    const nx = src[i + 1];
    if (nx === '(') {
      const close = matchParen(i + 2);
      if (src[i + 2] === '(' && src[close - 1] === ')') {
        const e = src.slice(i + 3, close - 1); i = close + 1;
        return { k: 'arith', src: e, q };
      }
      const s = src.slice(i + 2, close); i = close + 1;
      return { k: 'sub', src: s, q };
    }
    if (nx === '{') {
      const j = src.indexOf('}', i + 2);
      if (j < 0) throw new Incomplete();
      const inner = src.slice(i + 2, j); i = j + 1;
      const m = /^(#?)([A-Za-z_]\w*|[0-9@*#?$!])(?:(:?[-=+?])([\s\S]*))?$/.exec(inner);
      if (!m) throw new ShErr(`\${${inner}}: bad substitution`);
      return { k: 'var', name: m[2], len: !!m[1], op: m[3] || null, arg: m[4] || '', q };
    }
    let m = /^[A-Za-z_]\w*/.exec(src.slice(i + 1));
    if (m) { i += 1 + m[0].length; return { k: 'var', name: m[0], q }; }
    if (nx && /[0-9@*#?$!]/.test(nx)) { i += 2; return { k: 'var', name: nx, q }; }
    return null;
  }

  function readWord() {
    const parts = [];
    let lit = '', litQ = false, hadQuote = false;
    const flush = () => { if (lit) { parts.push({ k: 'lit', v: lit, q: litQ }); lit = ''; } };
    const add = (s, q) => { if (q !== litQ) { flush(); litQ = q; } lit += s; };
    while (i < n) {
      const c = src[i];
      if (META.has(c)) break;
      if (c === '\\') {
        if (i + 1 >= n) throw new Incomplete();
        if (src[i + 1] === '\n') { i += 2; continue; }
        add(src[i + 1], true); hadQuote = true; i += 2; continue;
      }
      if (c === "'") {
        const j = src.indexOf("'", i + 1);
        if (j < 0) throw new Incomplete();
        add(src.slice(i + 1, j), true); hadQuote = true; i = j + 1; continue;
      }
      if (c === '"') {
        i++; hadQuote = true;
        for (;;) {
          if (i >= n) throw new Incomplete();
          const d = src[i];
          if (d === '"') { i++; break; }
          if (d === '\\' && i + 1 < n && '$`"\\\n'.includes(src[i + 1])) {
            if (src[i + 1] !== '\n') add(src[i + 1], true);
            i += 2; continue;
          }
          if (d === '$' || d === '`') {
            const p = readDollar(true);
            if (p) { flush(); parts.push(p); continue; }
          }
          add(d, true); i++;
        }
        continue;
      }
      if (c === '$' || c === '`') {
        const p = readDollar(false);
        if (p) { flush(); parts.push(p); continue; }
      }
      add(c, false); i++;
    }
    flush();
    return { w: true, parts, hadQuote };
  }

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '\n') { toks.push({ op: '\n' }); i++; continue; }
    const rest = src.slice(i, i + 4);
    let m;
    if ((m = /^&>>?/.exec(rest))) { toks.push({ op: 'redir', fd: 'both', kind: m[0] === '&>>' ? '>>' : '>' }); i += m[0].length; continue; }
    if ((m = /^(\d?)(>>|>&|<&|>\||>|<)/.exec(rest))) {
      const kind = m[2] === '>|' ? '>' : m[2] === '<&' ? '>&' : m[2];
      toks.push({ op: 'redir', fd: m[1] ? +m[1] : (kind === '<' ? 0 : 1), kind });
      i += m[0].length; continue;
    }
    if ((m = /^(&&|\|\||;;|\||;|&|\(|\))/.exec(rest))) { toks.push({ op: m[0] }); i += m[0].length; continue; }
    toks.push(readWord());
  }
  return toks;
}

/* ================================================================ */
/* parser                                                           */
/* ================================================================ */

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', '{', '}', '!', 'function']);
const plainText = t => t && t.w && !t.hadQuote && t.parts.length === 1 && t.parts[0].k === 'lit' && !t.parts[0].q ? t.parts[0].v : null;
const tokStr = t => !t ? 'newline' : t.op === '\n' ? 'newline' : t.op === 'redir' ? (t.kind) : t.op ? t.op : (t.parts.map(p => p.v || '$' + (p.name || '(..)')).join(''));

class Parser {
  constructor(toks) { this.t = toks; this.p = 0; }
  peek(o = 0) { return this.t[this.p + o]; }
  next() { return this.t[this.p++]; }
  eof() { return this.p >= this.t.length; }
  isWord(t, w) { return plainText(t) === w; }
  err(t) { return new ShErr(`syntax error near unexpected token \`${tokStr(t)}'`, 2); }
  skipNL() { while (this.peek() && this.peek().op === '\n') this.p++; }
  expectWord(w) { const t = this.next(); if (!t) throw new Incomplete(); if (!this.isWord(t, w)) throw this.err(t); }
  atTerm(terms) {
    const t = this.peek();
    if (!t) return true;
    if (t.op === ')' && terms.includes(')')) return true;
    return terms.some(x => this.isWord(t, x));
  }
  list(terms) {
    const items = [];
    this.skipNL();
    while (!this.eof() && !this.atTerm(terms)) {
      const ao = this.andOr();
      const t = this.peek();
      let bg = false;
      if (t && (t.op === ';' || t.op === '\n' || t.op === '&')) { this.next(); bg = t.op === '&'; }
      else if (t && !this.atTerm(terms)) throw this.err(t);
      items.push({ ao, bg });
      this.skipNL();
    }
    if (this.eof() && !terms.includes('EOF') && terms.length) { /* caller's expect will raise Incomplete */ }
    return { type: 'list', items };
  }
  andOr() {
    const first = this.pipeline(), rest = [];
    for (;;) {
      const t = this.peek();
      if (!t || (t.op !== '&&' && t.op !== '||')) break;
      this.next(); this.skipNL();
      if (this.eof()) throw new Incomplete();
      rest.push([t.op, this.pipeline()]);
    }
    return { first, rest };
  }
  pipeline() {
    let bang = false;
    if (this.isWord(this.peek(), '!')) { this.next(); bang = true; }
    const cmds = [this.command()];
    while (this.peek() && this.peek().op === '|') {
      this.next(); this.skipNL();
      if (this.eof()) throw new Incomplete();
      cmds.push(this.command());
    }
    return { bang, cmds };
  }
  redirs(node) {
    node.redirs = node.redirs || [];
    while (this.peek() && this.peek().op === 'redir') {
      const r = this.next(), tgt = this.next();
      if (!tgt) throw new Incomplete();
      if (!tgt.w) throw this.err(tgt);
      node.redirs.push({ fd: r.fd, kind: r.kind, target: tgt });
    }
    return node;
  }
  command() {
    const t = this.peek();
    if (!t) throw new Incomplete();
    if (t.op === '(') {
      this.next();
      const body = this.list([')']);
      const c = this.next();
      if (!c) throw new Incomplete();
      if (c.op !== ')') throw this.err(c);
      return this.redirs({ type: 'subshell', body });
    }
    if (t.op && t.op !== 'redir') throw this.err(t);
    const w = plainText(t);
    if (w === 'if') return this.redirs(this.parseIf());
    if (w === 'for') return this.redirs(this.parseFor());
    if (w === 'while' || w === 'until') return this.redirs(this.parseWhile(w));
    if (w === '{') {
      this.next();
      const body = this.list(['}']);
      this.expectWord('}');
      return this.redirs({ type: 'group', body });
    }
    if (w === 'function') {
      this.next();
      const nm = plainText(this.next());
      if (!nm) throw new ShErr('syntax error: bad function name', 2);
      if (this.peek() && this.peek().op === '(') { this.next(); const c = this.next(); if (!c) throw new Incomplete(); if (c.op !== ')') throw this.err(c); }
      this.skipNL();
      return { type: 'funcdef', name: nm, body: this.command() };
    }
    if (w && ['then', 'elif', 'else', 'fi', 'do', 'done', '}', 'in'].includes(w)) throw this.err(t);
    const t2 = this.peek(1), t3 = this.peek(2);
    if (w && t2 && t2.op === '(' && t3 && t3.op === ')') {
      this.p += 3; this.skipNL();
      if (this.eof()) throw new Incomplete();
      return { type: 'funcdef', name: w, body: this.command() };
    }
    return this.simple();
  }
  simple() {
    const assigns = [], words = [], redirs = [];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.op === 'redir') {
        this.next();
        const tgt = this.next();
        if (!tgt) throw new Incomplete();
        if (!tgt.w) throw this.err(tgt);
        redirs.push({ fd: t.fd, kind: t.kind, target: tgt });
        continue;
      }
      if (!t.w) break;
      const first = t.parts[0];
      if (!words.length && first && first.k === 'lit' && !first.q && /^[A-Za-z_]\w*=/.test(first.v)) {
        this.next();
        const eq = first.v.indexOf('=');
        const name = first.v.slice(0, eq);
        const rest = first.v.slice(eq + 1);
        const parts = (rest ? [{ k: 'lit', v: rest, q: false }] : []).concat(t.parts.slice(1));
        assigns.push({ name, value: { w: true, parts, hadQuote: true } });
        continue;
      }
      words.push(this.next());
    }
    if (!words.length && !assigns.length && !redirs.length) throw this.err(this.peek());
    return { type: 'simple', assigns, words, redirs };
  }
  parseIf() {
    this.next();
    const clauses = [];
    let cond = this.list(['then']); this.expectWord('then');
    let body = this.list(['elif', 'else', 'fi']);
    clauses.push([cond, body]);
    while (this.isWord(this.peek(), 'elif')) {
      this.next();
      cond = this.list(['then']); this.expectWord('then');
      body = this.list(['elif', 'else', 'fi']);
      clauses.push([cond, body]);
    }
    let els = null;
    if (this.isWord(this.peek(), 'else')) { this.next(); els = this.list(['fi']); }
    this.expectWord('fi');
    return { type: 'if', clauses, els };
  }
  parseFor() {
    this.next();
    const nt = this.next();
    if (!nt) throw new Incomplete();
    const name = plainText(nt);
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) throw new ShErr(`\`${tokStr(nt)}': not a valid identifier`, 2);
    this.skipNL();
    let words = null;
    if (this.isWord(this.peek(), 'in')) {
      this.next(); words = [];
      while (this.peek() && this.peek().w) words.push(this.next());
    }
    const t = this.peek();
    if (t && (t.op === ';' || t.op === '\n')) this.next();
    this.skipNL();
    this.expectWord('do');
    const body = this.list(['done']);
    this.expectWord('done');
    return { type: 'for', name, words, body };
  }
  parseWhile(kind) {
    this.next();
    const cond = this.list(['do']); this.expectWord('do');
    const body = this.list(['done']); this.expectWord('done');
    return { type: kind, cond, body };
  }
}

function parse(src) {
  const P = new Parser(lex(src));
  const ast = P.list([]);
  if (!P.eof()) throw P.err(P.peek());
  return ast;
}

/* ================================================================ */
/* globbing                                                         */
/* ================================================================ */

function hasGlob(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if ('*?['.includes(s[i])) return true;
  }
  return false;
}
function globToRe(pat, icase) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\') { i++; re += (pat[i] || '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); continue; }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      const j = pat.indexOf(']', i + 2);
      if (j > 0) {
        let cls = pat.slice(i + 1, j).replace(/\\/g, '\\\\');
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += '[' + cls + ']'; i = j; continue;
      }
    }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', icase ? 'i' : '');
}
/* {a,b,c} and {1..5} on unquoted literal text */
function braceExpand(word, depth = 0) {
  if (depth > 8) return [word];
  for (let k = 0; k < word.parts.length; k++) {
    const p = word.parts[k];
    if (p.k !== 'lit' || p.q) continue;
    const m = /\{([^{}]*)\}/.exec(p.v);
    if (!m) continue;
    let alts = null;
    const r = /^(-?\d+)\.\.(-?\d+)$/.exec(m[1]) || /^([a-zA-Z])\.\.([a-zA-Z])$/.exec(m[1]);
    if (r) {
      const num = /\d/.test(r[1]);
      let a = num ? +r[1] : r[1].charCodeAt(0), b = num ? +r[2] : r[2].charCodeAt(0);
      const step = a <= b ? 1 : -1; alts = [];
      for (let x = a; step > 0 ? x <= b : x >= b; x += step) { alts.push(num ? String(x) : String.fromCharCode(x)); if (alts.length > 10000) break; }
    } else if (m[1].includes(',')) alts = m[1].split(',');
    if (!alts) continue;
    const pre = p.v.slice(0, m.index), post = p.v.slice(m.index + m[0].length);
    const out = [];
    for (const alt of alts) {
      const parts = word.parts.slice();
      parts[k] = { k: 'lit', v: pre + alt + post, q: false };
      out.push(...braceExpand({ w: true, parts, hadQuote: word.hadQuote }, depth + 1));
    }
    return out;
  }
  return [word];
}
const unescape = s => s.replace(/\\(.)/g, '$1');
const sortKey = s => s.replace(/^\.+/, '').toLowerCase();
const byName = (a, b) => { const x = sortKey(a), y = sortKey(b); return x < y ? -1 : x > y ? 1 : (a < b ? -1 : a > b ? 1 : 0); };

/* ================================================================ */
/* I/O                                                              */
/* ================================================================ */

class Stream {
  constructor(s) { this.s = s; this.p = 0; }
  all() { const r = this.s.slice(this.p); this.p = this.s.length; return r; }
  line() {
    if (this.p >= this.s.length) return null;
    let j = this.s.indexOf('\n', this.p);
    if (j < 0) j = this.s.length;
    const r = this.s.slice(this.p, j); this.p = j + 1; return r;
  }
}
const lines = t => { const a = t.split('\n'); if (a.length && a[a.length - 1] === '') a.pop(); return a; };
const unlines = a => a.map(l => l + '\n').join('');
const visLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = n => String(n).padStart(2, '0');

function getopts(args, flags, withArg = '') {
  const f = {}, a = [];
  let done = false;
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (done || x === '-' || x[0] !== '-' || /^-\d/.test(x)) { a.push(x); continue; }
    if (x === '--') { done = true; continue; }
    if (x.startsWith('--')) { const eq = x.indexOf('='); f[eq < 0 ? x.slice(2) : x.slice(2, eq)] = eq < 0 ? true : x.slice(eq + 1); continue; }
    for (let k = 1; k < x.length; k++) {
      const c = x[k];
      if (withArg.includes(c)) {
        const v = x.slice(k + 1) || args[++i];
        if (v == null) throw new ShErr(`option requires an argument -- '${c}'`, 2);
        f[c] = v; break;
      }
      if (!flags.includes(c)) throw new ShErr(`invalid option -- '${c}'`, 2);
      f[c] = true;
    }
  }
  return { f, a };
}

/* ================================================================ */
/* the shell                                                        */
/* ================================================================ */

class Shell {
  /* env: { write, clear, cols, readLine, interrupted(), openFile, openUrl, contrib, onExit } */
  constructor(fs, env) {
    this.fs = fs; this.env = env;
    this.vars = new Map(); this.exported = new Set();
    this.funcs = new Map(); this.aliases = new Map();
    this.cwd = HOME; this.status = 0; this.pos = []; this.arg0 = 'bash';
    this.scopes = []; this.history = []; this.booted = Date.now();
    const init = {
      HOME, USER, LOGNAME: USER, SHELL: '/bin/bash', PATH: '/usr/local/bin:/usr/bin:/bin',
      PWD: HOME, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', HOSTNAME: HOST_FALLBACK,
      PS1: '\\u@\\h:\\w\\$ ', PS2: '> ', BASH_VERSION: VERSION, GITHUB_USER: 'mattkoco',
    };
    for (const [k, v] of Object.entries(init)) this.vars.set(k, v);
    for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'PWD', 'TERM', 'LANG', 'HOSTNAME']) this.exported.add(k);
  }

  path(p) { return normPath(p, this.cwd); }
  get(name) { return this.vars.has(name) ? this.vars.get(name) : ''; }
  set(name, v) { this.vars.set(name, String(v)); }
  tilde(p) { return p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p; }

  prompt(which = 'PS1') {
    const raw = this.get(which);
    return raw.replace(/\\\[|\\\]/g, '').replace(/\\(u|h|H|w|W|\$|e|n|\\|0?33|t|d)/g, (m, c) => {
      switch (c) {
        case 'u': return USER;
        case 'h': case 'H': return this.get('HOSTNAME');
        case 'w': return this.tilde(this.cwd);
        case 'W': return this.cwd === HOME ? '~' : baseOf(this.cwd);
        case '$': return '$';
        case 'e': case '033': case '33': return '\x1b';
        case 'n': return '\n';
        case '\\': return '\\';
        case 't': { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
        case 'd': { const d = new Date(); return `${WDAY[d.getDay()]} ${MON[d.getMonth()]} ${pad2(d.getDate())}`; }
      }
      return m;
    });
  }

  checkInt() { if (this.env.interrupted()) throw new Interrupt(); }
  async tick(k) { if (k % 64 === 0) { await new Promise(r => setTimeout(r, 0)); this.checkInt(); } }

  /* ------------------------- reading input ------------------------ */
  async readAll(io) {
    if (io.in) return io.in.all();
    const out = [];
    for (;;) { const l = await this.env.readLine(''); if (l == null) break; out.push(l + '\n'); }
    return out.join('');
  }
  async readInputs(files, io, name) {
    if (!files.length) return { text: await this.readAll(io), st: 0 };
    let text = '', st = 0;
    for (const p of files) {
      if (p === '-') { text += await this.readAll(io); continue; }
      try {
        const n = this.fs.lookup(this.path(p));
        if (n.type === 'dir') throw new ShErr('Is a directory');
        if (!this.fs.can(n, 4)) throw new ShErr('Permission denied');
        text += await this.fs.read(n);
      } catch (e) {
        if (!(e instanceof ShErr)) throw e;
        io.err(`${name}: ${p}: ${e.message}\n`); st = 1;
      }
    }
    return { text, st };
  }

  /* ------------------------- expansion ---------------------------- */
  varValue(name) {
    switch (name) {
      case '?': return String(this.status);
      case '$': return '1337';
      case '!': return '';
      case '#': return String(this.pos.length);
      case '@': case '*': return this.pos.join(' ');
      case '0': return this.arg0;
    }
    if (/^\d$/.test(name)) return this.pos[+name - 1] || '';
    return this.get(name);
  }
  async partValue(p) {
    if (p.k === 'var') {
      let v = this.varValue(p.name);
      const isSet = /^[?$#@*!0-9]$/.test(p.name) ? true : this.vars.has(p.name);
      if (p.len) return String(v.length);
      if (p.op) {
        const empty = p.op[0] === ':' ? v === '' : !isSet;
        const op = p.op.replace(':', '');
        const arg = () => this.expandStr(p.arg);
        if (op === '-' && empty) v = await arg();
        else if (op === '=' && empty) { v = await arg(); this.set(p.name, v); }
        else if (op === '+') v = empty ? '' : await arg();
        else if (op === '?' && empty) throw new ShErr(`${p.name}: ${p.arg || 'parameter null or not set'}`);
      }
      return v;
    }
    if (p.k === 'sub') return (await this.capture(p.src)).replace(/\n+$/, '');
    if (p.k === 'arith') return String(await this.arith(p.src));
    return p.v;
  }
  async arith(src) {
    let e = await this.expandStr(src);
    e = e.replace(/[A-Za-z_]\w*/g, m => String(parseInt(this.get(m), 10) || 0));
    if (!/^[\d\s+\-*/%()<>=!&|^~?:]*$/.test(e)) throw new ShErr(`${src}: syntax error in expression`);
    if (/\/\s*0(?!\d)|%\s*0(?!\d)/.test(e)) throw new ShErr(`${src}: division by 0`);
    let r;
    try { r = Function('"use strict";return (' + (e.trim() || '0') + ')')(); }
    catch (err) { throw new ShErr(`${src}: syntax error in expression`); }
    if (typeof r === 'boolean') r = r ? 1 : 0;
    return Math.trunc(Number(r) || 0);
  }
  async expandStr(s) {
    const toks = lex('"' + s.replace(/"/g, '\\"') + '"');
    return (await this.expandWord(toks[0], { noGlob: true })).join(' ');
  }
  /* word -> list of fields (word splitting + globbing) */
  async expandWord(word, opts = {}) {
    const fields = [];
    let cur = { segs: [], forced: false };
    const newField = () => { fields.push(cur); cur = { segs: [], forced: false }; };
    for (let idx = 0; idx < word.parts.length; idx++) {
      const p = word.parts[idx];
      if (p.k === 'lit') {
        let v = p.v;
        if (!p.q && idx === 0 && v[0] === '~') {
          const m = /^~([a-z]*)(?=\/|$)/.exec(v);
          if (m) {
            const home = m[1] === '' || m[1] === USER ? HOME : m[1] === 'root' ? '/root' : null;
            if (home) v = home + v.slice(m[0].length);
          }
        }
        if (p.q) { cur.segs.push({ s: v, g: false }); cur.forced = true; }
        else cur.segs.push({ s: v, g: true });
        continue;
      }
      if (p.k === 'var' && p.name === '@' && p.q && !p.op && !p.len) {
        this.pos.forEach((a, k) => { if (k > 0) newField(); cur.segs.push({ s: a, g: false }); cur.forced = true; });
        continue;
      }
      const v = await this.partValue(p);
      if (p.q || opts.noSplit) { cur.segs.push({ s: v, g: false }); cur.forced = true; continue; }
      const pieces = v.split(/[ \t\n]+/);
      pieces.forEach((pc, k) => { if (k > 0) newField(); if (pc) cur.segs.push({ s: pc, g: true }); });
    }
    if (!word.parts.length && word.hadQuote) cur.forced = true;
    fields.push(cur);
    const out = [];
    for (const f of fields) {
      const text = f.segs.map(s => s.s).join('');
      if (!text && !f.forced) continue;
      const globbable = !opts.noGlob && f.segs.some(s => s.g && /[*?[]/.test(s.s));
      if (globbable) {
        const pat = f.segs.map(s => s.g ? s.s : s.s.replace(/[*?[\]\\]/g, '\\$&')).join('');
        const m = this.glob(pat);
        if (m.length) { out.push(...m); continue; }
      }
      out.push(text);
    }
    return out;
  }
  async expandWords(words) {
    const out = [];
    for (const w of words) for (const b of braceExpand(w)) out.push(...await this.expandWord(b));
    return out;
  }
  glob(pat) {
    const abs = pat.startsWith('/');
    const segs = pat.split('/').filter(Boolean);
    let cur = [{ path: abs ? '/' : this.cwd, disp: [] }];
    segs.forEach((seg, k) => {
      const next = [];
      for (const c of cur) {
        if (!hasGlob(seg)) {
          const lit = unescape(seg);
          const p = normPath(lit, c.path);
          if (k === segs.length - 1 ? this.fs.get(p) : (this.fs.get(p) || {}).type === 'dir') next.push({ path: p, disp: c.disp.concat(lit) });
          continue;
        }
        const d = this.fs.get(c.path);
        if (!d || d.type !== 'dir' || !this.fs.can(d, 4)) continue;
        const re = globToRe(seg);
        const names = [...d.children.keys()].filter(nm => (nm[0] !== '.' || seg[0] === '.') && re.test(nm)).sort(byName);
        for (const nm of names) {
          if (k < segs.length - 1 && d.children.get(nm).type !== 'dir') continue;
          next.push({ path: normPath(nm, c.path), disp: c.disp.concat(nm) });
        }
      }
      cur = next;
    });
    return cur.map(c => (abs ? '/' : '') + c.disp.join('/') + (pat.endsWith('/') && c.disp.length ? '/' : ''));
  }

  /* ------------------------- execution ---------------------------- */
  async capture(src) {
    const buf = [];
    const saved = this.status;
    await this.execList(parse(src), { in: null, out: s => buf.push(s), err: this.curErr || (s => this.env.write(s)), tty: false });
    this.lastSubStatus = this.status;
    void saved;
    return buf.join('');
  }
  async execList(list, io) {
    let st = this.status;
    for (const it of list.items) {
      this.checkInt();
      st = await this.execAndOr(it.ao, io);
      this.status = st;
    }
    return st;
  }
  async execAndOr(ao, io) {
    let st = await this.execPipeline(ao.first, io);
    this.status = st;
    for (const [op, p] of ao.rest) {
      if ((op === '&&' && st === 0) || (op === '||' && st !== 0)) { st = await this.execPipeline(p, io); this.status = st; }
    }
    return st;
  }
  async execPipeline(pl, io) {
    let st;
    if (pl.cmds.length === 1) st = await this.execCmd(pl.cmds[0], io);
    else {
      let input = io.in;
      for (let k = 0; k < pl.cmds.length; k++) {
        const last = k === pl.cmds.length - 1;
        const buf = [];
        const sub = { in: input, out: last ? io.out : s => buf.push(s), err: io.err, tty: last ? io.tty : false };
        st = await this.execCmd(pl.cmds[k], sub);
        input = new Stream(buf.join(''));
      }
    }
    return pl.bang ? (st ? 0 : 1) : st;
  }
  async withRedirs(node, io, fn) {
    if (!node.redirs || !node.redirs.length) return fn(io);
    let r;
    try { r = await this.applyRedirs(node.redirs, io); }
    catch (e) { if (e instanceof ShErr) { io.err(`bash: ${e.message}\n`); return 1; } throw e; }
    try { return await fn(r.io); } finally { await r.finalize(); }
  }
  async applyRedirs(redirs, io) {
    let { in: inp, out, err, tty } = io;
    const pending = [];
    for (const r of redirs) {
      const t = await this.expandWord(r.target);
      if (t.length !== 1) throw new ShErr(`${tokStr(r.target)}: ambiguous redirect`);
      const target = t[0];
      if (r.kind === '>&') {
        if (target === '1') { if (r.fd === 2) err = out; }
        else if (target === '2') { if (r.fd === 1) { out = err; tty = io.tty; } }
        else if (target !== '-') throw new ShErr(`${target}: bad file descriptor`);
        continue;
      }
      const abs = this.path(target);
      if (r.kind === '<') {
        let n;
        try { n = this.fs.lookup(abs); } catch (e) { throw new ShErr(`${target}: ${e.message}`); }
        if (n.type === 'dir') throw new ShErr(`${target}: Is a directory`);
        if (!this.fs.can(n, 4)) throw new ShErr(`${target}: Permission denied`);
        inp = new Stream(await this.fs.read(n));
        continue;
      }
      let sink;
      if (abs === '/dev/null') sink = () => {};
      else {
        try { await this.fs.write(abs, '', r.kind === '>>'); }
        catch (e) { throw new ShErr(`${target}: ${e.message}`); }
        const buf = [];
        sink = s => buf.push(s);
        pending.push(async () => { if (buf.length) await this.fs.write(abs, buf.join(''), true); });
      }
      if (r.fd === 1 || r.fd === 'both') { out = sink; tty = false; }
      if (r.fd === 2 || r.fd === 'both') err = sink;
    }
    return {
      io: { in: inp, out, err, tty },
      finalize: async () => { for (const p of pending) { try { await p(); } catch (e) { if (e instanceof ShErr) io.err(`bash: ${e.message}\n`); } } },
    };
  }
  async execCmd(node, io) {
    switch (node.type) {
      case 'simple': return this.execSimple(node, io);
      case 'funcdef': this.funcs.set(node.name, node.body); return 0;
      case 'group': return this.withRedirs(node, io, sio => this.execList(node.body, sio));
      case 'subshell': return this.withRedirs(node, io, async sio => {
        const saved = { vars: new Map(this.vars), cwd: this.cwd, funcs: new Map(this.funcs) };
        try { return await this.execList(node.body, sio); }
        catch (e) { if (e instanceof ExitSig) return e.code; throw e; }
        finally { this.vars = saved.vars; this.cwd = saved.cwd; this.funcs = saved.funcs; }
      });
      case 'if': return this.withRedirs(node, io, async sio => {
        for (const [cond, body] of node.clauses) {
          if (await this.execList(cond, sio) === 0) return this.execList(body, sio);
        }
        return node.els ? this.execList(node.els, sio) : 0;
      });
      case 'for': return this.withRedirs(node, io, async sio => {
        const items = node.words ? await this.expandWords(node.words) : this.pos.slice();
        let st = 0, k = 0;
        for (const v of items) {
          await this.tick(++k);
          this.set(node.name, v);
          try { st = await this.execList(node.body, sio); }
          catch (e) {
            if (e instanceof BreakSig) { if (e.n > 1) { e.n--; throw e; } break; }
            if (e instanceof ContinueSig) { if (e.n > 1) { e.n--; throw e; } continue; }
            throw e;
          }
        }
        return st;
      });
      case 'while': case 'until': return this.withRedirs(node, io, async sio => {
        let st = 0, k = 0;
        for (;;) {
          await this.tick(++k);
          const c = await this.execList(node.cond, sio);
          if (node.type === 'while' ? c !== 0 : c === 0) break;
          try { st = await this.execList(node.body, sio); }
          catch (e) {
            if (e instanceof BreakSig) { if (e.n > 1) { e.n--; throw e; } break; }
            if (e instanceof ContinueSig) { if (e.n > 1) { e.n--; throw e; } continue; }
            throw e;
          }
        }
        return st;
      });
    }
    return 0;
  }
  async execSimple(node, io) {
    let argv = await this.expandWords(node.words);
    // alias expansion on the first word
    if (node.words.length && plainText(node.words[0]) !== null) {
      const seen = new Set();
      while (argv.length && this.aliases.has(argv[0]) && !seen.has(argv[0])) {
        seen.add(argv[0]);
        const toks = lex(this.aliases.get(argv[0])).filter(t => t.w);
        argv = (await this.expandWords(toks)).concat(argv.slice(1));
      }
    }
    this.lastSubStatus = null;
    const assigned = [];
    for (const a of node.assigns) assigned.push([a.name, (await this.expandWord(a.value, { noSplit: true, noGlob: true })).join('')]);
    if (!argv.length) {
      for (const [k, v] of assigned) this.set(k, v);
      return this.withRedirs(node, io, async () => this.lastSubStatus == null ? 0 : this.lastSubStatus);
    }
    const saved = assigned.map(([k]) => [k, this.vars.has(k) ? this.vars.get(k) : undefined]);
    for (const [k, v] of assigned) this.set(k, v);
    try {
      return await this.withRedirs(node, io, sio => this.invoke(argv, sio));
    } finally {
      for (const [k, v] of saved) { if (v === undefined) this.vars.delete(k); else this.vars.set(k, v); }
    }
  }
  resolveCmd(name) {
    if (name.includes('/')) return this.path(name);
    for (const d of this.get('PATH').split(':')) {
      if (!d) continue;
      const p = normPath(name, d);
      const n = this.fs.get(p);
      if (n && n.type === 'file' && this.fs.can(n, 1)) return p;
    }
    return null;
  }
  async invoke(argv, io) {
    const name = argv[0], args = argv.slice(1);
    this.checkInt();
    if (this.funcs.has(name)) {
      const savedPos = this.pos;
      this.pos = args; this.scopes.push(new Map());
      try { return await this.execCmd(this.funcs.get(name), io); }
      catch (e) { if (e instanceof ReturnSig) return e.code; throw e; }
      finally {
        this.pos = savedPos;
        for (const [k, v] of this.scopes.pop()) { if (v === undefined) this.vars.delete(k); else this.vars.set(k, v); }
      }
    }
    if (BUILTINS[name]) return this.call(BUILTINS[name], args, io, name, 'bash: ' + name);
    const path = this.resolveCmd(name);
    const n = path && this.fs.get(path);
    if (!n) {
      if (name.includes('/')) { io.err(`bash: ${name}: No such file or directory\n`); return 127; }
      io.err(`${name}: command not found\n`); return 127;
    }
    if (n.type === 'dir') { io.err(`bash: ${name}: Is a directory\n`); return 126; }
    if (!this.fs.can(n, 1)) { io.err(`bash: ${name}: Permission denied\n`); return 126; }
    if (n.bin) return this.call(CMDS[n.bin], args, io, name, n.bin);
    return this.runScript(await this.fs.read(n), args, io, name);
  }
  async call(fn, args, io, name, prefix) {
    try { const r = await fn.call(this, args, io, name); return r == null ? 0 : r; }
    catch (e) {
      if (e instanceof ShErr) { io.err(`${prefix}: ${e.message}\n`); return e.code; }
      throw e;
    }
  }
  async runScript(text, args, io, name) {
    const saved = { vars: new Map(this.vars), cwd: this.cwd, funcs: new Map(this.funcs), pos: this.pos, arg0: this.arg0, aliases: this.aliases };
    this.pos = args; this.arg0 = name; this.aliases = new Map();
    try {
      let ast;
      try { ast = parse(text); }
      catch (e) {
        if (e instanceof Incomplete) { io.err(`${name}: line ${lines(text).length}: syntax error: unexpected end of file\n`); return 2; }
        if (e instanceof ShErr) { io.err(`${name}: ${e.message}\n`); return 2; }
        throw e;
      }
      return await this.execList(ast, io);
    } catch (e) {
      if (e instanceof ExitSig || e instanceof ReturnSig) return e.code;
      throw e;
    } finally {
      Object.assign(this, saved);
    }
  }
  async source(text, io, args) {
    const savedPos = this.pos;
    if (args.length) this.pos = args;
    try { return await this.execList(parse(text), io); }
    catch (e) { if (e instanceof ReturnSig) return e.code; throw e; }
    finally { this.pos = savedPos; }
  }

  /* entry point for one line typed at the prompt */
  async runInteractive(src, io) {
    let ast;
    try { ast = parse(src); }
    catch (e) {
      if (e instanceof ShErr) { io.err(`bash: ${e.message}\n`); this.status = e.code; return; }
      throw e;
    }
    try { this.status = await this.execList(ast, io); }
    catch (e) {
      if (e instanceof Interrupt) { this.status = 130; return; }
      if (e instanceof ExitSig) throw e;
      if (e instanceof ReturnSig) { io.err("bash: return: can only `return' from a function or sourced script\n"); this.status = 1; return; }
      if (e instanceof BreakSig || e instanceof ContinueSig) { this.status = 0; return; }
      if (e instanceof ShErr) { io.err(`bash: ${e.message}\n`); this.status = e.code; return; }
      console.error(e);
      io.err(`bash: internal error: ${e && e.message}\n`); this.status = 1;
    }
  }

  /* -------------------------- completion -------------------------- */
  complete(line) {
    const m = /(^|[\s;|&(])([^\s;|&()<>]*)$/.exec(line);
    const word = m ? m[2] : '';
    const before = line.slice(0, line.length - word.length);
    const isCmd = /(^|[;|&(]|&&|\|\|)\s*$/.test(before) && !word.includes('/');
    let cands = [];
    if (isCmd) {
      const names = new Set([...Object.keys(BUILTINS), ...this.funcs.keys(), ...this.aliases.keys()]);
      for (const d of this.get('PATH').split(':')) {
        const n = this.fs.get(normPath(d || '.', this.cwd));
        if (n && n.type === 'dir') for (const [k, c] of n.children) if (c.type === 'file' && this.fs.can(c, 1)) names.add(k);
      }
      cands = [...names].filter(n => n.startsWith(word)).sort().map(n => ({ text: n, dir: false }));
    } else {
      let w = word, prefix = '';
      if (w.startsWith('~')) { prefix = '~'; w = HOME + w.slice(1); }
      const slash = w.lastIndexOf('/');
      const dpart = slash >= 0 ? w.slice(0, slash + 1) : '';
      const base = slash >= 0 ? w.slice(slash + 1) : w;
      const d = this.fs.get(this.path(dpart || '.'));
      if (d && d.type === 'dir' && this.fs.can(d, 4)) {
        const shown = prefix ? '~' + dpart.slice(HOME.length) : dpart;
        cands = [...d.children].filter(([k]) => k.startsWith(base) && (base[0] === '.' || k[0] !== '.'))
          .sort((a, b) => byName(a[0], b[0])).map(([k, c]) => ({ text: shown + k, dir: c.type === 'dir', name: k }));
      }
    }
    if (!cands.length) return { line, list: [] };
    if (cands.length === 1) {
      const c = cands[0];
      return { line: before + c.text + (c.dir ? '/' : ' '), list: [] };
    }
    let common = cands[0].text;
    for (const c of cands) while (!c.text.startsWith(common)) common = common.slice(0, -1);
    if (common.length > word.length) return { line: before + common, list: [] };
    return { line, list: cands.map(c => (c.name || c.text) + (c.dir ? '/' : '')) };
  }
}

/* ================================================================ */
/* shell builtins                                                   */
/* ================================================================ */

function unescapeEcho(s) {
  return s.replace(/\\(0?33|e|n|t|r|a|b|\\|x[0-9a-fA-F]{1,2}|c)/g, (m, c) => {
    switch (c) {
      case 'n': return '\n'; case 't': return '\t'; case 'r': return ''; case 'a': case 'b': return '';
      case '\\': return '\\'; case 'e': case '033': case '33': return '\x1b'; case 'c': return '\u0000';
    }
    if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    return m;
  });
}

function evalTest(a, sh) {
  if (!a.length) return false;
  if (a[0] === '!') return !evalTest(a.slice(1), sh);
  const oi = a.indexOf('-o'); if (oi > 0) return evalTest(a.slice(0, oi), sh) || evalTest(a.slice(oi + 1), sh);
  const ai = a.indexOf('-a'); if (ai > 0 && a.length > 3) return evalTest(a.slice(0, ai), sh) && evalTest(a.slice(ai + 1), sh);
  if (a.length === 1) return a[0] !== '';
  if (a.length === 2) {
    const [op, v] = a;
    const n = () => sh.fs.get(sh.path(v));
    switch (op) {
      case '-z': return v === '';
      case '-n': return v !== '';
      case '-e': return !!n();
      case '-f': return (n() || {}).type === 'file';
      case '-d': return (n() || {}).type === 'dir';
      case '-s': { const x = n(); return !!x && sh.fs.size(x) > 0; }
      case '-r': { const x = n(); return !!x && sh.fs.can(x, 4); }
      case '-w': { const x = n(); return !!x && sh.fs.can(x, 2); }
      case '-x': { const x = n(); return !!x && sh.fs.can(x, 1); }
    }
    throw new ShErr(`${op}: unary operator expected`, 2);
  }
  if (a.length === 3) {
    const [l, op, r] = a;
    const num = x => { if (!/^-?\d+$/.test(x.trim())) throw new ShErr(`${x}: integer expression expected`, 2); return +x; };
    switch (op) {
      case '=': case '==': return l === r;
      case '!=': return l !== r;
      case '<': return l < r;
      case '>': return l > r;
      case '-eq': return num(l) === num(r);
      case '-ne': return num(l) !== num(r);
      case '-lt': return num(l) < num(r);
      case '-le': return num(l) <= num(r);
      case '-gt': return num(l) > num(r);
      case '-ge': return num(l) >= num(r);
    }
    throw new ShErr(`${op}: binary operator expected`, 2);
  }
  throw new ShErr('too many arguments', 2);
}

function printfFormat(fmt, args) {
  let out = '', i = 0;
  const one = () => fmt.replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?([sdifxXoc%b])/g, (m, fl, w, prec, c) => {
    if (c === '%') return '%';
    let v = args[i++]; if (v === undefined) v = '';
    let s;
    switch (c) {
      case 's': s = prec ? v.slice(0, +prec) : v; break;
      case 'b': s = unescapeEcho(v); break;
      case 'c': s = v.charAt(0); break;
      case 'd': case 'i': s = String(Math.trunc(Number(v) || 0)); break;
      case 'f': s = (Number(v) || 0).toFixed(prec ? +prec : 6); break;
      case 'x': s = (Math.trunc(Number(v)) || 0).toString(16); break;
      case 'X': s = (Math.trunc(Number(v)) || 0).toString(16).toUpperCase(); break;
      case 'o': s = (Math.trunc(Number(v)) || 0).toString(8); break;
    }
    if (w) s = fl.includes('-') ? s.padEnd(+w) : s.padStart(+w, fl.includes('0') && c !== 's' ? '0' : ' ');
    return s;
  });
  const usesArgs = /%[-+ 0#]*\d*(?:\.\d+)?[sdifxXocb]/.test(fmt);
  do { out += unescapeEcho(one()); } while (usesArgs && i < args.length);
  return out;
}

const BUILTINS = {
  async cd(args) {
    let t = args[0];
    if (t === undefined || t === '') t = this.get('HOME');
    if (t === '-') { t = this.get('OLDPWD') || this.cwd; this.env.write(this.tilde(t) + '\n'); }
    const abs = this.path(t);
    let n;
    try { n = this.fs.lookup(abs); } catch (e) { throw new ShErr(`${t}: ${e.message}`); }
    if (n.type !== 'dir') throw new ShErr(`${t}: Not a directory`);
    if (!this.fs.can(n, 1)) throw new ShErr(`${t}: Permission denied`);
    this.vars.set('OLDPWD', this.cwd);
    this.cwd = abs; this.vars.set('PWD', abs);
    return 0;
  },
  async pwd(args, io) { io.out(this.cwd + '\n'); },
  async echo(args, io) {
    let nl = true, esc = false, i = 0;
    for (; i < args.length && /^-[neE]+$/.test(args[i]); i++) {
      if (args[i].includes('n')) nl = false;
      if (args[i].includes('e')) esc = true;
      if (args[i].includes('E')) esc = false;
    }
    let s = args.slice(i).join(' ');
    if (esc) { s = unescapeEcho(s); const c = s.indexOf('\u0000'); if (c >= 0) { s = s.slice(0, c); nl = false; } }
    io.out(s + (nl ? '\n' : ''));
  },
  async printf(args, io) {
    if (!args.length) throw new ShErr('usage: printf format [arguments]', 2);
    io.out(printfFormat(args[0], args.slice(1)));
  },
  async export(args, io) {
    const a = args.filter(x => x !== '-n');
    if (!a.length || args[0] === '-p') {
      io.out([...this.exported].sort().filter(k => this.vars.has(k)).map(k => `declare -x ${k}="${this.vars.get(k)}"\n`).join(''));
      return;
    }
    for (const x of a) {
      const eq = x.indexOf('=');
      const k = eq < 0 ? x : x.slice(0, eq);
      if (!/^[A-Za-z_]\w*$/.test(k)) throw new ShErr(`\`${x}': not a valid identifier`);
      if (eq >= 0) this.set(k, x.slice(eq + 1));
      if (args[0] === '-n') this.exported.delete(k); else this.exported.add(k);
    }
  },
  async unset(args) {
    for (const k of args) { if (k === '-f' || k === '-v') continue; if (args[0] === '-f') this.funcs.delete(k); else { this.vars.delete(k); this.exported.delete(k); } }
  },
  async set(args, io) {
    if (!args.length) { io.out([...this.vars].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'\n`).join('')); return; }
    if (args[0] === '--') { this.pos = args.slice(1); return; }
    if (!args[0].startsWith('-') && !args[0].startsWith('+')) this.pos = args.slice();
  },
  async alias(args, io) {
    if (!args.length) {
      io.out([...this.aliases].sort().map(([k, v]) => `alias ${k}='${v.replace(/'/g, "'\\''")}'\n`).join(''));
      return;
    }
    let st = 0;
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq < 0) {
        if (this.aliases.has(a)) io.out(`alias ${a}='${this.aliases.get(a)}'\n`);
        else { io.err(`bash: alias: ${a}: not found\n`); st = 1; }
      } else this.aliases.set(a.slice(0, eq), a.slice(eq + 1));
    }
    return st;
  },
  async unalias(args) {
    if (args[0] === '-a') { this.aliases.clear(); return; }
    for (const a of args) { if (!this.aliases.delete(a)) throw new ShErr(`${a}: not found`); }
  },
  async history(args, io) {
    if (args[0] === '-c') { this.history.length = 0; return; }
    const n = args[0] ? +args[0] : this.history.length;
    const start = Math.max(0, this.history.length - n);
    io.out(this.history.slice(start).map((h, k) => `${String(start + k + 1).padStart(5)}  ${h.replace(/\n/g, ' ')}\n`).join(''));
  },
  async type(args, io) {
    let st = 0;
    for (const a of args) {
      if (this.aliases.has(a)) io.out(`${a} is aliased to \`${this.aliases.get(a)}'\n`);
      else if (RESERVED.has(a)) io.out(`${a} is a shell keyword\n`);
      else if (this.funcs.has(a)) io.out(`${a} is a function\n`);
      else if (BUILTINS[a]) io.out(`${a} is a shell builtin\n`);
      else { const p = this.resolveCmd(a); if (p) io.out(`${a} is ${p}\n`); else { io.err(`bash: type: ${a}: not found\n`); st = 1; } }
    }
    return st;
  },
  async exit(args) { throw new ExitSig(args[0] ? (+args[0] & 255) : this.status); },
  async logout(args) { throw new ExitSig(0); },
  async true() { return 0; },
  async false() { return 1; },
  async ':'() { return 0; },
  async test(args) { return evalTest(args, this) ? 0 : 1; },
  async '['(args) {
    if (args[args.length - 1] !== ']') throw new ShErr("missing `]'", 2);
    return evalTest(args.slice(0, -1), this) ? 0 : 1;
  },
  async source(args, io) {
    if (!args.length) throw new ShErr('filename argument required', 2);
    const n = this.fs.get(this.path(args[0])) || (this.resolveCmd(args[0]) && this.fs.get(this.resolveCmd(args[0])));
    if (!n || n.type !== 'file') throw new ShErr(`${args[0]}: No such file or directory`);
    if (!this.fs.can(n, 4)) throw new ShErr(`${args[0]}: Permission denied`);
    return this.source(await this.fs.read(n), io, args.slice(1));
  },
  async eval(args, io) { return this.execList(parse(args.join(' ')), io); },
  async read(args, io) {
    const { f, a } = getopts(args, 'rs', 'p');
    let line;
    if (io.in) line = io.in.line();
    else line = await this.env.readLine(f.p || '', { secret: !!f.s });
    if (line == null) return 1;
    if (!f.r) line = line.replace(/\\(.)/g, '$1');
    const names = a.length ? a : ['REPLY'];
    const parts = names.length === 1 ? [line] : line.trim().split(/[ \t]+/);
    names.forEach((nm, k) => this.set(nm, k === names.length - 1 ? parts.slice(k).join(' ') : (parts[k] || '')));
    return 0;
  },
  async local(args) {
    if (!this.scopes.length) throw new ShErr('can only be used in a function');
    const sc = this.scopes[this.scopes.length - 1];
    for (const x of args) {
      const eq = x.indexOf('=');
      const k = eq < 0 ? x : x.slice(0, eq);
      if (!sc.has(k)) sc.set(k, this.vars.has(k) ? this.vars.get(k) : undefined);
      this.vars.set(k, eq < 0 ? '' : x.slice(eq + 1));
    }
  },
  async return(args) { throw new ReturnSig(args[0] ? (+args[0] & 255) : this.status); },
  async shift(args) { const n = args[0] ? +args[0] : 1; if (n > this.pos.length) return 1; this.pos = this.pos.slice(n); },
  async break(args) { throw new BreakSig(args[0] ? +args[0] : 1); },
  async continue(args) { throw new ContinueSig(args[0] ? +args[0] : 1); },
  async help(args, io) {
    const g = '\x1b[32m', y = '\x1b[33m', d = '\x1b[90m', r = '\x1b[0m';
    io.out(
`GNU bash, version ${VERSION} (simulated, x86_64-pc-linux-gnu)

${y}About me${r}
  cat about.txt          who I am
  resume                 about + education + experience + achievements
  ls projects            things I've built
  contrib                my GitHub activity
  blog                   CTF writeups and notes
  code README.md         open a file in the editor above
  theme                  list color themes (theme tokyo night, theme -p)

${y}Shell builtins${r}
  ${Object.keys(BUILTINS).sort().join(' ')}

${y}Programs${r} ${d}(see: ls /usr/bin)${r}
  ${Object.keys(CMDS).sort().join(' ')}

${y}Syntax${r}
  pipes ${g}a | b${r}, lists ${g}a && b || c ; d${r}, redirects ${g}> >> < 2> 2>&1 &>${r}
  ${g}$VAR ${'${VAR:-default}'} $(cmd) $((1+2)) ~ * ? [abc]${r}, quotes ${g}'..' ".." \\${r}
  ${g}if/elif/else/fi${r}, ${g}for x in ..; do ..; done${r}, ${g}while${r}/${g}until${r}, ${g}f() { ..; }${r}
  keys: Tab completes, Up/Down history, Ctrl+C interrupts, Ctrl+L clears
`);
  },
};
BUILTINS['.'] = BUILTINS.source;

/* ================================================================ */
/* programs in /usr/bin                                             */
/* ================================================================ */

const CMDS = {};
const def = (names, fn) => { for (const n of names.split(' ')) CMDS[n] = fn; };

const C = { dir: '\x1b[1;34m', exe: '\x1b[1;32m', reset: '\x1b[0m' };
function modeStr(n) {
  let s = n.type === 'dir' ? 'd' : '-';
  for (const sh of [6, 3, 0]) { const m = (n.mode >> sh) & 7; s += (m & 4 ? 'r' : '-') + (m & 2 ? 'w' : '-') + (m & 1 ? 'x' : '-'); }
  if (n.mode & 0o1000) s = s.slice(0, 9) + 't';
  return s;
}
function lsDate(ms) {
  const d = new Date(ms);
  const recent = Math.abs(Date.now() - ms) < 182 * 864e5;
  return `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${recent ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : ' ' + d.getFullYear()}`;
}
function human(n) {
  if (n < 1024) return String(n);
  const u = ['K', 'M', 'G']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return (n < 10 ? n.toFixed(1) : String(Math.round(n))) + u[i];
}
function columns(names, width) {
  if (!names.length) return '';
  const lens = names.map(visLen);
  for (let rows = 1; rows <= names.length; rows++) {
    const cols = Math.ceil(names.length / rows);
    const ws = [];
    for (let c = 0; c < cols; c++) ws.push(Math.max(...lens.slice(c * rows, c * rows + rows)) + 2);
    if (ws.reduce((a, b) => a + b, 0) - 2 <= width || rows === names.length) {
      let out = '';
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          const k = c * rows + r;
          if (k >= names.length) continue;
          const last = c === cols - 1 || (c + 1) * rows + r >= names.length;
          line += last ? names[k] : names[k] + ' '.repeat(ws[c] - lens[k]);
        }
        out += line + '\n';
      }
      return out;
    }
  }
}

def('ls', async function (args, io) {
  const { f, a } = getopts(args, 'laAh1RdFtrS');
  const color = io.tty && f.color && f.color !== 'never';
  const targets = a.length ? a : ['.'];
  const files = [], dirs = [];
  let st = 0;
  for (const t of targets) {
    try { const n = this.fs.lookup(this.path(t)); (n.type === 'dir' && !f.d ? dirs : files).push({ name: t, n }); }
    catch (e) { io.err(`ls: cannot access '${t}': ${e.message}\n`); st = 2; }
  }
  const show = e => {
    let s = e.name;
    const exe = e.n.type === 'file' && (e.n.mode & 0o111);
    if (color) s = e.n.type === 'dir' ? C.dir + s + C.reset : exe ? C.exe + s + C.reset : s;
    if (f.F) s += e.n.type === 'dir' ? '/' : exe ? '*' : '';
    return s;
  };
  const sortE = ents => {
    ents.sort((x, y) => byName(x.name, y.name));
    if (f.t) ents.sort((x, y) => y.n.mtime - x.n.mtime);
    if (f.S) ents.sort((x, y) => this.fs.size(y.n) - this.fs.size(x.n));
    if (f.r) ents.reverse();
    return ents;
  };
  const fmt = ents => {
    if (!ents.length) return '';
    if (f.l) {
      const sz = ents.map(e => f.h ? human(this.fs.size(e.n)) : String(this.fs.size(e.n)));
      const w = Math.max(...sz.map(s => s.length));
      const ow = Math.max(...ents.map(e => e.n.owner.length));
      return ents.map((e, k) => {
        const links = e.n.type === 'dir' ? 2 + [...e.n.children.values()].filter(c => c.type === 'dir').length : 1;
        return `${modeStr(e.n)} ${String(links).padStart(2)} ${e.n.owner.padEnd(ow)} ${e.n.owner.padEnd(ow)} ${sz[k].padStart(w)} ${lsDate(e.n.mtime)} ${show(e)}\n`;
      }).join('');
    }
    if (f['1'] || !io.tty) return ents.map(e => show(e) + '\n').join('');
    return columns(ents.map(show), this.env.cols());
  };
  const out = [];
  if (files.length) out.push(fmt(sortE(files)));
  const header = targets.length > 1 || f.R;
  const doDir = async (label, n, abs) => {
    if (!this.fs.can(n, 4)) { io.err(`ls: cannot open directory '${label}': Permission denied\n`); st = 2; return; }
    let ents = [...n.children].map(([name, c]) => ({ name, n: c }));
    if (!f.a && !f.A) ents = ents.filter(e => e.name[0] !== '.');
    sortE(ents);
    if (f.a) ents.unshift({ name: '.', n }, { name: '..', n: this.fs.get(dirOf(abs)) || n });
    let s = header ? `${label}:\n` : '';
    if (f.l) s += `total ${ents.reduce((t, e) => t + Math.ceil(this.fs.size(e.n) / 4096) * 4, 0)}\n`;
    out.push(s + fmt(ents));
    if (f.R) for (const e of ents) if (e.n.type === 'dir' && e.name !== '.' && e.name !== '..') await doDir(label.replace(/\/$/, '') + '/' + e.name, e.n, normPath(e.name, abs));
  };
  for (const d of sortE(dirs)) await doDir(d.name, d.n, this.path(d.name));
  io.out(out.filter(Boolean).join('\n'));
  return st;
});

def('cat less more', async function (args, io, name) {
  const { f, a } = getopts(args, 'nAE');
  const { text, st } = await this.readInputs(a, io, name === 'cat' ? 'cat' : name);
  if (f.n) io.out(lines(text).map((l, k) => `${String(k + 1).padStart(6)}\t${l}\n`).join(''));
  else io.out(text);
  return st;
});

function numArg(args) { return args.map(x => /^-\d+$/.test(x) ? '-n' + x.slice(1) : x); }
def('head', async function (args, io) {
  const { f, a } = getopts(numArg(args), 'q', 'nc');
  const { text, st } = await this.readInputs(a, io, 'head');
  if (f.c) io.out(text.slice(0, +f.c));
  else { const n = f.n ? +f.n : 10; io.out(unlines(n < 0 ? lines(text).slice(0, n) : lines(text).slice(0, n))); }
  return st;
});
def('tail', async function (args, io) {
  const { f, a } = getopts(numArg(args), 'q', 'nc');
  const { text, st } = await this.readInputs(a, io, 'tail');
  if (f.c) { io.out(text.slice(-f.c)); return st; }
  const ls = lines(text);
  const n = f.n || '10';
  io.out(unlines(n.startsWith('+') ? ls.slice(+n.slice(1) - 1) : ls.slice(Math.max(0, ls.length - Math.abs(+n)))));
  return st;
});

def('wc', async function (args, io) {
  const { f, a } = getopts(args, 'lwcm');
  const pick = (f.l || f.w || f.c || f.m) ? ['l', 'w', 'c'].filter(k => f[k] || (k === 'c' && f.m)) : ['l', 'w', 'c'];
  const count = t => ({ l: (t.match(/\n/g) || []).length, w: (t.match(/\S+/g) || []).length, c: new TextEncoder().encode(t).length });
  const rows = [];
  let st = 0;
  if (!a.length) rows.push([count(await this.readAll(io)), '']);
  else for (const p of a) {
    const r = await this.readInputs([p], { in: null, out: io.out, err: s => { io.err(s); st = 1; } }, 'wc');
    if (!r.st) rows.push([count(r.text), p]);
  }
  if (rows.length > 1) rows.push([rows.reduce((t, [c]) => ({ l: t.l + c.l, w: t.w + c.w, c: t.c + c.c }), { l: 0, w: 0, c: 0 }), 'total']);
  const w = !a.length && pick.length > 1 ? 7 : Math.max(1, ...rows.map(([c]) => Math.max(...pick.map(k => String(c[k]).length))));
  io.out(rows.map(([c, nm]) => (pick.length === 1 && !nm ? String(c[pick[0]]) : pick.map(k => String(c[k]).padStart(w)).join(' ')) + (nm ? ' ' + nm : '') + '\n').join(''));
  return st;
});

function toJsRe(p, ext) {
  if (ext) return p;
  let r = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) {
      const d = p[++i];
      if ('|()+?{}'.includes(d)) r += d; else r += '\\' + d;
      continue;
    }
    if ('|()+?{}'.includes(c)) r += '\\' + c; else r += c;
  }
  return r;
}

def('grep egrep', async function (args, io, name) {
  const { f, a } = getopts(args, 'ivnclLrRhHEFwoqs', 'e');
  if (f.e) a.unshift(f.e);
  if (!a.length) throw new ShErr('usage: grep [OPTION]... PATTERNS [FILE]...', 2);
  const pat = a.shift();
  let src = f.F ? pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : toJsRe(pat, f.E || name === 'egrep');
  if (f.w) src = `\\b(?:${src})\\b`;
  let re;
  try { re = new RegExp(src, f.i ? 'gi' : 'g'); } catch (e) { throw new ShErr('invalid regular expression', 2); }
  const color = io.tty && f.color && f.color !== 'never';
  const rec = f.r || f.R;
  let files = a;
  if (rec && !files.length) files = ['.'];
  const inputs = [];
  let st = 0;
  const walk = (p, n) => {
    if (n.type === 'dir') {
      if (!rec) { io.err(`grep: ${p}: Is a directory\n`); return; }
      if (!this.fs.can(n, 5)) { io.err(`grep: ${p}: Permission denied\n`); st = 2; return; }
      for (const k of [...n.children.keys()].sort(byName)) walk((p === '/' ? '' : p.replace(/\/$/, '')) + '/' + k, n.children.get(k));
    } else if (!n.bin) {
      if (!this.fs.can(n, 4)) { if (!f.s) io.err(`grep: ${p}: Permission denied\n`); st = 2; return; }
      inputs.push({ name: a.length ? p : p.replace(/^\.\//, ''), n });
    }
  };
  if (!files.length) inputs.push({ name: '(standard input)', text: await this.readAll(io) });
  else for (const p of files) {
    const n = this.fs.get(this.path(p));
    if (!n) { if (!f.s) io.err(`grep: ${p}: No such file or directory\n`); st = 2; continue; }
    walk(p, n);
  }
  const multi = !f.h && (f.H || inputs.length > 1 || rec);
  let found = false;
  const out = [];
  for (const inp of inputs) {
    const text = inp.text != null ? inp.text : await this.fs.read(inp.n);
    let count = 0;
    lines(text).forEach((ln, k) => {
      re.lastIndex = 0;
      const hit = re.test(ln);
      if (hit === !!f.v) return;
      count++; found = true;
      if (f.q || f.l || f.L || f.c) return;
      let s = '';
      if (multi) s += color ? `\x1b[35m${inp.name}\x1b[36m:\x1b[0m` : inp.name + ':';
      if (f.n) s += color ? `\x1b[32m${k + 1}\x1b[36m:\x1b[0m` : (k + 1) + ':';
      if (f.o && !f.v) { re.lastIndex = 0; for (const m of ln.match(re) || []) out.push(s + (color ? `\x1b[1;31m${m}\x1b[0m` : m)); return; }
      s += color && !f.v ? ln.replace(re, m => `\x1b[1;31m${m}\x1b[0m`) : ln;
      out.push(s);
    });
    if (f.l && count) out.push(color ? `\x1b[35m${inp.name}\x1b[0m` : inp.name);
    if (f.L && !count) out.push(inp.name);
    if (f.c) out.push((multi ? inp.name + ':' : '') + count);
  }
  if (!f.q) io.out(unlines(out));
  return st === 2 && !found ? 2 : found ? 0 : 1;
});

def('sort', async function (args, io) {
  const { f, a } = getopts(args, 'rnufb', 'kt');
  const { text, st } = await this.readInputs(a, io, 'sort');
  let ls = lines(text);
  const key = l => {
    if (!f.k) return l;
    const fields = f.t ? l.split(f.t) : l.trim().split(/\s+/);
    return fields.slice(+f.k - 1).join(f.t || ' ');
  };
  ls.sort((x, y) => {
    let kx = key(x), ky = key(y);
    if (f.n) return (parseFloat(kx) || 0) - (parseFloat(ky) || 0) || (x < y ? -1 : x > y ? 1 : 0);
    if (f.f) { kx = kx.toLowerCase(); ky = ky.toLowerCase(); }
    return kx.localeCompare(ky, 'en');
  });
  if (f.r) ls.reverse();
  if (f.u) ls = ls.filter((l, k) => k === 0 || l !== ls[k - 1]);
  io.out(unlines(ls));
  return st;
});

def('uniq', async function (args, io) {
  const { f, a } = getopts(args, 'cdui');
  const { text, st } = await this.readInputs(a.slice(0, 1), io, 'uniq');
  const groups = [];
  for (const l of lines(text)) {
    const g = groups[groups.length - 1];
    if (g && (f.i ? g[0].toLowerCase() === l.toLowerCase() : g[0] === l)) g[1]++; else groups.push([l, 1]);
  }
  io.out(groups.filter(([, c]) => (!f.d || c > 1) && (!f.u || c === 1)).map(([l, c]) => (f.c ? String(c).padStart(7) + ' ' : '') + l + '\n').join(''));
  return st;
});

function parseList(spec) {
  const r = [];
  for (const part of spec.split(',')) {
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new ShErr('invalid field value', 1);
    const lo = m[1] ? +m[1] : 1, hi = m[2] ? (m[3] ? +m[3] : Infinity) : lo;
    r.push([lo, hi]);
  }
  return k => r.some(([lo, hi]) => k >= lo && k <= hi);
}
def('cut', async function (args, io) {
  const { f, a } = getopts(args, 's', 'dfc');
  if (!f.f && !f.c) throw new ShErr('you must specify a list of bytes, characters, or fields', 1);
  const sel = parseList(f.f || f.c);
  const d = f.d || '\t';
  const { text, st } = await this.readInputs(a, io, 'cut');
  io.out(lines(text).map(l => {
    if (f.c) return [...l].filter((_, k) => sel(k + 1)).join('');
    if (!l.includes(d)) return f.s ? null : l;
    return l.split(d).filter((_, k) => sel(k + 1)).join(d);
  }).filter(l => l !== null).map(l => l + '\n').join(''));
  return st;
});

function trSet(s) {
  s = unescapeEcho(s)
    .replace(/\[:upper:\]/g, 'A-Z').replace(/\[:lower:\]/g, 'a-z').replace(/\[:digit:\]/g, '0-9')
    .replace(/\[:space:\]/g, ' \t\n').replace(/\[:alpha:\]/g, 'a-zA-Z').replace(/\[:alnum:\]/g, 'a-zA-Z0-9');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i + 1] === '-' && i + 2 < s.length) {
      for (let c = s.charCodeAt(i); c <= s.charCodeAt(i + 2); c++) out.push(String.fromCharCode(c));
      i += 2;
    } else out.push(s[i]);
  }
  return out;
}
def('tr', async function (args, io) {
  const { f, a } = getopts(args, 'dsc');
  if (!a.length || (!f.d && a.length < 2)) throw new ShErr('missing operand', 1);
  const text = await this.readAll(io);
  const s1 = trSet(a[0]);
  let out;
  if (f.d) out = [...text].filter(c => !s1.includes(c)).join('');
  else {
    const s2 = trSet(a[1]);
    out = [...text].map(c => { const k = s1.indexOf(c); return k < 0 ? c : s2[Math.min(k, s2.length - 1)]; }).join('');
    if (f.s) out = out.replace(new RegExp(`([${s2.join('').replace(/[\]\\^-]/g, '\\$&')}])\\1+`, 'g'), '$1');
  }
  io.out(out);
});

def('rev', async function (args, io) {
  const { text, st } = await this.readInputs(args, io, 'rev');
  io.out(lines(text).map(l => [...l].reverse().join('') + '\n').join(''));
  return st;
});

def('tee', async function (args, io) {
  const { f, a } = getopts(args, 'a');
  const text = await this.readAll(io);
  let st = 0;
  for (const p of a) {
    try { await this.fs.write(this.path(p), text, !!f.a); }
    catch (e) { io.err(`tee: ${p}: ${e.message}\n`); st = 1; }
  }
  io.out(text);
  return st;
});

def('touch', async function (args, io) {
  const { a } = getopts(args, 'acm');
  if (!a.length) throw new ShErr('missing file operand', 1);
  let st = 0;
  for (const p of a) {
    const abs = this.path(p);
    const n = this.fs.get(abs);
    try {
      if (n) { if (!this.fs.can(n, 2) && n.owner !== USER) throw new ShErr('Permission denied'); n.mtime = Date.now(); this.fs.changed(); }
      else await this.fs.write(abs, '');
    } catch (e) { io.err(`touch: cannot touch '${p}': ${e.message}\n`); st = 1; }
  }
  return st;
});

def('mkdir', async function (args, io) {
  const { f, a } = getopts(args, 'pv');
  if (!a.length) throw new ShErr('missing operand', 1);
  let st = 0;
  for (const p of a) {
    const abs = this.path(p);
    try {
      const segs = abs.split('/').filter(Boolean);
      for (let k = 1; k <= segs.length; k++) {
        const cur = '/' + segs.slice(0, k).join('/');
        const ex = this.fs.get(cur);
        if (ex) {
          if (k === segs.length && !f.p) throw new ShErr('File exists');
          if (ex.type !== 'dir') throw new ShErr('Not a directory');
          continue;
        }
        if (k < segs.length && !f.p) throw new ShErr('No such file or directory');
        const parent = this.fs.parentOf(cur);
        if (!this.fs.can(parent, 2)) throw new ShErr('Permission denied');
        parent.children.set(segs[k - 1], this.fs.node('dir', { owner: USER }));
        if (f.v) io.out(`mkdir: created directory '${cur}'\n`);
      }
    } catch (e) { io.err(`mkdir: cannot create directory '${p}': ${e.message}\n`); st = 1; }
  }
  this.fs.changed();
  return st;
});

def('rmdir', async function (args, io) {
  let st = 0;
  for (const p of args) {
    const abs = this.path(p);
    try {
      const n = this.fs.lookup(abs);
      if (n.type !== 'dir') throw new ShErr('Not a directory');
      if (n.children.size) throw new ShErr('Directory not empty');
      const parent = this.fs.parentOf(abs);
      if (!this.fs.can(parent, 2)) throw new ShErr('Permission denied');
      parent.children.delete(baseOf(abs));
    } catch (e) { io.err(`rmdir: failed to remove '${p}': ${e.message}\n`); st = 1; }
  }
  this.fs.changed();
  return st;
});

def('rm', async function (args, io) {
  const { f, a } = getopts(args, 'rRfiv');
  if (f['no-preserve-root'] && a.includes('/')) { /* still blocked by permissions below */ }
  if (!a.length && !f.f) throw new ShErr('missing operand', 1);
  let st = 0;
  const rec = f.r || f.R;
  for (const p of a) {
    const abs = this.path(p);
    if (abs === '/' && rec && !f['no-preserve-root']) {
      io.err("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n"); st = 1; continue;
    }
    try {
      const n = this.fs.lookup(abs);
      if (n.type === 'dir' && !rec) throw new ShErr('Is a directory');
      if (abs === '/') throw new ShErr('Permission denied');
      const parent = this.fs.parentOf(abs);
      if (!this.fs.can(parent, 2)) throw new ShErr('Permission denied');
      if (n.type === 'dir') {
        const bad = [];
        const check = (x, path) => { if (x.type === 'dir') { if (!this.fs.can(x, 2)) bad.push(path); for (const [k, c] of x.children) check(c, path + '/' + k); } };
        check(n, p);
        if (bad.length) throw new ShErr('Permission denied');
      }
      parent.children.delete(baseOf(abs));
      if (f.v) io.out(`removed '${p}'\n`);
    } catch (e) {
      if (f.f && e.message === 'No such file or directory') continue;
      io.err(`rm: cannot remove '${p}': ${e.message}\n`); st = 1;
    }
  }
  this.fs.changed();
  return st;
});

async function copyOrMove(sh, args, io, move) {
  const name = move ? 'mv' : 'cp';
  const { f, a } = getopts(args, move ? 'fivn' : 'rRfivpa');
  if (a.length < 2) throw new ShErr(a.length ? `missing destination file operand after '${a[0]}'` : 'missing file operand', 1);
  const dest = a.pop();
  const dAbs = sh.path(dest);
  const dNode = sh.fs.get(dAbs);
  if (a.length > 1 && (!dNode || dNode.type !== 'dir')) throw new ShErr(`target '${dest}' is not a directory`, 1);
  let st = 0;
  for (const s of a) {
    const sAbs = sh.path(s);
    try {
      const n = sh.fs.lookup(sAbs);
      if (!sh.fs.can(n, 4)) throw new ShErr('Permission denied');
      if (n.type === 'dir' && !move && !(f.r || f.R || f.a)) { io.err(`cp: -r not specified; omitting directory '${s}'\n`); st = 1; continue; }
      const target = dNode && dNode.type === 'dir' ? normPath(baseOf(sAbs), dAbs) : dAbs;
      if (target === sAbs) throw new ShErr(`'${s}' and '${dest}' are the same file`);
      if (n.type === 'dir' && (target + '/').startsWith(sAbs + '/')) throw new ShErr(`cannot ${move ? 'move' : 'copy'} a directory, '${s}', into itself`);
      const tParent = sh.fs.parentOf(target);
      if (!sh.fs.can(tParent, 2)) throw new ShErr(`cannot create '${dest}': Permission denied`);
      const existing = tParent.children.get(baseOf(target));
      if (existing && existing.type === 'dir' && n.type !== 'dir') throw new ShErr(`cannot overwrite directory '${dest}' with non-directory`);
      if (move) {
        const sParent = sh.fs.parentOf(sAbs);
        if (!sh.fs.can(sParent, 2)) throw new ShErr('Permission denied');
        sParent.children.delete(baseOf(sAbs));
        tParent.children.set(baseOf(target), n);
      } else {
        if (n.type === 'file' && n.content == null) await sh.fs.read(n);
        const copyAll = async x => { if (x.type === 'dir') for (const c of x.children.values()) await copyAll(c); else if (x.content == null && !x.bin) await sh.fs.read(x); };
        await copyAll(n);
        tParent.children.set(baseOf(target), sh.fs.clone(n));
      }
      if (f.v) io.out(`'${s}' -> '${target}'\n`);
    } catch (e) {
      if (!(e instanceof ShErr)) throw e;
      io.err(`${name}: ${/^cannot|'/.test(e.message) ? e.message : `cannot stat '${s}': ${e.message}`}\n`); st = 1;
    }
  }
  sh.fs.changed();
  return st;
}
def('cp', async function (args, io) { return copyOrMove(this, args, io, false); });
def('mv', async function (args, io) { return copyOrMove(this, args, io, true); });

def('find', async function (args, io) {
  const paths = [];
  let i = 0;
  while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(') paths.push(args[i++]);
  if (!paths.length) paths.push('.');
  const tests = [];
  let maxd = Infinity, mind = 0, neg = false;
  for (; i < args.length; i++) {
    const x = args[i];
    let t = null;
    if (x === '!' || x === '-not') { neg = true; continue; }
    if (x === '-name' || x === '-iname') { const re = globToRe(args[++i] || '', x === '-iname'); t = nm => re.test(nm); }
    else if (x === '-type') { const ty = args[++i]; t = (nm, n) => ty === 'd' ? n.type === 'dir' : n.type === 'file'; }
    else if (x === '-maxdepth') { maxd = +args[++i]; continue; }
    else if (x === '-mindepth') { mind = +args[++i]; continue; }
    else if (x === '-empty') t = (nm, n) => n.type === 'dir' ? n.children.size === 0 : this.fs.size(n) === 0;
    else if (x === '-print') continue;
    else throw new ShErr(`unknown predicate \`${x}'`, 1);
    if (neg) { const inner = t; t = (...q) => !inner(...q); neg = false; }
    tests.push(t);
  }
  let st = 0;
  const out = [];
  const walk = (p, n, depth) => {
    const nm = depth === 0 ? baseOf(p) : baseOf(p);
    if (depth >= mind && tests.every(t => t(nm, n, p))) out.push(p);
    if (n.type === 'dir' && depth < maxd) {
      if (!this.fs.can(n, 5)) { io.err(`find: '${p}': Permission denied\n`); st = 1; return; }
      for (const k of [...n.children.keys()].sort(byName)) walk((p.endsWith('/') ? p : p + '/') + k, n.children.get(k), depth + 1);
    }
  };
  for (const p of paths) {
    const n = this.fs.get(this.path(p));
    if (!n) { io.err(`find: '${p}': No such file or directory\n`); st = 1; continue; }
    walk(p, n, 0);
  }
  io.out(unlines(out));
  return st;
});

def('tree', async function (args, io) {
  const { f, a } = getopts(args, 'adf', 'L');
  const color = io.tty;
  const max = f.L ? +f.L : Infinity;
  let nd = 0, nf = 0;
  const out = [];
  const nm = (name, n) => color && n.type === 'dir' ? C.dir + name + C.reset : color && n.mode & 0o111 ? C.exe + name + C.reset : name;
  const walk = (n, prefix, depth, path) => {
    if (depth >= max) return;
    if (!this.fs.can(n, 5)) { out[out.length - 1] += '  [error opening dir]'; return; }
    let ents = [...n.children].filter(([k, c]) => (f.a || k[0] !== '.') && (!f.d || c.type === 'dir')).sort((x, y) => byName(x[0], y[0]));
    ents.forEach(([k, c], idx) => {
      const last = idx === ents.length - 1;
      out.push(prefix + (last ? '└── ' : '├── ') + nm(f.f ? path + '/' + k : k, c));
      if (c.type === 'dir') { nd++; walk(c, prefix + (last ? '    ' : '│   '), depth + 1, path + '/' + k); } else nf++;
    });
  };
  const targets = a.length ? a : ['.'];
  for (const t of targets) {
    const n = this.fs.get(this.path(t));
    if (!n) { out.push(`${t}  [error opening dir]`); continue; }
    out.push(color ? C.dir + t + C.reset : t);
    if (n.type === 'dir') walk(n, '', 0, t);
  }
  out.push('', `${nd} director${nd === 1 ? 'y' : 'ies'}` + (f.d ? '' : `, ${nf} file${nf === 1 ? '' : 's'}`));
  io.out(unlines(out));
});

function tzName(d) { try { return d.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop(); } catch (e) { return 'UTC'; } }
def('date', async function (args, io) {
  const d = new Date();
  const fmt = args.find(x => x.startsWith('+'));
  if (!fmt) {
    io.out(`${WDAY[d.getDay()]} ${MON[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${tzName(d)} ${d.getFullYear()}\n`);
    return;
  }
  const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const fullM = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  io.out(fmt.slice(1).replace(/%([YmdHMSaAbBjsZyeIpnTDF%])/g, (m, c) => ({
    Y: d.getFullYear(), y: pad2(d.getFullYear() % 100), m: pad2(d.getMonth() + 1), d: pad2(d.getDate()), e: String(d.getDate()).padStart(2),
    H: pad2(d.getHours()), I: pad2((d.getHours() % 12) || 12), p: d.getHours() < 12 ? 'AM' : 'PM', M: pad2(d.getMinutes()), S: pad2(d.getSeconds()),
    a: WDAY[d.getDay()], A: full[d.getDay()], b: MON[d.getMonth()], B: fullM[d.getMonth()], Z: tzName(d), n: '\n', '%': '%',
    j: String(Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5)).padStart(3, '0'), s: Math.floor(d / 1000),
    T: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`, D: `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${pad2(d.getFullYear() % 100)}`,
    F: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
  })[c]) + '\n');
});

def('whoami', async function (args, io) { io.out(USER + '\n'); });
def('id', async function (args, io) { io.out('uid=1000(matt) gid=1000(matt) groups=1000(matt),100(users)\n'); });
def('groups', async function (args, io) { io.out('matt users\n'); });
def('hostname', async function (args, io) {
  const n = this.fs.get('/etc/hostname');
  io.out((n ? (await this.fs.read(n)).trim() : HOST_FALLBACK) + '\n');
});
def('uname', async function (args, io) {
  const { f } = getopts(args, 'asnrvmo');
  const host = this.get('HOSTNAME');
  const parts = { s: 'Linux', n: host, r: '6.8.0-portfolio', v: '#1 SMP PREEMPT_DYNAMIC', m: 'x86_64', o: 'GNU/Linux' };
  const keys = f.a ? ['s', 'n', 'r', 'v', 'm', 'o'] : ['s', 'n', 'r', 'v', 'm', 'o'].filter(k => f[k]);
  io.out((keys.length ? keys : ['s']).map(k => parts[k]).join(' ') + '\n');
});
function uptimeStr(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}:${pad2(m % 60)}`;
}
def('uptime', async function (args, io) {
  const d = new Date();
  if (args[0] === '-p') { io.out(`up ${uptimeStr(Date.now() - this.booted).replace(/^(\d+):(\d+)$/, '$1 hours, $2 minutes')}\n`); return; }
  io.out(` ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} up ${uptimeStr(Date.now() - this.booted)},  1 user,  load average: 0.00, 0.01, 0.05\n`);
});
def('seq', async function (args, io) {
  const { f, a } = getopts(args, 'w', 's');
  const n = a.map(Number);
  if (!a.length || n.some(isNaN)) throw new ShErr(a.length ? `invalid floating point argument: '${a.find(x => isNaN(+x))}'` : 'missing operand', 1);
  const [first, step, last] = n.length === 1 ? [1, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : n;
  if (step === 0) throw new ShErr("invalid Zero increment value: '0'", 1);
  const out = [];
  for (let x = first, k = 0; step > 0 ? x <= last : x >= last; x += step, k++) {
    out.push(String(x));
    if (k > 100000) break;
  }
  io.out(out.join(f.s != null ? f.s : '\n') + (out.length ? '\n' : ''));
});
def('basename', async function (args, io) {
  if (!args.length) throw new ShErr('missing operand', 1);
  let b = baseOf(args[0]);
  if (args[1] && b.endsWith(args[1]) && b !== args[1]) b = b.slice(0, -args[1].length);
  io.out(b + '\n');
});
def('dirname', async function (args, io) {
  if (!args.length) throw new ShErr('missing operand', 1);
  const p = args[0].replace(/\/+$/, '') || '/';
  const i = p.lastIndexOf('/');
  io.out((i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i)) + '\n');
});
def('sleep', async function (args) {
  if (!args.length) throw new ShErr('missing operand', 1);
  const secs = args.reduce((t, x) => { const m = /^(\d*\.?\d+)([smh]?)$/.exec(x); if (!m) throw new ShErr(`invalid time interval '${x}'`, 1); return t + +m[1] * ({ '': 1, s: 1, m: 60, h: 3600 })[m[2]]; }, 0);
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) { await new Promise(r => setTimeout(r, Math.min(100, end - Date.now()))); this.checkInt(); }
});
def('stat', async function (args, io) {
  if (!args.length) throw new ShErr('missing operand', 1);
  let st = 0;
  for (const p of args) {
    try {
      const n = this.fs.lookup(this.path(p));
      const d = new Date(n.mtime);
      const ts = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      const uid = n.owner === USER ? '1000/    matt' : '   0/    root';
      io.out(`  File: ${p}\n  Size: ${String(this.fs.size(n)).padEnd(15)} Blocks: ${String(Math.ceil(this.fs.size(n) / 512)).padEnd(10)} IO Block: 4096   ${n.type === 'dir' ? 'directory' : 'regular file'}\n` +
        `Access: (0${(n.mode & 0o7777).toString(8).padStart(3, '0')}/${modeStr(n)})  Uid: (${uid})   Gid: (${uid})\nModify: ${ts}\n`);
    } catch (e) { io.err(`stat: cannot statx '${p}': ${e.message}\n`); st = 1; }
  }
  return st;
});
def('file', async function (args, io) {
  let st = 0;
  for (const p of args) {
    const n = this.fs.get(this.path(p));
    let desc;
    if (!n) { desc = "cannot open (No such file or directory)"; st = 1; }
    else if (n.type === 'dir') desc = n.mode & 0o1000 ? 'sticky, directory' : 'directory';
    else if (n.bin) desc = 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, stripped';
    else if (!this.fs.can(n, 4)) desc = 'regular file, no read permission';
    else {
      const t = await this.fs.read(n);
      if (!t.length) desc = 'empty';
      else if (t.startsWith('#!/bin/bash') || t.startsWith('#!/usr/bin/env bash')) desc = 'Bourne-Again shell script, ASCII text executable';
      else if (/^\s*[{[]/.test(t)) { try { JSON.parse(t); desc = 'JSON text data'; } catch (e) { desc = 'ASCII text'; } }
      else desc = /[^\x00-\x7f]/.test(t) ? 'Unicode text, UTF-8 text' : 'ASCII text';
    }
    io.out(`${p}: ${desc}\n`);
  }
  return st;
});
def('chmod', async function (args, io) {
  const a = args.filter(x => x !== '-R');
  if (a.length < 2) throw new ShErr('missing operand', 1);
  const spec = a.shift();
  let st = 0;
  for (const p of a) {
    try {
      const n = this.fs.lookup(this.path(p));
      if (n.owner !== USER) throw new ShErr('Operation not permitted');
      if (/^[0-7]{3,4}$/.test(spec)) n.mode = parseInt(spec, 8);
      else for (const cl of spec.split(',')) {
        const m = /^([ugoa]*)([-+=])([rwxt]*)$/.exec(cl);
        if (!m) throw new ShErr(`invalid mode: '${spec}'`);
        const who = m[1] && m[1] !== 'a' ? m[1] : 'ugo';
        let bits = 0;
        for (const w of who) { const sh = { u: 6, g: 3, o: 0 }[w]; for (const q of m[3]) bits |= ({ r: 4, w: 2, x: 1, t: 0 })[q] << sh; }
        if (m[2] === '+') n.mode |= bits; else if (m[2] === '-') n.mode &= ~bits; else n.mode = (n.mode & ~0o777) | bits;
      }
      n.mtime = Date.now();
    } catch (e) { io.err(`chmod: ${e.message.startsWith('invalid') ? e.message : `changing permissions of '${p}': ${e.message}`}\n`); st = 1; }
  }
  this.fs.changed();
  return st;
});
def('base64', async function (args, io) {
  const { f, a } = getopts(args, 'dw', '');
  const { text, st } = await this.readInputs(a, io, 'base64');
  if (f.d) {
    let bin;
    try { bin = atob(text.replace(/\s+/g, '')); } catch (e) { throw new ShErr('invalid input', 1); }
    io.out(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } else {
    const bytes = new TextEncoder().encode(text);
    let s = ''; for (const b of bytes) s += String.fromCharCode(b);
    io.out((btoa(s).match(/.{1,76}/g) || ['']).join('\n') + '\n');
  }
  return st;
});
def('sed', async function (args, io) {
  const { f, a } = getopts(args, 'niE', 'e');
  const script = f.e || a.shift();
  if (!script) throw new ShErr('no script specified', 1);
  const m = /^s(.)(.*?)\1(.*?)\1([gip0-9]*)$/.exec(script);
  if (!m) throw new ShErr(`-e expression #1, char 1: unknown command: \`${script[0]}'`, 1);
  let re;
  try { re = new RegExp(toJsRe(m[2], f.E), (m[4].includes('g') ? 'g' : '') + (m[4].includes('i') ? 'i' : '')); }
  catch (e) { throw new ShErr('-e expression #1: invalid regular expression', 1); }
  const rep = m[3].replace(/\$/g, '$$$$').replace(/\\(\d)/g, '$$$1').replace(/(^|[^\\])&/g, '$1$$&').replace(/\\&/g, '&').replace(/\\n/g, '\n');
  const apply = t => lines(t).map(l => { const hit = (re.lastIndex = 0, re.test(l)); re.lastIndex = 0; const r = l.replace(re, rep); return f.n ? (hit && m[4].includes('p') ? r + '\n' : '') : r + '\n'; }).join('');
  if (f.i) {
    for (const p of a) {
      const n = this.fs.get(this.path(p));
      if (!n) { io.err(`sed: can't read ${p}: No such file or directory\n`); continue; }
      await this.fs.write(this.path(p), apply(await this.fs.read(n)));
    }
    return;
  }
  const { text, st } = await this.readInputs(a, io, 'sed');
  io.out(apply(text));
  return st;
});
def('xargs', async function (args, io) {
  const items = (await this.readAll(io)).split(/\s+/).filter(Boolean);
  const cmd = args.length ? args : ['echo'];
  return this.invoke(cmd.concat(items), { in: null, out: io.out, err: io.err, tty: io.tty });
});
def('env printenv', async function (args, io, name) {
  if (name === 'printenv' && args.length) { let st = 0; for (const k of args) { if (this.vars.has(k) && this.exported.has(k)) io.out(this.vars.get(k) + '\n'); else st = 1; } return st; }
  io.out([...this.exported].sort().filter(k => this.vars.has(k)).map(k => `${k}=${this.vars.get(k)}\n`).join(''));
});
def('which', async function (args, io) {
  let st = 0;
  for (const a of args) { const p = this.resolveCmd(a); if (p) io.out(p + '\n'); else st = 1; }
  return st;
});
def('clear', async function () { this.env.clear(); });
def('code vim vi nano', async function (args, io, name) {
  if (!args.length) { if (name === 'code') return; throw new ShErr('opening an empty buffer is not supported here; try: ' + name + ' README.md', 1); }
  let st = 0;
  for (const p of args) {
    const abs = this.path(p);
    const n = this.fs.get(abs);
    if (n && n.type === 'dir') { this.env.revealDir(abs); continue; }
    if (!n) { io.err(`${name}: ${p}: No such file\n`); st = 1; continue; }
    if (!this.fs.can(n, 4)) { io.err(`${name}: ${p}: Permission denied\n`); st = 1; continue; }
    await this.env.openFile(abs);
  }
  if (name !== 'code' && !st) io.out(`(opened in the editor above; ${name} itself isn't installed here)\n`);
  return st;
});
def('open xdg-open', async function (args, io) {
  if (!args.length) throw new ShErr('missing URL or file', 1);
  for (const x of args) {
    if (/^https?:\/\//.test(x)) io.out(`${x}\n`);
    else { const n = this.fs.get(this.path(x)); if (n && n.type === 'file') await this.env.openFile(this.path(x)); else io.err(`open: ${x}: not found\n`); }
  }
});
def('blog', async function (args, io) {
  if (!this.env.goBlog) { io.err('blog: not available here\n'); return 1; }
  io.out('opening ~/blog …\n');
  this.env.goBlog();
});
def('sudo', async function (args, io) {
  if (!args.length) throw new ShErr('usage: sudo command', 1);
  for (let k = 0; k < 3; k++) {
    const pw = await this.env.readLine(`[sudo] password for ${USER}: `, { secret: true });
    if (pw == null) break;
    if (k < 2) io.err('Sorry, try again.\n');
  }
  io.err(`${USER} is not in the sudoers file.  This incident will be reported.\n`);
  return 1;
});
def('su', async function (args, io) {
  const pw = await this.env.readLine('Password: ', { secret: true });
  if (pw == null) return 1;
  await new Promise(r => setTimeout(r, 1200));
  io.err('su: Authentication failure\n');
  return 1;
});
def('bash sh', async function (args, io, name) {
  if (args[0] === '-c') return this.execList(parse(args.slice(1).join(' ')), io);
  if (args[0] === '--version') { io.out(`GNU bash, version ${VERSION} (x86_64-pc-linux-gnu)\n`); return; }
  if (!args.length) { io.out("(you're already in bash)\n"); return; }
  const n = this.fs.get(this.path(args[0]));
  if (!n) throw new ShErr(`${args[0]}: No such file or directory`, 127);
  if (n.type === 'dir') throw new ShErr(`${args[0]}: Is a directory`, 126);
  return this.runScript(await this.fs.read(n), args.slice(1), io, args[0]);
});
def('man', async function (args, io) {
  if (!args.length) { io.err('What manual page do you want?\nFor example, try \'man ls\'.\n'); return 1; }
  const desc = MAN[args[0]];
  if (!desc) { io.err(`No manual entry for ${args[0]}\n`); return 16; }
  io.out(`\x1b[1m${args[0].toUpperCase()}(1)\x1b[0m\n\n\x1b[1mNAME\x1b[0m\n       ${args[0]} - ${desc}\n\n(this system ships short pages only; try '${args[0]} --help' on a real box)\n`);
});
def('ping', async function (args, io) { io.err('ping: socket: Operation not permitted (this machine lives in a browser tab)\n'); return 2; });
def('curl wget ssh', async function (args, io, name) { io.err(`${name}: network access is disabled in this sandbox\n`); return 6; });

def('theme', async function (args, io) {
  const T = this.env.themes;
  if (!T) throw new ShErr('themes are unavailable here', 1);
  if (args[0] === '-p' || args[0] === 'pick') { T.pick(); return; }
  if (args[0] === '-h' || args[0] === '--help') {
    io.out('usage: theme             list themes (* = current)\n       theme NAME        switch (fuzzy: "tokyo", "one dark")\n       theme -p          open the theme picker\n');
    return;
  }
  if (!args.length) {
    const cur = T.current().id;
    let lastType = null;
    const out = [];
    for (const t of T.list()) {
      if (t.type !== lastType) { if (lastType) out.push(''); out.push(`\x1b[90m${t.type} themes\x1b[0m`); lastType = t.type; }
      out.push(t.id === cur ? `\x1b[1;32m* ${t.name}\x1b[0m` : `  ${t.name}`);
    }
    io.out(out.join('\n') + '\n');
    return;
  }
  const t = T.set(args.join(' '));
  if (!t) throw new ShErr(`no theme matching '${args.join(' ')}' (run 'theme' to list them)`, 1);
  io.out(`theme: ${t.name}\n`);
});

def('neofetch fastfetch', async function (args, io) {
  let pretty = 'Linux';
  const osr = this.fs.get('/etc/os-release');
  if (osr) { const m = /PRETTY_NAME="([^"]*)"/.exec(await this.fs.read(osr)); if (m) pretty = m[1]; }
  const host = (await (async () => { const n = this.fs.get('/etc/hostname'); return n ? (await this.fs.read(n)).trim() : HOST_FALLBACK; })());
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const scr = typeof screen !== 'undefined' ? `${screen.width}x${screen.height}` : 'unknown';
  const logo = [
    '███╗   ███╗██╗  ██╗',
    '████╗ ████║██║ ██╔╝',
    '██╔████╔██║█████╔╝ ',
    '██║╚██╔╝██║██╔═██╗ ',
    '██║ ╚═╝ ██║██║  ██╗',
    '╚═╝     ╚═╝╚═╝  ╚═╝',
  ];
  const o = '\x1b[33m', b = '\x1b[1;33m', r = '\x1b[0m';
  const info = [
    `${b}${USER}${r}@${b}${host}${r}`,
    '-'.repeat(USER.length + host.length + 1),
    `${b}OS${r}: ${pretty}`,
    `${b}Host${r}: ${browser}`,
    `${b}Kernel${r}: 6.8.0-portfolio`,
    `${b}Uptime${r}: ${uptimeStr(Date.now() - this.booted)}`,
    `${b}Shell${r}: bash ${VERSION.split('(')[0]} (JavaScript)`,
    `${b}Resolution${r}: ${scr}`,
    `${b}Theme${r}: ${this.env.themes ? this.env.themes.current().name : 'Gruvbox Material'}`,
    `${b}Font${r}: Consolas`,
    '',
    [30, 31, 32, 33, 34, 35, 36, 37].map(c => `\x1b[${c + 10}m   `).join('') + r,
    [90, 91, 92, 93, 94, 95, 96, 97].map(c => `\x1b[${c + 10}m   `).join('') + r,
  ];
  const narrow = this.env.cols() < 52;
  const out = [];
  if (narrow) { out.push(...logo.map(l => o + l + r), '', ...info); }
  else for (let k = 0; k < Math.max(logo.length, info.length); k++) out.push(`${o}${(logo[k] || '').padEnd(21)}${r}  ${info[k] || ''}`);
  io.out(out.join('\n') + '\n');
});

def('ghcontrib', async function (args, io) {
  const user = args[0] || 'mattkoco';
  let data;
  try { data = await this.env.contrib(user); }
  catch (e) { throw new ShErr(`could not reach GitHub for '${user}' (only mattkoco has an offline snapshot)`, 1); }
  const days = data.contributions;
  const LV = (this.env.contribColors ? this.env.contribColors().map(h => h.slice(1)) : ['3a3735', '4a5131', '6b7a3a', '8a9a4e', 'a9b665']).map(h => `\x1b[38;2;${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4), 16)}m`);
  const first = new Date(days[0].date + 'T00:00:00');
  const offset = first.getDay();
  const totalWeeks = Math.ceil((days.length + offset) / 7);
  const weeks = Math.max(8, Math.min(totalWeeks, this.env.cols() - 5));
  const startCol = totalWeeks - weeks;
  const grid = Array.from({ length: 7 }, () => Array(totalWeeks).fill(null));
  days.forEach((d, k) => { const idx = k + offset; grid[idx % 7][Math.floor(idx / 7)] = d; });
  let header = '    ', lastMonth = -1;
  for (let c = startCol; c < totalWeeks; c++) {
    const d = grid.map(r => r[c]).find(Boolean);
    const mo = d ? new Date(d.date + 'T00:00:00').getMonth() : -1;
    const at = 4 + (c - startCol);
    if (mo !== lastMonth && header.length < at && at + 3 <= 4 + weeks) header = header.padEnd(at) + MON[mo];
    lastMonth = mo;
  }
  const labels = ['   ', 'Mon', '   ', 'Wed', '   ', 'Fri', '   '];
  const rows = grid.map((r, k) => labels[k] + ' ' + r.slice(startCol).map(d => d ? LV[d.level] + '■' : ' ').join('') + '\x1b[0m');
  const legend = `    \x1b[90mLess\x1b[0m ${LV.map(c => c + '■').join('')}\x1b[0m \x1b[90mMore\x1b[0m`;
  const total = days.reduce((t, d) => t + d.count, 0);
  io.out([header.slice(0, 4 + weeks), ...rows, '', legend, '',
    `${total} contributions in the last year` + (data.live ? '' : ` \x1b[90m(snapshot from ${data.fetched})\x1b[0m`)].join('\n') + '\n');
});

const MAN = {
  ls: 'list directory contents', cat: 'concatenate files and print on the standard output', grep: 'print lines that match patterns',
  cd: 'change the working directory', head: 'output the first part of files', tail: 'output the last part of files',
  wc: 'print newline, word, and byte counts for each file', sort: 'sort lines of text files', uniq: 'report or omit repeated lines',
  find: 'search for files in a directory hierarchy', tree: 'list contents of directories in a tree-like format',
  sed: 'stream editor for filtering and transforming text', base64: 'base64 encode/decode data and print to standard output',
  echo: 'display a line of text', mkdir: 'make directories', rm: 'remove files or directories', cp: 'copy files and directories',
  mv: 'move (rename) files', touch: 'change file timestamps', chmod: 'change file mode bits', bash: 'GNU Bourne-Again SHell',
  neofetch: 'a fast, highly customizable system info script', ghcontrib: 'draw a GitHub contribution graph', theme: 'switch the color theme of this window', blog: 'open the blog',
  tr: 'translate or delete characters', cut: 'remove sections from each line of files', tee: 'read from standard input and write to standard output and files',
  xargs: 'build and execute command lines from standard input', man: 'an interface to the system reference manuals',
};

/* ================================================================ */
/* boot                                                             */
/* ================================================================ */

async function buildFS(manifestUrl, base) {
  const fs = new VFS();
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error('could not load ' + manifestUrl);
  const man = await res.json();
  for (const f of man.files) fs.addFile(f.p, { src: base + f.p.slice(1), size: f.s, mode: f.m, owner: f.o, mtime: f.t || Date.now() });
  // directories that come from the manifest inherit ownership by location
  fs.mkdirp('/home/matt');
  fs.mkdirp('/tmp').mode = 0o1777;
  const rootHome = fs.mkdirp('/root'); rootHome.mode = 0o700;
  rootHome.children.set('.bashrc', fs.node('file', { content: '', mode: 0o644 }));
  const dev = fs.mkdirp('/dev');
  dev.children.set('null', fs.node('file', { content: '', mode: 0o666 }));
  const bin = fs.mkdirp('/bin');
  for (const n of ['bash', 'sh']) bin.children.set(n, fs.node('file', { bin: n, mode: 0o755, size: 1446024 }));
  const usr = fs.mkdirp('/usr/bin');
  for (const n of Object.keys(CMDS)) if (n !== 'bash' && n !== 'sh') usr.children.set(n, fs.node('file', { bin: n, mode: 0o755, size: 30000 + (n.length * 7919) % 120000 }));
  fs.mkdirp('/usr/local/bin');
  fs.mkdirp('/var/log');
  // directories inside /home/matt belong to matt
  const fix = (n, path) => { if (n.type === 'dir') { if (path.startsWith(HOME)) n.owner = USER; for (const [k, c] of n.children) fix(c, path + '/' + k); } };
  fix(fs.root, '');
  fs.root.children.get('home').owner = 'root';
  return fs;
}

global.Bash = { Shell, VFS, Stream, buildFS, parse, lex, Incomplete, ExitSig, Interrupt, ShErr, normPath, HOME, USER };

})(typeof window !== 'undefined' ? window : globalThis);
