// AimForge – Windows-Anwendung (Electron-Hauptprozess)
const { app, BrowserWindow, Menu, shell, ipcMain, nativeTheme } = require('electron');
const path = require('path');

// Für ein Aim-Tool zählt jede Millisekunde: keine Bildratenbegrenzung, kein VSync,
// Fenster im Hintergrund nicht drosseln (sonst stocken Testläufe).
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('de.aimforge.app');

const BG = '#0b0e13';
let win = null;

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1380, height: 880, minWidth: 1080, minHeight: 700,
    backgroundColor: BG, show: false, title: 'AimForge',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BG, symbolColor: '#8d99ab', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, spellcheck: false,
      additionalArguments: [`--aimforge-version=${app.getVersion()}`],
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'dist', 'AimForge.html'));
  win.once('ready-to-show', () => win.show());

  // Links nach außen im Standardbrowser öffnen, im App-Fenster nie fremde Seiten laden
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  const sendFs = () => win.webContents.send('fullscreen', win.isFullScreen());
  win.on('enter-full-screen', sendFs);
  win.on('leave-full-screen', sendFs);
}

ipcMain.on('toggle-fullscreen', () => win && win.setFullScreen(!win.isFullScreen()));

app.whenReady().then(createWindow);
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.on('window-all-closed', () => app.quit());
