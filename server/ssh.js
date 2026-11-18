// Running ssh, and reading the ssh config it reads: the hosts it names, and what one resolves to.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sshOpts, sshDest, parseTarget } from '../shared/ssh.js';

/** An ssh config of belay's own instead of yours (the tests' private server). */
const configFile = () => process.env.BELAY_SSH_CONFIG || '';

/**
 * Where belay's ssh connections share one login per host (ssh's ControlMaster): short, since a socket's path may
 * be no longer than 104 bytes on macOS, and only if it is a directory of this user's that no one else can use.
 */
let muxDirCache;
function muxDir() {
  if (muxDirCache !== undefined) return muxDirCache;
  muxDirCache = null;
  if (process.env.BELAY_SSH_MUX === '0' || typeof process.getuid !== 'function') return null;
  const dir = `/tmp/belay-${process.getuid()}`;
  try {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid()) return null;
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    muxDirCache = dir;
  } catch {}
  return muxDirCache;
}

/** The hosts belay has a shared login to, to close when belay does. */
const shared = new Set();

/** Closes belay's shared logins (`ssh -O exit`), so that nothing belay started outlives it. */
export function closeShared() {
  const mux = muxDir();
  if (!mux) return Promise.resolve();
  const all = [...shared];
  shared.clear();
  return Promise.all(all.map((target) => new Promise((res) => {
    execFile('ssh', [...(configFile() ? ['-F', configFile()] : []), '-o', `ControlPath=${mux}/%C`, '-O', 'exit', ...sshDest(target)], { timeout: 3000 }, () => res());
  })));
}

/**
 * ssh's arguments, up to and including the destination: belay's options, then `-p` and `[user@]host`. belay's
 * short connections to a host (files, media, putting the holder there) share one login, kept for ten minutes
 * after the last: much quicker, and a key's passphrase or a second factor asked for once. `share: 'use'` rides
 * on that login when there is one without starting one (the holder's connection, which stays up anyway);
 * `share: 'off'` keeps out of it (a tunnel, which must be a connection of its own). A host seen for the first
 * time is trusted on first use (`accept-new`; a key that has changed is still refused), unless your config
 * says otherwise.
 */
export function sshArgs(target, { forwards = true, extra = [], share = 'auto' } = {}) {
  const eff = effectiveTarget(target);
  const name = parseTarget(eff)?.name || '';
  const opts = sshOpts({ forwards, config: configFile() });
  if (!configOption(name, 'stricthostkeychecking')) opts.push('-o', 'StrictHostKeyChecking=accept-new');
  const mux = muxDir();
  if (mux && share === 'auto') shared.add(eff);
  if (mux && share === 'auto') opts.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${mux}/%C`, '-o', 'ControlPersist=600');
  else if (mux && share === 'use') opts.push('-o', 'ControlMaster=no', '-o', `ControlPath=${mux}/%C`);
  else opts.push('-o', 'ControlPath=none');
  return [...opts, ...extra, ...sshDest(eff)];
}

const expand = (p, base) => {
  const e = p.replace(/^~(?=$|\/)/, os.homedir());
  return path.isAbsolute(e) ? e : path.join(base, e);
};

/** The files an `Include` names: globs in the last part of the path, as ssh allows. */
function included(pattern, base) {
  const p = expand(pattern, base);
  const dir = path.dirname(p);
  const name = path.basename(p);
  if (!/[*?]/.test(name)) return [p];
  const re = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try { return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)); } catch { return []; }
}

/**
 * Your ssh config as blocks, in order, Includes read where they stand: each { patterns, opts } (`patterns` null
 * for what comes before the first Host, and for a Match block, which applies to what it can only find out by
 * connecting, so belay leaves it to ssh).
 */
function readConfig(file = configFile() || path.join(os.homedir(), '.ssh', 'config')) {
  const blocks = [{ patterns: [], opts: {} }];
  const seen = new Set();
  const read = (f) => {
    if (seen.has(f) || seen.size > 50) return;
    seen.add(f);
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { return; }
    for (const raw of text.split('\n')) {
      const line = raw.replace(/(^|\s)#.*/, '').trim();
      if (!line) continue;
      const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^"(.*)"$/, '$1');
      if (key === 'include') { for (const pat of value.split(/\s+/)) for (const g of included(pat, path.join(os.homedir(), '.ssh'))) read(g); continue; }
      if (key === 'host') { blocks.push({ patterns: value.split(/\s+/), opts: {} }); continue; }
      if (key === 'match') { blocks.push({ patterns: null, opts: {} }); continue; }
      const o = blocks[blocks.length - 1].opts;
      if (!(key in o)) o[key] = value;
    }
  };
  read(file);
  return blocks;
}

const globRe = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
/** Whether a Host line's patterns take a name: one of them matches, and none of its negations do. */
function matches(patterns, name) {
  if (!patterns) return false;
  if (!patterns.length) return true;
  let hit = false;
  for (const p of patterns) {
    if (p.startsWith('!')) { if (globRe(p.slice(1)).test(name)) return false; } else if (globRe(p).test(name)) hit = true;
  }
  return hit;
}

/** An option for a host as your ssh config gives it: the first value from the blocks that match, as ssh takes it. */
export function configOption(name, key, blocks = readConfig()) {
  for (const b of blocks) if (matches(b.patterns, name) && key in b.opts) return b.opts[key];
  return '';
}

/** The user your ssh config sets for a host, if it sets one. */
export const configUser = (name) => configOption(name, 'user');

/**
 * The target belay connects to: your ssh config's User for the host, when it sets one, rather than the
 * project's (which is only for hosts the config leaves it to).
 */
export function effectiveTarget(target) {
  const t = parseTarget(target);
  if (!t || !t.user || !configUser(t.name)) return target;
  return target.slice(t.user.length + 1);
}

/** The hosts your ssh config names (not its patterns), with the HostName, User and Port it gives each. */
export function configHosts() {
  const blocks = readConfig();
  const names = [];
  for (const b of blocks) for (const n of b.patterns || []) if (!/[*?!]/.test(n) && parseTarget(n) && !names.includes(n)) names.push(n);
  return names.map((name) => {
    const o = (k) => configOption(name, k, blocks);
    return { name, hostname: o('hostname'), user: o('user'), port: Number(o('port')) || undefined };
  });
}

/** What ssh will actually connect to for a target, from `ssh -G` (no connection is made). */
export function resolve(target) {
  return new Promise((res, rej) => {
    let args;
    try { args = [...(configFile() ? ['-F', configFile()] : []), '-G', ...sshDest(effectiveTarget(target))]; } catch (e) { rej(e); return; }
    const name = parseTarget(target).name;
    execFile('ssh', args, { timeout: 5000 }, (err, stdout) => {
      if (err) { rej(new Error(`ssh -G ${target}: ${err.message}`)); return; }
      const o = {};
      for (const l of stdout.split('\n')) { const i = l.indexOf(' '); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
      res({ hostname: o.hostname || '', user: o.user || '', port: Number(o.port) || 22, proxyJump: o.proxyjump && o.proxyjump !== 'none' ? o.proxyjump : '', configUser: configUser(name) });
    });
  });
}
