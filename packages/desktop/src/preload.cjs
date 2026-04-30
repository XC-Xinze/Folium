const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zettelDesktop', {
  getApiToken() {
    return ipcRenderer.invoke('app:get-api-token');
  },
  selectDirectory(options = {}) {
    return ipcRenderer.invoke('vault:select-directory', options);
  },
});
