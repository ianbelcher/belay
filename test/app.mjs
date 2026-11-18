// The Belay app itself, end to end: it starts its server, opens a shell, quits, and the shell is still there
// when it starts again, the same process with what it printed. Run under a display (xvfb-run on a server).
// Needs Playwright (BELAY_PLAYWRIGHT can point at a copy).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stopHolder } from './holder.js';

let _electron;
try { ({ _electron } = await import(process.env.BELAY_PLAYWRIGHT || 'playwright')); }
catch { console.log('playwright not installed; run: npm i -D playwright'); process.exit(1); }

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-app-'));
const step = (s) => console.log(`• ${s}`);
// BELAY_APP is a packaged app's executable to test instead of this checkout. Chromium will not run
// sandboxed as root (a container); everywhere else the sandbox stays on.
const packaged = process.env.BELAY_APP;
const args = [...(packaged ? [] : [root]), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])];
const env = { ...process.env, BELAY_DATA_DIR: dataDir };
delete env.BELAY_PORT;

async function launch() {
  // The project's own Electron (the electron package's main is the path to its binary).
  const executablePath = packaged || createRequire(path.join(root, 'package.json'))('electron');
  const app = await _electron.launch({ executablePath, args, env, cwd: root, timeout: 60000 });
  const win = await app.firstWindow();
  await win.waitForSelector('.watermark, .tp', { timeout: 30000 });
  return { app, win };
}
const sessions = (win) => win.evaluate(() => fetch('/api/sessions').then((r) => r.json()));
const textOf = (win, sid) => win.evaluate((id) => {
  const p = window.belay.panels.get(`p-${id}`);
  const b = p?.term?.buffer.active;
  if (!b) return '';
  let t = '';
  for (let y = 0; y < b.length; y++) t += `${b.getLine(y)?.translateToString(true) ?? ''}\n`;
  return t;
}, sid);
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('timed out waiting');
}

let app;
try {
  step('the app starts its server and opens on it, signed in');
  ({ app } = await launch());
  let { win } = { win: await app.firstWindow() };
  assert.equal(await win.evaluate(() => !!window.belayApp), true, 'the page knows it is in the app');
  assert.equal(await win.isVisible('#btn-install'), false, 'no "Install as app" in the app');
  // Its port, chosen once (7681 when it is free) and kept, so sessions on hosts can always report back.
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'app.json'), 'utf8'));
  const port = settings.port;
  assert.ok(port > 0);
  assert.match(win.url(), new RegExp(`^http://127\\.0\\.0\\.1:${port}/`));
  assert.ok(settings.token.length >= 24, 'a token of its own');
  const out = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(out.status, 401, 'other programs here are kept out');

  step("the menu leaves belay's keys to belay");
  const accels = await app.evaluate(({ Menu }) => {
    const all = [];
    const walk = (m) => m?.items.forEach((i) => { if (i.accelerator) all.push(i.accelerator); if (i.role) all.push(`role:${i.role}`); walk(i.submenu); });
    walk(Menu.getApplicationMenu());
    return all;
  });
  for (const k of ['CmdOrCtrl+W', 'CommandOrControl+W', 'CmdOrCtrl+T', 'CmdOrCtrl+N', 'role:close', 'role:windowMenu', 'role:fileMenu']) assert.ok(!accels.includes(k), `${k} is not the menu's`);
  assert.ok(accels.includes('role:copy') && accels.includes('role:paste'), 'copy and paste are, for text fields');

  step('a shell, typed into');
  await win.click('.watermark button:text-is("Shell")');
  const s = await until(async () => (await sessions(win)).find((x) => x.status === 'running'));
  await win.waitForFunction((id) => window.belay.panels.get(`p-${id}`)?.attached, s.id);
  await win.waitForTimeout(300);
  await win.keyboard.type('echo app-$((20+22)) && cd /usr\n');
  await until(async () => (await textOf(win, s.id)).includes('app-42'));

  step('links to elsewhere open in their own apps, not in the window');
  await app.evaluate(({ shell }) => { globalThis.opened = []; shell.openExternal = async (u) => { globalThis.opened.push(u); }; });
  await win.evaluate(() => { window.open('https://example.com/docs', '_blank'); });
  await win.evaluate(() => { window.location.href = 'vscode://file/tmp/x.js:1'; });
  await until(async () => (await app.evaluate(() => globalThis.opened)).length === 2);
  assert.deepEqual(await app.evaluate(() => globalThis.opened), ['https://example.com/docs', 'vscode://file/tmp/x.js:1']);
  assert.equal(app.windows().length, 1, 'no window for the web page');
  assert.match(win.url(), new RegExp(`^http://127\\.0\\.0\\.1:${port}/`), 'and the window stays on belay');

  step('a link a program marks as one (OSC 8, as Claude prints them) opens in the browser, with no question first');
  const dialogs = [];
  win.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await win.evaluate((id) => window.belay.panels.get(`p-${id}`).focus(), s.id);
  await win.keyboard.type("printf '\\033]8;;https://example.com/osc8\\033\\\\click-this-link\\033]8;;\\033\\\\\\n'\n");
  await until(async () => (await textOf(win, s.id)).split('\n').some((l) => l.startsWith('click-this-link')));
  const at = await win.evaluate((id) => {
    const p = window.belay.panels.get(`p-${id}`);
    const b = p.term.buffer.active;
    for (let y = b.length - 1; y >= 0; y--) {
      const line = b.getLine(y)?.translateToString(true) || '';
      if (!line.startsWith('click-this-link')) continue;
      const r = p.element.querySelector('.xterm-screen').getBoundingClientRect();
      return { x: r.left + 4.5 * (r.width / p.term.cols), y: r.top + (y - b.viewportY + 0.5) * (r.height / p.term.rows) };
    }
    return null;
  }, s.id);
  assert.ok(at, 'the link is on screen');
  await win.mouse.move(at.x - 20, at.y);
  await win.mouse.move(at.x, at.y, { steps: 3 });
  await win.mouse.click(at.x, at.y);
  await until(async () => (await app.evaluate(() => globalThis.opened)).includes('https://example.com/osc8'));
  assert.deepEqual(dialogs, [], 'no "do you want to open" question');
  assert.equal(app.windows().length, 1, 'and no empty window left behind');

  step('quit: the shell carries on without the app');
  await app.close();
  app = null;
  await new Promise((r) => setTimeout(r, 500));
  process.kill(s.pid, 0); // still running, or this throws

  step('started again: the same shell, where it was, with what it printed');
  ({ app, win } = await launch());
  const back = await until(async () => (await sessions(win)).find((x) => x.id === s.id && x.status === 'running'));
  assert.equal(back.pid, s.pid, 'the same process');
  await win.waitForFunction((id) => window.belay.panels.get(`p-${id}`)?.attached, s.id, { timeout: 20000 });
  await until(async () => (await textOf(win, s.id)).includes('app-42'));
  await win.waitForTimeout(300);
  await win.keyboard.type('echo "back-in-$(pwd)"\n');
  await until(async () => (await textOf(win, s.id)).includes('back-in-/usr'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'app.json'), 'utf8')).port, port, 'on the port it had');
  console.log('\nApp test passed');
} catch (e) {
  console.error('\nApp test FAILED:', e.message, (e.stack || '').split('\n').find((l) => l.includes('app.mjs')) || '');
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  await stopHolder(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
