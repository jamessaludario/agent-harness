// File explorer backend: list folders, read files for preview, watch the open ones.
// Everything is confined to "roots" (the session's folders plus the app's own skill and
// attachment folders); paths are resolved through realpath so symlinks cannot escape.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.idea']);
const MAX_ENTRIES = 600;
const MAX_TEXT = 1.5 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
const BINARY_EXT = new Set(['.zip', '.gz', '.7z', '.rar', '.exe', '.dll', '.pdf', '.docx', '.xlsx', '.pptx', '.mp4', '.mov', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.ico', '.bin', '.pyc', '.db', '.sqlite']);

let extraRoots = []; // app-owned folders that may always be viewed

function init(dirs) {
  extraRoots = dirs.filter(Boolean);
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realRoots(roots) {
  return [...(Array.isArray(roots) ? roots : []), ...extraRoots]
    .filter((r) => typeof r === 'string' && path.isAbsolute(r))
    .map(real)
    .filter(Boolean);
}

/** Returns the real absolute path if it is inside a root, else null. */
function allowed(p, roots) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  const rp = real(p);
  if (!rp) return null;
  return realRoots(roots).some((r) => inside(r, rp)) ? rp : null;
}

function list(dir, roots) {
  const rp = allowed(dir, roots);
  if (!rp || !fs.statSync(rp).isDirectory()) throw new Error('Folder not available');
  const out = [];
  for (const e of fs.readdirSync(rp, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const full = path.join(rp, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue; // dangling link
      }
    }
    out.push({ name: e.name, path: full, dir: isDir });
  }
  out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { entries: out.slice(0, MAX_ENTRIES), truncated: out.length > MAX_ENTRIES };
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function read(file, roots) {
  const rp = allowed(file, roots);
  if (!rp) throw new Error('That file is outside this session\'s folders');
  const st = fs.statSync(rp);
  if (st.isDirectory()) throw new Error('That is a folder');
  const ext = path.extname(rp).toLowerCase();
  const base = { path: rp, name: path.basename(rp), size: st.size, mtime: st.mtimeMs, ext };

  if (IMAGE_MIME[ext]) {
    if (st.size > MAX_IMAGE) return { ...base, kind: 'toolarge' };
    return { ...base, kind: 'image', dataUrl: `data:${IMAGE_MIME[ext]};base64,${fs.readFileSync(rp).toString('base64')}` };
  }
  if (BINARY_EXT.has(ext)) return { ...base, kind: 'binary' };

  const fd = fs.openSync(rp, 'r');
  try {
    const len = Math.min(st.size, MAX_TEXT);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    if (looksBinary(buf)) return { ...base, kind: 'binary' };
    return { ...base, kind: 'text', text: buf.toString('utf8'), truncated: st.size > MAX_TEXT };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Turn path-like strings from the chat into real files. Relative paths are tried against
 * `base` first (e.g. the markdown file they were written in) and then every root.
 * Returns an array parallel to `candidates` with the resolved path or null.
 */
function resolve(candidates, roots, base) {
  const bases = [base, ...realRoots(roots)].filter((b) => typeof b === 'string' && b);
  return (Array.isArray(candidates) ? candidates : []).slice(0, 80).map((c) => {
    if (typeof c !== 'string' || !c || c.length > 400) return null;
    let p = c.replace(/^file:\/\/\/?/i, '').replace(/[?#].*$/, '');
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep as typed
    }
    const tries = path.isAbsolute(p) ? [p] : bases.map((b) => path.join(b, p));
    for (const t of tries) {
      const ok = allowed(t, roots);
      if (ok) {
        try {
          if (fs.statSync(ok).isFile()) return ok;
        } catch {
          // not a file
        }
      }
    }
    return null;
  });
}

// ---- find by name / search inside files / git status ------------------------------------------
function* walk(root, cap = 6000) {
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < cap) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
        seen++;
        yield { path: path.join(dir, e.name), dir: true, name: e.name };
      } else if (e.isFile()) {
        seen++;
        yield { path: path.join(dir, e.name), dir: false, name: e.name };
      }
    }
  }
}

/** Entries under root whose name contains the query (case-insensitive). */
function find(root, query, roots) {
  const rp = allowed(root, roots);
  const q = String(query || '').trim().toLowerCase();
  if (!rp || !q) return [];
  const out = [];
  for (const e of walk(rp)) {
    if (e.name.toLowerCase().includes(q)) {
      out.push({ path: e.path, dir: e.dir, name: e.name });
      if (out.length >= 200) break;
    }
  }
  return out.sort((a, b) => a.path.length - b.path.length);
}

/** Lines containing the query inside text files under root. */
async function search(root, query, roots) {
  const rp = allowed(root, roots);
  const q = String(query || '').trim().toLowerCase();
  if (!rp || q.length < 2) return { hits: [], capped: false };
  const hits = [];
  const started = Date.now();
  const BATCH = 32; // read this many files at once

  const scan = async (e) => {
    try {
      const st = await fs.promises.stat(e.path);
      if (st.size > 512 * 1024) return [];
      const buf = await fs.promises.readFile(e.path);
      if (looksBinary(buf)) return [];
      const found = [];
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && found.length < 20; i++) {
        if (lines[i].toLowerCase().includes(q)) found.push({ path: e.path, line: i + 1, text: lines[i].trim().slice(0, 180) });
      }
      return found;
    } catch {
      return [];
    }
  };

  let batch = [];
  const flush = async () => {
    const results = await Promise.all(batch.map(scan));
    batch = [];
    for (const r of results) for (const h of r) if (hits.length < 150) hits.push(h);
  };

  for (const e of walk(rp, 5000)) {
    if (e.dir) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (IMAGE_MIME[ext] || BINARY_EXT.has(ext)) continue;
    batch.push(e);
    if (batch.length >= BATCH) {
      await flush();
      if (hits.length >= 150 || Date.now() - started > 3000) return { hits, capped: true };
    }
  }
  await flush();
  return { hits, capped: false };
}

const git = (args, cwd) =>
  new Promise((resolve) =>
    execFile('git', args, { cwd, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out))),
  );

/** Changed files in the git repo containing root: { files: {abs: 'M'|'U'|'A'|'D'|'R'}, untrackedDirs, changedDirs } */
async function gitStatus(root, roots) {
  const empty = { files: {}, untrackedDirs: [], changedDirs: [] };
  const rp = allowed(root, roots);
  if (!rp) return empty;
  const top = (await git(['rev-parse', '--show-toplevel'], rp))?.trim();
  if (!top) return empty;
  const out = await git(['status', '--porcelain=v1', '-z', '-unormal'], rp);
  if (out == null) return empty;
  const files = {};
  const untrackedDirs = [];
  const changed = new Set();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const x = rec[0], y = rec[1];
    let rel = rec.slice(3);
    if (x === 'R' || x === 'C') i++; // the next token is the old name
    const code = x === '?' ? 'U' : x === 'D' || y === 'D' ? 'D' : x === 'A' ? 'A' : x === 'R' ? 'R' : 'M';
    const isDir = rel.endsWith('/');
    if (isDir) rel = rel.slice(0, -1);
    const abs = path.normalize(path.join(top, rel));
    if (isDir) untrackedDirs.push(abs);
    else files[abs] = code;
    // every folder between the change and the viewed root gets a marker
    for (let d = isDir ? abs : path.dirname(abs); inside(rp, d) && d !== path.dirname(d); d = path.dirname(d)) {
      changed.add(d);
      if (d === rp) break;
    }
  }
  return { files, untrackedDirs, changedDirs: [...changed] };
}

// ---- watching open files so a regenerated report refreshes on screen -----------------------
const watched = new Map(); // path -> listener

function watch(file, roots, onChange) {
  const rp = allowed(file, roots);
  if (!rp || watched.has(rp)) return;
  const listener = (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) onChange(rp);
  };
  watched.set(rp, listener);
  fs.watchFile(rp, { interval: 1000, persistent: false }, listener);
}

function unwatch(file) {
  const rp = real(file) || file;
  const l = watched.get(rp);
  if (l) {
    fs.unwatchFile(rp, l);
    watched.delete(rp);
  }
}

function unwatchAll() {
  for (const [p, l] of watched) fs.unwatchFile(p, l);
  watched.clear();
}

module.exports = { init, list, read, resolve, find, search, gitStatus, watch, unwatch, unwatchAll };
