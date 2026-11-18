import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockDataDir } from '../server/lock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-lock-'));

test('a second lock on the same data dir is refused until the first is released', async () => {
  const dir = tmp();
  const first = await lockDataDir(dir);
  await assert.rejects(lockDataDir(dir), /another belay is already running/);
  await new Promise((r) => first.close(r));
  const again = await lockDataDir(dir);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lock left behind by a killed belay is taken over', async () => {
  const dir = tmp();
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import { lockDataDir } from ${JSON.stringify(path.join(root, 'server/lock.js'))};
     const l = await lockDataDir(${JSON.stringify(dir)}); l.ref(); console.log('locked');`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => holder.stdout.once('data', r));
  holder.kill('SIGKILL');
  await new Promise((r) => holder.once('exit', r));
  assert.ok(fs.existsSync(path.join(dir, 'belay.sock')), 'the socket file outlives the killed process');
  const lock = await lockDataDir(dir);
  lock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a second server on the same data dir exits without touching the sessions', async () => {
  const dir = tmp();
  const run = (port) => spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, BELAY_TOKEN: '', BELAY_PORT: String(port), BELAY_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const a = run(port);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  const b = run(port + 1);
  let out = '';
  b.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => b.once('exit', r));
  assert.equal(code, 1);
  assert.match(out, /another belay is already running/);
  assert.ok((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, 'the first server keeps running');
  await new Promise((r) => { a.once('exit', r); a.kill('SIGTERM'); });
  fs.rmSync(dir, { recursive: true, force: true });
});
