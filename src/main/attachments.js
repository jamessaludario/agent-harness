// Chat attachments: files/folders the user adds to a message, plus pasted images.
// The agent reads them with its own file tools, so we only need to (1) make sure it is
// allowed to reach them and (2) tell it where they are in the prompt.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILES = 10;
const MAX_COPY_BYTES = 25 * 1024 * 1024;
const KEEP_DAYS = 7;
const UNSAFE = /["&|<>^%\r\n]/; // cannot be passed safely on a Windows command line

let root = null;

function init(userDataDir) {
  root = path.join(userDataDir, 'attachments');
  // pasted/copied attachments are scratch copies; drop old ones
  try {
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    for (const d of fs.readdirSync(root)) {
      const full = path.join(root, d);
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch {
    // nothing stored yet
  }
}

const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|%&^\r\n]/g, '_').slice(0, 120) || 'file';

function scratchDir() {
  const dir = path.join(root, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Save bytes (e.g. a pasted screenshot) as a file and return its path. */
function saveBlob(name, bytes) {
  const buf = Buffer.from(bytes);
  if (!buf.length) throw new Error('Nothing to attach');
  if (buf.length > MAX_COPY_BYTES) throw new Error('That is too large to attach (25 MB max)');
  const file = path.join(scratchDir(), safeName(name || 'pasted-image.png'));
  fs.writeFileSync(file, buf);
  return file;
}

const isInside = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * @param {string[]} paths  absolute paths chosen by the user
 * @param {{cwd: string, allowed: string[]}} ctx  folders the agent can already reach
 * @returns {{ block: string, dirs: string[] }}  text to append to the prompt, folders to grant access to
 */
function prepare(paths, { cwd, allowed = [] }) {
  const lines = [];
  const dirs = [];
  for (const p of (Array.isArray(paths) ? paths : []).slice(0, MAX_FILES)) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue; // moved or deleted since it was attached
    }
    let target = p;
    const dirOf = (t) => (fs.statSync(t).isDirectory() ? t : path.dirname(t));
    if (UNSAFE.test(dirOf(target))) {
      // the agent's CLI can't be given this location; hand it a safe copy instead
      if (st.isDirectory() || st.size > MAX_COPY_BYTES) continue;
      target = path.join(scratchDir(), safeName(path.basename(p)));
      fs.copyFileSync(p, target);
    }
    lines.push(`- ${target}${st.isDirectory() ? ' (folder)' : ''}`);
    const dir = dirOf(target);
    if (![cwd, ...allowed, ...dirs].some((a) => a && isInside(a, dir))) dirs.push(dir);
  }
  if (!lines.length) return { block: '', dirs: [] };
  return {
    block: `\n\n[Attached files — read them with your file tools; images can be viewed too]\n${lines.join('\n')}`,
    dirs,
  };
}

module.exports = { init, saveBlob, prepare };
