/** Tiny DOM helper: h('div', {class:'x', onclick}, ...children). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function shortPath(p, home) {
  if (!p) return '';
  if (home && p === home) return '~';
  if (home && p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

/**
 * Puts text on the clipboard. Resolves false when the browser refuses: outside a secure context only a
 * copy made soon after a click or key press is allowed.
 */
export async function copyText(text) {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const prev = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.append(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  prev?.focus?.();
  return ok;
}

/**
 * File paths in a line of terminal output: absolute, ~/, ./ or ../ paths, paths with a slash, and bare names
 * with an extension, each with an optional :line. URLs are left to the web-links addon.
 * Returns [{ index, text, path, line }] with index the position in the line.
 */
export function findPaths(line) {
  const clean = line.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, (m) => ' '.repeat(m.length));
  const out = [];
  for (const m of clean.matchAll(/(?<![\w./~@+-])((?:~|\.{1,2})?\/?[\w@+.-]+(?:\/[\w@+.-]+)*)(?::(\d+)(?::\d+)?)?/g)) {
    const raw = m[1];
    const p = raw.replace(/[.,;:]+$/, '');
    const ok = p.includes('/') ? /[\w]/.test(p) && p.length > 1 : /^[\w@+-][\w@+.-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(p);
    if (!ok) continue;
    const withLine = p === raw && m[2];
    out.push({ index: m.index, text: withLine ? m[0] : p, path: p, line: withLine ? Number(m[2]) : null });
  }
  return out;
}

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const rid = () => Math.random().toString(36).slice(2, 10);
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');
