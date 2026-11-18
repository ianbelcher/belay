import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HttpError, expandHome } from './util.js';
import { mediaKind } from './media.js';
import { HOST_RE, USER_RE, targetOf } from '../shared/ssh.js';
import { sshArgs } from './ssh.js';

// Files in editor tabs: opened from a path printed in a terminal (resolved against the session's directory) or
// picked by hand. Files on a remote host are read, written and listed over ssh.

export const FILE_MAX = 2 * 1024 * 1024;
export { HOST_RE, USER_RE } from '../shared/ssh.js';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** Quote for a remote shell, keeping a leading ~/ for the shell to expand. */
const remotePath = (p) => (p === '~' ? '"$HOME"' : p.startsWith('~/') ? `"$HOME"/${shq(p.slice(2))}` : shq(p));

function localPath(p, cwd) {
  const e = expandHome(String(p));
  return path.resolve(cwd || os.homedir(), e);
}

/** Whether a file starts like text: no NUL in its first 4 KB. Binaries such as /bin/bash are not worth a link. */
function isDirSync(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

async function looksLikeText(p) {
  const fh = await fsp.open(p, 'r').catch(() => null);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return !buf.subarray(0, bytesRead).includes(0);
  } finally { await fh.close(); }
}

/** Which of the candidate paths are text files here, as absolute paths (null for the rest). */
export async function resolveLocal(cwd, candidates) {
  const list = candidates.slice(0, 200);
  const found = await Promise.all(list.map(async (c) => {
    const p = localPath(c, cwd);
    const st = await fsp.stat(p).catch(() => null);
    return st?.isFile() && (mediaKind(p) || await looksLikeText(p)) ? p : null;
  }));
  // In the order asked, whichever was checked first.
  return Object.fromEntries(list.map((c, i) => [c, found[i]]));
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** `hash` is of the whole file, and says on save whether it changed in the meantime; a truncated file has none and cannot be saved. */
function asText(buf, p) {
  const truncated = buf.length > FILE_MAX;
  const body = truncated ? buf.subarray(0, FILE_MAX) : buf;
  if (body.subarray(0, 8192).includes(0)) throw new HttpError(415, `${p} is not a text file`);
  return { text: body.toString('utf8'), truncated, hash: truncated ? null : sha(body) };
}

/** The ssh target for a host and user, refused unless both are what belay takes. */
export function checkHost(host, user) {
  if (!HOST_RE.test(host || '') || host.length > 255) throw new HttpError(400, 'bad host');
  if (user && (!USER_RE.test(user) || user.length > 64)) throw new HttpError(400, 'bad user');
  return targetOf(host, user);
}

/** Runs a script on `target` over ssh. Exit code 3 means not found, 4 already exists, 5 not a directory. */
function ssh(target, script, { input, maxBuffer = FILE_MAX + 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', [...sshArgs(target, { forwards: false, extra: ['-o', 'ConnectTimeout=5'] }), script],
      { encoding: 'buffer', timeout: 15000, maxBuffer }, (err, stdout, stderr) => {
        if (!err) { resolve(stdout); return; }
        const msg = String(stderr || '').trim().split('\n').pop() || err.message;
        reject(new HttpError({ 3: 404, 4: 409, 5: 400 }[err.code] || 502, `${target}: ${msg}`));
      });
    child.stdin.end(input ?? '');
  });
}

/** A text file here, or on `host` over ssh (relative paths from `dir` there). */
export async function readTextFile({ path: p, host, user, dir }) {
  if (!p) throw new HttpError(400, 'path is required');
  if (!host) {
    const abs = localPath(p, dir);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, `${abs} is not a file`);
    const fh = await fsp.open(abs, 'r');
    try {
      // What is there now, read to its end: a file being saved over shrinks and grows between a stat and a read,
      // and a buffer sized from the stat would keep zeros where the file had ended.
      const buf = Buffer.allocUnsafe(FILE_MAX + 1);
      let n = 0;
      for (let r; n < buf.length && (r = (await fh.read(buf, n, buf.length - n, n)).bytesRead); ) n += r;
      return { path: abs, host: '', size: n, ...asText(buf.subarray(0, n), abs) };
    } finally { await fh.close(); }
  }
  const target = checkHost(host, user);
  const script = `${dir ? `cd ${remotePath(dir)} 2>/dev/null; ` : ''}f=${remotePath(p)}; [ -f "$f" ] || { echo "$f is not a file" >&2; exit 3; }; head -c ${FILE_MAX + 1} -- "$f"`;
  const buf = await ssh(target, script);
  return { path: p, host: target, size: buf.length, ...asText(buf, p) };
}

/**
 * Saves a text file here or on `host`. `base` is the hash it was loaded with: when the file has changed since,
 * the save is refused (409) unless `force`. `create` makes a new file, and is refused if one is there already.
 */
export async function writeTextFile({ path: p, host, user, dir, text, base, create, force }) {
  if (!p) throw new HttpError(400, 'path is required');
  if (typeof text !== 'string') throw new HttpError(400, 'text is required');
  const data = Buffer.from(text, 'utf8');
  if (data.length > FILE_MAX) throw new HttpError(413, `files up to ${FILE_MAX / 1024 / 1024} MB can be saved`);
  if (!create && !force) {
    const cur = await readTextFile({ path: p, host, user, dir });
    if (cur.hash !== base) throw new HttpError(409, 'the file has changed since it was opened');
  }
  if (!host) {
    const abs = localPath(p, dir);
    // In place, like most editors: the file keeps its inode, owner and mode.
    await fsp.writeFile(abs, data, { flag: create ? 'wx' : 'w' }).catch((e) => {
      throw new HttpError(e.code === 'EEXIST' ? 409 : e.code === 'ENOENT' ? 404 : 500, e.code === 'EEXIST' ? `${abs} already exists` : e.message);
    });
    return { path: abs, host: '', size: data.length, hash: sha(data) };
  }
  const target = checkHost(host, user);
  const guard = create ? '[ -e "$f" ] && { echo "$f already exists" >&2; exit 4; }; ' : '';
  await ssh(target, `${dir ? `cd ${remotePath(dir)} 2>/dev/null; ` : ''}f=${remotePath(p)}; ${guard}cat > "$f"`, { input: data });
  return { path: p, host: target, size: data.length, hash: sha(data) };
}

const LIST_MAX = 500;

/**
 * Entries for the file picker, like a shell completing a path: a path ending in a slash (or none) lists that
 * directory, anything else lists its parent, keeping the names that start with the last part. Directories end
 * with a slash. Hidden names show when asked for or when the last part starts with a dot.
 */
export async function listEntries({ path: p = '', host, user, dir, hidden }) {
  const whole = !p || p.endsWith('/') || p === '~';
  const prefix = whole ? '' : p.split('/').pop();
  const keep = (names) => names.filter((e) => e && e.startsWith(prefix) && (hidden || prefix.startsWith('.') || !e.startsWith('.')))
    .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b)).slice(0, LIST_MAX);
  if (!host) {
    const abs = localPath(p, dir);
    const d = whole ? abs : path.dirname(abs);
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => null);
    if (!entries) return { dir: d, entries: [] };
    return { dir: d, entries: keep(entries.map((e) => (e.isDirectory() || (e.isSymbolicLink() && isDirSync(path.join(d, e.name))) ? `${e.name}/` : e.name))) };
  }
  const target = checkHost(host, user);
  const d = whole ? remotePath(p || '.') : `"$(dirname -- ${remotePath(p)})"`;
  // ls -p marks directories (-L: and links to them) with a slash.
  const script = `${dir ? `cd ${remotePath(dir)} 2>/dev/null; ` : ''}cd -- ${d} 2>/dev/null || exit 5; pwd; ls -1ApL 2>/dev/null | head -n 20000`;
  const out = String(await ssh(target, script, { maxBuffer: 4 * 1024 * 1024 }).catch((e) => { if (e.status === 400) return ''; throw e; })).split('\n');
  return { dir: out.shift() || '', entries: keep(out) };
}
