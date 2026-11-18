import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HttpError, readJson, sendJson, stripAnsi, expandHome, loginShell, shortId, isLocalRequest } from './util.js';
import { coerceSettings } from './store.js';
import { resolveLocal, readTextFile, writeTextFile, listEntries } from './files.js';
import { sendMedia, statFile } from './media.js';
import { AGENT_IDS, BUILTIN_VARS, DEFAULT_TEMPLATES, EXIT_POLICIES, parseFields, launch, renderName, validateTemplate, normalizeTemplate } from '../shared/template-core.js';
import { HOST_RE, USER_RE } from '../shared/ssh.js';
import { configHosts, resolve as resolveSsh } from './ssh.js';

const BELAY_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const pkg = createRequire(import.meta.url)('../package.json');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'template';

export function createApi({ mgr, store, broadcast, dataDir, port, baseUrl, pages }) {
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
  const serverInfo = () => ({
    version: pkg.version, dataDir, port, baseUrl, platform: process.platform, home: os.homedir(),
    shell: loginShell(), builtins: BUILTIN_VARS, exitPolicies: EXIT_POLICIES, hostname: os.hostname(), belaydir: BELAY_DIR,
  });
  const state = () => ({
    templates: store.state.templates,
    sessions: mgr.list(),
    projects: store.state.projects,
    notes: store.state.notes,
    walls: store.state.walls,
    settings: store.state.settings,
    server: serverInfo(),
  });

  on('GET', '/api/health', () => ({ ok: true, version: pkg.version, sessions: store.state.sessions.length }));
  on('GET', '/api/state', () => state());

  // ---- templates -------------------------------------------------------------
  on('GET', '/api/templates', () => store.state.templates);
  // ---- ssh: the hosts your ssh config names, and what one resolves to (`ssh -G`, nothing connects) -----------
  on('GET', '/api/ssh/hosts', () => configHosts());
  on('GET', '/api/ssh/resolve', async (_req, _m, url) => {
    const host = url.searchParams.get('host') || '';
    const user = url.searchParams.get('user') || '';
    if (!HOST_RE.test(host) || (user && !USER_RE.test(user))) throw new HttpError(400, 'not a host');
    return resolveSsh(user ? `${user}@${host}` : host);
  });
  on('POST', '/api/templates/preview', async (req) => {
    const body = await readJson(req);
    const t = { name: body.name || 'preview', command: body.command || '', provision: body.provision || '', nameTemplate: body.nameTemplate || '', defaults: body.defaults || {}, agent: body.agent || '' };
    const builtins = { shell: loginShell(), cwd: body.cwd || os.homedir(), home: os.homedir(), name: body.sessionName || '', sid: 'SESSION_ID', port, url: baseUrl, belaydir: BELAY_DIR };
    const parsed = parseFields(t.command, t.provision);
    let command = '', provision = '', name = '', error = parsed.error || null;
    if (!error) {
      try { ({ command, provision } = launch(t, body.vars || {}, builtins)); name = renderName(t, body.vars || {}, builtins); }
      catch (e) { error = e.message; }
    }
    return { command, provision, name, fields: parsed.fields, error };
  });
  on('POST', '/api/templates/reset', () => {
    for (const d of DEFAULT_TEMPLATES) {
      const i = store.state.templates.findIndex((t) => t.id === d.id);
      if (i >= 0) store.state.templates[i] = structuredClone(d);
      else store.state.templates.push(structuredClone(d));
    }
    store.save();
    broadcast({ t: 'templates', templates: store.state.templates });
    return store.state.templates;
  });
  on('POST', '/api/templates/([^/]+)/reset', (_req, [id]) => {
    const d = DEFAULT_TEMPLATES.find((t) => t.id === id);
    if (!d) throw new HttpError(404, 'not a built-in template');
    const i = store.state.templates.findIndex((t) => t.id === id);
    if (i >= 0) store.state.templates[i] = structuredClone(d);
    else store.state.templates.push(structuredClone(d));
    store.save();
    broadcast({ t: 'templates', templates: store.state.templates });
    for (const s of store.state.sessions) if (s.templateId === id) mgr.emit('session', mgr.publicOf(s));
    return structuredClone(d);
  });
  on('POST', '/api/templates', async (req) => {
    const body = await readJson(req);
    const t = normalizeTemplate(body);
    const errors = validateTemplate(t);
    if (errors.length) throw new HttpError(400, errors.join('; '));
    let id = slug(body.id || t.name);
    while (store.state.templates.some((x) => x.id === id)) id = `${slug(t.name)}-${shortId(2)}`;
    t.id = id;
    store.state.templates.push(t);
    store.save();
    broadcast({ t: 'templates', templates: store.state.templates });
    return t;
  });
  on('PUT', '/api/templates/([^/]+)', async (req, [id]) => {
    const i = store.state.templates.findIndex((x) => x.id === id);
    if (i < 0) throw new HttpError(404, 'template not found');
    const body = await readJson(req);
    const t = normalizeTemplate(body, store.state.templates[i]);
    const errors = validateTemplate(t);
    if (errors.length) throw new HttpError(400, errors.join('; '));
    store.state.templates[i] = t;
    store.save();
    broadcast({ t: 'templates', templates: store.state.templates });
    for (const s of store.state.sessions) if (s.templateId === id) mgr.emit('session', mgr.publicOf(s));
    return t;
  });
  on('DELETE', '/api/templates/([^/]+)', (_req, [id]) => {
    const used = store.state.sessions.filter((s) => s.templateId === id);
    if (used.length) throw new HttpError(409, `template is used by ${used.length} session(s): ${used.map((s) => s.name).join(', ')}`);
    const before = store.state.templates.length;
    store.state.templates = store.state.templates.filter((x) => x.id !== id);
    if (store.state.templates.length === before) throw new HttpError(404, 'template not found');
    store.save();
    broadcast({ t: 'templates', templates: store.state.templates });
    return { ok: true };
  });

  // ---- sessions --------------------------------------------------------------
  on('GET', '/api/sessions', () => mgr.list());
  on('POST', '/api/sessions', async (req) => mgr.create(await readJson(req)));
  on('GET', '/api/sessions/([^/]+)', (_req, [id]) => mgr.publicOf(mgr.find(id)));
  on('PATCH', '/api/sessions/([^/]+)', async (req, [id]) => mgr.update(id, await readJson(req)));
  on('DELETE', '/api/sessions/([^/]+)', async (_req, [id]) => { await mgr.remove(id); return { ok: true }; });
  on('POST', '/api/sessions/([^/]+)/start', async (_req, [id]) => { await mgr.start(id); return mgr.publicOf(mgr.find(id)); });
  on('POST', '/api/sessions/([^/]+)/stop', (_req, [id]) => mgr.stop(id));
  on('POST', '/api/sessions/([^/]+)/restart', (_req, [id]) => mgr.restart(id));
  on('GET', '/api/sessions/([^/]+)/scrollback', async (req, [id], url, res) => {
    const s = mgr.find(id);
    let text = await mgr.scrollbackOf(id);
    if (url.searchParams.get('plain') === '1') text = stripAnsi(text).replace(/\r/g, '');
    const fname = `${s.name.replace(/[^\w.-]+/g, '_')}.${url.searchParams.get('plain') === '1' ? 'txt' : 'ansi'}`;
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Cache-Control': 'no-store',
    });
    res.end(text);
    return undefined;
  });

  // ---- projects (and their layouts, owned by the browser, stored here) --------
  on('PUT', '/api/projects', async (req) => {
    const body = await readJson(req);
    if (!Array.isArray(body.projects)) throw new HttpError(400, 'projects must be an array');
    const projects = body.projects.map((v) => ({
      id: String(v.id || shortId()),
      name: String(v.name || 'Project').slice(0, 60),
      // Rendered into ssh command lines, so only plain host and user names are kept.
      host: typeof v.host === 'string' && v.host.length <= 255 && HOST_RE.test(v.host) ? v.host : '',
      user: typeof v.user === 'string' && v.user.length <= 64 && USER_RE.test(v.user) ? v.user : '',
      // The directory everything in the project starts in, on its host or here.
      dir: typeof v.dir === 'string' ? v.dir.trim().slice(0, 4096) : '',
      // Closed: kept, with its sessions, until one of them is opened again.
      hidden: !!v.hidden,
      noteId: typeof v.noteId === 'string' ? v.noteId.slice(0, 32) : null,
      wallId: typeof v.wallId === 'string' ? v.wallId.slice(0, 32) : null,
      layout: v.layout && typeof v.layout === 'object' ? v.layout : null,
    }));
    store.state.projects = projects;
    store.save();
    broadcast({ t: 'projects', projects, origin: body.origin || null });
    return projects;
  });

  // ---- notes: free text shown as panels in a project, shared by every browser ----
  const NOTE_MAX = 1024 * 1024;
  const noteOf = (id) => {
    const n = store.state.notes.find((x) => x.id === id);
    if (!n) throw new HttpError(404, 'note not found');
    return n;
  };
  const applyNote = (n, body) => {
    if (body.title != null) n.title = String(body.title).trim().slice(0, 60) || n.title || 'Notes';
    if (body.text != null) {
      const text = String(body.text);
      if (Buffer.byteLength(text) > NOTE_MAX) throw new HttpError(413, 'a note is limited to 1 MB');
      n.text = text;
    }
    n.updatedAt = new Date().toISOString();
  };
  on('GET', '/api/notes', () => store.state.notes);
  on('POST', '/api/notes', async (req) => {
    const body = await readJson(req);
    const n = { id: shortId(), title: 'Notes', text: '', updatedAt: null };
    applyNote(n, body);
    store.state.notes.push(n);
    store.save();
    broadcast({ t: 'note', note: n, origin: body.origin || null });
    return n;
  });
  on('GET', '/api/notes/([^/]+)', (_req, [id]) => noteOf(id));
  on('PUT', '/api/notes/([^/]+)', async (req, [id]) => {
    const n = noteOf(id);
    const body = await readJson(req);
    applyNote(n, body);
    store.save();
    broadcast({ t: 'note', note: n, origin: body.origin || null });
    return n;
  });
  on('DELETE', '/api/notes/([^/]+)', (_req, [id]) => {
    noteOf(id);
    store.state.notes = store.state.notes.filter((x) => x.id !== id);
    store.save();
    broadcast({ t: 'note-removed', id });
    return { ok: true };
  });

  // ---- post-it walls: one per project, a board of notes that nest by sitting inside each other ----
  const WALL_ITEMS = 5000;
  const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
  const wallOf = (id) => {
    const w = store.state.walls.find((x) => x.id === id);
    if (!w) throw new HttpError(404, 'post-it wall not found');
    return w;
  };
  /** Only what a note is made of: its text, where it sits, its size and colors. */
  const cleanItems = (items) => {
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be an array');
    if (items.length > WALL_ITEMS) throw new HttpError(413, `a wall holds up to ${WALL_ITEMS} notes`);
    const seen = new Set();
    return items.map((it) => {
      const id = typeof it?.id === 'string' && /^[\w-]{1,32}$/.test(it.id) && !seen.has(it.id) ? it.id : shortId();
      seen.add(id);
      return {
        id,
        text: String(it?.text ?? '').slice(0, 20000),
        x: num(it?.x, -1e6, 1e6, 0), y: num(it?.y, -1e6, 1e6, 0),
        w: num(it?.w, 40, 20000, 160), h: num(it?.h, 30, 20000, 110),
        color: COLOR_RE.test(it?.color) ? it.color : null,
        fontColor: COLOR_RE.test(it?.fontColor) ? it.fontColor : null,
      };
    });
  };
  on('GET', '/api/walls', () => store.state.walls);
  on('POST', '/api/walls', async (req) => {
    const body = await readJson(req);
    const w = { id: shortId(), title: String(body.title || 'Post-its').trim().slice(0, 60) || 'Post-its', items: body.items ? cleanItems(body.items) : [], updatedAt: new Date().toISOString() };
    store.state.walls.push(w);
    store.save();
    broadcast({ t: 'wall', wall: w, origin: body.origin || null });
    return w;
  });
  on('GET', '/api/walls/([^/]+)', (_req, [id]) => wallOf(id));
  on('PUT', '/api/walls/([^/]+)', async (req, [id]) => {
    const w = wallOf(id);
    const body = await readJson(req, 16_000_000);
    if (body.items != null) w.items = cleanItems(body.items);
    if (body.title != null) w.title = String(body.title).trim().slice(0, 60) || w.title;
    w.updatedAt = new Date().toISOString();
    store.save();
    broadcast({ t: 'wall', wall: w, origin: body.origin || null });
    return w;
  });
  on('DELETE', '/api/walls/([^/]+)', (_req, [id]) => {
    wallOf(id);
    store.state.walls = store.state.walls.filter((x) => x.id !== id);
    store.save();
    broadcast({ t: 'wall-removed', id });
    return { ok: true };
  });

  // ---- settings ----------------------------------------------------------------
  on('GET', '/api/settings', () => store.state.settings);
  on('PUT', '/api/settings', async (req) => {
    const body = await readJson(req);
    store.state.settings = coerceSettings(body, store.state.settings);
    store.save();
    mgr.applySettings();
    broadcast({ t: 'settings', settings: store.state.settings });
    return store.state.settings;
  });

  // ---- agent hooks (Claude Code, Codex, opencode): conversation id for resume, plus activity (busy / idle / attention) ----
  on('POST', `/api/hook/(${AGENT_IDS.join('|')})`, async (req, m, url) => {
    if (!isLocalRequest(req)) throw new HttpError(403, 'hooks are accepted from this machine only');
    const sid = url.searchParams.get('belay');
    const body = await readJson(req);
    const s = store.state.sessions.find((x) => x.id === sid);
    if (!s) return { ok: false, reason: 'unknown belay session' };
    let changed = false;
    // The id is rendered unescaped into the next command line, so only a plain token is kept (Claude and
    // Codex use UUIDs, opencode ses_…).
    const convId = String(body.session_id || '').trim();
    if (/^[\w-]{1,128}$/.test(convId) && s.vars.session !== convId) {
      s.vars = { ...s.vars, session: convId };
      changed = true;
      store.save();
    }
    if (mgr.applyHookEvent(s, body, m[0])) changed = true;
    if (changed) mgr.emit('session', mgr.publicOf(s));
    return { ok: true, activity: s.activity?.state ?? null };
  });

  // ---- files in editor tabs: from paths printed in a terminal, or picked ------------
  on('POST', '/api/files/resolve', async (req) => {
    const body = await readJson(req);
    const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
    return { paths: await resolveLocal(typeof body.cwd === 'string' ? body.cwd : '', paths) };
  });
  on('GET', '/api/files', async (_req, _m, url) => {
    const q = (k) => url.searchParams.get(k) || '';
    return readTextFile({ path: q('path'), host: q('host'), user: q('user'), dir: q('dir') });
  });
  // PDFs, images, video and audio for a viewer tab: the bytes, with ranges; and whether the file changed.
  const fileQuery = (url) => Object.fromEntries(['path', 'host', 'user', 'dir'].map((k) => [k, url.searchParams.get(k) || '']));
  on('GET', '/api/files/raw', async (req, _m, url, res) => { await sendMedia(req, res, fileQuery(url)); });
  on('GET', '/api/files/stat', (_req, _m, url) => statFile(fileQuery(url)));
  on('PUT', '/api/files', async (req) => {
    // Room for 2 MB of text after JSON escaping.
    const b = await readJson(req, 16_000_000);
    const str = (v) => (typeof v === 'string' ? v : '');
    return writeTextFile({ path: str(b.path), host: str(b.host), user: str(b.user), dir: str(b.dir), text: b.text, base: b.base ?? null, create: !!b.create, force: !!b.force });
  });
  on('GET', '/api/fs/entries', async (_req, _m, url) => {
    const q = (k) => url.searchParams.get(k) || '';
    return listEntries({ path: q('path'), host: q('host'), user: q('user'), dir: q('dir'), hidden: q('hidden') === '1' });
  });

  // ---- remote pages: a web address opened from the project's machine, served by belay ----
  on('POST', '/api/pages', async (req) => pages.register(await readJson(req), req));

  // ---- directory browsing for the new-session dialog ---------------------------
  on('GET', '/api/fs/dirs', async (_req, _m, url) => {
    let p = expandHome(url.searchParams.get('path') || '') || os.homedir();
    if (!path.isAbsolute(p)) p = path.join(os.homedir(), p);
    const showHidden = url.searchParams.get('hidden') === '1';
    let st = await fsp.stat(p).catch(() => null);
    let prefix = '';
    if (!st?.isDirectory()) { prefix = path.basename(p).toLowerCase(); p = path.dirname(p); st = await fsp.stat(p).catch(() => null); }
    if (!st?.isDirectory()) return { path: p, exists: false, dirs: [] };
    const entries = await fsp.readdir(p, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((e) => e.isDirectory() && (showHidden || !e.name.startsWith('.')) && e.name.toLowerCase().startsWith(prefix))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 300);
    return { path: p, exists: true, dirs: dirs.map((d) => path.join(p, d)) };
  });

  async function handle(req, res, url) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      try {
        const out = await r.handler(req, m.slice(1).map(decodeURIComponent), url, res);
        if (out !== undefined) sendJson(res, 200, out);
        return true;
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error(e);
        sendJson(res, status, { error: e.message || String(e) });
        return true;
      }
    }
    if (url.pathname.startsWith('/api/')) { sendJson(res, 404, { error: 'not found' }); return true; }
    return false;
  }
  handle.state = state;
  return handle;
}
