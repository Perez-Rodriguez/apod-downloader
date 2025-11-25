const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// Polyfill dla Web API w Electron (przed załadowaniem innych modułów)
if (typeof global.File === 'undefined') {
  global.File = class File {
    constructor() {
      throw new Error('File constructor is not available in Electron main process');
    }
  };
}

if (typeof global.FileReader === 'undefined') {
  global.FileReader = class FileReader {
    constructor() {
      throw new Error('FileReader constructor is not available in Electron main process');
    }
  };
}

const downloader = require('./downloader');

// Naprawa problemu z sandboxem na Linuxie - musi być przed app.whenReady()
app.commandLine.appendSwitch('--no-sandbox');
app.commandLine.appendSwitch('--disable-setuid-sandbox');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a1a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: true,
    titleBarStyle: 'default'
  });

  mainWindow.loadFile('index.html');

  // Otwórz DevTools w trybie deweloperskim
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// Ustaw ścieżki dla downloadera używając userData (działa w zbudowanej aplikacji)
// i utwórz okno
app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');
  downloader.setPaths(userDataPath);
  // Zresetuj stan pobierania przy starcie (na wypadek zawieszenia)
  downloader.resetDownloadState();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('start-download', async () => {
  return await downloader.startDownload(mainWindow);
});

ipcMain.handle('stop-download', async () => {
  return await downloader.stopDownload();
});

ipcMain.handle('reset-download-state', async () => {
  return await downloader.resetDownloadState();
});

ipcMain.handle('get-progress', async () => {
  return await downloader.getProgress();
});

ipcMain.handle('open-downloads-folder', async () => {
  try {
    const userDataPath = app.getPath('userData');
    const DOWNLOAD_DIR = path.join(userDataPath, 'downloads');
    // Upewnij się, że folder istnieje przed otwarciem
    await fs.ensureDir(DOWNLOAD_DIR);
    await shell.openPath(DOWNLOAD_DIR);
    return { success: true };
  } catch (error) {
    console.error('Error opening downloads folder:', error);
    return { success: false, error: error.message };
  }
});

// Nasłuchiwanie na logi z downloadera
ipcMain.on('log', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', data);
  }
});

