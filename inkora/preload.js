'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = [
  'capture-display',
  'clipboard-read',
  'clipboard-write-text',
  'settings:update',
  'settings:reset',
  'settings:choose-dir',
  'settings:open-dir',
  'settings:labels',
];

// The only bridge between the web pages and the main process.
contextBridge.exposeInMainWorld('annotator', {
  platform: process.platform,
  update: (patch) => ipcRenderer.send('state:update', patch),
  command: (name, arg) => ipcRenderer.send('command', name, arg),
  setActive: () => ipcRenderer.send('overlay:active'),
  ready: () => ipcRenderer.send('renderer:ready'),
  recorderEvent: (type, data) => ipcRenderer.send('recorder:event', type, data),
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.includes(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  onCommand: (callback) => ipcRenderer.on('command', (_event, name, arg) => callback(name, arg)),
  onCursor: (callback) => ipcRenderer.on('cursor', (_event, point) => callback(point)),
  // The main process asks for data (drawings, PNG/PDF export, PDF pages); the handler's return value is sent back.
  onRequest: (handler) =>
    ipcRenderer.on('request', async (_event, id, name, arg) => {
      let result = null;
      try {
        result = await handler(name, arg);
      } catch {
        result = null;
      }
      ipcRenderer.send('response', id, result);
    }),
});
