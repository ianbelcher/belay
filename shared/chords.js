// Key chords as belay names them ("Ctrl+Shift+P"), shared by the browser and the script belay puts into remote
// pages, so a chord pressed inside one of those still reaches belay. Keep these functions self-contained: the
// server sends their source into the page as they are.

export const CODE_KEYS = {
  Backquote: '`', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
  Slash: '/', Backslash: '\\', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown',
};

/** "Ctrl+Shift+P" from a keyboard event, or null for a bare modifier / unknown key. */
export function chordFromEvent(e) {
  const c = e.code || '';
  let key = null;
  if (/^Key[A-Z]$/.test(c)) key = c[3];
  else if (/^Digit[0-9]$/.test(c)) key = c[5];
  else if (/^Numpad[0-9]$/.test(c)) key = c[6];
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) key = c;
  else key = CODE_KEYS[c] || null;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

export const chordOrder = (p) => ({ Ctrl: 0, Alt: 1, Meta: 2, Shift: 3 }[p] ?? 10);

export const normalizeChord = (s) => String(s).split('+').map((p) => p.trim()).filter(Boolean)
  .map((p) => ({ ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', super: 'Meta' }[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p)))
  .sort((a, b) => chordOrder(a) - chordOrder(b)).join('+');

/**
 * The script served into remote pages. belay tells it which chords are its own; the page hands those to belay
 * instead of acting on them. It only reports a chord, it is never told anything else.
 */
export function pageKeysScript() {
  return `(() => {
  if (window.parent === window) return;
  const CODE_KEYS = ${JSON.stringify(CODE_KEYS)};
  const chordOrder = ${chordOrder};
  const normalizeChord = ${normalizeChord};
  ${chordFromEvent}
  let chords = new Set();
  addEventListener('message', (e) => { if (e.source === parent && e.data && e.data.belay === 'chords') chords = new Set(e.data.chords); });
  parent.postMessage({ belay: 'hello' }, '*');
  addEventListener('keydown', (e) => {
    const c = chordFromEvent(e);
    if (!c || !chords.has(normalizeChord(c))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    parent.postMessage({ belay: 'key', chord: normalizeChord(c) }, '*');
  }, true);
})();
`;
}
