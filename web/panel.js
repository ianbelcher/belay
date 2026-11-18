import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { h, shortPath, copyText, findPaths } from './util.js';
import { resolveLocal } from './file.js';
import { displayChord, IS_MAC } from './keys.js';
import { openInVsCode } from './vscode.js';

/** A web link from a terminal, in a tab of its own: in the app, the browser (the app hands it over). */
const openLink = (uri) => window.open(uri, '_blank', 'noopener');

export const XTERM_THEMES = {
  dark: {
    background: '#0f1115', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#0f1115', selectionBackground: '#3b4b6b',
    black: '#1b1f27', red: '#ef6b73', green: '#8fd18b', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d8dee9',
    brightBlack: '#5c6370', brightRed: '#f28b82', brightGreen: '#a5e3a1', brightYellow: '#f0d08a', brightBlue: '#7cc0ff', brightMagenta: '#d7a1f0', brightCyan: '#7fd1dc', brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#ffffff', selectionBackground: '#b6d6ff',
    black: '#1f2328', red: '#cf222e', green: '#116329', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#7d4e00', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
};
const MAX_WEBGL = 8;
let webglCount = 0;

/** A dockview content renderer hosting one xterm.js instance bound to one belay session. */
export class TerminalPanel {
  constructor(app, project) {
    this.app = app;
    this.project = project;
    this.element = h('div', { class: 'tp' });
    this.disposables = [];
    this.attached = false;
    this.pending = new Set();
  }

  init(params) {
    this.api = params.api;
    this.containerApi = params.containerApi;
    this.sid = params.params?.sessionId;
    this.project.panels.set(this.api.id, this);
    const s = this.app.client.session(this.sid);
    if (!s) { this.renderMissing(); return; }
    this.build();
    this.createTerminal();
    this.disposables.push(
      this.api.onDidVisibilityChange((e) => { if (e.isVisible) this.scheduleFit(); }),
      this.api.onDidActiveChange((e) => { if (e.isActive) this.term.focus(); }),
      this.api.onDidDimensionsChange(() => this.scheduleFit()),
    );
    this.ro = new ResizeObserver(() => this.scheduleFit());
    this.ro.observe(this.termEl);
    this.unsubMsg = this.app.client.onSession(this.sid, (m) => this.onMsg(m));
    this.unsubState = this.app.client.on('session', (e) => { if (e.detail.id === this.sid) this.renderStatus(e.detail); });
    this.unsubSettings = this.app.client.on('settings', () => this.applySettings());
    this.renderStatus(s);
    this.scheduleFit();
  }

  build() {
    const btn = (act, title, label) => h('button', { class: 'tp-btn', 'data-act': act, title }, label);
    this.dot = h('span', { class: 'tp-dot' });
    this.nameEl = h('span', { class: 'tp-name', title: 'Edit session' });
    this.cwdEl = h('span', { class: 'tp-cwd' });
    // The connection to the session's host: back soon (reconnecting), or none to keep (plain ssh).
    this.linkEl = h('span', { class: 'tp-link hidden' });
    this.titleEl = h('span', { class: 'tp-title' });
    this.bar = h('div', { class: 'tp-bar' },
      this.dot, this.nameEl, this.cwdEl, this.linkEl, this.titleEl, h('span', { class: 'tp-spacer' }),
      (this.starBtn = btn('star', 'Star: first in the Sessions list', '☆')),
      btn('here', 'New shell beside this one', '>_'),
      btn('search', 'Find', '⌕'),
      btn('restart', 'Restart', '↻'),
      btn('stop', 'Stop', '■'),
      btn('edit', 'Edit session', '✎'),
      btn('tabs', 'Show the tab bar', '▭'),
      btn('max', 'Maximize / restore', '⤢'),
      btn('close', 'Remove from project', '×'),
    );
    this.searchInput = h('input', { class: 'tp-search-input', placeholder: 'Find', spellcheck: 'false' });
    this.searchBar = h('div', { class: 'tp-search hidden' }, this.searchInput,
      h('button', { class: 'tp-btn', 'data-act': 'find-prev', title: 'Previous (Shift+Enter)' }, '↑'),
      h('button', { class: 'tp-btn', 'data-act': 'find-next', title: 'Next (Enter)' }, '↓'),
      h('button', { class: 'tp-btn', 'data-act': 'find-close', title: 'Close (Esc)' }, '×'));
    this.termEl = h('div', { class: 'tp-term' });
    this.exitMsg = h('span', { class: 'tp-exit-msg' });
    this.exitBar = h('div', { class: 'tp-exit hidden' }, this.exitMsg,
      h('button', { class: 'btn small primary', 'data-act': 'restart' }, 'Restart'),
      h('button', { class: 'btn small', 'data-act': 'close' }, 'Remove from project'));
    this.element.replaceChildren(this.bar, this.searchBar, this.termEl, this.exitBar);

    this.element.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      e.preventDefault();
      this.action(act);
    });
    this.nameEl.addEventListener('click', () => this.action('edit'));
    this.bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) this.toggleMaximize(); });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.find(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); this.toggleSearch(false); }
    });
    this.searchInput.addEventListener('input', () => this.find(1, true));
  }

  createTerminal() {
    const st = this.app.settings();
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: st.cursorBlink !== false,
      fontSize: st.fontSize || 13,
      fontFamily: st.fontFamily || '"JetBrains Mono", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      scrollback: st.clientScrollback || 50000,
      theme: XTERM_THEMES[st.theme] || XTERM_THEMES.dark,
      macOptionIsMeta: true,
      scrollOnUserInput: true,
      minimumContrastRatio: 1,
      // Links a program marks as such (OSC 8; Claude's are): opened as the links in the text are, with no
      // question first. xterm's own way asks, then opens an empty window to point at the link, which the app
      // sends to the browser while it is still empty.
      linkHandler: { activate: (e, uri) => { if (!e || e.button === 0) openLink(uri); }, allowNonHttpProtocols: false },
    });
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((e, uri) => { if (!e || e.button === 0) openLink(uri); }));
    this.term.registerLinkProvider({ provideLinks: (y, cb) => { this.fileLinks(y).then(cb, () => cb(undefined)); } });
    // File links look like links all the time, not only under the mouse.
    this.linkDecos = new Map();
    this.term.onWriteParsed(() => this.scheduleLinkScan());
    this.term.onScroll(() => this.scheduleLinkScan());
    // Programs set the clipboard with OSC 52; Claude's /copy does when it has no clipboard tool, as in a container.
    this.term.parser.registerOscHandler(52, (data) => { this.oscCopy(data); return true; });
    this.term.open(this.termEl);
    this.tryWebgl();
    this.term.onData((d) => this.app.client.send({ t: 'input', sid: this.sid, data: d }));
    this.term.onSelectionChange(() => {
      if (this.app.settings().copyOnSelect && this.term.hasSelection()) copyText(this.term.getSelection());
    });
    this.term.onBell(() => this.flash());
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.termEl.addEventListener('contextmenu', (e) => {
      // On a file link: where to open it.
      if (this.hoverLink) {
        e.preventDefault();
        const f = this.hoverLink;
        this.app.ui.showMenu([
          ['Open in belay', () => this.app.dock.openFile(f)],
          ['Open in VS Code', () => openInVsCode(this.app, f), 'Option-click'],
          ['Copy path', () => copyText(f.path)],
        ], e);
        return;
      }
      if (!this.app.settings().rightClickPaste) return;
      e.preventDefault();
      if (this.term.hasSelection()) { copyText(this.term.getSelection()); this.term.clearSelection(); return; }
      navigator.clipboard?.readText?.().then((t) => { if (t) this.term.paste(t); }).catch(() => {});
    });
  }

  /**
   * File links in some lines ({ y, text }, y 1-based): paths that open in a file tab. Local ones count only when
   * they are files, resolved from the session's directory; on a remote host, any path with a slash, read over
   * ssh when clicked. Returns a map from y to [{ index, text, line, file }].
   */
  async findFileLinks(lines) {
    const s = this.app.client.session(this.sid);
    const out = new Map();
    if (!s) return out;
    const found = lines.map(({ y, text }) => ({ y, list: findPaths(text) })).filter((l) => l.list.length);
    if (!found.length) return out;
    const remote = s.vars?.host;
    const abs = remote ? null : await resolveLocal(this.app, s.cwd, [...new Set(found.flatMap((l) => l.list.map((f) => f.path)))]);
    for (const { y, list } of found) {
      const links = remote
        ? list.filter((f) => f.path.includes('/')).map((f) => ({ ...f, file: { path: f.path, host: remote, user: s.vars.user || '', dir: s.vars.dir || '' } }))
        : list.filter((f) => abs[f.path]).map((f) => ({ ...f, file: { path: abs[f.path] } }));
      if (links.length) out.set(y, links);
    }
    return out;
  }

  /** The link provider: what is under the mouse in row y opens a file tab when clicked. */
  async fileLinks(y) {
    const text = this.term?.buffer.active.getLine(y - 1)?.translateToString(true);
    if (!text) return undefined;
    const found = (await this.findFileLinks([{ y, text }])).get(y);
    if (!found) return undefined;
    return found.map((f) => ({
      range: { start: { x: f.index + 1, y }, end: { x: f.index + f.text.length, y } },
      text: f.text,
      decorations: { underline: true, pointerCursor: true },
      // A click opens it here; Option/Alt+click in VS Code. Right-click asks (see the contextmenu handler).
      // xterm calls this for any button; only the left one opens (the right one has its menu).
      activate: (e) => { if (e && e.button !== 0) return; if (e?.altKey) openInVsCode(this.app, { ...f.file, line: f.line }); else this.app.dock.openFile({ ...f.file, line: f.line }); },
      hover: () => { this.hoverLink = { ...f.file, line: f.line }; },
      leave: () => { this.hoverLink = null; },
    }));
  }

  scheduleLinkScan() {
    clearTimeout(this.linkT);
    this.linkT = setTimeout(() => this.scanLinks().catch(() => {}), 150);
  }

  /** Underline and color the file links on screen. Lines are rescanned when their text changes. */
  async scanLinks() {
    const term = this.term;
    if (!term || !this.project.isActive() || term.buffer.active.type !== 'normal') return;
    const b = term.buffer.active;
    const changed = [];
    for (let y = b.viewportY; y < b.viewportY + term.rows; y++) {
      const text = b.getLine(y)?.translateToString(true) ?? '';
      if (this.linkDecos.get(y)?.text !== text) changed.push({ y: y + 1, text });
    }
    if (!changed.length) return;
    const links = await this.findFileLinks(changed);
    if (this.term !== term) return;
    const color = XTERM_THEMES[this.app.settings().theme === 'light' ? 'light' : 'dark'].brightBlue;
    for (const { y, text } of changed) {
      const row = y - 1;
      if ((b.getLine(row)?.translateToString(true) ?? '') !== text) continue; // rewritten meanwhile; the next scan has it
      this.linkDecos.get(row)?.decos.forEach((d) => d.dispose());
      const decos = [];
      const list = links.get(y);
      if (list) {
        const marker = term.registerMarker(row - (b.baseY + b.cursorY));
        for (const f of list) {
          const d = marker && term.registerDecoration({ marker, x: f.index, width: f.text.length, foregroundColor: color });
          if (d) { d.onRender((el) => el.classList.add('fl-deco')); decos.push(d); }
        }
        if (marker) decos.push(marker);
      }
      this.linkDecos.set(row, { text, decos });
    }
    // Forget lines far above the screen; their decorations scroll away with them.
    for (const row of this.linkDecos.keys()) if (row < b.viewportY - 2000) this.linkDecos.delete(row);
  }

  clearLinkDecos() {
    for (const { decos } of this.linkDecos?.values() || []) decos.forEach((d) => d.dispose());
    this.linkDecos?.clear();
  }

  /** OSC 52: put text on the clipboard, from the pane you are looking at only (every browser and project sees the output). */
  oscCopy(data) {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!b64 || b64 === '?' || !this.project.isActive() || !document.hasFocus()) return;
    let text;
    try { text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return; }
    copyText(text).then((ok) => {
      if (ok) this.app.ui.toast(`Copied ${text.length} character${text.length === 1 ? '' : 's'}`, 'info');
      else this.app.ui.toast('The browser blocked the clipboard.', 'error', { label: 'Copy', fn: () => copyText(text) });
    });
  }

  tryWebgl() {
    if (webglCount >= MAX_WEBGL) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => { addon.dispose(); this.webgl = null; webglCount--; });
      this.term.loadAddon(addon);
      this.webgl = addon;
      webglCount++;
    } catch { this.webgl = null; }
  }

  onKey(e) {
    if (this.app.keys.match(e)) return false; // handled at document level
    const seq = this.keySequence(e);
    if (seq) {
      if (e.type === 'keydown') { e.preventDefault(); this.term.input(seq); }
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      if (e.type === 'keydown' && this.term.hasSelection()) { copyText(this.term.getSelection()); e.preventDefault(); }
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') return false; // let the browser paste
    return true;
  }

  /**
   * Keys xterm.js sends nothing useful for. Shift+Enter is a plain CR, so in an agent's pane (its template,
   * or hooks reporting activity) it sends ESC CR, the newline in Claude Code, Codex and opencode; bash
   * leaves ESC CR unbound, so a shell keeps Enter.
   * xterm.js drops Cmd+arrows; on macOS Cmd+Left / Right go to the start / end of the line, as in iTerm2.
   */
  keySequence(e) {
    if (e.isComposing) return null;
    const mods = `${e.ctrlKey ? 'C' : ''}${e.altKey ? 'A' : ''}${e.shiftKey ? 'S' : ''}${e.metaKey ? 'M' : ''}`;
    if (e.key === 'Enter' && mods === 'S') { const s = this.app.client.session(this.sid); return s?.activity || s?.agent ? '\x1b\r' : null; }
    if (IS_MAC && mods === 'M') return { ArrowLeft: '\x01', ArrowRight: '\x05' }[e.key] || null;
    return null;
  }

  scheduleFit() {
    if (this.fitRaf || !this.term) return;
    this.fitRaf = requestAnimationFrame(() => { this.fitRaf = 0; this.doFit(); });
  }

  doFit() {
    if (!this.term || !this.element.isConnected || this.termEl.clientWidth < 20 || this.termEl.clientHeight < 10) return;
    const dims = this.fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 1) return;
    const changed = dims.cols !== this.term.cols || dims.rows !== this.term.rows;
    if (changed) this.fit.fit();
    this.termEl.classList.add('ready');
    if (!this.attached) {
      this.attached = true;
      this.app.client.attach(this.sid, this.term.cols, this.term.rows);
    } else if (changed && this.project.isActive()) {
      this.sendSize();
    }
  }

  /** The pty takes the size of the pane you are looking at: a project in the background does not resize it. */
  sendSize() { this.app.client.send({ t: 'resize', sid: this.sid, cols: this.term.cols, rows: this.term.rows }); }
  /** Its project came to the front. */
  onShow() { if (this.attached && this.term) this.sendSize(); this.scheduleFit(); this.scheduleLinkScan(); }

  /** Called after the websocket reconnects: ask for a fresh replay. */
  reattach() { this.attached = false; this.scheduleFit(); }

  onMsg(m) {
    switch (m.t) {
      case 'replay':
        this.clearLinkDecos();
        this.term.reset();
        if (m.cols && m.rows && (m.cols !== this.term.cols || m.rows !== this.term.rows)) this.term.resize(m.cols, m.rows);
        this.term.write(m.data);
        break;
      case 'data': this.term.write(m.data); break;
      case 'exit': break; // status arrives via the session event
      case 'error': this.app.ui.toast(m.message); break;
      default: break;
    }
  }

  renderStatus(s) {
    this.session = s;
    this.dot.dataset.status = s.status;
    this.dot.title = s.status === 'running' ? `running, pid ${s.pid}` : s.status;
    this.nameEl.textContent = s.name;
    this.starBtn.textContent = s.starred ? '★' : '☆';
    this.starBtn.classList.toggle('on', !!s.starred);
    this.starBtn.title = s.starred ? 'Unstar' : 'Star: first in the Sessions list';
    // A remote session works on its host; the local directory it was started from says nothing.
    this.cwdEl.textContent = s.host ? `${s.host}:${s.dir || '~'}` : shortPath(s.cwd, this.app.client.state.server.home);
    this.cwdEl.title = `${s.host ? `on ${s.host}, in ${s.dir || '~'}` : s.cwd}\n${s.command || ''}`;
    this.linkEl.classList.toggle('hidden', !s.link || (s.status !== 'running' && s.status !== 'starting'));
    this.linkEl.dataset.link = s.link || '';
    this.linkEl.textContent = s.link === 'reconnecting' ? 'reconnecting…' : s.link === 'connecting' ? 'connecting…' : s.link === 'plain' ? 'not held' : '';
    this.linkEl.title = s.link === 'reconnecting'
      ? `The connection to ${s.host} dropped. The session carries on there; belay catches up when it is back.\n${s.linkNote || ''}`
      : s.linkNote || '';
    this.titleEl.textContent = s.title && s.title !== s.name ? s.title : '';
    if (this.api.title !== s.name) this.api.setTitle(s.name);
    const running = s.status === 'running' || s.status === 'starting';
    this.exitBar.classList.toggle('hidden', running);
    this.exitMsg.textContent = s.status === 'stopped' ? 'Stopped' : `Exited with code ${s.exitCode}`;
    this.bar.querySelector('[data-act="stop"]').disabled = !running || this.pending.has('stop');
  }

  renderMissing() {
    this.element.replaceChildren(
      h('div', { class: 'tp-missing' },
        h('p', {}, 'This session no longer exists.'),
        h('button', { class: 'btn small' , onclick: () => this.api.close() }, 'Remove from project')));
  }

  async action(act) {
    const { client, ui, dock } = this.app;
    try {
      switch (act) {
        case 'search': this.toggleSearch(); break;
        case 'find-next': this.find(1); break;
        case 'find-prev': this.find(-1); break;
        case 'find-close': this.toggleSearch(false); break;
        case 'restart': await this.restart(); break;
        case 'stop': await this.busy('stop', () => client.api('POST', `/api/sessions/${this.sid}/stop`)); break;
        case 'edit': ui.openSessionEditor(this.app, this.sid); break;
        case 'here': await ui.openHere(this.app, 'shell', { from: this.sid, group: this.api.group }); break;
        case 'star': await client.api('PATCH', `/api/sessions/${this.sid}`, { starred: !this.session?.starred }); break;
        case 'max': this.toggleMaximize(); break;
        case 'close': this.api.close(); break;
        default: break;
      }
    } catch (e) { ui.toast(e.message); }
    void dock;
  }

  restart() {
    return this.busy('restart', async () => { await this.app.client.api('POST', `/api/sessions/${this.sid}/restart`); this.term?.focus(); });
  }

  /** Runs a slow pane action once at a time, with a spinner on its buttons in the bar and the exit bar. */
  async busy(act, fn) {
    if (this.pending.has(act)) return;
    this.pending.add(act);
    const btns = [...this.element.querySelectorAll(`[data-act="${act}"]`)];
    for (const b of btns) { b.classList.add('busy'); b.disabled = true; }
    try { await fn(); } catch (e) { this.app.ui.toast(e.message); }
    finally {
      this.pending.delete(act);
      for (const b of btns) { b.classList.remove('busy'); b.disabled = false; }
      if (this.term && this.session) this.renderStatus(this.session);
    }
  }

  toggleMaximize() {
    if (this.api.isMaximized()) this.api.exitMaximized(); else this.api.maximize();
    this.scheduleFit();
    setTimeout(() => this.term?.focus(), 0);
  }

  toggleSearch(force) {
    const show = force ?? this.searchBar.classList.contains('hidden');
    this.searchBar.classList.toggle('hidden', !show);
    this.scheduleFit();
    if (show) { this.searchInput.focus(); this.searchInput.select(); }
    else { this.search.clearDecorations?.(); this.term.focus(); }
  }

  find(dir, incremental = false) {
    const q = this.searchInput.value;
    if (!q) { this.search.clearDecorations?.(); return; }
    const opts = { incremental, decorations: { matchOverviewRuler: '#4c8dff', activeMatchColorOverviewRuler: '#ffb454', matchBackground: '#3b4b6b', activeMatchBackground: '#705a2a' } };
    if (dir < 0) this.search.findPrevious(q, opts); else this.search.findNext(q, opts);
  }

  flash() {
    // Again from the start when bells come quickly: the class comes off, a reflow, and back on.
    clearTimeout(this.flashT);
    this.element.classList.remove('tp-flash');
    void this.element.offsetWidth;
    this.element.classList.add('tp-flash');
    this.flashT = setTimeout(() => this.element.classList.remove('tp-flash'), 450);
  }

  applySettings() {
    if (!this.term) return;
    const st = this.app.settings();
    this.term.options.fontSize = st.fontSize || 13;
    if (st.fontFamily) this.term.options.fontFamily = st.fontFamily;
    this.term.options.cursorBlink = st.cursorBlink !== false;
    this.term.options.scrollback = st.clientScrollback || 50000;
    this.term.options.theme = XTERM_THEMES[st.theme] || XTERM_THEMES.dark;
    this.clearLinkDecos();
    this.scheduleLinkScan();
    this.scheduleFit();
  }

  focus() { this.term?.focus(); }
  layout() { this.scheduleFit(); }

  dispose() {
    this.project.panels.delete(this.api?.id);
    for (const d of this.disposables) d.dispose?.();
    this.ro?.disconnect();
    clearTimeout(this.linkT);
    this.clearLinkDecos();
    this.unsubMsg?.(); this.unsubState?.(); this.unsubSettings?.();
    if (this.attached) this.app.client.detach(this.sid);
    if (this.webgl) { webglCount--; this.webgl = null; }
    this.term?.dispose();
    this.term = null;
  }
}

/** Shown when a project is empty. */
export class Watermark {
  constructor(app) {
    this.app = app;
    this.element = h('div', { class: 'watermark' },
      h('div', { class: 'watermark-box' },
        h('h2', {}, 'Nothing here yet'),
        h('p', {}, 'Start a shell or an agent for this project, or open an existing session.'),
        h('div', { class: 'row' },
          ...app.ui.launchers(app).map((t) => h('button', { class: `btn${t.builtin && t.id !== 'command' ? ' primary' : ''}`, onclick: () => app.ui.openHere(app, t.id) }, app.ui.launcherLabel(t))),
          h('button', { class: 'btn', onclick: () => app.side?.toggle('sessions', true) }, 'Open existing'),
          h('button', { class: 'btn', onclick: () => app.dock.showNotes().catch((e) => app.ui.toast(e.message)) }, 'Notes'),
          h('button', { class: 'btn', onclick: () => app.dock.showWall().catch((e) => app.ui.toast(e.message)) }, 'Post-its')),
        h('p', { class: 'hint' }, `${displayChord(app.keys.bindings('palette')[0] || 'Ctrl+Shift+P')} opens the command palette`)));
  }
  init() {}
  dispose() {}
}
