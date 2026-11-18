/** REST + WebSocket client with reconnect. Holds the mirrored server state. */
export class Client extends EventTarget {
  constructor() {
    super();
    this.state = { templates: [], sessions: new Map(), views: [], notes: new Map(), walls: new Map(), settings: {}, server: {} };
    this.clientId = Math.random().toString(36).slice(2, 10);
    this.ws = null;
    this.connected = false;
    this.backoff = 500;
    this.sidHandlers = new Map();
    this.attachCount = new Map(); // panes attached per session on this socket: every project stays live, and one session can be in several
  }

  on(type, fn) {
    this.addEventListener(type, fn);
    return () => this.removeEventListener(type, fn);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** Subscribe to terminal traffic (replay/data/exit/error) for one session. */
  onSession(sid, fn) {
    let set = this.sidHandlers.get(sid);
    if (!set) this.sidHandlers.set(sid, (set = new Set()));
    set.add(fn);
    return () => { set.delete(fn); if (!set.size) this.sidHandlers.delete(sid); };
  }

  async api(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw Object.assign(new Error((data && data.error) || `${r.status} ${r.statusText}`), { status: r.status });
    return data;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.backoff = 500; this.attachCount.clear(); this.emit('connected'); };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } this.onMessage(m); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.emit('disconnected');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  /** A pane wants a session's output. Each attach brings a replay, which every pane of that session redraws from. */
  attach(sid, cols, rows) {
    this.attachCount.set(sid, (this.attachCount.get(sid) || 0) + 1);
    this.send({ t: 'attach', sid, cols, rows });
  }
  /** The server stops sending only when the last pane of the session lets go. */
  detach(sid) {
    const n = (this.attachCount.get(sid) || 0) - 1;
    if (n > 0) { this.attachCount.set(sid, n); return; }
    this.attachCount.delete(sid);
    this.send({ t: 'detach', sid });
  }

  onMessage(m) {
    switch (m.t) {
      case 'hello':
        this.applyState(m.state);
        this.emit('hello');
        break;
      case 'session':
        this.state.sessions.set(m.session.id, m.session);
        this.emit('session', m.session);
        break;
      case 'session-removed':
        this.state.sessions.delete(m.sid);
        this.emit('session-removed', m.sid);
        break;
      case 'templates':
        this.state.templates = m.templates;
        this.emit('templates');
        break;
      case 'projects':
        if (m.origin !== this.clientId) { this.state.views = m.projects; this.emit('views'); }
        break;
      case 'note':
        this.state.notes.set(m.note.id, m.note);
        this.emit('note', { note: m.note, remote: m.origin !== this.clientId });
        break;
      case 'wall':
        this.state.walls.set(m.wall.id, m.wall);
        this.emit('wall', { wall: m.wall, remote: m.origin !== this.clientId });
        break;
      case 'wall-removed':
        this.state.walls.delete(m.id);
        this.emit('wall-removed', m.id);
        break;
      case 'note-removed':
        this.state.notes.delete(m.id);
        this.emit('note-removed', m.id);
        break;
      case 'settings':
        this.state.settings = m.settings;
        this.emit('settings');
        break;
      case 'replay': case 'data': case 'exit': case 'error': {
        const set = this.sidHandlers.get(m.sid);
        if (set) for (const fn of set) fn(m);
        else if (m.t === 'error') this.emit('error', m);
        break;
      }
      default:
        break;
    }
  }

  applyState(s) {
    this.state.templates = s.templates || [];
    this.state.sessions = new Map((s.sessions || []).map((x) => [x.id, x]));
    this.state.views = s.projects || [];
    this.state.notes = new Map((s.notes || []).map((n) => [n.id, n]));
    this.state.walls = new Map((s.walls || []).map((w) => [w.id, w]));
    this.state.settings = s.settings || {};
    this.state.server = s.server || {};
  }

  session(id) { return this.state.sessions.get(id); }
  template(id) { return this.state.templates.find((t) => t.id === id); }
  note(id) { return this.state.notes.get(id); }
  wall(id) { return this.state.walls.get(id); }
  sessionsSorted() {
    const order = { running: 0, exited: 1, stopped: 2 };
    return [...this.state.sessions.values()].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.name.localeCompare(b.name));
  }
}
