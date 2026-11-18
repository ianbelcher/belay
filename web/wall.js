import { h, debounce, rid } from './util.js';

// The four states 🎨 steps through, as (note, text) color pairs, bright as the HUD's post-its: yellow is a
// note as usual, gray is done, green and red are for priorities. The pickers choose any other color.
export const PALETTE = [['#ffff88', '#000000'], ['#aaaaaa', '#888888'], ['#55cc55', '#000000'], ['#ff6644', '#000000']];
/** Dark text on a light note, light on a dark one. */
export const readableOn = (hex) => {
  const n = parseInt(String(hex).slice(1, 7), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? '#000000' : '#ffffff';
};
const NOTE_W = 160;
const NOTE_H = 110;
const DRAG_PX = 3;
const MINI_W = 180;
const MINI_H = 120;

/** b sits inside a (and is not the same box): a is its container, and it is part of a's group. */
export const inside = (b, a) => b !== a && b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h
  && !(b.x === a.x && b.y === a.y && b.w === a.w && b.h === a.h);

const overlap = (a, b) => !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);

/** How many of a's edges run through b: the one crossing more of the other's edges sits on top. */
function edgesCrossing(a, b) {
  const hz = (y, x1, x2) => y > b.y && y < b.y + b.h && x2 > b.x && x1 < b.x + b.w;
  const vt = (x, y1, y2) => x > b.x && x < b.x + b.w && y2 > b.y && y1 < b.y + b.h;
  return Number(hz(a.y, a.x, a.x + a.w)) + Number(hz(a.y + a.h, a.x, a.x + a.w)) + Number(vt(a.x, a.y, a.y + a.h)) + Number(vt(a.x + a.w, a.y, a.y + a.h));
}

/** Whether a is drawn over b: what sits inside is in front of what holds it; otherwise the lower one. */
function inFront(a, b) {
  if (inside(a, b)) return true;
  if (inside(b, a)) return false;
  if (overlap(a, b)) { const ca = edgesCrossing(a, b), cb = edgesCrossing(b, a); if (ca !== cb) return ca > cb; }
  return a.y > b.y;
}

/**
 * The stacking order, worked out from where the notes are, so nobody arranges layers by hand: a note is in front
 * of every note that holds it. Back to front.
 */
export function stackOrder(items) {
  const score = new Map(items.map((a) => [a, items.reduce((n, b) => n + (b !== a && inFront(a, b) ? 1 : 0), 0)]));
  return [...items].sort((a, b) => score.get(a) - score.get(b));
}

/** Everything inside a note, at any depth: what moves with it. */
const contents = (note, items) => items.filter((x) => inside(x, note));

/**
 * One project's post-it wall: notes on a board you pan and zoom. A note inside a bigger one belongs to it (the
 * bigger one becomes a heading, sits behind, and carries it when moved), so the wall arranges itself into
 * groups. Notes are kept on the server, so every browser shows the same wall; where you are looking is kept by
 * this browser.
 */
export class WallPanel {
  constructor(app, project) {
    this.app = app;
    this.project = project;
    this.element = h('div', { class: 'wl' });
    this.items = [];
    this.selected = new Set();
    this.view = { zoom: 1, x: 40, y: 40 };
  }

  init(params) {
    this.api = params.api;
    this.wallId = params.params?.wallId;
    this.project.panels.set(this.api.id, this);
    const w = this.app.client.wall(this.wallId);
    if (!w) { this.element.replaceChildren(h('div', { class: 'tp-missing' }, h('p', {}, 'This post-it wall no longer exists.'), h('button', { class: 'btn small', onclick: () => this.api.close() }, 'Close'))); return; }
    this.items = structuredClone(w.items || []);
    try { Object.assign(this.view, JSON.parse(localStorage.getItem(this.viewKey))); } catch {}
    const btn = (act, title, label, cls = '') => h('button', { class: `tp-btn ${cls}`, 'data-act': act, title }, label);
    this.titleEl = h('span', { class: 'tp-name', title: 'Rename' });
    this.statusEl = h('span', { class: 'np-status' });
    this.bgPick = h('input', { type: 'color', class: 'wl-pick', title: 'Note color' });
    this.fgPick = h('input', { type: 'color', class: 'wl-pick', title: 'Text color' });
    this.selBar = h('span', { class: 'wl-selbar hidden' },
      h('span', { class: 'wl-count' }),
      btn('cycle', 'Next color for every selected note: yellow, gray (done), green, red', '🎨'),
      this.bgPick, this.fgPick,
      btn('delete-notes', 'Delete the selected notes (Delete)', '🗑'));
    this.zoomEl = h('span', { class: 'np-status wl-zoom', title: 'Zoom: Ctrl/Cmd+scroll' });
    this.element.replaceChildren(
      h('div', { class: 'tp-bar' }, h('span', { class: 'np-icon' }, '▦'), this.titleEl, this.statusEl, h('span', { class: 'tp-spacer' }),
        this.selBar,
        btn('add', 'Add notes from a list, one per line (into the selected note, if one is selected)', '+ Notes', 'wl-add'),
        btn('fit', 'Show the whole wall', '⤧'),
        this.zoomEl,
        btn('tabs', 'Show the tab bar', '▭'),
        btn('max', 'Maximize / restore', '⤢'),
        btn('close', 'Hide (the wall is kept)', '×')));
    this.board = h('div', { class: 'wl-board', tabindex: '0' });
    this.inner = h('div', { class: 'wl-inner' });
    this.band = h('div', { class: 'wl-band hidden' });
    this.mini = h('canvas', { class: 'wl-mini', width: MINI_W, height: MINI_H, title: 'The whole wall: click or drag to go there' });
    this.board.append(this.inner, this.band, this.mini,
      h('div', { class: 'wl-hint' }, 'Double-click to add a note · drag a note into another to group it · Shift+drag to select · scroll to pan, Ctrl/Cmd+scroll to zoom'));
    this.element.append(this.board);
    this.element.addEventListener('click', (e) => {
      const act = e.target.closest('.tp-bar [data-act]')?.dataset.act;
      if (act) { e.preventDefault(); this.action(act); }
    });
    this.titleEl.addEventListener('click', () => this.action('rename'));
    // A note color brings a text color that reads on it; the text swatch can change that after.
    this.bgPick.addEventListener('input', () => { this.paint({ color: this.bgPick.value, fontColor: readableOn(this.bgPick.value) }); this.fgPick.value = readableOn(this.bgPick.value); });
    this.fgPick.addEventListener('input', () => this.paint({ fontColor: this.fgPick.value }));
    this.saveSoon = debounce(() => this.save(), 400);
    this.saveView = debounce(() => { try { localStorage.setItem(this.viewKey, JSON.stringify(this.view)); } catch {} }, 300);
    this.board.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.board.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.board.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.board.addEventListener('keydown', (e) => this.onKey(e));
    this.mini.addEventListener('pointerdown', (e) => this.onMini(e));
    this.unsub = this.app.client.on('wall', (e) => { if (e.detail.wall.id === this.wallId) this.onWall(e.detail); });
    this.unsubGone = this.app.client.on('wall-removed', (e) => { if (e.detail === this.wallId) this.api.close(); });
    this.onUnload = () => this.flush();
    window.addEventListener('beforeunload', this.onUnload);
    this.ro = new ResizeObserver(() => this.drawMini());
    this.ro.observe(this.board);
    this.renderTitle(w);
    this.render();
  }

  get viewKey() { return `belay.wall.view.${this.wallId}`; }
  byId(id) { return this.items.find((x) => x.id === id); }

  renderTitle(w = this.app.client.wall(this.wallId)) {
    if (!w) return;
    this.titleEl.textContent = w.title;
    if (this.api.title !== w.title) this.api.setTitle(w.title);
  }

  renderStatus() { this.statusEl.textContent = this.saving ? 'saving…' : this.dirty ? 'edited' : `${this.items.length} note${this.items.length === 1 ? '' : 's'}`; }

  applyView() {
    const { zoom, x, y } = this.view;
    this.inner.style.transform = `scale(${zoom}) translate(${x}px, ${y}px)`;
    this.zoomEl.textContent = `${Math.round(zoom * 100)}%`;
    this.saveView();
    this.drawMini();
  }

  /** Board coordinates of a point on screen. */
  toBoard(cx, cy) {
    const r = this.board.getBoundingClientRect();
    return { x: (cx - r.left) / this.view.zoom - this.view.x, y: (cy - r.top) / this.view.zoom - this.view.y };
  }

  /** Every note again, in stacking order. Containers get the heading style. */
  render() {
    const order = stackOrder(this.items);
    this.inner.replaceChildren(...order.map((it, i) => {
      const container = this.items.some((x) => inside(x, it));
      const el = h('div', { class: `wl-note${container ? ' container' : ''}${this.selected.has(it.id) ? ' selected' : ''}`, 'data-id': it.id },
        h('div', { class: 'wl-text' }, it.text),
        h('span', { class: 'wl-check', title: 'Select (Shift+click adds)' }),
        h('span', { class: 'wl-resize', title: 'Drag to resize' }));
      this.place(el, it);
      el.style.zIndex = String(i + 1);
      el.style.background = it.color || PALETTE[0][0];
      el.style.color = it.fontColor || PALETTE[0][1];
      return el;
    }));
    if (this.editing) this.edit(this.editing);
    this.renderSelection();
    this.renderStatus();
    this.applyView();
  }

  place(el, it) {
    el.style.left = `${it.x}px`;
    el.style.top = `${it.y}px`;
    el.style.width = `${it.w}px`;
    el.style.height = `${it.h}px`;
  }

  noteEl(id) { return this.inner.querySelector(`.wl-note[data-id="${CSS.escape(id)}"]`); }

  renderSelection() {
    for (const el of this.inner.children) el.classList.toggle('selected', this.selected.has(el.dataset.id));
    const n = this.selected.size;
    this.selBar.classList.toggle('hidden', !n);
    this.selBar.querySelector('.wl-count').textContent = `${n} selected`;
    const first = this.byId([...this.selected][0]);
    if (first) { this.bgPick.value = (first.color || PALETTE[0][0]).slice(0, 7); this.fgPick.value = (first.fontColor || PALETTE[0][1]).slice(0, 7); }
  }

  select(id, additive) {
    if (!additive) this.selected = new Set(id ? [id] : []);
    else if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.renderSelection();
  }

  changed() { this.dirty = true; this.renderStatus(); this.saveSoon(); this.drawMini(); }

  // ---- pointer: drag notes, resize, select by band, pan -----------------------------------

  onPointerDown(e) {
    if (e.button === 1 || (e.button === 0 && e.target === this.mini)) return;
    if (e.button !== 0) return;
    const noteEl = e.target.closest('.wl-note');
    if (noteEl?.querySelector('.wl-text[contenteditable]') && e.target.closest('.wl-text')) return; // typing in it
    this.board.focus({ preventScroll: true });
    if (this.editing) this.finishEdit();
    const start = { x: e.clientX, y: e.clientY };
    const at = this.toBoard(e.clientX, e.clientY);
    let moved = false;
    let onMove, onUp;
    if (noteEl && e.target.classList.contains('wl-check')) { e.preventDefault(); this.select(noteEl.dataset.id, true); return; }
    if (noteEl && e.target.classList.contains('wl-resize')) {
      const it = this.byId(noteEl.dataset.id);
      const w0 = it.w, h0 = it.h;
      onMove = (ev) => {
        if (!moved && !this.selected.has(it.id)) this.select(it.id, false);
        it.w = Math.max(40, Math.round(w0 + (ev.clientX - start.x) / this.view.zoom));
        it.h = Math.max(30, Math.round(h0 + (ev.clientY - start.y) / this.view.zoom));
        this.place(noteEl, it);
        moved = true;
      };
      onUp = () => { if (moved) { this.changed(); this.render(); } };
    } else if (noteEl) {
      const it = this.byId(noteEl.dataset.id);
      // A selected note moves with the rest of the selection; whatever sits inside a moving note goes too.
      const lead = this.selected.has(it.id) ? this.items.filter((x) => this.selected.has(x.id)) : [it];
      const moving = new Set(lead);
      for (const x of lead) for (const c of contents(x, this.items)) moving.add(c);
      const from = new Map([...moving].map((x) => [x, { x: x.x, y: x.y }]));
      onMove = (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_PX) return;
        if (!moved) {
          moved = true;
          for (const x of moving) this.noteEl(x.id)?.classList.add('dragging');
          // A note moved from outside the selection becomes the selection.
          if (!this.selected.has(it.id)) this.select(it.id, false);
        }
        const p = this.toBoard(ev.clientX, ev.clientY);
        for (const x of moving) {
          const f = from.get(x);
          x.x = Math.round(f.x + p.x - at.x);
          x.y = Math.round(f.y + p.y - at.y);
          const el = this.noteEl(x.id);
          if (el) this.place(el, x);
        }
      };
      onUp = (ev) => {
        if (moved) { this.changed(); this.render(); return; }
        this.select(it.id, ev.shiftKey || ev.metaKey || ev.ctrlKey);
      };
    } else if (e.shiftKey) {
      // A band across the board selects every note entirely inside it.
      onMove = (ev) => {
        moved = true;
        const p = this.toBoard(ev.clientX, ev.clientY);
        this.bandBox = { x: Math.min(at.x, p.x), y: Math.min(at.y, p.y), w: Math.abs(p.x - at.x), h: Math.abs(p.y - at.y) };
        const r = this.board.getBoundingClientRect();
        Object.assign(this.band.style, { left: `${Math.min(start.x, ev.clientX) - r.left}px`, top: `${Math.min(start.y, ev.clientY) - r.top}px`, width: `${Math.abs(ev.clientX - start.x)}px`, height: `${Math.abs(ev.clientY - start.y)}px` });
        this.band.classList.remove('hidden');
      };
      onUp = () => {
        this.band.classList.add('hidden');
        if (moved && this.bandBox) for (const x of this.items) if (x.x >= this.bandBox.x && x.y >= this.bandBox.y && x.x + x.w <= this.bandBox.x + this.bandBox.w && x.y + x.h <= this.bandBox.y + this.bandBox.h) this.selected.add(x.id);
        this.renderSelection();
      };
    } else {
      // Dragging the empty board pans; a click on it clears the selection.
      const v0 = { ...this.view };
      onMove = (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_PX) return;
        moved = true;
        this.board.classList.add('panning');
        this.view.x = v0.x + (ev.clientX - start.x) / this.view.zoom;
        this.view.y = v0.y + (ev.clientY - start.y) / this.view.zoom;
        this.applyView();
      };
      onUp = () => { this.board.classList.remove('panning'); if (!moved) this.select(null, false); };
    }
    e.preventDefault();
    const up = (ev) => { removeEventListener('pointermove', onMove); removeEventListener('pointerup', up); onUp(ev); };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', up);
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const before = this.toBoard(e.clientX, e.clientY);
      this.view.zoom = Math.min(3, Math.max(0.15, this.view.zoom * Math.exp(-e.deltaY * 0.0015)));
      const after = this.toBoard(e.clientX, e.clientY);
      this.view.x += after.x - before.x;
      this.view.y += after.y - before.y;
    } else {
      this.view.x -= e.deltaX / this.view.zoom;
      this.view.y -= e.deltaY / this.view.zoom;
    }
    this.applyView();
  }

  /** Double-click: on a note, edit it; on the board, a new note there. Alt+double-click puts a new note on top of one. */
  onDoubleClick(e) {
    if (e.target === this.mini) return;
    const noteEl = e.target.closest('.wl-note');
    if (noteEl && !e.altKey) { this.edit(noteEl.dataset.id); return; }
    const p = this.toBoard(e.clientX, e.clientY);
    this.addNote({ x: Math.round(p.x - NOTE_W / 2), y: Math.round(p.y - NOTE_H / 2) });
  }

  onKey(e) {
    if (e.target.isContentEditable) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected.size) { e.preventDefault(); this.deleteSelected(); }
    else if (e.key === 'Escape') { this.select(null, false); }
    else if (e.key === 'Enter' && this.selected.size === 1) { e.preventDefault(); this.edit([...this.selected][0]); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selected = new Set(this.items.map((x) => x.id)); this.renderSelection(); }
  }

  // ---- notes ------------------------------------------------------------------------------

  /** A new note at `at` (from a double-click), ready to write in. */
  addNote(at) {
    const [color, fontColor] = PALETTE[0];
    const it = { id: rid(), text: '', x: at.x, y: at.y, w: NOTE_W, h: NOTE_H, color, fontColor };
    this.items.push(it);
    this.selected = new Set([it.id]);
    this.changed();
    this.render();
    this.edit(it.id);
    return it;
  }

  /**
   * A note per line, laid out in a grid: inside the selected note, below what is there already (it grows to
   * hold them, and they take its color), or in the middle of the view. They are left selected, to move or
   * color together.
   */
  addNotes(texts) {
    if (!texts.length) return [];
    const gap = 10;
    const parent = this.selected.size === 1 ? this.byId([...this.selected][0]) : null;
    let x0, y0, cols;
    let pair = PALETTE[0];
    if (parent) {
      const kids = contents(parent, this.items);
      cols = Math.max(1, Math.min(texts.length, Math.max(3, Math.floor((parent.w - 24 + gap) / (NOTE_W + gap)))));
      x0 = parent.x + 12;
      y0 = Math.max(parent.y + 34, ...kids.map((k) => k.y + k.h + gap));
      const rows = Math.ceil(texts.length / cols);
      parent.w = Math.max(parent.w, 24 + cols * (NOTE_W + gap) - gap);
      parent.h = Math.max(parent.h, y0 - parent.y + rows * (NOTE_H + gap) - gap + 12);
      pair = PALETTE.find((p) => p[0] === parent.color) ? [parent.color, parent.fontColor || PALETTE[0][1]] : pair;
    } else {
      cols = Math.min(6, Math.ceil(Math.sqrt(texts.length)));
      const rows = Math.ceil(texts.length / cols);
      const r = this.board.getBoundingClientRect();
      const c = this.toBoard(r.left + r.width / 2, r.top + r.height / 2);
      x0 = Math.round(c.x - (cols * (NOTE_W + gap) - gap) / 2);
      y0 = Math.round(c.y - (rows * (NOTE_H + gap) - gap) / 2);
    }
    const added = texts.map((text, i) => ({
      id: rid(), text, x: x0 + (i % cols) * (NOTE_W + gap), y: y0 + Math.floor(i / cols) * (NOTE_H + gap), w: NOTE_W, h: NOTE_H, color: pair[0], fontColor: pair[1],
    }));
    this.items.push(...added);
    this.selected = new Set(added.map((x) => x.id));
    this.changed();
    this.render();
    this.board.focus({ preventScroll: true });
    return added;
  }

  /** + Notes: a list pasted in, one note per line. */
  promptNotes() {
    const { ui } = this.app;
    const into = this.selected.size === 1 ? this.byId([...this.selected][0]) : null;
    const text = h('textarea', { class: 'wl-paste', rows: 12, spellcheck: 'false', placeholder: 'One note per line\nBlank lines are skipped' });
    const lines = () => text.value.split('\n').map((l) => l.trim()).filter(Boolean);
    const ok = h('button', { class: 'btn primary', disabled: true }, 'Add notes');
    const sync = () => { const n = lines().length; ok.disabled = !n; ok.textContent = n ? `Add ${n} note${n === 1 ? '' : 's'}` : 'Add notes'; };
    const submit = () => { const l = lines(); if (!l.length) return; m.close(); this.addNotes(l); };
    text.addEventListener('input', sync);
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
    ok.addEventListener('click', submit);
    const m = ui.modal({
      title: 'Add notes', width: '480px',
      body: h('div', { class: 'form' }, text,
        h('p', { class: 'hint' }, into ? `They go into "${(into.text || 'the selected note').split('\n')[0].slice(0, 40)}", which grows to hold them.` : 'They go in the middle of the view, in a grid. Select a note first to put them inside it.')),
      footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), ok],
    });
    text.focus();
  }

  /** Typing in a note: plain text, Escape or a click elsewhere to finish. */
  edit(id) {
    const el = this.noteEl(id);
    const it = this.byId(id);
    if (!el || !it) return;
    this.editing = id;
    const t = el.querySelector('.wl-text');
    t.contentEditable = 'plaintext-only';
    el.classList.add('editing');
    t.focus();
    const r = document.createRange();
    r.selectNodeContents(t);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    t.oninput = () => { it.text = t.innerText.replace(/\n$/, ''); this.changed(); };
    t.onkeydown = (ev) => { if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) { ev.preventDefault(); ev.stopPropagation(); this.finishEdit(); this.board.focus({ preventScroll: true }); } };
    t.onblur = () => this.finishEdit();
  }

  finishEdit() {
    const id = this.editing;
    if (!id) return;
    this.editing = null;
    const el = this.noteEl(id);
    const t = el?.querySelector('.wl-text');
    if (t) { t.removeAttribute('contenteditable'); t.oninput = t.onkeydown = t.onblur = null; el.classList.remove('editing'); }
    if (this.pendingRemote) { const w = this.pendingRemote; this.pendingRemote = null; this.onWall({ wall: w, remote: true }); }
  }

  /** Colors for every selected note: a pair from the palette, or one picked. */
  paint(colors) {
    for (const id of this.selected) {
      const it = this.byId(id);
      if (!it) continue;
      Object.assign(it, colors);
      const el = this.noteEl(id);
      if (el) { el.style.background = it.color || PALETTE[0][0]; el.style.color = it.fontColor || PALETTE[0][1]; }
    }
    this.changed();
  }

  cycle() {
    const first = this.byId([...this.selected][0]);
    if (!first) return;
    const i = PALETTE.findIndex((p) => p[0] === first.color);
    const [color, fontColor] = PALETTE[(i + 1) % PALETTE.length];
    this.paint({ color, fontColor });
    this.renderSelection();
  }

  async deleteSelected() {
    const n = this.selected.size;
    if (!n) return;
    const text = this.items.filter((x) => this.selected.has(x.id)).some((x) => x.text.trim());
    if (text && n > 1 && !(await this.app.ui.confirm(`Delete ${n} notes?`, { ok: 'Delete', danger: true }))) return;
    this.items = this.items.filter((x) => !this.selected.has(x.id));
    this.selected.clear();
    this.changed();
    this.render();
    this.board.focus({ preventScroll: true });
  }

  /** The whole wall in view. */
  fit() {
    if (!this.items.length) { this.view = { zoom: 1, x: 40, y: 40 }; this.applyView(); return; }
    const b = this.bounds();
    const r = this.board.getBoundingClientRect();
    const zoom = Math.min(2, Math.max(0.15, Math.min((r.width - 60) / b.w, (r.height - 60) / b.h)));
    this.view = { zoom, x: (r.width / zoom - b.w) / 2 - b.x, y: (r.height / zoom - b.h) / 2 - b.y };
    this.applyView();
  }

  bounds() {
    const x = Math.min(...this.items.map((i) => i.x)), y = Math.min(...this.items.map((i) => i.y));
    return { x, y, w: Math.max(...this.items.map((i) => i.x + i.w)) - x, h: Math.max(...this.items.map((i) => i.y + i.h)) - y };
  }

  // ---- the preview of the whole wall ------------------------------------------------------

  miniScale() {
    const r = this.board.getBoundingClientRect();
    const vis = { x: -this.view.x, y: -this.view.y, w: r.width / this.view.zoom, h: r.height / this.view.zoom };
    const all = this.items.length ? this.bounds() : vis;
    const b = { x: Math.min(all.x, vis.x) - 40, y: Math.min(all.y, vis.y) - 40 };
    b.w = Math.max(all.x + all.w, vis.x + vis.w) + 40 - b.x;
    b.h = Math.max(all.y + all.h, vis.y + vis.h) + 40 - b.y;
    const s = Math.min(MINI_W / b.w, MINI_H / b.h);
    return { b, s, vis, ox: (MINI_W - b.w * s) / 2, oy: (MINI_H - b.h * s) / 2 };
  }

  drawMini() {
    const ctx = this.mini.getContext('2d');
    if (!ctx || !this.board.isConnected) return;
    const { b, s, vis, ox, oy } = this.miniScale();
    ctx.clearRect(0, 0, MINI_W, MINI_H);
    for (const it of stackOrder(this.items)) {
      ctx.fillStyle = it.color || PALETTE[0][0];
      ctx.fillRect(ox + (it.x - b.x) * s, oy + (it.y - b.y) * s, Math.max(1, it.w * s), Math.max(1, it.h * s));
    }
    ctx.strokeStyle = '#4c8dff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + (vis.x - b.x) * s, oy + (vis.y - b.y) * s, vis.w * s, vis.h * s);
  }

  /** A click or drag on the preview centers the view there. */
  onMini(e) {
    e.preventDefault();
    e.stopPropagation();
    const { b, s, ox, oy } = this.miniScale();
    const r = this.board.getBoundingClientRect();
    const mr = this.mini.getBoundingClientRect();
    const go = (ev) => {
      const cx = (ev.clientX - mr.left - ox) / s + b.x, cy = (ev.clientY - mr.top - oy) / s + b.y;
      this.view.x = r.width / this.view.zoom / 2 - cx;
      this.view.y = r.height / this.view.zoom / 2 - cy;
      this.applyView();
    };
    go(e);
    const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); };
    addEventListener('pointermove', go);
    addEventListener('pointerup', up);
  }

  // ---- the server ---------------------------------------------------------------------------

  async save() {
    if (!this.dirty || this.saving) return;
    this.saving = true;
    this.dirty = false;
    this.renderStatus();
    try {
      await this.app.client.api('PUT', `/api/walls/${this.wallId}`, { items: this.items, origin: this.app.client.clientId });
    } catch (e) {
      this.dirty = true;
      this.app.ui.toast(`Post-its not saved: ${e.message}`);
    } finally {
      this.saving = false;
      this.renderStatus();
      if (this.dirty) this.saveSoon();
    }
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    fetch(`/api/walls/${this.wallId}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: this.items, origin: this.app.client.clientId }) }).catch(() => {});
  }

  /** Another browser changed the wall: shown unless this one has changes of its own, or you are typing. */
  onWall({ wall, remote }) {
    this.renderTitle(wall);
    if (!remote || this.dirty) return;
    if (this.editing) { this.pendingRemote = wall; return; }
    this.items = structuredClone(wall.items || []);
    for (const id of [...this.selected]) if (!this.byId(id)) this.selected.delete(id);
    this.render();
  }

  async action(act) {
    const { ui, client } = this.app;
    switch (act) {
      case 'add': this.promptNotes(); break;
      case 'fit': this.fit(); break;
      case 'cycle': this.cycle(); break;
      case 'delete-notes': this.deleteSelected(); break;
      case 'rename': {
        const title = await ui.prompt('Rename post-it wall', client.wall(this.wallId)?.title || '', 'Title');
        if (title?.trim()) await client.api('PUT', `/api/walls/${this.wallId}`, { title }).catch((e) => ui.toast(e.message));
        break;
      }
      case 'max': this.toggleMaximize(); break;
      case 'close': this.api.close(); break;
      default: break;
    }
  }

  reattach() { const w = this.app.client.wall(this.wallId); if (w) this.onWall({ wall: w, remote: true }); }
  toggleMaximize() { if (this.api.isMaximized()) this.api.exitMaximized(); else this.api.maximize(); }
  toggleSearch() {}
  restart() {}
  focus() { this.board?.focus({ preventScroll: true }); }

  dispose() {
    this.flush();
    this.ro?.disconnect();
    this.project.panels.delete(this.api?.id);
    this.unsub?.(); this.unsubGone?.();
    window.removeEventListener('beforeunload', this.onUnload);
  }
}
