// Builds the holder for every system belay runs on or reaches: one static binary each, in hold/dist/.
// `--here` builds only this machine's, for development.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
export const TARGETS = ['linux-amd64', 'linux-arm64', 'linux-arm', 'darwin-amd64', 'darwin-arm64'];
const here = `${process.platform}-${{ x64: 'amd64', arm64: 'arm64', arm: 'arm' }[process.arch] || process.arch}`;
const targets = process.argv.includes('--here') ? [here] : TARGETS;
const dist = path.join(root, 'hold', 'dist');
fs.mkdirSync(dist, { recursive: true });
for (const t of targets) {
  const [goos, goarch] = t.split('-');
  const out = path.join(dist, `belay-hold-${t}`);
  execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${pkg.version}`, '-o', out, '.'], {
    cwd: path.join(root, 'hold'),
    stdio: 'inherit',
    // ARMv6 runs on every 32-bit ARM board, the old ones too.
    env: { ...process.env, GOOS: goos, GOARCH: goarch, GOARM: '6', CGO_ENABLED: '0' },
  });
}
console.log(`holder built for ${targets.join(', ')}`);
