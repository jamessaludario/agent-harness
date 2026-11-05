const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const adapters = require('./adapters');
const setup = require('./setup');
const dock = require('./dock');
const memory = require('./memory');
const crypto = require('node:crypto');

// The app was called "Agent Harness" before "Rubick"; keep using that data folder so
// saved sessions and settings survive the rename.
app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'Agent Harness' : 'agent-harness'));

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
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
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

ipcMain.handle('shell:openExternal', (_e, url) => {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.toString());
  } catch {
    // not a URL
  }
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
  const binary = req.binary || setup.detectClaude() || 'claude';

  // Memory bank: applicable entries go to the agent as extra system prompt, via a temp file.
  const mem = memory.buildPrompt(req.cwd || '');
  let memoryFile;
  if (mem.text) {
    memoryFile = path.join(app.getPath('userData'), `memory-${crypto.randomUUID()}.md`);
    fs.writeFileSync(memoryFile, mem.text);
    memory.markUsed(mem.ids);
    sendWin('agent:event', { runId, event: { type: 'memory', count: mem.ids.length } });
  }

  let reply = '';
  const handle = adapter.run({ ...req, cwd, binary, memoryFile }, (event) => {
    if (event.type === 'text-delta' && reply.length < 4000) reply += event.text;
    if (event.type === 'result' && !event.isError) {
      memory
        .learnFromTurn({
          prompt: String(req.prompt || ''),
          reply,
          cwd: req.cwd || '',
          ask: (prompt) => adapter.ask({ prompt, binary, cwd }),
        })
        .then((entry) => entry && sendWin('memory:learned', entry))
        .catch(() => {}); // learning is best-effort and must never disturb a run
    }
    if (event.type === 'exit' && memoryFile) fs.rm(memoryFile, { force: true }, () => {});
    if (!win || win.isDestroyed()) return;
    win.webContents.send('agent:event', { runId, event });
    if (event.type === 'exit') running.delete(runId);
  });
  running.set(runId, handle);
});

ipcMain.handle('agent:cancel', (_e, runId) => {
  running.get(runId)?.cancel();
});

// ---- dock: browser + terminal ----
const sendWin = (ch, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};
dock.init({ getWindow: () => win, onBrowserState: (s) => sendWin('browser:state', s) });
ipcMain.handle('browser:bounds', (_e, b) => dock.setBounds(b));
ipcMain.handle('browser:visible', (_e, v) => dock.setVisible(v));
ipcMain.handle('browser:go', (_e, url) => dock.navigate(url));
ipcMain.handle('browser:nav', (_e, action) => dock.nav(action));
ipcMain.handle('browser:external', () => dock.openExternal());
ipcMain.handle('term:run', (_e, req) => {
  const cwd = req.cwd || path.join(app.getPath('userData'), 'no-folder');
  fs.mkdirSync(cwd, { recursive: true });
  dock.termRun({ ...req, cwd }, (ev) => sendWin('term:event', ev));
});
ipcMain.handle('term:kill', (_e, termId) => dock.termKill(termId));
ipcMain.handle('term:checkDir', (_e, dir) => dock.validCwd(dir));

// ---- memory bank ----
ipcMain.handle('memory:list', () => memory.list());
ipcMain.handle('memory:save', (_e, entry) => memory.upsert(entry || {}));
ipcMain.handle('memory:remove', (_e, id) => memory.remove(id));
ipcMain.handle('memory:toggle', (_e, id, on) => memory.setEnabled(id, on));
ipcMain.handle('memory:resolve', (_e, id, accept) => memory.resolve(id, !!accept));
ipcMain.handle('memory:learning', (_e, mode) => memory.setLearning(mode));
ipcMain.handle('memory:importSkill', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a skill (SKILL.md)',
    properties: ['openFile'],
    filters: [{ name: 'Skill / markdown', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (res.canceled) return null;
  const file = res.filePaths[0];
  if (fs.statSync(file).size > 500 * 1024) throw new Error('That file is too large to be a skill (500 KB max)');
  // SKILL.md is named after its folder
  const base = path.basename(file).toLowerCase() === 'skill.md' ? path.basename(path.dirname(file)) : path.parse(file).name;
  return memory.parseSkill(fs.readFileSync(file, 'utf8'), base);
});
ipcMain.handle('memory:condense', async (_e, id) => {
  const e = memory.list().entries.find((x) => x.id === id);
  if (!e) throw new Error('Memory not found');
  const out = await adapters.get('claude-code').ask({
    binary: setup.detectClaude() || 'claude',
    prompt:
      'Condense the following skill into compact instructions (max 1200 characters). Keep every concrete rule, command, name and constraint; drop examples, filler and repetition. ' +
      'Reply with only the condensed instructions, no preface.\n\n' + e.body,
  });
  return memory.upsert({ ...e, body: out.trim() });
});

let updater;
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', () => updater?.check());
ipcMain.handle('update:install', () => updater?.install());

app.whenReady().then(() => {
  memory.init(app.getPath('userData'));
  createWindow();
  updater = require('./updater').init((event) => {
    if (win && !win.isDestroyed()) win.webContents.send('update:event', event);
  });
});
app.on('before-quit', () => {
  running.forEach((h) => h.cancel());
  dock.killAll();
  setup.cancelLogin();
});
app.on('window-all-closed', () => app.quit());
