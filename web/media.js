import { h, copyText } from './util.js';
import { mediaKind } from '../shared/media.js';
import { openInVsCode, VSCODE_ICON } from './vscode.js';

export { mediaKind };

const basename = (p) => String(p).replace(/\/+$/, '').split('/').pop() || p;
const ICONS = { pdf: '▤', image: '▣', video: '▶', audio: '♪' };
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const clock = (s) => { if (!Number.isFinite(s)) return ''; const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

/**
 * A PDF, image, video or audio file in a tab, here or on a project's host, shown by the browser itself: its
 * PDF viewer, an image, a player. The file is watched while the tab is in view (every couple of seconds here,
 * less often over ssh) and shown again when it changes, so a PDF or image a build writes stays current.
 */
export class MediaPanel {
  constructor(app, project) {
    this.app = app;
    this.project = project;
    this.element = h('div', { class: 'mv', tabindex: '-1' });
  }

  init(params) {
    this.api = params.api;
    this.file = { ...params.params };
    this.kind = mediaKind(this.file.path);
    this.project.panels.set(this.api.id, this);
    const btn = (act, title, label) => h('button', { class: 'tp-btn', 'data-act': act, title }, label);
    this.nameEl = h('span', { class: 'tp-name' });
    this.pathEl = h('span', { class: 'tp-cwd' });
    this.infoEl = h('span', { class: 'np-status' });
    this.body = h('div', { class: `mv-body mv-${this.kind}` });
    this.element.replaceChildren(
      h('div', { class: 'tp-bar' }, h('span', { class: 'fv-icon' }, ICONS[this.kind] || '▤'), this.nameEl, this.pathEl, this.infoEl, h('span', { class: 'tp-spacer' }),
        btn('reload', 'Reload', '↻'),
        btn('open', 'Open in a browser tab', '↗'),
        Object.assign(h('button', { class: 'tp-btn tp-vscode', 'data-act': 'vscode', title: 'Open in VS Code' }), { innerHTML: VSCODE_ICON }),
        btn('copy-path', 'Copy path', '⧉'),
        btn('tabs', 'Show the tab bar', '▭'),
        btn('max', 'Maximize / restore', '⤢'),
        btn('close', 'Close', '×')),
      this.body);
    this.element.addEventListener('click', (e) => {
      const act = e.target.closest('.tp-bar [data-act]')?.dataset.act;
      if (act) { e.preventDefault(); this.action(act); }
    });
    this.renderHead();
    this.load();
    // Watched while in view: a changed file is shown again.
    this.timer = setInterval(() => { if (this.api.isVisible && document.visibilityState === 'visible') this.check(); }, this.file.host ? 10000 : 2000);
  }

  where() { return `${this.file.host ? `${this.file.user ? `${this.file.user}@` : ''}${this.file.host}:` : ''}${this.file.path}`; }

  renderHead() {
    this.nameEl.textContent = basename(this.file.path);
    this.pathEl.textContent = this.where();
    this.pathEl.title = this.where();
  }

  query() {
    const f = this.file;
    return new URLSearchParams({ path: f.path, host: f.host || '', user: f.user || '', dir: f.dir || '' });
  }

  /** The file's bytes, with its modification time so a changed file is not taken from the cache. */
  url() { return `/api/files/raw?${this.query()}&v=${this.stat?.mtime || 0}-${this.stat?.size || 0}`; }

  renderInfo(extra = '') {
    this.infoEl.textContent = [this.kind === 'pdf' ? 'PDF' : this.kind, this.stat ? size(this.stat.size) : '', extra].filter(Boolean).join(' · ');
  }

  async load() {
    this.infoEl.textContent = 'loading…';
    try {
      this.stat = await this.app.client.api('GET', `/api/files/stat?${this.query()}`);
    } catch (e) {
      this.infoEl.textContent = '';
      this.body.replaceChildren(h('div', { class: 'tp-missing' }, h('p', {}, e.message), h('button', { class: 'btn small', onclick: () => this.load() }, 'Try again')));
      return;
    }
    if (!this.file.host && this.stat.path !== this.file.path) { this.file.path = this.stat.path; this.api.updateParameters({ ...this.file }); this.renderHead(); }
    this.renderInfo();
    this.show();
  }

  /** The viewer for the kind of file: the browser's PDF viewer, an image, a player. */
  show() {
    const src = this.url();
    if (this.kind === 'pdf') {
      if (!this.frame) { this.frame = h('iframe', { class: 'mv-frame', title: basename(this.file.path) }); this.body.replaceChildren(this.frame); }
      this.frame.src = src;
    } else if (this.kind === 'image') {
      if (!this.img) {
        this.img = h('img', { class: 'mv-img fit', alt: basename(this.file.path), title: 'Click for actual size / fit' });
        this.img.addEventListener('click', () => this.img.classList.toggle('fit'));
        this.img.addEventListener('load', () => this.renderInfo(`${this.img.naturalWidth} × ${this.img.naturalHeight}`));
        this.img.addEventListener('error', () => this.renderInfo('could not be shown'));
        this.body.replaceChildren(this.img);
      }
      this.img.src = src;
    } else {
      // A file that changed under a player picks up where it was.
      const was = this.player ? { time: this.player.currentTime, paused: this.player.paused } : null;
      if (!this.player) {
        this.player = h(this.kind, { class: `mv-${this.kind}-el`, controls: true, preload: 'metadata' });
        this.player.addEventListener('loadedmetadata', () => {
          const p = this.player;
          this.renderInfo([clock(p.duration), this.kind === 'video' && p.videoWidth ? `${p.videoWidth} × ${p.videoHeight}` : ''].filter(Boolean).join(' · '));
          if (this.resume) { p.currentTime = this.resume.time; if (!this.resume.paused) p.play().catch(() => {}); this.resume = null; }
        });
        this.player.addEventListener('error', () => this.renderInfo('this browser cannot play it'));
        this.body.replaceChildren(this.player);
      }
      this.resume = was;
      this.player.src = src;
    }
  }

  /** Shown again when the file has changed since. */
  async check() {
    if (this.checking || !this.stat) return;
    this.checking = true;
    try {
      const st = await this.app.client.api('GET', `/api/files/stat?${this.query()}`).catch(() => null);
      if (st && (st.mtime !== this.stat.mtime || st.size !== this.stat.size)) { this.stat = st; this.renderInfo(); this.show(); }
    } finally { this.checking = false; }
  }

  /** Opened again from another mention of the same file. (Not `update`: dockview calls that on its renderers.) */
  reopen(file) {
    this.file = { ...this.file, ...file };
    this.check();
  }

  action(act) {
    switch (act) {
      case 'reload': this.load(); break;
      case 'vscode': openInVsCode(this.app, this.file); break;
      case 'open': window.open(this.url(), '_blank', 'noopener'); break;
      case 'copy-path': copyText(this.file.path).then((ok) => this.app.ui.toast(ok ? 'Path copied' : 'The browser blocked the clipboard', ok ? 'info' : 'error')); break;
      case 'max': this.toggleMaximize(); break;
      case 'close': this.app.dock.closePanel(this.api.id); break;
      default: break;
    }
  }

  toggleMaximize() { if (this.api.isMaximized()) this.api.exitMaximized(); else this.api.maximize(); }
  toggleSearch() {}
  restart() { this.load(); }
  focus() { (this.player || this.element).focus({ preventScroll: true }); }
  dispose() {
    clearInterval(this.timer);
    this.player?.pause();
    this.project.panels.delete(this.api?.id);
  }
}
