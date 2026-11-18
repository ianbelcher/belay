import net from 'node:net';
import { spawn } from 'node:child_process';
import { HttpError, log } from './util.js';
import { sshArgs } from './ssh.js';
import { targetOf } from '../shared/ssh.js';

// Connections for remote pages, made from the machine a project works on. For this machine, a plain TCP
// connection. For a project's host, one `ssh -D` per host: a SOCKS proxy whose far end resolves the name and
// connects there, so `localhost` and cluster names mean what they mean on that host.

const IDLE_MS = 10 * 60 * 1000;
const READY_MS = 20000;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function connectTcp(host, port, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(timeout, () => fail(Object.assign(new Error(`timed out connecting to ${host}:${port}`), { code: 'ETIMEDOUT' })));
    sock.once('error', fail);
    sock.once('connect', () => { sock.setTimeout(0); sock.removeListener('error', fail); resolve(sock); });
  });
}

const SOCKS_ERRORS = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'timed out', 7: 'command not supported', 8: 'address type not supported' };

/** A connection to host:port through the SOCKS5 proxy on 127.0.0.1:proxyPort, the name resolved by the proxy. */
export async function socks5(proxyPort, host, port) {
  const sock = await connectTcp('127.0.0.1', proxyPort);
  let buf = Buffer.alloc(0);
  let want = null;
  const read = (n) => new Promise((resolve, reject) => { want = { n, resolve, reject }; pump(); });
  const pump = () => {
    if (!want || buf.length < want.n) return;
    const w = want; want = null;
    const out = buf.subarray(0, w.n); buf = buf.subarray(w.n);
    w.resolve(out);
  };
  const onData = (d) => { buf = Buffer.concat([buf, d]); pump(); };
  const onEnd = () => want?.reject(Object.assign(new Error('the tunnel closed the connection'), { code: 'ECONNRESET' }));
  sock.on('data', onData);
  sock.on('close', onEnd);
  sock.on('error', onEnd);
  try {
    sock.write(Buffer.from([5, 1, 0]));
    const hello = await read(2);
    if (hello[0] !== 5 || hello[1] !== 0) throw new Error('the tunnel refused the SOCKS greeting');
    const name = Buffer.from(host);
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
    const head = await read(4);
    if (head[1] !== 0) throw Object.assign(new Error(SOCKS_ERRORS[head[1]] || `SOCKS error ${head[1]}`), { code: head[1] === 5 ? 'ECONNREFUSED' : 'ESOCKS' });
    const alen = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await read(1))[0];
    await read(alen + 2);
  } catch (e) { sock.destroy(); throw e; }
  sock.removeListener('data', onData);
  sock.removeListener('close', onEnd);
  sock.removeListener('error', onEnd);
  if (buf.length) sock.unshift(buf);
  return sock;
}

/** One `ssh -N -D` to a host, started when first needed and stopped after it has been idle a while. */
class SshSocks {
  constructor(target) {
    this.target = target;
    this.proc = null;
    this.port = 0;
    this.starting = null;
    this.open = 0;
    this.usedAt = Date.now();
  }

  ready() {
    if (this.proc && this.proc.exitCode === null && !this.starting) return Promise.resolve(this.port);
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    this.port = await freePort();
    let stderr = '';
    // Up once the SOCKS port answers (below): a forward of your config's that cannot bind does not matter.
    const proc = spawn('ssh', sshArgs(this.target, { share: 'off', extra: ['-N', '-D', `127.0.0.1:${this.port}`,
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10'] }), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    proc.on('exit', (code) => { if (this.proc === proc) this.proc = null; if (code) log(`tunnel to ${this.target} exited (${code}): ${stderr.trim().split('\n').pop() || ''}`); });
    proc.on('error', () => {});
    // ssh opens the forward only once it has logged in, so a port that answers means the tunnel is up.
    const until = Date.now() + READY_MS;
    while (Date.now() < until) {
      if (proc.exitCode !== null || proc.signalCode) throw new HttpError(502, `ssh to ${this.target} failed: ${stderr.trim().split('\n').pop() || `exit ${proc.exitCode}`}`);
      const ok = await connectTcp('127.0.0.1', this.port, 500).then((s) => { s.destroy(); return true; }, () => false);
      if (ok) { log(`tunnel to ${this.target} on 127.0.0.1:${this.port}`); return this.port; }
      await new Promise((r) => setTimeout(r, 150));
    }
    proc.kill();
    throw new HttpError(504, `ssh to ${this.target} did not come up within ${READY_MS / 1000}s`);
  }

  async connect(host, port) {
    this.usedAt = Date.now();
    const sock = await socks5(await this.ready(), host, port);
    this.open++;
    sock.once('close', () => { this.open--; this.usedAt = Date.now(); });
    return sock;
  }

  idle(now) { return this.open <= 0 && now - this.usedAt > IDLE_MS; }
  stop() { this.proc?.kill(); this.proc = null; }
}

export class Tunnels {
  constructor() {
    this.ssh = new Map();
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [k, t] of this.ssh) if (t.idle(now)) { t.stop(); this.ssh.delete(k); }
    }, 60000);
    this.timer.unref();
  }

  /** A TCP connection to host:port as seen from `via` ({ host, user }; no host means this machine). */
  connect(via, host, port) {
    if (!via?.host) return connectTcp(host, port);
    const target = targetOf(via.host, via.user);
    let t = this.ssh.get(target);
    if (!t) { t = new SshSocks(target); this.ssh.set(target, t); }
    return t.connect(host, port);
  }

  close() { clearInterval(this.timer); for (const t of this.ssh.values()) t.stop(); this.ssh.clear(); }
}
