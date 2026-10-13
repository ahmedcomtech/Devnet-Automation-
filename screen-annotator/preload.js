'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the web pages and the main process.
contextBridge.exposeInMainWorld('annotator', {
  update: (patch) => ipcRenderer.send('state:update', patch),
  command: (name, arg) => ipcRenderer.send('command', name, arg),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onCommand: (callback) => ipcRenderer.on('command', (_event, name) => callback(name)),
});
