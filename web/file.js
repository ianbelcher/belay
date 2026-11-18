import { h, copyText, rid } from './util.js';
import { loadMonaco, createEditor, replaceText, settingsOptions } from './editor.js';
import { openInVsCode, VSCODE_ICON } from './vscode.js';

const basename = (p) => String(p).replace(/\/+$/, '').split('/').pop() || p;

/** Which printed paths are files on this machine, from a session's directory. Cached briefly, since hovering asks often. */
const cache = new Map();
export async function resolveLocal(app, cwd, paths) {
  const now = Date.now();
  const out = {}, ask = [];
  for (const p of paths) {
    const c = cache.get(`${cwd}\0${p}`);
    if (c && now - c.at < 5000) out[p] = c.abs; else ask.push(p);
  }
  if (ask.length) {
    const r = await app.client.api('POST', '/api/files/resolve', { cwd, paths: ask });
    for (const p of ask) { out[p] = r.paths[p] || null; cache.set(`${cwd}\0${p}`, { abs: out[p], at: now }); }
  }
  return out;
}

// Unsaved text, per file tab, until it is saved: it survives a reload, and a tab moved to another project.
const draftKey = (id) => `belay.draft.${id}`;
const readDraft = (id) => { try { return JSON.parse(localStorage.getItem(draftKey(id))); } catch { return null; } };
const writeDraft = (id, d) => { try { localStorage.setItem(draftKey(id), JSON.stringify(d)); } catch {} };
const clearDraft = (id) => { try { localStorage.removeItem(draftKey(id)); } catch {} };

/**
 * A text file in Monaco, here or on a remote host: opened from a path printed in a terminal, or picked with
 * Open file. Cmd/Ctrl+S saves; a save is refused when the file changed on disk since it was loaded, unless you
 * say to overwrite. A file that does not exist yet (`create`) is made on the first save.
 */
export class FilePanel {
  constructor(app, project) {
    this.app = app;
    this.project = project;
    this.element = h('div', { class: 'fv' });
    this.hash = null;
    this.isNew = false;
    this.readOnly = false;
  }

  init(params) {
    this.api = params.api;
    this.file = { ...params.params };
    this.project.panels.set(this.api.id, this);
    const btn = (act, title, label) => h('button', { class: 'tp-btn', 'data-act': act, title }, label);
    this.nameEl = h('span', { class: 'tp-name' });
    this.pathEl = h('span', { class: 'tp-cwd' });
    this.infoEl = h('span', { class: 'np-status' });
    this.saveBtn = btn('save', 'Save (Cmd/Ctrl+S)', 'Save');
    this.saveBtn.classList.add('fv-save');
    this.box = h('div', { class: 'ed-box' });
    this.element.replaceChildren(
      h('div', { class: 'tp-bar' }, h('span', { class: 'fv-icon' }, '▤'), this.nameEl, this.pathEl, this.infoEl, h('span', { class: 'tp-spacer' }),
        this.saveBtn,
        btn('search', 'Find', '⌕'),
        btn('reload', 'Reload from disk', '↻'),
        this.vscodeBtn(),
        btn('copy-path', 'Copy path', '⧉'),
        btn('tabs', 'Show the tab bar', '▭'),
        btn('max', 'Maximize / restore', '⤢'),
        btn('close', 'Close', '×')),
      this.box);
    this.element.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) { e.preventDefault(); this.action(act); }
    });
    // Unsaved, the page asks before it goes; a reload asked for (the palette's) does not, the draft kept for after it.
    this.onUnload = (e) => { if (this.dirty) { this.keepDraft(); if (!window.belayReloading) { e.preventDefault(); e.returnValue = ''; } } };
    window.addEventListener('beforeunload', this.onUnload);
    this.disposeActive = this.api.onDidActiveChange((e) => { if (e.isActive) { this.focus(); this.checkDisk(); } });
    this.onWindowFocus = () => { if (this.api.isVisible) this.checkDisk(); };
    window.addEventListener('focus', this.onWindowFocus);
    this.renderHead();
    this.mount();
  }

  vscodeBtn() {
    const b = h('button', { class: 'tp-btn tp-vscode', 'data-act': 'vscode', title: 'Open in VS Code, at this line' });
    b.innerHTML = VSCODE_ICON;
    return b;
  }

  where() { return `${this.file.host ? `${this.file.user ? `${this.file.user}@` : ''}${this.file.host}:` : ''}${this.file.path}`; }

  renderHead() {
    this.nameEl.textContent = basename(this.file.path);
    this.pathEl.textContent = this.where();
    this.pathEl.title = this.where();
  }

  get dirty() { return !!this.model && this.model.getAlternativeVersionId() !== this.savedVersion; }

  /** The status beside the path, the Save button, and the tab's unsaved dot. */
  renderStatus(note = '') {
    const lang = this.model ? this.monaco.languages.getLanguages().find((l) => l.id === this.model.getLanguageId()) : null;
    // Lines as a file has them: the empty one after a final newline does not count.
    const lines = this.model ? this.model.getLineCount() - (this.model.getLineLength(this.model.getLineCount()) === 0 ? 1 : 0) : 0;
    const parts = [this.saving ? 'saving…' : this.dirty ? 'edited' : '', this.dirty ? this.held : '', note, this.isNew ? 'new file' : '', this.readOnly ? 'first 2 MB, read-only' : '',
      lang && lang.id !== 'plaintext' ? lang.aliases?.[0] || lang.id : '', this.model ? `${lines} line${lines === 1 ? '' : 's'}` : ''];
    this.infoEl.textContent = parts.filter(Boolean).join(' · ');
    this.saveBtn.disabled = this.readOnly || !this.model || (!this.dirty && !this.isNew);
    window.dispatchEvent(new CustomEvent('belay:dirty', { detail: { id: this.api.id, dirty: this.dirty } }));
  }

  async fetchFile() {
    const f = this.file;
    const q = new URLSearchParams({ path: f.path, host: f.host || '', user: f.user || '', dir: f.dir || '' });
    try {
      return await this.app.client.api('GET', `/api/files?${q}`);
    } catch (e) {
      if (f.create && e.status === 404) return { path: f.path, text: '', hash: null, missing: true };
      throw e;
    }
  }

  async mount() {
    this.infoEl.textContent = 'loading…';
    let r;
    try { [this.monaco, r] = await Promise.all([loadMonaco(), this.fetchFile()]); } catch (e) { this.showError(e.message); return; }
    if (this.disposed) return;
    const { monaco } = this;
    this.takeFile(r);
    // The path decides the language; the random part keeps one file open in two projects apart.
    this.model = monaco.editor.createModel(r.text, undefined, monaco.Uri.from({ scheme: 'belay', path: `/${rid()}${r.path.startsWith('/') ? '' : '/'}${r.path}` }));
    this.savedVersion = this.model.getAlternativeVersionId();
    this.editor = createEditor(monaco, this.app, this.box, this.model, { readOnly: this.readOnly, wordWrap: this.file.wrap ? 'on' : 'off', tabSize: 2, detectIndentation: true, stickyScroll: { enabled: false } });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.save());
    this.model.onDidChangeContent(() => { this.renderStatus(); this.draftSoon(); });
    // Saved as the focus leaves the editor (another tab, a terminal, another window), as VS Code's onFocusChange.
    // Not while belay is asking about this file: its question takes the focus too.
    this.editor.onDidBlurEditorText(() => { if (this.dirty && !this.asking) this.autosaving = this.save(false, { auto: true }).finally(() => { this.autosaving = null; }); });
    await this.restoreDraft();
    this.renderStatus();
    this.reveal(this.file.line);
    if (this.api.isActive) this.focus();
  }

  takeFile(r) {
    if (!this.file.host && r.path !== this.file.path) { this.file.path = r.path; this.api.updateParameters({ ...this.file }); this.renderHead(); }
    this.hash = r.hash;
    this.isNew = !!r.missing;
    this.readOnly = !!r.truncated;
  }

  showError(msg) {
    this.infoEl.textContent = '';
    this.box.replaceChildren(h('div', { class: 'tp-missing' }, h('p', {}, msg), h('button', { class: 'btn small', onclick: () => { this.box.replaceChildren(); this.mount(); } }, 'Try again')));
  }

  draftSoon() {
    clearTimeout(this.draftT);
    this.draftT = setTimeout(() => this.keepDraft(), 300);
  }

  keepDraft() {
    clearTimeout(this.draftT);
    if (!this.model) return;
    if (this.dirty) writeDraft(this.api.id, { base: this.hash, text: this.model.getValue(), time: Date.now() });
    else clearDraft(this.api.id);
  }

  /** Text that was never saved comes back. If the file changed since, ask: saving it would overwrite those changes. */
  async restoreDraft() {
    const d = readDraft(this.api.id);
    if (!d || d.text === this.model.getValue()) { clearDraft(this.api.id); return; }
    const same = d.base === this.hash;
    if (same || await this.app.ui.confirm(`${basename(this.file.path)} has changes from ${new Date(d.time).toLocaleString()} that were never saved, and the file has changed since. Bring them back? Saving would then overwrite the newer file.`, { ok: 'Bring back' })) {
      this.model.setValue(d.text);
      if (!same) this.renderStatus('changed on disk');
    } else clearDraft(this.api.id);
  }

  /** Back to the file on disk: silently when nothing is edited, else only when asked to drop the edits. */
  async reload({ ask = true } = {}) {
    if (!this.model) { this.box.replaceChildren(); this.mount(); return; }
    if (this.dirty && ask && !(await this.app.ui.confirm(`Drop your changes to ${basename(this.file.path)} and load it from disk?`, { ok: 'Drop changes', danger: true }))) return;
    let r;
    try { r = await this.fetchFile(); } catch (e) { this.app.ui.toast(e.message); return; }
    this.takeFile(r);
    this.editor.updateOptions({ readOnly: this.readOnly });
    replaceText(this.editor, r.text);
    this.savedVersion = this.model.getAlternativeVersionId();
    clearDraft(this.api.id);
    this.renderStatus();
  }

  /** On coming back to the tab: a file changed on disk is reloaded when nothing is edited, and flagged when something is. */
  async checkDisk() {
    if (!this.model || this.saving || this.checking || this.isNew) return;
    this.checking = true;
    try {
      const r = await this.fetchFile().catch(() => null);
      if (!r || r.hash === this.hash || !r.hash) return;
      if (this.dirty) { this.renderStatus('changed on disk'); return; }
      this.takeFile(r);
      replaceText(this.editor, r.text);
      this.savedVersion = this.model.getAlternativeVersionId();
      this.renderStatus('reloaded: changed on disk');
    } finally { this.checking = false; }
  }

  /**
   * Saves the text. A file changed on disk since it was loaded is not overwritten without asking; a save made
   * on its own (`auto`, as the focus leaves) does not ask, it leaves the file alone and says so until Cmd+S.
   */
  async save(force = false, { auto = false } = {}) {
    if (!this.model || this.readOnly || this.saving) return;
    const text = this.model.getValue();
    const version = this.model.getAlternativeVersionId();
    const f = this.file;
    let conflict = null;
    this.saving = true;
    this.renderStatus();
    try {
      const r = await this.app.client.api('PUT', '/api/files', { path: f.path, host: f.host || '', user: f.user || '', dir: f.dir || '', text, base: this.hash, create: this.isNew && !force, force });
      this.hash = r.hash;
      this.isNew = false;
      this.held = '';
      this.savedVersion = version;
      if (!f.host && r.path !== f.path) { f.path = r.path; this.api.updateParameters({ ...f }); this.renderHead(); }
      this.keepDraft();
    } catch (e) {
      if (e.status === 409 && auto) this.held = 'changed on disk: not saved, Cmd/Ctrl+S to choose';
      else if (e.status === 409) conflict = this.isNew ? `${basename(f.path)} already exists. Replace it with this text?` : `${basename(f.path)} has changed on disk since you opened it. Overwrite it with your version?`;
      else this.app.ui.toast(`Not saved: ${e.message}`);
    } finally {
      this.saving = false;
      this.renderStatus();
    }
    if (!conflict) return;
    this.asking = true;
    const overwrite = await this.app.ui.confirm(conflict, { ok: 'Overwrite', danger: true }).finally(() => { this.asking = false; });
    if (overwrite) await this.save(true);
  }

  /** Before the tab closes: unsaved changes are saved, dropped, or the close is called off. */
  async confirmClose() {
    // Pressing close took the focus from the editor, which saves: wait for that before asking.
    if (this.autosaving) await this.autosaving;
    if (!this.dirty) return true;
    this.asking = true;
    const choice = await this.app.ui.choose(`Save your changes to ${basename(this.file.path)}?`, [['cancel', 'Cancel'], ['drop', "Don't save"], ['save', 'Save', 'primary']]).finally(() => { this.asking = false; });
    if (choice === 'drop') { clearDraft(this.api.id); this.savedVersion = this.model.getAlternativeVersionId(); return true; }
    if (choice !== 'save') return false;
    await this.save();
    return !this.dirty;
  }

  /** Scroll to a line and mark it. */
  reveal(line) {
    if (!this.editor || !line) return;
    const n = Math.min(Number(line), this.model.getLineCount());
    this.editor.setPosition({ lineNumber: n, column: 1 });
    this.editor.revealLineInCenter(n);
    this.marks = this.editor.createDecorationsCollection([{ range: new this.monaco.Range(n, 1, n, 1), options: { isWholeLine: true, className: 'ed-hl' } }]);
  }

  /** Opened again from another mention of the same file, maybe at another line. (Not `update`: dockview calls that on its renderers when parameters change.) */
  async reopen(file) {
    this.file = { ...this.file, ...file };
    this.api.updateParameters({ ...this.file });
    this.marks?.clear();
    if (this.model && !this.dirty) await this.checkDisk();
    this.reveal(file.line);
  }

  action(act) {
    switch (act) {
      case 'save': this.save(); break;
      case 'reload': this.reload(); break;
      case 'vscode': this.keepDraft(); openInVsCode(this.app, { ...this.file, line: this.editor?.getPosition()?.lineNumber || this.file.line }); break;
      case 'copy-path': copyText(this.file.path).then((ok) => this.app.ui.toast(ok ? 'Path copied' : 'The browser blocked the clipboard', ok ? 'info' : 'error')); break;
      case 'search': this.toggleSearch(); break;
      case 'max': this.toggleMaximize(); break;
      case 'close': this.app.dock.closePanel(this.api.id); break;
      default: break;
    }
  }

  /** Word wrap for this tab, kept in the layout; files start without. */
  get wrap() { return !!this.file.wrap; }
  toggleWrap() {
    this.file.wrap = !this.file.wrap;
    this.editor?.updateOptions({ wordWrap: this.file.wrap ? 'on' : 'off' });
    this.api.updateParameters({ wrap: this.file.wrap });
  }

  toggleSearch() { this.editor?.focus(); this.editor?.getAction('actions.find')?.run(); }
  toggleMaximize() { if (this.api.isMaximized()) this.api.exitMaximized(); else this.api.maximize(); }
  applySettings() { this.editor?.updateOptions(settingsOptions(this.app)); }
  focus() { this.editor?.focus(); }
  restart() { this.reload(); }
  load() { this.reload(); }

  dispose() {
    this.keepDraft();
    this.disposed = true;
    this.editor?.dispose();
    this.model?.dispose();
    this.project.panels.delete(this.api?.id);
    this.disposeActive?.dispose?.();
    window.removeEventListener('beforeunload', this.onUnload);
    window.removeEventListener('focus', this.onWindowFocus);
    window.dispatchEvent(new CustomEvent('belay:dirty', { detail: { id: this.api?.id, dirty: false } }));
  }
}
