import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalRequest } from '../server/util.js';

test('hook requests are accepted from this machine only', () => {
  const req = (remoteAddress, localAddress = '127.0.0.1') => ({ socket: { remoteAddress, localAddress } });
  assert.ok(isLocalRequest(req('127.0.0.1')));
  assert.ok(isLocalRequest(req('::1', '::1')));
  assert.ok(isLocalRequest(req('::ffff:127.0.0.1', '::ffff:127.0.0.1')));
  assert.ok(isLocalRequest(req('192.168.1.5', '192.168.1.5')), 'server bound to a LAN address, posted to from the same box');
  assert.ok(!isLocalRequest(req('192.168.1.9', '192.168.1.5')), 'another machine on the LAN');
  assert.ok(!isLocalRequest(req(undefined, undefined)));
});

test('built-in templates added later reach existing state once; deleted ones stay deleted', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Store } = await import('../server/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-store-'));
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, seededTemplates: ['shell', 'claude', 'command'], sessions: [], views: [], templates: [] }));
    const ids = () => new Store(dir).load().templates.map((t) => t.id);
    assert.deepEqual(ids(), ['codex', 'opencode'], 'the ones not yet seeded arrive; the deleted ones stay deleted');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    st.templates = st.templates.filter((t) => t.id !== 'codex');
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    assert.deepEqual(ids(), ['opencode'], 'deleting a newly added one sticks too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('editor font size: 0 follows the terminals, anything else is kept within bounds', async () => {
  const { coerceSettings, DEFAULT_SETTINGS } = await import('../server/store.js');
  assert.equal(DEFAULT_SETTINGS.editorFontSize, 0);
  assert.equal(coerceSettings({ editorFontSize: 15 }, DEFAULT_SETTINGS).editorFontSize, 15);
  assert.equal(coerceSettings({ editorFontSize: 2 }, DEFAULT_SETTINGS).editorFontSize, 6);
  assert.equal(coerceSettings({ editorFontSize: 99 }, DEFAULT_SETTINGS).editorFontSize, 40);
  assert.equal(coerceSettings({ editorFontSize: 0 }, { ...DEFAULT_SETTINGS, editorFontSize: 20 }).editorFontSize, 0);
});

test('post-its: the four states, and text that reads on any note color', async () => {
  const { PALETTE, readableOn } = await import('../web/wall.js');
  assert.deepEqual(PALETTE, [['#ffff88', '#000000'], ['#aaaaaa', '#888888'], ['#55cc55', '#000000'], ['#ff6644', '#000000']]);
  assert.deepEqual([readableOn('#ffff88'), readableOn('#123456')], ['#000000', '#ffffff']);
});

test('files sidebar: the directory above', async () => {
  const { parentDir } = await import('../web/files.js');
  assert.deepEqual(['/a/b/c', '/a/b/', '/a', '/', '~/x'].map(parentDir), ['/a/b', '/a', '/', null, null]);
});

test('open in VS Code: a vscode:// link naming the remote exactly as VS Code does', async () => {
  const { vscodeUrl } = await import('../web/vscode.js');
  assert.equal(vscodeUrl({ path: '/home/me/app/README.md', line: 5 }, 'devbox'), 'vscode://vscode-remote/ssh-remote+devbox/home/me/app/README.md:5');
  assert.equal(vscodeUrl({ path: '/tmp/a b.js' }, 'devbox'), 'vscode://vscode-remote/ssh-remote+devbox/tmp/a%20b.js:1', 'always a line: without one VS Code replaces the window');
  assert.equal(vscodeUrl({ path: '/tmp/x.js', line: 2 }, 'local'), 'vscode://file/tmp/x.js:2', "local: VS Code's own computer");
  assert.equal(vscodeUrl({ path: 'src/x.js', host: 'box', user: 'me', dir: '/srv/app' }, 'devbox'), 'vscode://vscode-remote/ssh-remote+box/srv/app/src/x.js:1', "a project host's file goes to that host");
  assert.equal(vscodeUrl({ path: '~/x.js', host: 'box' }, ''), null, 'a host needs the full path');
});

test('a file read while it is being saved over is what is there, never padded with zeros', async () => {
  const fs = await import('node:fs');
  const fsp = (await import('node:fs/promises')).default;
  const os = await import('node:os');
  const path = await import('node:path');
  const { readTextFile } = await import('../server/files.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-read-'));
  const file = path.join(dir, 'plan.md');
  fs.writeFileSync(file, 'a much longer text, from before the save\n');
  // The save lands between the size check and the read: the file is shorter than the size seen.
  const stat = fsp.stat;
  fsp.stat = async (p) => { const st = await stat(p); fs.writeFileSync(file, 'short\n'); return st; };
  try {
    const r = await readTextFile({ path: file });
    assert.equal(r.text, 'short\n');
    assert.equal(r.size, 6);
  } finally { fsp.stat = stat; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ssh destinations: a name, a port, a user, and nothing ssh would take for an option', async () => {
  const { sshDest, parseTarget, sshOpts } = await import('../shared/ssh.js');
  assert.deepEqual(sshDest('box'), ['box']);
  assert.deepEqual(sshDest('my_box'), ['my_box'], 'names from an ssh config can have underscores');
  assert.deepEqual(sshDest('me@box:2222'), ['-p', '2222', 'me@box']);
  assert.deepEqual(sshDest('[fe80::1]:22'), ['-p', '22', 'fe80::1']);
  for (const bad of ['-oProxyCommand=x', 'box name', 'me@-x', 'box:99999', '', 'a;b']) assert.equal(parseTarget(bad), null, bad);
  assert.throws(() => sshDest('-v'));
  const o = sshOpts({ forwards: false }).join(' ');
  assert.match(o, /RemoteCommand=none/);
  assert.match(o, /ClearAllForwardings=yes/);
});

test('your ssh config, read as ssh reads it: Host patterns in order, the first value winning', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-sshcfg-'));
  fs.writeFileSync(path.join(dir, 'more'), 'Host gpu\n  HostName gpu.lan\n');
  fs.writeFileSync(path.join(dir, 'config'), [
    '# mine', `Include ${dir}/more`, 'Host box my_box', '  HostName 10.0.0.5', '  Port 2222', '  User root',
    'Host *.prod !bastion.prod', '  User admin', 'Match host x', '  User nobody', 'Host *', '  User me', ''].join('\n'));
  process.env.BELAY_SSH_CONFIG = path.join(dir, 'config');
  try {
    const { configHosts, configUser, effectiveTarget, sshArgs } = await import('../server/ssh.js');
    assert.deepEqual(configHosts().map((h) => h.name), ['gpu', 'box', 'my_box']);
    assert.deepEqual(configHosts()[1], { name: 'box', hostname: '10.0.0.5', user: 'root', port: 2222 });
    assert.equal(configUser('web.prod'), 'admin');
    assert.equal(configUser('bastion.prod'), 'me', 'a negated pattern leaves it to the next block');
    assert.equal(effectiveTarget('someone@box'), 'box', "the config's User, not the project's");
    assert.match(sshArgs('someone@box:2200').join(' '), /-p 2200 box$/);
  } finally {
    delete process.env.BELAY_SSH_CONFIG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
