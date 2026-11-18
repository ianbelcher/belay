import { h, debounce } from './util.js';
import { loadMonaco, createEditor, replaceText, settingsOptions } from './editor.js';

/**
 * A dockview content renderer for one note: markdown kept on the server, so every browser shows the same
 * scratch pad, edited in Monaco with the HUD's notes settings. Saves as you type; a change from another
 * browser replaces the text unless you have edits that are not saved yet.
 */
export class NotePanel {
  constructor(app, project) {
    this.app = app;
    this.project = project;
    this.element = h('div', { class: 'np' });
    this.dirty = false;
    this.saving = false;
  }

  init(params) {
    this.api = params.api;
    this.noteId = params.params?.noteId;
    // Notes wrap unless the tab says not to.
    this.wrap = params.params?.wrap !== false;
    this.project.panels.set(this.api.id, this);
    const n = this.app.client.note(this.noteId);
    if (!n) { this.renderMissing(); return; }
    const btn = (act, title, label) => h('button', { class: 'tp-btn', 'data-act': act, title }, label);
    this.titleEl = h('span', { class: 'tp-name', title: 'Rename' });
    this.statusEl = h('span', { class: 'np-status' });
    this.box = h('div', { class: 'ed-box' });
    this.element.replaceChildren(
      h('div', { class: 'tp-bar' }, h('span', { class: 'np-icon' }, '✎'), this.titleEl, this.statusEl, h('span', { class: 'tp-spacer' }),
        btn('delete', 'Delete note', '🗑'),
        btn('tabs', 'Show the tab bar', '▭'),
        btn('max', 'Maximize / restore', '⤢'),
        btn('close', 'Hide (the note is kept)', '×')),
      this.box);
    this.element.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) { e.preventDefault(); this.action(act); }
    });
    this.titleEl.addEventListener('click', () => this.action('rename'));
    this.saveSoon = debounce(() => this.save(), 400);
    this.unsubNote = this.app.client.on('note', (e) => { if (e.detail.note.id === this.noteId) this.onNote(e.detail); });
    this.unsubRemoved = this.app.client.on('note-removed', (e) => { if (e.detail === this.noteId) this.api.close(); });
    this.onUnload = () => this.flush();
    window.addEventListener('beforeunload', this.onUnload);
    this.disposeActive = this.api.onDidActiveChange((e) => { if (e.isActive) this.focus(); });
    this.render(n);
    this.mount(n.text || '');
  }

  async mount(text) {
    let monaco;
    try { monaco = await loadMonaco(); } catch (e) { this.box.replaceChildren(h('div', { class: 'tp-missing' }, h('p', {}, `The editor did not load: ${e.message}`))); return; }
    if (this.disposed) return;
    this.model = monaco.editor.createModel(text, 'markdown');
    this.model.updateOptions({ tabSize: 2 });
    // As the HUD's notes: wrapped lines hang under their text, no line numbers, nothing suggested.
    this.editor = createEditor(monaco, this.app, this.box, this.model, {
      wordWrap: this.wrap ? 'on' : 'off', wrappingIndent: 'deepIndent', lineNumbers: 'off', lineNumbersMinChars: 0, folding: false, glyphMargin: false,
      lineDecorationsWidth: 10, quickSuggestions: false, wordBasedSuggestions: 'off', placeholder: 'Ideas, to-dos, things to tell the agent later…',
    });
    this.model.onDidChangeContent(() => { if (this.applying) return; this.dirty = true; this.renderStatus(); this.saveSoon(); });
    this.editor.onDidBlurEditorText(() => { if (this.dirty) this.save(); });
    // Saving is automatic; Cmd/Ctrl+S just does it now.
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.save());
    if (this.api.isActive) this.focus();
  }

  get value() { return this.model?.getValue() ?? this.app.client.note(this.noteId)?.text ?? ''; }

  render(n) {
    this.titleEl.textContent = n.title;
    if (this.api.title !== n.title) this.api.setTitle(n.title);
    this.renderStatus();
  }

  renderStatus() {
    this.statusEl.textContent = this.saving ? 'saving…' : this.dirty ? 'edited' : '';
  }

  onNote({ note, remote }) {
    this.render(note);
    if (!remote || this.dirty || !this.editor || this.value === note.text) return;
    this.applying = true;
    try { replaceText(this.editor, note.text); } finally { this.applying = false; }
  }

  async save() {
    if (!this.dirty || this.saving || !this.model) return;
    this.saving = true;
    this.dirty = false;
    this.renderStatus();
    try {
      await this.app.client.api('PUT', `/api/notes/${this.noteId}`, { text: this.value, origin: this.app.client.clientId });
    } catch (e) {
      this.dirty = true;
      this.app.ui.toast(`Note not saved: ${e.message}`);
    } finally {
      this.saving = false;
      this.renderStatus();
      if (this.dirty) this.saveSoon();
    }
  }

  /** Last chance on unload or when the panel goes away: a request that outlives the page. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    fetch(`/api/notes/${this.noteId}`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: this.value, origin: this.app.client.clientId }) }).catch(() => {});
  }

  async action(act) {
    const { ui, client } = this.app;
    switch (act) {
      case 'rename': {
        const n = client.note(this.noteId);
        const title = await ui.prompt('Rename note', n?.title || '', 'Title');
        if (title?.trim()) await client.api('PUT', `/api/notes/${this.noteId}`, { title }).catch((e) => ui.toast(e.message));
        break;
      }
      case 'delete': await ui.deleteNote(this.app, this.noteId); break;
      case 'max': if (this.api.isMaximized()) this.api.exitMaximized(); else this.api.maximize(); break;
      case 'close': this.api.close(); break;
      default: break;
    }
  }

  renderMissing() {
    this.element.replaceChildren(
      h('div', { class: 'tp-missing' },
        h('p', {}, 'This note no longer exists.'),
        h('button', { class: 'btn small', onclick: () => this.api.close() }, 'Close')));
  }

  /** After a reconnect: show what the server has now. */
  reattach() { const n = this.app.client.note(this.noteId); if (n) this.onNote({ note: n, remote: true }); }

  applySettings() { this.editor?.updateOptions(settingsOptions(this.app)); }
  /** Word wrap for this tab, kept in the layout. */
  toggleWrap() {
    this.wrap = !this.wrap;
    this.editor?.updateOptions({ wordWrap: this.wrap ? 'on' : 'off' });
    this.api.updateParameters({ wrap: this.wrap });
  }

  focus() { this.editor?.focus(); }
  toggleMaximize() { this.action('max'); }
  toggleSearch() { this.editor?.getAction('actions.find')?.run(); }
  restart() {}

  dispose() {
    this.flush();
    this.disposed = true;
    this.editor?.dispose();
    this.model?.dispose();
    this.project.panels.delete(this.api?.id);
    this.unsubNote?.(); this.unsubRemoved?.();
    this.disposeActive?.dispose?.();
    window.removeEventListener('beforeunload', this.onUnload);
  }
}
