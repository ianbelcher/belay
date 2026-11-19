import './app.css';
import { Client } from './client.js';
import { Dock } from './dock.js';
import { Keys, displayChord } from './keys.js';
import * as ui from './ui.js';
import { installPageKeys } from './web.js';
import { SessionsView } from './sessions.js';
import { FilesView } from './files.js';
import { SideBar } from './side.js';

const app = {
  client: new Client(),
  ui,
  dock: null,
  installPrompt: null,
  settings() { return this.client.state.settings || {}; },
  /** Panes of the project in front, by dockview panel id. */
  get panels() { return this.dock?.current()?.panels || new Map(); },
  /** Panes of every project: they all stay live. */
  allPanels() { return this.dock ? [...this.dock.projects.values()].flatMap((p) => [...p.panels.values()]) : []; },
  activePanel() {
    const id = this.dock?.api?.activePanel?.id;
    return (id && this.panels.get(id)) || null;
  },
  applySettings() {
    const st = this.settings();
    document.documentElement.dataset.theme = st.theme || 'dark';
    // In the app, the window's own buttons (outside macOS) are drawn over the top bar, in its colours.
    if (window.belayApp?.setTitleBarColors) {
      const css = getComputedStyle(document.documentElement);
      window.belayApp.setTitleBarColors({ color: css.getPropertyValue('--bg2').trim(), symbolColor: css.getPropertyValue('--fg').trim() });
    }
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', st.theme === 'light' ? '#f3f4f6' : '#171a21');
    this.dock?.setTheme(st.theme);
    for (const p of this.allPanels()) p.applySettings?.();
    this.keys.rebuild();
    const pal = this.keys.bindings('palette')[0];
    document.getElementById('btn-palette').title = pal ? `Command palette (${displayChord(pal)})` : 'Command palette';
  },
  async toggleTheme() {
    const theme = this.settings().theme === 'light' ? 'dark' : 'light';
    try { await this.client.api('PUT', '/api/settings', { theme }); } catch (e) { ui.toast(e.message); }
  },
  async installApp() {
    if (!this.installPrompt) { ui.toast('Open belay in Chrome or Edge over localhost or HTTPS, then use the browser’s Install option.', 'info'); return; }
    const p = this.installPrompt;
    this.installPrompt = null;
    document.getElementById('btn-install').classList.add('hidden');
    try { await p.prompt(); } catch {}
  },
};
window.belay = app;
app.keys = new Keys(app);

const conn = document.getElementById('conn');
const setConn = (ok) => { conn.className = `conn ${ok ? 'on' : 'off'}`; conn.title = ok ? 'Connected' : 'Reconnecting…'; };

app.client.on('hello', () => {
  if (!app.dock) {
    app.applySettings();
    app.dock = new Dock(app, document.getElementById('dock'));
    app.dock.ensureViews();
    app.dock.loadActive();
  } else {
    app.applySettings();
    app.dock.onRemoteViews();
    for (const p of app.allPanels()) p.reattach?.();
  }
  if (!app.side) app.side = new SideBar(app, [new SessionsView(app), new FilesView(app)]);
  app.side.refresh();
  setConn(true);
});
app.client.on('disconnected', () => setConn(false));
app.client.on('session', () => { app.side?.refresh(); app.dock?.renderTabs(); });
app.client.on('session-removed', (e) => { app.dock?.onSessionRemoved(e.detail); app.side?.refresh(); });
app.client.on('views', () => app.dock?.onRemoteViews());
app.client.on('settings', () => app.applySettings());
app.client.on('templates', () => app.side?.refresh());
app.client.on('error', (e) => ui.toast(e.detail.message));

document.getElementById('btn-palette').addEventListener('click', () => ui.openPalette(app));
document.getElementById('btn-settings').addEventListener('click', () => ui.openSettings(app));
document.getElementById('btn-help').addEventListener('click', () => ui.openHelp(app));
document.getElementById('btn-install').addEventListener('click', () => app.installApp());

// In a browser, belay can be installed as an app of its own: Chrome fires this when the page qualifies, and the
// prompt is kept for belay's button. The Belay app (window.belayApp) is that already.
if (!window.belayApp) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    app.installPrompt = e;
    if (!matchMedia('(display-mode: standalone)').matches) document.getElementById('btn-install').classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => { app.installPrompt = null; document.getElementById('btn-install').classList.add('hidden'); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// In the app the top bar is the window's title bar (see app.css): which system, for the room its buttons need.
if (window.belayApp) {
  document.body.classList.add('in-app', `app-${window.belayApp.platform}`);
  window.belayApp.onFullScreen?.((on) => document.body.classList.toggle('app-fullscreen', on));
}

app.keys.install();
installPageKeys(app);
app.client.connect();
