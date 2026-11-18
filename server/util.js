import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const shortId = (bytes = 6) => randomBytes(bytes).toString('base64url');
export const nowIso = () => new Date().toISOString();

export function loginShell() {
  try {
    const s = os.userInfo().shell;
    if (s) return s;
  } catch {}
  return process.env.SHELL || '/bin/bash';
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function atomicWriteSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export async function atomicWrite(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readBody(req, limit = 4_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson(req, limit) {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/** True when the connection comes from this machine: loopback, or one of its own addresses. */
export function isLocalRequest(req) {
  const addr = (a) => String(a || '').replace(/^::ffff:/, '');
  const remote = addr(req.socket?.remoteAddress);
  if (!remote) return false;
  return remote === '::1' || remote.startsWith('127.') || remote === addr(req.socket?.localAddress);
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Matches CSI, OSC and other escape sequences for the plain-text scrollback export.
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;
export const stripAnsi = (s) => s.replace(ANSI_RE, '');

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n | 0));

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
