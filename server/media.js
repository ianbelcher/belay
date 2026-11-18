import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { HttpError, expandHome } from './util.js';
import { checkHost } from './files.js';
import { sshArgs as sshBase } from './ssh.js';
import { mediaType, mediaKind } from '../shared/media.js';

export { mediaKind };

// Files a browser shows itself: PDFs, images, video and audio, served as bytes for a viewer tab, here or over
// ssh from a project's host. Ranges are honored, so video and audio can seek. Only these types are served:
// anything else is not a viewer's business, and an HTML or SVG file must never run in belay's origin.

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const remotePath = (p) => (p === '~' ? '"$HOME"' : p.startsWith('~/') ? `"$HOME"/${shq(p.slice(2))}` : shq(p));

const target = ({ host, user }) => checkHost(host, user);
const sshArgs = (t, script) => [...sshBase(t, { forwards: false, extra: ['-o', 'ConnectTimeout=5'] }), script];
const remoteCd = (dir) => (dir ? `cd ${remotePath(dir)} 2>/dev/null; ` : '');

/** Size and modification time (ms) of a file here or on a host; 404 when it is not a file. */
export async function statFile({ path: p, host, user, dir }) {
  if (!p) throw new HttpError(400, 'path is required');
  if (!host) {
    const abs = path.resolve(dir || os.homedir(), expandHome(p));
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, `${abs} is not a file`);
    return { path: abs, size: st.size, mtime: Math.round(st.mtimeMs) };
  }
  const t = target({ host, user });
  // GNU stat first, then BSD (macOS).
  const script = `${remoteCd(dir)}f=${remotePath(p)}; [ -f "$f" ] || { echo "$f is not a file" >&2; exit 3; }; stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f"`;
  const out = await new Promise((resolve, reject) => execFile('ssh', sshArgs(t, script), { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) reject(new HttpError(err.code === 3 ? 404 : 502, `${t}: ${String(stderr || err.message).trim().split('\n').pop()}`));
    else resolve(String(stdout).trim());
  }));
  const [size, mtime] = out.split(/\s+/).map(Number);
  if (!Number.isFinite(size)) throw new HttpError(502, `${t}: could not read the file's size`);
  return { path: p, size, mtime: mtime * 1000 };
}

/** `bytes=a-b` against a size: [start, end] inclusive, null for the whole file, or 'bad'. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (!m[1] && !m[2])) return 'bad';
  let start, end;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  return start > end || start >= size ? 'bad' : [start, end];
}

/** The file's bytes (or the range asked for) as the response. */
export async function sendMedia(req, res, q) {
  const type = mediaType(q.path || '');
  if (!type) throw new HttpError(415, 'only PDFs, images, video and audio are shown');
  const st = await statFile(q);
  const range = parseRange(req.headers.range, st.size);
  if (range === 'bad') { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
  const [start, end] = range || [0, Math.max(0, st.size - 1)];
  const length = st.size ? end - start + 1 : 0;
  const headers = {
    'Content-Type': type,
    'Content-Length': length,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${path.basename(q.path).replace(/["\\\r\n]/g, '_')}"`,
  };
  // An SVG opened on its own would be a document in belay's origin: no scripts, nothing it can load.
  if (type === 'image/svg+xml') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || !length) { res.end(); return; }
  if (!q.host) {
    const stream = fs.createReadStream(st.path, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }
  const t = target(q);
  const script = `${remoteCd(q.dir)}f=${remotePath(q.path)}; tail -c +${start + 1} -- "$f" | head -c ${length}`;
  const child = spawn('ssh', sshArgs(t, script), { stdio: ['ignore', 'pipe', 'ignore'] });
  res.on('close', () => child.kill());
  child.on('error', () => res.destroy());
  child.stdout.pipe(res);
}
