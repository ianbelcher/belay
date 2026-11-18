import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { log } from './util.js';

/**
 * Holds a unix socket in the data dir for as long as belay runs. A second belay on the same data dir
 * would follow every session a second time and race on state.json, so it refuses to start instead.
 * A socket rather than a pid file: it works across containers that share the directory, and a belay that
 * crashed leaves a socket nobody answers on, which is taken over.
 */
export function lockDataDir(dataDir) {
  const file = path.join(dataDir, 'belay.sock');
  fs.mkdirSync(dataDir, { recursive: true });
  const listen = () => new Promise((resolve, reject) => {
    const srv = net.createServer((c) => c.end());
    srv.once('error', reject);
    srv.listen(file, () => { srv.off('error', reject); srv.unref(); resolve(srv); });
  });
  const answers = () => new Promise((resolve) => {
    const c = net.connect(file);
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
  return listen().catch(async (e) => {
    if (e.code !== 'EADDRINUSE') {
      log(`WARNING: could not lock ${dataDir} (${e.message}); not guarding against a second belay`);
      return null;
    }
    if (await answers()) throw new Error(`another belay is already running on ${dataDir}`);
    fs.rmSync(file, { force: true });
    return listen();
  });
}
