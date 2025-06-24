const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('settings.html');
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);

// Обработчик сохранения настроек
ipcMain.on('save-settings', (event, settings) => {
  try {
    const configPath = path.join(__dirname, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
    event.reply('settings-saved', true);
  } catch (error) {
    event.reply('settings-saved', false);
  }
});

// Обработчик загрузки настроек
ipcMain.on('load-settings', (event) => {
  try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
      const settings = JSON.parse(fs.readFileSync(configPath));
      event.reply('settings-loaded', settings);
    } else {
      event.reply('settings-loaded', {});
    }
  } catch (error) {
    event.reply('settings-loaded', {});
  }
});