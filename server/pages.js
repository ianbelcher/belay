import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { HttpError } from './util.js';
import { checkHost } from './files.js';
import { pageKeysScript } from '../shared/chords.js';

// Remote pages: a web address opened from the machine a project works on, this one or the project's host over
// ssh, and served by belay. Each page gets its own origin, page-<id>.localhost:<port> (browsers send *.localhost
// to this machine), so the app runs at / with its own cookies and storage, and belay's own cookie never reaches
// it. belay passes requests and WebSockets through as they are, with the Host the app expects, and fixes up what
// would point the browser at the app's real address or stop it showing in a frame.

const PAGE_HOST = /^page-([0-9a-f]{10})\./;
const COOKIE = 'belay_page';
const TICKET_MS = 10 * 60 * 1000;
const PAGES_MAX = 200;
const HTML_MAX = 32 * 1024 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** What a remote page shows: "8080", "localhost:3000/app", "grafana.monitoring.svc.cluster.local:3000", or a full URL. */
export function parseAddress(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new HttpError(400, 'an address is required');
  if (/^\d{1,5}$/.test(s)) s = `localhost:${s}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, `not an address: ${input}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'only http and https addresses');
  if (!u.hostname) throw new HttpError(400, `not an address: ${input}`);
  return { origin: u.origin, path: `${u.pathname}${u.search}${u.hash}` };
}

const parseCookies = (header) => {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
};

const page = (status, title, text, retry = false) => {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return [status, `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>${retry ? '<meta http-equiv="refresh" content="5">' : ''}
<style>body{font:14px system-ui;background:#0f1115;color:#d8dee9;display:grid;place-items:center;height:100vh;margin:0}div{max-width:560px;padding:24px}b{color:#4c8dff}p{color:#9aa4b5}</style>
<div><b>${esc(title)}</b><p>${esc(text)}</p>${retry ? '<p>Trying again every few seconds…</p>' : ''}</div>`];
};

const send = (res, [status, html]) => {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
};

function decoder(encoding) {
  switch (String(encoding || '').trim().toLowerCase()) {
    case '': case 'identity': return null;
    case 'gzip': case 'x-gzip': return zlib.createGunzip();
    case 'deflate': return zlib.createInflate();
    case 'br': return zlib.createBrotliDecompress();
    case 'zstd': return zlib.createZstdDecompress?.() ?? undefined;
    default: return undefined;
  }
}

/** The script that hands belay's chords back to it, right after <head> (or first, without one). */
function injectKeys(html) {
  const tag = '<script src="/__belay/keys.js"></script>';
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  const d = /<!doctype[^>]*>/i.exec(html);
  return d ? html.slice(0, d.index + d[0].length) + tag + html.slice(d.index + d[0].length) : tag + html;
}

export function createPages({ store, token, tunnels }) {
  const sign = (s) => crypto.createHmac('sha256', token || 'belay').update(s).digest('base64url');
  const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const keysJs = pageKeysScript();
  const agents = new Map();

  const recordOf = (req) => {
    const m = PAGE_HOST.exec(String(req.headers.host || '').toLowerCase());
    if (!m) return undefined;
    return store.state.pages.find((p) => p.id === m[1]) || null;
  };
  const via = (rec) => ({ host: rec.host, user: rec.user });
  const where = (rec) => (rec.host ? `on ${rec.user ? `${rec.user}@` : ''}${rec.host}` : 'on the belay machine');
  const scheme = (req) => (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http');

  /** page-<id> under the name belay was opened by: localhost becomes page-<id>.localhost. */
  function pageHost(id, reqHost) {
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(reqHost || ''));
    if (!m) throw new HttpError(400, 'no Host header');
    const name = m[1].toLowerCase();
    const port = m[2] ? `:${m[2]}` : '';
    if (name === 'localhost' || name === '[::1]' || /^127\./.test(name)) return `page-${id}.localhost${port}`;
    if (net.isIP(name.replace(/^\[|\]$/g, ''))) throw new HttpError(400, 'Remote pages need belay opened by a name, such as localhost, not an IP address: each page gets its own subdomain');
    return `page-${id}.${name}${port}`;
  }

  /** The page for an address, seen from a host (none: this machine), and the URL that signs the browser in to it. */
  function register(body, req) {
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    const user = host && typeof body.user === 'string' ? body.user.trim() : '';
    if (host) checkHost(host, user);
    const { origin: target, path } = parseAddress(body.address);
    const id = crypto.createHash('sha256').update(`${target}\n${user}@${host}`).digest('hex').slice(0, 10);
    let rec = store.state.pages.find((p) => p.id === id);
    if (!rec) { rec = { id, target, host, user }; store.state.pages.push(rec); }
    rec.usedAt = Date.now();
    if (store.state.pages.length > PAGES_MAX) {
      store.state.pages.sort((a, b) => b.usedAt - a.usedAt);
      store.state.pages.length = PAGES_MAX;
    }
    store.save();
    const origin = `${scheme(req)}://${pageHost(id, req.headers.host)}`;
    let url = `${origin}${path}`;
    if (token) {
      const exp = Date.now() + TICKET_MS;
      url = `${origin}/__belay/login?t=${exp}.${sign(`ticket:${id}:${exp}`)}&to=${encodeURIComponent(path)}`;
    }
    return { id, target, host, user, origin, url };
  }

  const signedIn = (req, rec) => !token || same(parseCookies(req.headers.cookie)[COOKIE], sign(`page:${rec.id}`));

  function login(req, res, rec, url) {
    const [exp, sig] = String(url.searchParams.get('t') || '').split('.');
    if (!(Number(exp) > Date.now() && same(sig, sign(`ticket:${rec.id}:${exp}`)))) {
      send(res, page(403, 'Link expired', 'Open this page from its tab in belay again.'));
      return;
    }
    const to = url.searchParams.get('to') || '/';
    res.writeHead(302, {
      // Two of them. The page in its tab is in a frame of belay; page-<id>.localhost and localhost are different
      // sites to a browser, so only a partitioned cookie (kept for the page under belay) is stored there and sent
      // back (Secure, which browsers allow over http for localhost). The plain one is for the page opened on
      // its own, and for belay under a real name, where the page's name is on the same site.
      'Set-Cookie': [
        `${COOKIE}=${sign(`page:${rec.id}`)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=31536000`,
        `${COOKIE}=${sign(`page:${rec.id}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      ],
      Location: to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\') ? to : '/',
      'Cache-Control': 'no-store',
    });
    res.end();
  }

  /** A connection to the page's app, made from where the page is opened, with TLS for an https address. */
  async function dial(rec) {
    const t = new URL(rec.target);
    const port = Number(t.port) || (t.protocol === 'https:' ? 443 : 80);
    const sock = await tunnels.connect(via(rec), t.hostname.replace(/^\[|\]$/g, ''), port);
    if (t.protocol !== 'https:') return sock;
    // An address someone typed for their own service: self-signed certificates are the norm there.
    return new Promise((resolve, reject) => {
      const s = tls.connect({ socket: sock, servername: net.isIP(t.hostname) ? undefined : t.hostname, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
      s.once('secureConnect', () => { s.removeListener('error', reject); resolve(s); });
      s.once('error', reject);
    });
  }

  function agentFor(rec) {
    let a = agents.get(rec.id);
    if (!a) {
      a = new http.Agent({ keepAlive: true, maxSockets: 32 });
      // Node waits for the callback when createConnection returns nothing.
      a.createConnection = (_opts, cb) => { dial(rec).then((s) => cb(null, s), cb); };
      agents.set(rec.id, a);
    }
    return a;
  }

  function requestHeaders(headers, t, pageOrigin) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!HOP.has(k)) out[k] = v;
    out.host = t.host;
    if (out.origin === pageOrigin) out.origin = t.origin;
    if (typeof out.referer === 'string' && out.referer.startsWith(pageOrigin)) out.referer = t.origin + out.referer.slice(pageOrigin.length);
    if (out.cookie) {
      const kept = String(out.cookie).split(';').filter((c) => c.split('=')[0].trim() !== COOKIE).join(';').trim();
      if (kept) out.cookie = kept; else delete out.cookie;
    }
    return out;
  }

  function responseHeaders(headers, t, pageOrigin) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!HOP.has(k)) out[k] = v;
    // Pointing back at the app's own address would take the browser past belay.
    const back = (u) => (typeof u === 'string' && (u === t.origin || u.startsWith(`${t.origin}/`)) ? pageOrigin + u.slice(t.origin.length) : u);
    if (out.location) out.location = back(out.location);
    if (out['content-location']) out['content-location'] = back(out['content-location']);
    if (out['access-control-allow-origin'] === t.origin) out['access-control-allow-origin'] = pageOrigin;
    // The cookie belongs to the page's own host, which never matches a Domain the app names.
    if (out['set-cookie']) out['set-cookie'] = [].concat(out['set-cookie']).map((c) => c.replace(/;\s*domain=[^;]*/gi, ''));
    // It is shown in a belay tab; and HSTS would pin the page's name to https, where belay does not answer.
    delete out['x-frame-options'];
    delete out['strict-transport-security'];
    for (const k of ['content-security-policy', 'content-security-policy-report-only']) {
      if (!out[k]) continue;
      const v = [].concat(out[k]).map((p) => p.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';')).filter((p) => p.trim());
      if (v.length) out[k] = v; else delete out[k];
    }
    return out;
  }

  function failure(rec, e) {
    const t = new URL(rec.target);
    if (e instanceof HttpError) return page(e.status, `Cannot reach ${t.host}`, e.message, true);
    const what = e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? `Nothing answered at ${t.host} ${where(rec)}. Is it running?`
      : e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? `${t.hostname} does not resolve ${where(rec)}.`
        : `${t.host} ${where(rec)}: ${e.message}`;
    return page(502, `Cannot reach ${t.host}`, what, true);
  }

  function proxy(req, res, rec) {
    const t = new URL(rec.target);
    const pageOrigin = `${scheme(req)}://${req.headers.host}`;
    const up = http.request({
      method: req.method, path: req.url, headers: requestHeaders(req.headers, t, pageOrigin), agent: agentFor(rec),
      host: t.hostname, port: Number(t.port) || (t.protocol === 'https:' ? 443 : 80),
    }, (ur) => {
      const headers = responseHeaders(ur.headers, t, pageOrigin);
      const html = /^\s*text\/html/i.test(ur.headers['content-type'] || '') && req.method !== 'HEAD' && ur.statusCode !== 204 && ur.statusCode !== 304;
      const dec = html ? decoder(ur.headers['content-encoding']) : undefined;
      if (!html || dec === undefined) { res.writeHead(ur.statusCode, ur.statusMessage, headers); ur.pipe(res); return; }
      const chunks = [];
      let size = 0;
      const body = dec ? ur.pipe(dec) : ur;
      body.on('data', (c) => { size += c.length; if (size > HTML_MAX) { body.destroy(new Error('page too large')); return; } chunks.push(c); });
      body.on('error', (e) => send(res, failure(rec, e)));
      body.on('end', () => {
        const out = Buffer.from(injectKeys(Buffer.concat(chunks).toString('utf8')));
        delete headers['content-encoding'];
        delete headers['content-length'];
        headers['content-length'] = out.length;
        res.writeHead(ur.statusCode, ur.statusMessage, headers);
        res.end(out);
      });
    });
    up.on('error', (e) => send(res, failure(rec, e)));
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }

  /** A request for a remote page: true when it was one (handled here), false when it is for belay itself. */
  function handle(req, res) {
    const rec = recordOf(req);
    if (rec === undefined) return false;
    if (!rec) { send(res, page(404, 'Unknown page', 'Open this page from its tab in belay again.')); return true; }
    const url = new URL(req.url, 'http://page');
    if (url.pathname === '/__belay/login') { login(req, res, rec, url); return true; }
    if (!signedIn(req, rec)) { send(res, page(401, 'Not signed in', 'Open this page from its tab in belay: that signs this browser in to it.')); return true; }
    if (url.pathname === '/__belay/keys.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(keysJs);
      return true;
    }
    proxy(req, res, rec);
    return true;
  }

  /** A WebSocket (or other upgrade) for a remote page, passed through byte for byte once connected. */
  function upgrade(req, socket, head) {
    const rec = recordOf(req);
    if (rec === undefined) return false;
    if (!rec || !signedIn(req, rec)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return true; }
    const t = new URL(rec.target);
    const pageOrigin = `${scheme(req)}://${req.headers.host}`;
    socket.on('error', () => {});
    dial(rec).then((up) => {
      const headers = requestHeaders(req.headers, t, pageOrigin);
      headers.connection = 'Upgrade';
      headers.upgrade = req.headers.upgrade;
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) for (const x of [].concat(v)) raw += `${k}: ${x}\r\n`;
      up.write(`${raw}\r\n`);
      if (head?.length) up.write(head);
      up.on('error', () => socket.destroy());
      socket.on('close', () => up.destroy());
      up.pipe(socket).pipe(up);
    }, (e) => {
      const [status] = failure(rec, e);
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\nConnection: close\r\n\r\n`);
    });
    return true;
  }

  return { register, handle, upgrade, close: () => { for (const a of agents.values()) a.destroy(); } };
}
