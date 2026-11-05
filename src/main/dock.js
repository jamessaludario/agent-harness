// Dock: an embedded browser (WebContentsView) and a simple command terminal.
// The terminal runs one shell command at a time (no PTY, so no native modules):
// good for running test suites and reading their output inside the app.

const { WebContentsView, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';

// ---- browser ------------------------------------------------------------
let view = null;
let getWin = () => null;
let sendBrowser = () => {};

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u);
    const looksLikeHost = /^[^\s/]+\.[^\s/]+/.test(u);
    if (local) u = `http://${u}`;
    else if (looksLikeHost) u = `https://${u}`;
    else u = `https://www.google.com/search?q=${encodeURIComponent(u)}`;
  }
  try {
    const parsed = new URL(u);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function ensureView() {
  const win = getWin();
  if (view || !win) return view;
  view = new WebContentsView({
    webPreferences: { partition: 'persist:dock-browser', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = view.webContents;
  const push = () =>
    sendBrowser({ url: wc.getURL(), title: wc.getTitle(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), loading: wc.isLoading() });
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, push);
  // Links that want a new window open in the same view; nothing else gets to open windows.
  wc.setWindowOpenHandler(({ url }) => {
    const ok = normalizeUrl(url);
    if (ok) wc.loadURL(ok);
    return { action: 'deny' };
  });
  win.contentView.addChildView(view);
  view.setVisible(false);
  return view;
}

function setBounds(b) {
  const v = ensureView();
  if (!v || !b) return;
  const r = (n) => Math.max(0, Math.round(Number(n) || 0));
  v.setBounds({ x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height) });
}
function setVisible(show) {
  const v = ensureView();
  if (v) v.setVisible(!!show);
}
function navigate(input) {
  const v = ensureView();
  const url = normalizeUrl(input);
  if (v && url) v.webContents.loadURL(url).catch(() => {}); // load errors surface via the page itself
  return !!url;
}
function nav(action) {
  const wc = view?.webContents;
  if (!wc) return;
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') wc.stop();
}
function openExternal() {
  const url = view?.webContents.getURL();
  if (url && /^https?:/i.test(url)) shell.openExternal(url);
}

// ---- terminal -----------------------------------------------------------
const terms = new Map(); // termId -> child

function validCwd(cwd) {
  try {
    return typeof cwd === 'string' && path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function termRun({ termId, command, cwd }, send) {
  if (typeof termId !== 'string' || typeof command !== 'string' || !command.trim()) throw new Error('Bad command');
  if (terms.has(termId)) throw new Error('A command is already running in this terminal');
  if (!validCwd(cwd)) throw new Error('Folder not found');
  // PowerShell on Windows; the command is passed as a single argv entry, never via a shell line.
  const [file, args] = IS_WIN
    ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ProgressPreference='SilentlyContinue'; ${command}`]]
    : [process.env.SHELL || '/bin/sh', ['-c', command]];
  const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', FORCE_COLOR: '0' } });
  terms.set(termId, child);
  const out = (stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (text) => send({ termId, type: 'out', text }));
  };
  out(child.stdout);
  out(child.stderr);
  child.on('error', (err) => send({ termId, type: 'out', text: `${err.message}\n` }));
  child.on('close', (code) => {
    terms.delete(termId);
    send({ termId, type: 'exit', code });
  });
}

function termKill(termId) {
  const child = terms.get(termId);
  if (!child) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

function killAll() {
  for (const id of [...terms.keys()]) termKill(id);
}

function init({ getWindow, onBrowserState }) {
  getWin = getWindow;
  sendBrowser = onBrowserState;
}

module.exports = { init, setBounds, setVisible, navigate, nav, openExternal, termRun, termKill, killAll, validCwd };
