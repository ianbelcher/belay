import { h, copyText } from './util.js';
import { openInVsCode } from './vscode.js';

const ICON = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 5V14a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1H9L7.5 3.5h-4a1 1 0 0 0-1 1z"/></svg>';
const FRESH_MS = 10000;
const HOME = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3v-3.5h2V13h3V6.5"/></svg>';

/** The directory above an absolute path, or null at the top. */
export const parentDir = (p) => (p === '/' || !p.startsWith('/') ? null : p.replace(/\/[^/]+\/*$/, '') || '/');

/**
 * The files view of the sidebar: the project's directory as a tree, here or on its host over ssh. `..` goes up
 * a level, ⌂ back to the project's directory. Directories open in place; a file opens in an editor tab. Dotfiles
 * show. It follows the project in front, and remembers per project where it is and which directories are open.
 */
export class FilesView {
  constructor(app) {
    this.app = app;
    this.id = 'files';
    this.title = 'Files';
    this.icon = ICON;
    this.command = 'files';
    this.state = new Map(); // project id → { base: the directory at the top, open: Set of directories, lists: Map dir → { entries, dir, at, error } }
  }

  get bar() { return this.app.side; }

  /** Where the project's files are: its host (none: this machine) and its directory. */
  where(v = this.app.dock.activeView() || {}) {
    const host = v.host || '';
    const home = this.app.client.state.server.home || '/';
    const dir = v.dir ? (!host && /^~(\/|$)/.test(v.dir) ? home + v.dir.slice(1) : v.dir) : host ? '~' : home;
    return { host, user: host ? v.user || '' : '', root: dir.replace(/(.)\/+$/, '$1') };
  }

  stateOf(v) {
    let st = this.state.get(v.id);
    const w = this.where(v);
    const key = `${w.user}@${w.host}:${w.root}`;
    // The project is now somewhere else: start over there.
    if (!st || st.key !== key) { st = { key, base: w.root, open: new Set(), lists: new Map() }; this.state.set(v.id, st); }
    return st;
  }

  headButtons() {
    const home = h('button', { class: 'btn icon', title: "Back to the project's directory", 'data-act': 'home', onclick: () => this.home() });
    home.innerHTML = HOME;
    return [
      home,
      h('button', { class: 'btn icon', title: 'Refresh', 'data-act': 'refresh', onclick: () => { this.forget(); this.render(this.el, true); } }, '↻'),
    ];
  }

  /** Lists are fetched again on the next look. */
  forget() { const v = this.app.dock.activeView(); if (v) this.stateOf(v).lists.clear(); }

  /** A directory's entries, from the server (here, or over ssh), kept a little while. */
  async list(v, dir) {
    const st = this.stateOf(v);
    const have = st.lists.get(dir);
    if (have && (have.loading || Date.now() - have.at < FRESH_MS)) return;
    const w = this.where(v);
    st.lists.set(dir, { ...have, loading: true });
    try {
      const q = new URLSearchParams({ path: `${dir}/`, host: w.host, user: w.user, hidden: '1' });
      const r = await this.app.client.api('GET', `/api/fs/entries?${q}`);
      st.lists.set(dir, { entries: r.entries, dir: r.dir, at: Date.now() });
    } catch (e) {
      st.lists.set(dir, { entries: [], at: Date.now(), error: e.message });
    }
    if (this.app.dock.activeView()?.id === v.id && this.bar.open && this.bar.view === this) this.render(this.el, true);
  }

  /** Drawn again only when something it shows changed; lists older than a few seconds are fetched again on a `force`d draw (opening, a click), not on every event. */
  render(el = this.el, force = true) {
    this.el = el;
    const v = this.app.dock.activeView();
    if (!v || !el) return;
    const st = this.stateOf(v);
    const w = this.where(v);
    const active = this.app.dock.api?.activePanel?.params;
    const activePath = active?.path && (active.host || '') === w.host ? active.path : null;
    const sig = JSON.stringify([v.id, st.key, st.base, [...st.open], [...st.lists].map(([k, x]) => [k, x.at, x.loading]), activePath]);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    const rows = [];
    const walk = (dir, depth) => {
      const l = st.lists.get(dir);
      if (!l || (!l.entries && l.loading)) { this.list(v, dir); rows.push(h('div', { class: 'frow muted', style: `padding-left:${12 + depth * 14}px` }, 'loading…')); return; }
      if (force && Date.now() - l.at >= FRESH_MS) this.list(v, dir);
      if (l.error) { rows.push(h('div', { class: 'frow error', style: `padding-left:${12 + depth * 14}px`, title: l.error }, l.error)); return; }
      if (!l.entries.length && depth === 0) rows.push(h('div', { class: 'frow muted', style: `padding-left:${12 + depth * 14}px` }, 'empty'));
      for (const name of l.entries) {
        const isDir = name.endsWith('/');
        const n = isDir ? name.slice(0, -1) : name;
        const path = `${dir === '/' ? '' : dir}/${n}`;
        const open = isDir && st.open.has(path);
        const row = h('div', { class: `frow${isDir ? ' dir' : ''}${path === activePath ? ' active' : ''}`, style: `padding-left:${12 + depth * 14}px`, title: path, 'data-path': path },
          h('span', { class: 'ftw' }, isDir ? (open ? '▾' : '▸') : ''),
          h('span', { class: 'fname' }, n));
        row.addEventListener('click', (e) => (isDir ? this.toggleDir(v, path) : e.altKey ? this.openInVsCode(v, path) : this.openFile(v, path)));
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.app.ui.showMenu([
            ...(isDir ? [] : [['Open in belay', () => this.openFile(v, path)], ['Open in VS Code', () => this.openInVsCode(v, path), 'Option-click']]),
            ['Copy path', () => copyText(path)],
          ], e);
        });
        rows.push(row);
        if (open) walk(path, depth + 1);
      }
    };
    // `..` to the directory above, once the server has said where this one really is (~ on a host).
    const up = parentDir(st.lists.get(st.base)?.dir || st.base);
    if (up) {
      const row = h('div', { class: 'frow dir up', style: 'padding-left:12px', title: `Up to ${up}` }, h('span', { class: 'ftw' }, ''), h('span', { class: 'fname' }, '..'));
      row.addEventListener('click', () => this.up(v));
      rows.unshift(row);
    }
    walk(st.base, 0);
    const shown = `${w.host ? `${w.host}:` : ''}${st.base}`;
    // Drawn again in place: opening a directory or a file must not throw the list back to the top. A new
    // place to look (another project, .., ⌂) starts at the top.
    const at = `${v.id}\n${st.base}`;
    const prev = el.querySelector('.side-body.files');
    const keep = at !== st.scrollAt ? null : prev ? { top: prev.scrollTop, left: prev.scrollLeft } : st.scroll;
    st.scrollAt = at;
    st.scroll = keep;
    const body = h('div', { class: 'side-body files' }, h('div', { class: 'ftree' }, rows));
    // Not while hidden: a sidebar going away scrolls its list to the top on the way out.
    body.addEventListener('scroll', () => { if (body.clientHeight) st.scroll = { top: body.scrollTop, left: body.scrollLeft }; }, { passive: true });
    el.replaceChildren(
      h('div', { class: 'side-controls files-where', title: `${w.host ? `${w.user ? `${w.user}@` : ''}${w.host}:` : ''}${st.base}${st.base === w.root ? '' : `\nThe project's directory is ${w.root}`}` },
        h('span', { class: 'fproj' }, v.name), h('span', { class: `froot${st.base === w.root ? '' : ' away'}` }, h('bdi', {}, shown))),
      body);
    if (keep) { body.scrollTop = keep.top; body.scrollLeft = keep.left; } else st.scroll = null;
  }

  /** Up a level. The directory you were in shows open below, so you can see where you came from. */
  up(v) {
    const st = this.stateOf(v);
    const here = st.lists.get(st.base)?.dir || st.base;
    const parent = parentDir(here);
    if (!parent) return;
    st.open.add(here);
    st.base = parent;
    this.render(this.el, true);
  }

  /** ⌂: back to the project's directory. */
  home() {
    const v = this.app.dock.activeView();
    if (!v) return;
    this.stateOf(v).base = this.where(v).root;
    this.render(this.el, true);
  }

  toggleDir(v, path) {
    const st = this.stateOf(v);
    if (st.open.has(path)) st.open.delete(path); else st.open.add(path);
    this.render(this.el, true);
  }

  /** Where the project's files are, as a file to open: its host and directory along with the path. */
  fileAt(v, path) { const w = this.where(v); return { path, host: w.host, user: w.user, dir: '' }; }

  openInVsCode(v, path) { openInVsCode(this.app, this.fileAt(v, path)); this.bar.done(); }

  openFile(v, path) {
    const w = this.where(v);
    this.app.dock.openFile({ path, host: w.host, user: w.user, dir: '' });
    this.bar.done();
  }

  refresh() { if (this.bar.open && this.bar.view === this) this.render(this.el, false); }
}
