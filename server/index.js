import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { SessionManager } from './sessions.js';
import { createWs } from './ws.js';
import { createApi } from './api.js';
import { lockDataDir } from './lock.js';
import { createPages } from './pages.js';
import { Tunnels } from './tunnels.js';
import { expandHome, log, sendJson } from './util.js';
import { AGENT_IDS } from '../shared/template-core.js';
import { closeShared } from './ssh.js';


const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const HOOK_PATH = new RegExp(`^/api/hook/(${AGENT_IDS.join('|')})$`);

export function config(env = process.env) {
  const port = Number(env.BELAY_PORT || 7681);
  // Kubernetes sets BELAY_PORT=tcp://<ip>:<port> in pods next to a service named belay
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`BELAY_PORT must be a port number, not "${env.BELAY_PORT}"`);
  return {
    host: env.BELAY_HOST || '127.0.0.1',
    port,
    dataDir: path.resolve(expandHome(env.BELAY_DATA_DIR || path.join(os.homedir(), '.belay'))),
    token: env.BELAY_TOKEN || '',
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf',
};

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (!path.extname(p) && p !== '/index.html') { // SPA fallback
        serveStatic(req, res, new URL('/', url));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': p === '/index.html' || p === '/sw.js' || p === '/manifest.webmanifest' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><title>belay</title>
<style>body{font:15px system-ui;background:#0f1115;color:#d8dee9;display:grid;place-items:center;height:100vh;margin:0}
form{background:#171a21;padding:28px;border-radius:10px;border:1px solid #2a2f3a;display:grid;gap:12px;min-width:300px}
input{font:inherit;padding:8px;border-radius:6px;border:1px solid #2a2f3a;background:#0f1115;color:inherit}
button{font:inherit;padding:8px;border-radius:6px;border:0;background:#4c8dff;color:#fff;cursor:pointer}</style>
<form method="get" action="/"><b>belay</b><label>Access token<br><input name="token" type="password" autofocus></label><button>Open</button></form>`;

export function start(cfg = config()) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const baseUrl = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
  const store = new Store(cfg.dataDir);
  store.load();
  const mgr = new SessionManager({ store, dataDir: cfg.dataDir, baseUrl, port: cfg.port });
  const tunnels = new Tunnels();
  const pages = createPages({ store, token: cfg.token, tunnels });
  let broadcastRef = () => {};
  const api = createApi({ mgr, store, dataDir: cfg.dataDir, port: cfg.port, baseUrl, pages, broadcast: (m) => broadcastRef(m) });
  const { wss, all } = createWs({ mgr, getState: api.state });
  broadcastRef = all;

  // A request another page made: refused, cookie or not. Remote pages live on subdomains of belay's own name,
  // which browsers count as the same site, so SameSite alone would let them send belay's cookie.
  const foreign = (req) => {
    const o = req.headers.origin;
    if (o == null) return false;
    try { const h = new URL(o).host; return h !== req.headers.host && h !== req.headers['x-forwarded-host']; } catch { return true; }
  };
  const authorized = (req, url) => {
    if (foreign(req)) return false;
    if (!cfg.token) return true;
    if (HOOK_PATH.test(url.pathname)) return true; // localhost hook, session id is the secret
    return parseCookies(req).belay === cfg.token;
  };

  const server = http.createServer(async (req, res) => {
    if (pages.handle(req, res)) return;
    const url = new URL(req.url, baseUrl);
    if (foreign(req)) { sendJson(res, 403, { error: 'cross-origin request refused' }); return; }
    if (!authorized(req, url)) {
      const t = url.searchParams.get('token');
      if (t && t === cfg.token) {
        url.searchParams.delete('token');
        res.writeHead(302, { 'Set-Cookie': `belay=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, Location: url.pathname + url.search });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/')) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE);
      return;
    }
    if (await api(req, res, url)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    serveStatic(req, res, url);
  });

  server.on('upgrade', (req, socket, head) => {
    if (pages.upgrade(req, socket, head)) return;
    const url = new URL(req.url, baseUrl);
    if (url.pathname !== '/ws' || !authorized(req, url)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      const n = mgr.bootAll();
      log(`belay listening on ${baseUrl}  data=${cfg.dataDir}  sessions=${store.state.sessions.length} following=${n}${cfg.token ? '  auth=token' : ''}`);
      if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && !cfg.token) log('WARNING: listening on a non-local address without BELAY_TOKEN');
      resolve();
    });
  });

  /** Saves state and scrollback and stops serving; the sessions carry on in their holders. At most a couple of seconds. */
  let closing = null;
  const close = (why = 'closing') => {
    if (closing) return closing;
    log(`${why}: saving state and scrollback; the sessions carry on in their holders`);
    tunnels.close();
    pages.close();
    server.close();
    closing = Promise.race([Promise.all([mgr.shutdown().catch((e) => console.error(e)), closeShared()]), new Promise((r) => setTimeout(r, 2000))]);
    return closing;
  };
  if (cfg.signals !== false) {
    const bye = (sig) => close(sig).finally(() => setTimeout(() => process.exit(0), 50));
    process.on('SIGTERM', () => bye('SIGTERM'));
    process.on('SIGINT', () => bye('SIGINT'));
  }
  process.on('uncaughtException', (e) => { console.error('uncaught', e); });
  process.on('unhandledRejection', (e) => { console.error('unhandled', e); });
  return { server, mgr, store, cfg, baseUrl, tunnels, listening, close };
}

/** Starts belay for real: takes the data dir lock first, so a second belay exits instead of running every session twice. */
export function main(cfg = config()) {
  return lockDataDir(cfg.dataDir).then((lock) => {
    process.on('exit', () => lock?.close());
    return start(cfg);
  }, (e) => {
    log(e.message);
    process.exit(1);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
