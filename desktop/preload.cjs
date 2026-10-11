'use strict';
// 只暴露控制台需要的窄接口，渲染进程拿不到 Node。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fb', {
  status: () => ipcRenderer.invoke('fb:status'),
  launch: () => ipcRenderer.invoke('fb:launch'),
  stop: () => ipcRenderer.invoke('fb:stop'),
  openPanel: () => ipcRenderer.invoke('fb:open-panel'),
  openDir: () => ipcRenderer.invoke('fb:open-dir'),
  openLog: () => ipcRenderer.invoke('fb:open-log'),
  logTail: () => ipcRenderer.invoke('fb:log-tail'),
  clearLog: () => ipcRenderer.invoke('fb:clear-log'),
  setAutostart: (on) => ipcRenderer.invoke('fb:set-autostart', on),
  setProfile: (id) => ipcRenderer.invoke('fb:set-profile', id),
  setCloseToTray: (on) => ipcRenderer.invoke('fb:set-close-to-tray', on),
  relaunch: (hidden) => ipcRenderer.invoke('fb:relaunch', hidden),
  quit: () => ipcRenderer.invoke('fb:quit'),
  onLog: (cb) => ipcRenderer.on('fb:log', (_e, line) => cb(line)),
});
