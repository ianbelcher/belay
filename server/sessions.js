import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { shortId, nowIso, loginShell, atomicWriteSync, expandHome, HttpError, clamp, log } from './util.js';
import { fileURLToPath } from 'node:url';
import { launch, describeLaunch, renderName, parseFields, EXIT_POLICIES } from '../shared/template-core.js';
import { localHost, remoteHost, CannotHold } from './hold.js';
import { HOST_RE, USER_RE, parseTarget } from '../shared/ssh.js';
import { sessionName } from '../shared/names.js';
import { configUser } from './ssh.js';

const BELAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;

const PUBLIC_FIELDS = [
  'id', 'name', 'cwd', 'templateId', 'vars', 'exitPolicy', 'desired', 'status', 'exitCode',
  'pid', 'title', 'createdAt', 'startedAt', 'exitedAt', 'cols', 'rows', 'activity', 'lastOutputAt', 'starred', 'project',
  'link', 'linkNote',
];

// Hook events → activity state shown on the tab. Codex sends the same events as Claude Code, and
// belay's opencode plugin translates opencode's into them.
const ACTIVITY_BY_EVENT = {
  SessionStart: 'idle', UserPromptSubmit: 'busy', PreToolUse: 'busy', PostToolUse: 'busy',
  Stop: 'idle', SubagentStop: null, Notification: 'attention', PermissionRequest: 'attention', SessionEnd: 'gone',
};

const divider = (text) => `\r\n\x1b[2;3m── ${text} · ${new Date().toLocaleString()} ──\x1b[0m\r\n`;

/** A session's place, when it has one, is a host belay takes (it goes to ssh). */
function checkPlace(vars) {
  if (vars.host && !HOST_RE.test(vars.host)) throw new HttpError(400, `not a host: ${vars.host}`);
  if (vars.user && !USER_RE.test(vars.user)) throw new HttpError(400, `not a user name: ${vars.user}`);
  return vars;
}

/**
 * A template and values as they run: on a host whose ssh config sets a User, without the project's user, so
 * ssh uses the config's.
 */
function asRun(t, vars) {
  const name = vars.host && parseTarget(vars.host)?.name;
  if (!name || !vars.user || !configUser(name)) return [t, vars];
  const { user: _v, ...v } = vars;
  return [t, v];
}

function cleanVars(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (!/^[A-Za-z_][\w-]*$/.test(k)) continue;
      const s = val == null ? '' : String(val).trim();
      if (s) out[k] = s;
    }
  }
  return out;
}

/** Where a UTF-8 sequence cut off at the end of `b` starts (b.length when none is). */
function utf8Cut(b) {
  let i = b.length - 1;
  let n = 0;
  while (i >= 0 && n < 3 && (b[i] & 0xc0) === 0x80) { i--; n++; }
  if (i < 0) return b.length;
  const c = b[i];
  const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
  return need > n + 1 ? i : b.length;
}

/**
 * Every session's process belongs to a holder (belay-hold): the one on this machine, or the one on the
 * session's host, reached over ssh. The holders keep them running whether belay is running or not, connected
 * or not. Here each session has a headless xterm that follows its output and holds the real scrollback, so a
 * browser that (re)attaches gets an exact replay; it is saved to disk with the offset in the output it reached,
 * and belay, started again, follows on from exactly there.
 */
export class SessionManager extends EventEmitter {
  constructor({ store, dataDir, baseUrl, port }) {
    super();
    this.store = store;
    this.state = store.state;
    this.dataDir = dataDir;
    this.baseUrl = baseUrl;
    this.port = port;
    this.rt = new Map();
    this.hosts = new Map();
    this.scrollDir = path.join(dataDir, 'scrollback');
    fs.mkdirSync(this.scrollDir, { recursive: true });
    // Names this belay's sessions in a holder that other belays may use too (two computers, one server).
    if (!this.state.instance) { this.state.instance = shortId(); store.save(); }
  }

  /** The session's name in its holder. */
  hid(s) { return `${this.state.instance}.${s.id}`; }

  /** A machine's holder, kept connected: '' for this one, else `user@host`. */
  hostFor(target) {
    const key = target || '';
    let h = this.hosts.get(key);
    if (!h) {
      h = key ? remoteHost(key, { tunnelPort: this.port }) : localHost({ dir: process.env.BELAY_HOLD_DIR || this.dataDir });
      h.on('state', (state, why) => this.onHostState(h, state, why));
      this.hosts.set(key, h);
    }
    return h;
  }

  /** A host with nothing on it is let go, rather than kept connected (or kept trying). */
  dropIdleHost(target) {
    const h = this.hosts.get(target);
    if (!h || !target) return;
    for (const r of this.rt.values()) if (r.run?.host === h) return;
    h.stop();
    this.hosts.delete(target);
  }

  /** Sessions show whether their host is connected; a holder coming back also gets tidied. */
  onHostState(h, state, why) {
    for (const s of this.state.sessions) {
      const r = this.rt.get(s.id);
      if (r?.run?.host !== h || r.run.plain) continue;
      const link = state === 'up' ? null : 'reconnecting';
      const note = link ? `${h.key}: ${why || state}` : null;
      if (s.link !== link || s.linkNote !== note) { s.link = link; s.linkNote = note; this.emit('session', this.publicOf(s)); }
    }
    if (state === 'up') this.tidy(h).catch((e) => log(`tidying ${h.key || 'this machine'}: ${e.message}`));
    if (state === 'cannot') {
      for (const s of this.state.sessions) { const r = this.rt.get(s.id); if (r?.run?.host === h) this.onLost(s, r, r.run, new Error(why)); }
    }
  }

  /** Lets go of what a holder still has of this belay's that is not running any more: deleted, or stopped while away. */
  async tidy(h) {
    const { sessions } = await h.request('list');
    const mine = `${this.state.instance}.`;
    for (const x of sessions) {
      if (!x.id.startsWith(mine)) continue;
      const s = this.state.sessions.find((y) => this.hid(y) === x.id);
      const r = s && this.rt.get(s.id);
      if (r?.run?.host === h && r.run.hid === x.id) continue;
      if (s && r?.starting) continue;
      await h.request('forget', { id: x.id }).catch(() => {});
    }
  }

  get settings() { return this.state.settings; }

  // ---- lookups -----------------------------------------------------------

  list() { return this.state.sessions.map((s) => this.publicOf(s)); }

  find(id) {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) throw new HttpError(404, 'session not found');
    return s;
  }

  template(id) {
    const t = this.state.templates.find((x) => x.id === id);
    if (!t) throw new HttpError(400, `template not found: ${id}`);
    return t;
  }

  /**
   * Where a session runs: its project's host, user and directory, as the project says now (so a project moved
   * elsewhere takes its sessions with it at their next start). A session of no project (one made through the
   * API) has its own: host and user in its values, and its `dir` there or its cwd here.
   */
  placeOf(s) {
    const p = s.project && this.state.projects.find((x) => x.id === s.project);
    if (p) return { host: p.host || '', user: p.host ? p.user || '' : '', dir: p.dir || '', project: true };
    return { host: s.vars?.host || '', user: s.vars?.user || '', dir: s.vars?.host ? s.vars?.dir || '' : '', project: false };
  }

  /** The session's values as it runs: its own fields, in its project's place. */
  runVars(s) {
    const { host: _h, user: _u, dir: _d, ...own } = s.vars || {};
    const { host, user, dir } = this.placeOf(s);
    return { ...own, ...(host ? { host, user, ...(dir ? { dir } : {}) } : {}) };
  }

  /** The directory a session here starts in: its project's (home when it has none), else its own. */
  localCwd(s) {
    const place = this.placeOf(s);
    const want = place.project ? (place.dir ? expandHome(place.dir) : os.homedir()) : s.cwd;
    return want && fs.existsSync(want) ? want : os.homedir();
  }

  builtins(s) {
    return { shell: loginShell(), cwd: s.cwd, home: os.homedir(), name: s.name, sid: s.id, port: this.port, url: this.baseUrl, belaydir: BELAY_DIR };
  }

  publicOf(s) {
    const o = {};
    for (const k of PUBLIC_FIELDS) o[k] = s[k];
    const r = this.rt.get(s.id);
    o.attached = r ? r.clients.size : 0;
    try {
      const t = this.template(s.templateId);
      const l = launch(...asRun(t, this.runVars(s)), this.builtins(s));
      // Running, it is where it was started, whatever its project says now.
      const running = (s.status === 'running' || s.status === 'starting') && s.hold && !s.hold.plain ? s.hold.host : null;
      Object.assign(o, { command: l.command, provision: l.provision, host: running ?? l.host, dir: l.dir });
      o.agent = t.agent || '';
    } catch (e) { o.command = `# template error: ${e.message}`; o.provision = ''; }
    return o;
  }

  // ---- CRUD ----------------------------------------------------------------

  async create(input) {
    const t = this.template(input.templateId);
    const cwd = await this.checkDir(input.cwd || os.homedir());
    const vars = checkPlace(cleanVars(input.vars));
    // The project it belongs to, which says where it runs.
    const project = typeof input.project === 'string' && this.state.projects.some((p) => p.id === input.project) ? input.project : null;
    const s = {
      id: shortId(),
      name: '',
      cwd,
      templateId: t.id,
      vars,
      project,
      exitPolicy: EXIT_POLICIES.includes(input.exitPolicy) ? input.exitPolicy : null,
      desired: input.autostart === false ? 'stopped' : 'running',
      status: 'stopped',
      exitCode: null,
      pid: null,
      title: '',
      createdAt: nowIso(),
      startedAt: null,
      exitedAt: null,
      cols: clamp(input.cols || 120, 2, 500),
      rows: clamp(input.rows || 30, 1, 300),
      activity: null,
      lastOutputAt: null,
    };
    const run = this.runVars(s);
    const missing = parseFields(t.command, t.provision).fields.filter((f) => f.required && !run[f.name] && !(t.defaults || {})[f.name]);
    if (missing.length) throw new HttpError(400, `missing required fields: ${missing.map((f) => f.name).join(', ')}`);
    // Its own name, unless the template makes one (Command names it after the command).
    s.name = String(input.name ?? '').trim()
      || (t.nameTemplate ? renderName(t, run, this.builtins(s)) : sessionName(new Set(this.state.sessions.map((x) => x.name))));
    if (s.project && !run.host) s.cwd = this.localCwd(s);
    this.state.sessions.push(s);
    this.store.save();
    if (s.desired === 'running') {
      // Here it starts at once; on a host it may take a while (the holder going on first): the answer does not
      // wait for that, and the session says it is starting.
      await Promise.race([this.start(s.id).catch(() => {}), new Promise((res) => setTimeout(res, 1500))]);
      if (!this.state.sessions.includes(s)) throw new HttpError(404, 'the session was deleted while it started');
    } else this.emit('session', this.publicOf(s));
    return this.publicOf(s);
  }

  async update(id, patch) {
    const s = this.find(id);
    if (patch.name != null) s.name = String(patch.name).trim() || s.name;
    if (patch.cwd != null) s.cwd = await this.checkDir(patch.cwd);
    if (patch.templateId != null) s.templateId = this.template(patch.templateId).id;
    if (patch.vars != null) s.vars = checkPlace(cleanVars(patch.vars));
    if (patch.exitPolicy !== undefined) s.exitPolicy = EXIT_POLICIES.includes(patch.exitPolicy) ? patch.exitPolicy : null;
    // A star in the sessions list: the ones to look at first.
    if (patch.starred !== undefined) s.starred = !!patch.starred;
    // The project it was last open in, kept after its tab closes: the sidebar lists it there, hidden.
    if (patch.project !== undefined) s.project = typeof patch.project === 'string' && /^[\w-]{1,32}$/.test(patch.project) ? patch.project : null;
    this.store.save();
    this.emit('session', this.publicOf(s));
    return this.publicOf(s);
  }

  async remove(id) {
    const s = this.find(id);
    const r = this.rt.get(id);
    if (r) {
      r.removing = true;
      this.clearTimers(r);
      if (r.run) await this.killAndWait(r);
      r.disposed = true;
      r.term.dispose();
      this.rt.delete(id);
    }
    this.state.sessions = this.state.sessions.filter((x) => x.id !== id);
    this.store.save();
    for (const f of [this.scrollFile(id), this.atFile(id)]) { try { fs.unlinkSync(f); } catch {} }
    this.emit('session-removed', id);
  }

  // ---- runtime -------------------------------------------------------------

  rtOf(s) {
    let r = this.rt.get(s.id);
    if (r) return r;
    const term = new Terminal({ cols: s.cols || 120, rows: s.rows || 30, scrollback: this.settings.serverScrollback, allowProposedApi: true });
    const ser = new SerializeAddon();
    term.loadAddon(ser);
    r = {
      run: null, term, ser, clients: new Set(), dirty: false, paused: false, fed: 0,
      probeTimer: null, saveTimer: null, restartTimer: null, backoff: 0, exitWaiters: [],
      restartPending: false, loadedFromDisk: false, hadProcess: false, removing: false, starting: false,
    };
    if (typeof term.onTitleChange === 'function') {
      term.onTitleChange((title) => {
        if (s.title === title) return;
        s.title = title;
        this.emit('session', this.publicOf(s));
      });
    }
    this.rt.set(s.id, r);
    return r;
  }

  /** The scrollback saved last time, and how far into the session's output it went. */
  restoreScrollback(s, r) {
    if (r.loadedFromDisk) return 0;
    r.loadedFromDisk = true;
    let data = '';
    try { data = fs.readFileSync(this.scrollFile(s.id), 'utf8'); } catch { return 0; }
    if (!data) return 0;
    r.term.write(data);
    r.hadProcess = true;
    try { return Number(JSON.parse(fs.readFileSync(this.atFile(s.id), 'utf8')).at) || 0; } catch { return 0; }
  }

  /**
   * Starts the session's process in its holder: here, or on its host. A host belay cannot keep a holder on
   * (it asks for a password, say) gets plain ssh from here instead, which ends with the connection; a host
   * that cannot be reached at all is an error, shown in the session.
   */
  async start(id) {
    const s = this.find(id);
    const r = this.rtOf(s);
    if (r.run || r.starting) throw new HttpError(409, 'session is already running');
    r.starting = true;
    clearTimeout(r.restartTimer);
    r.restartTimer = null;
    try {
      this.restoreScrollback(s, r);
      const t = this.template(s.templateId);
      const plan = launch(...asRun(t, this.runVars(s)), this.builtins(s));
      s.status = 'starting';
      s.desired = 'running';
      if (plan.host) { s.link = 'connecting'; s.linkNote = `Connecting to ${plan.host}`; }
      this.emit('session', this.publicOf(s));
      const env = { TERM: 'xterm-256color', COLORTERM: 'truecolor', BELAY_SESSION: s.id, BELAY_SESSION_NAME: s.name, BELAY_URL: this.baseUrl };
      let host = this.hostFor('');
      let script = plan.script;
      let shown = plan;
      let plain = null;
      let cwd = this.localCwd(s);
      if (plan.host) {
        const h = this.hostFor(plan.host);
        try {
          await h.ready();
          host = h;
          cwd = '';
          // The hooks of an agent there report through the tunnel the connection carries.
          env.BELAY_URL = `http://127.0.0.1:${this.port}`;
        } catch (e) {
          this.dropIdleHost(plan.host);
          if (!(e instanceof CannotHold)) throw e;
          plain = e.message;
          script = [plan.ssh.provision, plan.ssh.command].filter(Boolean).join('\n');
          shown = { ...plan.ssh, host: '' };
        }
      }
      const hid = this.hid(s);
      await host.request('forget', { id: hid }).catch(() => {});
      const res = await host.request('spawn', { id: hid, script: host.scriptFor(script), cwd, env, cols: r.term.cols, rows: r.term.rows });
      // Deleted while it was starting: what was started goes too.
      if (r.removing) { host.request('forget', { id: hid }).catch(() => {}); return; }
      const run = { host, hid, pid: res.pid, plain: !!plain, carry: Buffer.alloc(0) };
      r.run = run;
      r.hadProcess = true;
      r.fed = 0;
      s.hold = { host: host === this.hostFor('') ? '' : plan.host, pid: res.pid, plain: !!plain };
      s.pid = res.pid;
      s.status = 'running';
      s.desired = 'running';
      s.exitCode = null;
      s.startedAt = nowIso();
      s.exitedAt = null;
      s.activity = this.restoredActivity(s);
      s.link = plain ? 'plain' : null;
      s.linkNote = plain ? `Not held on ${plan.host}, so it ends if the connection drops: ${plain}` : null;
      for (const line of describeLaunch(shown).split('\n')) this.write(s, r, `\x1b[2m${line.startsWith('#') ? '' : '$ '}${line}\x1b[0m\r\n`);
      this.follow(s, r, run, 0);
      this.startProbe(s, r);
      this.startSaver(s, r);
      this.store.save();
      this.emit('session', this.publicOf(s));
      log(`started ${s.id} "${s.name}" pid=${res.pid}${plan.host ? ` on ${plan.host}${plain ? ' (plain ssh)' : ''}` : ` cwd=${cwd}`} :: ${plan.command}`);
    } catch (e) {
      if (r.removing) return;
      log(`could not start ${s.id} "${s.name}": ${e.message}`);
      this.write(s, r, divider(`failed to start: ${e.message}`));
      s.link = null;
      s.linkNote = null;
      s.status = 'exited';
      s.exitCode = -1;
      s.exitedAt = nowIso();
      s.pid = null;
      this.store.save();
      this.emit('session', this.publicOf(s));
      throw e instanceof HttpError ? e : new HttpError(502, `failed to start: ${e.message}`);
    } finally {
      r.starting = false;
    }
  }

  /** Follows a run's output from `from`, through any number of reconnects. */
  follow(s, r, run, from) {
    run.host.follow(run.hid, from, {
      output: (buf, next) => {
        if (r.run !== run) return;
        // Text goes on whole characters; a cut-off one waits for the rest. `fed` is how far the text went.
        const b = run.carry.length ? Buffer.concat([run.carry, buf]) : buf;
        const cut = utf8Cut(b);
        run.carry = Buffer.from(b.subarray(cut));
        r.fed = next - run.carry.length;
        if (!cut) return;
        const text = b.toString('utf8', 0, cut);
        r.term.write(text);
        r.dirty = true;
        this.broadcast(r, { t: 'data', sid: s.id, data: text });
        this.flowControl(r);
        this.noteOutput(s, r);
      },
      gap: (had, at) => { if (r.run === run) this.write(s, r, divider(`${at - had} bytes of output were lost while belay was away`)); },
      attached: (info) => {
        if (r.run !== run) return;
        if (s.link === 'reconnecting') { s.link = null; s.linkNote = null; this.emit('session', this.publicOf(s)); }
        // The holder's size follows the session's, which may have changed while it was away.
        if (info.cols !== r.term.cols || info.rows !== r.term.rows) run.host.request('resize', { id: run.hid, cols: r.term.cols, rows: r.term.rows }).catch(() => {});
      },
      lost: (err) => this.onLost(s, r, run, err),
      exit: (ev) => this.onExit(s, r, run, ev.code, ev.signal),
    });
  }

  /**
   * Belay was away and comes back: a session that was running carries on from where its saved scrollback
   * ends, in its holder, here or on its host, reconnecting until that host can be reached.
   */
  resume(s) {
    const r = this.rtOf(s);
    const at = this.restoreScrollback(s, r);
    const host = this.hostFor(s.hold.host || '');
    const run = { host, hid: this.hid(s), pid: s.hold.pid, plain: !!s.hold.plain, carry: Buffer.alloc(0) };
    r.run = run;
    r.fed = at;
    s.status = 'running';
    s.pid = s.hold.pid;
    if (!run.plain && host.state !== 'up') { s.link = 'reconnecting'; s.linkNote = `${host.key || 'this machine'}: connecting`; }
    this.follow(s, r, run, at);
    this.startProbe(s, r);
    this.startSaver(s, r);
  }

  /** The holder does not have the session: it ended with the machine, or the holder did. It is started again if it should be running. */
  onLost(s, r, run, err) {
    if (r.run !== run) return;
    r.run = null;
    s.pid = null;
    s.link = null;
    s.linkNote = null;
    this.stopProbe(r);
    log(`lost ${s.id} "${s.name}": ${err.message}`);
    this.write(s, r, divider(`the session ended while belay was away${run.host.key ? ` (${run.host.key})` : ''}`));
    s.status = 'exited';
    s.exitCode = null;
    s.exitedAt = nowIso();
    for (const w of r.exitWaiters.splice(0)) w();
    this.store.save();
    this.emit('session', this.publicOf(s));
    if (s.desired === 'running' && !r.removing) this.start(s.id).catch((e) => log(`could not start ${s.id} again: ${e.message}`));
  }

  onExit(s, r, run, code, signal) {
    if (r.run !== run) return;
    r.run = null;
    r.paused = false;
    s.pid = null;
    s.status = 'exited';
    s.exitCode = code;
    s.exitedAt = nowIso();
    s.activity = null;
    s.link = null;
    s.linkNote = null;
    this.stopProbe(r);
    // The holder has said all it will: it can let the session go.
    run.host.request('forget', { id: run.hid }).catch(() => {});
    if (run.host.key && !r.removing) this.dropIdleHost(run.host.key);
    this.write(s, r, divider(`exited with code ${code}${signal ? `, signal ${signal}` : ''}`));
    // Whoever waits for the exit (stop, remove) goes on once the scrollback is saved; a session being removed has none to keep.
    const waiters = r.exitWaiters.splice(0);
    (r.removing ? Promise.resolve() : this.saveScrollback(s, r)).then(() => waiters.forEach((w) => w()));
    this.broadcast(r, { t: 'exit', sid: s.id, code });
    log(`exited ${s.id} "${s.name}" code=${code}`);
    if (r.removing) return;
    if (r.restartPending) {
      r.restartPending = false;
      this.start(s.id).catch((e) => log(`restart failed for ${s.id}: ${e.message}`));
      return;
    }
    this.store.save();
    this.emit('session', this.publicOf(s));
    if (s.desired !== 'running') return;
    let policy = 'hold';
    try { policy = s.exitPolicy || this.template(s.templateId).exitPolicy || 'hold'; } catch {}
    if (policy === 'restart') {
      const ranMs = Date.now() - Date.parse(s.startedAt);
      r.backoff = ranMs > 60_000 ? 1000 : Math.min(Math.max(r.backoff * 2, 1000), 30_000);
      this.write(s, r, divider(`restarting in ${r.backoff / 1000}s`));
      r.restartTimer = setTimeout(() => {
        r.restartTimer = null;
        if (r.run || s.desired !== 'running' || r.removing) return;
        this.start(s.id).catch((e) => log(`auto-restart failed for ${s.id}: ${e.message}`));
      }, r.backoff);
    } else if (policy === 'close') {
      this.remove(s.id).catch((e) => log(`close policy failed for ${s.id}: ${e.message}`));
    }
  }

  async stop(id) {
    const s = this.find(id);
    s.desired = 'stopped';
    const r = this.rt.get(id);
    if (r) {
      clearTimeout(r.restartTimer);
      r.restartTimer = null;
      if (r.run) await this.killAndWait(r);
    }
    s.status = 'stopped';
    this.store.save();
    this.emit('session', this.publicOf(s));
    return this.publicOf(s);
  }

  async restart(id) {
    const s = this.find(id);
    const r = this.rtOf(s);
    s.desired = 'running';
    if (r.run) {
      r.restartPending = true;
      await this.killAndWait(r);
    } else {
      await this.start(id);
    }
    return this.publicOf(s);
  }

  /**
   * Hangs up on the session's process, then kills it if it lingers. With its host out of reach it is let go
   * here, and its holder lets it go when belay next reaches it.
   */
  killAndWait(r) {
    const run = r.run;
    if (!run) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const timers = [];
      const finish = () => { if (done) return; done = true; timers.forEach(clearTimeout); resolve(); };
      r.exitWaiters.push(finish);
      const kill = (signal) => run.host.request('kill', { id: run.hid, signal }).catch(() => {});
      if (run.host.state !== 'up') {
        // Unreachable: nothing to wait for.
        run.host.detach(run.hid);
        const s = this.state.sessions.find((x) => this.rt.get(x.id) === r);
        if (s) this.onExit(s, r, run, null, null);
        return;
      }
      kill('HUP');
      timers.push(setTimeout(() => { kill('KILL'); timers.push(setTimeout(finish, 1000)); }, 3000));
    });
  }

  input(id, data) {
    const r = this.rt.get(id);
    if (r?.run) r.run.host.input(r.run.hid, data);
  }

  resize(id, cols, rows) {
    const s = this.find(id);
    const r = this.rtOf(s);
    cols = clamp(cols, 2, 500);
    rows = clamp(rows, 1, 300);
    if (r.term.cols !== cols || r.term.rows !== rows) r.term.resize(cols, rows);
    if (r.run && r.run.host.state === 'up') r.run.host.request('resize', { id: r.run.hid, cols, rows }).catch(() => {});
    if (s.cols !== cols || s.rows !== rows) { s.cols = cols; s.rows = rows; this.store.save(); }
  }

  /** Attach a websocket client; resolves with an exact replay of the buffer. */
  async attach(id, ws, cols, rows) {
    const s = this.find(id);
    const r = this.rtOf(s);
    this.restoreScrollback(s, r);
    if (cols && rows) this.resize(id, cols, rows);
    r.clients.add(ws);
    // Wait for the headless parser to drain so the serialized buffer is current.
    await new Promise((res) => r.term.write('', res));
    const data = r.ser.serialize();
    this.emit('session', this.publicOf(s));
    return { data, cols: r.term.cols, rows: r.term.rows };
  }

  detach(id, ws) {
    const r = this.rt.get(id);
    if (!r || !r.clients.delete(ws)) return;
    const s = this.state.sessions.find((x) => x.id === id);
    if (s) this.emit('session', this.publicOf(s));
  }

  broadcast(r, msg) {
    if (!r.clients.size) return;
    const str = JSON.stringify(msg);
    for (const c of r.clients) if (c.readyState === 1) c.send(str);
  }

  /** Holds the output back when a slow browser falls far behind (the program waits to write), and lets it go once it catches up. */
  flowControl(r) {
    const run = r.run;
    if (!run || r.paused) return;
    let max = 0;
    for (const c of r.clients) max = Math.max(max, c.bufferedAmount);
    if (max < 4_000_000) return;
    r.paused = true;
    run.host.request('pause', { id: run.hid }).catch(() => {});
    const tick = () => {
      if (r.run !== run) { r.paused = false; return; }
      let m = 0;
      for (const c of r.clients) m = Math.max(m, c.bufferedAmount);
      if (m < 1_000_000) { r.paused = false; run.host.request('resume', { id: run.hid }).catch(() => {}); }
      else setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  }

  write(s, r, text) {
    r.term.write(text);
    r.dirty = true;
    this.broadcast(r, { t: 'data', sid: s.id, data: text });
  }

  /** Throttled "there was output" timestamp so hidden tabs can show activity. */
  noteOutput(s, r) {
    const now = Date.now();
    if (r.lastOutputEmit && now - r.lastOutputEmit < 2000) { r.outputPending = true; if (!r.outputTimer) r.outputTimer = setTimeout(() => { r.outputTimer = null; if (r.outputPending) this.noteOutput(s, r); }, 2000); return; }
    r.lastOutputEmit = now;
    r.outputPending = false;
    s.lastOutputAt = new Date(now).toISOString();
    this.emit('session', this.publicOf(s));
  }

  /**
   * What an agent session was doing when it was last launched, from its conversation's last turn: idle since
   * that turn ended, if it finished and this launch resumes the same conversation. Otherwise nothing, until
   * the agent's hooks report.
   */
  restoredActivity(s) {
    const t = s.turn;
    let agent = t?.agent;
    if (!agent) try { agent = this.template(s.templateId).agent; } catch {}
    if (!agent || !t?.endedAt || t.conv !== s.vars?.session || (t.startedAt && t.startedAt > t.endedAt)) return null;
    return { state: 'idle', since: t.endedAt, event: 'restored', agent };
  }

  /**
   * Update the activity state from an agent's hook event. Returns true when it changed.
   *
   * The conversation's last turn is kept with the session (`turn`: when a prompt went in, when the agent
   * finished), across restarts, so the times shown are the conversation's own: idle since its last turn
   * ended, even when a relaunch has just resumed it, and working since the prompt, through any pause for
   * permission. A turn cut off by the agent stopping ends when it stopped.
   */
  applyHookEvent(s, body, agent = 'claude') {
    const ev = String(body.hook_event_name || '');
    let state = ACTIVITY_BY_EVENT[ev];
    if (state === undefined) return false;
    if (ev === 'Notification') {
      const kind = String(body.notification_type || body.message || '').toLowerCase();
      state = /idle/.test(kind) ? 'idle' : 'attention';
    }
    const now = nowIso();
    const conv = String(body.session_id || '').trim() || s.vars?.session || null;
    if (conv && s.turn?.conv !== conv) s.turn = { conv, agent, startedAt: null, endedAt: null };
    const t = s.turn;
    if (t) {
      const inTurn = !!t.startedAt && (!t.endedAt || t.startedAt > t.endedAt);
      if (state === 'busy' && !inTurn) t.startedAt = now;
      if ((ev === 'Stop' || ev === 'SessionStart' || state === 'gone') && inTurn) t.endedAt = now;
      t.agent = agent;
      this.store.save();
    }
    const finished = t?.endedAt && !(t.startedAt > t.endedAt);
    const since = state === 'busy' && t?.startedAt && !finished ? t.startedAt : state === 'idle' && finished ? t.endedAt : now;
    const next = state === 'gone' || state === null ? null : { state, since, event: ev, agent };
    const prev = s.activity;
    if ((prev?.state ?? null) === (next?.state ?? null) && (prev?.since ?? null) === (next?.since ?? null)) return false;
    s.activity = next;
    return true;
  }

  /** Follows a shell here as it changes directory, so a new tab next to it starts where it is. */
  startProbe(s, r) {
    this.stopProbe(r);
    if (!r.run || r.run.host.key) return;
    r.probeTimer = setInterval(async () => {
      const run = r.run;
      if (!run || run.host.state !== 'up') return;
      try {
        const { cwd } = await run.host.request('cwd', { id: run.hid });
        if (cwd && cwd !== s.cwd && !cwd.endsWith(' (deleted)')) {
          s.cwd = cwd;
          this.store.save();
          this.emit('session', this.publicOf(s));
        }
      } catch {}
    }, this.settings.probeCwdMs || 3000);
  }

  stopProbe(r) { clearInterval(r.probeTimer); r.probeTimer = null; }

  startSaver(s, r) {
    if (r.saveTimer) return;
    r.saveTimer = setInterval(() => { if (r.dirty) this.saveScrollback(s, r); }, this.settings.scrollbackSaveMs || 30000);
  }

  clearTimers(r) {
    this.stopProbe(r);
    clearInterval(r.saveTimer); r.saveTimer = null;
    clearTimeout(r.restartTimer); r.restartTimer = null;
    clearTimeout(r.outputTimer); r.outputTimer = null;
  }

  /**
   * Saves the scrollback, and the offset in the output it reaches: everything written to the terminal up to
   * now, and nothing after, so belay started again follows on from exactly there.
   */
  saveScrollback(s, r) {
    r.dirty = false;
    const at = r.fed;
    if (r.disposed) return Promise.resolve();
    return new Promise((resolve) => r.term.write('', () => {
      if (r.disposed) { resolve(); return; }
      try {
        atomicWriteSync(this.scrollFile(s.id), r.ser.serialize());
        atomicWriteSync(this.atFile(s.id), JSON.stringify({ at }));
      } catch (e) {
        log(`could not save scrollback for ${s.id}: ${e.message}`);
      }
      resolve();
    }));
  }

  scrollFile(id) { return path.join(this.scrollDir, `${id}.ansi`); }
  atFile(id) { return path.join(this.scrollDir, `${id}.at.json`); }

  async scrollbackOf(id) {
    this.find(id);
    const r = this.rt.get(id);
    if (r) {
      await new Promise((res) => r.term.write('', res));
      return r.ser.serialize();
    }
    try { return fs.readFileSync(this.scrollFile(id), 'utf8'); } catch { return ''; }
  }

  async checkDir(p) {
    p = expandHome(String(p ?? '').trim()) || os.homedir();
    if (!path.isAbsolute(p)) throw new HttpError(400, 'directory must be an absolute path');
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(400, `not a directory: ${p}`);
    return path.resolve(p);
  }

  applySettings() {
    for (const r of this.rt.values()) r.term.options.scrollback = this.settings.serverScrollback;
  }

  /**
   * At startup: sessions that were running carry on where they are, held while belay was away; ones meant to
   * be running that are not are started. Returns how many it went on with.
   */
  bootAll() {
    let n = 0;
    for (const s of this.state.sessions) {
      s.pid = null;
      s.link = null;
      s.linkNote = null;
      // Held, it carried on: so did its agent, working or not, as last reported.
      if (s.status === 'running' && s.hold) { this.resume(s); n++; continue; }
      s.activity = null;
      if (s.status === 'running' || s.status === 'starting') s.status = 'stopped';
      if (s.desired !== 'running' || s.status === 'exited') continue;
      this.start(s.id).catch((e) => log(`boot: could not start ${s.id} "${s.name}": ${e.message}`));
      n++;
    }
    this.store.saveSync();
    return n;
  }

  /** Before belay exits: scrollback and state saved. The sessions themselves carry on in their holders. */
  async shutdown() {
    const saves = [];
    for (const [id, r] of this.rt) {
      const s = this.state.sessions.find((x) => x.id === id);
      this.clearTimers(r);
      if (s && r.hadProcess) saves.push(this.saveScrollback(s, r));
    }
    await Promise.all(saves);
    this.store.saveSync();
    for (const h of this.hosts.values()) h.stop();
  }
}
