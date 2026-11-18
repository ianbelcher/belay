import { h } from './util.js';
import { AGENTS } from '../shared/template-core.js';
import { chordFromEvent, normalizeChord } from '../shared/chords.js';

/** Cmd is the modifier on macOS and iOS; Ctrl everywhere else. */
export const IS_MAC = typeof navigator !== 'undefined'
  && (/Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || navigator.userAgentData?.platform === 'macOS');

/**
 * Every command the UI exposes. `keys` are the defaults; `mac` replaces them on macOS, where Cmd
 * never reaches the terminal so unshifted chords (Cmd+T, Cmd+F) are safe. Users override both in Settings.
 */
export const COMMANDS = [
  { id: 'palette', label: 'Command palette', keys: ['Ctrl+Shift+P'], mac: ['Cmd+Shift+P'] },
  // Everything shown again from the server, sessions untouched; unsaved file edits come back as drafts.
  { id: 'reload', label: 'Reload window', keys: [] },
  { id: 'new-session', label: 'New session', keys: ['Ctrl+Shift+`'], mac: ['Cmd+T'] },
  { id: 'files', label: 'Files sidebar', keys: ['Ctrl+Shift+E'], mac: ['Cmd+Shift+E'] },
  { id: 'sessions', label: 'Sessions sidebar', keys: ['Ctrl+Shift+S'], mac: ['Cmd+Shift+S'] },
  { id: 'shell-here', label: 'New shell', keys: [] },
  ...AGENTS.map((a) => ({ id: `${a.id}-here`, label: `New ${a.label}`, keys: [] })),
  { id: 'duplicate-pane', label: 'Duplicate session', keys: [] },
  { id: 'toggle-notes', label: 'Show / hide project notes', keys: ['Ctrl+Shift+K'], mac: ['Cmd+Shift+K'] },
  { id: 'toggle-postits', label: 'Show / hide project post-its', keys: [] },
  { id: 'new-web', label: 'New web tab', keys: [] },
  { id: 'new-remote-page', label: 'New remote page', keys: [] },
  { id: 'open-file', label: 'Open file', keys: ['Ctrl+Shift+O'], mac: ['Cmd+O'] },
  { id: 'new-project', label: 'New project', keys: ['Ctrl+Shift+D'], mac: ['Cmd+Shift+D'] },
  { id: 'edit-project', label: 'Edit project', keys: [] },
  { id: 'close-project', label: 'Close project', keys: [] },
  { id: 'next-project', label: 'Next project', keys: [] },
  { id: 'prev-project', label: 'Previous project', keys: [] },
  // Cmd+Tab belongs to macOS, so the Mac set uses Chrome's own tab chords plus Ctrl+Tab.
  { id: 'next-tab', label: 'Next tab in project', keys: ['Ctrl+Tab', 'Ctrl+Shift+]'], mac: ['Cmd+Shift+]', 'Ctrl+Tab'] },
  { id: 'prev-tab', label: 'Previous tab in project', keys: ['Ctrl+Shift+Tab', 'Ctrl+Shift+['], mac: ['Cmd+Shift+[', 'Ctrl+Shift+Tab'] },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `project-${i + 1}`, label: `Switch to project ${i + 1}`, keys: [`Ctrl+${i + 1}`], mac: [`Cmd+${i + 1}`] })),
  { id: 'editor-bigger', label: 'Editor: larger text', keys: [] },
  { id: 'editor-smaller', label: 'Editor: smaller text', keys: [] },
  { id: 'editor-reset-size', label: 'Editor: reset text size', keys: [] },
  { id: 'editor-wrap', label: 'Editor: toggle word wrap', keys: [] },
  { id: 'toggle-tabbar', label: 'Show / hide tab bar', keys: [] },
  { id: 'maximize', label: 'Maximize / restore pane', keys: ['Ctrl+Shift+Enter'], mac: ['Cmd+Shift+Enter'] },
  { id: 'find', label: 'Find in pane', keys: ['Ctrl+Shift+F'], mac: ['Cmd+F'] },
  { id: 'restart-pane', label: 'Restart pane', keys: ['Ctrl+Shift+R'], mac: ['Cmd+Shift+R'] },
  { id: 'stop-pane', label: 'Stop pane', keys: [] },
  { id: 'edit-pane', label: 'Edit session', keys: [] },
  // Cmd+W as in any app: in the installed app belay gets it before the window does, and closes the tab, not
  // belay. (A browser tab keeps it.) Outside macOS Ctrl+W deletes a word in the shell, so it is Ctrl+Shift+W.
  { id: 'close-pane', label: 'Close tab', keys: ['Ctrl+Shift+W', 'Ctrl+Shift+X'], mac: ['Cmd+W', 'Cmd+Shift+X'] },
  { id: 'settings', label: 'Settings', keys: ['Ctrl+,'], mac: ['Cmd+,'] },
  { id: 'shortcuts', label: 'Keyboard shortcuts', keys: [] },
  { id: 'help', label: 'Help', keys: [] },
  { id: 'toggle-theme', label: 'Toggle light / dark theme', keys: [] },
  { id: 'install-app', label: 'Install as app', keys: [] },
];

/** Default chords for a command on this platform. */
export const defaultKeys = (c) => (IS_MAC && c.mac) || c.keys;

/** Chord as shown to the user: the modifier is Cmd on a Mac, Meta elsewhere. */
export const displayChord = (k) => normalizeChord(k).split('+').map((p) => (p === 'Meta' ? (IS_MAC ? 'Cmd' : 'Meta') : p)).join('+');

export { chordFromEvent, normalizeChord };

/** Binds chords to commands, runs them, and feeds the palette. */
export class Keys {
  constructor(app) { this.app = app; this.map = new Map(); }

  bindings(id) {
    const user = this.app.settings().keybindings || {};
    if (Array.isArray(user[id])) return user[id];
    const c = COMMANDS.find((x) => x.id === id);
    return c ? defaultKeys(c) : [];
  }

  rebuild() {
    this.map.clear();
    for (const c of COMMANDS) for (const k of this.bindings(c.id)) this.map.set(normalizeChord(k), c.id);
  }

  match(e) {
    const ch = chordFromEvent(e);
    return ch ? this.map.get(normalizeChord(ch)) : undefined;
  }

  install() {
    this.rebuild();
    // Capture phase: runs before xterm sees the key, so chords work while a terminal has focus.
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      const id = this.match(e);
      if (!id) return;
      if (e.target.closest?.('.keyrec')) return; // the shortcut recorder owns the key
      e.preventDefault();
      e.stopPropagation();
      this.run(id);
    }, true);
  }

  run(id, panel = this.app.activePanel()) {
    const { app } = this;
    const m = /^project-(\d)$/.exec(id);
    if (m) { app.dock.switchToIndex(Number(m[1]) - 1); return; }
    // shell-here, claude-here, codex-here, opencode-here
    const here = /^(\w+)-here$/.exec(id);
    if (here) { app.ui.openHere(app, here[1], { from: app.dock.sessionOf()?.id }); return; }
    switch (id) {
      case 'palette': app.ui.openPalette(app); break;
      case 'reload': window.belayReloading = true; window.location.reload(); break;
      case 'new-session': app.ui.openNewSession(app); break;
      case 'sessions': app.side?.toggle('sessions'); break;
      case 'files': app.side?.toggle('files'); break;
      case 'new-project': app.ui.openProjectDialog(app); break;
      case 'duplicate-pane': { const s = app.dock.sessionOf(); if (s) app.ui.duplicateSession(app, s.id); break; }
      case 'toggle-notes': app.dock.toggleNotes().catch((e) => app.ui.toast(e.message)); break;
      case 'toggle-postits': app.dock.toggleWall().catch((e) => app.ui.toast(e.message)); break;
      case 'new-web': app.ui.openWebDialog(app); break;
      case 'new-remote-page': app.ui.openWebDialog(app, { remote: true }); break;
      case 'open-file': app.ui.openFileDialog(app); break;
      case 'edit-project': app.ui.promptRename(app, app.dock.activeView()); break;
      case 'close-project': app.dock.confirmRemove(app.dock.activeView()); break;
      case 'next-project': app.dock.step(1); break;
      case 'prev-project': app.dock.step(-1); break;
      case 'next-tab': app.dock.stepPanel(1); break;
      case 'prev-tab': app.dock.stepPanel(-1); break;
      case 'maximize': panel?.toggleMaximize(); break;
      case 'editor-bigger': app.ui.setEditorFontSize(app, 1); break;
      case 'editor-smaller': app.ui.setEditorFontSize(app, -1); break;
      case 'editor-reset-size': app.ui.setEditorFontSize(app, 0); break;
      case 'editor-wrap': if (panel?.toggleWrap) panel.toggleWrap(); else app.ui.toast('Word wrap is for file and note tabs', 'info'); break;
      case 'toggle-tabbar': { const g = panel?.api.group; if (g) app.dock.current()?.setTabBar(g, !!g.header.hidden); break; }
      case 'find': panel?.toggleSearch(true); break;
      case 'restart-pane': panel?.restart(); break;
      case 'stop-pane': panel?.action('stop'); break;
      case 'edit-pane': panel?.action('edit'); break;
      case 'close-pane': if (panel) app.dock.closePanel(panel.api.id); break;
      case 'settings': app.ui.openSettings(app); break;
      case 'shortcuts': app.ui.openSettings(app, 'shortcuts'); break;
      case 'help': app.ui.openHelp(app); break;
      case 'toggle-theme': app.toggleTheme(); break;
      case 'install-app': app.installApp(); break;
      default: break;
    }
  }

  /** Items for the command palette: commands, projects, sessions, notes, templates. */
  paletteItems() {
    const { app } = this;
    const items = [];
    for (const c of COMMANDS) {
      if (c.id === 'palette') continue;
      if (c.id === 'install-app' && !app.installPrompt) continue;
      if (/^project-\d$/.test(c.id) && !app.dock.shown[Number(c.id.slice(8)) - 1]) continue;
      items.push({ label: c.label, keys: this.bindings(c.id), run: () => this.run(c.id) });
    }
    app.dock.shown.forEach((v, i) => items.push({ label: `Project: ${v.name}`, detail: v.id === app.dock.activeViewId ? 'current' : '', keys: this.bindings(`project-${i + 1}`), run: () => app.dock.switchView(v.id) }));
    // Closed ones too: opening one brings it back as it was.
    for (const v of app.dock.views.filter((x) => x.hidden)) items.push({ label: `Project: ${v.name}`, detail: 'closed', run: () => app.dock.switchView(v.id) });
    for (const s of app.client.sessionsSorted()) items.push({ label: `Session: ${s.name}`, detail: `${s.status} · ${s.cwd}`, run: () => app.dock.goToSession(s.id) });
    // Each project's note, and notes no project has, which go into this project's note.
    for (const n of app.client.state.notes.values()) {
      const owner = app.dock.viewOfNote(n.id);
      const first = (n.text || '').split('\n').find((l) => l.trim()) || '';
      if (owner) items.push({ label: `Notes: ${owner.name}`, detail: first, run: () => app.dock.openNote(n.id).catch((e) => app.ui.toast(e.message)) });
      else if (first) items.push({ label: `Recover note: ${first.slice(0, 60)}`, detail: `into ${app.dock.activeView()?.name}'s notes`, run: () => app.dock.openNote(n.id).catch((e) => app.ui.toast(e.message)) });
    }
    // Templates without a command of their own above (shell-here, claude-here…): htop, k9s, Command.
    for (const t of app.ui.launchers(app).filter((x) => !COMMANDS.some((c) => c.id === `${x.id}-here`))) items.push({ label: `New: ${app.ui.launcherLabel(t)}`, detail: 'in this project', run: () => app.ui.openHere(app, t.id, { from: app.dock.sessionOf()?.id }) });
    return items;
  }
}

/** Small chip list showing chords. */
export const chordChips = (keys) => keys.length ? keys.map((k) => h('kbd', {}, displayChord(k))) : [h('span', { class: 'hint' }, 'none')];
