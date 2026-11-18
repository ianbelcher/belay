// Copies the static files that esbuild does not handle into public/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
fs.mkdirSync(path.join(pub, 'icons'), { recursive: true });
for (const f of ['manifest.webmanifest', 'sw.js']) fs.copyFileSync(path.join(root, 'web', f), path.join(pub, f));
// index.html is served no-cache; versioning the bundle URLs in it makes a plain reload pick up a rebuild.
const hash = crypto.createHash('sha256');
for (const f of ['app.js', 'app.css']) { try { hash.update(fs.readFileSync(path.join(pub, f))); } catch {} }
const v = hash.digest('hex').slice(0, 10);
// Monaco's bundle carries its own version, which its workers and stylesheet take from its URL.
const mhash = crypto.createHash('sha256');
for (const f of fs.existsSync(path.join(pub, 'monaco')) ? fs.readdirSync(path.join(pub, 'monaco')).sort() : []) mhash.update(fs.readFileSync(path.join(pub, 'monaco', f)));
const mv = mhash.digest('hex').slice(0, 10);
fs.writeFileSync(path.join(pub, 'index.html'), fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
  .replace(/"\/(app\.(?:js|css))"/g, `"/$1?v=${v}"`).replace('"/monaco/monaco.js"', `"/monaco/monaco.js?v=${mv}"`));
for (const f of fs.readdirSync(path.join(root, 'web', 'icons'))) fs.copyFileSync(path.join(root, 'web', 'icons', f), path.join(pub, 'icons', f));
