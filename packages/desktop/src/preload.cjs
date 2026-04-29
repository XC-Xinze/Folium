const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zettelDesktop', {
  selectDirectory(options = {}) {
    return ipcRenderer.invoke('vault:select-directory', options);
  },
});
