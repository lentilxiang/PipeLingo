const { contextBridge } = require('electron');
const { ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pipelingo', {
  platform: process.platform
});

contextBridge.exposeInMainWorld('ast', {
  start: (voiceOpt) => ipcRenderer.invoke('ast:start', voiceOpt),
  cloneTrain: (payload) => ipcRenderer.invoke('clone:train', payload),
  sendAudio: (buf) => ipcRenderer.send('ast:audio', buf),
  stop: () => ipcRenderer.invoke('ast:stop'),
  onEvent: (cb) => ipcRenderer.on('ast:event', (_e, ev) => cb(ev)),
});

contextBridge.exposeInMainWorld('ast2', {
  start: (opts) => ipcRenderer.invoke('ast2:start', opts),
  sendAudio: (buf) => ipcRenderer.send('ast2:audio', buf),
  stop: () => ipcRenderer.invoke('ast2:stop'),
  onEvent: (cb) => ipcRenderer.on('ast2:event', (_e, ev) => cb(ev)),
});

contextBridge.exposeInMainWorld('tts2Audio', {
  onAudio: (cb) => ipcRenderer.on('tts2:audio', (_e, buf) => cb(buf)),
});

contextBridge.exposeInMainWorld('ttsAudio', {
  onAudio: (cb) => ipcRenderer.on('tts:audio', (_e, buf) => cb(buf)),
});
