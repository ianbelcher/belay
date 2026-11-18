// The styled UMD build injects dockview's CSS at load time; the ESM entry ships without styles.
import { createDockview, getPanelData, themeDark, themeLight } from 'dockview-core/dist/dockview-core.js';
import { TerminalPanel, Watermark } from './panel.js';
import { NotePanel } from './note.js';
import { FilePanel } from './file.js';
import { WebPanel } from './web.js';
import { WallPanel } from './wall.js';
import { MediaPanel, mediaKind } from './media.js';
import { h, rid, shortPath } from './util.js';
import { AGENTS } from '../shared/template-core.js';

const PANEL_PREFIX = 'p-';
const NOTE_PREFIX = 'n-';
const FILE_PREFIX = 'f-';
const WEB_PREFIX = 'w-';
const WALL_PREFIX = 'b-';
const PROJECT_MIME = 'application/x-belay-project';
const pickTheme = (name) => (name === 'light' ? themeLight : themeDark);
// A file tab is the editor, or a viewer for a PDF, image, video or audio file.
const componentOf = (panelId, params) => (panelId.startsWith(NOTE_PREFIX) ? 'note' : panelId.startsWith(FILE_PREFIX) ? (mediaKind(params?.path || '') ? 'media' : 'file') : panelId.startsWith(WEB_PREFIX) ? 'web' : panelId.startsWith(WALL_PREFIX) ? 'wall' : 'terminal');
// A web page stays mounted while its tab is hidden or moved: taking an iframe out of the page reloads it. So
// does a viewer, so a PDF keeps its page and a player its place.
const rendererOf = (panelId, params) => (panelId.startsWith(WEB_PREFIX) || (panelId.startsWith(FILE_PREFIX) && mediaKind(params?.path || '')) ? 'always' : undefined);
/** Short stable id for a file: the same file opened twice is one tab. */
const fileKey = (f) => { let x = 5381; for (const c of `${f.user || ''}@${f.host || ''}:${f.host ? f.dir || '' : ''}:${f.path}`) x = ((x * 33) ^ c.charCodeAt(0)) >>> 0; return x.toString(36); };

/**
 * Custom dockview tab: name, close, and a dot only where it says something: an agent working (blue),
 * waiting for you (amber) or idle (green), or a session that has ended (red for a failure, gray otherwise).
 * A shell with output you have not looked at gets a brighter name instead. A click on the tab that is
 * already active opens its editor.
 */
class TabRenderer {
  constructor(app, project) {
    this.app = app;
    this.project = project;
    this.element = h('div', { class: 'ttab' });
  }
  init(params) {
    this.api = params.api;
    this.sid = params.params?.sessionId;
    this.noteId = params.params?.noteId;
    this.wallId = params.params?.wallId;
    this.file = !this.sid && !this.noteId && params.params?.path ? params.params : null;
    this.web = this.api.id.startsWith(WEB_PREFIX);
    const icon = this.noteId ? '✎' : this.wallId ? '▦' : this.file ? ({ image: '▣', video: '▶', audio: '♪' }[mediaKind(this.file.path)] || '▤') : this.web ? (params.params?.remote ? '⇆' : '◍') : null;
    this.dot = icon ? h('span', { class: 'ttab-note' }, icon) : h('span', { class: 'ttab-dot' });
    this.name = h('span', { class: 'ttab-name' });
    const close = h('button', { class: 'ttab-close', title: this.noteId ? 'Hide note' : this.file || this.web ? 'Close' : 'Remove from project' }, '×');
    close.addEventListener('mousedown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => { e.stopPropagation(); this.app.dock.closePanel(this.api.id); });
    this.element.append(this.dot, this.name, close);
    this.element.addEventListener('auxclick', (e) => { if (e.button === 1) this.app.dock.closePanel(this.api.id); });
    // A file with unsaved changes: a dot where the close button is, as in VS Code.
    this.onDirty = (e) => { if (e.detail.id === this.api.id) { this.element.classList.toggle('dirty', e.detail.dirty); close.title = e.detail.dirty ? 'Unsaved changes: close…' : 'Close'; } };
    if (this.file) window.addEventListener('belay:dirty', this.onDirty);
    // Remember whether the tab was already active before this press activated it.
    this.element.addEventListener('pointerdown', (e) => { this.wasActive = e.button === 0 && this.api.isActive; });
    this.element.addEventListener('click', (e) => {
      if (!this.wasActive || e.target.closest('.ttab-close')) return;
      this.wasActive = false;
      if (this.sid) this.app.ui.openSessionEditor(this.app, this.sid);
      else if (this.noteId) this.project.panels.get(this.api.id)?.action('rename');
      else if (this.web) this.app.ui.openWebDialog(this.app, { panelId: this.api.id });
      else this.project.panels.get(this.api.id)?.load();
    });
    this.element.addEventListener('contextmenu', (e) => { e.preventDefault(); this.app.ui.tabMenu(this.app, this.api.id, e); });
    this.unsub = this.sid
      ? this.app.client.on('session', (e) => { if (e.detail.id === this.sid) this.render(e.detail); })
      : this.noteId ? this.app.client.on('note', (e) => { if (e.detail.note.id === this.noteId) this.render(); })
        : this.wallId ? this.app.client.on('wall', (e) => { if (e.detail.wall.id === this.wallId) this.render(); }) : null;
    this.disposable = this.api.onDidActiveChange((e) => { if (e.isActive) { this.unseen = false; this.render(); } });
    // A web or file tab's name is its panel title, which a reloaded layout sets after the tab is made; a remote
    // page's icon follows its kind.
    this.titleSub = this.web || this.file ? this.api.onDidTitleChange(() => this.render()) : null;
    this.paramSub = this.web ? this.api.onDidParametersChange?.((p) => { this.dot.textContent = p?.remote ? '⇆' : '◍'; }) : null;
    this.render();
    this.initialized = true;
  }
  render(s = this.sid && this.app.client.session(this.sid)) {
    if (this.noteId) { this.name.textContent = this.app.client.note(this.noteId)?.title || this.api.title || 'Notes'; return; }
    if (this.wallId) { this.name.textContent = this.app.client.wall(this.wallId)?.title || this.api.title || 'Post-its'; return; }
    if (this.web) { this.name.textContent = this.api.title; return; }
    if (this.file) { this.name.textContent = this.api.title || String(this.file.path).split('/').pop(); this.element.title = this.file.host ? `${this.file.host}:${this.file.path}` : this.file.path; return; }
    if (!s) { this.name.textContent = this.api.title || '?'; this.setDot('ended', 'session removed'); return; }
    this.name.textContent = s.name;
    if (s.lastOutputAt !== this.lastOutputAt) {
      if (this.initialized && !this.api.isActive) this.unseen = true;
      this.lastOutputAt = s.lastOutputAt;
    }
    const act = s.activity?.state;
    const agent = AGENTS.find((a) => a.id === (s.activity?.agent || s.agent))?.label || 'The agent';
    if (s.status === 'starting') this.setDot('starting', s.linkNote || 'starting');
    else if (s.status !== 'running') this.setDot(s.status === 'exited' && s.exitCode ? 'failed' : 'ended', s.status === 'exited' ? `exited with code ${s.exitCode}` : 'stopped');
    else if (act === 'busy') this.setDot('busy', `${agent} is working`);
    else if (act === 'attention') this.setDot('attention', `${agent} needs your input`);
    else if (act === 'idle') this.setDot('idle', `${agent} is waiting for a prompt`);
    else this.setDot(null);
    // Agents redraw all the time, so only a plain session's new output is news.
    const unseen = this.unseen && !act && s.status === 'running';
    this.name.classList.toggle('unseen', unseen);
    this.name.title = unseen ? 'New output since you last looked' : '';
  }
  setDot(state, title = '') {
    this.dot.className = state ? `ttab-dot ${state}` : 'ttab-dot hidden';
    this.dot.title = title;
  }
  dispose() { this.unsub?.(); this.disposable?.dispose?.(); this.titleSub?.dispose?.(); this.paramSub?.dispose?.(); window.removeEventListener('belay:dirty', this.onDirty); }
}

/** The + after a group's tabs: a shell, an agent or a note for this project, or the full new-session dialog. */
class GroupActions {
  constructor(app) {
    this.app = app;
    this.element = h('div', { class: 'gadd' });
  }
  init(params) {
    this.group = params.group;
    const btn = h('button', { class: 'gadd-btn', title: 'New tab here' }, '+');
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => { e.stopPropagation(); this.app.ui.addMenu(this.app, this.group, btn); });
    this.element.append(btn);
  }
  dispose() {}
}

/**
 * One project's dockview. Every project keeps its own, so switching is instant and terminals keep running.
 * The ones behind stay laid out at full size but invisible, so their terminals keep the right dimensions.
 */
class Project {
  constructor(dock, view) {
    const { app } = dock;
    this.dock = dock;
    this.id = view.id;
    this.panels = new Map();
    this.el = h('div', { class: 'proj' });
    dock.el.append(this.el);
    this.api = createDockview(this.el, {
      theme: pickTheme(app.settings().theme),
      createComponent: (o) => (o.name === 'note' ? new NotePanel(app, this) : o.name === 'file' ? new FilePanel(app, this) : o.name === 'web' ? new WebPanel(app, this) : o.name === 'wall' ? new WallPanel(app, this) : o.name === 'media' ? new MediaPanel(app, this) : new TerminalPanel(app, this)),
      createTabComponent: () => new TabRenderer(app, this),
      // Panels saved without a tab component would get dockview's own tab, whose close button shows through hidden projects.
      defaultTabComponent: 'tab',
      createWatermarkComponent: () => new Watermark(app),
      createLeftHeaderActionComponent: () => new GroupActions(app),
      singleTabMode: 'default',
      disableFloatingGroups: false,
    });
    this.loading = true;
    try {
      if (view.layout) this.api.fromJSON(view.layout);
    } catch (e) {
      console.error(`layout of "${view.name}" failed to load, starting empty`, e);
      try { this.api.clear(); } catch {}
    } finally { this.loading = false; }
    this.api.onDidLayoutChange(() => { this.markTabBars(); if (!this.loading) dock.scheduleSave(); });
    this.api.onDidActivePanelChange(() => dock.renderTabs());
    this.markTabBars();
    // The ▭ in the bar of a pane whose group hides its tab bar brings the tab bar back.
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act="tabs"]');
      const pane = b && [...this.panels.values()].find((p) => p.element.contains(b));
      if (pane) { e.stopPropagation(); this.setTabBar(pane.api.group, true); }
    }, true);
  }
  /**
   * A group can hide its tab bar, for a pane that is a dashboard rather than something you switch between.
   * dockview keeps that in the layout; its panes get the ▭ that shows the tab bar again.
   */
  setTabBar(group, show) {
    if (!group || group.header.hidden === !show) return;
    group.header.hidden = !show;
    this.markTabBars();
    this.dock.scheduleSave();
  }
  markTabBars() {
    for (const g of this.api.groups) for (const p of g.panels) this.panels.get(p.id)?.element.classList.toggle('notabs', !!g.header.hidden);
  }
  get view() { return this.dock.views.find((v) => v.id === this.id); }
  isActive() { return this.dock.activeViewId === this.id; }
  show(on) {
    this.el.classList.toggle('active', on);
    if (on) for (const p of this.panels.values()) p.onShow?.();
  }
  capture() { const v = this.view; if (v) v.layout = this.api.panels.length ? this.api.toJSON() : null; }
  /** Tabs in group order: what next / previous tab walks through. */
  tabs() { return this.api.groups.flatMap((g) => g.panels); }
  dispose() { this.api.dispose(); this.el.remove(); }
}

/** The projects (top-level tabs), each with a live dockview layout. */
export class Dock {
  constructor(app, el) {
    this.app = app;
    this.el = el;
    this.projects = new Map();
    this.activeViewId = null;
    window.addEventListener('beforeunload', () => this.flushSave());
  }

  get views() { return this.app.client.state.views; }
  activeView() { return this.views.find((v) => v.id === this.activeViewId); }
  current() { return this.projects.get(this.activeViewId) || null; }
  /** The dockview of the project in front. */
  get api() { return this.current()?.api; }

  /** The projects with a tab: all but the closed ones, which are kept, hidden, until one of their sessions is opened. */
  get shown() { return this.views.filter((v) => !v.hidden); }

  ensureViews() {
    if (!this.shown.length) {
      // Nothing open: the first closed project comes back, or a new one.
      const closed = this.views[0];
      if (closed) closed.hidden = false;
      else this.views.push({ id: rid(), name: 'Main', host: '', user: '', dir: '', noteId: null, layout: null });
      this.saveViews();
    }
    let saved = null;
    try { saved = localStorage.getItem('belay.activeView'); } catch {}
    if (!this.shown.some((v) => v.id === this.activeViewId)) this.activeViewId = this.shown.find((v) => v.id === saved)?.id || this.shown[0].id;
  }

  /** A dockview for every project, the active one in front. */
  syncProjects() {
    for (const [id, p] of this.projects) if (!this.views.some((v) => v.id === id)) { p.dispose(); this.projects.delete(id); }
    for (const v of this.views) if (!this.projects.has(v.id)) this.projects.set(v.id, new Project(this, v));
    for (const p of this.projects.values()) p.show(p.id === this.activeViewId);
  }

  loadActive() {
    this.syncProjects();
    this.adoptNotes();
    this.rememberProjects();
    try { localStorage.setItem('belay.activeView', this.activeViewId); } catch {}
    this.renderTabs();
    setTimeout(() => this.app.activePanel()?.focus(), 0);
  }

  switchView(id) {
    const v = this.views.find((x) => x.id === id);
    if (!v) return;
    // A closed project switched to is open again, as it was.
    if (v.hidden) { v.hidden = false; this.saveViews(); this.renderTabs(); }
    if (id === this.activeViewId) return;
    this.activeViewId = id;
    this.loadActive();
  }
  switchToIndex(i) { const v = this.shown[i]; if (v) this.switchView(v.id); }
  step(d) { const shown = this.shown; const i = shown.findIndex((v) => v.id === this.activeViewId); this.switchToIndex((i + d + shown.length) % shown.length); }
  /**
   * Next / previous tab in group order. Past the last tab it carries on into the next project's first tab,
   * and before the first into the previous project's last. Inside a maximized group, only its tabs.
   */
  stepPanel(d) {
    const api = this.api;
    if (api?.hasMaximizedGroup()) {
      const panels = api.groups.filter((g) => g.panels.some((p) => p.api.isMaximized())).flatMap((g) => g.panels);
      const i = panels.indexOf(api.activePanel);
      const p = panels[(i + d + panels.length) % panels.length];
      if (p) this.focusPanel(p);
      return;
    }
    // The keyboard always goes with the tab: a tab that does not take it (a page, a file still loading) would
    // otherwise leave it in the pane before, still typing there, or in a page frame that keeps every key.
    const tabs = this.current()?.tabs() || [];
    const i = tabs.indexOf(api?.activePanel);
    const j = i + d;
    if (tabs.length && i >= 0 && j >= 0 && j < tabs.length) { this.focusPanel(tabs[j]); return; }
    if (this.views.length < 2) { const p = tabs[(j + tabs.length) % tabs.length]; if (p) this.focusPanel(p); return; }
    this.step(d);
    const next = this.current()?.tabs() || [];
    const target = d > 0 ? next[0] : next[next.length - 1];
    if (target) { target.api.setActive(); this.focusPanel(target); }
  }

  captureLayout() { for (const p of this.projects.values()) p.capture(); }
  scheduleSave() { clearTimeout(this.saveT); this.saveT = setTimeout(() => this.flushSave(), 400); }
  flushSave() { clearTimeout(this.saveT); this.captureLayout(); this.saveViews(); this.rememberProjects(); }
  saveViews() {
    this.app.client.api('PUT', '/api/projects', { projects: this.views, origin: this.app.client.clientId }).catch((e) => this.app.ui.toast(`Could not save layout: ${e.message}`));
  }

  addView({ name, host = '', user = '', dir = '' } = {}) {
    const v = { id: rid(), name: name || `Project ${this.views.length + 1}`, host, user, dir, noteId: null, layout: null };
    this.views.push(v);
    this.activeViewId = v.id;
    this.loadActive();
    this.saveViews();
    return v;
  }
  updateView(id, { name, host, user, dir }) {
    const v = this.views.find((x) => x.id === id);
    if (!v) return;
    if (name?.trim()) v.name = name.trim().slice(0, 60);
    if (dir != null) v.dir = dir.trim();
    const was = `${v.user}@${v.host}`;
    if (host != null) v.host = host.trim();
    if (user != null) v.user = user.trim();
    if (`${v.user}@${v.host}` !== was) for (const p of this.projects.get(id)?.panels.values() || []) p.onProjectChange?.();
    this.renderTabs();
    this.saveViews();
  }
  renameView(id, name) { this.updateView(id, { name }); }
  /** Deletes a project for good: its sessions belong to none after. */
  removeView(id) {
    const i = this.views.findIndex((v) => v.id === id);
    if (i < 0) return;
    if (!this.views[i].hidden && this.shown.length <= 1) { this.app.ui.toast('Keep at least one project', 'info'); return; }
    this.views.splice(i, 1);
    if (this.activeViewId === id) this.activeViewId = this.shown[0].id;
    this.loadActive();
    this.saveViews();
  }

  /**
   * Closes a project: it is hidden, not deleted. Its sessions carry on and still belong to it, its layout,
   * notes and post-its are kept, and opening one of its sessions (from the Sessions list) brings it back.
   */
  hideView(id) {
    const v = this.views.find((x) => x.id === id);
    if (!v || v.hidden) return;
    const shown = this.shown;
    if (shown.length <= 1) { this.app.ui.toast('Keep at least one project open', 'info'); return; }
    const i = shown.indexOf(v);
    v.hidden = true;
    if (this.activeViewId === id) this.activeViewId = shown[i > 0 ? i - 1 : 1].id;
    this.loadActive();
    this.saveViews();
  }
  moveView(id, delta) {
    const i = this.views.findIndex((v) => v.id === id);
    this.placeView(id, i + delta + (delta > 0 ? 1 : 0));
  }
  /** Put a project before the one now at index `to` (the end when `to` is the length). */
  placeView(id, to) {
    const i = this.views.findIndex((v) => v.id === id);
    if (i < 0 || to < 0 || to > this.views.length || to === i || to === i + 1) return;
    const [v] = this.views.splice(i, 1);
    this.views.splice(to > i ? to - 1 : to, 0, v);
    this.renderTabs();
    this.saveViews();
  }

  /** Projects changed elsewhere (another browser, or a reconnect): new ones appear, removed ones go. */
  onRemoteViews() {
    this.ensureViews();
    this.loadActive();
  }

  panelId(sid) { return PANEL_PREFIX + sid; }
  notePanelId(noteId) { return NOTE_PREFIX + noteId; }

  /** The session shown in a group, or in the active one: what "here" means for new shells. */
  sessionOf(group = this.api?.activeGroup) {
    const sid = group?.activePanel?.params?.sessionId;
    return (sid && this.app.client.session(sid)) || null;
  }

  /**
   * Go to a session where it is: its tab in this project, else its tab in the first project that has it.
   * Only a session open nowhere opens here. (Going to a session never moves it between projects.)
   */
  goToSession(sid) {
    const id = this.panelId(sid);
    const here = this.api?.getPanel(id);
    if (here) { this.focusPanel(here); return here; }
    for (const v of this.views) {
      const panel = this.projects.get(v.id)?.api.getPanel(id);
      if (panel) { this.switchView(v.id); this.focusPanel(panel); return panel; }
    }
    // Hidden (its tab was closed): back in the project it was last open in, which comes back if it was closed.
    const home = this.views.find((v) => v.id === this.app.client.session(sid)?.project);
    if (home) this.switchView(home.id);
    const back = this.api?.getPanel(id);
    if (back) { this.focusPanel(back); return back; }
    return this.openSession(sid);
  }

  /**
   * Each session remembers the project it is open in, on the server, so that once its tab is closed the
   * sidebar can still list it there, hidden. Open in two projects, it keeps the one it had while still open there.
   */
  rememberProjects() {
    for (const v of this.views) {
      for (const panel of this.projects.get(v.id)?.api.panels || []) {
        const sid = panel.params?.sessionId;
        const s = sid && this.app.client.session(sid);
        if (!s || s.project === v.id) continue;
        if (s.project && this.projects.get(s.project)?.api.getPanel(this.panelId(sid))) continue;
        s.project = v.id;
        this.app.client.api('PATCH', `/api/sessions/${sid}`, { project: v.id }).catch(() => {});
      }
    }
  }

  /**
   * Open a session in the active project. direction: 'within' (tab, default) | 'right' | 'below' | 'left' | 'above';
   * group: the group to add it to instead of the active one.
   */
  openSession(sid, { direction = 'within', group } = {}) {
    const existing = this.api.getPanel(this.panelId(sid));
    if (existing) {
      const g = group || this.api.activeGroup;
      // Already open: a split request moves the pane next to the active group instead of ignoring it.
      if (direction !== 'within' && g && !(existing.group === g && g.panels.length === 1)) {
        existing.api.moveTo({ group: g, position: { right: 'right', left: 'left', below: 'bottom', above: 'top' }[direction] || 'right' });
      }
      existing.api.setActive();
      existing.focus();
      return existing;
    }
    const s = this.app.client.session(sid);
    return this.addPanelAt({ id: this.panelId(sid), component: 'terminal', title: s?.name || sid, params: { sessionId: sid } }, { direction, group });
  }

  /** The project a note belongs to, if any: each project has one note, its scratch pad. */
  viewOfNote(noteId) { return this.views.find((v) => v.noteId === noteId) || null; }

  /**
   * From the palette: a project's note opens in its project. A note no project has (left from when a
   * project could have several) is added to the end of this project's note, so its text is not lost.
   */
  async openNote(noteId) {
    const owner = this.viewOfNote(noteId);
    if (owner) { this.switchView(owner.id); await this.showNotes(); return; }
    const n = this.app.client.note(noteId);
    if (!n) return;
    const v = await this.ensureNote(this.activeView());
    const mine = this.app.client.note(v.noteId);
    const text = [mine?.text?.replace(/\s+$/, ''), n.text?.replace(/\s+$/, '')].filter(Boolean).join('\n\n');
    await this.app.client.api('PUT', `/api/notes/${v.noteId}`, { text, origin: this.app.client.clientId });
    this.app.client.state.notes.set(v.noteId, { ...mine, text });
    for (const p of this.projects.values()) p.api.getPanel(this.notePanelId(noteId))?.api.close();
    await this.app.client.api('DELETE', `/api/notes/${noteId}`);
    const panel = await this.showNotes();
    this.app.panels.get(panel?.id)?.reattach?.();
    this.app.ui.toast(`Added to ${v.name}'s notes`, 'info');
  }

  /**
   * A text file in an editor tab: { path, host?, user?, dir?, line?, create? }. The same file again reuses its
   * tab. `create`: a file that is not there yet opens empty and is made on the first save.
   */
  openFile(file, { group } = {}) {
    const id = FILE_PREFIX + fileKey(file);
    const existing = this.api.getPanel(id);
    if (existing) { this.app.panels.get(id)?.reopen(file); this.focusPanel(existing); return existing; }
    const title = String(file.path).replace(/\/+$/, '').split('/').pop() || file.path;
    const params = { path: file.path, host: file.host || '', user: file.user || '', dir: file.dir || '', line: file.line || null, ...(file.create ? { create: true } : {}) };
    const panel = this.addPanelAt({ id, component: componentOf(id, params), title, params, renderer: rendererOf(id, params) }, { group });
    this.focusPanel(panel);
    return panel;
  }

  /** A page in a tab: a web page { url, title }, or a remote page { address, title, remote: true }. */
  openWeb(web, { group } = {}) {
    const id = WEB_PREFIX + rid();
    const params = web.remote ? { address: web.address, title: web.title, remote: true } : { url: web.url, title: web.title };
    const panel = this.addPanelAt({ id, component: 'web', title: web.title, params, renderer: 'always' }, { group });
    this.focusPanel(panel);
    return panel;
  }

  /** Close a tab, once the pane agrees: a file with unsaved changes asks first. */
  async closePanel(panelId) {
    const panel = this.api?.getPanel(panelId);
    if (!panel) return;
    const pane = this.app.panels.get(panelId);
    if (pane?.confirmClose && !(await pane.confirmClose())) return;
    panel.api.close();
  }

  /** Make a panel active and put the keyboard in it once it has rendered. */
  focusPanel(panel) {
    panel.api.setActive();
    // Straight away for a pane that is there already, so no key goes astray, and again once a new one has rendered.
    this.app.panels.get(panel.id)?.focus();
    setTimeout(() => this.app.panels.get(panel.id)?.focus(), 0);
  }

  addPanelAt(spec, { direction = 'within', group, api = this.api } = {}) {
    const g = group || api.activeGroup;
    const position = g ? { referenceGroup: g.id, direction } : undefined;
    return api.addPanel({ ...spec, tabComponent: 'tab', position });
  }

  /** The project's note, made the first time it is asked for. */
  async ensureNote(v) {
    if (v.noteId && this.app.client.note(v.noteId)) return v;
    const n = await this.app.client.api('POST', '/api/notes', { title: `${v.name} notes`, origin: this.app.client.clientId });
    this.app.client.state.notes.set(n.id, n);
    v.noteId = n.id;
    this.saveViews();
    return v;
  }

  /**
   * A project without a note of its own takes the first one open in its layout: projects could once have
   * several notes, and the one in front is the one you were using.
   */
  adoptNotes() {
    let changed = false;
    for (const v of this.views) {
      if (v.noteId && this.app.client.note(v.noteId)) continue;
      const ids = this.projects.get(v.id)?.api.panels.map((p) => p.params?.noteId).filter(Boolean) || [];
      const id = ids.find((x) => this.app.client.note(x) && !this.viewOfNote(x));
      if (id) { v.noteId = id; changed = true; }
    }
    if (changed) this.saveViews();
  }

  /** The project's note: brought to the front, or opened (in `group`, else down the right-hand side). */
  async showNotes({ group } = {}) {
    const v = await this.ensureNote(this.activeView());
    const shown = this.api.getPanel(this.notePanelId(v.noteId));
    if (shown) { this.focusPanel(shown); return shown; }
    const spec = { id: this.notePanelId(v.noteId), component: 'note', title: this.app.client.note(v.noteId).title, params: { noteId: v.noteId } };
    const panel = group ? this.addPanelAt(spec, { group })
      : this.api.addPanel({ ...spec, tabComponent: 'tab', position: this.api.groups.length ? { direction: 'right' } : undefined, initialWidth: 340 });
    this.focusPanel(panel);
    return panel;
  }

  /** The project's post-it wall, made the first time it is asked for. */
  async ensureWall(v) {
    if (v.wallId && this.app.client.wall(v.wallId)) return v;
    const w = await this.app.client.api('POST', '/api/walls', { title: `${v.name} post-its`, origin: this.app.client.clientId });
    this.app.client.state.walls.set(w.id, w);
    v.wallId = w.id;
    this.saveViews();
    return v;
  }

  /** The project's post-it wall: brought to the front, or opened as a tab (in `group`, else the active group). */
  async showWall({ group } = {}) {
    const v = await this.ensureWall(this.activeView());
    const id = WALL_PREFIX + v.wallId;
    const shown = this.api.getPanel(id);
    if (shown) { this.focusPanel(shown); return shown; }
    const panel = this.addPanelAt({ id, component: 'wall', title: this.app.client.wall(v.wallId).title, params: { wallId: v.wallId } }, { group });
    this.focusPanel(panel);
    return panel;
  }

  /** The post-it wall, or hidden again: hiding keeps it, and it comes back as it was. */
  async toggleWall() {
    const v = this.activeView();
    if (!v) return;
    const shown = v.wallId && this.api.getPanel(WALL_PREFIX + v.wallId);
    if (shown) { shown.api.close(); return; }
    await this.showWall();
  }

  /** The project's note down the right-hand side, or hidden again: hiding keeps the text, and it comes back as it was. */
  async toggleNotes() {
    const v = this.activeView();
    if (!v) return;
    const shown = v.noteId && this.api.getPanel(this.notePanelId(v.noteId));
    if (shown) { shown.api.close(); return; }
    await this.showNotes();
  }

  onSessionRemoved(sid) {
    for (const p of this.projects.values()) p.api.getPanel(this.panelId(sid))?.api.close();
  }

  /** Move tabs into another project and show them there. */
  moveToView(panelIds, viewId) {
    const target = this.projects.get(viewId);
    if (viewId === this.activeViewId || !target) return;
    // A note or a post-it wall is its project's own, so it stays with it.
    const own = (id) => id.startsWith(NOTE_PREFIX) || id.startsWith(WALL_PREFIX);
    if (panelIds.some(own)) this.app.ui.toast("A project's notes and post-its stay with it", 'info');
    const specs = panelIds.filter((id) => !own(id)).map((id) => this.api.getPanel(id)).filter(Boolean)
      .map((p) => ({ id: p.id, component: componentOf(p.id, p.params), title: p.title, params: p.params, renderer: rendererOf(p.id, p.params) }));
    if (!specs.length) return;
    for (const s of specs) this.api.getPanel(s.id)?.api.close();
    this.switchView(viewId);
    let last = null;
    for (const s of specs) last = target.api.getPanel(s.id) || this.addPanelAt(s, { api: target.api });
    if (last) this.focusPanel(last);
    this.flushSave();
  }

  /** Session ids open somewhere in the given project. */
  sessionsInView(v) {
    if (!v) return new Set();
    const p = this.projects.get(v.id);
    if (p) return new Set(p.api.panels.map((x) => x.params?.sessionId).filter(Boolean));
    const out = new Set();
    for (const x of Object.values(v.layout?.panels || {})) if (x.params?.sessionId) out.add(x.params.sessionId);
    return out;
  }

  setTheme(name) { for (const p of this.projects.values()) p.api.updateOptions({ theme: pickTheme(name) }); }

  renderTabs() {
    this.app.side?.refresh();
    const nav = document.getElementById('views');
    const sessions = this.app.client.state.sessions;
    const clearDrop = () => nav.querySelectorAll('.drop, .drop-before, .drop-after').forEach((t) => t.classList.remove('drop', 'drop-before', 'drop-after'));
    nav.replaceChildren(
      ...this.shown.map((v, index) => {
        const home = this.app.client.state.server.home;
        const ids = [...this.sessionsInView(v)];
        const states = ids.map((id) => sessions.get(id)?.activity?.state).filter(Boolean);
        const busy = states.filter((s) => s === 'busy').length;
        const attention = states.filter((s) => s === 'attention').length;
        const where = v.host ? `${v.user ? `${v.user}@` : ''}${v.host}${v.dir ? `:${v.dir}` : ''}` : v.dir ? shortPath(v.dir, home) : '';
        const title = `${v.name}${where ? ` · ${where}` : ''}${ids.length ? ` · ${ids.length} session${ids.length === 1 ? '' : 's'}` : ''}${busy ? ` · ${busy} working` : ''}${attention ? ` · ${attention} waiting for you` : ''}\nClick again for its settings, drag to reorder`;
        const tab = h('div', { class: `vtab${v.id === this.activeViewId ? ' active' : ''}`, title, 'data-id': v.id, draggable: 'true' },
          attention ? h('span', { class: 'vtab-dot attention' }) : busy ? h('span', { class: 'vtab-dot busy' }) : null,
          h('span', { class: 'vtab-name' }, v.name),
          ids.length ? h('span', { class: 'vtab-count' }, String(ids.length)) : null,
          h('button', { class: 'vtab-close', title: 'Close project', onclick: (e) => { e.stopPropagation(); this.confirmRemove(v); } }, '×'));
        // The project in front, clicked: its settings.
        tab.addEventListener('click', () => { if (v.id === this.activeViewId) this.app.ui.openProjectDialog(this.app, v); else this.switchView(v.id); });
        tab.addEventListener('auxclick', (e) => { if (e.button === 1) this.confirmRemove(v); });
        tab.addEventListener('contextmenu', (e) => { e.preventDefault(); this.app.ui.viewMenu(this.app, v, e); });
        // Dragging a project tab reorders the projects.
        tab.addEventListener('dragstart', (e) => { this.draggingView = v.id; e.dataTransfer.setData(PROJECT_MIME, v.id); e.dataTransfer.effectAllowed = 'move'; });
        tab.addEventListener('dragend', () => { this.draggingView = null; clearDrop(); });
        // A tab dragged out of a layout and dropped here moves to this project.
        tab.addEventListener('dragover', (e) => {
          if (this.draggingView) {
            if (this.draggingView === v.id) return;
            e.preventDefault();
            const r = tab.getBoundingClientRect();
            clearDrop();
            tab.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
            return;
          }
          if (v.id === this.activeViewId || !getPanelData()) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          tab.classList.add('drop');
        });
        // Leaving for one of the tab's own children is not leaving.
        tab.addEventListener('dragleave', (e) => { if (!tab.contains(e.relatedTarget)) tab.classList.remove('drop', 'drop-before', 'drop-after'); });
        tab.addEventListener('drop', (e) => {
          const r = tab.getBoundingClientRect();
          const before = e.clientX < r.left + r.width / 2;
          clearDrop();
          if (this.draggingView) {
            e.preventDefault();
            const id = this.draggingView;
            this.draggingView = null;
            this.placeView(id, before ? index : index + 1);
            return;
          }
          const data = getPanelData();
          if (!data || v.id === this.activeViewId) return;
          e.preventDefault();
          const panelIds = data.panelId ? [data.panelId] : (this.api.getGroup(data.groupId)?.panels || []).map((p) => p.id);
          this.moveToView(panelIds, v.id);
        });
        return tab;
      }),
      h('button', { class: 'vtab-add', title: 'New project', onclick: () => this.app.ui.openProjectDialog(this.app) }, '+ Project'),
    );
  }

  /** Closing a project hides it (see hideView): nothing to confirm, nothing is lost. */
  confirmRemove(v) { if (v) this.hideView(v.id); }

  /** Deleting one is for good, so it asks. */
  async confirmDelete(v) {
    if (!v) return;
    const n = this.sessionsInView(v).size;
    if (!(await this.app.ui.confirm(`Delete project "${v.name}" for good? ${n ? `Its ${n} session${n === 1 ? '' : 's'} keep running, in no project.` : ''}`, { ok: 'Delete', danger: true }))) return;
    this.removeView(v.id);
  }
}
