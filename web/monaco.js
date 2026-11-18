// Monaco for note and file tabs. Bundled on its own (scripts/build-monaco.mjs) and loaded the first time an
// editor opens: it is several megabytes, and a page of terminals never needs it.
import * as monaco from 'monaco-editor';

const v = new URL(import.meta.url).search;
const WORKERS = { json: 'json', css: 'css', scss: 'css', less: 'css', html: 'html', handlebars: 'html', razor: 'html', typescript: 'ts', javascript: 'ts' };
self.MonacoEnvironment = { getWorker: (_id, label) => new Worker(new URL(`./${WORKERS[label] || 'editor'}.worker.js${v}`, import.meta.url)) };

// A file is seen on its own, without its project: errors about imports it cannot find would be noise.
for (const d of [monaco.typescript?.typescriptDefaults, monaco.typescript?.javascriptDefaults]) d?.setDiagnosticsOptions({ noSemanticValidation: true });

// The keys from the HUD's notes, on top of Monaco's own (which are VS Code's).
const { KeyMod, KeyCode } = monaco;
monaco.editor.addKeybindingRules([
  { keybinding: KeyMod.Shift | KeyCode.Delete, command: 'editor.action.deleteLines', when: 'textInputFocus' },
  { keybinding: KeyMod.CtrlCmd | KeyCode.KeyL, command: 'editor.action.addSelectionToNextFindMatch', when: 'textInputFocus' },
  { keybinding: KeyMod.CtrlCmd | KeyCode.KeyD, command: 'editor.action.duplicateSelection', when: 'textInputFocus' },
  { keybinding: KeyMod.Shift | KeyMod.CtrlCmd | KeyCode.DownArrow, command: 'editor.action.moveLinesDownAction', when: 'textInputFocus' },
  { keybinding: KeyMod.Shift | KeyMod.CtrlCmd | KeyCode.UpArrow, command: 'editor.action.moveLinesUpAction', when: 'textInputFocus' },
  { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.DownArrow, command: 'editor.action.insertCursorBelow', when: 'textInputFocus' },
  { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.UpArrow, command: 'editor.action.insertCursorAbove', when: 'textInputFocus' },
  { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.Equal, command: 'editor.action.fontZoomIn', when: 'textInputFocus' },
  { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.Minus, command: 'editor.action.fontZoomOut', when: 'textInputFocus' },
]);

// belay's own background, so an editor sits in the layout like a terminal does.
monaco.editor.defineTheme('belay-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#0f1115', 'editorGutter.background': '#0f1115' } });
monaco.editor.defineTheme('belay-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff' } });

export { monaco };
