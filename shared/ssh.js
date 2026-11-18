// Where ssh goes, the same everywhere belay runs ssh. A host is a name from your ssh config, a host name or an
// address, with an optional port (`box`, `my_box`, `10.0.0.5:2222`, `[fe80::1]:22`); a user is separate. Your
// ssh config applies as it does on the command line: belay runs your ssh.

/** A host as belay takes it: never starting with "-", so it can never be read as an option. */
export const HOST_RE = /^(?:\[[0-9A-Fa-f:.%a-z]+\]|[A-Za-z0-9_][A-Za-z0-9._-]*)(?::\d{1,5})?$/;
export const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** `[user@]host[:port]` → { user, name, port }; null for something that is not one. */
export function parseTarget(target) {
  const m = /^(?:([^@]+)@)?(.+)$/.exec(String(target || '').trim());
  if (!m || !HOST_RE.test(m[2]) || (m[1] && !USER_RE.test(m[1]))) return null;
  const hp = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(m[2]);
  const port = hp[2] ? Number(hp[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { user: m[1] || '', name: hp[1].replace(/^\[(.*)\]$/, '$1'), port };
}

/** The target for a host and user: `user@host[:port]`. */
export const targetOf = (host, user) => `${user ? `${user}@` : ''}${host}`;

/** ssh's arguments for a target: `-p` for a port, then `[user@]name`. */
export function sshDest(target) {
  const t = parseTarget(target);
  if (!t) throw new Error(`not a host: ${target}`);
  return [...(t.port ? ['-p', String(t.port)] : []), `${t.user ? `${t.user}@` : ''}${t.name}`];
}

/**
 * Options for belay's own connections, given before yours so they win. Your config still decides the rest
 * (HostName, User, Port, IdentityFile, ProxyJump, agents…), but a Host that runs its own RemoteCommand or
 * asks for a terminal would stop belay running anything, and one that forwards ports would make every
 * connection after the first fail (`forwards: false` drops them: a connection that forwards nothing itself).
 */
export function sshOpts({ forwards = true, config = '' } = {}) {
  return [
    ...(config ? ['-F', config] : []),
    '-o', 'BatchMode=yes', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no',
    ...(forwards ? ['-o', 'ExitOnForwardFailure=no'] : ['-o', 'ClearAllForwardings=yes']),
  ];
}

/** The same, as a command line for a plain `ssh -t` session in a terminal: only what would stop it working. */
export function sshCommandLine(target, extra = '') {
  return ['ssh -t -o RemoteCommand=none', extra, ...sshDest(target)].filter(Boolean).join(' ');
}
