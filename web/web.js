import { h } from './util.js';

/** An http(s) URL, or null: nothing else (javascript:, data:, file:) may be loaded into a tab. */
export function webUrl(s) {
  try {
    const u = new URL(String(s).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

// Chords that mean nothing to a page tab stay with the page: its own find, for one.
const PAGE_OWN = new Set(['find']);
const SIGN_IN_MS = 9 * 60 * 1000; // a little under the server's ten minutes

/**
 * One web page in a tab, set in the tab's settings: no address bar, no history. The frame is sandboxed
 * without top navigation, so a page cannot take over belay's window.
 *
 * A web page (`url`) loads in this browser, as any page would. A remote page (`address`, `remote`) is opened
 * from the machine the project works on, this one or its host over ssh, and served by belay: `localhost:8080`
 * means that machine's port 8080, and names resolve there, cluster services included.
 */
export class WebPanel {
  constructor(app, project) {
    this.app = app;
    this.project = project;
    // Focusable itself, so a page tab can hold the keyboard for belay without handing it to the page.
    this.element = h('div', { class: 'wv', tabindex: '-1' });
  }

  init(params) {
    this.api = params.api;
    this.web = { ...params.params };
    this.project.panels.set(this.api.id, this);
    const btn = (act, title, label) => h('button', { class: 'tp-btn', 'data-act': act, title }, label);
    this.iconEl = h('span', { class: 'fv-icon' });
    this.titleEl = h('span', { class: 'tp-name', title: 'Edit' });
    this.urlEl = h('span', { class: 'tp-cwd' });
    this.frame = h('iframe', {
      class: 'wv-frame',
      referrerpolicy: 'no-referrer',
      allow: 'clipboard-read; clipboard-write; fullscreen',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads',
    });
    // The parent sees the pointer enter the frame; a page that takes the focus without it did so by itself.
    this.frame.addEventListener('pointerenter', () => { this.hover = true; });
    this.frame.addEventListener('pointerleave', () => { this.hover = false; });
    this.errorEl = h('div', { class: 'wv-error hidden' });
    this.element.replaceChildren(
      h('div', { class: 'tp-bar' }, this.iconEl, this.titleEl, this.urlEl, h('span', { class: 'tp-spacer' }),
        btn('reload', 'Reload', '↻'),
        btn('open', 'Open in a browser tab', '↗'),
        btn('edit', 'Edit', '✎'),
        btn('tabs', 'Show the tab bar', '▭'),
        btn('max', 'Maximize / restore', '⤢'),
        btn('close', 'Close', '×')),
      h('div', { class: 'wv-body' }, this.frame, this.errorEl));
    this.element.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) { e.preventDefault(); this.action(act); }
    });
    this.titleEl.addEventListener('click', () => this.action('edit'));
    this.render(true);
  }

  get remote() { return !!this.web.remote; }

  /** Where a remote page is opened from: the project's host, or this machine. */
  via() {
    const v = this.project.view || {};
    return v.host ? { host: v.host, user: v.user || '' } : { host: '', user: '' };
  }

  whereText() {
    const { host, user } = this.via();
    return host ? `on ${user ? `${user}@` : ''}${host}` : 'on the belay machine';
  }

  render(load) {
    this.iconEl.textContent = this.remote ? '⇆' : '◍';
    this.titleEl.textContent = this.web.title;
    const shown = this.remote ? `${this.web.address} · ${this.whereText()}` : this.web.url;
    this.urlEl.textContent = shown;
    this.urlEl.title = this.remote ? `${shown}\nOpened from the project's machine and served by belay` : shown;
    if (this.api.title !== this.web.title) this.api.setTitle(this.web.title);
    if (load) this.navigate();
  }

  /** Signs this browser in to a remote page (the link lasts ten minutes): fresh, or the last one while it is good. */
  async signIn(fresh = false) {
    if (!fresh && this.page && Date.now() - this.pageAt < SIGN_IN_MS && this.pageVia === JSON.stringify(this.via())) return this.page;
    this.page = await this.app.client.api('POST', '/api/pages', { address: this.web.address, ...this.via() });
    this.pageAt = Date.now();
    this.pageVia = JSON.stringify(this.via());
    return this.page;
  }

  async navigate() {
    this.showError(null);
    if (!this.remote) { this.frame.src = webUrl(this.web.url) || 'about:blank'; return; }
    try {
      const p = await this.signIn(true);
      // Assigning src navigates again; a cross-origin frame cannot be told to reload.
      this.frame.src = p.url;
    } catch (e) {
      this.frame.src = 'about:blank';
      this.showError(e.message);
    }
  }

  showError(msg) {
    this.errorEl.classList.toggle('hidden', !msg);
    this.errorEl.replaceChildren(...(msg ? [h('p', {}, msg), h('button', { class: 'btn small', onclick: () => this.navigate() }, 'Try again')] : []));
  }

  /** New settings from the tab's dialog. (Not `update`: dockview calls that on its renderers when parameters change.) */
  setWeb(web) {
    const reload = web.url !== this.web.url || web.address !== this.web.address || !!web.remote !== this.remote;
    this.web = { title: web.title, ...(web.remote ? { address: web.address, remote: true } : { url: web.url }) };
    this.api.updateParameters({ ...this.web });
    this.render(reload);
  }

  /** The project moved to another host: a remote page now opens from there. */
  onProjectChange() { if (this.remote) this.render(true); }

  /** Tell a remote page which chords are belay's, so it hands them back (the script belay serves into it asks). */
  sendChords() {
    if (!this.remote || !this.page || !this.frame.contentWindow) return;
    const chords = [...this.app.keys.map.entries()].filter(([, id]) => !PAGE_OWN.has(id)).map(([c]) => c);
    this.frame.contentWindow.postMessage({ belay: 'chords', chords }, this.page.origin);
  }

  async action(act) {
    switch (act) {
      case 'reload': this.navigate(); break;
      case 'open': {
        if (!this.remote) { window.open(this.web.url, '_blank', 'noopener'); break; }
        // Opened before any await, or the browser counts it as a popup nobody asked for.
        const w = window.open('about:blank', '_blank');
        try { const p = await this.signIn(); if (w) { w.opener = null; w.location = p.url; } } catch (e) { w?.close(); this.app.ui.toast(e.message); }
        break;
      }
      case 'edit': this.app.ui.openWebDialog(this.app, { panelId: this.api.id }); break;
      case 'max': this.toggleMaximize(); break;
      case 'close': this.app.dock.closePanel(this.api.id); break;
      default: break;
    }
  }

  applySettings() { this.sendChords(); }
  toggleMaximize() { if (this.api.isMaximized()) this.api.exitMaximized(); else this.api.maximize(); }
  toggleSearch() {}
  restart() { this.action('reload'); }
  /** The tab, not the page: belay's keys keep working until you click into the page. */
  focus() { this.element.focus({ preventScroll: true }); }
  dispose() { this.project.panels.delete(this.api?.id); }
}

/**
 * Page tabs and the keyboard. A page that takes the focus by itself (on load, say) gives it back, since a
 * focused frame keeps every key from belay. And a remote page hands back belay's chords: belay serves a small
 * script into it that sends them here while it has the focus.
 */
export function installPageKeys(app) {
  const paneOf = (frame) => app.allPanels().find((p) => p.frame && p.frame === frame);
  const guard = () => setTimeout(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLIFrameElement) || !el.classList.contains('wv-frame')) return;
    const pane = paneOf(el);
    if (!pane || pane.hover) return;
    (app.activePanel() || pane).focus();
  }, 0);
  // The frame element takes the focus in this document as its page does; the window losing it is the fallback.
  document.addEventListener('focusin', (e) => { if (e.target instanceof HTMLIFrameElement) guard(); });
  window.addEventListener('blur', guard);
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.belay !== 'string') return;
    const pane = app.allPanels().find((p) => p.remote && p.frame?.contentWindow === e.source);
    if (!pane || !pane.page || e.origin !== pane.page.origin) return;
    if (d.belay === 'hello') pane.sendChords();
    else if (d.belay === 'key' && typeof d.chord === 'string' && document.activeElement === pane.frame) {
      const id = app.keys.map.get(d.chord);
      if (id && !PAGE_OWN.has(id)) app.keys.run(id);
    }
  });
}
