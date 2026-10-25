const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('openSea', Object.freeze({
  getState: () => ipcRenderer.invoke('open-sea:state'),
  launch: () => ipcRenderer.invoke('open-sea:launch'),
  apply: settings => ipcRenderer.invoke('open-sea:apply', settings),
  importImage: () => ipcRenderer.invoke('open-sea:import'),
  importVideo: () => ipcRenderer.invoke('open-sea:import-video'),
  importSystemVideo: id => ipcRenderer.invoke('open-sea:import-system-video', id),
  refreshSystemWallpapers: () => ipcRenderer.invoke('open-sea:refresh-wallpapers'),
  openWallpaperSettings: () => ipcRenderer.invoke('open-sea:open-wallpaper-settings'),
  restore: () => ipcRenderer.invoke('open-sea:restore'),
  onStateChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('A state listener must be a function.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('open-sea:state-changed', listener);
    return () => { ipcRenderer.removeListener('open-sea:state-changed', listener); };
  },
  onPreviewVisibilityChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('A visibility listener must be a function.');
    const listener = (_event, visible) => { if (typeof visible === 'boolean') callback(visible); };
    ipcRenderer.on('open-sea:preview-visibility', listener);
    return () => { ipcRenderer.removeListener('open-sea:preview-visibility', listener); };
  },
}));
