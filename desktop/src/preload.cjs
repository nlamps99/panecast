const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panecastDesktop', {
  version: 1,
  getSecret: (key) => ipcRenderer.invoke('panecast:secret:get', key),
  setSecret: (key, value) => ipcRenderer.invoke('panecast:secret:set', key, value),
  deleteSecret: (key) => ipcRenderer.invoke('panecast:secret:delete', key),
  request: (id, url, options) => ipcRenderer.invoke('panecast:request', id, url, options),
  abortRequest: (id) => ipcRenderer.send('panecast:request:abort', id),
  connectSocket: (id, url, protocols, headers) => ipcRenderer.invoke('panecast:socket:connect', id, url, protocols, headers),
  sendSocket: (id, data) => ipcRenderer.send('panecast:socket:send', id, data),
  closeSocket: (id) => ipcRenderer.send('panecast:socket:close', id),
  onSocket: (listener) => {
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('panecast:socket:event', handler);
    return () => ipcRenderer.removeListener('panecast:socket:event', handler);
  },
  dialog: (options) => ipcRenderer.invoke('panecast:dialog', options),
});
