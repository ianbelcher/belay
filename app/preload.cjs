// What the page knows of the app around it.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('belayApp', { platform: process.platform });
