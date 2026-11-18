// belay's side of the holders: belay-hold owns the terminals, here and on each host, and belay comes and goes.
// A Host is one machine's holder: the local one over its socket, a remote one over `ssh host belay-hold
// connect`. It keeps itself connected, and after a drop it attaches every session again from the last byte
// it had, so nothing is missed and nothing comes twice.
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './util.js';
import { sshArgs } from './ssh.js';

const T = { HELLO: 1, REQ: 2, RES: 3, OUTPUT: 4, INPUT: 5, EVENT: 6 };
export const PROTO = 1;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Where the holder binaries are: hold/dist in a checkout; the app says where it packed them. */
export const HOLD_DIST = process.env.BELAY_HOLD_DIST || path.join(ROOT, 'hold', 'dist');

function frame(type, payload) {
  const b = Buffer.allocUnsafe(5 + payload.length);
  b.writeUInt32BE(1 + payload.length, 0);
  b[4] = type;
  payload.copy(b, 5);
  return b;
}

/** One connection to a holder, over any pair of streams. */
export class HoldConn extends EventEmitter {
  constructor(input, output) {
    super();
    this.out = output;
    this.rid = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.closed = false;
    input.on('data', (d) => this.onData(d));
    const end = (err) => this.close(err);
    input.on('end', () => end());
    input.on('close', () => end());
    input.on('error', end);
    output.on('error', end);
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + n) break;
      const type = this.buf[4];
      const p = this.buf.subarray(5, 4 + n);
      this.buf = this.buf.subarray(4 + n);
      if (type === T.OUTPUT) {
        const idLen = p[0];
        const id = p.toString('utf8', 1, 1 + idLen);
        const offset = Number(p.readBigUInt64BE(1 + idLen));
        this.emit('output', id, offset, Buffer.from(p.subarray(1 + idLen + 8)));
      } else if (type === T.RES) {
        const res = JSON.parse(p.toString('utf8'));
        const w = this.pending.get(res.rid);
        if (!w) continue;
        this.pending.delete(res.rid);
        if (res.ok) w.resolve(res); else w.reject(new Error(res.error || 'holder error'));
      } else if (type === T.EVENT) {
        this.emit('event', JSON.parse(p.toString('utf8')));
      } else if (type === T.HELLO) {
        this.hello = JSON.parse(p.toString('utf8'));
        this.emit('hello', this.hello);
      }
    }
  }

  request(op, args = {}) {
    if (this.closed) return Promise.reject(new Error('not connected'));
    const rid = ++this.rid;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.out.write(frame(T.REQ, Buffer.from(JSON.stringify({ ...args, op, rid }))));
    });
  }

  input(id, data) {
    if (this.closed) return;
    const idb = Buffer.from(id);
    const db = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    this.out.write(frame(T.INPUT, Buffer.concat([Buffer.from([idb.length]), idb, db])));
  }

  close(err) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.pending.values()) w.reject(new Error('the connection to the holder closed'));
    this.pending.clear();
    this.emit('close', err);
  }
}

/** The name `uname -sm` gives a system, as the holder's builds are named. */
export function targetOf(uname) {
  const [sys, machine] = String(uname).trim().split(/\s+/);
  const os_ = { Linux: 'linux', Darwin: 'darwin' }[sys];
  const arch = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64', armv6l: 'arm', armv7l: 'arm', armv8l: 'arm' }[machine];
  return os_ && arch ? `${os_}-${arch}` : null;
}

export const localTarget = () => targetOf(`${{ linux: 'Linux', darwin: 'Darwin' }[process.platform] || process.platform} ${{ x64: 'x86_64', arm64: 'arm64', arm: 'armv7l' }[process.arch] || process.arch}`);

const hashes = new Map();
/** A holder build's file, and the name it goes by on a host: its content's hash, so a new build is a new file. */
export function holdBinary(target) {
  const file = path.join(HOLD_DIST, `belay-hold-${target}`);
  if (!hashes.has(file)) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
    hashes.set(file, h);
  }
  return { file, name: `belay-hold-${hashes.get(file)}` };
}

// Keepalives notice a dead connection in under a minute. BatchMode (in sshArgs): a host that would ask for a
// password is one belay cannot hold sessions on; it falls back to plain ssh, which can ask.
const KEEPALIVE = ['-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

/** Something that cannot be held on a host however often it is tried: belay runs plain ssh there instead. */
export class CannotHold extends Error {}

function sshRun(target, script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', [...sshArgs(target, { forwards: false, extra: KEEPALIVE }), script], { encoding: 'buffer', maxBuffer: 1 << 20, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) { const e = new Error(String(stderr || '').trim().split('\n').pop() || err.message); e.code = err.code; reject(e); return; }
      resolve(stdout.toString());
    });
    child.stdin.end(input ?? '');
  });
}

/**
 * Puts the holder on a host, unless the build it needs is there already: one `uname`, and the binary sent
 * over ssh to ~/.belay/bin. Needs nothing on the host but a shell and a writable home.
 */
export async function installHolder(target) {
  let probe;
  try {
    probe = await sshRun(target, 'uname -sm; ls ~/.belay/bin 2>/dev/null; true', '');
  } catch (e) {
    // 255 is ssh itself: a host it cannot log in to without asking stays plain ssh, which can ask.
    if (/Permission denied|publickey|password|keyboard-interactive|Host key verification failed/i.test(e.message)) throw new CannotHold(`ssh needs a password or a host key confirmation for ${target}: ${e.message}`);
    throw e;
  }
  const [uname, ...have] = probe.split('\n');
  const t = targetOf(uname);
  if (!t) throw new CannotHold(`no holder for ${uname.trim()} yet`);
  let bin;
  try { bin = holdBinary(t); } catch { throw new CannotHold(`no holder build for ${t} in this copy of belay`); }
  if (!have.map((x) => x.trim()).includes(bin.name)) {
    const part = `~/.belay/bin/.part-${bin.name}`;
    try {
      await sshRun(target, `mkdir -p ~/.belay/bin && chmod 700 ~/.belay && cat > ${part} && chmod 700 ${part} && mv -f ${part} ~/.belay/bin/${bin.name}`, fs.readFileSync(bin.file));
    } catch (e) { throw new CannotHold(`could not put the holder on ${target}: ${e.message}`); }
    log(`holder ${bin.name} (${t}) installed on ${target}`);
  }
  return bin.name;
}

/**
 * One machine's holder, kept connected. `open` makes a new connection: it resolves with { input, output,
 * close() } or throws (a CannotHold when it never will work). Sessions attached through it are attached again
 * after every reconnect, from where they are.
 */
export class Host extends EventEmitter {
  constructor(key, open) {
    super();
    this.key = key;
    this.open = open;
    this.conn = null;
    this.state = 'down';
    this.error = null;
    this.attached = new Map(); // id → { from: next offset, handlers }
    this.backoff = 0;
    this.waiters = [];
    this.stopped = false;
    this.connect();
  }

  setState(state, error = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit('state', state, error);
  }

  async connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.setState('connecting', this.error);
    let link;
    try {
      link = await this.open();
    } catch (e) {
      this.connecting = false;
      if (e instanceof CannotHold) { this.cannot = e; this.setState('cannot', e.message); this.flush(e); return; }
      this.retry(e.message);
      return;
    }
    this.connecting = false;
    const conn = new HoldConn(link.input, link.output);
    const hello = await new Promise((resolve) => { conn.once('hello', resolve); conn.once('close', () => resolve(null)); });
    if (!hello) { link.close?.(); this.retry(link.why?.() || 'the holder closed the connection'); return; }
    if (hello.proto !== PROTO) { link.close?.(); this.cannot = new CannotHold(`the holder there speaks protocol ${hello.proto}, this belay ${PROTO}`); this.setState('cannot', this.cannot.message); this.flush(this.cannot); return; }
    this.conn = conn;
    this.link = link;
    this.hello = hello;
    this.backoff = 0;
    conn.on('output', (id, offset, data) => {
      const a = this.attached.get(id);
      if (!a) return;
      // A byte already had is never handed on twice; a gap (output gone from the holder's buffer) is said.
      if (offset + data.length <= a.from) return;
      if (offset > a.from) a.handlers.gap?.(a.from, offset);
      const fresh = offset < a.from ? data.subarray(a.from - offset) : data;
      a.from = offset + data.length;
      a.handlers.output(fresh, a.from);
    });
    conn.on('event', (ev) => {
      if (ev.ev !== 'exit') return;
      const a = this.attached.get(ev.id);
      if (!a) return;
      this.attached.delete(ev.id);
      a.handlers.exit(ev);
    });
    conn.on('close', () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.link = null;
      this.retry('the connection dropped');
    });
    this.everUp = true;
    this.setState('up');
    for (const [id, a] of this.attached) this.reattach(id, a);
    this.flush(null);
  }

  retry(why) {
    if (this.stopped) return;
    this.setState('down', why);
    // Never reached: whoever is waiting to start something hears now, not after the timeout.
    if (!this.everUp) this.flush(new Error(`could not reach ${this.key || 'the holder on this machine'}: ${why}`));
    this.backoff = Math.min(Math.max(this.backoff * 2, 1000), 30000);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.backoff);
  }

  /** Connect now rather than at the next try (the network came back, say). */
  poke() { if (this.state === 'down') { clearTimeout(this.timer); this.backoff = 0; this.connect(); } }

  flush(err) { for (const w of this.waiters.splice(0)) (err ? w.reject(err) : w.resolve()); }

  /** Waits until connected; throws if it never can be, or if `ms` pass first. */
  ready(ms = 20000) {
    if (this.state === 'up') return Promise.resolve();
    if (this.state === 'cannot') return Promise.reject(this.cannot);
    return new Promise((resolve, reject) => {
      const w = { resolve: () => { clearTimeout(t); resolve(); }, reject: (e) => { clearTimeout(t); reject(e); } };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`could not reach the holder on ${this.key || 'this machine'}: ${this.error || 'timed out'}`)); }, ms);
      this.waiters.push(w);
    });
  }

  async request(op, args) {
    await this.ready();
    return this.conn.request(op, args);
  }

  /** Attaches a followed session on this connection; a holder that no longer has it says so through `lost`. */
  async reattach(id, a) {
    const conn = this.conn;
    try {
      const res = await conn.request('attach', { id, from: a.from });
      if (this.attached.get(id) === a) a.handlers.attached?.(res);
    } catch (e) {
      if (this.conn !== conn || this.attached.get(id) !== a) return;
      this.attached.delete(id);
      a.handlers.lost?.(e);
    }
  }

  /**
   * Follows session `id` from offset `from`, now and after every reconnect: `output(bytes, next)`,
   * `exit(ev)`, `gap(had, at)` when output between was lost, `attached(info)` on every (re)attach, `lost(err)`
   * when the holder does not have it. Works while the host is unreachable too: it attaches once it is back.
   */
  follow(id, from, handlers) {
    const a = { from, handlers };
    this.attached.set(id, a);
    if (this.state === 'up') this.reattach(id, a);
  }

  detach(id) {
    if (!this.attached.delete(id)) return;
    this.conn?.request('detach', { id }).catch(() => {});
  }

  input(id, data) { this.conn?.input(id, data); }

  /**
   * A session's script as this holder should get it. A holder from before `interactive` starts it in a login
   * shell that is not interactive, which reads no .bashrc or .zshrc: then the script goes through one that is…
   */
  scriptFor(script) {
    if (this.hello?.features?.includes('interactive')) return script;
    // …and with a UTF-8 locale when there is none, as a newer holder gives it.
    const locale = '[ -n "$LC_ALL$LC_CTYPE$LANG" ] || { [ "$(uname)" = Darwin ] && export LANG=en_US.UTF-8 || export LANG=C.UTF-8; }';
    return `${locale}; exec "$SHELL" -l -i -c '${String(script).replace(/'/g, `'\\''`)}'`;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.link?.close?.();
    this.conn?.close();
  }
}

/** The holder on this machine: started if it is not running, then its socket. */
export function localHost({ dir }) {
  const t = localTarget();
  return new Host('', async () => {
    let bin;
    try { bin = holdBinary(t); } catch { throw new CannotHold(`no holder build for ${t}: run npm run build:hold`); }
    const sock = await new Promise((resolve, reject) => {
      execFile(bin.file, ['ensure'], { env: { ...process.env, BELAY_HOLD_DIR: dir }, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim())); else resolve(stdout.trim());
      });
    });
    const sockConn = net.connect(sock);
    await new Promise((resolve, reject) => { sockConn.once('connect', resolve); sockConn.once('error', reject); });
    return { input: sockConn, output: sockConn, close: () => sockConn.destroy() };
  });
}

/**
 * The holder on a host, over ssh: put there first if need be, then `belay-hold connect`. The connection also
 * carries the tunnel back to belay (`tunnelPort`) that an agent's hooks report through.
 */
export function remoteHost(target, { tunnelPort } = {}) {
  let name = null;
  return new Host(target, async () => {
    if (!name) name = await installHolder(target);
    const tunnel = tunnelPort ? ['-R', `${tunnelPort}:127.0.0.1:${tunnelPort}`] : [];
    const child = spawn('ssh', [...sshArgs(target, { share: 'use', extra: [...KEEPALIVE, ...tunnel] }), `exec ~/.belay/bin/${name} connect`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    // The binary went missing (a cleaned home): put it back on the next try.
    child.once('exit', (code) => { if (code === 127) name = null; });
    return {
      input: child.stdout,
      output: child.stdin,
      close: () => child.kill(),
      why: () => err.trim().split('\n').filter((l) => !/remote port forwarding failed/i.test(l)).pop() || '',
    };
  });
}
