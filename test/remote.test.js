// Sessions on a host, end to end: belay puts its holder there over ssh, runs the session in it, loses the
// connection and comes back to exactly where it was, and is restarted without the session noticing. The host
// is an ssh server of the test's own on this machine, with a home of its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { stopHolder } from './holder.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = (cmd) => { try { return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const sshd = which('sshd') || (fs.existsSync('/usr/sbin/sshd') ? '/usr/sbin/sshd' : '');
const skip = !sshd || !which('ssh-keygen') ? 'needs sshd and ssh-keygen' : false;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'brt-'));
const home = path.join(T, 'home');
const dataDir = path.join(T, 'data');
const sshPort = 20000 + Math.floor(Math.random() * 20000);
const port = 40000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
let server;
let sshdPid;
// Set once the private sshd is up; where one cannot be started (no sshd, or one that needs root), the tests skip.
let up = false;
const need = (t) => { if (!up) t.skip('no private sshd here'); return up; };

async function api(method, p, body) {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function waitFor(fn, ms = 15000, step = 100) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  throw new Error(`timeout waiting for condition (last: ${JSON.stringify(last)})`);
}
async function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, BELAY_TOKEN: '', BELAY_PORT: String(port), BELAY_DATA_DIR: dataDir, BELAY_SSH_CONFIG: path.join(T, 'ssh_config') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.BELAY_TEST_VERBOSE && process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(async () => { try { return (await api('GET', '/api/health')).ok; } catch { return false; } }, 5000, 50);
  return child;
}
const stopServer = (child) => new Promise((res) => { child.once('exit', res); child.kill('SIGTERM'); });
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, msgs: [], send: (m) => ws.send(JSON.stringify(m)) };
    c.text = (sid) => c.msgs.filter((m) => m.sid === sid && (m.t === 'replay' || m.t === 'data')).map((m) => m.data).join('');
    ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'hello') resolve(c); });
    ws.on('error', reject);
  });
}
const session = (id) => api('GET', `/api/sessions/${id}`);
/** The ssh connection belay keeps to the host's holder: killing it is the network dropping. */
const holderSsh = () => execFileSync('sh', ['-c', `pgrep -f 'belay-hold-[0-9a-f]+ connect' || true`], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);

before(async () => {
  if (skip) return;
  fs.mkdirSync(home);
  // A home like Ubuntu's: .profile reads .bashrc, which goes no further unless the shell is interactive, and
  // what the installer added (~/.local/bin, where claude lives) comes after that.
  fs.writeFileSync(path.join(home, '.profile'), '[ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n');
  fs.writeFileSync(path.join(home, '.bashrc'), 'case $- in *i*) ;; *) return;; esac\nexport PATH="$HOME/.local/bin:$PATH"\n');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'fakeclaude'), '#!/bin/sh\necho "fakeclaude-is-here $*"\nexec sleep 30\n', { mode: 0o755 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(T, 'hostkey')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(T, 'key')]);
  fs.copyFileSync(path.join(T, 'key.pub'), path.join(T, 'authorized_keys'));
  fs.writeFileSync(path.join(T, 'sshd_config'), [
    `Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${T}/hostkey`, `AuthorizedKeysFile ${T}/authorized_keys`,
    `PidFile ${T}/sshd.pid`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PermitRootLogin prohibit-password', `SetEnv HOME=${home}`, ''].join('\n'));
  // ssh takes the first value it finds for a setting: a host's own settings go first.
  const host = (alias, extra = [], { port = true, strict = true } = {}) => [`Host ${alias}`, ...extra, '  HostName 127.0.0.1', ...(port ? [`  Port ${sshPort}`] : []),
    `  User ${os.userInfo().username}`, '  IdentitiesOnly yes', ...(strict ? ['  StrictHostKeyChecking no', '  UserKnownHostsFile /dev/null'] : []), '  LogLevel ERROR'];
  fs.writeFileSync(path.join(T, 'ssh_config'), [
    ...host('box', [`  IdentityFile ${T}/key`]),
    // A host that wants a password: belay cannot hold sessions there.
    // (A user of its own, or it would share box's connection, already signed in: the same host to ssh.)
    ...host('nokey', [`  IdentityFile ${T}/hostkey`, '  User belay-nobody']),
    // No port: it is given with the host, box-port:<port>.
    ...host('noport', [`  IdentityFile ${T}/key`], { port: false }),
    // A host that runs its own command, wants a terminal and forwards a port, all of which would stop belay.
    ...host('fancy', [`  IdentityFile ${T}/key`, '  RemoteCommand echo not-belay', '  RequestTTY force', `  LocalForward 127.0.0.1:${sshPort + 1} 127.0.0.1:${sshPort}`, '  ExitOnForwardFailure yes']),
    // A host belay has not met: trusted on first use, and remembered. (By another name, so that it is a
    // connection of its own, not box's again.)
    ...host('fresh', ['  HostName localhost', `  IdentityFile ${T}/key`, `  UserKnownHostsFile ${T}/known_hosts`], { strict: false }),
    'Host gone', '  HostName 127.0.0.1', '  Port 9', '  ConnectTimeout 2', ''].join('\n'));
  try {
    execFileSync(sshd, ['-f', path.join(T, 'sshd_config'), '-E', path.join(T, 'sshd.log')]);
    sshdPid = Number(await waitFor(() => { try { return fs.readFileSync(path.join(T, 'sshd.pid'), 'utf8').trim(); } catch { return ''; } }, 5000, 50));
    execFileSync('ssh', ['-F', path.join(T, 'ssh_config'), '-o', 'BatchMode=yes', 'box', 'true'], { timeout: 10000 });
    up = true;
  } catch (e) {
    let why = e.message;
    try { why += `\n${fs.readFileSync(path.join(T, 'sshd.log'), 'utf8')}`; } catch {}
    console.log(`# no private sshd, remote tests skipped: ${why}`);
    return;
  }
  server = await startServer();
});

after(async () => {
  if (skip) return;
  if (!up) { fs.rmSync(T, { recursive: true, force: true }); return; }
  if (server) await stopServer(server);
  await stopHolder(path.join(home, '.belay'));
  await stopHolder(dataDir);
  try { process.kill(sshdPid); } catch {}
  fs.rmSync(T, { recursive: true, force: true });
});

let sid;
let pid;
test('belay puts its holder on the host and runs the session there', { skip }, async (t) => {
  if (!need(t)) return;
  const s = await api('POST', '/api/sessions', { templateId: 'shell', name: 'on box', cwd: os.tmpdir(), vars: { host: 'box', dir: '/usr' } });
  sid = s.id;
  assert.equal(s.status, 'running', JSON.stringify(s));
  assert.equal(s.link, null, 'held, not plain ssh');
  assert.equal(s.host, 'box');
  pid = s.pid;
  const bins = fs.readdirSync(path.join(home, '.belay', 'bin'));
  assert.equal(bins.length, 1);
  assert.match(bins[0], /^belay-hold-[0-9a-f]{12}$/);
  assert.ok(fs.existsSync(path.join(home, '.belay', 'scripts', 'provision-claude.sh')), 'the agents\' setup scripts came with it');
  const c = await connect();
  c.send({ t: 'attach', sid, cols: 100, rows: 30 });
  await waitFor(() => c.msgs.some((m) => m.t === 'replay' && m.sid === sid));
  c.send({ t: 'input', sid, data: 'echo "at-$(pwd)-home-$HOME"\n' });
  await waitFor(() => c.text(sid).includes(`at-/usr-home-${home}`)).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(c.text(sid).slice(-600))}`); });
  c.ws.close();
});

test('the connection drops; the session carries on, and belay catches up on exactly what it missed', { skip }, async (t) => {
  if (!need(t)) return;
  const c = await connect();
  c.send({ t: 'attach', sid, cols: 100, rows: 30 });
  await waitFor(() => c.msgs.some((m) => m.t === 'replay' && m.sid === sid));
  c.send({ t: 'input', sid, data: 'sleep 1; echo during-$((2+3))-drop\n' });
  await sleep(300);
  const ssh = holderSsh();
  assert.ok(ssh.length >= 1, 'belay keeps an ssh connection to the holder');
  for (const p of ssh) process.kill(p, 'SIGKILL');
  await waitFor(async () => (await session(sid)).link === 'reconnecting', 5000, 20);
  await waitFor(async () => (await session(sid)).link === null);
  await waitFor(() => c.text(sid).includes('during-5-drop'));
  await sleep(300);
  assert.equal(c.text(sid).split('during-5-drop').length, 2, 'once, not twice');
  assert.equal((await session(sid)).pid, pid, 'the same process');
  c.ws.close();
});

test('belay restarts; the session on the host never noticed', { skip }, async (t) => {
  if (!need(t)) return;
  const c0 = await connect();
  c0.send({ t: 'attach', sid, cols: 100, rows: 30 });
  await waitFor(() => c0.msgs.some((m) => m.t === 'replay' && m.sid === sid));
  c0.send({ t: 'input', sid, data: 'sleep 2; echo while-$((3+4))-away\n' });
  await sleep(300);
  c0.ws.close();
  await stopServer(server);
  await sleep(2500);
  server = await startServer();
  const s = await waitFor(async () => { const x = await session(sid); return x.status === 'running' && x.link === null ? x : null; });
  assert.equal(s.pid, pid);
  const c = await connect();
  c.send({ t: 'attach', sid, cols: 100, rows: 30 });
  await waitFor(() => c.text(sid).includes('while-7-away'));
  assert.equal(c.text(sid).split('while-7-away').length, 2);
  c.ws.close();
});

test("a session of a project runs on the project's host, in its directory, with nothing of its own", { skip }, async (t) => {
  if (!need(t)) return;
  await api('PUT', '/api/projects', { projects: [{ id: 'pbox', name: 'Box', host: 'box', dir: '/usr' }] });
  const s = await api('POST', '/api/sessions', { templateId: 'shell', cwd: os.tmpdir(), project: 'pbox' });
  assert.deepEqual([s.status, s.link, s.host, s.dir, s.vars], ['running', null, 'box', '/usr', {}], "the project's host and directory");
  const c = await connect();
  c.send({ t: 'attach', sid: s.id, cols: 100, rows: 30 });
  await waitFor(() => c.msgs.some((m) => m.t === 'replay' && m.sid === s.id));
  c.send({ t: 'input', sid: s.id, data: 'echo "on-$HOME-in-$(pwd)"\n' });
  await waitFor(() => c.text(s.id).includes(`on-${home}-in-/usr`));
  c.ws.close();
  await api('DELETE', `/api/sessions/${s.id}`);
  await api('PUT', '/api/projects', { projects: [] });
});

test("a project's directory is browsed on its host: the directories there, from home down", { skip }, async (t) => {
  if (!need(t)) return;
  fs.mkdirSync(path.join(home, 'projects', 'app'), { recursive: true });
  const at = (p) => api('GET', `/api/fs/entries?${new URLSearchParams({ path: p, host: 'box' })}`);
  assert.ok((await at('~/')).entries.includes('projects/'));
  assert.deepEqual((await at('~/projects/')).entries, ['app/']);
  assert.deepEqual((await at('~/projects/a')).entries, ['app/'], 'what is typed narrows it');
  assert.deepEqual((await at(`${home}/projects/`)).entries, ['app/'], 'and full paths');
});

test('a command finds what a shell you type in would: what .bashrc puts on the PATH', { skip }, async (t) => {
  if (!need(t)) return;
  const tpl = await api('POST', '/api/templates', { name: 'fake claude', command: 'fakeclaude --resume x' });
  const s = await api('POST', '/api/sessions', { templateId: tpl.id, cwd: os.tmpdir(), vars: { host: 'box' } });
  const c = await connect();
  c.send({ t: 'attach', sid: s.id, cols: 100, rows: 30 });
  await waitFor(() => c.text(s.id).includes('fakeclaude-is-here --resume x')).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(c.text(s.id).slice(-400))}`); });
  c.ws.close();
  await api('DELETE', `/api/sessions/${s.id}`);
  await api('DELETE', `/api/templates/${tpl.id}`);
});

test("an agent's hooks on the host reach belay", { skip }, async (t) => {
  if (!need(t)) return;
  const tpl = await api('POST', '/api/templates', { name: 'fake agent', agent: 'claude', command: `curl -s -X POST "$BELAY_URL/api/hook/claude?belay=$BELAY_SESSION" -H 'content-type: application/json' -d '{"hook_event_name":"Stop","session_id":"conv-on-box"}'; sleep 30` });
  const s = await api('POST', '/api/sessions', { templateId: tpl.id, cwd: os.tmpdir(), vars: { host: 'box' } });
  const done = await waitFor(async () => { const x = await session(s.id); return x.vars.session === 'conv-on-box' ? x : null; });
  assert.equal(done.activity?.state, 'idle');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'settings.json')), "the agent's hooks were set up on the host");
  await api('DELETE', `/api/sessions/${s.id}`);
  await api('DELETE', `/api/templates/${tpl.id}`);
});

test('your ssh config: a port with the host, its user over the session\'s, its own command and forwards, a host met for the first time', { skip }, async (t) => {
  if (!need(t)) return;
  const made = [];
  const run = async (vars) => {
    const s = await api('POST', '/api/sessions', { templateId: 'shell', cwd: os.tmpdir(), vars });
    made.push(s.id);
    assert.equal(s.status, 'running', `${JSON.stringify(vars)}: ${JSON.stringify(s)}`);
    assert.equal(s.link, null, `${JSON.stringify(vars)} is held, not plain ssh`);
    return s;
  };
  await run({ host: `noport:${sshPort}` });
  const wrong = await run({ host: 'box', user: 'someone-else' });
  assert.equal(wrong.host, 'box', "the config's User, not the session's");
  await run({ host: 'fancy' });
  await run({ host: 'fresh' });
  assert.match(fs.readFileSync(path.join(T, 'known_hosts'), 'utf8'), /ssh-ed25519/, 'its key is remembered');
  // What the forms show: the config's hosts, and where one goes.
  const hosts = await api('GET', '/api/ssh/hosts');
  assert.deepEqual(hosts.map((h) => h.name), ['box', 'nokey', 'noport', 'fancy', 'fresh', 'gone']);
  assert.deepEqual(hosts[0], { name: 'box', hostname: '127.0.0.1', user: os.userInfo().username, port: sshPort });
  const r = await api('GET', '/api/ssh/resolve?host=box&user=someone-else');
  assert.deepEqual([r.hostname, r.user, r.port, r.configUser], ['127.0.0.1', os.userInfo().username, sshPort, os.userInfo().username]);
  await assert.rejects(api('GET', '/api/ssh/resolve?host=-oProxyCommand=x'), /400/);
  for (const id of made) await api('DELETE', `/api/sessions/${id}`);
});

test('a host belay cannot keep a holder on gets plain ssh, and says so', { skip }, async (t) => {
  if (!need(t)) return;
  const s = await api('POST', '/api/sessions', { templateId: 'shell', cwd: os.tmpdir(), vars: { host: 'nokey' } });
  assert.equal(s.link, 'plain');
  assert.match(s.linkNote, /^Not held on nokey/);
  await api('DELETE', `/api/sessions/${s.id}`);
});

test('a host that cannot be reached is an error, shown in the session', { skip }, async (t) => {
  if (!need(t)) return;
  await assert.rejects(api('POST', '/api/sessions/' + (await api('POST', '/api/sessions', { templateId: 'shell', cwd: os.tmpdir(), vars: { host: 'gone' }, autostart: false })).id + '/start'), /could not reach gone/);
  const s = (await api('GET', '/api/sessions')).find((x) => x.host === 'gone');
  assert.equal(s.status, 'exited');
  const plain = await (await fetch(`${base}/api/sessions/${s.id}/scrollback?plain=1`)).text();
  assert.match(plain, /failed to start: could not reach gone/);
  await api('DELETE', `/api/sessions/${s.id}`);
});

test('deleting the session ends it on the host', { skip }, async (t) => {
  if (!need(t)) return;
  await api('DELETE', `/api/sessions/${sid}`);
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 8000);
});
