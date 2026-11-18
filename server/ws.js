import { WebSocketServer } from 'ws';

/**
 * One websocket per browser, multiplexing every attached session.
 *   client → server: attach {sid,cols,rows} | detach {sid} | input {sid,data} | resize {sid,cols,rows} | ping
 *   server → client: hello {state} | replay {sid,data,cols,rows} | data {sid,data} | exit {sid,code}
 *                    session {session} | session-removed {sid} | templates | views | settings | error | pong
 */
export function createWs({ mgr, getState }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    const attached = new Set();
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ t: 'hello', state: getState() }));

    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      try {
        switch (m.t) {
          case 'attach': {
            if (attached.has(m.sid)) mgr.detach(m.sid, ws);
            const rep = await mgr.attach(m.sid, ws, m.cols | 0, m.rows | 0);
            attached.add(m.sid);
            if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'replay', sid: m.sid, ...rep }));
            break;
          }
          case 'detach':
            mgr.detach(m.sid, ws);
            attached.delete(m.sid);
            break;
          case 'input':
            if (attached.has(m.sid)) mgr.input(m.sid, String(m.data ?? ''));
            break;
          case 'resize':
            if (attached.has(m.sid)) mgr.resize(m.sid, m.cols | 0, m.rows | 0);
            break;
          case 'ping':
            ws.send('{"t":"pong"}');
            break;
          default:
            break;
        }
      } catch (e) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'error', sid: m.sid, message: e.message }));
      }
    });

    ws.on('close', () => { for (const sid of attached) mgr.detach(sid, ws); });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  const all = (msg) => {
    const s = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(s);
  };
  mgr.on('session', (s) => all({ t: 'session', session: s }));
  mgr.on('session-removed', (sid) => all({ t: 'session-removed', sid }));

  return { wss, all };
}
