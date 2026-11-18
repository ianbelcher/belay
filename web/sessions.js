import { h } from './util.js';
import { AGENTS } from '../shared/template-core.js';

const PREFS_KEY = 'belay.sessions';
const DEFAULTS = { group: 'none', sort: 'least', show: { idle: true, working: true, hidden: false }, starredFirst: true };
const SORTS = [['least', 'Least recent first'], ['recent', 'Most recent first'], ['name', 'Name']];
const readPrefs = () => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    const out = { ...DEFAULTS, ...p, show: { ...DEFAULTS.show, ...p.show } };
    if (!SORTS.some(([v]) => v === out.sort)) out.sort = 'least';
    delete out.show.other;
    return out;
  } catch { return structuredClone(DEFAULTS); }
};

/** "45s", "12m", "3h 05m", "2d 4h": how long a session has been as it is. */
export function since(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

/**
 * Where an agent session stands, for the list: `bucket` is what the Idle / Working switches show or hide, `at`
 * when it got there. Working is from its hooks; everything else (waiting for a prompt, needing you, not
 * reporting yet, ended) is idle as far as the switches go, with its own label.
 */
export function standing(s) {
  const act = s.activity?.state;
  if (s.status !== 'running') return { state: 'ended', bucket: 'idle', label: s.status === 'exited' ? `exited ${s.exitCode ?? ''}`.trim() : 'stopped', at: s.exitedAt };
  if (act === 'busy') return { state: 'working', bucket: 'working', label: 'working', at: s.activity.since };
  if (act === 'attention') return { state: 'attention', bucket: 'idle', label: 'needs you', at: s.activity.since };
  if (act === 'idle') return { state: 'idle', bucket: 'idle', label: 'idle', at: s.activity.since };
  return { state: 'running', bucket: 'idle', label: 'running', at: s.startedAt };
}

/** Claude, Codex or opencode: what it reports itself as, else its template. Shells are not listed. */
const agentLabel = (s) => AGENTS.find((a) => a.id === (s.activity?.agent || s.agent))?.label || null;

const ICON = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="4" cy="4.5" r="1.2"/><circle cx="4" cy="9" r="1.2"/><circle cx="4" cy="13.5" r="1.2"/><path d="M8 4.5h7M8 9h7M8 13.5h7"/></svg>';

/**
 * The sessions view of the sidebar: every agent session with how long it has been idle or working, grouped by
 * project or by agent, sorted by that time, starred ones first. A click goes to the session where it is open;
 * it never moves it. A session whose tab was closed is hidden: it stays listed under the project it was in
 * (with Hidden switched on), and a click opens it there again.
 */
export class SessionsView {
  constructor(app) {
    this.app = app;
    this.id = 'sessions';
    this.title = 'Sessions';
    this.icon = ICON;
    this.command = 'sessions';
    this.prefs = readPrefs();
  }

  get bar() { return this.app.side; }

  savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch {} }

  /** The rail's badge: agents waiting for a prompt, amber when one needs you. */
  rail(btn, badge) {
    const open = this.openIn();
    const waiting = [...this.app.client.state.sessions.values()].filter((s) => agentLabel(s) && open.has(s.id)).map(standing).filter((x) => x.state === 'idle' || x.state === 'attention');
    const attention = waiting.some((x) => x.state === 'attention');
    badge.textContent = String(waiting.length);
    badge.classList.toggle('hidden', !waiting.length);
    badge.classList.toggle('attention', attention);
    if (waiting.length) btn.title += `\n${waiting.length} waiting for a prompt${attention ? ', some need you' : ''}`;
  }

  /** The project each session is open in: the first in project order, the current one if it is there. */
  openIn() {
    const { dock } = this.app;
    const out = new Map();
    // A closed project's sessions are open nowhere: they are listed as hidden, under it.
    for (const v of dock.shown) for (const id of dock.sessionsInView(v)) if (!out.has(id)) out.set(id, v);
    const cur = dock.activeView();
    for (const id of dock.sessionsInView(cur)) out.set(id, cur);
    return out;
  }

  rows() {
    const p = this.prefs;
    const where = this.openIn();
    const { views } = this.app.dock;
    const list = [...this.app.client.state.sessions.values()].filter((s) => agentLabel(s)).map((s) => {
      const open = where.get(s.id) || null;
      // Hidden: open in no project. It still belongs to the one it was last open in.
      return { s, ...standing(s), view: open || views.find((v) => v.id === s.project) || null, hidden: !open, agent: agentLabel(s) };
    });
    const counts = { idle: 0, working: 0, hidden: 0 };
    for (const r of list) counts[r.hidden ? 'hidden' : r.bucket]++;
    const shown = list.filter((r) => p.show[r.bucket] && (!r.hidden || p.show.hidden));
    const t = (r) => (r.at ? Date.parse(r.at) : Infinity);
    shown.sort((a, b) => (p.starredFirst ? Number(!!b.s.starred) - Number(!!a.s.starred) : 0)
      || (p.sort === 'name' ? a.s.name.localeCompare(b.s.name) : p.sort === 'recent' ? t(b) - t(a) : t(a) - t(b))
      || a.s.name.localeCompare(b.s.name));
    return { shown, counts };
  }

  /** Rows under headings: projects in their tab order, agents in theirs, or one list. */
  groups(shown) {
    const p = this.prefs;
    if (p.group === 'project') {
      const out = this.app.dock.views.map((v) => ({ title: v.hidden ? `${v.name} (closed)` : v.name, rows: shown.filter((r) => r.view?.id === v.id) }));
      out.push({ title: 'No project', rows: shown.filter((r) => !r.view) });
      return out.filter((g) => g.rows.length);
    }
    if (p.group === 'agent') {
      return AGENTS.map((a) => ({ title: a.label, rows: shown.filter((r) => r.agent === a.label) })).filter((g) => g.rows.length);
    }
    return [{ title: null, rows: shown }];
  }

  /** Drawn again only when something it shows has changed (`force` for a change of its own settings). */
  render(el = this.el, force = true) {
    this.el = el;
    const p = this.prefs;
    const { app } = this;
    const { shown, counts } = this.rows();
    // The session in front, marked, so it is easy to find in the list (it follows as tabs change).
    const current = app.dock.sessionOf()?.id || null;
    const sig = JSON.stringify([p, counts, current, shown.map((r) => [r.s.id, r.s.name, r.label, r.at, r.view?.id, r.view?.name, r.hidden, r.s.starred, r.agent])]);
    if (!force && sig === this.sig) return;
    this.sig = sig;
    const set = (fn) => () => { fn(); this.savePrefs(); this.render(); };
    const seg = (key, options) => h('span', { class: 'seg' }, ...options.map(([v, label]) => h('button', { class: p[key] === v ? 'on' : '', onclick: set(() => { p[key] = v; }) }, label)));
    const chip = (b, label, title) => h('button', { class: `chip-t${p.show[b] ? ' on' : ''}`, 'data-show': b, title, onclick: set(() => { p.show[b] = !p.show[b]; }) }, `${label} ${counts[b]}`);
    const sort = h('select', { title: 'Order' }, ...SORTS.map(([v, label]) => h('option', { value: v, selected: p.sort === v }, label)));
    sort.addEventListener('change', set(() => { p.sort = sort.value; }));
    const now = Date.now();
    const row = (r) => {
      const star = h('button', { class: `srow-star${r.s.starred ? ' on' : ''}`, title: r.s.starred ? 'Unstar' : 'Star: first in the list' }, r.s.starred ? '★' : '☆');
      star.addEventListener('click', (e) => { e.stopPropagation(); app.client.api('PATCH', `/api/sessions/${r.s.id}`, { starred: !r.s.starred }).catch((err) => app.ui.toast(err.message)); });
      const where = `${r.view ? r.view.name : 'no project'}${r.hidden ? ' · hidden' : ''}`;
      const el = h('div', { class: `srow st-${r.state}${r.hidden ? ' is-hidden' : ''}${r.s.id === current ? ' is-current' : ''}`, 'data-sid': r.s.id, title: `${r.s.name} · ${where}${r.hidden ? '\nClick to open it in its project again' : ''}` },
        star,
        h('div', { class: 'srow-main' },
          h('div', { class: 'srow-name' }, r.s.name),
          p.group !== 'project' ? h('div', { class: 'srow-sub' }, where) : r.hidden ? h('div', { class: 'srow-sub' }, 'hidden') : null),
        h('div', { class: 'srow-state' },
          h('span', { class: 'srow-label' }, r.label),
          h('span', { class: 'srow-time', 'data-at': r.at || '' }, r.at ? since(now - Date.parse(r.at)) : '')));
      el.addEventListener('click', () => { app.dock.goToSession(r.s.id); this.bar.done(); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.menu(r.s, e); });
      return el;
    };
    const body = this.groups(shown).flatMap((g) => [g.title ? h('div', { class: 'sgroup' }, g.title, h('span', { class: 'n' }, String(g.rows.length))) : null, ...g.rows.map(row)]);
    const total = counts.idle + counts.working + counts.hidden;
    // Drawn again in place, at the same scroll.
    const prev = this.el.querySelector('.side-body');
    const keep = prev ? { top: prev.scrollTop, left: prev.scrollLeft } : null;
    this.el.replaceChildren(
      h('div', { class: 'side-controls' },
        h('div', { class: 'side-row' }, h('span', { class: 'lbl' }, 'Group'), seg('group', [['none', 'None'], ['project', 'Project'], ['agent', 'Agent']])),
        h('div', { class: 'side-row' }, h('span', { class: 'lbl' }, 'Show'),
          chip('idle', 'Idle', 'Waiting for a prompt, needing you, or stopped'),
          chip('working', 'Working', 'Working on a prompt'),
          chip('hidden', 'Hidden', 'Closed in their project, still listed there: a click opens one again')),
        h('div', { class: 'side-row' }, h('span', { class: 'lbl' }, 'Order'), sort,
          h('button', { class: `chip-t star${p.starredFirst ? ' on' : ''}`, 'data-starred-first': '', title: p.starredFirst ? 'Starred sessions are at the top' : 'Put starred sessions at the top', onclick: set(() => { p.starredFirst = !p.starredFirst; }) }, '★'))),
      h('div', { class: 'side-body' }, body.length ? body : h('p', { class: 'side-empty' }, total ? 'Nothing to show: switch on Idle, Working or Hidden above.' : 'No agent sessions yet: start Claude, Codex or opencode from the + after a project\'s tabs.')));
    const list = this.el.querySelector('.side-body');
    if (keep && list) { list.scrollTop = keep.top; list.scrollLeft = keep.left; }
  }

  /** Every second while open: the times move on; nothing else is redrawn. */
  tick() {
    const now = Date.now();
    for (const t of this.el.querySelectorAll('.srow-time[data-at]')) if (t.dataset.at) t.textContent = since(now - Date.parse(t.dataset.at));
  }

  menu(s, ev) {
    const { app } = this;
    const { ui, dock, client } = app;
    const act = (p) => () => client.api('POST', `/api/sessions/${s.id}/${p}`).catch((e) => ui.toast(e.message));
    ui.showMenu([
      ['Go to it', () => dock.goToSession(s.id)],
      ['Open in this project', () => dock.openSession(s.id)],
      ['Split right here', () => dock.openSession(s.id, { direction: 'right' })],
      null,
      ['Edit…', () => ui.openSessionEditor(app, s.id)],
      ['Duplicate', () => ui.duplicateSession(app, s.id)],
      ...(s.status === 'running' ? [['Restart', act('restart')], ['Stop', act('stop')]] : [['Start', act('restart')]]),
      null,
      ['Delete…', async () => {
        if (await ui.confirm(`Delete "${s.name}"? The process is killed and its scrollback is removed.`, { ok: 'Delete', danger: true })) await client.api('DELETE', `/api/sessions/${s.id}`).catch((e) => ui.toast(e.message));
      }],
    ], ev);
  }
}
