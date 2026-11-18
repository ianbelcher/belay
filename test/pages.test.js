// Remote pages: belay with a token in front of a small app, driven over HTTP and WebSocket the way a browser
// would, with the page's Host. The ssh path runs against a private sshd when this machine has one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { stopHolder } from './holder.js';
import WebSocket, { WebSocketServer } from 'ws';
import { parseAddress } from '../server/pages.js';
import { socks5 } from '../server/tunnels.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pages-'));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => r(p)); }); });
// Test files run in parallel, so every port comes from the OS.
const [port, upPort, sshPort, port2] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
const TOKEN = 'pages-test-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server, upstream;
const seen = [];

/** A request to belay with a chosen Host, as a browser sends it to page-<id>.localhost. */
function req(method, host, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const belayApi = async (method, p, body, headers = {}) => {
  const r = await req(method, `127.0.0.1:${port}`, p, { headers: { cookie: `belay=${TOKEN}`, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { ...r, json: (() => { try { return JSON.parse(r.text); } catch { return null; } })() };
};

before(async () => {
  upstream = http.createServer((q, r) => {
    if (q.url === '/redir') { r.writeHead(302, { location: `http://localhost:${upPort}/landed?x=1` }); r.end(); return; }
    if (q.url === '/gz') {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'strict-transport-security': 'max-age=1' });
      r.end(zlib.gzipSync('<!doctype html><html><head><title>gz</title></head><body>zipped</body></html>'));
      return;
    }
    let body = '';
    q.on('data', (d) => { body += d; });
    q.on('end', () => {
      seen.push({ url: q.url, method: q.method, headers: q.headers, body });
      r.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['app=1; Domain=localhost; Path=/', 'other=2; Path=/'] });
      r.end(JSON.stringify({ ok: true }));
    });
  });
  new WebSocketServer({ server: upstream }).on('connection', (ws, q) => {
    ws.send(`hello origin=${q.headers.origin} host=${q.headers.host}`);
    ws.on('message', (m) => ws.send(`echo ${m}`));
  });
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));
  server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, BELAY_TOKEN: TOKEN, BELAY_PORT: String(port), BELAY_DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 100; i++) { try { if ((await belayApi('GET', '/api/health')).status === 200) break; } catch {} await sleep(50); }
});
after(async () => {
  if (server) await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
  upstream?.close();
  await stopHolder(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('addresses: a port, a host and port, a full URL', () => {
  assert.deepEqual(parseAddress('8080'), { origin: 'http://localhost:8080', path: '/' });
  assert.deepEqual(parseAddress('grafana.monitoring.svc.cluster.local:3000/d/x?y=1'), { origin: 'http://grafana.monitoring.svc.cluster.local:3000', path: '/d/x?y=1' });
  assert.deepEqual(parseAddress('https://box:8443'), { origin: 'https://box:8443', path: '/' });
  assert.throws(() => parseAddress('file:///etc/passwd'), /only http and https/);
  assert.throws(() => parseAddress(''), /required/);
});

let page;
test('a page is registered under its own subdomain, with a sign-in link', async () => {
  const r = await belayApi('POST', '/api/pages', { address: `localhost:${upPort}/start?q=1` });
  assert.equal(r.status, 200, r.text);
  page = r.json;
  assert.match(page.origin, new RegExp(`^http://page-[0-9a-f]{10}\\.localhost:${port}$`));
  assert.equal(page.target, `http://localhost:${upPort}`);
  assert.match(page.url, /\/__belay\/login\?t=\d+\.[\w-]+&to=%2Fstart%3Fq%3D1$/);
  const again = await belayApi('POST', '/api/pages', { address: `http://localhost:${upPort}/other` });
  assert.equal(again.json.id, page.id, 'the same address and machine is the same page');
  const elsewhere = await belayApi('POST', '/api/pages', { address: `localhost:${upPort}`, host: 'box' });
  assert.notEqual(elsewhere.json.id, page.id, 'the same address on another host is another page');
  assert.equal((await belayApi('POST', '/api/pages', { address: 'x', host: 'box; rm -rf /' })).status, 400);
  assert.equal((await req('POST', `127.0.0.1:${port}`, '/api/pages', { body: '{"address":"8080"}' })).status, 401, 'registering needs belay sign-in');
  const byIp = await req('POST', `10.1.2.3:${port}`, '/api/pages', { headers: { cookie: `belay=${TOKEN}` }, body: '{"address":"8080"}' });
  assert.match(byIp.text, /not an IP address/);
});

let cookie;
test('the page needs its own sign-in, given by the link', async () => {
  const host = new URL(page.origin).host;
  assert.equal((await req('GET', host, '/')).status, 401);
  assert.equal((await req('GET', host, '/', { headers: { cookie: `belay=${TOKEN}` } })).status, 401, "belay's own cookie is not the page's");
  assert.equal((await req('GET', host, '/__belay/login?t=1.abc&to=/')).status, 403);
  const other = await belayApi('POST', '/api/pages', { address: 'localhost:1' });
  const wrongPage = new URL(other.json.url);
  assert.equal((await req('GET', host, `${wrongPage.pathname}${wrongPage.search}`)).status, 403, "one page's link does not sign in another");
  const u = new URL(page.url);
  const r = await req('GET', host, `${u.pathname}${u.search}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/start?q=1');
  cookie = r.headers['set-cookie'][0].split(';')[0];
  assert.match(r.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=None; Partitioned/, 'kept for the page in its frame under belay, a different site');
  assert.match(r.headers['set-cookie'][1], /HttpOnly; SameSite=Lax/, 'and for the page opened on its own');
  assert.equal(r.headers['set-cookie'][1].split(';')[0], cookie);
  const evil = await req('GET', host, `${u.pathname}${u.search.replace(/to=[^&]*/, 'to=%2F%2Fevil.example')}`);
  assert.equal(evil.headers.location, '/', 'no open redirect');
  assert.equal((await req('GET', 'page-0000000000.localhost', '/')).status, 404);
});

test('requests reach the app as if made to it, and come back pointing at the page', async () => {
  const host = new URL(page.origin).host;
  seen.length = 0;
  const r = await req('POST', host, '/api/thing?a=1', { headers: { cookie: `${cookie}; mine=yes`, origin: page.origin, referer: `${page.origin}/start`, 'content-type': 'text/plain' }, body: 'payload' });
  assert.equal(r.status, 200);
  const s = seen[0];
  assert.equal(s.url, '/api/thing?a=1');
  assert.equal(s.method, 'POST');
  assert.equal(s.body, 'payload');
  assert.equal(s.headers.host, `localhost:${upPort}`);
  assert.equal(s.headers.origin, `http://localhost:${upPort}`);
  assert.equal(s.headers.referer, `http://localhost:${upPort}/start`);
  assert.equal(s.headers.cookie, 'mine=yes', "the page's sign-in cookie stays with belay");
  assert.deepEqual(r.headers['set-cookie'], ['app=1; Path=/', 'other=2; Path=/']);
  const redir = await req('GET', host, '/redir', { headers: { cookie } });
  assert.equal(redir.headers.location, `${page.origin}/landed?x=1`);
  const gz = await req('GET', host, '/gz', { headers: { cookie, 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], undefined);
  assert.equal(gz.text, '<!doctype html><html><head><script src="/__belay/keys.js"></script><title>gz</title></head><body>zipped</body></html>');
  assert.equal(gz.headers['x-frame-options'], undefined);
  assert.equal(gz.headers['strict-transport-security'], undefined);
  assert.equal(gz.headers['content-security-policy'], "default-src 'self'");
  const keys = await req('GET', host, '/__belay/keys.js', { headers: { cookie } });
  assert.match(keys.text, /postMessage\(\{ belay: 'key'/);
  new Function(keys.text); // eslint-disable-line no-new-func -- parses
});

test('WebSockets pass through, with the Origin the app expects', async () => {
  const host = new URL(page.origin).host;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { host, cookie, origin: page.origin } });
  const got = [];
  ws.on('message', (m) => got.push(String(m)));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send('ping');
  for (let i = 0; i < 50 && got.length < 2; i++) await sleep(20);
  assert.deepEqual(got, [`hello origin=http://localhost:${upPort} host=localhost:${upPort}`, 'echo ping']);
  ws.close();
  const refused = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { host, origin: page.origin } });
  await new Promise((r) => { refused.on('error', r); refused.on('unexpected-response', (_q, res) => { assert.equal(res.statusCode, 401); r(); }); });
});

test('an app that is not running gives a page that says so and retries', async () => {
  const r0 = await belayApi('POST', '/api/pages', { address: 'localhost:1' });
  const host = new URL(r0.json.origin).host;
  const u = new URL(r0.json.url);
  const c = (await req('GET', host, `${u.pathname}${u.search}`)).headers['set-cookie'][0].split(';')[0];
  const r = await req('GET', host, '/', { headers: { cookie: c } });
  assert.equal(r.status, 502);
  assert.match(r.text, /Nothing answered at localhost:1 on the belay machine/);
  assert.match(r.text, /http-equiv="refresh"/);
});

test('belay refuses requests and sockets from other origins, such as a remote page', async () => {
  const evil = await belayApi('POST', '/api/sessions', { templateId: 'shell', name: 'x' }, { origin: page.origin });
  assert.equal(evil.status, 403);
  assert.equal((await belayApi('GET', '/api/state', null, { origin: 'null' })).status, 403);
  assert.equal((await belayApi('GET', '/api/health', null, { origin: `http://127.0.0.1:${port}` })).status, 200, 'its own origin is fine');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `belay=${TOKEN}`, origin: page.origin } });
  await new Promise((r) => { ws.on('error', r); ws.on('unexpected-response', (_q, res) => { assert.equal(res.statusCode, 401); r(); }); });
});

test('SOCKS5 client: a name is resolved by the proxy, and errors are reported', async () => {
  // A one-shot SOCKS5 server that records what it was asked for and connects to the upstream app.
  let asked = null;
  const proxy = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (d) => {
        const n = d[4];
        asked = `${d.subarray(5, 5 + n)}:${d.readUInt16BE(5 + n)}`;
        if (asked.startsWith('refuse')) { c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const up = net.connect(upPort, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); c.pipe(up).pipe(c); });
      });
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const sock = await socks5(proxy.address().port, 'svc.ns.svc.cluster.local', 8080);
  assert.equal(asked, 'svc.ns.svc.cluster.local:8080');
  sock.write('GET /via-socks HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  const text = await new Promise((r) => { let t = ''; sock.on('data', (d) => { t += d; }); sock.on('end', () => r(t)); });
  assert.match(text, /^HTTP\/1\.1 200/);
  await assert.rejects(socks5(proxy.address().port, 'refuse.me', 1), /connection refused/);
  proxy.close();
});

/**
 * The ssh path for real: a private sshd on a spare port, and an `ssh` on PATH that points the tunnel at it.
 * Needs sshd and ssh-keygen, and an sshd that will run here; without them this test says so and is skipped.
 */
test('a page of a project on another host goes through ssh, and resolves names there', async (t) => {
  const sshd = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => fs.existsSync(p));
  let keygen = null;
  try { keygen = execFileSync('sh', ['-c', 'command -v ssh-keygen'], { encoding: 'utf8' }).trim(); } catch {}
  if (!sshd || !keygen) { t.skip('no sshd here'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-sshd-'));
  fs.chmodSync(dir, 0o700);
  execFileSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'host')]);
  execFileSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'user')]);
  fs.copyFileSync(path.join(dir, 'user.pub'), path.join(dir, 'authorized_keys'));
  fs.chmodSync(path.join(dir, 'authorized_keys'), 0o600);
  // sshd started by root wants its privilege separation directory; started by anyone else it does not.
  try { fs.mkdirSync('/run/sshd', { recursive: true }); } catch {}
  const d = spawn(sshd, ['-D', '-e', '-f', '/dev/null', '-p', String(sshPort), '-h', path.join(dir, 'host'), '-o', `AuthorizedKeysFile=${path.join(dir, 'authorized_keys')}`,
    '-o', 'ListenAddress=127.0.0.1', '-o', 'PasswordAuthentication=no', '-o', 'StrictModes=no', '-o', `PidFile=${path.join(dir, 'pid')}`, '-o', 'AllowTcpForwarding=yes'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let dErr = '';
  d.stderr.on('data', (x) => { dErr += x; });
  // Torn down last, after belay (registered below): belay closes its connections through this ssh and config.
  let s2 = null;
  t.after(async () => {
    if (s2) await new Promise((r) => { s2.once('exit', r); s2.kill(); });
    d.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let listening = false;
  for (let i = 0; i < 50 && !listening; i++) {
    listening = await new Promise((r) => { const s = net.connect(sshPort, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
    if (!listening) await sleep(100);
  }
  if (!listening) { t.skip(`the private sshd did not start: ${dErr.trim().split('\n').pop()}`); return; }
  // belay runs `ssh … sshbox`; this ssh sends sshbox to the private sshd.
  fs.writeFileSync(path.join(dir, 'config'), `Host sshbox\n  HostName 127.0.0.1\n  Port ${sshPort}\n  IdentityFile ${path.join(dir, 'user')}\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n`);
  fs.mkdirSync(path.join(dir, 'bin'));
  const realSsh = execFileSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'bin', 'ssh'), `#!/bin/sh\nexec ${realSsh} -F ${path.join(dir, 'config')} "$@"\n`, { mode: 0o755 });
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pages-ssh-'));
  const p2 = port2;
  s2 = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, BELAY_TOKEN: '', BELAY_PORT: String(p2), BELAY_DATA_DIR: dd }, stdio: ['ignore', 'ignore', 'inherit'] });
  t.after(() => fs.rmSync(dd, { recursive: true, force: true }));
  const call = (method, host, p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p2, method, path: p, headers: { host, 'content-type': 'application/json' } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    r.on('error', reject);
    r.end(body && JSON.stringify(body));
  });
  for (let i = 0; i < 100; i++) { try { if ((await call('GET', `127.0.0.1:${p2}`, '/api/health')).status === 200) break; } catch {} await sleep(50); }
  const reg = JSON.parse((await call('POST', `localhost:${p2}`, '/api/pages', { address: `localhost:${upPort}/x`, host: 'sshbox' })).text);
  assert.equal(reg.url, `${reg.origin}/x`, 'without a token there is no sign-in step');
  seen.length = 0;
  const r = await call('GET', new URL(reg.origin).host, '/through-ssh');
  assert.equal(r.status, 200, `${r.text}\n${dErr}`);
  assert.equal(seen.at(-1).url, '/through-ssh');
  assert.equal(seen.at(-1).headers.host, `localhost:${upPort}`);
  const ws = new WebSocket(`ws://127.0.0.1:${p2}/s`, { headers: { host: new URL(reg.origin).host, origin: reg.origin } });
  const first = await new Promise((res, rej) => { ws.on('message', (m) => res(String(m))); ws.on('error', rej); });
  assert.equal(first, `hello origin=http://localhost:${upPort} host=localhost:${upPort}`);
  ws.close();
  const down = JSON.parse((await call('POST', `localhost:${p2}`, '/api/pages', { address: 'localhost:1', host: 'sshbox' })).text);
  const r2 = await call('GET', new URL(down.origin).host, '/');
  assert.equal(r2.status, 502);
  assert.match(r2.text, /Nothing answered at localhost:1 on sshbox/);
  // Viewer tabs read media over the same ssh: a range comes back exactly.
  const media = path.join(dir, 'clip.mp4');
  fs.writeFileSync(media, Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  const ranged = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p2, path: `/api/files/raw?path=${encodeURIComponent(media)}&host=sshbox`, headers: { range: 'bytes=100-103' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, range: res.headers['content-range'], body: [...Buffer.concat(chunks)] }));
    });
    r.on('error', reject);
    r.end();
  });
  assert.deepEqual(ranged, { status: 206, range: 'bytes 100-103/256', body: [100, 101, 102, 103] });
  const nohost = JSON.parse((await call('POST', `localhost:${p2}`, '/api/pages', { address: 'localhost:80', host: 'nosuchhost.invalid' })).text);
  const r3 = await call('GET', new URL(nohost.origin).host, '/');
  assert.match(r3.text, /ssh to nosuchhost\.invalid failed/);
});
