// Pure template logic shared by the server and the browser bundle.
// Templates are Mustache strings. Optional fragments use sections:
//   ssh -t {{#user}}{{user}}@{{/user}}{{host}}
// A variable that only ever appears inside a section is optional; anything at the
// top level is required. Built-in variables are supplied by the server.
import Mustache from 'mustache';
import { sshDest, targetOf } from './ssh.js';

export const BUILTIN_VARS = ['shell', 'cwd', 'home', 'name', 'sid', 'port', 'url', 'belaydir'];
export const EXIT_POLICIES = ['hold', 'restart', 'close'];
const noEscape = (s) => s;

/**
 * Coding agents belay knows. A template marked with one (`agent`) has it provisioned where it runs, so its hooks
 * report the conversation id (`session`, for resuming) and activity to `/api/hook/<id>`.
 */
export const AGENTS = [
  { id: 'claude', label: 'Claude', resume: 'claude{{#session}} --resume {{session}}{{/session}}' },
  // Codex otherwise runs in a shared background server, whose hooks carry the environment of whichever
  // terminal started it, so every Codex tab would report as that one.
  { id: 'codex', label: 'Codex', resume: 'codex --no-daemon{{#session}} resume {{session}}{{/session}}' },
  { id: 'opencode', label: 'opencode', resume: 'opencode{{#session}} --session {{session}}{{/session}}' },
];
export const AGENT_IDS = AGENTS.map((a) => a.id);
/** The agent a template starts, from its `agent`. */
export const agentOf = (template) => AGENTS.find((a) => a.id === template?.agent) || null;

/**
 * Where a session runs: `host`, `user` and `dir` (on the host) are not a template's fields but the project's
 * (or the session's) place. A template says what to run; belay runs it there, over ssh for a host.
 */
export const LOCATION_VARS = ['host', 'user', 'dir'];

/** A login shell: yours here, the host's there. */
const SHELL_COMMAND = 'exec "$SHELL" -l';

export const DEFAULT_TEMPLATES = [
  { id: 'shell', name: 'Shell', command: SHELL_COMMAND, provision: '', nameTemplate: '', exitPolicy: 'hold', defaults: {}, agent: '', builtin: true },
  ...AGENTS.map((a) => ({ id: a.id, name: a.label, command: a.resume, provision: '', nameTemplate: '', exitPolicy: 'hold', defaults: {}, agent: a.id, builtin: true })),
  { id: 'command', name: 'Command', command: '{{command}}', provision: '', nameTemplate: '{{command}}', exitPolicy: 'hold', defaults: {}, agent: '', builtin: true },
];

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** Quoted for a shell only when it needs to be. */
const q = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : shq(s));
/** A directory for the far shell: ~ stays for it to expand. */
const remoteDir = (d) => (d === '~' ? '~' : d.startsWith('~/') ? `~/${q(d.slice(2))}` : q(d));

/** Whether starting a template needs values from you: a required field, not a place, with no default. */
export function asksForInput(t) {
  const { fields, error } = parseFields(t.command || '', t.provision || '');
  return !!error || fields.some((f) => f.required && !LOCATION_VARS.includes(f.name) && !t.defaults?.[f.name]);
}

/** Whether a template names a location variable itself (one written for a host, with its own ssh). */
function placesItself(t) {
  try {
    const names = (toks) => toks.flatMap((x) => (x[0] === 'name' || x[0] === '&' ? [x[1].trim()] : x[0] === '#' || x[0] === '^' ? [x[1].trim(), ...names(x[4] || [])] : []));
    return names(Mustache.parse(String(t.command ?? ''))).some((n) => LOCATION_VARS.includes(n));
  } catch { return false; }
}

/**
 * What a session runs, and where. With no host it runs here; with one it runs there, in `dir`. Either way a
 * holder runs it (belay-hold, here or put on the host over ssh): `script` in the user's login shell, after
 * the agent's setup script if the template has an agent (the holder carries those, in $BELAY_HOME/scripts),
 * and the template's own provision. A template that names the host itself writes its own ssh, and runs here
 * as written.
 *
 * `ssh` is the same session as plain `ssh -t`, run here, for a host belay cannot keep a holder on (one that
 * asks for a password, an unknown system): it ends if the connection does.
 */
export function launch(template, vars, builtins) {
  const cmd = renderCommand(template, vars, builtins);
  const own = renderProvision(template, vars, builtins);
  const agent = agentOf(template);
  const setup = agent ? `sh "$BELAY_HOME/scripts/provision-${agent.id}.sh"` : '';
  const provision = [setup, own].filter(Boolean).join('\n');
  // Where is the project's (the session's host, user and directory there), never a template's.
  const at = { host: vars?.host, user: vars?.user, dir: vars?.dir };
  const host = String(at.host || '').trim();
  if (!host || placesItself(template)) return { host: '', dir: '', command: cmd, provision, script: [provision, cmd].filter(Boolean).join('\n') };
  const target = targetOf(host, at.user);
  // A host that is not one (a stray space, a leading dash) never reaches ssh.
  const dest = sshDest(target).join(' ');
  const dir = String(at.dir || '');
  const port = builtins.port;
  const there = `${dir ? `cd ${remoteDir(dir)} && ` : ''}${agent ? `BELAY_SESSION=${builtins.sid} BELAY_URL=http://127.0.0.1:${port} ` : ''}${cmd === SHELL_COMMAND ? 'exec $SHELL -l' : `exec $SHELL -lc ${q(cmd)}`}`;
  return {
    host: target,
    dir,
    command: cmd,
    provision,
    script: [provision, dir ? `cd ${remoteDir(dir)} || exit 1` : '', cmd].filter(Boolean).join('\n'),
    ssh: {
      command: `ssh -t -o RemoteCommand=none ${agent ? `-R ${port}:127.0.0.1:${port} ` : ''}${dest} ${shq(there)}`,
      provision: [agent ? `ssh -o RemoteCommand=none ${dest} 'sh -s' < ${builtins.belaydir}/hold/scripts/provision-${agent.id}.sh` : '', own].filter(Boolean).join('\n'),
    },
  };
}

/** A launch as text, for a preview: where it runs, then what. */
export function describeLaunch(l) {
  return [l.host ? `# on ${l.host}${l.dir ? `, in ${l.dir}` : ''}` : '', l.provision, l.command].filter(Boolean).join('\n');
}

/** Derive the user-facing fields of a template (command plus provision) from its Mustache tokens. */
export function parseFields(command, provision = '') {
  let tokens;
  try {
    tokens = [...Mustache.parse(String(command ?? '')), ...Mustache.parse(String(provision ?? ''))];
  } catch (e) {
    return { fields: [], error: e.message };
  }
  const seen = new Map();
  const add = (raw, required) => {
    const name = raw.trim();
    if (!name || name === '.' || BUILTIN_VARS.includes(name)) return;
    const f = seen.get(name);
    if (!f) seen.set(name, { name, required });
    else if (required) f.required = true;
  };
  const walk = (toks, depth) => {
    for (const t of toks) {
      const [type, name] = t;
      if (type === 'name' || type === '&') add(name, depth === 0);
      else if (type === '#' || type === '^') {
        add(name, false);
        walk(t[4] || [], depth + 1);
      }
    }
  };
  walk(tokens, 0);
  return { fields: [...seen.values()] };
}

function view(template, vars, builtins) {
  const v = { ...(builtins || {}) };
  for (const [k, val] of Object.entries(template.defaults || {})) if (val != null && val !== '') v[k] = val;
  for (const [k, val] of Object.entries(vars || {})) if (val != null && val !== '') v[k] = val;
  return v;
}

/** Render the command line for a template with the given variables. */
export function renderCommand(template, vars, builtins) {
  return Mustache.render(String(template.command ?? ''), view(template, vars, builtins), {}, { escape: noEscape }).trim();
}

/** Render the optional provision command that runs before the main command. */
export function renderProvision(template, vars, builtins) {
  const p = String(template.provision ?? '').trim();
  return p ? Mustache.render(p, view(template, vars, builtins), {}, { escape: noEscape }).trim() : '';
}

/** Render the default session name. Falls back to the template name. */
export function renderName(template, vars, builtins) {
  const t = String(template.nameTemplate ?? '').trim();
  const host = vars?.host;
  if (!t) return host ? `${template.name} @ ${host}` : template.name;
  try {
    const out = Mustache.render(t, view(template, vars, builtins), {}, { escape: noEscape }).replace(/\s+/g, ' ').trim();
    return out || template.name;
  } catch {
    return template.name;
  }
}

/** Validate a template object. Returns a list of problems, empty when valid. */
export function validateTemplate(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['template must be an object'];
  if (!String(t.name ?? '').trim()) errors.push('name is required');
  if (!String(t.command ?? '').trim()) errors.push('command is required');
  const parsed = parseFields(t.command, t.provision);
  if (parsed.error) errors.push(`command: ${parsed.error}`);
  if (t.nameTemplate) {
    try { Mustache.parse(String(t.nameTemplate)); } catch (e) { errors.push(`name template: ${e.message}`); }
  }
  if (t.exitPolicy && !EXIT_POLICIES.includes(t.exitPolicy)) errors.push(`exit policy must be one of ${EXIT_POLICIES.join(', ')}`);
  if (t.defaults && (typeof t.defaults !== 'object' || Array.isArray(t.defaults))) errors.push('defaults must be an object');
  if (t.agent && !AGENT_IDS.includes(t.agent)) errors.push(`agent must be one of ${AGENT_IDS.join(', ')}, or none`);
  return errors;
}

/** Normalize a template coming from the API. */
export function normalizeTemplate(input, existing) {
  const defaults = {};
  if (input.defaults && typeof input.defaults === 'object') {
    for (const [k, v] of Object.entries(input.defaults)) if (/^[A-Za-z_][\w-]*$/.test(k) && v != null && String(v) !== '') defaults[k] = String(v);
  }
  return {
    id: existing?.id ?? input.id,
    name: String(input.name ?? '').trim(),
    command: String(input.command ?? '').trim(),
    provision: String(input.provision ?? '').trim(),
    nameTemplate: String(input.nameTemplate ?? '').trim(),
    exitPolicy: EXIT_POLICIES.includes(input.exitPolicy) ? input.exitPolicy : 'hold',
    defaults,
    agent: AGENT_IDS.includes(input.agent) ? input.agent : '',
    builtin: existing?.builtin ?? false,
  };
}
