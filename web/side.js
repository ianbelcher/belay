import { h } from './util.js';
import { displayChord } from './keys.js';

const PREFS_KEY = 'belay.side';
const WIDTH_MIN = 240;
const widthMax = () => Math.max(WIDTH_MIN, Math.round(innerWidth * 0.7));

function readPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch {}
  return { pinned: !!p.pinned, width: Number(p.width) || 360, view: p.view || 'sessions' };
}

/**
 * The sidebar on the left: a rail of buttons, one per view (sessions, files), and the panel the chosen view
 * fills. It opens over the layout and closes when you click elsewhere, or stays beside the layout when pinned;
 * its right edge drags to resize it. A view is { id, title, icon (SVG), command, render(el, force), refresh(),
 * tick(), rail(button, badge), headButtons() }.
 */
export class SideBar {
  constructor(app, views) {
    this.app = app;
    this.prefs = readPrefs();
    this.el = document.getElementById('side');
    this.railEl = document.getElementById('rail');
    this.views = new Map();
    this.buttons = new Map();
    for (const v of views) {
      this.views.set(v.id, v);
      const badge = h('span', { class: 'rail-badge hidden' });
      const btn = h('button', { class: 'rail-btn', 'data-side': v.id, title: v.title });
      btn.innerHTML = v.icon;
      btn.append(badge);
      btn.addEventListener('click', () => this.toggle(v.id));
      this.railEl.append(btn);
      this.buttons.set(v.id, { btn, badge });
    }
    if (!this.views.has(this.prefs.view)) this.prefs.view = views[0].id;
    // Over the layout it closes when you go elsewhere; pinned it stays.
    document.addEventListener('mousedown', (e) => {
      if (this.open && !this.prefs.pinned && !this.el.contains(e.target) && !this.railEl.contains(e.target) && !e.target.closest?.('#ctx-menu, .modal-backdrop')) this.toggle(null, false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.open && !this.prefs.pinned && this.el.contains(document.activeElement)) this.toggle(null, false); });
    this.open = false;
    if (this.prefs.pinned) this.toggle(this.prefs.view, true);
    else this.renderRail();
  }

  get pinned() { return this.prefs.pinned; }
  get view() { return this.views.get(this.prefs.view); }
  savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch {} }

  /**
   * A rail button: opens its view, switches to it, or (already showing) closes the sidebar. `force` true opens
   * and false closes, whatever is showing. No id means the view showing now.
   */
  toggle(id = null, force) {
    const want = id || this.prefs.view;
    const showing = this.open && want === this.prefs.view;
    this.open = force ?? !showing;
    if (this.open && want !== this.prefs.view) { this.prefs.view = want; this.savePrefs(); }
    this.el.classList.toggle('hidden', !this.open);
    this.el.classList.toggle('floating', !this.prefs.pinned);
    clearInterval(this.ticker);
    if (this.open) {
      this.render();
      this.ticker = setInterval(() => this.view.tick?.(), 1000);
    } else this.app.activePanel()?.focus();
    this.renderRail();
  }

  /** After a choice made in the sidebar: over the layout, it gets out of the way. */
  done() { if (!this.prefs.pinned) this.toggle(null, false); }

  setPinned(on) {
    this.prefs.pinned = on;
    this.savePrefs();
    this.el.classList.toggle('floating', !on);
    this.render();
  }

  /** Session events, a project switch: the views and the rail follow. */
  refresh() {
    this.renderRail();
    if (this.open) this.view.render(this.content, false);
  }

  renderRail() {
    for (const [id, { btn, badge }] of this.buttons) {
      const v = this.views.get(id);
      btn.classList.toggle('on', this.open && id === this.prefs.view);
      const key = v.command && this.app.keys?.bindings(v.command)[0];
      btn.title = `${v.title}${key ? ` (${displayChord(key)})` : ''}`;
      v.rail?.(btn, badge);
    }
  }

  /** The frame (resize edge, title, pin, close), and the view inside it. */
  render() {
    const v = this.view;
    const p = this.prefs;
    const resize = h('div', { class: 'side-resize', title: 'Drag to resize' });
    resize.addEventListener('pointerdown', (e) => this.startResize(e));
    this.content = h('div', { class: 'side-content' });
    this.el.dataset.view = v.id;
    this.el.replaceChildren(
      resize,
      h('div', { class: 'side-head' },
        h('h3', {}, v.title),
        ...(v.headButtons?.() || []),
        h('button', { class: `btn icon${p.pinned ? ' on' : ''}`, 'data-act': 'pin', title: p.pinned ? 'Unpin: open over the layout' : 'Pin beside the layout', onclick: () => this.setPinned(!p.pinned) }, '📌'),
        h('button', { class: 'btn icon', title: 'Close', onclick: () => this.toggle(null, false) }, '×')),
      this.content);
    v.render(this.content, true);
    this.el.style.width = `${Math.min(p.width, widthMax())}px`;
  }

  /** Dragging the right edge: the width follows the pointer and is remembered. */
  startResize(e) {
    e.preventDefault();
    const left = this.el.getBoundingClientRect().left;
    const move = (ev) => {
      this.prefs.width = Math.round(Math.min(widthMax(), Math.max(WIDTH_MIN, ev.clientX - left)));
      this.el.style.width = `${this.prefs.width}px`;
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('resizing'); this.savePrefs(); };
    document.body.classList.add('resizing');
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }
}
