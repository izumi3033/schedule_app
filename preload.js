const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scheduleAPI', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
});
