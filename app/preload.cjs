// What the page knows of the app around it, and the little it can ask of it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('belayApp', {
  platform: process.platform,
  // The colours of the window's own buttons (Windows, Linux), drawn over the top bar: the top bar's.
  setTitleBarColors: (colors) => ipcRenderer.send('titlebar-colors', colors),
  // Called with true going full screen, false coming back.
  onFullScreen: (fn) => ipcRenderer.on('fullscreen', (_e, on) => fn(!!on)),
});
