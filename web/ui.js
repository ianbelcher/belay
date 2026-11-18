import { h, shortPath, debounce, fmtTime } from './util.js';
import { HOST_RE, USER_RE } from '../shared/ssh.js';
import { sessionName } from '../shared/names.js';
import { parseFields, launch, describeLaunch, renderName, asksForInput, EXIT_POLICIES, AGENTS, DEFAULT_TEMPLATES, LOCATION_VARS } from '../shared/template-core.js';
import { COMMANDS, IS_MAC, defaultKeys, displayChord, chordFromEvent, normalizeChord, chordChips } from './keys.js';
import { webUrl } from './web.js';
import { editorFontSize } from './editor.js';

// ---- primitives ----------------------------------------------------------------

/** A message in the corner. `action` ({ label, fn }) adds a button, for things only a click may do, like a copy outside HTTPS. */
export function toast(msg, kind = 'error', action = null) {
  const el = h('div', { class: `toast ${kind}` }, msg);
  const dismiss = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); };
  if (action) el.append(h('button', { class: 'btn small primary', onclick: () => { action.fn(); dismiss(); } }, action.label));
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(dismiss, action ? 15000 : kind === 'error' ? 6000 : 2500);
}

/** Top-anchored modal so a change in height never moves the header. `title: null` hides the header. */
export function modal({ title, width, body, footer, onClose, cls = '' }) {
  const root = document.getElementById('modals');
  const box = h('div', { class: `modal ${cls}`, style: width ? `width:${width}` : '' },
    title == null ? null : h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'btn icon', title: 'Close (Esc)', onclick: () => close() }, '×')),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  const backdrop = h('div', { class: 'modal-backdrop' }, box);
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  let closed = false;
  // The keyboard stays with the dialog on top: a pane underneath that takes the focus (one that has just
  // finished loading, a page in a frame) gives it straight back, so keys typed here are never lost to it.
  let inside = null;
  const keepFocus = (e) => {
    if (closed || root.lastElementChild !== backdrop) return;
    if (backdrop.contains(e.target)) { inside = e.target; return; }
    (inside?.isConnected ? inside : box.querySelector('input, select, textarea, button'))?.focus();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', keepFocus, true);
    onClose?.();
    window.belay?.activePanel()?.focus();
  };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', keepFocus, true);
  root.append(backdrop);
  // Synchronous, so keys typed right after the chord land here: the first field, not the header's close button.
  (box.querySelector('.modal-body input, .modal-body select, .modal-body textarea') || box.querySelector('button'))?.focus();
  return { close, box };
}

export function confirm(message, { ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title: 'Confirm', width: '420px',
      body: h('p', {}, message),
      footer: [
        // The answer first: closing resolves the rest as a cancel.
        h('button', { class: 'btn', onclick: () => { resolve(false); m.close(); } }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { resolve(true); m.close(); } }, ok),
      ],
      onClose: () => resolve(false),
    });
  });
}

/** A question with several answers: `options` are [value, label, 'primary' | 'danger'?]. Resolves to a value, or null. */
export function choose(message, options) {
  return new Promise((resolve) => {
    let done = false;
    const pick = (v) => { if (done) return; done = true; resolve(v); m.close(); };
    const m = modal({
      title: 'Confirm', width: '440px',
      body: h('p', {}, message),
      footer: options.map(([v, label, kind]) => h('button', { class: `btn${kind ? ` ${kind}` : ''}`, onclick: () => pick(v) }, label)),
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    m.box.querySelector('.modal-foot .btn.primary')?.focus();
  });
}

export function prompt(title, value = '', label = 'Name') {
  return new Promise((resolve) => {
    const input = h('input', { value, spellcheck: 'false' });
    const submit = () => { resolve(input.value); m.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const m = modal({
      title, width: '420px',
      body: field(label, input),
      footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, 'OK')],
      onClose: () => resolve(null),
    });
    setTimeout(() => { if (input.value === value) input.select(); }, 0);
  });
}

/**
 * Button for an action that waits on the server. While it runs the button shows a spinner and the buttons
 * beside it are disabled, so a second click (or Enter, which clicks it) cannot repeat the action.
 */
export function actionBtn(label, fn, attrs = {}) {
  const btn = h('button', attrs, label);
  btn.addEventListener('click', async (e) => {
    const group = [...(btn.parentElement?.querySelectorAll(':scope > button') ?? [btn])];
    if (group.some((b) => b.classList.contains('busy'))) return;
    const was = group.map((b) => b.disabled);
    btn.classList.add('busy');
    for (const b of group) b.disabled = true;
    try { await fn(e); } catch (err) { toast(err.message); }
    finally { btn.classList.remove('busy'); group.forEach((b, i) => { b.disabled = was[i]; }); }
  });
  return btn;
}

export function field(label, input) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
}

const select = (options, value, attrs = {}) => h('select', attrs, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));

/** Directory input with completion from the server's directory listing. */
/**
 * A directory field that browses as you type: under it, the directories in the one typed so far, on the
 * project's host over ssh or on this machine (`place()` says which). ↑ ↓ choose one, Tab or Enter goes into it
 * (and lists what is in it), a click the same; Escape closes the list. Empty, it starts at home there.
 */
function dirPicker(app, value, place) {
  const input = h('input', { value: value || '', placeholder: '~', spellcheck: 'false', autocomplete: 'off', class: 'dp-input' });
  const list = h('div', { class: 'dp-list hidden', role: 'listbox' });
  let rows = [];
  let index = -1;
  let seq = 0;
  const isOpen = () => !list.classList.contains('hidden');
  const close = () => { list.classList.add('hidden'); index = -1; };
  const draw = (msg) => {
    list.replaceChildren(...rows.map((r, i) => {
      const el = h('div', { class: `dp-row${i === index ? ' on' : ''}`, role: 'option', title: r }, r);
      // Not a click: the field keeps the focus.
      el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(r); });
      return el;
    }), ...(msg ? [h('div', { class: 'dp-note' }, msg)] : []));
    list.classList.remove('hidden');
    list.querySelector('.dp-row.on')?.scrollIntoView({ block: 'nearest' });
  };
  const load = debounce(async () => {
    // Only for the field being typed in: one left meanwhile shows no list.
    if (document.activeElement !== input) return;
    const { host, user } = place();
    const v = input.value.trim();
    const ask = v || (host ? '~/' : `${app.client.state.server.home || ''}/`);
    const base = ask.includes('/') ? ask.slice(0, ask.lastIndexOf('/') + 1) : '';
    const mine = ++seq;
    rows = [];
    index = -1;
    draw(host ? `Looking on ${host}…` : 'Looking…');
    try {
      const r = await app.client.api('GET', `/api/fs/entries?${new URLSearchParams({ path: ask, host, user: host ? user : '' })}`);
      if (mine !== seq) return;
      if (document.activeElement !== input) { close(); return; }
      rows = r.entries.filter((e) => e.endsWith('/')).map((e) => base + e);
      draw(rows.length ? '' : 'No directories here');
    } catch (e) {
      if (mine === seq) draw(e.message);
    }
  }, 120);
  const choose = (r) => { input.value = r; load(); };
  input.addEventListener('focus', load);
  input.addEventListener('input', load);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) { load(); return; }
      index = e.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, -1);
      draw(rows.length ? '' : list.querySelector('.dp-note')?.textContent || '');
    } else if ((e.key === 'Enter' || e.key === 'Tab') && isOpen() && rows[index]) {
      e.preventDefault();
      e.stopPropagation();
      choose(rows[index]);
    }
  });
  // Escape closes the list before it would close the dialog.
  const onEsc = (e) => { if (e.key === 'Escape' && e.target === input && isOpen()) { e.stopPropagation(); close(); } };
  window.addEventListener('keydown', onEsc, true);
  return { input, el: h('div', { class: 'dp' }, input, list), refresh: () => { if (document.activeElement === input) load(); }, dispose: () => window.removeEventListener('keydown', onEsc, true) };
}

/**
 * Path input that completes from a directory listing, here or on a host over ssh, like a shell does: the
 * entries of the directory typed so far, directories ending in a slash.
 */
function pathInput(app, { host = '', user = '', dir = '' } = {}) {
  const listId = `paths-${Math.random().toString(36).slice(2, 8)}`;
  const input = h('input', { list: listId, spellcheck: 'false', autocomplete: 'off' });
  const list = h('datalist', { id: listId });
  let asked = '';
  const load = debounce(async () => {
    const v = input.value;
    const base = v.includes('/') ? v.slice(0, v.lastIndexOf('/') + 1) : '';
    if (asked === `${base}\0${v}`) return;
    asked = `${base}\0${v}`;
    try {
      const q = new URLSearchParams({ path: v, host, user, dir });
      const r = await app.client.api('GET', `/api/fs/entries?${q}`);
      if (input.value === v) list.replaceChildren(...r.entries.map((e) => h('option', { value: base + e })));
    } catch {}
  }, 150);
  input.addEventListener('input', load);
  input.addEventListener('focus', load);
  return { input, el: h('div', { class: 'with-list' }, input, list) };
}

/** Open a file in an editor tab, from the project's machine: its host over ssh, or this one. */
export function openFileDialog(app, { group } = {}) {
  const v = app.dock.activeView() || {};
  const host = v.host || '';
  const user = host ? v.user || '' : '';
  // From the project's directory.
  const dir = v.dir || (host ? '' : app.client.state.server.home || '');
  const pick = pathInput(app, { host, user, dir });
  pick.input.value = dir ? `${dir.replace(/\/+$/, '')}/` : '';
  pick.input.placeholder = host ? 'relative to the login directory, or /absolute' : '/path/to/file';
  const error = h('p', { class: 'error-text hidden' });
  const submit = () => {
    const p = pick.input.value.trim();
    const bad = !p || p.endsWith('/') ? 'Pick a file, not a directory.' : '';
    error.textContent = bad;
    error.classList.toggle('hidden', !bad);
    if (bad) return;
    m.close();
    app.dock.openFile({ path: p, host, user, dir: host ? dir : '', create: true }, { group });
  };
  const body = h('div', { class: 'form' }, field('File', pick.el),
    h('p', { class: 'hint' }, `${host ? `On ${user ? `${user}@` : ''}${host}, the project's host. ` : ''}A file that is not there yet is made when you save.`), error);
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
  const m = modal({
    title: 'Open file', width: '560px', body,
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, 'Open')],
  });
  setTimeout(() => { pick.input.focus(); pick.input.setSelectionRange(pick.input.value.length, pick.input.value.length); }, 0);
}

/**
 * A Host field (and its User field) that knows your ssh config: its hosts are offered as you type, `user@host`
 * splits into the two, and a line underneath says where ssh will really connect (`ssh -G`, nothing connects).
 */
function sshPlace(app, hostIn, userIn) {
  const listId = `ssh-hosts-${Math.random().toString(36).slice(2)}`;
  const list = h('datalist', { id: listId });
  hostIn.setAttribute('list', listId);
  app.client.api('GET', '/api/ssh/hosts').then((hosts) => {
    list.replaceChildren(...hosts.map((x) => h('option', { value: x.name }, [x.user && `${x.user}@`, x.hostname || '', x.port && `:${x.port}`].filter(Boolean).join(''))));
  }).catch(() => {});
  const hint = h('p', { class: 'hint ssh-where' });
  let timer = null;
  let asked = '';
  const where = () => {
    const host = hostIn.value.trim();
    const user = userIn.value.trim();
    const key = `${user}@${host}`;
    if (key === asked) return;
    asked = key;
    userIn.disabled = !host;
    if (!host) userIn.placeholder = '';
    if (!host || !HOST_RE.test(host) || (user && !USER_RE.test(user))) { hint.textContent = ''; return; }
    app.client.api('GET', `/api/ssh/resolve?${new URLSearchParams({ host, user })}`).then((r) => {
      if (asked !== key) return;
      hint.textContent = `ssh connects to ${r.user ? `${r.user}@` : ''}${r.hostname}${r.port !== 22 ? `:${r.port}` : ''}${r.proxyJump ? `, through ${r.proxyJump}` : ''}`;
      // Your ssh config's user for the host is the one: the field is only for hosts it leaves to belay.
      userIn.disabled = !!r.configUser;
      if (r.configUser) userIn.value = '';
      userIn.placeholder = r.configUser ? `${r.configUser}, from your ssh config` : r.user;
      userIn.title = r.configUser ? 'Your ssh config sets the user for this host' : '';
    }).catch(() => { if (asked === key) hint.textContent = ''; });
  };
  const changed = () => {
    // user@host typed into Host: the user goes to its own field.
    const m = /^([^@\s]+)@(.+)$/.exec(hostIn.value.trim());
    if (m) { userIn.value = m[1]; hostIn.value = m[2]; }
    clearTimeout(timer);
    timer = setTimeout(where, 300);
  };
  hostIn.addEventListener('input', changed);
  userIn.addEventListener('input', changed);
  where();
  return { list, hint };
}

const HOST_HELP = 'Host is a name from your ssh config, a host name or an address, with :port when it needs one (an IPv6 address in brackets).';

/**
 * New project, or the settings of an existing one. A project is a place: a directory, here or on a host over
 * ssh. Everything in it starts there, and its files sidebar shows it.
 */
export function openProjectDialog(app, view = null) {
  const input = (value, placeholder) => h('input', { value: value || '', placeholder, spellcheck: 'false', autocomplete: 'off' });
  const nameIn = input(view?.name, `Project ${app.dock.views.length + 1}`);
  const hostIn = input(view?.host, 'this machine');
  const userIn = input(view?.user, '');
  const place = sshPlace(app, hostIn, userIn);
  // Where everything in the project starts, and where its files are: a directory on its host, or here,
  // browsed there as you type.
  const dir = dirPicker(app, view?.dir || '', () => ({ host: hostIn.value.trim(), user: userIn.disabled ? '' : userIn.value.trim() }));
  hostIn.addEventListener('change', () => dir.refresh());
  const error = h('p', { class: 'error-text hidden' });
  const submit = () => {
    const fields = { name: nameIn.value.trim(), dir: dir.input.value.trim().replace(/(.)\/+$/, '$1'), host: hostIn.value.trim(), user: hostIn.value.trim() && !userIn.disabled ? userIn.value.trim() : '' };
    const bad = fields.host && !HOST_RE.test(fields.host) ? HOST_HELP : fields.user && !USER_RE.test(fields.user) ? 'User can only have letters, digits, dots, dashes and underscores.' : '';
    error.textContent = bad;
    error.classList.toggle('hidden', !bad);
    if (bad) return;
    if (view) app.dock.updateView(view.id, fields);
    else app.dock.addView(fields);
    m.close();
  };
  const body = h('div', { class: 'form' }, field('Name', nameIn),
    h('div', { class: 'row' }, field('Host', hostIn), field('User', userIn)), place.hint, place.list,
    field('Directory', dir.el), error);
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
  const m = modal({
    title: view ? 'Edit project' : 'New project', width: '480px', body, onClose: () => dir.dispose(),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, view ? 'Save' : 'Create')],
  });
  // Selected for typing over, unless typing has already begun there (the modal focused it straight away) or
  // in another field.
  const initialName = nameIn.value;
  setTimeout(() => {
    const at = document.activeElement;
    if (nameIn.value === initialName && (at === nameIn || !m.box.contains(at))) { nameIn.focus(); nameIn.select(); }
  }, 0);
}
export const promptRename = (app, view) => { if (view) openProjectDialog(app, view); };

/** Context menu at a point, or under an element. Items are [label, fn, detail?]; null draws a separator. */
export function showMenu(items, at) {
  closeMenu();
  const r = at instanceof Element ? at.getBoundingClientRect() : null;
  const x = r ? r.left : at.clientX, y = r ? r.bottom + 2 : at.clientY;
  const menu = h('div', { class: 'menu', style: `left:${x}px;top:${y}px` },
    ...items.map((it) => (it ? h('button', { class: 'menu-item', onclick: () => { closeMenu(); it[1](); } }, it[0], it[2] ? h('span', { class: 'menu-detail' }, it[2]) : null) : h('div', { class: 'menu-sep' }))));
  menu.id = 'ctx-menu';
  menu.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.append(menu);
  // Keep it on screen.
  const b = menu.getBoundingClientRect();
  if (b.right > innerWidth - 4) menu.style.left = `${Math.max(4, innerWidth - b.width - 4)}px`;
  if (b.bottom > innerHeight - 4) menu.style.top = `${Math.max(4, y - b.height - (r ? r.height + 4 : 0))}px`;
  setTimeout(() => document.addEventListener('mousedown', closeMenu, { once: true }), 0);
}
function closeMenu() { document.getElementById('ctx-menu')?.remove(); }

export function viewMenu(app, view, ev) {
  showMenu([
    ['Edit project…', () => openProjectDialog(app, view)],
    ['Move left', () => app.dock.moveView(view.id, -1)],
    ['Move right', () => app.dock.moveView(view.id, 1)],
    ['New project…', () => openProjectDialog(app)],
    ['Close project', () => app.dock.confirmRemove(view), 'its sessions carry on'],
    null,
    ['Delete project…', () => app.dock.confirmDelete(view)],
  ], ev);
}

/** Right-click on a tab. */
export function tabMenu(app, panelId, ev) {
  const panel = app.dock.api.getPanel(panelId);
  if (!panel) return;
  const sid = panel.params?.sessionId, noteId = panel.params?.noteId;
  const others = app.dock.views.filter((v) => v.id !== app.dock.activeViewId).map((v) => [`Move to ${v.name}`, () => app.dock.moveToView([panelId], v.id)]);
  const pane = app.panels.get(panelId);
  // Every kind of tab can hide its group's tab bar; the pane's ▭ brings it back.
  const tabBar = ['Hide tab bar', () => app.dock.current()?.setTabBar(panel.group, false), panel.group.panels.length > 1 ? `${panel.group.panels.length} tabs` : ''];
  if (sid) {
    showMenu([
      ['Edit…', () => openSessionEditor(app, sid)],
      ['Duplicate', () => duplicateSession(app, sid, panel.group)],
      ...launchers(app).map((t) => [`New ${launcherLabel(t)}`, () => openHere(app, t.id, { from: sid, group: panel.group })]),
      null,
      ['Restart', () => pane?.restart()],
      ['Maximize / restore', () => pane?.toggleMaximize()],
      tabBar,
      ...(others.length ? [null, ...others] : []),
      null,
      ['Remove from project', () => panel.api.close()],
    ], ev);
  } else if (panel.params?.url || panel.params?.remote) {
    showMenu([
      ['Edit…', () => openWebDialog(app, { panelId })],
      ['Reload', () => pane?.action('reload')],
      ['Open in a browser tab', () => pane?.action('open')],
      tabBar,
      ...(others.length ? [null, ...others] : []),
      null,
      ['Close', () => app.dock.closePanel(panelId)],
    ], ev);
  } else if (panel.params?.path && !pane?.save) {
    showMenu([
      ['Reload', () => pane?.action('reload')],
      ['Open in a browser tab', () => pane?.action('open')],
      ['Open in VS Code', () => pane?.action('vscode')],
      ['Copy path', () => pane?.action('copy-path')],
      tabBar,
      ...(others.length ? [null, ...others] : []),
      null,
      ['Close', () => app.dock.closePanel(panelId)],
    ], ev);
  } else if (panel.params?.path) {
    showMenu([
      ['Save', () => pane?.action('save')],
      [`Word wrap: ${pane?.wrap ? 'on' : 'off'}`, () => pane?.toggleWrap()],
      ['Reload from disk', () => pane?.action('reload')],
      ['Open in VS Code', () => pane?.action('vscode')],
      ['Copy path', () => pane?.action('copy-path')],
      tabBar,
      ...(others.length ? [null, ...others] : []),
      null,
      ['Close', () => app.dock.closePanel(panelId)],
    ], ev);
  } else if (panel.params?.wallId) {
    showMenu([
      ['Rename…', () => pane?.action('rename')],
      ['Show the whole wall', () => pane?.fit()],
      tabBar,
      null,
      ['Hide', () => panel.api.close()],
    ], ev);
  } else if (noteId) {
    showMenu([
      ['Rename…', () => pane?.action('rename')],
      [`Word wrap: ${pane?.wrap ? 'on' : 'off'}`, () => pane?.toggleWrap()],
      tabBar,
      null,
      ['Hide', () => panel.api.close()],
      ['Delete note…', () => deleteNote(app, noteId)],
    ], ev);
  }
}

/** The + after a group's tabs. */
export function addMenu(app, group, anchor) {
  const from = app.dock.sessionOf(group)?.id;
  const spec = hereSpec(app, null, from);
  const v = app.dock.activeView() || {};
  const on = v.host ? ` on ${v.user ? `${v.user}@` : ''}${v.host}` : '';
  const where = v.host ? v.dir || '~' : shortPath(v.dir || spec.cwd, app.client.state.server.home);
  showMenu([
    ...launchers(app).map((t) => [`${launcherLabel(t)}${on}`, () => openHere(app, t.id, { from, group }), where]),
    null,
    ['Notes', () => app.dock.showNotes({ group }).catch((e) => toast(e.message)), "this project's"],
    ['Post-its', () => app.dock.showWall({ group }).catch((e) => toast(e.message)), "this project's"],
    ['File…', () => openFileDialog(app, { group }), v.host || ''],
    ['Web page…', () => openWebDialog(app, { group }), 'in this browser'],
    ['Remote page…', () => openWebDialog(app, { group, remote: true }), v.host || 'this machine'],
  ], anchor);
}

/**
 * The templates to start from a menu: the built-ins in their order (a shell, then the agents), then your own
 * (htop, k9s…), then Command, which asks what to run.
 */
export function launchers(app) {
  const order = DEFAULT_TEMPLATES.map((d) => d.id).filter((id) => id !== 'command');
  const rank = (t) => (t.builtin && order.includes(t.id) ? order.indexOf(t.id) : t.builtin && t.id === 'command' ? order.length + 1 : order.length);
  return app.client.state.templates.map((t, i) => [t, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);
}

/** A template's name, with … when starting it asks for something first. */
export const launcherLabel = (t) => `${t.name}${asksForInput(t) ? '…' : ''}`;

/**
 * A session of template `templateId` (a shell, an agent, htop…) for the project in front (`from` is the pane
 * it opens beside). The project says where: its directory, on its host over ssh or on this machine. The server
 * gives it a name.
 */
export function hereSpec(app, templateId, from) {
  const v = app.dock.activeView() || {};
  const s = from ? app.client.session(from) : null;
  const home = app.client.state.server.home;
  const t = templateId ? app.client.template(templateId) : null;
  // Where is the project's (its host, its directory): the server knows, and names it too.
  void s;
  const cwd = home;
  const vars = {};
  const project = v.id || null;
  if (!t) return { missing: templateId, cwd, vars, project };
  return { templateId: t.id, cwd, vars, project };
}

/** Starts one; a template that needs values first (Command asks what to run) opens the new session form on it. */
export async function openHere(app, templateId, { from, group } = {}) {
  const spec = hereSpec(app, templateId, from);
  if (spec.missing) { toast(`There is no template "${spec.missing}" any more; Settings → Templates has the ones there are.`); return; }
  if (asksForInput(app.client.template(spec.templateId))) { openNewSession(app, { templateId: spec.templateId, cwd: spec.cwd, vars: spec.vars, project: spec.project, group }); return; }
  try {
    const s = await app.client.api('POST', '/api/sessions', spec);
    app.dock.openSession(s.id, { group });
    app.side?.refresh();
  } catch (e) { toast(e.message); }
}

/** Same template, directory and values, with a free name. An agent's conversation id is left out, so it starts fresh. */
export async function duplicateSession(app, sid, group) {
  const s = app.client.session(sid);
  if (!s) return;
  const { session: _conversation, ...vars } = s.vars || {};
  try {
    const d = await app.client.api('POST', '/api/sessions', { templateId: s.templateId, cwd: s.cwd, vars, project: s.project || app.dock.activeView()?.id, exitPolicy: s.exitPolicy });
    app.dock.openSession(d.id, { group: group || app.dock.api.getPanel(app.dock.panelId(sid))?.group });
    app.side?.refresh();
    return d;
  } catch (e) { toast(e.message); return null; }
}

/**
 * A new page tab, or the settings of one (`panelId`): a title and the one address it shows. A web page loads in
 * this browser; a remote page (`remote`) is opened from the project's machine and served by belay.
 */
export function openWebDialog(app, { group, panelId, remote } = {}) {
  const pane = panelId ? app.panels.get(panelId) : null;
  const cur = pane?.web || {};
  const v = app.dock.activeView() || {};
  const machine = v.host ? `${v.user ? `${v.user}@` : ''}${v.host}` : 'the belay machine';
  const kind = select([['web', 'This browser: a web page'], ['remote', `The project's machine (${machine}): a remote page`]], (pane ? cur.remote : remote) ? 'remote' : 'web');
  const urlIn = h('input', { value: cur.remote ? cur.address || '' : cur.url || '', spellcheck: 'false', autocomplete: 'off' });
  const titleIn = h('input', { value: cur.title || '', placeholder: 'from the address', spellcheck: 'false', autocomplete: 'off' });
  const hint = h('p', { class: 'hint' });
  const error = h('p', { class: 'error-text hidden' });
  const sync = () => {
    const r = kind.value === 'remote';
    urlIn.placeholder = r ? 'localhost:3000, or service.namespace.svc.cluster.local:8080' : 'https://';
    hint.textContent = r
      ? `Everything on the page goes through ${machine}: localhost is that machine, and names resolve there. belay serves it to this browser under its own name, so nothing needs forwarding.`
      : 'Loaded by this browser, as any page is: localhost is the machine this browser runs on.';
  };
  kind.addEventListener('change', sync);
  sync();
  const submit = () => {
    const r = kind.value === 'remote';
    const raw = urlIn.value.trim();
    const url = r ? null : webUrl(raw);
    const bad = r ? (!raw || /\s/.test(raw) ? 'Give an address, such as localhost:3000.' : '') : url ? '' : 'Give an http:// or https:// address.';
    error.textContent = bad;
    error.classList.toggle('hidden', !bad);
    if (bad) return;
    const title = titleIn.value.trim() || (r ? raw.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '') : new URL(url).host);
    const web = r ? { address: raw, title, remote: true } : { url, title };
    if (pane) pane.setWeb(web);
    else app.dock.openWeb(web, { group });
    m.close();
  };
  const body = h('div', { class: 'form' }, field('Opens from', kind), field('Address', urlIn), field('Title', titleIn), hint, error);
  body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } });
  const m = modal({
    title: pane ? 'Edit page tab' : remote ? 'New remote page' : 'New web tab', width: '560px', body,
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, pane ? 'Save' : 'Open')],
  });
  setTimeout(() => urlIn.focus(), 0);
}

/** Every editor's text a size larger (+1) or smaller (-1), or back to the terminals' size (0). Shared by all browsers. */
export async function setEditorFontSize(app, step) {
  const st = app.settings();
  const size = step ? Math.min(40, Math.max(6, editorFontSize(st) + step)) : 0;
  try {
    await app.client.api('PUT', '/api/settings', { editorFontSize: size });
    toast(`Editor text: ${size || `${st.fontSize || 13}, as the terminals`}`, 'info');
  } catch (e) { toast(e.message); }
}

export async function deleteNote(app, noteId) {
  const n = app.client.note(noteId);
  if (!n) return;
  if (!(await confirm(`Delete the note "${n.title}"? Its text is gone for good.`, { ok: 'Delete', danger: true }))) return;
  try { await app.client.api('DELETE', `/api/notes/${noteId}`); } catch (e) { toast(e.message); }
}

// ---- command palette --------------------------------------------------------------

export function openPalette(app) {
  const items = app.keys.paletteItems();
  let filtered = items, index = 0;
  const input = h('input', { class: 'pal-input', placeholder: 'Type a command, project, session, note or template…', spellcheck: 'false' });
  const list = h('div', { class: 'pal-list' });
  const choose = (it) => { if (!it) return; m.close(); it.run(); };
  const render = () => {
    list.replaceChildren(...filtered.slice(0, 60).map((it, i) => h('div', {
      class: `pal-item${i === index ? ' active' : ''}`,
      onmousedown: (e) => { e.preventDefault(); choose(it); },
      onmousemove: () => { if (index !== i) { index = i; render(); } },
    }, h('span', { class: 'pal-label' }, it.label), it.detail ? h('span', { class: 'pal-detail' }, it.detail) : null, it.keys?.length ? h('span', { class: 'pal-keys' }, ...it.keys.map((k) => h('kbd', {}, displayChord(k)))) : null)));
    if (!filtered.length) list.append(h('div', { class: 'pal-empty' }, 'No matches'));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const filter = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    filtered = items.filter((it) => words.every((w) => `${it.label} ${it.detail || ''}`.toLowerCase().includes(w)));
    index = 0;
    render();
  };
  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(index + 1, filtered.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(index - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(filtered[index]); }
  });
  const m = modal({ title: null, width: '560px', cls: 'palette', body: [input, list] });
  render();
}

// ---- session form (shared by create + edit) ---------------------------------------

function builtinsFor(app, { cwd, name, sid }) {
  const sv = app.client.state.server;
  return { shell: sv.shell || '/bin/sh', cwd, home: sv.home || '~', name: name || '', sid: sid || 'SESSION_ID', port: sv.port, url: sv.baseUrl, belaydir: sv.belaydir || '<belay>' };
}

/**
 * Form used to create or edit a session: a template, where it runs (a host, or this machine, and the
 * directory there), and the template's own fields. The preview is live.
 */
function sessionForm(app, initial) {
  const templates = launchers(app);
  let tpl = app.client.template(initial.templateId) || templates[0];
  let nameTouched = !!initial.name;
  const vars = { ...(initial.vars || {}) };
  // Where it runs is its project's (its host, as its user, and its directory): nothing of the session's own.
  const projectId = initial.project !== undefined ? initial.project : app.dock?.activeView()?.id ?? null;
  const proj = app.dock?.views.find((v) => v.id === projectId) || {};
  const host = proj.host || '';
  const user = host ? proj.user || '' : '';
  const home = app.client.state.server.home;
  for (const k of LOCATION_VARS) delete vars[k];
  const run = () => ({ ...vars, ...(host ? { host, user, ...(proj.dir ? { dir: proj.dir } : {}) } : {}) });
  const cwd = host ? home : proj.dir || initial.cwd || home;
  // A new one is named like sly-fox, unless its template names it.
  const fresh = sessionName(new Set([...app.client.state.sessions.values()].map((x) => x.name)));

  const nameIn = h('input', { value: initial.name || '', placeholder: 'Name', spellcheck: 'false', autocomplete: 'off' });
  const tplSel = select(templates.map((t) => [t.id, t.name]), tpl?.id);
  const policySel = select([['', 'default'], ...EXIT_POLICIES.map((p) => [p, p])], initial.exitPolicy || '');
  const fieldsBox = h('div', { class: 'tpl-fields' });
  const preview = h('pre', { class: 'preview' });

  const sync = () => renderPreview();
  const renderPreview = () => {
    if (!tpl) return;
    const b = builtinsFor(app, { cwd, name: nameIn.value, sid: initial.id });
    try {
      preview.textContent = describeLaunch(launch(tpl, run(), b));
      preview.classList.remove('error');
    } catch (e) { preview.textContent = e.message; preview.classList.add('error'); }
    if (!nameTouched) nameIn.value = tpl.nameTemplate ? renderName(tpl, run(), b) : fresh;
    policySel.options[0].textContent = `default (${tpl.exitPolicy || 'hold'})`;
  };

  const renderFields = () => {
    const { fields, error } = parseFields(tpl?.command || '', tpl?.provision || '');
    fieldsBox.replaceChildren(...fields.filter((f) => !LOCATION_VARS.includes(f.name)).map((f) => {
      const inp = h('input', { value: vars[f.name] || '', placeholder: tpl.defaults?.[f.name] || '', spellcheck: 'false', autocomplete: 'off' });
      inp.addEventListener('input', () => { if (inp.value.trim()) vars[f.name] = inp.value.trim(); else delete vars[f.name]; renderPreview(); });
      return field(h('span', {}, f.name, f.required ? h('span', { class: 'req' }, ' *') : null), inp);
    }));
    if (error) fieldsBox.append(h('p', { class: 'error-text' }, error));
    sync();
  };

  tplSel.addEventListener('change', () => { tpl = app.client.template(tplSel.value); renderFields(); });
  // Typed in, the name is yours, even emptied while you retype it; left empty, it goes back to the template's.
  nameIn.addEventListener('input', () => { nameTouched = true; renderPreview(); });
  nameIn.addEventListener('blur', () => { if (!nameIn.value.trim()) { nameTouched = false; renderPreview(); } });

  const el = h('div', { class: 'form' },
    field('Name', nameIn),
    h('div', { class: 'row' }, field('Template', tplSel), field('On exit', policySel)),
    fieldsBox,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Command'), preview));
  renderFields();
  return {
    el,
    template: () => tpl,
    vars: () => ({ ...vars }),
    setTemplate: (id) => { tplSel.value = id; tpl = app.client.template(id); renderFields(); },
    read: () => {
      const name = nameIn.value.trim() || (tpl.nameTemplate ? renderName(tpl, run(), builtinsFor(app, { cwd, name: '', sid: initial.id })) : fresh);
      return { templateId: tpl.id, name, cwd, vars: { ...vars }, project: projectId, exitPolicy: policySel.value || null };
    },
    focus: () => { nameIn.focus(); nameIn.select(); },
  };
}

/** Turn the current template + field values into a new template with those values as defaults. */
async function saveAsTemplate(app, form) {
  const tpl = form.template();
  const data = form.read();
  const name = await prompt('Save as new template', `${tpl.name} copy`, 'Template name');
  if (!name?.trim()) return null;
  try {
    const created = await app.client.api('POST', '/api/templates', {
      name: name.trim(), command: tpl.command, provision: tpl.provision || '', nameTemplate: tpl.nameTemplate || '', agent: tpl.agent || '',
      exitPolicy: data.exitPolicy || tpl.exitPolicy || 'hold', defaults: { ...(tpl.defaults || {}), ...data.vars },
    });
    toast(`Template "${created.name}" saved`, 'info');
    return created;
  } catch (e) { toast(e.message); return null; }
}

const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

export function openNewSession(app, preset = {}) {
  if (!app.client.state.templates.length) { toast('No templates defined. Add one in Settings.'); return; }
  // Start from where this project works: its host and directory, or the pane's directory.
  const here = app.dock ? hereSpec(app, null, app.dock.sessionOf(preset.group)?.id) : {};
  const form = sessionForm(app, {
    templateId: preset.templateId || safeGet('belay.lastTemplate') || 'shell',
    cwd: preset.cwd || here.cwd || safeGet('belay.lastCwd') || app.client.state.server.home,
    vars: preset.vars || here.vars || {},
    project: preset.project !== undefined ? preset.project : here.project ?? null,
  });
  const startNow = h('input', { type: 'checkbox', checked: true });
  const openHere = h('input', { type: 'checkbox', checked: true });
  const submit = async () => {
    const data = form.read();
    try {
      const s = await app.client.api('POST', '/api/sessions', { ...data, autostart: startNow.checked });
      try { localStorage.setItem('belay.lastCwd', data.cwd); localStorage.setItem('belay.lastTemplate', data.templateId); } catch {}
      m.close();
      if (openHere.checked) app.dock.openSession(s.id, { group: preset.group });
      app.side?.refresh();
    } catch (e) { toast(e.message); }
  };
  const createBtn = actionBtn('Create', submit, { class: 'btn primary' });
  form.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); createBtn.click(); } });
  const m = modal({
    title: 'New session', width: '560px',
    body: [form.el, h('div', { class: 'row checks' }, h('label', { class: 'check' }, startNow, ' Start now'), h('label', { class: 'check' }, openHere, ' Open as a tab in this project'))],
    footer: [
      actionBtn('Save as template…', async () => { const t = await saveAsTemplate(app, form); if (t) form.setTemplate(t.id); }, { class: 'btn left', title: 'Save this template with the current values as its defaults' }),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      createBtn,
    ],
  });
  setTimeout(() => form.focus(), 0);
}

export function openSessionEditor(app, sid) {
  const s = app.client.session(sid);
  if (!s) { toast('Session not found'); return; }
  const form = sessionForm(app, s);
  const info = h('p', { class: 'hint' },
    `${s.status}${s.pid ? ` · pid ${s.pid}` : ''}${s.startedAt ? ` · started ${fmtTime(s.startedAt)}` : ''}${s.status === 'exited' ? ` · exit code ${s.exitCode}` : ''}${s.activity ? ` · ${(AGENTS.find((a) => a.id === s.activity.agent) || AGENTS[0]).label} ${s.activity.state}` : ''}`);
  const save = async (restart) => {
    try {
      await app.client.api('PATCH', `/api/sessions/${sid}`, form.read());
      if (restart) await app.client.api('POST', `/api/sessions/${sid}/restart`);
      m.close();
      app.side?.refresh();
    } catch (e) { toast(e.message); }
  };
  const del = async () => {
    if (!(await confirm(`Delete "${s.name}"? The process is killed and its scrollback is removed.`, { ok: 'Delete', danger: true }))) return;
    try { await app.client.api('DELETE', `/api/sessions/${sid}`); m.close(); app.side?.refresh(); } catch (e) { toast(e.message); }
  };
  const act = async (p) => { try { await app.client.api('POST', `/api/sessions/${sid}/${p}`); m.close(); } catch (e) { toast(e.message); } };
  const m = modal({
    title: 'Edit session', width: '640px',
    body: [info, form.el],
    footer: [
      actionBtn('Delete', del, { class: 'btn danger left' }),
      h('a', { class: 'btn left', href: `/api/sessions/${sid}/scrollback?plain=1`, download: '' }, 'Scrollback'),
      actionBtn('Duplicate', async () => { if (await duplicateSession(app, sid)) m.close(); }, { class: 'btn left', title: 'A new session with the same template, directory and values' }),
      s.status === 'running' ? actionBtn('Stop', () => act('stop'), { class: 'btn left' }) : actionBtn('Start', () => act('restart'), { class: 'btn left' }),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      actionBtn('Save', () => save(false), { class: 'btn', title: 'Applies on the next start' }),
      actionBtn('Save & restart', () => save(true), { class: 'btn primary' }),
    ],
  });
}

// ---- settings -------------------------------------------------------------------

export function openSettings(app, tab = 'templates') {
  const body = h('div', { class: 'settings' });
  const tabs = h('div', { class: 'settings-tabs' });
  let cleanup = null;
  const render = (which) => {
    cleanup?.();
    tab = which;
    tabs.replaceChildren(...[['templates', 'Templates'], ['shortcuts', 'Shortcuts'], ['general', 'General']].map(([id, label]) =>
      h('button', { class: `tab${tab === id ? ' active' : ''}`, onclick: () => render(id) }, label)));
    const pane = tab === 'templates' ? templatesPane(app) : tab === 'shortcuts' ? shortcutsPane(app) : generalPane(app, () => m.close());
    cleanup = pane.cleanup || null;
    body.replaceChildren(pane.el || pane);
  };
  const m = modal({ title: 'Settings', width: '860px', body: [tabs, body], onClose: () => cleanup?.() });
  render(tab);
}

function templatesPane(app) {
  const list = h('div', { class: 'tpl-list' });
  const editor = h('div', { class: 'tpl-editor' });
  let current = null;
  const blank = () => ({ name: '', command: '', provision: '', nameTemplate: '', exitPolicy: 'hold', defaults: {}, agent: '' });

  const renderList = () => {
    list.replaceChildren(
      ...app.client.state.templates.map((t) => h('button', { class: `tpl-item${current?.id === t.id ? ' active' : ''}`, onclick: () => edit(t) },
        h('span', {}, t.name), t.builtin ? h('span', { class: 'badge dim' }, 'built-in') : null)),
      h('button', { class: 'btn small', onclick: () => edit(blank()) }, '+ New template'),
      actionBtn('Reset built-ins', async () => {
        if (!(await confirm('Reset all built-in templates to their defaults? Your own templates are kept.'))) return;
        try { await app.client.api('POST', '/api/templates/reset'); } catch (e) { toast(e.message); }
      }, { class: 'btn small', title: 'Restore every built-in template and bring back deleted ones' }));
  };

  const edit = (t) => {
    current = t;
    renderList();
    const nameIn = h('input', { value: t.name, placeholder: 'Name', spellcheck: 'false' });
    const cmdIn = h('textarea', { rows: 3, spellcheck: 'false', placeholder: 'k9s --context {{context}}' });
    cmdIn.value = t.command || '';
    const provIn = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'optional, runs before the command' });
    provIn.value = t.provision || '';
    const nameTplIn = h('input', { value: t.nameTemplate || '', placeholder: `${t.name || 'k9s'}, or ${t.name || 'k9s'} @ the host`, spellcheck: 'false' });
    const agentSel = select([['', 'None'], ...AGENTS.map((a) => [a.id, a.label])], t.agent || '');
    const policySel = select(EXIT_POLICIES.map((p) => [p, p]), t.exitPolicy || 'hold');
    const defaultsIn = h('textarea', { rows: 2, spellcheck: 'false', placeholder: 'context=prod' });
    defaultsIn.value = Object.entries(t.defaults || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const sampleBox = h('div', { class: 'tpl-fields compact' });
    const preview = h('pre', { class: 'preview' });
    const namePreview = h('div', { class: 'hint' });
    const sample = {};

    const parseDefaults = () => Object.fromEntries(defaultsIn.value.split('\n').map((l) => l.split('=')).filter((p) => p[0]?.trim()).map(([k, ...v]) => [k.trim(), v.join('=').trim()]));
    const draft = () => ({ name: nameIn.value, command: cmdIn.value, provision: provIn.value, nameTemplate: nameTplIn.value, exitPolicy: policySel.value, defaults: parseDefaults(), agent: agentSel.value });
    const refreshPreview = () => {
      const d = draft();
      const b = builtinsFor(app, { cwd: app.client.state.server.home, name: 'example' });
      const vars = { ...sample };
      try {
        preview.textContent = describeLaunch(launch(d, vars, b));
        preview.classList.remove('error');
        namePreview.textContent = `Name: ${renderName(d, vars, b)}`;
      } catch (e) { preview.textContent = e.message; preview.classList.add('error'); }
    };
    const refresh = () => {
      const d = draft();
      const { fields, error } = parseFields(d.command, d.provision);
      for (const k of Object.keys(sample)) if (!fields.some((f) => f.name === k)) delete sample[k];
      sampleBox.replaceChildren(...fields.filter((f) => !LOCATION_VARS.includes(f.name)).map((f) => {
        const inp = h('input', { value: sample[f.name] || '', placeholder: d.defaults[f.name] || (f.required ? `${f.name} *` : f.name), spellcheck: 'false' });
        inp.addEventListener('input', () => { if (inp.value) sample[f.name] = inp.value; else delete sample[f.name]; refreshPreview(); });
        return inp;
      }));
      if (error) { preview.textContent = error; preview.classList.add('error'); namePreview.textContent = ''; return; }
      refreshPreview();
    };
    for (const el of [cmdIn, provIn, nameTplIn, defaultsIn, nameIn]) el.addEventListener('input', refresh);
    agentSel.addEventListener('change', refresh);

    const save = async (asNew) => {
      const d = draft();
      try {
        if (asNew || !t.id) {
          if (asNew) { const n = await prompt('Save as new template', `${d.name} copy`, 'Template name'); if (!n?.trim()) return; d.name = n.trim(); }
          current = await app.client.api('POST', '/api/templates', d);
          toast(`Template "${current.name}" created`, 'info');
          edit(current);
        } else {
          current = await app.client.api('PUT', `/api/templates/${t.id}`, d);
          toast('Template saved', 'info');
          renderList();
        }
      } catch (e) { toast(e.message); }
    };
    const del = async () => {
      if (!t.id) { editor.replaceChildren(); current = null; renderList(); return; }
      if (!(await confirm(`Delete template "${t.name}"?`, { ok: 'Delete', danger: true }))) return;
      try { await app.client.api('DELETE', `/api/templates/${t.id}`); editor.replaceChildren(); current = null; renderList(); }
      catch (e) { toast(e.message); }
    };
    const reset = async () => {
      if (!(await confirm(`Reset "${t.name}" to its built-in default?`))) return;
      try { const r = await app.client.api('POST', `/api/templates/${t.id}/reset`); edit(r); } catch (e) { toast(e.message); }
    };

    editor.replaceChildren(
      h('div', { class: 'form' },
        h('div', { class: 'row' }, field('Name', nameIn), field('Agent', agentSel)),
        field('Command', cmdIn),
        h('p', { class: 'hint' }, "What to run. It runs where the session is: on this machine, or on the project's host over ssh, in its directory there. An agent is set up there first, and its hooks report back."),
        field('Provision', provIn),
        h('div', { class: 'row' }, field('Name template', nameTplIn), field('On exit', policySel)),
        field('Defaults', defaultsIn),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Preview'), sampleBox, preview, namePreview)),
      h('div', { class: 'row end' },
        t.id ? actionBtn('Delete', del, { class: 'btn danger left' }) : h('button', { class: 'btn left', onclick: del }, 'Discard'),
        t.builtin ? actionBtn('Reset', reset, { class: 'btn left' }) : null,
        t.id ? actionBtn('Save as new', () => save(true), { class: 'btn' }) : null,
        actionBtn(t.id ? 'Save' : 'Create', () => save(false), { class: 'btn primary' })));
    refresh();
  };

  renderList();
  const first = app.client.state.templates[0];
  if (first) edit(first); else edit(blank());
  const unsub = app.client.on('templates', () => { renderList(); if (current?.id) { const t = app.client.template(current.id); if (t && t !== current) edit(t); } });
  return { el: h('div', { class: 'tpl-pane' }, list, editor), cleanup: unsub };
}

function shortcutsPane(app) {
  const work = {};
  for (const c of COMMANDS) work[c.id] = [...app.keys.bindings(c.id)];
  const table = h('div', { class: 'keys-table' });
  let recording = null;

  const render = () => {
    table.replaceChildren(...COMMANDS.map((c) => {
      const chips = work[c.id].map((k) => h('span', { class: 'chip key' }, h('kbd', {}, displayChord(k)), h('button', { class: 'chip-x', title: 'Remove', onclick: () => { work[c.id] = work[c.id].filter((x) => x !== k); render(); } }, '×')));
      const add = recording === c.id
        ? h('span', { class: 'keyrec', tabindex: '0' }, 'Press keys… (Esc cancels)')
        : h('button', { class: 'btn small', onclick: () => { recording = c.id; render(); table.querySelector('.keyrec')?.focus(); } }, '+');
      const isDefault = JSON.stringify(work[c.id]) === JSON.stringify(defaultKeys(c));
      return h('div', { class: 'keys-row' }, h('span', { class: 'keys-label' }, c.label), h('span', { class: 'keys-chips' }, ...chips, add),
        isDefault ? null : h('button', { class: 'btn small', title: 'Restore default', onclick: () => { work[c.id] = [...defaultKeys(c)]; render(); } }, '↺'));
    }));
    table.querySelector('.keyrec')?.focus();
  };
  table.addEventListener('keydown', (e) => {
    if (!recording || !e.target.classList.contains('keyrec')) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { recording = null; render(); return; }
    const chord = chordFromEvent(e);
    if (!chord) return;
    const n = normalizeChord(chord);
    for (const id of Object.keys(work)) work[id] = work[id].filter((k) => normalizeChord(k) !== n);
    work[recording].push(n);
    recording = null;
    render();
  }, true);

  const save = async () => {
    const keybindings = {};
    for (const c of COMMANDS) if (JSON.stringify(work[c.id]) !== JSON.stringify(defaultKeys(c))) keybindings[c.id] = work[c.id];
    try { await app.client.api('PUT', '/api/settings', { keybindings }); toast('Shortcuts saved', 'info'); } catch (e) { toast(e.message); }
  };
  const resetAll = async () => {
    if (!(await confirm('Reset all shortcuts to their defaults?'))) return;
    try { await app.client.api('PUT', '/api/settings', { keybindings: {} }); for (const c of COMMANDS) work[c.id] = [...defaultKeys(c)]; render(); } catch (e) { toast(e.message); }
  };
  render();
  return h('div', { class: 'form' },
    table,
    h('div', { class: 'row end' }, actionBtn('Reset all', resetAll, { class: 'btn left' }), actionBtn('Save', save, { class: 'btn primary' })));
}

function generalPane(app, close) {
  const st = app.client.state.settings;
  const fontSize = h('input', { type: 'number', min: 8, max: 40, value: st.fontSize });
  const editorSize = h('input', { type: 'number', min: 6, max: 40, value: st.editorFontSize || '', placeholder: 'as the terminals' });
  const vscodeHost = h('input', { value: st.vscodeHost || '', placeholder: 'devbox, say, or local', spellcheck: 'false' });
  const fontFamily = h('input', { value: st.fontFamily || '', placeholder: 'default monospace stack', spellcheck: 'false' });
  const theme = select([['dark', 'Dark'], ['light', 'Light']], st.theme);
  const copyOnSelect = h('input', { type: 'checkbox', checked: st.copyOnSelect });
  const rightClickPaste = h('input', { type: 'checkbox', checked: st.rightClickPaste });
  const cursorBlink = h('input', { type: 'checkbox', checked: st.cursorBlink });
  const clientScrollback = h('input', { type: 'number', min: 100, max: 1000000, value: st.clientScrollback });
  const serverScrollback = h('input', { type: 'number', min: 100, max: 200000, value: st.serverScrollback });
  const save = async () => {
    try {
      await app.client.api('PUT', '/api/settings', {
        fontSize: fontSize.value, editorFontSize: editorSize.value || 0, vscodeHost: vscodeHost.value.trim().replace(/^ssh-remote\+/, ''), fontFamily: fontFamily.value, theme: theme.value, copyOnSelect: copyOnSelect.checked,
        rightClickPaste: rightClickPaste.checked, cursorBlink: cursorBlink.checked, clientScrollback: clientScrollback.value, serverScrollback: serverScrollback.value,
      });
      toast('Settings saved', 'info');
      close();
    } catch (e) { toast(e.message); }
  };
  return h('div', { class: 'form' },
    h('div', { class: 'row' }, field('Font size', fontSize), field('Editor font size', editorSize), field('Theme', theme)),
    field('Font family', fontFamily),
    field('Open in VS Code on', vscodeHost),
    h('p', { class: 'hint' }, 'The ssh host your VS Code window is connected to over Remote-SSH, as in your ssh config (VS Code calls the window ssh-remote+ that name), or "local" when VS Code runs on the machine belay runs on. Files on a project\'s host open on that host.'),
    h('div', { class: 'row checks' },
      h('label', { class: 'check' }, copyOnSelect, ' Copy on select'),
      h('label', { class: 'check' }, rightClickPaste, ' Right-click pastes'),
      h('label', { class: 'check' }, cursorBlink, ' Cursor blink')),
    h('div', { class: 'row' }, field('Browser scrollback lines', clientScrollback), field('Server scrollback lines', serverScrollback)),
    h('div', { class: 'row end' }, actionBtn('Save', save, { class: 'btn primary' })));
}

// ---- help ------------------------------------------------------------------------

export function openHelp(app) {
  const sv = app.client.state.server;
  const dir = sv.belaydir || '<belay dir>';
  const bind = (id) => app.keys.bindings(id);
  const row = (id) => h('tr', {}, h('td', {}, COMMANDS.find((c) => c.id === id)?.label || id), h('td', {}, ...chordChips(bind(id))));
  const m = modal({
    title: 'belay', width: '640px',
    body: h('div', { class: 'help' },
      h('p', { class: 'hint' }, `${sv.hostname || ''} · ${sv.dataDir || '~/.belay'} · v${sv.version || ''}`),
      h('div', { class: 'row' },
        window.belayApp ? null : h('button', { class: 'btn primary', onclick: () => { m.close(); app.installApp(); } }, app.installPrompt ? 'Install as app' : 'Install as app…'),
        h('button', { class: 'btn', onclick: () => { m.close(); openSettings(app, 'shortcuts'); } }, 'Edit shortcuts'),
        h('button', { class: 'btn', onclick: () => { m.close(); openPalette(app); } }, 'Command palette')),
      window.belayApp ? null : h('p', { class: 'hint' }, IS_MAC
        ? 'In a browser tab Chrome keeps Cmd+T, Cmd+W, Cmd+Shift+] / [ and Ctrl+Tab for itself. The installed app hands them to belay.'
        : 'In a browser tab Chrome keeps Ctrl+Tab and Ctrl+Shift+Tab for itself. The installed app hands them to belay.'),
      h('table', { class: 'kbd' }, ...['palette', 'new-session', 'shell-here', 'toggle-notes', 'sessions', 'new-project', 'next-tab', 'prev-tab', 'project-1', 'maximize', 'find', 'restart-pane', 'close-pane'].map(row),
        h('tr', {}, h('td', {}, 'Copy / paste'), h('td', {}, h('kbd', {}, IS_MAC ? 'Cmd+C' : 'Ctrl+Shift+C'), ' ', h('kbd', {}, IS_MAC ? 'Cmd+V' : 'Ctrl+Shift+V'), ' or select and right-click'))),
      h('h4', {}, 'Files, notes and pages'),
      h('p', {}, 'Files and notes open in an editor with VS Code\'s keys: Cmd/Ctrl+S saves a file (notes save themselves), and a file changed on disk since you opened it is not overwritten without asking. A remote page is opened from the project\'s machine and served by belay under its own name (page-….localhost), so localhost:8080 or a cluster service name just works, with nothing to forward.'),
      h('h4', {}, 'Claude Code, Codex and opencode'),
      h('p', {}, 'Their templates provision hooks (a plugin for opencode) on the machine the agent runs on, local or remote, each time a session starts. The hooks report the conversation id, so a relaunch resumes it, and the activity shown on the tab: working, idle, or waiting for you. Codex asks once to trust the new hooks: pick "Trust all and continue".'),
      h('pre', {}, `node ${dir}/bin/belay.js hook install        # by hand, local machine`)),
  });
}
