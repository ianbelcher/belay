// Tests run their sessions in a holder of their own; this stops it, sessions and all.
import net from 'node:net';
import path from 'node:path';

export function stopHolder(dir) {
  return new Promise((resolve) => {
    const c = net.connect(path.join(dir, 'hold-v1.sock'));
    let buf = Buffer.alloc(0);
    const done = () => { c.destroy(); resolve(); };
    c.on('error', done);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 5 || buf.length < 4 + buf.readUInt32BE(0)) return;
      const { pid } = JSON.parse(buf.subarray(5, 4 + buf.readUInt32BE(0)).toString());
      try { process.kill(pid, 'SIGTERM'); } catch {}
      // Gone once its socket is.
      const t = setInterval(() => { const p = net.connect(path.join(dir, 'hold-v1.sock')); p.on('error', () => { clearInterval(t); done(); }); p.on('connect', () => p.destroy()); }, 50);
    });
  });
}
