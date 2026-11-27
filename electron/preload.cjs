// Schmale, sichere Brücke zwischen App-Fenster und Hauptprozess
const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--aimforge-version='));
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  version: arg ? arg.split('=')[1] : '',
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, v) => cb(!!v)),
});
