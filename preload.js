const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scheduleAPI', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  gcalStatus: () => ipcRenderer.invoke('gcal:status'),
  gcalConnect: (clientId, clientSecret) => ipcRenderer.invoke('gcal:connect', clientId, clientSecret),
  gcalDisconnect: () => ipcRenderer.invoke('gcal:disconnect'),
  gcalEvents: (timeMin, timeMax) => ipcRenderer.invoke('gcal:events', timeMin, timeMax),
});
