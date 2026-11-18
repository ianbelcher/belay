// End-to-end smoke test: boots the server with a throwaway data dir and drives it
// through REST + WebSocket exactly as the browser does, including a server restart.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-test-'));
// The sessions' own holder, away from the real one in ~/.belay.
const holdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
const port = 17000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let server;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, p, body) {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, BELAY_TOKEN: '', BELAY_PORT: String(port), BELAY_DATA_DIR: dataDir, BELAY_HOLD_DIR: holdDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.BELAY_TEST_VERBOSE && process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    try { const h = await api('GET', '/api/health'); if (h.ok) return child; } catch {}
    await sleep(50);
  }
  throw new Error('server did not start');
}
function stopServer(child) {
  return new Promise((res) => { child.once('exit', res); child.kill('SIGTERM'); });
}
async function waitFor(fn, ms = 6000, step = 100) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  throw new Error('timeout waiting for condition');
}
/** Minimal browser-like client: one ws, per-session message queues. */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const client = { ws, msgs: [], hello: null, send: (m) => ws.send(JSON.stringify(m)) };
    client.waitFor = (pred, ms = 5000) => waitFor(() => client.msgs.find(pred), ms, 20);
    client.textFor = (sid) => client.msgs.filter((m) => m.sid === sid && (m.t === 'data' || m.t === 'replay')).map((m) => m.data).join('');
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'hello') { client.hello = m.state; resolve(client); } client.msgs.push(m); });
    ws.on('error', reject);
  });
}

before(async () => { server = await startServer(); });
after(async () => {
  if (server) await stopServer(server);
  await stopHolder(holdDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(holdDir, { recursive: true, force: true });
});

test('state has seeded templates and settings', async () => {
  const st = await api('GET', '/api/state');
  assert.deepEqual(st.templates.map((t) => t.id), ['shell', 'claude', 'codex', 'opencode', 'command']);
  assert.deepEqual(st.templates.map((t) => t.agent), ['', 'claude', 'codex', 'opencode', '']);
  assert.equal(st.settings.theme, 'dark');
  assert.equal(st.sessions.length, 0);
});

test('template preview derives fields and renders optional fragments', async () => {
  const p = await api('POST', '/api/templates/preview', { command: 'ssh -t {{#user}}{{user}}@{{/user}}{{host}}', vars: { host: 'box' } });
  assert.deepEqual(p.fields, [{ name: 'user', required: false }, { name: 'host', required: true }]);
  assert.equal(p.command, 'ssh -t box');
  const p2 = await api('POST', '/api/templates/preview', { command: 'ssh -t {{#user}}{{user}}@{{/user}}{{host}}', vars: { host: 'box', user: 'ian' } });
  assert.equal(p2.command, 'ssh -t ian@box');
  await assert.rejects(api('POST', '/api/sessions', { templateId: 'command', cwd: os.tmpdir(), vars: {} }), /missing required fields: command/);
});

test('template CRUD', async () => {
  const t = await api('POST', '/api/templates', { name: 'Echo thing', command: 'echo {{what}}', nameTemplate: 'echo {{what}}', exitPolicy: 'hold' });
  assert.equal(t.id, 'echo-thing');
  const t2 = await api('PUT', `/api/templates/${t.id}`, { ...t, command: 'echo [{{what}}]' });
  assert.equal(t2.command, 'echo [{{what}}]');
  await assert.rejects(api('PUT', `/api/templates/${t.id}`, { ...t, command: '{{#a}}' }), /Unclosed section/);
  await api('DELETE', `/api/templates/${t.id}`);
  await assert.rejects(api('DELETE', `/api/templates/${t.id}`), /404/);
});

test('a template says what to run; the project says where', async () => {
  const k9s = await api('POST', '/api/templates', { name: 'k9s', command: 'k9s{{#context}} --context {{context}}{{/context}}' });
  assert.equal(k9s.agent, '');
  const here = await api('POST', '/api/sessions', { templateId: 'k9s', cwd: os.tmpdir(), autostart: false });
  assert.equal(here.command, 'k9s');
  assert.match(here.name, /^[a-z]+-[a-z]+$/, 'a name of its own, like sly-fox');
  const there = await api('POST', '/api/sessions', { templateId: 'k9s', cwd: os.tmpdir(), vars: { host: 'box', user: 'ian', dir: '~/ops', context: 'prod' }, autostart: false });
  assert.deepEqual([there.host, there.dir, there.command, there.provision], ['ian@box', '~/ops', 'k9s --context prod', '']);

  assert.deepEqual([here.host, here.dir], ['', '']);
  // A session of a project runs on the project's host, as it is when the session starts: a project moved to
  // another host takes its sessions with it. A template cannot name a host of its own.
  await api('PUT', '/api/projects', { projects: [{ id: 'pbox', name: 'Box', host: 'box', user: 'ian' }] });
  const htop = await api('POST', '/api/templates', { name: 'htop', command: 'htop', defaults: { host: 'elsewhere' } });
  const ht = await api('POST', '/api/sessions', { templateId: htop.id, cwd: os.tmpdir(), project: 'pbox', autostart: false });
  assert.deepEqual([ht.host, ht.command], ['ian@box', 'htop']);
  assert.deepEqual(ht.vars, {}, 'the place is the project\'s, not kept with the session');
  await api('PUT', '/api/projects', { projects: [{ id: 'pbox', name: 'Box', host: 'other:2222' }] });
  assert.equal((await api('GET', `/api/sessions/${ht.id}`)).host, 'other:2222');
  // A project here: its sessions start in its directory, wherever they were asked to.
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pdir-'));
  await api('PUT', '/api/projects', { projects: [{ id: 'phere', name: 'Here', dir: projDir }] });
  const inDir = await api('POST', '/api/sessions', { templateId: 'shell', cwd: '/', project: 'phere', autostart: false });
  assert.equal(inDir.cwd, projDir);
  fs.rmSync(projDir, { recursive: true, force: true });
  const plain = await api('POST', '/api/sessions', { templateId: htop.id, cwd: os.tmpdir(), autostart: false });
  assert.equal(plain.host, '', 'no project, no host: a template\'s default host counts for nothing');
  await api('PUT', '/api/projects', { projects: [] });
  // One that writes its own ssh runs here as written, with the place filled in.
  const own = await api('POST', '/api/templates', { name: 'own ssh', command: 'ssh -t {{host}} top' });
  const ow = await api('POST', '/api/sessions', { templateId: own.id, cwd: os.tmpdir(), vars: { host: 'box' }, autostart: false });
  assert.deepEqual([ow.host, ow.command], ['', 'ssh -t box top']);
  // A template of your own can start an agent: set up where it runs, and reporting through its hooks.
  const yolo = await api('POST', '/api/templates', { name: 'yolo', command: 'claude --dangerously-skip-permissions', agent: 'claude' });
  const y = await api('POST', '/api/sessions', { templateId: yolo.id, cwd: os.tmpdir(), vars: { host: 'box' }, autostart: false });
  assert.deepEqual([y.host, y.command, y.provision], ['box', 'claude --dangerously-skip-permissions', 'sh "$BELAY_HOME/scripts/provision-claude.sh"']);
  assert.equal(y.agent, 'claude');
  const bad = await api('POST', '/api/templates', { name: 'bad', command: 'x', agent: 'aider' });
  assert.equal(bad.agent, '', 'not an agent belay knows: none');
  await api('DELETE', `/api/templates/${bad.id}`);
  for (const s of await api('GET', '/api/sessions')) await api('DELETE', `/api/sessions/${s.id}`);
  for (const t of [k9s, htop, own, yolo]) await api('DELETE', `/api/templates/${t.id}`);
});

let sid;
test('create a local shell session, attach, type, replay on reattach', async () => {
  const s = await api('POST', '/api/sessions', { templateId: 'shell', cwd: os.tmpdir(), name: 'shell one' });
  sid = s.id;
  assert.equal(s.templateId, 'shell');
  assert.equal(s.status, 'running');
  assert.ok(s.pid > 0);
  assert.equal(s.name, 'shell one');
  const c = await connect();
  assert.equal(c.hello.sessions.length, 1);
  c.send({ t: 'attach', sid, cols: 100, rows: 30 });
  const rep = await c.waitFor((m) => m.t === 'replay' && m.sid === sid);
  assert.equal(rep.cols, 100);
  assert.match(rep.data, /\$ exec "\$SHELL" -l/); // the command header line
  c.send({ t: 'input', sid, data: 'echo hello-$((40+2))\n' });
  await c.waitFor((m) => m.t === 'data' && m.sid === sid && m.data.includes('hello-42'));
  await sleep(200);
  c.send({ t: 'resize', sid, cols: 90, rows: 25 });
  await sleep(100);
  const after = await api('GET', `/api/sessions/${sid}`);
  assert.equal(after.cols, 90);
  assert.equal(after.attached, 1);
  c.ws.close();
  await sleep(100);
  const c2 = await connect();
  c2.send({ t: 'attach', sid, cols: 90, rows: 25 });
  const rep2 = await c2.waitFor((m) => m.t === 'replay' && m.sid === sid);
  assert.ok(rep2.data.includes('hello-42'), 'replay carries earlier output');
  c2.ws.close();
});

test('cwd follows the shell', async () => {
  const c = await connect();
  c.send({ t: 'attach', sid, cols: 90, rows: 25 });
  await c.waitFor((m) => m.t === 'replay');
  c.send({ t: 'input', sid, data: 'cd /usr\n' });
  const s = await waitFor(async () => { const x = await api('GET', `/api/sessions/${sid}`); return x.cwd === '/usr' ? x : null; }, 8000, 250);
  assert.equal(s.cwd, '/usr');
  c.ws.close();
});

test('edit vars and name, stop, restart', async () => {
  const s = await api('PATCH', `/api/sessions/${sid}`, { name: 'renamed', vars: { ignored: 'x' } });
  assert.equal(s.name, 'renamed');
  const stopped = await api('POST', `/api/sessions/${sid}/stop`);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.desired, 'stopped');
  assert.ok(fs.existsSync(path.join(dataDir, 'scrollback', `${sid}.ansi`)), 'scrollback saved on exit');
  const restarted = await api('POST', `/api/sessions/${sid}/restart`);
  assert.equal(restarted.status, 'running');
  assert.equal(restarted.desired, 'running');
  assert.equal(restarted.cwd, '/usr', 'relaunch keeps the last directory');
});

test('exit policies: hold keeps exit code, restart relaunches, close removes', async () => {
  const hold = await api('POST', '/api/sessions', { templateId: 'command', cwd: os.tmpdir(), vars: { command: 'exit 3' }, exitPolicy: 'hold' });
  const h = await waitFor(async () => { const x = await api('GET', `/api/sessions/${hold.id}`); return x.status === 'exited' ? x : null; });
  assert.equal(h.exitCode, 3);
  assert.equal(h.desired, 'running');

  const rs = await api('POST', '/api/sessions', { templateId: 'command', cwd: os.tmpdir(), vars: { command: 'sleep 0.3; exit 0' }, exitPolicy: 'restart' });
  const firstPid = rs.pid;
  const r2 = await waitFor(async () => { const x = await api('GET', `/api/sessions/${rs.id}`); return x.status === 'running' && x.pid !== firstPid ? x : null; }, 8000, 100);
  assert.notEqual(r2.pid, firstPid);

  const cl = await api('POST', '/api/sessions', { templateId: 'command', cwd: os.tmpdir(), vars: { command: 'true' }, exitPolicy: 'close' });
  await waitFor(async () => { const all = await api('GET', '/api/sessions'); return all.some((x) => x.id === cl.id) ? null : true; });

  await api('DELETE', `/api/sessions/${hold.id}`);
  await api('DELETE', `/api/sessions/${rs.id}`);
  assert.ok(!fs.existsSync(path.join(dataDir, 'scrollback', `${hold.id}.ansi`)));
});

test('claude hook stores the conversation id and tracks activity', async () => {
  const s = await api('POST', '/api/sessions', { templateId: 'claude', cwd: os.tmpdir(), name: 'cc', autostart: false });
  assert.equal(s.status, 'stopped');
  assert.equal(s.command, 'claude');
  assert.equal(s.provision, 'sh "$BELAY_HOME/scripts/provision-claude.sh"');
  const hook = (body) => api('POST', `/api/hook/claude?belay=${s.id}`, body);
  let r = await hook({ session_id: 'abc-123', hook_event_name: 'SessionStart', source: 'startup' });
  assert.deepEqual(r, { ok: true, activity: 'idle' });
  const s2 = await api('GET', `/api/sessions/${s.id}`);
  assert.equal(s2.vars.session, 'abc-123');
  assert.equal(s2.command, 'claude --resume abc-123');
  await hook({ session_id: "x'; touch /tmp/belay-pwned; '" });
  assert.equal((await api('GET', `/api/sessions/${s.id}`)).command, 'claude --resume abc-123', 'an id that is not a plain token is ignored');
  r = await hook({ session_id: 'abc-123', hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.equal(r.activity, 'busy');
  r = await hook({ session_id: 'abc-123', hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  assert.equal(r.activity, 'busy');
  r = await hook({ session_id: 'abc-123', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.equal(r.activity, 'attention');
  r = await hook({ session_id: 'abc-123', hook_event_name: 'Stop' });
  assert.equal(r.activity, 'idle');
  assert.equal((await api('GET', `/api/sessions/${s.id}`)).activity.state, 'idle');
  r = await hook({ session_id: 'abc-123', hook_event_name: 'SessionEnd', reason: 'exit' });
  assert.equal(r.activity, null);
  const miss = await api('POST', `/api/hook/claude?belay=nope`, { session_id: 'x' });
  assert.equal(miss.ok, false);
  await api('DELETE', `/api/sessions/${s.id}`);
});

test('codex and opencode hooks store the conversation id and track activity', async () => {
  const st = await api('GET', '/api/state');
  for (const id of ['codex', 'opencode']) assert.equal(st.templates.find((t) => t.id === id).agent, id);
  const cx = await api('POST', '/api/sessions', { templateId: 'codex', cwd: os.tmpdir(), name: 'cx', autostart: false });
  assert.equal(cx.command, 'codex --no-daemon');
  assert.equal(cx.provision, 'sh "$BELAY_HOME/scripts/provision-codex.sh"');
  let r = await api('POST', `/api/hook/codex?belay=${cx.id}`, { session_id: '01a1574b-f3fd-7201-abb7-6b9ad4dadf5e', hook_event_name: 'UserPromptSubmit' });
  assert.equal(r.activity, 'busy');
  r = await api('POST', `/api/hook/codex?belay=${cx.id}`, { session_id: '01a1574b-f3fd-7201-abb7-6b9ad4dadf5e', hook_event_name: 'PermissionRequest' });
  assert.equal(r.activity, 'attention');
  const cx2 = await api('GET', `/api/sessions/${cx.id}`);
  assert.equal(cx2.command, 'codex --no-daemon resume 01a1574b-f3fd-7201-abb7-6b9ad4dadf5e');
  assert.equal(cx2.activity.agent, 'codex');

  // The same template on a host: over ssh, with the tunnel and environment its hooks report through.
  const oc = await api('POST', '/api/sessions', { templateId: 'opencode', cwd: os.tmpdir(), name: 'oc', vars: { host: 'box', dir: '/srv' }, autostart: false });
  assert.deepEqual([oc.host, oc.dir, oc.command, oc.provision], ['box', '/srv', 'opencode', 'sh "$BELAY_HOME/scripts/provision-opencode.sh"']);
  r = await api('POST', `/api/hook/opencode?belay=${oc.id}`, { session_id: 'ses_ea8b176feffezeuxYI06Q1282B', hook_event_name: 'Stop' });
  assert.equal(r.activity, 'idle');
  assert.equal((await api('GET', `/api/sessions/${oc.id}`)).command, 'opencode --session ses_ea8b176feffezeuxYI06Q1282B');
  await assert.rejects(api('POST', `/api/hook/aider?belay=${oc.id}`, { session_id: 'x' }), /404/);
  await api('DELETE', `/api/sessions/${cx.id}`);
  await api('DELETE', `/api/sessions/${oc.id}`);
});

test("provision-claude registers belay's own hook, beside another tool's hook of the same name", async () => {
  // python3, and node where there is no python3: a PATH of only what the script needs.
  const nodeOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-bin-'));
  for (const b of ['sh', 'cat', 'cmp', 'mv', 'chmod', 'mkdir', 'rm', 'uname', 'node']) {
    const at = execFileSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }).trim();
    fs.symlinkSync(at, path.join(nodeOnly, b));
  }
  for (const PATH of [process.env.PATH, nodeOnly]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-home-'));
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      // Another tool's hook, a file of the same name: it is not belay's, and belay's goes in beside it.
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/opt/other/claude-hook.sh' }] }] }, theme: 'dark' }));
      const run = () => execFileSync(path.join(nodeOnly, 'sh'), [path.join(root, 'hold', 'scripts', 'provision-claude.sh')], { env: { ...process.env, PATH, HOME: home }, encoding: 'utf8' });
      assert.match(run(), /Claude Code hooks installed/);
      const st = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
      assert.equal(st.theme, 'dark');
      assert.deepEqual(st.hooks.Stop.map((e) => e.hooks[0].command), ['/opt/other/claude-hook.sh', path.join(home, '.belay', 'claude-hook.sh')], PATH === nodeOnly ? 'node' : 'python3');
      assert.deepEqual(Object.keys(st.hooks).sort(), ['Notification', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
      assert.equal(run(), '', 'a second run changes nothing');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
  fs.rmSync(nodeOnly, { recursive: true, force: true });
});

test('provision-codex registers its hook in hooks.json once, keeping what is there', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-home-'));
  try {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/mine' }] }] }, other: 1 }));
    const run = () => execFileSync('sh', [path.join(root, 'hold', 'scripts', 'provision-codex.sh')], { env: { ...process.env, HOME: home, CODEX_HOME: '' }, encoding: 'utf8' });
    assert.match(run(), /Codex hooks installed/);
    const hooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(hooks.other, 1);
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.deepEqual(hooks.hooks.Stop.map((e) => e.hooks[0].command), ['/usr/bin/mine', path.join(home, '.belay', 'codex-hook.sh')]);
    assert.equal(run(), '', 'a second run changes nothing');
    assert.match(fs.readFileSync(path.join(home, '.belay', 'codex-hook.sh'), 'utf8'), /\/api\/hook\/codex\?belay=/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the opencode plugin reports the conversation and activity, not subagents', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-home-'));
  const s = await api('POST', '/api/sessions', { templateId: 'opencode', cwd: os.tmpdir(), name: 'oc-plugin', autostart: false });
  const env = { BELAY_SESSION: process.env.BELAY_SESSION, BELAY_URL: process.env.BELAY_URL };
  try {
    const run = () => execFileSync('sh', [path.join(root, 'hold', 'scripts', 'provision-opencode.sh')], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: '' }, encoding: 'utf8' });
    assert.match(run(), /opencode plugin installed/);
    assert.equal(run(), '', 'a second run changes nothing');
    const file = path.join(home, '.config', 'opencode', 'plugin', 'belay.js');
    Object.assign(process.env, { BELAY_SESSION: s.id, BELAY_URL: base });
    const { BelayPlugin } = await import(`${file}?${Date.now()}`);
    const plugin = await BelayPlugin({});
    const state = () => api('GET', `/api/sessions/${s.id}`);
    await waitFor(async () => (await state()).activity?.state === 'idle'); // SessionStart on load
    const ev = (type, properties) => plugin.event({ event: { type, properties } });
    await ev('session.created', { sessionID: 'ses_child', info: { id: 'ses_child', parentID: 'ses_main' } });
    await ev('session.status', { sessionID: 'ses_child', status: { type: 'busy' } });
    await ev('session.status', { sessionID: 'ses_main', status: { type: 'busy' } });
    await waitFor(async () => (await state()).activity?.state === 'busy');
    assert.equal((await state()).vars.session, 'ses_main');
    await ev('permission.asked', { sessionID: 'ses_main', id: 'per_1' });
    await waitFor(async () => (await state()).activity?.state === 'attention');
    await ev('permission.replied', { sessionID: 'ses_main', requestID: 'per_1' });
    await waitFor(async () => (await state()).activity?.state === 'busy');
    await ev('session.status', { sessionID: 'ses_main', status: { type: 'idle' } });
    await waitFor(async () => (await state()).activity?.state === 'idle');
    const done = await state();
    assert.equal(done.command, 'opencode --session ses_main');
    assert.equal(done.activity.agent, 'opencode');
    delete process.env.BELAY_SESSION;
    assert.deepEqual(await BelayPlugin({}), {}, 'outside belay it does nothing');
  } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(home, { recursive: true, force: true });
    await api('DELETE', `/api/sessions/${s.id}`);
  }
});

test('provision runs before the command and failures do not block it', async () => {
  const t = await api('POST', '/api/templates', { name: 'Prov', command: 'echo main-{{x}}; exit 0', provision: 'echo prov-{{x}}; false' });
  const s = await api('POST', '/api/sessions', { templateId: t.id, cwd: os.tmpdir(), vars: { x: '7' } });
  await waitFor(async () => (await api('GET', `/api/sessions/${s.id}`)).status === 'exited');
  const text = await (await fetch(`${base}/api/sessions/${s.id}/scrollback?plain=1`)).text();
  assert.ok(text.indexOf('prov-7') < text.indexOf('main-7'), 'provision output precedes main output');
  await api('DELETE', `/api/sessions/${s.id}`);
  await api('DELETE', `/api/templates/${t.id}`);
});

test('built-in templates can be edited, reset individually, deleted and restored', async () => {
  const orig = await api('GET', '/api/templates');
  const cli = orig.find((t) => t.id === 'shell');
  const edited = await api('PUT', '/api/templates/shell', { ...cli, command: 'bash --norc' });
  assert.equal(edited.command, 'bash --norc');
  assert.equal(edited.builtin, true);
  const reset = await api('POST', '/api/templates/shell/reset');
  assert.equal(reset.command, 'exec "$SHELL" -l');
  await assert.rejects(api('POST', '/api/templates/nope/reset'), /404/);
  await api('DELETE', '/api/templates/codex');
  assert.ok(!(await api('GET', '/api/templates')).some((t) => t.id === 'codex'));
  await api('POST', '/api/templates/reset');
  assert.ok((await api('GET', '/api/templates')).some((t) => t.id === 'codex'));
});

test('settings keep keybinding overrides', async () => {
  const s = await api('PUT', '/api/settings', { keybindings: { 'new-project': ['Ctrl+Shift+Y'] } });
  assert.deepEqual(s.keybindings, { 'new-project': ['Ctrl+Shift+Y'] });
  const s2 = await api('PUT', '/api/settings', { keybindings: 'junk' });
  assert.deepEqual(s2.keybindings, { 'new-project': ['Ctrl+Shift+Y'] });
});

test('notes: create, edit, broadcast, delete; projects keep their directory and notes', async () => {
  const c = await connect();
  const n = await api('POST', '/api/notes', { title: '  Ideas  ', text: 'one' });
  assert.equal(n.title, 'Ideas');
  assert.equal(n.text, 'one');
  const edited = await api('PUT', `/api/notes/${n.id}`, { text: 'one\ntwo', origin: 'me' });
  assert.equal(edited.text, 'one\ntwo');
  const msg = await c.waitFor((m) => m.t === 'note' && m.note.text === 'one\ntwo');
  assert.equal(msg.origin, 'me');
  await assert.rejects(api('PUT', `/api/notes/${n.id}`, { text: 'x'.repeat(1024 * 1024 + 1) }), /413/);
  assert.equal((await api('GET', '/api/state')).notes.find((x) => x.id === n.id).text, 'one\ntwo');
  const views = await api('PUT', '/api/projects', { projects: [
    { id: 'p1', name: 'Work', noteId: n.id, layout: null },
    { id: 'p2', name: 'Box', host: 'box_2.lan:2222', user: 'me', dir: '/srv/app', hidden: true, layout: null },
    { id: 'p3', name: 'Evil', host: "box'; touch /tmp/x; '", user: 'me me' },
    { id: 'p4', name: 'Option', host: '-oProxyCommand=x' },
  ] });
  assert.deepEqual(views[0], { id: 'p1', name: 'Work', host: '', user: '', dir: '', hidden: false, noteId: n.id, wallId: null, layout: null });
  assert.deepEqual(views[1], { id: 'p2', name: 'Box', host: 'box_2.lan:2222', user: 'me', dir: '/srv/app', hidden: true, noteId: null, wallId: null, layout: null }, 'a name from an ssh config, with a port; its directory; closed');
  assert.equal(views[2].host, '', 'a host that is not one is dropped: it goes to ssh');
  assert.equal(views[2].user, '');
  assert.equal(views[3].host, '', 'and never one ssh would take for an option');
  await assert.rejects(api('POST', '/api/sessions', { templateId: 'shell', cwd: os.tmpdir(), vars: { host: '-oProxyCommand=touch /tmp/x' }, autostart: false }), /not a host/);
  await api('DELETE', `/api/notes/${n.id}`);
  await c.waitFor((m) => m.t === 'note-removed' && m.id === n.id);
  await assert.rejects(api('GET', `/api/notes/${n.id}`), /404/);
  c.ws.close();
});

test('files: printed paths resolve from a directory, text files read, others refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-files-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'plan.md'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
  const r = await api('POST', '/api/files/resolve', { cwd: dir, paths: ['sub/plan.md', `${dir}/blob.bin`, 'nope.md', 'sub'] });
  assert.deepEqual(r.paths, { 'sub/plan.md': path.join(dir, 'sub', 'plan.md'), [`${dir}/blob.bin`]: null, 'nope.md': null, sub: null }, 'binaries and directories are not links');
  const f = await api('GET', `/api/files?path=${encodeURIComponent('plan.md')}&dir=${encodeURIComponent(path.join(dir, 'sub'))}`);
  assert.equal(f.path, path.join(dir, 'sub', 'plan.md'));
  assert.equal(f.text, 'one\ntwo\n');
  assert.equal(f.truncated, false);
  await assert.rejects(api('GET', `/api/files?path=${encodeURIComponent(path.join(dir, 'blob.bin'))}`), /415/);
  await assert.rejects(api('GET', `/api/files?path=${encodeURIComponent(path.join(dir, 'nope.md'))}`), /404/);
  await assert.rejects(api('GET', `/api/files?path=x.md&host=${encodeURIComponent('box; rm -rf /')}`), /400.*bad host/);
  await assert.rejects(api('GET', '/api/files?path=x.md&host=belay-test.invalid'), /502/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('projects and settings round-trip', async () => {
  const v = await api('PUT', '/api/projects', { projects: [{ id: 'v1', name: 'Main', layout: { grid: {}, panels: {} } }], origin: 'me' });
  assert.equal(v[0].name, 'Main');
  const st = await api('GET', '/api/state');
  assert.equal(st.projects.length, 1);
  const s = await api('PUT', '/api/settings', { fontSize: '15', copyOnSelect: false, theme: 'bogus' });
  assert.equal(s.fontSize, 15);
  assert.equal(s.copyOnSelect, false);
  assert.equal(s.theme, 'dark');
});

test('directory listing helps the cwd picker', async () => {
  const d = await api('GET', `/api/fs/dirs?path=${encodeURIComponent('/us')}`);
  assert.equal(d.path, '/');
  assert.ok(d.dirs.includes('/usr'));
});

test('plain scrollback export strips escapes', async () => {
  const r = await fetch(`${base}/api/sessions/${sid}/scrollback?plain=1`);
  const text = await r.text();
  assert.ok(text.includes('hello-42'));
  assert.ok(!text.includes('\x1b['));
});

test('a session carries on while belay is not running, and belay follows on from where it was', async () => {
  const before = await api('GET', `/api/sessions/${sid}`);
  assert.equal(before.status, 'running');
  const c0 = await connect();
  c0.send({ t: 'attach', sid, cols: 90, rows: 25 });
  await c0.waitFor((m) => m.t === 'replay' && m.sid === sid);
  c0.send({ t: 'input', sid, data: 'echo before-$((1+1)); sleep 1; echo while-$((2+2))-away; echo after-$((3+3))\n' });
  await c0.waitFor((m) => m.t === 'data' && m.sid === sid && m.data.includes('before-2'));
  c0.ws.close();
  await stopServer(server);
  await sleep(1500);
  server = await startServer();
  const after = await waitFor(async () => { const x = await api('GET', `/api/sessions/${sid}`); return x.status === 'running' ? x : null; });
  assert.equal(after.pid, before.pid, 'the same process, not a new one');
  assert.equal(after.cwd, '/usr');
  const c = await connect();
  c.send({ t: 'attach', sid, cols: 90, rows: 25 });
  const text = async () => { const all = c.msgs.filter((m) => m.sid === sid && (m.t === 'replay' || m.t === 'data')).map((m) => m.data).join(''); return all; };
  await waitFor(async () => (await text()).includes('after-6'));
  const all = await text();
  assert.ok(all.includes('hello-42'), 'what was there before');
  assert.equal(all.split('while-4-away').length, 2, 'what it wrote while belay was away, once');
  assert.equal(all.split('before-2').length, 2, 'and nothing twice');
  assert.ok(!all.includes('ended while belay was away'), 'it never ended');
  c.send({ t: 'input', sid, data: 'echo still-$((4+4))\n' });
  await c.waitFor((m) => m.t === 'data' && m.sid === sid && m.data.includes('still-8'));
  c.ws.close();
  await api('DELETE', `/api/sessions/${sid}`);
});

test('a session whose holder is gone (the machine restarted) is started again', async () => {
  const s = await api('POST', '/api/sessions', { templateId: 'shell', name: 'rebooted', cwd: os.tmpdir() });
  await stopServer(server);
  await stopHolder(holdDir);
  server = await startServer();
  const again = await waitFor(async () => { const x = await api('GET', `/api/sessions/${s.id}`); return x.status === 'running' && x.pid !== s.pid ? x : null; });
  assert.ok(again.pid > 0);
  const plain = await (await fetch(`${base}/api/sessions/${s.id}/scrollback?plain=1`)).text();
  assert.match(plain, /the session ended while belay was away/);
  await api('DELETE', `/api/sessions/${s.id}`);
});

test('a session can be starred, and the star is kept', async () => {
  const s = await api('POST', '/api/sessions', { templateId: 'shell', name: 'star me', cwd: os.tmpdir(), autostart: false });
  assert.equal(s.starred, undefined);
  assert.equal((await api('PATCH', `/api/sessions/${s.id}`, { starred: true })).starred, true);
  assert.equal((await api('GET', `/api/sessions/${s.id}`)).starred, true);
  assert.equal((await api('PATCH', `/api/sessions/${s.id}`, { starred: false })).starred, false);
  await api('DELETE', `/api/sessions/${s.id}`);
});

test('a session remembers the project it was in', async () => {
  const s = await api('POST', '/api/sessions', { templateId: 'shell', name: 'remember me', cwd: os.tmpdir(), autostart: false });
  assert.equal((await api('PATCH', `/api/sessions/${s.id}`, { project: 'abc123' })).project, 'abc123');
  assert.equal((await api('PATCH', `/api/sessions/${s.id}`, { project: 'no spaces allowed' })).project, null);
  await api('DELETE', `/api/sessions/${s.id}`);
});

test("an agent's idle and working times are its conversation's, and survive a restart", async () => {
  const s = await api('POST', '/api/sessions', { templateId: 'shell', name: 'turns', cwd: os.tmpdir() });
  const hook = (ev, conv = 'conv-1') => api('POST', `/api/hook/claude?belay=${s.id}`, { hook_event_name: ev, session_id: conv });
  const activity = async () => (await api('GET', `/api/sessions/${s.id}`)).activity;
  await hook('UserPromptSubmit');
  const t0 = (await activity()).since;
  await sleep(1100);
  await hook('PermissionRequest');
  assert.equal((await activity()).state, 'attention');
  await hook('PostToolUse');
  assert.deepEqual([(await activity()).state, (await activity()).since], ['busy', t0], 'working since the prompt, through the pause for permission');
  await sleep(1100);
  await hook('Stop');
  const t1 = (await activity()).since;
  assert.ok(t1 > t0);
  await hook('Notification');
  await sleep(1100);
  await hook('Stop');
  assert.equal((await activity()).since, t1, 'another idle report does not start the count again');

  await stopServer(server);
  server = await startServer();
  const back = await waitFor(async () => { const x = await api('GET', `/api/sessions/${s.id}`); return x.status === 'running' ? x : null; });
  assert.deepEqual([back.activity?.state, back.activity?.since], ['idle', t1], 'after a restart, it is still idle since its last turn ended');
  await hook('SessionStart');
  assert.equal((await activity()).since, t1, 'the resumed conversation reporting in changes nothing');
  await hook('SessionStart', 'conv-2');
  assert.ok((await activity()).since > t1, 'a new conversation is idle from now');

  await hook('UserPromptSubmit', 'conv-2');
  const t2 = (await activity()).since;
  await stopServer(server);
  server = await startServer();
  const held = await waitFor(async () => { const x = await api('GET', `/api/sessions/${s.id}`); return x.status === 'running' ? x : null; });
  assert.deepEqual([held.activity?.state, held.activity?.since], ['busy', t2], 'held through the restart, the agent is still working on its turn');
  await hook('Stop', 'conv-2');
  assert.equal((await activity()).state, 'idle');
  await api('DELETE', `/api/sessions/${s.id}`);
});

test('post-it walls keep only what a note is made of', async () => {
  const w = await api('POST', '/api/walls', { title: 'Board' });
  assert.deepEqual(w.items, []);
  const saved = await api('PUT', `/api/walls/${w.id}`, { items: [
    { id: 'a', text: 'Group', x: 10.4, y: -20, w: 400, h: 300, color: '#bbf7d0', fontColor: '#1f2328', junk: 'dropped' },
    { id: 'a', text: 'same id again', x: 20, y: 20, w: 5, h: 5, color: 'red; background:url(x)', fontColor: null },
  ] });
  assert.deepEqual(saved.items[0], { id: 'a', text: 'Group', x: 10, y: -20, w: 400, h: 300, color: '#bbf7d0', fontColor: '#1f2328' });
  assert.notEqual(saved.items[1].id, 'a', 'ids stay unique');
  assert.deepEqual([saved.items[1].w, saved.items[1].h, saved.items[1].color], [40, 30, null], 'sizes have a floor, colors must be colors');
  assert.equal((await api('GET', '/api/state')).walls.find((x) => x.id === w.id).items.length, 2);
  await api('DELETE', `/api/walls/${w.id}`);
  await assert.rejects(api('GET', `/api/walls/${w.id}`), /404/);
});

test('media for viewer tabs: bytes with ranges, only media types, SVG locked down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-media-'));
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  fs.writeFileSync(path.join(dir, 'clip.mp4'), bytes);
  fs.writeFileSync(path.join(dir, 'doc.pdf'), '%PDF-1.4\n%fake\n');
  fs.writeFileSync(path.join(dir, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(dir, 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(dir, 'pdf'), 'no extension');
  const raw = (name, headers = {}) => fetch(`${base}/api/files/raw?path=${encodeURIComponent(path.join(dir, name))}`, { headers });
  const full = await raw('clip.mp4');
  assert.equal(full.status, 200);
  assert.deepEqual([full.headers.get('content-type'), full.headers.get('content-length'), full.headers.get('accept-ranges'), full.headers.get('x-content-type-options')], ['video/mp4', '256', 'bytes', 'nosniff']);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const part = await raw('clip.mp4', { range: 'bytes=10-19' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/256');
  assert.deepEqual([...Buffer.from(await part.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const tail = await raw('clip.mp4', { range: 'bytes=-6' });
  assert.deepEqual([...Buffer.from(await tail.arrayBuffer())], [250, 251, 252, 253, 254, 255]);
  const open = await raw('clip.mp4', { range: 'bytes=250-' });
  assert.equal(open.headers.get('content-range'), 'bytes 250-255/256');
  assert.equal((await raw('clip.mp4', { range: 'bytes=999-' })).status, 416);
  assert.equal((await raw('doc.pdf')).headers.get('content-type'), 'application/pdf');
  const svg = await raw('pic.svg');
  assert.match(svg.headers.get('content-security-policy'), /^sandbox; default-src 'none'/, 'an SVG opened on its own runs nothing');
  assert.equal((await raw('page.html')).status, 415, 'only media types are served');
  assert.equal((await raw('pdf')).status, 415, 'a name without an extension is not a PDF');
  assert.equal((await raw('missing.png')).status, 404);
  const st = await api('GET', `/api/files/stat?path=${encodeURIComponent(path.join(dir, 'clip.mp4'))}`);
  assert.equal(st.size, 256);
  assert.ok(st.mtime > 0);
  const r = await api('POST', '/api/files/resolve', { cwd: dir, paths: ['clip.mp4', 'doc.pdf'] });
  assert.deepEqual(Object.values(r.paths).map((p) => p && path.basename(p)), ['clip.mp4', 'doc.pdf'], 'media are links in terminals too');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('open in VS Code: the setting is a host name or local, nothing else', async () => {
  assert.equal((await api('PUT', '/api/settings', { vscodeHost: 'devbox' })).vscodeHost, 'devbox');
  assert.equal((await api('PUT', '/api/settings', { vscodeHost: 'x/../evil?y' })).vscodeHost, '');
  await api('PUT', '/api/settings', { vscodeHost: '' });
});
