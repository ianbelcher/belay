import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteSync, log } from './util.js';
import { DEFAULT_TEMPLATES } from '../shared/template-core.js';

export const DEFAULT_SETTINGS = {
  fontSize: 13,
  // 0: editors use the terminal's size
  editorFontSize: 0,
  // Open in VS Code: the ssh host your VS Code's Remote-SSH window is connected to, as VS Code names it.
  vscodeHost: '',
  fontFamily: '',
  copyOnSelect: true,
  rightClickPaste: true,
  cursorBlink: true,
  theme: 'dark',
  clientScrollback: 50000,
  serverScrollback: 20000,
  probeCwdMs: 3000,
  scrollbackSaveMs: 30000,
  keybindings: {},
};

const SETTING_TYPES = {
  fontSize: 'number', editorFontSize: 'number', vscodeHost: 'string', fontFamily: 'string', copyOnSelect: 'boolean', rightClickPaste: 'boolean',
  cursorBlink: 'boolean', theme: 'string', clientScrollback: 'number', serverScrollback: 'number',
  probeCwdMs: 'number', scrollbackSaveMs: 'number', keybindings: 'object',
};

export function coerceSettings(input, base) {
  const out = { ...base };
  for (const [k, type] of Object.entries(SETTING_TYPES)) {
    if (!(k in (input || {}))) continue;
    const v = input[k];
    if (type === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
    else if (type === 'boolean') out[k] = v === true || v === 'true' || v === 1;
    else if (type === 'object') { if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v; }
    else out[k] = String(v ?? '');
  }
  out.fontSize = Math.min(40, Math.max(8, out.fontSize));
  out.editorFontSize = out.editorFontSize ? Math.min(40, Math.max(6, Math.round(out.editorFontSize))) : 0;
  out.clientScrollback = Math.min(1_000_000, Math.max(100, out.clientScrollback));
  out.serverScrollback = Math.min(200_000, Math.max(100, out.serverScrollback));
  out.probeCwdMs = Math.min(60_000, Math.max(500, out.probeCwdMs));
  out.scrollbackSaveMs = Math.min(600_000, Math.max(2_000, out.scrollbackSaveMs));
  if (!['dark', 'light'].includes(out.theme)) out.theme = 'dark';
  // A host name (it goes into a vscode:// link), or "local".
  out.vscodeHost = /^[\w.-]{0,255}$/.test(out.vscodeHost) ? out.vscodeHost : '';
  return out;
}

/** JSON file persistence for templates, sessions, projects and settings. */
export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    this.state = null;
    this._timer = null;
  }

  load() {
    let s = null;
    try {
      s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        const bak = `${this.file}.corrupt-${Date.now()}`;
        log(`state file unreadable (${e.message}); moving it to ${bak}`);
        try { fs.renameSync(this.file, bak); } catch {}
      }
    }
    if (!s || typeof s !== 'object') s = {};
    s.version = 1;
    s.templates = Array.isArray(s.templates) ? s.templates : [];
    s.sessions = Array.isArray(s.sessions) ? s.sessions : [];
    s.projects = Array.isArray(s.projects) ? s.projects : [];
    s.notes = Array.isArray(s.notes) ? s.notes : [];
    s.pages = Array.isArray(s.pages) ? s.pages : [];
    s.walls = Array.isArray(s.walls) ? s.walls : [];
    s.settings = coerceSettings(s.settings || {}, DEFAULT_SETTINGS);
    // Each built-in template is added once, so one the user deleted stays deleted, and one added in a later
    // version still arrives.
    s.seededTemplates = Array.isArray(s.seededTemplates) ? s.seededTemplates : [];
    for (const t of DEFAULT_TEMPLATES) {
      if (s.seededTemplates.includes(t.id)) continue;
      if (!s.templates.some((x) => x.id === t.id)) s.templates.push(structuredClone(t));
      s.seededTemplates.push(t.id);
    }
    this.state = s;
    this.saveSync();
    return s;
  }

  /** Debounced save; the state file is small so a sync write is fine. */
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => this.saveSync(), 150);
  }

  saveSync() {
    clearTimeout(this._timer);
    this._timer = null;
    atomicWriteSync(this.file, JSON.stringify(this.state, null, 2));
  }
}

