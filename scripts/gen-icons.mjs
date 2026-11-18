// Generates the PWA icons as PNGs with no dependencies (dark rounded tile, three blue bars).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');
fs.mkdirSync(out, { recursive: true });

const crc = (buf) => zlib.crc32(buf) >>> 0;
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// signed distance helpers (in unit square coordinates)
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const dx = Math.abs(px - cx) - hw + r, dy = Math.abs(py - cy) - hh + r;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
};
const coverage = (sd, px) => Math.min(1, Math.max(0, 0.5 - sd / px));
const BG = [15, 17, 21], BAR = [76, 141, 255];

function icon(size, maskable) {
  const px = 1 / size;
  return png(size, (x, y) => {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    let tile = 1;
    if (!maskable) tile = coverage(sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.2), px);
    // three bars: y centers 0.33 / 0.5 / 0.67, lengths 0.56 / 0.40 / 0.26, thickness 0.09, left edge 0.22
    const bars = [[0.33, 0.56], [0.5, 0.4], [0.67, 0.26]];
    let bar = 0;
    for (const [cy, len] of bars) {
      const inset = maskable ? 0.1 : 0;
      const scale = maskable ? 0.8 : 1;
      const l = 0.22 * scale + inset, cyy = (cy - 0.5) * scale + 0.5;
      bar = Math.max(bar, coverage(sdRoundRect(u, v, l + (len * scale) / 2, cyy, (len * scale) / 2, 0.045 * scale, 0.045 * scale), px));
    }
    const r = BG[0] + (BAR[0] - BG[0]) * bar, g = BG[1] + (BAR[1] - BG[1]) * bar, b = BG[2] + (BAR[2] - BG[2]) * bar;
    return [Math.round(r), Math.round(g), Math.round(b), Math.round(255 * tile)];
  });
}
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true]]) {
  fs.writeFileSync(path.join(out, name), icon(size, maskable));
}
console.log('icons written to', out);

// The app's icon, from which the builds make theirs: the same tile on a transparent 1024 square, at the
// size and corner macOS gives app icons (824 px, a little under a quarter round), the bars scaled with it.
function appIcon(size) {
  const px = 1 / size, k = 824 / 1024, o = (1 - k) / 2;
  return png(size, (x, y) => {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    const tile = coverage(sdRoundRect(u, v, 0.5, 0.5, k / 2, k / 2, 0.185 * k), px);
    let bar = 0;
    for (const [cy, len] of [[0.33, 0.56], [0.5, 0.4], [0.67, 0.26]]) {
      const l = o + 0.22 * k, cyy = o + cy * k, half = (len * k) / 2;
      bar = Math.max(bar, coverage(sdRoundRect(u, v, l + half, cyy, half, 0.045 * k, 0.045 * k), px));
    }
    const c = BG.map((bg, i) => Math.round(bg + (BAR[i] - bg) * bar));
    return [...c, Math.round(255 * tile)];
  });
}
const build = path.join(path.dirname(out), '..', 'build');
fs.mkdirSync(build, { recursive: true });
fs.writeFileSync(path.join(build, 'icon.png'), appIcon(1024));
// The website's, the same at a size for a page.
fs.writeFileSync(path.join(path.dirname(out), '..', 'site', 'icon.png'), appIcon(256));
