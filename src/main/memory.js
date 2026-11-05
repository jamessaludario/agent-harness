// Memory bank: durable rules, standards, decisions, preferences, notes and skills
// that are injected into every agent run, plus the self-learning pipeline that
// proposes new entries (always for the user to approve; nothing learned is
// active until accepted).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readZip } = require('./zip');

const TYPES = ['rule', 'standard', 'decision', 'preference', 'note', 'skill'];
const LEARNING_MODES = ['off', 'suggest', 'smart'];
const DAY = 864e5;

// ---- learning criteria (all tunable here) --------------------------------
const CRITERIA = {
  maxPending: 20, // stop suggesting once this many await review
  pendingTtlDays: 14, // unreviewed suggestions expire
  staleDays: 60, // an accepted learned entry never used in this long is flagged stale
  minChars: 12,
  maxChars: 400,
  similarity: 0.6, // token overlap above this counts as a duplicate (also of rejected ones)
  smartMinConfidence: 0.7,
  rejectedTtlDays: 180,
};

// A message must look like it states something lasting before it is even considered.
const SIGNAL = /\b(always|never|from now on|going forward|remember (that|to)|make sure (to|you)|do not ever|don'?t ever|prefer|instead of|we (use|follow|decided|agreed)|our (standard|convention|rule|policy)|stop (using|doing)|should always|must always|must never|should never)\b/i;
const EXPLICIT = /\b(remember (that|to)|from now on|going forward)\b/i;

let file = null;
let skillsRoot = null; // extracted skill packages (templates etc.) live here
let data = { settings: { learning: 'suggest' }, entries: [] };

function init(userDataDir) {
  file = path.join(userDataDir, 'memory.json');
  skillsRoot = path.join(userDataDir, 'skills');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      settings: { learning: 'suggest', ...(saved.settings || {}) },
      entries: Array.isArray(saved.entries) ? saved.entries : [],
    };
  } catch {
    // first run or unreadable file: start empty
  }
  if (!LEARNING_MODES.includes(data.settings.learning)) data.settings.learning = 'suggest';
  expire();
  sweepSkillDirs();
}

function persist() {
  if (!file) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const normScope = (s) => (s ? path.resolve(String(s)).toLowerCase() : '');
const now = () => Date.now();

function expire() {
  const t = now();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => {
    if (e.status === 'pending') return t - e.createdAt < CRITERIA.pendingTtlDays * DAY;
    if (e.status === 'rejected') return t - e.updatedAt < CRITERIA.rejectedTtlDays * DAY;
    return true;
  });
  if (data.entries.length !== before) persist();
}

// ---- skills ----------------------------------------------------------------
function parseSkill(text, fallbackName = 'Skill') {
  const src = String(text).replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { title: fallbackName, description: '', body: src.trim() };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1].toLowerCase();
      meta[key] = kv[2].replace(/^[>|]-?$/, '').replace(/^["']|["']$/g, '').trim();
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = `${meta[key]} ${line.trim()}`.trim(); // folded/indented continuation
    }
  }
  return { title: meta.name || fallbackName, description: meta.description || '', body: m[2].trim() };
}

// ---- skill packages (zip with SKILL.md + templates) ---------------------------
const isUnderSkills = (p) => {
  if (!skillsRoot || !p) return false;
  const rel = path.relative(skillsRoot, path.resolve(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function removeSkillDir(dir) {
  if (isUnderSkills(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// Drop extracted folders no entry refers to (e.g. an import the user cancelled).
function sweepSkillDirs() {
  if (!skillsRoot || !fs.existsSync(skillsRoot)) return;
  const used = new Set(data.entries.map((e) => e.resourceDir && path.resolve(e.resourceDir)).filter(Boolean));
  for (const d of fs.readdirSync(skillsRoot)) {
    const full = path.join(skillsRoot, d);
    if (!used.has(path.resolve(full))) removeSkillDir(full);
  }
}

/**
 * Unpack a skill zip: finds SKILL.md (at the root or inside one folder), writes the
 * whole package under the app's skills folder and returns the parsed skill.
 */
function extractSkillZip(buf, fallbackName = 'Skill') {
  const files = readZip(buf);
  const skillFile = files
    .filter((f) => path.posix.basename(f.name).toLowerCase() === 'skill.md')
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (!skillFile) throw new Error('No SKILL.md found in that zip');

  const rootDir = path.posix.dirname(skillFile.name); // '.' when at the zip root
  const prefix = rootDir === '.' ? '' : `${rootDir}/`;
  const inside = files.filter((f) => f.name.startsWith(prefix));
  const parsed = parseSkill(skillFile.data.toString('utf8'), rootDir === '.' ? fallbackName : path.posix.basename(rootDir));

  const dir = path.join(skillsRoot, crypto.randomUUID());
  const names = [];
  try {
    for (const f of inside) {
      const rel = f.name.slice(prefix.length);
      const target = path.join(dir, ...rel.split('/'));
      if (path.relative(dir, target).startsWith('..')) continue; // belt and braces against path tricks
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
      names.push(rel);
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { ...parsed, resourceDir: dir, files: names.sort() };
}

// ---- CRUD ------------------------------------------------------------------
const clip = (s, n) => String(s ?? '').slice(0, n);

function clean(e, existing) {
  const type = TYPES.includes(e.type) ? e.type : 'note';
  let title = clip(e.title, 120).trim();
  let body = clip(e.body, 20000).trim();
  let description = clip(e.description, 600).trim();
  if (type === 'skill' && /^---\r?\n/.test(body)) {
    const p = parseSkill(body, title);
    title = title || p.title;
    description = description || p.description;
    body = p.body;
  }
  if (!title && body) title = clip(body.split(/\r?\n/)[0], 60);
  if (!title || !body) throw new Error('A memory needs a title and some content');
  const scope = e.scope ? path.resolve(String(e.scope)) : '';
  const t = now();
  let resourceDir = type === 'skill' ? existing?.resourceDir || '' : '';
  let files = type === 'skill' ? existing?.files || [] : [];
  if (type === 'skill' && e.resourceDir && isUnderSkills(e.resourceDir) && fs.existsSync(e.resourceDir)) {
    resourceDir = path.resolve(e.resourceDir);
    files = Array.isArray(e.files) ? e.files.map((f) => clip(f, 200)).slice(0, 500) : files;
  }
  return {
    resourceDir,
    files,
    id: existing?.id || crypto.randomUUID(),
    type,
    title,
    description,
    body,
    scope,
    enabled: e.enabled !== false,
    source: existing?.source || (['manual', 'skill', 'learned'].includes(e.source) ? e.source : type === 'skill' ? 'skill' : 'manual'),
    status: existing?.status || 'active',
    uses: existing?.uses || 0,
    lastUsed: existing?.lastUsed || null,
    createdAt: existing?.createdAt || t,
    updatedAt: t,
  };
}

function upsert(e) {
  const i = e.id ? data.entries.findIndex((x) => x.id === e.id) : -1;
  const entry = clean(e, i >= 0 ? data.entries[i] : null);
  if (i >= 0) data.entries[i] = entry;
  else data.entries.unshift(entry);
  persist();
  return entry;
}

function remove(id) {
  removeSkillDir(data.entries.find((e) => e.id === id)?.resourceDir);
  data.entries = data.entries.filter((e) => e.id !== id);
  persist();
}

function setEnabled(id, enabled) {
  const e = data.entries.find((x) => x.id === id);
  if (e) {
    e.enabled = !!enabled;
    e.updatedAt = now();
    persist();
  }
}

function setLearning(mode) {
  if (LEARNING_MODES.includes(mode)) {
    data.settings.learning = mode;
    persist();
  }
}

function resolve(id, accept) {
  const e = data.entries.find((x) => x.id === id && x.status === 'pending');
  if (!e) return;
  e.status = accept ? 'active' : 'rejected'; // rejected entries stay as tombstones so they aren't re-suggested
  e.updatedAt = now();
  persist();
}

function list() {
  const t = now();
  return {
    settings: data.settings,
    criteria: CRITERIA,
    entries: data.entries
      .filter((e) => e.status !== 'rejected')
      .map((e) => ({
        ...e,
        stale: e.source === 'learned' && e.status === 'active' && !e.uses && t - e.createdAt > CRITERIA.staleDays * DAY,
      })),
  };
}

// ---- prompt injection ------------------------------------------------------
const BUDGET = 16000;
const SECTIONS = [
  ['rule', 'Rules'],
  ['standard', 'Standards'],
  ['decision', 'Decisions'],
  ['preference', 'Preferences'],
  ['note', 'Notes'],
];

function applicable(cwd) {
  const here = normScope(cwd);
  return data.entries.filter((e) => e.status === 'active' && e.enabled && (!e.scope || normScope(e.scope) === here));
}

function buildPrompt(cwd) {
  const active = applicable(cwd);
  if (!active.length) return { text: '', ids: [], dirs: [] };
  const ids = [];
  const dirs = []; // skill package folders the agent must be allowed to read
  let out =
    '# Memory bank\nThe user keeps these durable rules, standards, decisions and skills. Follow them in this work. ' +
    'If one conflicts with an explicit instruction in this conversation, follow the conversation.\n';
  const room = () => BUDGET - out.length;

  for (const [type, label] of SECTIONS) {
    const items = active.filter((e) => e.type === type);
    if (!items.length) continue;
    let block = `\n## ${label}\n`;
    for (const e of items) {
      const line = `- ${e.title}: ${e.body.replace(/\s*\n\s*/g, ' ')}\n`;
      if (block.length + line.length > room()) break;
      block += line;
      ids.push(e.id);
    }
    out += block;
  }

  const skills = active.filter((e) => e.type === 'skill');
  if (skills.length) {
    out += '\n## Skills\nProcedures the user taught. Apply the matching one when its description fits the task.\n';
    for (const e of skills) {
      // a zip skill keeps its templates on disk; tell the agent where, so it can read them on demand
      const hasFiles = !!e.resourceDir && fs.existsSync(e.resourceDir);
      const where = hasFiles ? `Skill files are in ${e.resourceDir} (read them with your file tools when needed): ${e.files.slice(0, 40).join(', ')}\n` : '';
      const cut = e.body.length > 2500 ? `\n[truncated; full text in ${hasFiles ? path.join(e.resourceDir, 'SKILL.md') : 'the memory bank'}]` : '';
      const full = `\n### ${e.title}\n${e.description ? `${e.description}\n` : ''}${where}${clip(e.body, 2500)}${cut}\n`;
      const short = `\n### ${e.title}\n${e.description || clip(e.body, 200)}\n${where}`;
      const pick = full.length <= room() ? full : short.length <= room() ? short : '';
      if (!pick) break;
      out += pick;
      ids.push(e.id);
      if (hasFiles) dirs.push(e.resourceDir);
    }
  }
  return { text: out, ids, dirs };
}

/** Full text of a skill the user invoked explicitly with /name (not truncated, even if disabled). */
function skillInvocation(id) {
  const e = data.entries.find((x) => x.id === id && x.type === 'skill' && x.status === 'active');
  if (!e) return null;
  const hasFiles = !!e.resourceDir && fs.existsSync(e.resourceDir);
  const where = hasFiles ? `Skill files are in ${e.resourceDir} (read templates and other files from there): ${e.files.slice(0, 60).join(', ')}\n\n` : '';
  const text =
    `[The user invoked the "${e.title}" skill with a slash command. Follow it for this request.]\n\n` +
    `${e.description ? `${e.description}\n\n` : ''}${where}${clip(e.body, 30000)}\n\n[End of skill]\n\nUser request: `;
  markUsed([e.id]);
  return { text, dir: hasFiles ? e.resourceDir : null, title: e.title };
}

function markUsed(ids) {
  if (!ids.length) return;
  const t = now();
  for (const e of data.entries) {
    if (ids.includes(e.id)) {
      e.uses = (e.uses || 0) + 1;
      e.lastUsed = t;
    }
  }
  persist();
}

// ---- self-learning -----------------------------------------------------------
const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
function similar(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

const isDuplicate = (text) => data.entries.some((e) => similar(`${e.title} ${e.body}`, text) >= CRITERIA.similarity || similar(e.body, text) >= CRITERIA.similarity);

/** Which sentences of a user message state something lasting (heuristic, free). */
function signalSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= CRITERIA.minChars && s.length <= CRITERIA.maxChars && SIGNAL.test(s));
}

function addCandidate({ type, title, body, scope, confidence }) {
  if (data.entries.filter((e) => e.status === 'pending').length >= CRITERIA.maxPending) return null;
  if (!body || body.length < CRITERIA.minChars || body.length > CRITERIA.maxChars) return null;
  if (isDuplicate(`${title || ''} ${body}`)) return null;
  const e = clean({ type, title, body, scope, source: 'learned' }, null);
  e.status = 'pending';
  e.confidence = confidence;
  data.entries.unshift(e);
  persist();
  return e;
}

const DISTILL_PROMPT = (user, reply) =>
  'You maintain a memory bank of durable instructions for a coding assistant.\n' +
  'Decide whether the USER MESSAGE states a lasting rule, standard, preference or decision that should apply to FUTURE tasks (not a one-off instruction about the current task).\n' +
  'Reply with ONLY a JSON object, no prose: ' +
  '{"durable":true|false,"type":"rule|standard|decision|preference","title":"<=60 chars","body":"one or two imperative sentences","confidence":0-1}\n\n' +
  `USER MESSAGE:\n${clip(user, 1500)}\n\nASSISTANT REPLY (context only):\n${clip(reply, 600)}`;

/**
 * Called after a successful turn. `ask(prompt)` runs a cheap model (smart mode only).
 * Returns the new pending entry, or null when nothing met the criteria.
 */
async function learnFromTurn({ prompt, reply, cwd, ask }) {
  const mode = data.settings.learning;
  if (mode === 'off') return null;
  const hits = signalSentences(prompt);
  if (!hits.length) return null; // criterion 1: must look like a lasting statement

  const scope = cwd || '';
  if (mode === 'suggest') {
    const body = hits.slice(0, 2).join(' ');
    return addCandidate({ type: 'rule', title: clip(hits[0], 60), body, scope, confidence: EXPLICIT.test(body) ? 0.85 : 0.5 });
  }

  // smart: let a small model decide, and require confidence
  let verdict;
  try {
    const raw = await ask(DISTILL_PROMPT(hits.join(' '), reply));
    const json = /\{[\s\S]*\}/.exec(raw)?.[0];
    verdict = json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
  if (!verdict?.durable || typeof verdict.confidence !== 'number' || verdict.confidence < CRITERIA.smartMinConfidence) return null;
  return addCandidate({
    type: verdict.type,
    title: clip(verdict.title, 60),
    body: clip(verdict.body, CRITERIA.maxChars),
    scope,
    confidence: verdict.confidence,
  });
}

module.exports = {
  init, list, upsert, extractSkillZip, skillInvocation, remove, setEnabled, setLearning, resolve,
  buildPrompt, markUsed, parseSkill, learnFromTurn, CRITERIA,
};
