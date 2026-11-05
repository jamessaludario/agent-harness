// First-run setup: find Claude Code, install it if missing, and drive the
// official `claude auth login` flow so users never touch a terminal.
// Credentials are handled entirely by Claude Code; we only relay the
// authorization URL and the one-time code the user pastes.

const { spawn, execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const IS_WIN = process.platform === 'win32';
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const needsShell = (b) => IS_WIN && !/\.exe$/i.test(b);
const AUTH_HOSTS = ['claude.com', 'claude.ai'];

// ---- locating the binary ------------------------------------------------
function bundledRoots() {
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Claude', 'claude-code'));
  // Store/MSIX installs keep app data under Packages\Claude_*\LocalCache\Roaming.
  const pkgs = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  try {
    for (const d of fs.readdirSync(pkgs)) {
      if (d.startsWith('Claude_')) roots.push(path.join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
    }
  } catch {
    // no packages dir
  }
  return roots;
}

const verParts = (v) => v.split('.').map((n) => parseInt(n, 10) || 0);
function newestFirst(a, b) {
  const x = verParts(a.version), y = verParts(b.version);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

function detectClaude() {
  const found = [];
  for (const root of bundledRoots()) {
    try {
      for (const v of fs.readdirSync(root).filter((n) => /^\d+\.\d+\.\d+/.test(n))) {
        for (const h of fs.readdirSync(path.join(root, v))) {
          const exe = path.join(root, v, h, 'claude.exe');
          if (fs.existsSync(exe)) found.push({ version: v, exe });
        }
      }
    } catch {
      // root missing
    }
  }
  found.sort(newestFirst);
  if (found[0]) return found[0].exe;

  // Standalone installer location
  const local = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude');
  if (fs.existsSync(local)) return local;

  // Anything on PATH
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', ['claude'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const first = out.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  } catch {
    // not on PATH
  }
  return null;
}

// ---- status -------------------------------------------------------------
function getStatus(binaryOverride) {
  const binary = binaryOverride || detectClaude();
  if (!binary || (path.isAbsolute(binary) && !fs.existsSync(binary))) return Promise.resolve({ found: false });
  return new Promise((resolve) => {
    execFile(binary, ['auth', 'status'], { timeout: 20000, shell: needsShell(binary), windowsHide: true }, (err, stdout) => {
      try {
        const j = JSON.parse(stdout);
        resolve({ found: true, binary, loggedIn: !!j.loggedIn, email: j.email, plan: j.subscriptionType, method: j.authMethod });
      } catch {
        resolve({ found: true, binary, loggedIn: false, error: err ? String(err.message).slice(0, 300) : 'Could not read login status' });
      }
    });
  });
}

// ---- process helpers ----------------------------------------------------
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

// ---- login --------------------------------------------------------------
let loginChild = null;

function startLogin(binary, emit) {
  cancelLogin();
  const child = spawn(binary, ['auth', 'login'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: needsShell(binary),
    windowsHide: true,
  });
  loginChild = child;
  let urlSent = false;
  let buf = '';
  const onData = (d) => {
    const text = String(d).replace(ANSI, '');
    buf += text;
    if (!urlSent) {
      const m = buf.match(/https:\/\/\S+/);
      if (m) {
        urlSent = true;
        emit({ type: 'url', url: m[0] });
      }
    }
    if (/invalid code/i.test(text)) emit({ type: 'invalid' });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => emit({ type: 'error', message: e.message }));
  child.on('close', (code) => {
    if (loginChild === child) loginChild = null;
    emit({ type: 'done', code });
  });
}

function submitCode(code) {
  const c = String(code ?? '').trim();
  if (!loginChild || !c || /[\r\n]/.test(c)) return false;
  loginChild.stdin.write(`${c}\n`);
  return true;
}

function cancelLogin() {
  if (loginChild) killTree(loginChild);
  loginChild = null;
}

// Only ever open Anthropic's own sign-in pages.
function openAuthUrl(url, openExternal) {
  try {
    const u = new URL(url);
    const ok = u.protocol === 'https:' && AUTH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    if (!ok) return false;
    openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
}

// ---- install ------------------------------------------------------------
const INSTALL_CMD = IS_WIN
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash';

function installCommandText() {
  return IS_WIN ? `powershell -NoProfile -Command "${INSTALL_CMD}"` : INSTALL_CMD;
}

function install(emit) {
  const child = IS_WIN
    ? spawn('powershell.exe', ['-NoProfile', '-Command', INSTALL_CMD], { windowsHide: true })
    : spawn('bash', ['-c', INSTALL_CMD]);
  const relay = (d) => emit({ type: 'out', text: String(d).replace(ANSI, '') });
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  child.on('error', (e) => emit({ type: 'error', message: e.message }));
  child.on('close', (code) => emit({ type: 'done', code }));
}

module.exports = {
  detectClaude, getStatus, startLogin, submitCode, cancelLogin, openAuthUrl, install, installCommandText,
};
