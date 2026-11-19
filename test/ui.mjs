// Browser test: drives the real UI in headless Chromium against a throwaway server.
// Needs Playwright, which is not a dependency of belay:
//   npm i -D playwright && npx playwright install chromium && npm run test:ui [screenshot-dir]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { stopHolder } from './holder.js';

let chromium;
try { ({ chromium } = await import(process.env.BELAY_PLAYWRIGHT || 'playwright')); }
catch { console.log('playwright not installed; run: npm i -D playwright && npx playwright install chromium'); process.exit(1); }

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-ui-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An ssh config of its own (empty), so that this machine's has no say in what the forms show.
fs.writeFileSync(path.join(dataDir, 'ssh_config'), '');
const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, BELAY_TOKEN: '', BELAY_PORT: String(port), BELAY_DATA_DIR: dataDir, BELAY_SSH_CONFIG: path.join(dataDir, 'ssh_config') }, stdio: ['ignore', 'ignore', 'inherit'] });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(50); }

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
// Errors the browser logs for answers the test asks for: a save refused as a conflict (409), a file that is
// not there yet (404), and the test page's own autofocus, which Chrome refuses in a frame.
const expected = (m) => {
  const t = m.text(), url = m.location()?.url || '';
  return (/status of 409 \(Conflict\)/.test(t) && url.includes('/api/files')) || (/status of 404 \(Not Found\)/.test(t) && url.includes('/api/files?'))
    || /Blocked autofocusing on a <input> element in a cross-origin subframe/.test(t)
    // The same refusal, as newer Chrome words it.
    || (/focus-without-user-activation is not allowed/.test(t) && url.endsWith('/hello'))
    // The directory field of the project on a host that cannot be reached, browsing there: it says so in its list.
    || (/status of 502/.test(t) && url.includes('/api/fs/entries') && url.includes('host=belay-test.invalid'));
};
page.on('console', (m) => { if (m.type() === 'error' && !expected(m)) errors.push(`[console.error] ${m.text()} ${m.location()?.url || ''}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 14).join('\n')}`));
const shot = (name) => (shots ? page.screenshot({ path: path.join(shots, `${name}.png`) }) : Promise.resolve());
const bufferHas = (text) => page.evaluate((text) => [...window.belay.panels.values()].some((p) => { const b = p.term?.buffer.active; if (!b) return false; for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString().includes(text)) return true; return false; }), text);
const step = (s) => console.log(`• ${s}`);
// Records what the terminals send to the server.
const spyInput = (p) => p.evaluate(() => { const c = window.belay.client, send = c.send.bind(c); window.sent = []; c.send = (m) => { if (m.t === 'input') window.sent.push(m.data); send(m); }; });
const takeSent = (p) => p.evaluate(() => window.sent.splice(0));

try {
  step('empty view shows watermark');
  await page.goto(BASE);
  await page.waitForSelector('.watermark');
  await shot('01-empty');

  step('new-session dialog derives fields and previews the command');
  await page.keyboard.press('Control+Shift+Backquote');
  await page.waitForSelector('.modal');
  // One template per thing to run (no local and remote pairs): the host is where, not which template.
  assert.deepEqual(await page.$$eval('.modal select >> nth=0', (s) => [...s[0].options].map((o) => o.value)), ['shell', 'claude', 'codex', 'opencode', 'command']);
  await page.selectOption('.modal select', 'claude');
  assert.deepEqual(await page.$$eval('.modal .tpl-fields .field-label', (o) => o.map((x) => x.textContent)), ['session']);
  assert.equal(await page.textContent('.modal .preview'), 'sh "$BELAY_HOME/scripts/provision-claude.sh"\nclaude');
  // Where is the project's: no host or directory of its own, and nothing said in their place.
  assert.equal(await page.$('.modal input[data-var="host"], .modal input[data-var="dir"], .modal .session-where'), null);
  const fresh = await page.inputValue('.modal input[placeholder="Name"]');
  assert.match(fresh, /^[a-z]+-[a-z]+$/, 'a name like sly-fox');
  // Typing a name over the default: emptied on the way, it stays empty until you leave the field.
  await page.fill('.modal input[placeholder="Name"]', '');
  await page.press('.modal input[placeholder="Name"]', 'Backspace');
  assert.equal(await page.inputValue('.modal input[placeholder="Name"]'), '', 'no default while you are typing');
  await page.type('.modal input[placeholder="Name"]', 'my claude');
  assert.equal(await page.inputValue('.modal input[placeholder="Name"]'), 'my claude');
  await page.fill('.modal input[placeholder="Name"]', '');
  await page.click('.modal .preview');
  assert.equal(await page.inputValue('.modal input[placeholder="Name"]'), fresh, 'left empty, the default comes back');
  await page.selectOption('.modal select', 'shell');
  await page.fill('.modal input[placeholder="Name"]', 'alpha');
  await shot('02-dialog');
  await page.click('.modal .btn.primary:has-text("Create")');
  await page.waitForFunction(() => window.belay.panels.size === 1 && [...window.belay.panels.values()][0].attached, null, { timeout: 10000 });

  step('typing reaches the shell and output renders');
  await sleep(500);
  await page.keyboard.type('echo UI-OK-$((1+1))\n');
  await page.waitForFunction(() => { const b = [...window.belay.panels.values()][0].term.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString().includes('UI-OK-2')) return true; return false; }, null, { timeout: 8000 });
  assert.equal(await page.getAttribute('.tp-dot', 'data-status'), 'running');

  step('second session opens as a tab in the same group');
  await page.keyboard.press('Control+Shift+Backquote');
  await page.fill('.modal input[placeholder="Name"]', 'beta');
  await page.dblclick('.modal .btn.primary:has-text("Create")');
  await page.waitForFunction(() => window.belay.panels.size === 2);
  await sleep(400);
  assert.equal((await (await fetch(`${BASE}/api/sessions`)).json()).length, 2, 'a double-click on Create makes one session');
  assert.equal(await page.evaluate(() => window.belay.dock.api.groups.length), 1);
  assert.deepEqual(await page.$$eval('.ttab-name', (t) => t.map((x) => x.textContent)), ['alpha', 'beta']);
  await shot('03-tabs');

  step('Ctrl+Tab cycles the tabs in the view');
  const activeName = () => page.evaluate(() => window.belay.client.session(window.belay.dock.api.activePanel.params.sessionId)?.name);
  assert.equal(await activeName(), 'beta');
  await page.keyboard.press('Control+Tab');
  await page.waitForFunction(() => document.activeElement?.closest('.tp') === document.querySelector('.tp'));
  assert.equal(await activeName(), 'alpha');
  await page.keyboard.press('Control+Tab');
  assert.equal(await activeName(), 'beta');
  await page.keyboard.press('Control+Shift+Tab');
  assert.equal(await activeName(), 'alpha');
  assert.equal(await page.$$eval('.vtab', (t) => t.length), 1, 'views unchanged');
  await page.keyboard.press('Control+Shift+Tab');
  assert.equal(await activeName(), 'beta');

  step('the sessions sidebar: "Split right here" makes a second group');
  // The sidebar lists agent sessions: alpha becomes one once Claude's hooks report from it.
  const alphaSid = await page.evaluate(() => [...window.belay.client.state.sessions.values()].find((s) => s.name === 'alpha').id);
  await fetch(`${BASE}/api/hook/claude?belay=${alphaSid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'a', hook_event_name: 'Stop' }) });
  await page.click('.rail-btn[data-side="sessions"]');
  await page.waitForSelector('#side .srow:has(.srow-name:text-is("alpha"))');
  assert.deepEqual(await page.$$eval('#side .srow .srow-name', (r) => r.map((x) => x.textContent)), ['alpha'], 'agent sessions only: beta is a plain shell');
  assert.equal(await page.$('#side .side-head .btn:text-is("+")'), null, 'new sessions start from their project, not here');
  await page.click('#side .srow:has(.srow-name:text-is("alpha"))', { button: 'right' });
  await page.click('.menu-item:has-text("Split right here")');
  await sleep(400);
  assert.equal(await page.evaluate(() => window.belay.dock.api.groups.length), 2);
  await page.click('.rail-btn[data-side="sessions"]');
  await shot('03-split');

  step('hook activity shows on the tab');
  const alphaId = await page.evaluate(() => [...window.belay.client.state.sessions.values()].find((s) => s.name === 'alpha').id);
  await fetch(`${BASE}/api/hook/claude?belay=${alphaId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'x', hook_event_name: 'UserPromptSubmit' }) });
  await page.waitForSelector('.ttab-dot.busy');
  await fetch(`${BASE}/api/hook/claude?belay=${alphaId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'x', hook_event_name: 'Notification', notification_type: 'permission_prompt' }) });
  await page.waitForSelector('.ttab-dot.attention');
  assert.equal(await page.getAttribute('.ttab-dot.attention', 'title'), 'Claude needs your input');
  await shot('03b-attention');
  await fetch(`${BASE}/api/hook/codex?belay=${alphaId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'x', hook_event_name: 'UserPromptSubmit' }) });
  await page.waitForFunction(() => document.querySelector('.ttab-dot.busy')?.title === 'Codex is working');

  step('Shift+Enter is a newline while Claude runs and Enter in a plain shell');
  await spyInput(page);
  await page.evaluate((sid) => window.belay.panels.get(`p-${sid}`).focus(), alphaId);
  await page.keyboard.press('Shift+Enter');
  assert.deepEqual(await takeSent(page), ['\x1b\r']);
  await fetch(`${BASE}/api/hook/claude?belay=${alphaId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'x', hook_event_name: 'SessionEnd' }) });
  await page.waitForFunction(() => !document.querySelector('.ttab-dot.attention, .ttab-dot.busy'));
  await page.keyboard.press('Shift+Enter');
  assert.deepEqual(await takeSent(page), ['\r']);
  await page.keyboard.press('Meta+ArrowLeft');
  assert.deepEqual(await takeSent(page), [], 'Cmd+arrows are only remapped on macOS');

  step('maximize and restore');
  await page.click('.tp >> nth=0 >> .tp-btn[data-act="max"]');
  await sleep(200);
  assert.equal(await page.evaluate(() => window.belay.dock.api.hasMaximizedGroup()), true);
  await shot('04-max');
  await page.keyboard.press('Control+Shift+Enter');
  await sleep(200);
  assert.equal(await page.evaluate(() => window.belay.dock.api.hasMaximizedGroup()), false);

  step('a group hides its tab bar from the tab menu, keeps it hidden in the layout, and its pane brings it back');
  const bar0 = () => page.evaluate(() => { const g = window.belay.dock.api.groups[0]; const p = window.belay.panels.get(g.activePanel.id); return { hidden: !!g.header.hidden, shown: g.header.element.offsetParent !== null, rows: p.term.rows, button: getComputedStyle(p.element.querySelector('.tp-btn[data-act="tabs"]')).display }; });
  const withBar = await bar0();
  assert.deepEqual([withBar.hidden, withBar.shown, withBar.button], [false, true, 'none']);
  const tab0 = await page.evaluate(() => window.belay.dock.api.groups[0].activePanel.id);
  await page.evaluate((id) => window.belay.dock.api.getPanel(id).view.tab.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 60 })), tab0);
  await page.click('.menu-item:has-text("Hide tab bar")');
  await page.waitForFunction(() => window.belay.dock.api.groups[0].header.hidden);
  await page.waitForFunction((rows) => { const g = window.belay.dock.api.groups[0]; return window.belay.panels.get(g.activePanel.id).term.rows > rows; }, withBar.rows);
  const noBar = await bar0();
  assert.deepEqual([noBar.shown, noBar.button !== 'none'], [false, true], 'the tab bar is gone, the terminal takes its room, and the pane offers it back');
  await page.mouse.move(1300, 700); // off the strip, which brightens under the pointer
  await page.waitForFunction(() => getComputedStyle(window.belay.panels.get(window.belay.dock.api.groups[0].activePanel.id).element.querySelector('.tp-bar')).opacity === '0.3');
  const fadedBar = await page.evaluate(() => { const g = window.belay.dock.api.groups[0]; const bar = window.belay.panels.get(g.activePanel.id).element.querySelector('.tp-bar'); return { height: bar.getBoundingClientRect().height, opacity: getComputedStyle(bar).opacity, shown: [...bar.children].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.dataset.act || c.className) }; });
  assert.deepEqual([fadedBar.height, fadedBar.opacity, fadedBar.shown], [14, '0.3', ['tabs']], "the pane's own bar is a faint strip with only the button that brings the tab bar back");
  await shot('04b-no-tab-bar');
  const saved = async () => (await (await fetch(`${BASE}/api/state`)).json()).projects.some((v) => JSON.stringify(v.layout).includes('"hideHeader":true'));
  for (let i = 0; i < 50 && !(await saved()); i++) await sleep(100);
  assert.equal(await saved(), true, 'the layout keeps it');

  step('command palette creates a project; Ctrl+1 switches back');
  await page.keyboard.press('Control+Shift+P');
  await page.waitForFunction(() => document.activeElement?.classList.contains('pal-input'));
  await page.keyboard.type('new project');
  try { await page.waitForFunction(() => document.querySelector('.pal-item.active')?.textContent.startsWith('New project'), null, { timeout: 4000 }); }
  catch (e) { console.log('palette state:', JSON.stringify(await page.evaluate(() => ({ active: document.activeElement?.className, input: document.querySelector('.pal-input')?.value, items: [...document.querySelectorAll('.pal-item')].slice(0, 5).map((x) => x.textContent), modals: document.querySelectorAll('.modal').length })))); throw e; }
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal-head h3:text-is("New project")');
  await page.keyboard.type('Second');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.watermark');
  assert.deepEqual(await page.$$eval('.vtab-name', (t) => t.map((x) => x.textContent)), ['Main', 'Second']);
  await page.keyboard.press('Control+1');
  try { await page.waitForFunction(() => window.belay.panels.size === 2, null, { timeout: 4000 }); }
  catch (e) { console.log('dock state:', JSON.stringify(await page.evaluate(() => ({ panels: window.belay.panels.size, views: window.belay.dock.views.map((v) => [v.name, JSON.stringify(v.layout)?.length]), active: window.belay.dock.activeViewId, groups: window.belay.dock.api.groups.length })))); throw e; }
  await sleep(500);
  assert.equal(await bufferHas('UI-OK-2'), true);

  step('reload restores layout and scrollback');
  await page.reload();
  await page.waitForFunction(() => window.belay?.panels?.size === 2, null, { timeout: 10000 });
  await sleep(700);
  assert.equal(await bufferHas('UI-OK-2'), true);
  await shot('05-reload');
  assert.equal(await page.evaluate(() => window.belay.dock.api.groups[0].header.hidden), true, 'a hidden tab bar stays hidden after a reload');
  await page.click('.proj.active .tp-btn[data-act="tabs"]:visible');
  await page.waitForFunction(() => !window.belay.dock.api.groups[0].header.hidden);
  assert.equal(await page.evaluate(() => window.belay.dock.api.groups[0].header.element.offsetParent !== null), true);

  step('sessions sidebar and settings');
  // An agent session to list: Claude's hooks reporting from alpha.
  await fetch(`${BASE}/api/hook/claude?belay=${alphaId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }) });
  await page.keyboard.press('Control+Shift+S');
  await page.waitForSelector('#side .srow');
  assert.ok((await page.$$eval('#side .srow .srow-name', (r) => r.map((x) => x.textContent))).includes('alpha'));
  await shot('06-sessions');
  await page.keyboard.press('Control+Shift+S');
  await page.waitForSelector('#side.hidden', { state: 'attached' });
  await page.click('#btn-settings');
  await page.waitForSelector('.tpl-pane');
  assert.deepEqual(await page.$$eval('.tpl-item > span:first-child', (r) => r.map((x) => x.textContent)), ['Shell', 'Claude', 'Codex', 'opencode', 'Command'], 'one of each, wherever it runs');
  await page.click('.tpl-item:has-text("Claude")');
  assert.equal(await page.inputValue('.tpl-editor select >> nth=0'), 'claude', 'the agent it starts');
  assert.deepEqual(await page.$$eval('.tpl-fields.compact input', (c) => c.map((x) => x.placeholder)), ['session'], 'what to run: where is a project\'s');
  assert.equal(await page.textContent('.tpl-editor .preview'), 'sh "$BELAY_HOME/scripts/provision-claude.sh"\nclaude');
  assert.equal(await page.$$eval('.tpl-editor .btn:has-text("Reset")', (b) => b.length), 1, 'built-ins get a Reset button');
  await shot('07-settings');
  await page.click('.settings-tabs .tab:has-text("Shortcuts")');
  await page.waitForSelector('.keys-row');
  assert.ok((await page.$$eval('.keys-row', (r) => r.length)) > 20);
  await shot('07b-shortcuts');
  await page.keyboard.press('Escape');

  step('edit dialog renames the session');
  await page.click('.tp >> nth=0 >> .tp-name');
  await page.waitForSelector('.modal');
  await page.fill('.modal input[placeholder="Name"]', 'alpha-renamed');
  await page.click('.modal .btn:has-text("Save"):not(.primary)');
  await page.waitForFunction(() => document.querySelector('.tp .tp-name')?.textContent === 'alpha-renamed');

  step('removing a pane keeps the session; stop shows the exit bar; restart recovers');
  await page.click('.tp >> nth=1 >> .tp-btn[data-act="close"]');
  await page.waitForFunction(() => window.belay.panels.size === 1);
  assert.equal(await page.$$eval('.modal-backdrop', (m) => m.length), 0);
  assert.equal((await (await fetch(`${BASE}/api/sessions`)).json()).length, 2);
  await page.click('.tp .tp-btn[data-act="stop"]');
  await page.waitForSelector('.tp-exit:not(.hidden)');
  assert.equal(await page.textContent('.tp-exit-msg'), 'Stopped');
  await page.click('.tp-exit .btn.primary');
  await page.waitForFunction(() => document.querySelector('.tp-dot')?.dataset.status === 'running');
  await shot('08-final');

  step('light theme applies');
  await page.click('#btn-settings');
  await page.click('.settings-tabs .tab:has-text("General")');
  await page.waitForSelector('.modal select');
  await page.selectOption('.modal select', 'light');
  await page.click('.modal .btn.primary:has-text("Save")');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await shot('09-light');

  step('slow actions show a spinner and ignore repeat clicks');
  // Ignores SIGHUP, so every restart waits for the 3 s SIGKILL fallback.
  const slow = await (await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'command', cwd: os.tmpdir(), name: 'stubborn', vars: { command: "trap '' HUP; sleep 600" } }) })).json();
  let restarts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith(`/api/sessions/${slow.id}/restart`)) restarts++; });
  await page.evaluate((sid) => window.belay.dock.openSession(sid), slow.id);
  await page.waitForFunction((sid) => window.belay.panels.get(`p-${sid}`)?.attached, slow.id);
  const paneRestart = page.locator('.tp', { has: page.locator('.tp-name', { hasText: 'stubborn' }) }).locator('.tp-bar [data-act="restart"]');
  await paneRestart.click();
  await page.waitForFunction(() => document.querySelector('.tp-bar .tp-btn.busy[data-act="restart"]'));
  assert.equal(await paneRestart.isDisabled(), true);
  await paneRestart.click({ force: true });
  await page.keyboard.press('Control+Shift+R');
  await shot('09b-busy');
  await page.waitForFunction(() => !document.querySelector('.tp-btn.busy'), null, { timeout: 8000 });
  assert.equal(restarts, 1, 'repeat clicks and the shortcut are ignored while the pane restarts');
  await fetch(`${BASE}/api/sessions/${slow.id}`, { method: 'DELETE' });
  await page.waitForFunction((sid) => !window.belay.panels.has(`p-${sid}`), slow.id);
  for (let i = 0; i < 50 && JSON.stringify((await (await fetch(`${BASE}/api/state`)).json()).projects).includes(slow.id); i++) await sleep(100); // layout saved

  step('+ Project asks for a name, and a host if it has one; its first shell starts at home; clicking it again is its settings');
  const projDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-proj-')));
  const api = async (method, p, body) => { const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const d = await r.json(); if (!r.ok) throw new Error(`${method} ${p}: ${d.error}`); return d; };
  const sessionNamed = async (name) => (await api('GET', '/api/sessions')).find((x) => x.name === name);
  // The session an action makes (sessions are named like sly-fox, so it is found as the one that is new), and its tab.
  const newSession = async (act) => {
    const before = new Set((await api('GET', '/api/sessions')).map((x) => x.id));
    await act();
    return until(async () => (await api('GET', '/api/sessions')).find((x) => !before.has(x.id)));
  };
  const tabOf = (x) => `.proj.active .dv-tab:has(.ttab-name:text-is("${x.name}"))`;
  const NAME = /^[a-z]+-[a-z]+(-\d+)?$/;
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { if ((v = await fn())) return v; await sleep(100); } throw new Error('timed out waiting'); };
  const projectNames = () => page.$$eval('.vtab-name', (t) => t.map((x) => x.textContent));
  // To a project: a click on its tab, unless it is in front already (where a click is its settings).
  const toProject = async (name) => {
    if (await page.$(`.vtab.active:has(.vtab-name:text-is("${name}"))`)) return;
    await page.click(`.vtab:has(.vtab-name:text-is("${name}"))`);
    await page.waitForFunction((n) => window.belay.dock.activeView()?.name === n, name);
  };
  await page.click('.vtab-add');
  await page.waitForSelector('.modal-head h3:text-is("New project")');
  assert.deepEqual(await page.$$eval('.modal .field-label', (l) => l.map((x) => x.textContent)), ['Name', 'Host', 'User', 'Directory']);
  assert.equal(await page.isDisabled('.modal .row input >> nth=1'), true, 'no user without a host');
  await page.fill('.modal input[placeholder^="Project"]', 'Work');
  await page.fill('.modal input[placeholder="~"]', projDir);
  await page.click('.modal .btn.primary:has-text("Create")');
  await page.waitForSelector('.proj.active .watermark');
  assert.match(await page.$eval('.vtab.active', (t) => t.title), new RegExp(`^Work · ${projDir}\n`));
  await page.click('.vtab.active');
  await page.waitForSelector('.modal-head h3:text-is("Edit project")');
  assert.equal(await page.inputValue('.modal input[placeholder^="Project"]'), 'Work', 'the project in front, clicked: its settings');
  await page.click('.modal .btn:text-is("Cancel")');
  // The directory field browses: the directories in what is typed, listed under it, stepped into from the keyboard.
  const pickDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pick-')));
  fs.mkdirSync(path.join(pickDir, 'alpha', 'inner'), { recursive: true });
  fs.mkdirSync(path.join(pickDir, 'beta'));
  await page.click('.vtab.active');
  await page.waitForSelector('.modal-head h3:text-is("Edit project")');
  await page.fill('.modal .dp-input', `${pickDir}/`);
  await page.waitForFunction(() => document.querySelectorAll('.modal .dp-row').length === 2);
  assert.deepEqual(await page.$$eval('.modal .dp-row', (r) => r.map((x) => x.textContent)), [`${pickDir}/alpha/`, `${pickDir}/beta/`]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('.modal .dp-input'), `${pickDir}/alpha/`, 'Enter goes into it');
  await page.waitForFunction((d) => [...document.querySelectorAll('.modal .dp-row')].map((x) => x.textContent).join() === `${d}/alpha/inner/`, pickDir);
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('.modal .dp-list'), false, 'Escape closes the list');
  assert.equal(await page.isVisible('.modal-head h3:text-is("Edit project")'), true, '…and not the dialog');
  await page.click('.modal .btn:text-is("Cancel")');
  fs.rmSync(pickDir, { recursive: true, force: true });
  const first = await newSession(() => page.click('.proj.active .watermark button:text-is("Shell")'));
  await page.waitForFunction(() => window.belay.panels.size === 1 && [...window.belay.panels.values()][0].attached, null, { timeout: 10000 });
  assert.equal(first.cwd, projDir, "in the project's directory");
  assert.match(first.name, NAME);
  assert.equal(first.templateId, 'shell');

  step('the tab strip uses the belay palette, and a plain running shell has no dot');
  const strip = await page.evaluate(() => { const d = document.createElement('div'); d.style.background = 'var(--strip)'; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; });
  assert.equal(await page.$eval('.proj.active .dv-tabs-and-actions-container', (e) => getComputedStyle(e).backgroundColor), strip);
  assert.equal(await page.$eval('.proj.active .dv-tab .ttab-dot', (d) => d.classList.contains('hidden')), true);
  assert.equal(await page.$eval('.vtab.active', (t) => getComputedStyle(t).borderBottomColor === getComputedStyle(t).borderTopColor), true, 'project tabs are pills, not underlined');

  step("+ after the tabs: a Shell starts in the project's directory, wherever the one beside it has gone");
  await sleep(400);
  await page.keyboard.type('mkdir -p sub && cd sub\n');
  await until(async () => (await api('GET', `/api/sessions/${first.id}`)).cwd === path.join(projDir, 'sub'));
  await page.click('.proj.active .gadd-btn');
  assert.equal(await page.textContent('.menu-item >> nth=0'), 'Shell', 'names only: the place is the project\'s');
  const second = await newSession(() => page.click('.menu-item >> nth=0'));
  await page.waitForFunction(() => window.belay.panels.size === 2);
  assert.equal(second.cwd, projDir);
  assert.notEqual(second.name, first.name);
  assert.equal(await page.evaluate(() => window.belay.dock.api.groups.length), 1, 'opens as a tab in the same group');

  step('a click on the active tab opens its editor; a click on another tab only switches to it');
  await page.click('.proj.active .dv-tab.dv-active-tab .ttab-name');
  await page.waitForSelector('.modal-head h3:text-is("Edit session")');
  assert.equal(await page.inputValue('.modal input[placeholder="Name"]'), second.name);
  await page.keyboard.press('Escape');
  await page.click('.proj.active .dv-tab:not(.dv-active-tab) .ttab-name');
  await sleep(300);
  assert.equal(await page.$('.modal'), null);
  assert.equal(await page.evaluate(() => window.belay.dock.sessionOf().name), first.name);

  step('switching projects keeps terminals live: no rebuild, and output keeps arriving behind');
  await page.evaluate((id) => { window.keptTerm = window.belay.panels.get(`p-${id}`).term; }, first.id);
  await page.keyboard.type('sleep 1; echo LATE-$((40+2))\n');
  await toProject('Main');
  await page.waitForFunction((id) => { const t = window.belay.dock.projects.get(window.belay.dock.views.find((v) => v.name === 'Work').id).panels.get(`p-${id}`).term.buffer.active; for (let y = 0; y < t.length; y++) if (t.getLine(y)?.translateToString().includes('LATE-42')) return true; return false; }, first.id, { timeout: 8000 });
  await toProject('Work');
  assert.equal(await page.evaluate((id) => window.belay.panels.get(`p-${id}`).term === window.keptTerm, first.id), true, 'the same terminal, not a replayed one');

  step('OSC 52 from a program puts text on the clipboard, with a fallback when the clipboard API refuses');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await page.evaluate((id) => window.belay.panels.get(`p-${id}`).focus(), first.id);
  await page.keyboard.type(`printf '\\033]52;c;%s\\a' "$(printf 'clip ✓ ok' | base64)"\n`);
  await page.waitForSelector('.toast:has-text("Copied 9 characters")');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'clip ✓ ok');
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('not allowed')); });
  await page.keyboard.type(`printf '\\033]52;c;%s\\a' "$(printf 'second' | base64)"\n`);
  await page.waitForSelector('.toast:has-text("Copied 6 characters")');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'second', 'copied through the textarea fallback');

  step('a file path printed in a terminal opens the file in a tab at that line');
  fs.writeFileSync(path.join(projDir, 'sub', 'plan.md'), '# Plan\ntwo **bold** `code`\nthree\n');
  await page.keyboard.type('echo "see plan.md:2 and /nonexistent/x.md"\n');
  const row = await until(() => page.evaluate((id) => { const b = window.belay.panels.get(`p-${id}`).term.buffer.active; for (let y = b.length - 1; y >= 0; y--) if (b.getLine(y)?.translateToString(true).startsWith('see plan.md')) return y + 1; return 0; }, first.id));
  const links = await page.evaluate(async ([id, y]) => (await window.belay.panels.get(`p-${id}`).fileLinks(y)).map((l) => l.text), [first.id, row]);
  assert.deepEqual(links, ['plan.md:2'], 'only files that exist are links');
  await page.waitForFunction(() => document.querySelectorAll('.proj.active .fl-deco').length >= 1, null, { timeout: 5000 }); // underlined without hovering
  const at = await page.evaluate(([id, y]) => {
    const p = window.belay.panels.get(`p-${id}`);
    const cell = p.term._core._renderService.dimensions.css.cell;
    const r = p.termEl.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: r.left + cell.width * 6.5, y: r.top + cell.height * (y - 1 - p.term.buffer.active.viewportY + 0.5) };
  }, [first.id, row]);
  await page.mouse.move(at.x, at.y);
  await sleep(300);
  // Right-click on the link: a menu, and the file does not open here. Open in VS Code asks once for the ssh host
  // VS Code is connected to, then hands the browser a vscode:// link (caught here).
  const vscodeOpens = [];
  await page.exposeFunction('belayTestOpened', (u) => { vscodeOpens.push(u); });
  const catchOpens = () => page.evaluate(() => { window.belay.openUrl = (u) => window.belayTestOpened(u); });
  await catchOpens();
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForSelector('#ctx-menu');
  assert.equal(await page.evaluate(() => [...window.belay.panels.keys()].some((k) => k.startsWith('f-'))), false, 'a right-click opens the menu, not the file');
  await page.click('.menu-item:has-text("Open in VS Code")');
  await page.waitForSelector('.modal-head h3:has-text("which ssh host is your VS Code window connected to")');
  await page.fill('.modal input', 'devbox');
  await page.click('.modal .btn.primary:text-is("OK")');
  await until(() => vscodeOpens.length === 1);
  assert.equal(vscodeOpens[0], `vscode://vscode-remote/ssh-remote+devbox${path.join(projDir, 'sub', 'plan.md')}:2`);
  assert.equal((await api('GET', '/api/settings')).vscodeHost, 'devbox', 'asked once, kept');
  await page.mouse.move(at.x + 200, at.y + 120); // away and back: the terminal finds the link under a moving pointer
  await page.mouse.move(at.x, at.y);
  await sleep(300);
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => [...window.belay.panels.keys()].some((k) => k.startsWith('f-')));
  const fileId = await page.evaluate(() => [...window.belay.panels.keys()].find((k) => k.startsWith('f-')));
  const ed = (fn, arg) => page.evaluate(([id, f, a]) => new Function('p', 'a', `return (${f})(p, a)`)(window.belay.panels.get(id), a), [fileId, String(fn), arg]);
  // The editor takes the focus a moment after it is asked to (newer Chrome); keys typed before then go to the tab.
  const edFocus = async (pos) => {
    await ed((p, at) => { p.editor.focus(); if (at) p.editor.setPosition(at); }, pos);
    await page.waitForFunction((id) => window.belay.panels.get(id)?.editor?.hasTextFocus(), fileId);
  };
  await page.waitForFunction((id) => window.belay.panels.get(id)?.editor, fileId, { timeout: 15000 });
  await page.waitForSelector('.proj.active .fv .ed-hl');
  assert.equal(await ed((p) => p.editor.getPosition().lineNumber), 2, 'the cursor is on the printed line');
  assert.equal(await ed((p) => p.model.getLanguageId()), 'markdown');
  assert.equal(await ed((p) => p.editor.getRawOptions().wordWrap), 'off', 'files do not wrap until asked');
  await ed((p) => p.toggleWrap());
  assert.equal(await ed((p) => [p.editor.getRawOptions().wordWrap, window.belay.dock.api.getPanel(p.api.id).params.wrap].join()), 'on,true');
  await ed((p) => p.toggleWrap());
  assert.equal(await ed((p) => p.model.getValue()), '# Plan\ntwo **bold** `code`\nthree\n');
  assert.equal(await page.textContent('.proj.active .fv .np-status'), 'Markdown · 3 lines');
  assert.equal(await page.textContent('.proj.active .dv-tab.dv-active-tab .ttab-name'), 'plan.md');
  assert.equal(await page.textContent('.proj.active .fv .tp-cwd'), path.join(projDir, 'sub', 'plan.md'));
  await shot('12-file');
  await page.evaluate((p) => window.belay.dock.openFile({ path: p, line: 3 }), path.join(projDir, 'sub', 'plan.md'));
  await page.waitForFunction((id) => window.belay.panels.get(id).editor.getPosition().lineNumber === 3, fileId);
  assert.equal(await page.evaluate(() => [...window.belay.panels.keys()].filter((k) => k.startsWith('f-')).length), 1, 'the same file again reuses its tab');

  step('a file is edited in Monaco with the HUD keys, and saved with Ctrl+S');
  const planPath = path.join(projDir, 'sub', 'plan.md');
  await edFocus({ lineNumber: 3, column: 6 });
  await page.keyboard.type(' and four');
  await page.waitForSelector('.proj.active .ttab.dirty');
  assert.match(await page.textContent('.proj.active .fv .np-status'), /^edited/);
  assert.equal(fs.readFileSync(planPath, 'utf8'), '# Plan\ntwo **bold** `code`\nthree\n', 'nothing is written before a save');
  await page.keyboard.press('Control+d'); // the HUD's Cmd/Ctrl+D: duplicate the line
  assert.equal(await ed((p) => p.model.getLineContent(4)), 'three and four');
  await page.keyboard.press('Shift+Delete'); // and Shift+Delete: delete it
  assert.equal(await ed((p) => p.model.getLineCount()), 4);
  await page.keyboard.press('Control+s');
  await until(() => fs.readFileSync(planPath, 'utf8') === '# Plan\ntwo **bold** `code`\nthree and four\n');
  await page.waitForFunction(() => !document.querySelector('.proj.active .ttab.dirty'));
  // The VS Code mark on the bar opens the file there, at the cursor's line.
  await catchOpens();
  await ed((p) => p.editor.setPosition({ lineNumber: 3, column: 1 }));
  await page.click('.proj.active .fv .tp-vscode');
  await until(() => vscodeOpens.length === 2);
  assert.equal(vscodeOpens[1], `vscode://vscode-remote/ssh-remote+devbox${planPath}:3`);
  vscodeOpens.pop();

  step('a file changed on disk: reloaded when nothing is edited, never overwritten without asking');
  fs.writeFileSync(planPath, 'changed outside\n');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction((id) => window.belay.panels.get(id).model.getValue() === 'changed outside\n', fileId);
  assert.match(await page.textContent('.proj.active .fv .np-status'), /reloaded: changed on disk/);
  await edFocus({ lineNumber: 1, column: 1 });
  await page.keyboard.type('mine: ');
  fs.writeFileSync(planPath, 'changed outside again\n');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.modal p:has-text("has changed on disk since you opened it")');
  await page.click('.modal .btn:text-is("Cancel")');
  assert.equal(fs.readFileSync(planPath, 'utf8'), 'changed outside again\n', 'cancel keeps the newer file');
  await page.keyboard.press('Control+s');
  await page.click('.modal .btn.danger:text-is("Overwrite")');
  await until(() => fs.readFileSync(planPath, 'utf8') === 'mine: changed outside\n');

  step('unsaved changes survive a reload, and closing asks first');
  await edFocus({ lineNumber: 1, column: 1 });
  await page.keyboard.type('draft ');
  await page.waitForSelector('.proj.active .ttab.dirty');
  await sleep(400); // the draft is kept a moment after typing
  await page.reload();
  await page.waitForFunction(() => window.belay?.dock && [...window.belay.panels.keys()].some((k) => k.startsWith('f-')), null, { timeout: 15000 });
  await toProject('Work');
  await page.waitForFunction((id) => window.belay.panels.get(id)?.model?.getValue() === 'draft mine: changed outside\n', fileId, { timeout: 15000 });
  assert.equal(await page.evaluate((id) => window.belay.dock.api.getPanel(id).view.tab.element.querySelector('.ttab-name').textContent, fileId), 'plan.md', 'a file tab has its name after a reload');
  await page.waitForSelector('.proj.active .ttab.dirty');
  // Closed from the keyboard, so the focus stays in the editor (a click elsewhere would save it).
  await edFocus();
  await page.keyboard.press('Control+Shift+X');
  await page.waitForSelector('.modal p:has-text("Save your changes to plan.md?")');
  await page.click('.modal .btn:text-is("Cancel")');
  assert.ok(await page.evaluate((id) => window.belay.panels.has(id), fileId), 'cancel keeps the tab');
  assert.equal(fs.readFileSync(planPath, 'utf8'), 'mine: changed outside\n', 'asking does not save it');
  await edFocus();
  await page.keyboard.press('Control+Shift+X');
  await page.click(`.modal .btn:text-is("Don't save")`);
  await page.waitForFunction((id) => !window.belay.panels.has(id), fileId);
  assert.equal(fs.readFileSync(planPath, 'utf8'), 'mine: changed outside\n');
  assert.equal(await page.evaluate((id) => localStorage.getItem(`belay.draft.${id}`), fileId), null, "don't save drops the draft");

  step('a file saves itself when the focus leaves it, but never over a newer file on disk');
  await page.evaluate((p) => window.belay.dock.openFile({ path: p }), planPath);
  await page.waitForFunction((id) => window.belay.panels.get(id)?.editor, fileId, { timeout: 15000 });
  await edFocus({ lineNumber: 1, column: 1 });
  await page.keyboard.type('auto ');
  await page.click(tabOf(first));
  await until(() => fs.readFileSync(planPath, 'utf8') === 'auto mine: changed outside\n');
  await page.click('.proj.active .dv-tab:has(.ttab-name:text-is("plan.md"))');
  await edFocus({ lineNumber: 1, column: 1 });
  await page.keyboard.type('again ');
  fs.writeFileSync(planPath, 'someone else\n');
  await page.click(tabOf(first));
  await page.click('.proj.active .dv-tab:has(.ttab-name:text-is("plan.md"))');
  await page.waitForFunction(() => /changed on disk: not saved/.test(document.querySelector('.proj.active .fv .np-status')?.textContent));
  assert.equal(fs.readFileSync(planPath, 'utf8'), 'someone else\n', 'the newer file is left alone');
  assert.equal(await page.$('.modal'), null, 'and nothing pops up');
  await edFocus();
  await page.keyboard.press('Control+Shift+X');
  await page.click(`.modal .btn:text-is("Don't save")`);
  await page.waitForFunction((id) => !window.belay.panels.has(id), fileId);

  step('Open file picks a path with completion, and a new file is made on save');
  await page.keyboard.press('Control+Shift+O');
  await page.waitForSelector('.modal-head h3:text-is("Open file")');
  await page.fill('.modal input[list]', `${projDir}/sub/`);
  // What is in the directory typed so far is offered (plan.md among it), as a shell completes.
  await page.waitForFunction((d) => [...document.querySelectorAll('.modal datalist option')].some((o) => o.value === `${d}/sub/plan.md`), projDir).catch(async (e) => {
    const offered = await page.$$eval('.modal datalist option', (o) => o.map((x) => x.value));
    throw new Error(`${e.message}; typed ${await page.inputValue('.modal input[list]')}, offered ${JSON.stringify(offered)}; in the directory ${JSON.stringify(fs.readdirSync(path.join(projDir, 'sub')))}`);
  });
  await page.fill('.modal input[list]', `${projDir}/sub/new.txt`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...window.belay.panels.values()].some((p) => p.file?.path.endsWith('/new.txt') && p.editor), null, { timeout: 15000 });
  assert.match(await page.textContent('.proj.active .fv .np-status'), /new file/);
  await page.keyboard.type('fresh');
  await page.keyboard.press('Control+s');
  await until(() => fs.existsSync(path.join(projDir, 'sub', 'new.txt')) && fs.readFileSync(path.join(projDir, 'sub', 'new.txt'), 'utf8') === 'fresh');
  await page.waitForFunction(() => !/new file/.test(document.querySelector('.proj.active .fv .np-status').textContent));
  await page.click('.proj.active .fv [data-act="close"]');

  step('code files get their language, and their text can never become HTML');
  fs.writeFileSync(path.join(projDir, 'sub', 'app.js'), '/* multi\nline */\nconst s = "<img src=x onerror=window.pwned=1>";\n');
  await page.evaluate((p) => window.belay.dock.openFile({ path: p }), path.join(projDir, 'sub', 'app.js'));
  await page.waitForFunction(() => [...window.belay.panels.values()].some((p) => p.file?.path.endsWith('app.js') && p.editor), null, { timeout: 15000 });
  await page.waitForSelector('.proj.active .fv .mtk1');
  assert.equal(await page.textContent('.proj.active .fv .np-status'), 'JavaScript · 3 lines');
  assert.equal(await page.$('.proj.active .fv img'), null);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await page.click('.proj.active .fv [data-act="close"]');
  await page.waitForFunction(() => ![...window.belay.panels.keys()].some((k) => k.startsWith('f-')));

  step('a web tab shows the one URL from its settings, and keeps its page while hidden');
  await page.click('.proj.active .gadd-btn');
  await page.click('.menu-item:text-is("Web page…")');
  await page.waitForSelector('.modal-head h3:text-is("New web tab")');
  await page.fill('.modal input[placeholder="https://"]', 'javascript:alert(1)');
  await page.click('.modal .btn.primary:has-text("Open")');
  assert.equal(await page.textContent('.modal .error-text'), 'Give an http:// or https:// address.');
  await page.fill('.modal input[placeholder="https://"]', `${BASE}/api/health`);
  await page.fill('.modal input[placeholder="from the address"]', 'Health');
  await page.click('.modal .btn.primary:has-text("Open")');
  const frame = '.proj.active .wv-frame';
  await page.waitForFunction((sel) => document.querySelector(sel)?.contentDocument?.body?.textContent.includes('"ok":true'), frame);
  assert.equal(await page.textContent('.proj.active .dv-tab.dv-active-tab .ttab-name'), 'Health');
  await page.evaluate((sel) => { document.querySelector(sel).contentWindow.marker = 42; }, frame);
  await page.click(tabOf(first));
  await toProject('Main');
  await toProject('Work');
  await page.click('.proj.active .dv-tab:has(.ttab-name:text-is("Health"))');
  assert.equal(await page.evaluate((sel) => document.querySelector(sel).contentWindow.marker, frame), 42, 'not reloaded by switching tabs or projects');
  await page.waitForFunction(() => window.belay.dock.api.activePanel?.title === 'Health'); // dockview activates a frame later
  await page.click('.proj.active .dv-tab.dv-active-tab .ttab-name');
  await page.waitForSelector('.modal-head h3:text-is("Edit page tab")');
  assert.equal(await page.inputValue('.modal input[placeholder="https://"]'), `${BASE}/api/health`);
  await page.fill('.modal input[placeholder="from the address"]', 'Status');
  await page.click('.modal .btn.primary:has-text("Save")');
  await page.waitForFunction(() => document.querySelector('.proj.active .dv-tab.dv-active-tab .ttab-name')?.textContent === 'Status');
  assert.equal(await page.evaluate((sel) => document.querySelector(sel).contentWindow.marker, frame), 42, 'a new title does not reload the page');
  await page.click('.proj.active .wv [data-act="close"]');
  await page.waitForFunction(() => ![...window.belay.panels.keys()].some((k) => k.startsWith('w-')));

  step('a remote page shows an app as seen from the project machine, WebSockets included, and hands belay its keys back');
  const app = http.createServer((q, r) => {
    r.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
    r.end(`<!doctype html><html><head><title>app</title></head><body><h1 id="t">hello from ${q.url}</h1><input id="i" autofocus><p id="ws">waiting</p>
<script>document.getElementById('i').focus(); const w = new WebSocket('ws://' + location.host + '/ws'); w.onmessage = (e) => { document.getElementById('ws').textContent = e.data; };</script></body></html>`);
  });
  new WebSocketServer({ server: app }).on('connection', (ws, q) => ws.send(`ws ok host=${q.headers.host}`));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const appPort = app.address().port;
  await page.click('.proj.active .gadd-btn');
  await page.click('.menu-item:has-text("Remote page…")');
  await page.waitForSelector('.modal-head h3:text-is("New remote page")');
  assert.equal(await page.inputValue('.modal select'), 'remote');
  await page.fill('.modal input[placeholder^="localhost:3000"]', `localhost:${appPort}/hello`);
  await page.mouse.move(5, 5); // off where the frame will be: a frame that takes the focus without the pointer did it by itself
  await page.keyboard.press('Enter');
  const appFrame = () => page.frames().find((f) => /^http:\/\/page-[0-9a-f]{10}\.localhost:\d+\/hello$/.test(f.url()));
  await until(() => appFrame());
  await appFrame().waitForFunction(() => document.getElementById('ws')?.textContent.startsWith('ws ok'), null, { timeout: 8000 });
  assert.equal(await appFrame().textContent('#t'), 'hello from /hello', 'the app runs at its own path, despite X-Frame-Options');
  assert.equal(await appFrame().textContent('#ws'), `ws ok host=localhost:${appPort}`, 'its WebSocket reaches it with the Host it expects');
  assert.equal(await page.textContent('.proj.active .dv-tab.dv-active-tab .ttab-note'), '⇆');
  assert.equal(await page.textContent('.proj.active .wv .tp-cwd'), `localhost:${appPort}/hello · on the belay machine`);
  await sleep(300);
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'IFRAME', 'a page that focuses itself on load does not keep the keyboard from belay');
  await shot('13-remote-page');
  const pageTitle = await page.textContent('.proj.active .dv-tab.dv-active-tab .ttab-name');
  assert.equal(pageTitle, `localhost:${appPort}`);
  await appFrame().click('#i');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'IFRAME', 'a click puts the keyboard in the page');
  await page.keyboard.press('Control+Tab');
  await page.waitForFunction((t) => window.belay.dock.api.activePanel?.title !== t && document.activeElement?.tagName !== 'IFRAME', pageTitle);
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForFunction((t) => window.belay.dock.api.activePanel?.title === t, pageTitle);
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'IFRAME', 'stepping onto a page tab keeps the keyboard with belay');
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('.proj.active .wv [data-act="open"]')]);
  await popup.waitForFunction(() => document.getElementById('t')?.textContent === 'hello from /hello', null, { timeout: 8000 });
  assert.match(popup.url(), /^http:\/\/page-[0-9a-f]{10}\.localhost:\d+\/hello$/);
  await popup.close();
  await page.click('.proj.active .wv [data-act="close"]');
  await page.waitForFunction(() => ![...window.belay.panels.keys()].some((k) => k.startsWith('w-')));
  app.close();

  step('a remote project runs its shells and Claude on its host, in its directory');
  await page.click('.vtab-add');
  await page.waitForSelector('.modal-head h3:text-is("New project")');
  await page.fill('.modal input[placeholder^="Project"]', 'Box');
  await page.fill('.modal input[placeholder="this machine"]', 'bad host!');
  await page.click('.modal .btn.primary:has-text("Create")');
  assert.match(await page.textContent('.modal .error-text'), /Host is a name from your ssh config/);
  // user@host typed as the host splits in two; where ssh will connect shows below.
  await page.fill('.modal input[placeholder="this machine"]', 'me@belay-test.invalid');
  assert.equal(await page.inputValue('.modal input[placeholder="this machine"]'), 'belay-test.invalid');
  assert.equal(await page.inputValue('.modal .row input >> nth=1'), 'me');
  await page.waitForFunction(() => /^ssh connects to me@belay-test\.invalid$/.test(document.querySelector('.modal .ssh-where')?.textContent || ''));
  await page.fill('.modal input[placeholder="~"]', '/srv/app');
  await page.click('.modal .btn.primary:has-text("Create")');
  await page.waitForSelector('.proj.active .watermark');
  assert.match(await page.$eval('.vtab.active', (t) => t.title), /^Box · me@belay-test\.invalid:\/srv\/app\n/);
  assert.equal(await page.$('.vtab.active .vtab-host'), null, 'the tab is its name: where it is, in its tooltip');
  assert.deepEqual(await page.$$eval('.proj.active .watermark .btn.primary', (b) => b.map((x) => x.textContent)), ['Shell', 'Claude', 'Codex', 'opencode']);
  const rc = await newSession(() => page.click('.proj.active .watermark button:text-is("Claude")'));
  assert.equal(rc.templateId, 'claude');
  assert.deepEqual([rc.host, rc.dir, rc.vars], ['me@belay-test.invalid', '/srv/app', {}], 'on the project\'s host, in its directory, nothing of its own');
  await page.waitForFunction(() => window.belay.panels.size === 1);
  await api('POST', `/api/hook/claude?belay=${rc.id}`, { session_id: 'conv-123', hook_event_name: 'Stop' });
  await page.click('.proj.active .gadd-btn');
  assert.equal(await page.textContent('.menu-item >> nth=0'), 'Shell');
  const rsh = await newSession(() => page.click('.menu-item >> nth=0'));
  assert.equal(rsh.templateId, 'shell');
  assert.deepEqual([rsh.host, rsh.vars], ['me@belay-test.invalid', {}], 'on the project\'s host, not one of its own');
  await page.waitForSelector(`${tabOf(rsh)} .ttab-dot.failed`, { timeout: 10000 }); // ssh to .invalid fails

  step('the + menu lists every template, yours too, then notes, post-its and pages; Codex and opencode sit beside Claude');
  const k9s = await api('POST', '/api/templates', { name: 'k9s', command: 'k9s' });
  await page.click('.proj.active .gadd-btn');
  assert.deepEqual(await page.$$eval('.menu-item', (m) => m.map((x) => x.firstChild.textContent)),
    ['Shell', 'Claude', 'Codex', 'opencode', 'k9s', 'Command…', 'Notes', 'Post-its', 'File…', 'Web page…', 'Remote page…'], 'names only, no New session…');
  await shot('08b-add-menu');
  const rk = await newSession(() => page.click('.menu-item:text-is("k9s")'));
  assert.deepEqual([rk.host, rk.dir, rk.command], ['me@belay-test.invalid', '/srv/app', 'k9s'], 'your own template runs on the host too');
  await page.waitForFunction((sid) => window.belay.panels.has(`p-${sid}`), rk.id);
  await api('DELETE', `/api/sessions/${rk.id}`);
  await page.waitForFunction((sid) => !window.belay.panels.has(`p-${sid}`), rk.id);
  await api('DELETE', `/api/templates/${k9s.id}`);
  // Command asks what to run first: the new session form, on that template, in this project's place.
  await page.click('.proj.active .gadd-btn');
  await page.click('.menu-item:has-text("Command…")');
  await page.waitForSelector('.modal-head h3:text-is("New session")');
  assert.equal(await page.inputValue('.modal select >> nth=0'), 'command');
  assert.match(await page.textContent('.modal .preview'), /^# on me@belay-test\.invalid, in \/srv\/app/, "the project's place");
  await page.click('.modal .btn:text-is("Cancel")');
  await page.click('.proj.active .gadd-btn');
  const rcx = await newSession(() => page.click('.menu-item:text-is("Codex")'));
  assert.equal(rcx.templateId, 'codex');
  assert.deepEqual([rcx.host, rcx.vars], ['me@belay-test.invalid', {}], 'on the project\'s host, nothing of its own');
  assert.deepEqual([rcx.host, rcx.command], ['me@belay-test.invalid', 'codex --no-daemon']);
  await page.waitForSelector(tabOf(rcx));
  await spyInput(page);
  await page.evaluate((sid) => window.belay.panels.get(`p-${sid}`).focus(), rcx.id);
  await page.keyboard.press('Shift+Enter');
  assert.deepEqual(await takeSent(page), ['\x1b\r'], 'an agent template gets the newline before its hooks report anything');
  await api('POST', `/api/hook/codex?belay=${rcx.id}`, { session_id: 'thread-9', hook_event_name: 'Stop' });
  assert.equal((await api('GET', `/api/sessions/${rcx.id}`)).command, 'codex --no-daemon resume thread-9');
  await page.click(tabOf(rcx), { button: 'right' });
  assert.deepEqual(await page.$$eval('.menu-item', (m) => m.map((x) => x.textContent).filter((t) => t.startsWith('New '))), ['New Shell', 'New Claude', 'New Codex', 'New opencode', 'New Command…']);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await api('DELETE', `/api/sessions/${rcx.id}`);
  await page.waitForFunction((sid) => !window.belay.panels.has(`p-${sid}`), rcx.id);
  await page.keyboard.press('Control+Shift+P');
  await page.fill('.pal-input', 'new op');
  assert.equal(await page.textContent('.pal-item >> nth=0 >> .pal-label'), 'New opencode');
  await page.keyboard.press('Escape');

  step('Duplicate keeps the template, directory and values, not the Claude conversation');
  assert.equal((await api('GET', `/api/sessions/${rc.id}`)).vars.session, 'conv-123');
  await page.click(tabOf(rc), { button: 'right' });
  const dup = await newSession(() => page.click('.menu-item:text-is("Duplicate")'));
  assert.match(dup.name, NAME, 'a name of its own');
  assert.equal(dup.templateId, 'claude');
  assert.deepEqual([dup.host, dup.vars], ['me@belay-test.invalid', {}], 'on the project\'s host, nothing of its own');
  await page.waitForFunction((id) => window.belay.panels.has(`p-${id}`), dup.id);

  step('notes: Ctrl+Shift+K shows the project notes on the right, saves as you type, hides and comes back');
  await page.keyboard.press('Control+Shift+K');
  await page.waitForFunction(() => [...window.belay.panels.values()].some((p) => p.noteId && p.editor?.hasTextFocus()), null, { timeout: 15000 });
  await page.keyboard.type('remember the + menu');
  const note = await until(async () => (await api('GET', '/api/notes')).find((n) => n.text === 'remember the + menu'));
  assert.equal(note.title, 'Box notes');
  const [termLeft, noteLeft] = await page.evaluate((id) => [document.querySelector('.proj.active .tp').getBoundingClientRect().left, window.belay.panels.get(`n-${id}`).element.getBoundingClientRect().left], note.id);
  assert.ok(noteLeft > termLeft + 200, 'the notes sit to the right of the terminals');
  await shot('11-notes');
  await page.keyboard.press('Control+Shift+K');
  await page.waitForFunction((id) => !window.belay.panels.has(`n-${id}`), note.id);
  await page.keyboard.press('Control+Shift+K');
  await page.waitForFunction((id) => window.belay.panels.get(`n-${id}`)?.editor && window.belay.panels.get(`n-${id}`).value === 'remember the + menu', note.id);
  assert.equal(await page.evaluate((id) => window.belay.panels.get(`n-${id}`).model.getLanguageId(), note.id), 'markdown');
  assert.deepEqual(await page.evaluate((id) => { const o = window.belay.panels.get(`n-${id}`).editor.getRawOptions(); return [o.wordWrap, o.wrappingIndent, o.lineNumbers]; }, note.id), ['on', 'deepIndent', 'off'], "the HUD notes' settings");
  step('the palette sizes every editor\'s text, and word wrap is per tab');
  const noteOpt = () => page.evaluate((id) => { const e = window.belay.panels.get(`n-${id}`).editor; return { size: e.getRawOptions().fontSize, wrap: e.getRawOptions().wordWrap }; }, note.id);
  const palette = async (label) => {
    await page.keyboard.press('Control+Shift+P');
    await page.fill('.pal-input', label);
    await page.waitForFunction((l) => document.querySelector('.pal-item.active .pal-label')?.textContent === l, label);
    await page.keyboard.press('Enter');
  };
  const size0 = (await noteOpt()).size;
  await palette('Editor: larger text');
  await page.waitForFunction(([id, n]) => window.belay.panels.get(`n-${id}`).editor.getRawOptions().fontSize === n, [note.id, size0 + 1]);
  await palette('Editor: larger text');
  await page.waitForFunction(([id, n]) => window.belay.panels.get(`n-${id}`).editor.getRawOptions().fontSize === n, [note.id, size0 + 2]);
  assert.equal((await api('GET', '/api/settings')).editorFontSize, size0 + 2, 'kept in the settings, for every browser');
  await palette('Editor: smaller text');
  await page.waitForFunction(([id, n]) => window.belay.panels.get(`n-${id}`).editor.getRawOptions().fontSize === n, [note.id, size0 + 1]);
  await palette('Editor: reset text size');
  await page.waitForFunction(([id, n]) => window.belay.panels.get(`n-${id}`).editor.getRawOptions().fontSize === n, [note.id, size0]);
  assert.equal((await api('GET', '/api/settings')).editorFontSize, 0);
  assert.equal((await noteOpt()).wrap, 'on', 'notes wrap by default');
  await palette('Editor: toggle word wrap');
  await page.waitForFunction((id) => window.belay.panels.get(`n-${id}`).editor.getRawOptions().wordWrap === 'off', note.id);
  for (let i = 0; i < 50 && !JSON.stringify((await api('GET', '/api/state')).projects).includes('"wrap":false'); i++) await sleep(100);
  assert.ok(JSON.stringify((await api('GET', '/api/state')).projects).includes('"wrap":false'), 'the tab keeps its wrap in the layout');
  await page.evaluate((id) => window.belay.dock.api.getPanel(`n-${id}`).view.tab.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 60 })), note.id);
  await page.click('.menu-item:has-text("Word wrap: off")');
  await page.waitForFunction((id) => window.belay.panels.get(`n-${id}`).editor.getRawOptions().wordWrap === 'on', note.id);

  await page.evaluate(() => document.activeElement.blur());
  await api('PUT', `/api/notes/${note.id}`, { text: 'changed in another browser', origin: 'elsewhere' });
  await page.waitForFunction((id) => window.belay.panels.get(`n-${id}`).value === 'changed in another browser', note.id);

  step('a project has one note: closing it keeps it, and the + menu opens the same one');
  await page.click(`.proj.active .dv-tab:has(.ttab-name:text-is("Box notes")) .ttab-close`);
  await page.waitForFunction((id) => !window.belay.panels.has(`n-${id}`), note.id);
  await page.click('.proj.active .gadd-btn >> nth=0');
  await page.click('.menu-item:has-text("Notes")');
  await page.waitForFunction((id) => window.belay.panels.get(`n-${id}`)?.value === 'changed in another browser', note.id);
  await page.click('.proj.active .gadd-btn >> nth=0');
  await page.click('.menu-item:has-text("Notes")');
  await sleep(300);
  assert.equal(await page.evaluate(() => [...window.belay.panels.keys()].filter((k) => k.startsWith('n-')).length), 1, 'asking again shows the same note, not another');
  assert.equal((await api('GET', '/api/notes')).filter((n) => n.title.startsWith('Box')).length, 1);
  assert.equal(await page.evaluate(() => window.belay.keys.paletteItems().some((i) => i.label === 'New note')), false, 'no command makes a second note');

  step('a note no project has (from when a project could have several) is recovered into this project\'s note');
  const stray = await api('POST', '/api/notes', { title: 'Notes', text: 'stray idea\n' });
  await until(() => page.evaluate((id) => window.belay.client.note(id), stray.id));
  await palette('Recover note: stray idea');
  await page.waitForFunction((id) => window.belay.panels.get(`n-${id}`)?.value === 'changed in another browser\n\nstray idea', note.id);
  await until(async () => !(await api('GET', '/api/notes')).some((n) => n.id === stray.id));
  assert.equal((await api('GET', `/api/notes/${note.id}`)).text, 'changed in another browser\n\nstray idea');

  step('dialogs answer: a note renamed through its prompt, and deleted through its confirm');
  await page.click('.proj.active .np .tp-name');
  await page.waitForSelector('.modal-head h3:text-is("Rename note")');
  await page.fill('.modal input', 'Box ideas');
  await page.click('.modal .btn.primary:text-is("OK")');
  await until(async () => (await api('GET', `/api/notes/${note.id}`)).title === 'Box ideas');
  await page.waitForFunction(() => document.querySelector('.proj.active .np .tp-name')?.textContent === 'Box ideas');
  await page.click('.proj.active .np [data-act="delete"]');
  await page.click('.modal .btn.danger:text-is("Delete")');
  await until(async () => !(await api('GET', '/api/notes')).some((n) => n.id === note.id));
  await page.waitForFunction((id) => !window.belay.panels.has(`n-${id}`), note.id);

  step('sessions sidebar: idle and working times, sorted, starred, grouped, hidden, resized, and a click goes to the session where it is');
  const mkS = async (name) => (await api('POST', '/api/sessions', { templateId: 'shell', name, cwd: os.tmpdir() })).id;
  const hookS = (sid, ev, agent = 'claude') => fetch(`${BASE}/api/hook/${agent}?belay=${sid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: `conv-${sid}`, hook_event_name: ev }) });
  const sOld = await mkS('side old'), sNew = await mkS('side new'), sBusy = await mkS('side busy');
  await page.evaluate(([a, b, c]) => {
    const d = window.belay.dock;
    const inView = (name, sid) => { d.switchView(d.views.find((v) => v.name === name).id); d.openSession(sid); };
    inView('Work', a); inView('Second', b); inView('Main', c);
  }, [sOld, sNew, sBusy]);
  await hookS(sOld, 'Stop');
  await sleep(1200);
  await hookS(sNew, 'Stop', 'codex');
  await hookS(sBusy, 'UserPromptSubmit');
  await until(async () => (await api('GET', `/api/sessions/${sOld}`)).project === (await api('GET', '/api/state')).projects.find((v) => v.name === 'Work').id);
  const sideNames = () => page.$$eval('#side .srow .srow-name', (r) => r.map((x) => x.textContent).filter((n) => n.startsWith('side ')));
  const srow = (n) => `#side .srow:has(.srow-name:text-is("${n}"))`;
  await page.waitForFunction(() => [...window.belay.client.state.sessions.values()].find((s) => s.name === 'side busy').activity?.state === 'busy');
  await page.click('.rail-btn[data-side="sessions"]');
  await page.waitForSelector('#side:not(.hidden) .srow');
  await page.click('#side .seg button:text-is("None")');
  assert.deepEqual(await page.$$eval('#side select option', (o) => o.map((x) => x.textContent)), ['Least recent first', 'Most recent first', 'Name']);
  assert.deepEqual(await sideNames(), ['side old', 'side new', 'side busy'], 'least recent first');
  assert.equal(await page.textContent(`${srow('side old')} .srow-label`), 'idle');
  assert.equal(await page.textContent(`${srow('side busy')} .srow-label`), 'working');
  assert.equal(await page.textContent(`${srow('side old')} .srow-sub`), 'Work', 'the project it is in');
  assert.equal(await page.$$eval('#side .srow', (r) => r.filter((x) => getComputedStyle(x).borderLeftWidth !== '0px').length), 0, 'no border marking the current project');
  const t0 = await page.textContent(`${srow('side old')} .srow-time`);
  await sleep(1100);
  assert.notEqual(await page.textContent(`${srow('side old')} .srow-time`), t0, 'the timer moves on');
  assert.match(t0, /^\d+s$/);
  await page.selectOption('#side select', 'recent');
  assert.deepEqual(await sideNames(), ['side busy', 'side new', 'side old']);
  await page.selectOption('#side select', 'least');
  await page.click(`${srow('side new')} .srow-star`);
  await until(async () => (await api('GET', `/api/sessions/${sNew}`)).starred === true);
  await page.waitForFunction(() => document.querySelector('#side .srow .srow-name')?.textContent === 'side new');
  assert.equal(await page.textContent('#side [data-starred-first]'), '★', 'a star, not words');
  await page.click('#side [data-starred-first]');
  assert.deepEqual(await sideNames(), ['side old', 'side new', 'side busy'], 'stars no longer first');
  await page.click('#side [data-starred-first]');
  await page.click('#side .chip-t[data-show="working"]');
  assert.deepEqual(await sideNames(), ['side new', 'side old'], 'Working switched off');
  await page.click('#side .chip-t[data-show="working"]');
  await page.click('#side .seg button:text-is("Project")');
  const sideGroups = await page.$$eval('#side .side-body > *', (r) => r.map((x) => (x.classList.contains('sgroup') ? `# ${x.firstChild.textContent}` : x.querySelector('.srow-name').textContent)).filter((x) => x.startsWith('#') || x.startsWith('side ')));
  const posOf = (n) => sideGroups.indexOf(n);
  assert.ok(posOf('# Main') < posOf('side busy') && posOf('side busy') < posOf('# Second') && posOf('# Second') < posOf('side new') && posOf('side new') < posOf('# Work') && posOf('# Work') < posOf('side old'), `projects in tab order: ${sideGroups}`);
  assert.equal(await page.$(`${srow('side old')} .srow-sub`), null, 'grouped by project, rows leave the project out');
  await page.click('#side .seg button:text-is("Agent")');
  const byAgent = await page.$$eval('#side .side-body > *', (r) => r.map((x) => (x.classList.contains('sgroup') ? `# ${x.firstChild.textContent}` : x.querySelector('.srow-name').textContent)));
  assert.ok(byAgent.indexOf('# Codex') < byAgent.indexOf('side new') && byAgent.indexOf('# Claude') < byAgent.indexOf('side old'), `${byAgent}`);
  await page.click('#side .seg button:text-is("None")');
  await shot('14-sessions');

  const hiddenBefore = Number((await page.textContent('#side .chip-t[data-show="hidden"]')).split(' ')[1]);
  // Resizing: the right edge drags, and the width is kept.
  const w0 = await page.$eval('#side', (e) => e.getBoundingClientRect().width);
  const edge = await page.$eval('#side .side-resize', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 200 }; });
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 120, edge.y, { steps: 5 });
  await page.mouse.up();
  const w1 = await page.$eval('#side', (e) => e.getBoundingClientRect().width);
  assert.ok(Math.abs(w1 - (w0 + 120)) < 4, `resized from ${w0} to ${w1}`);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('belay.side')).width), Math.round(w1));

  // A click goes to the session in its project; it does not move it here.
  await page.click(srow('side old'));
  await page.waitForFunction(() => window.belay.dock.activeView().name === 'Work');
  assert.equal(await page.evaluate((id) => window.belay.dock.api.activePanel.id === `p-${id}`, sOld), true, 'its tab in its project is in front');
  assert.equal(await page.evaluate((id) => window.belay.dock.projects.get(window.belay.dock.views.find((v) => v.name === 'Main').id).api.panels.some((p) => p.id === `p-${id}`), sOld), false, 'it was not moved to the project you were in');
  assert.equal(await page.evaluate(() => window.belay.side.open), false, 'over the layout, it closes once you have gone');

  // Closing its tab hides it: listed under its project with Hidden on, and a click brings it back there.
  await page.evaluate((id) => window.belay.dock.api.getPanel(`p-${id}`).api.close(), sOld);
  await toProject('Main');
  await page.click('.rail-btn[data-side="sessions"]');
  await page.waitForSelector('#side:not(.hidden) .srow');
  assert.deepEqual(await sideNames(), ['side new', 'side busy'], 'hidden ones are left out');
  assert.equal(await page.textContent('#side .chip-t[data-show="hidden"]'), `Hidden ${hiddenBefore + 1}`);
  await page.click('#side .chip-t[data-show="hidden"]');
  assert.equal(await page.textContent(`${srow('side old')} .srow-sub`), 'Work · hidden');
  assert.equal(await page.$eval(srow('side old'), (e) => e.classList.contains('is-hidden')), true);
  await page.click('#side .seg button:text-is("Project")');
  assert.ok((await page.$$eval('#side .sgroup', (g) => g.map((x) => x.firstChild.textContent))).includes('Work'), 'still under its project');
  await page.click('#side .seg button:text-is("None")');
  await page.click(srow('side old'));
  await page.waitForFunction(() => window.belay.dock.activeView().name === 'Work');
  await page.waitForFunction((id) => window.belay.dock.api.activePanel?.id === `p-${id}`, sOld);
  assert.equal(await page.evaluate((id) => window.belay.dock.projects.get(window.belay.dock.views.find((v) => v.name === 'Main').id).api.panels.some((p) => p.id === `p-${id}`), sOld), false, 'reopened in its own project, not the one in front');
  await page.click('.rail-btn[data-side="sessions"]');
  assert.equal(await page.$eval(srow('side old'), (e) => e.classList.contains('is-hidden')), false, 'and no longer hidden');
  await page.click('#side .chip-t[data-show="hidden"]');

  await page.click('#side [data-act="pin"]');
  assert.equal(await page.$eval('#side', (e) => e.classList.contains('floating')), false);
  const dockLeft = await page.$eval('#dock', (e) => e.getBoundingClientRect().left);
  assert.ok(dockLeft > 300, 'pinned, it sits beside the layout');
  await page.click('.proj.active .dv-tab >> nth=0');
  assert.equal(await page.evaluate(() => window.belay.side.open), true, 'pinned, it stays open');
  await page.click('#side [data-act="pin"]');
  await page.mouse.click(1350, 500); // the layout, beside the sidebar that floats over it again
  await page.waitForSelector('#side.hidden', { state: 'attached' });
  for (const id of [sOld, sNew, sBusy]) await api('DELETE', `/api/sessions/${id}`);

  step("files sidebar: the project's directory as a tree, and a file opens in an editor tab");
  await toProject('Work');
  await page.waitForFunction(() => window.belay.dock.activeView().name === 'Work');
  await page.keyboard.press('Control+Shift+E');
  await page.waitForSelector('#side[data-view="files"] .frow[data-path]');
  assert.equal(await page.textContent('#side .froot'), projDir, "the project's directory");
  assert.equal(await page.$$eval('#side .frow[data-path]', (r) => r.every((x) => x.dataset.path.startsWith(x.closest('#side').querySelector('.froot').textContent))), true);
  assert.deepEqual(await page.$$eval('#side .frow .fname', (r) => r.map((x) => x.textContent)), ['..', 'sub'], '.. to go up, then its one directory');
  assert.equal(await page.$('#side [data-act="hidden"]'), null, 'dotfiles always show: no switch for them');
  // .. goes up a level, keeping the directory open below; ⌂ comes back.
  await page.click('#side .frow.up');
  await page.waitForFunction((d) => document.querySelector('#side .froot')?.textContent === d, path.dirname(projDir));
  await page.waitForSelector(`#side .frow[data-path="${projDir}/sub"]`);
  assert.equal(await page.$eval('#side .froot', (e) => e.classList.contains('away')), true, "marked as away from the project's directory");
  await page.click('#side [data-act="home"]');
  await page.waitForFunction((d) => document.querySelector('#side .froot')?.textContent === d, projDir);
  // A long list keeps its place: opening a directory or a file does not throw it back to the top.
  fs.mkdirSync(path.join(projDir, 'many', 'deep'), { recursive: true });
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(projDir, 'many', `f${String(i).padStart(2, '0')}.txt`), 'x\n');
  fs.writeFileSync(path.join(projDir, 'many', 'deep', `a-very-long-file-name-${'x'.repeat(80)}.txt`), 'x\n');
  await page.click('#side [data-act="refresh"]');
  await page.click('#side .frow:has(.fname:text-is("many"))');
  await page.waitForSelector(`#side .frow[data-path="${projDir}/many/f59.txt"]`);
  await page.$eval('#side .side-body', (b) => { b.scrollTop = b.scrollHeight; });
  const scrolled = await page.$eval('#side .side-body', (b) => b.scrollTop);
  assert.ok(scrolled > 200, 'the list is long enough to scroll');
  // Clicked in place: the test tool would otherwise scroll the row into view first, as a person would not need to.
  await page.$eval('#side .frow[data-path$="/many/deep"]', (r) => r.click());
  await page.waitForSelector('#side .frow[data-path*="a-very-long-file-name"]', { state: 'attached' });
  assert.ok(Math.abs(await page.$eval('#side .side-body', (b) => b.scrollTop) - scrolled) < 40, 'opening a directory keeps the place');
  assert.ok(await page.$eval('#side .side-body', (b) => b.scrollWidth > b.clientWidth + 50), 'a long name scrolls sideways rather than being cut off');
  await page.$eval(`#side .frow[data-path="${projDir}/many/f58.txt"]`, (r) => r.click());
  await page.waitForFunction(() => [...window.belay.panels.values()].some((p) => p.file?.path.endsWith('/many/f58.txt')));
  await page.keyboard.press('Control+Shift+E');
  await page.waitForSelector(`#side .frow.active[data-path="${projDir}/many/f58.txt"]`);
  assert.ok(Math.abs(await page.$eval('#side .side-body', (b) => b.scrollTop) - scrolled) < 40, 'opening a file keeps it too');
  const sizes = await page.$$eval('#side .side-head .btn.icon', (b) => b.map((x) => `${x.offsetWidth}x${x.offsetHeight}`));
  assert.equal(new Set(sizes).size, 1, `the head's buttons are all one square: ${sizes}`);
  await page.$eval('#side .frow[data-path$="/many"]', (r) => r.click());
  await page.evaluate(() => window.belay.dock.closePanel([...window.belay.panels.values()].find((p) => p.file).api.id));
  await page.click('#side .frow:has(.fname:text-is("sub"))');
  await page.waitForSelector(`#side .frow[data-path="${projDir}/sub/plan.md"]`);
  assert.ok((await page.$$eval('#side .frow .fname', (r) => r.map((x) => x.textContent))).includes('app.js'));
  await shot('15-files');
  await catchOpens(); // the page was reloaded since
  await page.click(`#side .frow[data-path="${projDir}/sub/app.js"]`, { button: 'right' });
  await page.click('.menu-item:has-text("Open in VS Code")');
  await until(() => vscodeOpens.length === 2);
  assert.equal(vscodeOpens[1], `vscode://vscode-remote/ssh-remote+devbox${projDir}/sub/app.js:1`, 'line 1 when there is none');
  assert.equal(await page.$('.modal'), null, 'no question the second time');
  await page.keyboard.press('Control+Shift+E');
  await page.click(`#side .frow[data-path="${projDir}/sub/plan.md"]`);
  await page.waitForFunction(() => [...window.belay.panels.values()].some((p) => p.file?.path.endsWith('/sub/plan.md') && p.editor), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.belay.side.open), false, 'over the layout, it gets out of the way');
  await page.keyboard.press('Control+Shift+E');
  await page.waitForSelector(`#side .frow.active[data-path="${projDir}/sub/plan.md"]`);
  await page.click('.rail-btn[data-side="sessions"]');
  await page.waitForSelector('#side[data-view="sessions"] .side-controls');
  await page.click('.rail-btn[data-side="sessions"]');
  await page.waitForSelector('#side.hidden', { state: 'attached' });
  await page.evaluate(() => window.belay.dock.closePanel([...window.belay.panels.values()].find((p) => p.file).api.id));

  step('viewers: an image, a PDF and a video open in tabs of their own, and a changed file is shown again');
  // A PNG of w×h in one color, written here so the test needs nothing else.
  const png = (w, h) => {
    const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [255, 102, 68]).flat())])));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  };
  const imgPath = path.join(projDir, 'sub', 'shot.png');
  fs.writeFileSync(imgPath, png(4, 3));
  await page.evaluate((p) => window.belay.dock.openFile({ path: p }), imgPath);
  await page.waitForFunction(() => document.querySelector('.proj.active .mv-img')?.naturalWidth === 4);
  assert.match(await page.textContent('.proj.active .mv .np-status'), /^image · \d+ B · 4 × 3$/);
  assert.equal(await page.textContent('.proj.active .dv-tab.dv-active-tab .ttab-note'), '▣');
  await page.waitForTimeout(1100); // a different modification time, to the second
  fs.writeFileSync(imgPath, png(8, 6));
  await page.waitForFunction(() => document.querySelector('.proj.active .mv-img')?.naturalWidth === 8, null, { timeout: 8000 });
  await page.click('.proj.active .mv [data-act="close"]');
  const pdfPath = path.join(projDir, 'sub', 'doc.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  await page.evaluate((p) => window.belay.dock.openFile({ path: p }), pdfPath);
  await page.waitForSelector('.proj.active .mv-frame');
  assert.match(await page.getAttribute('.proj.active .mv-frame', 'src'), /^\/api\/files\/raw\?path=.*doc\.pdf/, "the browser's own PDF viewer, in a frame");
  assert.equal(await page.evaluate(() => window.belay.panels.get(window.belay.dock.api.activePanel.id).kind), 'pdf', 'a viewer, not the editor');
  await page.click('.proj.active .mv [data-act="close"]');
  let ffmpeg = null;
  try { ffmpeg = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim(); } catch {}
  if (ffmpeg) {
    const vid = path.join(projDir, 'sub', 'clip.webm');
    execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x48:rate=10', '-c:v', 'libvpx', '-y', vid]);
    await page.evaluate((p) => window.belay.dock.openFile({ path: p }), vid);
    await page.waitForFunction(() => document.querySelector('.proj.active .mv-video-el')?.readyState >= 1, null, { timeout: 10000 });
    assert.match(await page.textContent('.proj.active .mv .np-status'), /^video · [\d.]+ KB · 0:02 · 64 × 48$/);
    // Seeking needs ranges: the player asks for a part of the file and gets it.
    await page.evaluate(() => { document.querySelector('.proj.active .mv-video-el').currentTime = 1.5; });
    await page.waitForFunction(() => Math.abs(document.querySelector('.proj.active .mv-video-el').currentTime - 1.5) < 0.2 && !document.querySelector('.proj.active .mv-video-el').seeking);
    await page.click('.proj.active .mv [data-act="close"]');
  } else console.log('  (no ffmpeg here: the video part is skipped)');

  step('post-it wall: one per project, notes nest by sitting inside each other and move together, colors, multi-select, the preview');
  const wallPane = () => page.evaluate(() => { const p = [...window.belay.panels.values()].find((x) => x.wallId); return p && { id: p.wallId, items: p.items.map((i) => ({ ...i })), selected: [...p.selected] }; });
  await palette('Show / hide project post-its');
  await page.waitForSelector('.proj.active .wl-board');
  assert.equal(await page.textContent('.proj.active .dv-tab.dv-active-tab .ttab-name'), 'Work post-its');
  const bb = await page.$eval('.proj.active .wl-board', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await page.mouse.dblclick(bb.x + 220, bb.y + 160);
  await page.keyboard.type('Group A');
  await page.keyboard.press('Escape');
  await page.mouse.dblclick(bb.x + 620, bb.y + 160);
  await page.keyboard.type('loose');
  await page.keyboard.press('Escape');
  let wl = await wallPane();
  assert.deepEqual(wl.items.map((i) => i.text), ['Group A', 'loose']);
  // + Notes with Group A selected: a pasted list, one note per line, goes inside it, which grows to hold them.
  await page.click('.proj.active .wl-note:has(.wl-text:text-is("Group A"))');
  await page.click('.proj.active .wl [data-act="add"]');
  await page.waitForSelector('.modal-head h3:text-is("Add notes")');
  assert.match(await page.textContent('.modal .hint'), /They go into "Group A"/);
  await page.fill('.modal textarea', 'child one\n\n  child two  \n');
  assert.equal(await page.textContent('.modal .btn.primary'), 'Add 2 notes', 'blank lines are skipped');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => [...window.belay.panels.values()].find((x) => x.wallId).items.length === 4);
  assert.deepEqual((await wallPane()).selected.length, 2, 'the new notes are left selected');
  await page.keyboard.press('Escape');
  const zOf = (t) => page.$eval(`.proj.active .wl-note:has(.wl-text:text-is("${t}"))`, (e) => Number(e.style.zIndex));
  assert.equal(await page.$eval('.proj.active .wl-note:has(.wl-text:text-is("Group A"))', (e) => e.classList.contains('container')), true, 'a note with notes inside is a group');
  assert.ok(await zOf('child one') > await zOf('Group A') && await zOf('child two') > await zOf('Group A'), 'what is inside sits in front, on its own');
  wl = await wallPane();
  const pos = (items, t) => items.find((i) => i.text === t);
  const ga = await page.$eval('.proj.active .wl-note.container', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 60, y: r.top + 10 }; });
  await page.mouse.move(ga.x, ga.y);
  await page.mouse.down();
  await page.mouse.move(ga.x + 50, ga.y + 30, { steps: 5 });
  await page.mouse.up();
  const moved = (await wallPane()).items;
  for (const t of ['Group A', 'child one', 'child two']) assert.deepEqual([pos(moved, t).x - pos(wl.items, t).x, pos(moved, t).y - pos(wl.items, t).y], [50, 30], `${t} moved with its group`);
  assert.deepEqual([pos(moved, 'loose').x, pos(moved, 'loose').y], [pos(wl.items, 'loose').x, pos(wl.items, 'loose').y], 'what is not inside stays');
  // With another note selected, the note you drag becomes the selection.
  await page.click('.proj.active .wl-note:has(.wl-text:text-is("loose"))');
  const looseId = pos((await wallPane()).items, 'loose').id;
  assert.deepEqual((await wallPane()).selected, [looseId]);
  await page.mouse.move(ga.x + 50, ga.y + 30);
  await page.mouse.down();
  await page.mouse.move(ga.x, ga.y, { steps: 5 });
  await page.mouse.up();
  assert.deepEqual((await wallPane()).selected, [pos(moved, 'Group A').id], 'the dragged note is now the one selected');
  await page.keyboard.press('Escape');
  // Shift+drag selects; the 🎨 steps every selected note through the palette; the pickers choose exactly.
  await page.keyboard.down('Shift');
  await page.mouse.move(bb.x + 5, bb.y + 5);
  await page.mouse.down();
  await page.mouse.move(bb.x + 1100, bb.y + 620, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  assert.equal((await wallPane()).selected.length, 4);
  await page.click('.proj.active .wl [data-act="cycle"]');
  assert.deepEqual([...new Set((await wallPane()).items.map((i) => i.color))], ['#aaaaaa'], 'yellow, then gray for done');
  for (const want of ['#55cc55', '#ff6644', '#ffff88']) {
    await page.click('.proj.active .wl [data-act="cycle"]');
    assert.deepEqual([...new Set((await wallPane()).items.map((i) => i.color))], [want], 'then green, red, and back to yellow: four states');
  }
  await page.$eval('.proj.active .wl-selbar input[title="Note color"]', (el) => { el.value = '#123456'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.deepEqual([...new Set((await wallPane()).items.map((i) => i.color))], ['#123456']);
  assert.deepEqual([...new Set((await wallPane()).items.map((i) => i.fontColor))], ['#ffffff'], 'a dark note gets light text');
  // Shift+click takes one out of the selection; Delete deletes the rest of them... here just the one left selected.
  await page.keyboard.press('Escape');
  await page.click('.proj.active .wl-note:has(.wl-text:text-is("loose"))');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => ![...window.belay.panels.values()].find((x) => x.wallId).items.some((i) => i.text === 'loose'));
  // The preview: a click there moves the view.
  const v0 = await page.evaluate(() => ({ ...[...window.belay.panels.values()].find((x) => x.wallId).view }));
  const mini = await page.$eval('.proj.active .wl-mini', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 }; });
  await page.mouse.click(mini.x, mini.y);
  const v1 = await page.evaluate(() => ({ ...[...window.belay.panels.values()].find((x) => x.wallId).view }));
  assert.ok(v1.x !== v0.x || v1.y !== v0.y, 'the preview moves the view');
  await shot('16-postits');
  // Saved on the server, and back as it was after hiding it.
  const wallId = (await wallPane()).id;
  await until(async () => (await api('GET', `/api/walls/${wallId}`)).items.length === 3);
  assert.equal((await api('GET', '/api/state')).projects.find((v) => v.name === 'Work').wallId, wallId, 'the project keeps its wall');
  await palette('Show / hide project post-its');
  await page.waitForFunction(() => ![...window.belay.panels.values()].some((x) => x.wallId));
  await page.click('.proj.active .gadd-btn >> nth=0');
  await page.click('.menu-item:has-text("Post-its")');
  await page.waitForFunction(() => [...window.belay.panels.values()].find((x) => x.wallId)?.items.length === 3);
  assert.deepEqual((await wallPane()).items.map((i) => i.text).sort(), ['Group A', 'child one', 'child two']);
  await palette('Show / hide project post-its');

  step('next tab past the last carries on into the next project, previous before the first goes back');
  assert.deepEqual(await projectNames(), ['Main', 'Second', 'Work', 'Box']);
  await toProject('Work');
  await page.evaluate(() => { const t = window.belay.dock.current().tabs(); t[t.length - 1].api.setActive(); });
  await page.keyboard.press('Control+Tab');
  await page.waitForFunction(() => window.belay.dock.activeView().name === 'Box');
  assert.equal(await page.evaluate(() => window.belay.dock.api.activePanel.id === window.belay.dock.current().tabs()[0].id), true, 'lands on the first tab');
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForFunction(() => window.belay.dock.activeView().name === 'Work');
  assert.equal(await page.evaluate(() => { const t = window.belay.dock.current().tabs(); return window.belay.dock.api.activePanel.id === t[t.length - 1].id; }), true, 'lands on the last tab');

  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.proj:not(.active) *')].filter((e) => getComputedStyle(e).visibility === 'visible').map((e) => e.className)), [], 'nothing of a hidden project shows through');

  step('dragging a project tab reorders the projects');
  const box = await page.$('.vtab:has(.vtab-name:text-is("Box"))');
  await page.dragAndDrop('.vtab:has(.vtab-name:text-is("Box"))', '.vtab:has(.vtab-name:text-is("Main"))', { targetPosition: { x: 3, y: 10 } });
  await until(async () => JSON.stringify(await projectNames()) === JSON.stringify(['Box', 'Main', 'Second', 'Work']));
  const workBox = await (await page.$('.vtab:has(.vtab-name:text-is("Work"))')).boundingBox();
  await page.dragAndDrop('.vtab:has(.vtab-name:text-is("Box"))', '.vtab:has(.vtab-name:text-is("Work"))', { targetPosition: { x: workBox.width - 3, y: 10 } });
  await until(async () => JSON.stringify(await projectNames()) === JSON.stringify(['Main', 'Second', 'Work', 'Box']));
  void box;
  await until(async () => (await api('GET', '/api/state')).projects.map((v) => v.name).join() === 'Main,Second,Work,Box');

  step('dragging a tab onto another project moves it there');
  await toProject('Box');
  await page.dragAndDrop(tabOf(dup), '.vtab:has(.vtab-name:text-is("Main"))');
  await page.waitForFunction(() => window.belay.dock.activeView().name === 'Main');
  await page.waitForFunction((id) => window.belay.panels.has(`p-${id}`), dup.id);
  await toProject('Box');
  await page.waitForFunction(() => window.belay.panels.size === 2); // Box claude and Box shell (the note was deleted above)
  assert.equal(await page.evaluate((id) => window.belay.panels.has(`p-${id}`), dup.id), false);
  await toProject('Main');
  await page.waitForFunction(() => window.belay.dock.activeView().name === 'Main');
  // The Mac page below expects Main as the active project with a live shell in front.
  await page.evaluate((id) => window.belay.dock.api.getPanel(`p-${id}`).api.close(), dup.id);
  for (let i = 0; i < 50 && JSON.stringify((await api('GET', '/api/state')).projects).includes(dup.id); i++) await sleep(100);

  step('closing a project hides it: its sessions stay its own, and opening one brings it back as it was');
  const boxId = await page.evaluate(() => window.belay.dock.views.find((v) => v.name === 'Box').id);
  await page.click('.vtab:has(.vtab-name:text-is("Box"))', { button: 'right' });
  await page.click('.menu-item:has-text("Close project")');
  await until(async () => JSON.stringify(await projectNames()) === JSON.stringify(['Main', 'Second', 'Work']));
  await until(async () => (await api('GET', '/api/state')).projects.find((v) => v.id === boxId)?.hidden === true);
  assert.equal((await api('GET', `/api/sessions/${rc.id}`)).project, boxId, 'its sessions are still its own');
  await page.evaluate(() => window.belay.side.toggle('sessions', true));
  await page.waitForSelector('#side[data-view="sessions"] [data-show="hidden"]');
  if (!(await page.$('#side [data-show="hidden"].on'))) await page.click('#side [data-show="hidden"]');
  await page.waitForSelector(`#side .srow.is-hidden[data-sid="${rc.id}"]`);
  await page.click(`#side .srow[data-sid="${rc.id}"]`);
  await page.waitForFunction((id) => window.belay.dock.activeView().id === id, boxId);
  await page.waitForFunction((id) => window.belay.panels.has(`p-${id}`), rc.id);
  assert.deepEqual(await projectNames(), ['Main', 'Second', 'Work', 'Box'], 'back, where it was');
  assert.equal((await api('GET', '/api/state')).projects.find((v) => v.id === boxId).hidden, false);
  await page.keyboard.press('Escape');
  // Deleting is for good, from its menu, and asks first.
  await page.evaluate(() => window.belay.dock.addView({ name: 'Scratch' }));
  await page.click('.vtab:has(.vtab-name:text-is("Scratch"))', { button: 'right' });
  await page.click('.menu-item:has-text("Delete project…")');
  await page.click('.modal .btn:text-is("Delete")');
  await until(async () => !(await api('GET', '/api/state')).projects.some((v) => v.name === 'Scratch'));
  await toProject('Main');

  step('a session is starred from its own bar, and the Sessions list marks the one in front');
  await toProject('Box');
  await page.evaluate((id) => { window.belay.dock.api.getPanel(`p-${id}`).api.setActive(); }, rc.id);
  await page.click(`.proj.active .tp:has(.tp-name:text-is("${rc.name}")) [data-act="star"]`);
  await until(async () => (await api('GET', `/api/sessions/${rc.id}`)).starred === true);
  await page.waitForSelector(`.proj.active .tp:has(.tp-name:text-is("${rc.name}")) [data-act="star"].on`);
  await page.evaluate(() => window.belay.side.toggle('sessions', true));
  await page.waitForSelector(`#side .srow.is-current[data-sid="${rc.id}"]`);
  assert.equal(await page.$eval(`#side .srow[data-sid="${rc.id}"] .srow-star`, (b) => b.textContent), '★', 'starred in the list too');
  await page.click(`.proj.active .tp:has(.tp-name:text-is("${rc.name}")) [data-act="star"]`);
  await until(async () => (await api('GET', `/api/sessions/${rc.id}`)).starred === false);
  await page.keyboard.press('Escape');
  await toProject('Main');

  step('many projects never make the page wider than the window: their tabs scroll instead');
  const extra = await page.evaluate(() => Array.from({ length: 14 }, (_, i) => window.belay.dock.addView({ name: `A rather long project name ${i}` }).id));
  await toProject('Main');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), true, 'nothing past the right edge');
  const helpInView = await page.$eval("#btn-help", (b) => { const r = b.getBoundingClientRect(); return r.right <= innerWidth && r.width > 0; });
  assert.equal(helpInView, true, "the buttons on the right stay in view");
  await page.evaluate((ids) => { for (const id of ids) window.belay.dock.removeView(id); }, extra);
  await toProject('Main');

  step('Reload window, from the palette: the page again, the sessions as they were');
  await page.evaluate(() => { window.beforeReload = true; });
  await page.keyboard.press('Control+Shift+P');
  await page.fill('.pal-input', 'reload window');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.beforeReload && window.belay?.dock?.activeView(), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.belay.dock.activeView().name), 'Main');

  step('with a token, a remote page signs itself in, in its tab (a frame of another site) and opened on its own');
  {
    const tokDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-ui-tok-'));
    const tokPort = port + 1;
    const tokServer = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, BELAY_HOST: '127.0.0.1', BELAY_TOKEN: 'ui-secret', BELAY_PORT: String(tokPort), BELAY_DATA_DIR: tokDir }, stdio: ['ignore', 'ignore', 'inherit'] });
    try {
      for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${tokPort}/api/health`); break; } catch {} await sleep(50); }
      const app2 = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(`<!doctype html><html><head></head><body><h1 id="t">signed in ${q.url}</h1><p id="ws">…</p><script>const w = new WebSocket('ws://' + location.host + '/ws'); w.onmessage = (e) => { document.getElementById('ws').textContent = e.data; };</script></body></html>`); });
      new WebSocketServer({ server: app2 }).on('connection', (ws) => ws.send('ws signed in'));
      await new Promise((r) => app2.listen(0, '127.0.0.1', r));
      const tp = await browser.newPage();
      await tp.goto(`http://localhost:${tokPort}/?token=ui-secret`);
      await tp.waitForFunction(() => window.belay?.dock);
      await tp.evaluate((p) => window.belay.dock.openWeb({ address: `localhost:${p}/in-a-tab`, title: 'app', remote: true }), app2.address().port);
      const inTab = await until(() => tp.frames().find((f) => /page-[0-9a-f]+\.localhost/.test(f.url())));
      await inTab.waitForFunction(() => document.getElementById('ws')?.textContent === 'ws signed in', null, { timeout: 8000 });
      assert.equal(await inTab.textContent('#t'), 'signed in /in-a-tab', 'the page in its tab is signed in, WebSocket and all');
      const [own] = await Promise.all([tp.waitForEvent('popup'), tp.click('.proj.active .wv [data-act="open"]')]);
      await own.waitForFunction(() => document.getElementById('t')?.textContent === 'signed in /in-a-tab', null, { timeout: 8000 });
      await own.close();
      await tp.close();
      app2.close();
    } finally {
      await new Promise((r) => { tokServer.once('exit', r); tokServer.kill('SIGTERM'); });
      fs.rmSync(tokDir, { recursive: true, force: true });
    }
  }

  step('macOS gets Cmd chords: Cmd+Shift+P, Cmd+Shift+D, Cmd+1, Cmd+Left / Right, Cmd+W');
  const mac = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  mac.on('pageerror', (e) => errors.push(`[mac pageerror] ${e.message}`));
  const cdp = await mac.context().newCDPSession(mac);
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', platform: 'MacIntel' });
  await mac.goto(BASE);
  await mac.waitForFunction(() => window.belay?.dock && window.belay.panels.size >= 1, null, { timeout: 10000 });
  assert.equal(await mac.evaluate(() => window.belay.keys.bindings('palette').join()), 'Cmd+Shift+P');
  assert.equal(await mac.evaluate(() => document.getElementById('btn-palette').title), 'Command palette (Cmd+Shift+P)');
  await mac.keyboard.press('Meta+Shift+P');
  await mac.waitForFunction(() => document.activeElement?.classList.contains('pal-input'));
  assert.match(await mac.textContent('.pal-list'), /Cmd\+T/);
  await mac.keyboard.press('Escape');
  await mac.waitForFunction(() => !document.querySelector('.pal-input'));
  const before = await mac.$$eval('.vtab', (t) => t.length);
  await mac.keyboard.press('Meta+Shift+D');
  await mac.waitForSelector('.modal-head h3:text-is("New project")');
  await mac.keyboard.press('Enter');
  await mac.waitForFunction((n) => document.querySelectorAll('.vtab').length === n + 1, before);
  await mac.waitForSelector('.proj.active .watermark');
  assert.match(await mac.textContent('.proj.active .watermark .hint'), /^Cmd\+Shift\+P opens/);
  await mac.keyboard.press('Meta+1');
  await mac.waitForFunction(() => document.querySelectorAll('.vtab')[0]?.classList.contains('active'));
  await mac.waitForFunction(() => [...window.belay.panels.values()].some((p) => p.attached));
  await spyInput(mac);
  await mac.evaluate(() => [...window.belay.panels.values()].find((p) => p.attached).focus());
  await mac.keyboard.press('Meta+ArrowLeft');
  await mac.keyboard.press('Meta+ArrowRight');
  assert.deepEqual(await takeSent(mac), ['\x01', '\x05'], 'Cmd+Left / Right go to the start / end of the line');
  // Cmd+W closes the tab in front (the installed app hands it to belay), not the window; its session runs on.
  const shut = await mac.evaluate(() => window.belay.dock.api.activePanel.id);
  const shutSid = await mac.evaluate(() => window.belay.dock.api.activePanel.params.sessionId);
  await mac.keyboard.press('Meta+W');
  await mac.waitForFunction((id) => !window.belay.dock.api.getPanel(id), shut);
  assert.equal((await (await fetch(`${BASE}/api/sessions/${shutSid}`)).json()).status, 'running', 'closing the tab leaves its session running');
  assert.deepEqual(await page.evaluate(() => window.belay.keys.bindings('close-pane')), ['Ctrl+Shift+W', 'Ctrl+Shift+X'], 'outside macOS: Ctrl+Shift+W, since Ctrl+W deletes a word in the shell');
  await mac.keyboard.press('Control+Shift+P');
  await sleep(200);
  assert.equal(await mac.$('.pal-input'), null, 'Ctrl chord is not bound on macOS');
  await mac.click('#btn-help');
  await mac.waitForSelector('.modal .kbd');
  const help = await mac.textContent('.modal .kbd');
  assert.match(help, /Next tab in project\s*Cmd\+Shift\+\]Ctrl\+Tab/);
  assert.match(help, /Cmd\+C Cmd\+V/);
  if (shots) await mac.screenshot({ path: path.join(shots, '10-mac-help.png') });
  await mac.keyboard.press('Escape');
  await mac.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nUI test passed');
} catch (e) {
  console.error('\nUI test FAILED:', e.message, (e.stack || '').split('\n').find((l) => l.includes('ui.mjs')) || '');
  if (errors.length) console.error(errors.join('\n'));
  // What was on the screen: any dialog open, and a picture of it.
  const open = await page.evaluate(() => document.getElementById('modals')?.innerText.trim()).catch(() => '');
  if (open) console.error(`A dialog was open: ${open.slice(0, 300)}`);
  const tabs = await page.evaluate(() => [...window.belay.panels.keys()]).catch(() => []);
  const known = await fetch(`${BASE}/api/sessions`).then((r) => r.json()).then((l) => l.map((x) => `${x.id} ${x.name} ${x.status}`)).catch(() => []);
  console.error(`Tabs: ${tabs.join(', ')}\nSessions:\n  ${known.join('\n  ')}`);
  await page.screenshot({ path: path.join(shots || os.tmpdir(), 'FAILED.png') }).then(() => console.error(`Screenshot: ${path.join(shots || os.tmpdir(), 'FAILED.png')}`)).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); });
  await stopHolder(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
}
