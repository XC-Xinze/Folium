const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zettelDesktop', {
  backendOrigin: process.env.FOLIUM_BACKEND_ORIGIN || 'http://127.0.0.1:8000',
  getApiToken() {
    return ipcRenderer.invoke('app:get-api-token');
  },
  selectDirectory(options = {}) {
    return ipcRenderer.invoke('vault:select-directory', options);
  },
});
