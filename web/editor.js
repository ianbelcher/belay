// Loading Monaco (web/monaco.js, its own bundle) and making editors that look like the rest of belay.

let loading = null;

/** Monaco, loaded once. index.html names the bundle with a version, so a rebuild is picked up. */
export function loadMonaco() {
  if (!loading) {
    const src = document.querySelector('meta[name="belay-monaco"]')?.content || '/monaco/monaco.js';
    const css = h('link', { rel: 'stylesheet', href: src.replace(/monaco\.js/, 'monaco.css') });
    document.head.append(css);
    loading = import(src).then((m) => m.monaco).catch((e) => { loading = null; css.remove(); throw e; });
  }
  return loading;
}

function h(tag, attrs) { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; }

const theme = (app) => (app.settings().theme === 'light' ? 'belay-light' : 'belay-dark');

/** The editors' text size: its own once set from the palette, else the terminals'. */
export const editorFontSize = (st) => st.editorFontSize || st.fontSize || 13;

/** Options that follow belay's settings: font, size, theme. */
export function settingsOptions(app) {
  const st = app.settings();
  return { fontSize: editorFontSize(st), ...(st.fontFamily ? { fontFamily: st.fontFamily } : {}), theme: theme(app) };
}

/**
 * An editor in `el` for `model`. Shared choices: no minimap, no suggestions popping up while typing prose,
 * and laid out whenever its box changes size.
 */
export function createEditor(monaco, app, el, model, options = {}) {
  return monaco.editor.create(el, {
    model,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    autoIndent: 'full',
    renderLineHighlight: 'none',
    fixedOverflowWidgets: true,
    ...settingsOptions(app),
    ...options,
  });
}

/** Text replaced without losing the cursor or scroll, as the HUD's notes do. */
export function replaceText(editor, text) {
  const pos = editor.getPosition();
  const top = editor.getScrollTop();
  editor.getModel().setValue(text);
  if (pos) editor.setPosition(pos);
  editor.setScrollTop(top);
}
