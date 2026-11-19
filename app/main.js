// The Belay app: a window on belay, with belay's server running in this process. Closing the window (or
// quitting) never ends a session: the holders keep them, here and on every host, and the next launch
// carries on where it was.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isMac = process.platform === 'darwin';

if (!app.requestSingleInstanceLock()) app.exit(0);

// An app started from the Dock or a launcher gets a bare environment: the sessions want the user's shell.
if (!process.env.SHELL) process.env.SHELL = os.userInfo().shell || (isMac ? '/bin/zsh' : '/bin/sh');
const dataDir = path.resolve(process.env.BELAY_DATA_DIR || path.join(os.homedir(), '.belay'));
// The holder's builds, for this machine and for the hosts it reaches.
process.env.BELAY_HOLD_DIST = app.isPackaged ? path.join(process.resourcesPath, 'hold') : path.join(root, 'hold', 'dist');

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
const anyPort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/**
 * The app's own settings, chosen once: its port, which sessions on hosts report back to (so it must stay
 * the same from one launch to the next), and the token that keeps other programs here out of belay.
 */
async function appSettings() {
  const file = path.join(dataDir, 'app.json');
  let conf = {};
  try { conf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let changed = false;
  if (!conf.token) { conf.token = crypto.randomBytes(24).toString('base64url'); changed = true; }
  const wanted = Number(process.env.BELAY_PORT) || conf.port || 7681;
  const port = (await portFree(wanted)) ? wanted : await anyPort();
  if (port !== conf.port && !process.env.BELAY_PORT) { conf.port = port; changed = true; }
  if (changed) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
  }
  return { port, token: conf.token };
}

let belay = null;
let baseUrl = '';
let token = '';

/** Belay's own pages (and its remote pages, under page-*.localhost) stay in the app; everything else opens in its own app. */
function ours(url) {
  try {
    const u = new URL(url);
    const b = new URL(baseUrl);
    return u.port === b.port && (u.hostname === b.hostname || u.hostname.endsWith('.localhost'));
  } catch { return false; }
}

/**
 * The window's own title bar gives way to belay's top bar, which the window's buttons sit in: on macOS the
 * traffic lights on its left, centred in its 40 px; elsewhere minimize, maximize and close drawn over its right
 * end, in its colours (the page sets them to match its theme). The page makes room for them.
 */
const TOPBAR = 40;
const windowChrome = isMac
  ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 } }
  : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#171a21', symbolColor: '#d8dee9', height: TOPBAR - 1 } };

ipcMain.on('titlebar-colors', (e, { color, symbolColor } = {}) => {
  if (isMac || typeof color !== 'string' || typeof symbolColor !== 'string') return;
  BrowserWindow.fromWebContents(e.sender)?.setTitleBarOverlay?.({ color, symbolColor, height: TOPBAR - 1 });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    title: 'Belay',
    backgroundColor: '#0f1115',
    ...windowChrome,
    webPreferences: { preload: path.join(root, 'app', 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // Full screen, macOS hides the traffic lights: the page takes their room back.
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ours(url)) return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#0f1115' } };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // vscode:// links and the like are for their own apps, not this window.
  win.webContents.on('will-navigate', (e, url) => {
    if (ours(url)) return;
    e.preventDefault();
    shell.openExternal(url);
  });
  win.loadURL(`${baseUrl}/?token=${encodeURIComponent(token)}`);
  return win;
}

/**
 * The menu has what macOS needs (copy and paste in text fields go through it) and nothing that takes belay's
 * own keys: Cmd+W closes a tab, Cmd+T opens one, Cmd+N and the tab chords are belay's.
 */
function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'New Window', click: () => createWindow() },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'quit' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  const settings = await appSettings();
  token = settings.token;
  const { start, config } = await import('../server/index.js');
  const { lockDataDir } = await import('../server/lock.js');
  try {
    await lockDataDir(dataDir);
  } catch (e) {
    dialog.showErrorBox('Belay is already running', `Another belay is using ${dataDir}.\n\n${e.message}`);
    app.exit(1);
    return;
  }
  belay = start({ ...config(), host: '127.0.0.1', port: settings.port, dataDir, token, signals: false });
  baseUrl = belay.baseUrl;
  await belay.listening;
  buildMenu();
  createWindow();
}

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); } else if (belay) createWindow();
});
// On macOS the app stays when its windows close (the sessions carry on either way); elsewhere it quits.
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('activate', () => { if (belay && !BrowserWindow.getAllWindows().length) createWindow(); });
let quitting = false;
app.on('before-quit', (e) => {
  if (!belay || quitting) return;
  e.preventDefault();
  quitting = true;
  belay.close('quitting').finally(() => app.exit(0));
});

app.whenReady().then(boot).catch((e) => {
  dialog.showErrorBox('Belay could not start', String(e?.stack || e));
  app.exit(1);
});
