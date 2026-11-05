const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const adapters = require('./adapters');
const setup = require('./setup');

let win;
const running = new Map(); // runId -> { cancel }

const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const sendSetup = (kind, event) => {
  if (win && !win.isDestroyed()) win.webContents.send('setup:event', { kind, event });
};

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('adapters:list', () => adapters.list());
ipcMain.handle('claude:detect', () => setup.detectClaude());

// ---- first-run setup ----
ipcMain.handle('setup:status', (_e, binary) => setup.getStatus(typeof binary === 'string' && binary ? binary : undefined));

ipcMain.handle('setup:install', async () => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Install Claude Code',
    message: 'Run the official Claude Code installer?',
    detail: `This will run:\n\n${setup.installCommandText()}\n\nIt downloads and runs Anthropic's installer script.`,
  });
  if (response !== 0) return false;
  setup.install((event) => sendSetup('install', event));
  return true;
});

ipcMain.handle('setup:login:start', (_e, binary) => {
  const b = (typeof binary === 'string' && binary) || setup.detectClaude();
  if (!b) throw new Error('Claude Code not found');
  setup.startLogin(b, (event) => {
    if (event.type === 'url') setup.openAuthUrl(event.url, (u) => shell.openExternal(u));
    sendSetup('login', event);
  });
});
ipcMain.handle('setup:login:code', (_e, code) => setup.submitCode(code));
ipcMain.handle('setup:login:cancel', () => setup.cancelLogin());
ipcMain.handle('setup:openUrl', (_e, url) => setup.openAuthUrl(url, (u) => shell.openExternal(u)));

// ---- persistence ----
ipcMain.handle('state:load', () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('state:save', (_e, state) => {
  const tmp = stateFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, stateFile());
});

// ---- dialogs ----
ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:pickFile', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: ['exe', 'cmd'] }, { name: 'All files', extensions: ['*'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('theme:set', (_e, pref, bg) => {
  nativeTheme.themeSource = ['light', 'dark', 'system'].includes(pref) ? pref : 'system';
  if (win && !win.isDestroyed() && /^#[0-9a-f]{6}$/i.test(bg)) win.setBackgroundColor(bg);
});

ipcMain.handle('shell:reveal', (_e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
});

// ---- agent runs ----
ipcMain.handle('agent:run', (_e, req) => {
  const adapter = adapters.get(req.adapterId);
  if (!adapter) throw new Error(`Unknown adapter: ${req.adapterId}`);
  if (typeof req.runId !== 'string') throw new Error('Missing runId');
  const runId = req.runId; // chosen by the renderer so early events are never dropped
  let cwd = req.cwd;
  if (cwd) {
    if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
  } else {
    // "No folder" sessions run in a private scratch directory.
    cwd = path.join(app.getPath('userData'), 'no-folder');
    fs.mkdirSync(cwd, { recursive: true });
  }
  const handle = adapter.run({ ...req, cwd, binary: req.binary || setup.detectClaude() || 'claude' }, (event) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('agent:event', { runId, event });
    if (event.type === 'exit') running.delete(runId);
  });
  running.set(runId, handle);
});

ipcMain.handle('agent:cancel', (_e, runId) => {
  running.get(runId)?.cancel();
});

app.whenReady().then(createWindow);
app.on('before-quit', () => {
  running.forEach((h) => h.cancel());
  setup.cancelLogin();
});
app.on('window-all-closed', () => app.quit());
