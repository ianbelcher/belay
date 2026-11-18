#!/usr/bin/env node
// belay command line: start the server, list sessions, install the agent hooks.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'start', sub] = process.argv.slice(2);

const HELP = `belay - persistent web terminals

  belay [start]                 run the server (env: BELAY_HOST, BELAY_PORT, BELAY_DATA_DIR, BELAY_TOKEN)
  belay ls                      list sessions on a running server
  belay hook install|print      install the Claude Code and Codex hooks and the opencode plugin
                               (resume id + activity) on this machine
`;

async function main() {
  switch (cmd) {
    case 'start': { const { main } = await import('../server/index.js'); await main(); return; }
    case 'ls': return ls();
    case 'hook': return hook(sub);
    case 'help': case '--help': case '-h': console.log(HELP); return;
    default: console.error(`unknown command: ${cmd}\n${HELP}`); process.exit(1);
  }
}

async function ls() {
  const base = `http://${process.env.BELAY_HOST || '127.0.0.1'}:${process.env.BELAY_PORT || 7681}`;
  const r = await fetch(`${base}/api/sessions`, { headers: process.env.BELAY_TOKEN ? { cookie: `belay=${process.env.BELAY_TOKEN}` } : {} });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const rows = await r.json();
  if (!rows.length) { console.log('no sessions'); return; }
  const w = Math.max(...rows.map((s) => s.name.length), 4);
  for (const s of rows) console.log(`${s.status.padEnd(8)} ${s.id.padEnd(9)} ${s.name.padEnd(w)}  ${s.cwd}  ${s.command}`);
}

function hook(action = 'print') {
  const scripts = ['claude', 'codex', 'opencode'].map((a) => path.join(root, 'hold', 'scripts', `provision-${a}.sh`));
  if (action === 'print') {
    console.log(`Run on any machine where the agents run (their templates do this automatically on start):\n\n${scripts.map((s) => `  sh ${s}\n  ssh host 'sh -s' < ${s}\n`).join('')}`);
    return;
  }
  if (action !== 'install') throw new Error('usage: belay hook install|print');
  for (const s of scripts) execFileSync('sh', [s], { stdio: 'inherit' });
  console.log('Hooks are in place: ~/.claude/settings.json and ~/.codex/hooks.json run ~/.belay/claude-hook.sh and ~/.belay/codex-hook.sh, and ~/.config/opencode/plugin/belay.js reports for opencode.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
