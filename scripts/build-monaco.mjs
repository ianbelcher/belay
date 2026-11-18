// Builds Monaco into public/monaco/: the editor (web/monaco.js) with its CSS and font, and the workers that
// do the language work off the page. A bundle of its own, loaded only when an editor opens.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'monaco');
const dev = process.argv.includes('--dev');
const common = { bundle: true, minify: !dev, sourcemap: dev, target: 'es2022', logLevel: 'warning' };
const vs = path.join(root, 'node_modules', 'monaco-editor', 'esm', 'vs');

await Promise.all([
  build({ ...common, entryPoints: [path.join(root, 'web', 'monaco.js')], outfile: path.join(out, 'monaco.js'), format: 'esm', loader: { '.ttf': 'file' } }),
  build({
    ...common,
    entryPoints: {
      'editor.worker': path.join(vs, 'editor', 'editor.worker.js'),
      'json.worker': path.join(vs, 'languages', 'features', 'json', 'json.worker.js'),
      'css.worker': path.join(vs, 'languages', 'features', 'css', 'css.worker.js'),
      'html.worker': path.join(vs, 'languages', 'features', 'html', 'html.worker.js'),
      'ts.worker': path.join(vs, 'languages', 'features', 'typescript', 'ts.worker.js'),
    },
    outdir: out,
    format: 'iife',
  }),
]);
