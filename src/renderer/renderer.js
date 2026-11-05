const $ = (id) => document.getElementById(id);
const uid = () => crypto.randomUUID();
const log = $('log');

const PERM_LABELS = {
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan only',
  default: 'Ask (blocks tools)',
  bypassPermissions: 'Bypass all',
};
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ---- state --------------------------------------------------------------
let state = {
  projects: [], // { path, name, collapsed, sessions: [{ id, title, claudeSessionId, items, cost, turns, outputs }] }
  settings: { adapterId: 'claude-code', permissionMode: 'acceptEdits', binary: '', theme: 'system', model: '', effort: '' },
  active: null, // session id
  panelOpen: true,
  sideWidth: 240,
  panelWidth: 250,
  dock: { open: false, tab: 'browser', width: 420, url: '' },
  limits: null, // { windows: { five_hour: {utilization, resetsAt}, ... }, status, at }
  draftFolder: null, // folder chosen on the New screen ('' = no folder)
};
const runs = new Map(); // runId -> { sessionId }
const runtime = new Map(); // sessionId -> { runId }   (not persisted)
let query = '';
let saveTimer;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.harness.saveState(state), 400);
}

function findSession(id) {
  for (const p of state.projects) {
    const s = p.sessions.find((x) => x.id === id);
    if (s) return { p, s };
  }
  return null;
}
const activeSession = () => (state.active ? findSession(state.active)?.s : null);
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

function addProject(path) {
  let p = state.projects.find((x) => x.path === path);
  if (!p) {
    p = { path, name: path ? baseName(path) : 'No folder', collapsed: false, sessions: [] };
    state.projects.push(p);
  }
  return p;
}

function newSession(project) {
  const s = { id: uid(), title: 'New session', claudeSessionId: null, items: [], cost: 0, turns: 0, outputs: [] };
  project.sessions.unshift(s);
  project.collapsed = false;
  state.active = s.id;
  return s;
}

// ---- new-session draft ("New" screen) ------------------------------------
// A draft is simply "no active session". The folder is chosen from the dropdown
// under the composer; the session is only created when the first message is sent.
// '' means "No folder".
function defaultFolder() {
  const f = state.active ? findSession(state.active) : null;
  if (f) return f.p.path;
  const d = state.draftFolder;
  if (d === '' || (d != null && state.projects.some((p) => p.path === d))) return d;
  return state.projects.find((p) => p.path)?.path ?? '';
}

function startDraft(folder) {
  const target = folder === undefined ? defaultFolder() : folder;
  state.active = null;
  state.draftFolder = target;
  closeFolderMenu();
  refresh();
  save();
  $('prompt').focus();
}

async function openFolderForDraft() {
  const dir = await window.harness.pickFolder();
  if (!dir) return;
  addProject(dir);
  startDraft(dir);
}

function closeFolderMenu() { $('folderMenu').hidden = true; }

function renderFolderMenu() {
  const m = $('folderMenu');
  m.replaceChildren();
  const cur = defaultFolder();
  const item = (label, fn, checked) => {
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.append(el('span', 'ellipsis', label));
    if (checked) b.append(el('span', 'check', '✓'));
    b.addEventListener('click', fn);
    m.appendChild(b);
  };
  item('No folder', () => startDraft(''), cur === '');
  const real = state.projects.filter((p) => p.path);
  if (real.length) m.appendChild(el('div', 'menu-label', 'Recent'));
  for (const p of real) item(p.name, () => startDraft(p.path), cur === p.path);
  m.appendChild(el('div', 'menu-sep'));
  item('Open folder…', () => { closeFolderMenu(); openFolderForDraft(); }, false);
}

// ---- rendering helpers --------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Minimal safe rich text: ``` fences and `inline code`. Never uses innerHTML.
function renderRich(target, text) {
  const frag = document.createDocumentFragment();
  const parts = text.split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      // drop the newline that touches a code block so it doesn't render as a blank line
      if (i > 0) part = part.replace(/^\n/, '');
      if (i < parts.length - 1) part = part.replace(/\n$/, '');
    }
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      frag.appendChild(el('pre', 'code', (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '')));
    } else {
      part.split(/(`[^`\n]+`)/).forEach((seg) => {
        if (/^`[^`\n]+`$/.test(seg)) frag.appendChild(el('code', null, seg.slice(1, -1)));
        else if (seg) frag.appendChild(document.createTextNode(seg));
      });
    }
  });
  target.replaceChildren(frag);
}

function toolSummary(input) {
  return String(input?.command ?? input?.file_path ?? input?.pattern ?? input?.path ?? input?.description ?? '').slice(0, 90);
}

function toolEl(it) {
  const d = el('details', 'tool' + (it.isError ? ' err' : ''));
  const s = el('summary');
  s.append(el('b', null, it.name), ' ', toolSummary(it.input));
  d.append(s, el('pre', null, JSON.stringify(it.input, null, 2)));
  if (it.result != null) d.append(el('pre', 'result', it.result.slice(0, 4000)));
  return d;
}

function renderLog() {
  log.replaceChildren();
  const s = activeSession();
  if (!s) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'glyph', '✶'), el('h2', null, 'What should we work on?'), el('p', null, 'Pick a folder below, then describe a task.'));
    log.appendChild(empty);
    return;
  }
  let list = null;
  let count = 0;
  let summary = null;
  for (const it of s.items) {
    if (it.t === 'tool') {
      if (!list) {
        const g = el('details', 'tool-group');
        summary = el('summary');
        list = el('div', 'tool-list');
        g.append(summary, list);
        log.appendChild(g);
        count = 0;
      }
      count++;
      summary.textContent = `Ran ${count} command${count > 1 ? 's' : ''}`;
      list.appendChild(toolEl(it));
      continue;
    }
    list = null;
    if (it.t === 'user') log.appendChild(el('div', 'msg user', it.text));
    else if (it.t === 'assistant') {
      const m = el('div', 'msg assistant');
      renderRich(m, it.text);
      log.appendChild(m);
    } else if (it.t === 'error') log.appendChild(el('div', 'msg error', it.text));
    else if (it.t === 'footer') log.appendChild(el('div', 'footer', it.text));
  }
  if (runtime.has(s.id)) {
    const last = s.items[s.items.length - 1];
    if (last?.t === 'assistant') {
      log.lastElementChild.classList.add('streaming'); // blinking caret while text arrives
    } else {
      log.appendChild(thinkingEl(last));
    }
  }
  log.scrollTop = log.scrollHeight;
}

function thinkingEl(last) {
  const d = el('div', 'thinking');
  const dots = el('span', 'dots');
  for (let i = 0; i < 3; i++) dots.appendChild(el('i'));
  const running = last?.t === 'tool' && last.result == null;
  d.append(dots, el('span', 'shimmer', running ? `Running ${last.name}…` : 'Thinking…'));
  return d;
}

function renderSidebar() {
  const root = $('projects');
  root.replaceChildren();
  const q = query.toLowerCase();
  for (const p of state.projects) {
    const sessions = p.sessions.filter((s) => !q || s.title.toLowerCase().includes(q));
    if (q && !sessions.length) continue;
    const head = el('div', 'group-head');
    const label = el('span', 'group-label', `${p.name} ${p.collapsed ? '▸' : '▾'}`);
    label.title = p.path;
    const rm = el('button', 'x', '×');
    rm.title = 'Remove project from list';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      if (p.sessions.some((s) => runtime.has(s.id))) return;
      state.projects = state.projects.filter((x) => x !== p);
      if (!findSession(state.active)) state.active = state.projects[0]?.sessions[0]?.id ?? null;
      refresh();
      save();
    });
    const plus = el('button', 'x plus', '+');
    plus.title = 'New session in this folder';
    plus.addEventListener('click', (e) => {
      e.stopPropagation();
      startDraft(p.path);
    });
    head.append(label, plus, rm);
    head.addEventListener('click', () => {
      p.collapsed = !p.collapsed;
      renderSidebar();
      save();
    });
    root.appendChild(head);
    if (p.collapsed && !q) continue;
    for (const s of sessions) {
      const row = el('div', 'session' + (s.id === state.active ? ' active' : ''));
      if (runtime.has(s.id)) row.appendChild(el('span', 'dot'));
      row.appendChild(el('span', 'ellipsis', s.title));
      const del = el('button', 'x', '×');
      del.title = 'Delete session';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (runtime.has(s.id)) return;
        p.sessions = p.sessions.filter((x) => x !== s);
        if (state.active === s.id) state.active = p.sessions[0]?.id ?? null;
        refresh();
        save();
      });
      row.appendChild(del);
      row.addEventListener('click', () => {
        state.active = s.id;
        refresh();
        save();
      });
      root.appendChild(row);
    }
  }
}

function renderPanel() {
  const f = state.active ? findSession(state.active) : null;
  const draft = f ? null : defaultFolder();
  $('envFolder').textContent = f ? f.p.name : draft ? baseName(draft) : 'No folder';
  $('envFolder').title = f ? f.p.path : draft || '';
  $('envPerm').textContent = PERM_LABELS[state.settings.permissionMode];
  const dirs = $('extraDirs');
  dirs.replaceChildren();
  for (const d of f?.s.extraDirs ?? []) {
    const row = el('div', 'row');
    row.append(el('span', 'ic', '➕'));
    const name = el('span', 'ellipsis', baseName(d));
    name.title = d;
    const rm = el('button', 'x shown', '×');
    rm.title = 'Remove folder from this session';
    rm.addEventListener('click', () => {
      f.s.extraDirs = f.s.extraDirs.filter((x) => x !== d);
      renderPanel();
      save();
    });
    row.append(name, rm);
    dirs.appendChild(row);
  }
  $('addDir').hidden = !f;
  $('ctxTurns').textContent = f ? String(f.s.turns) : '0';
  $('ctxCost').textContent = f ? `$${f.s.cost.toFixed(4)}` : '$0.00';
  const out = $('outputs');
  out.replaceChildren();
  for (const p of f?.s.outputs ?? []) {
    const b = el('button', 'row link', baseName(p));
    b.title = p;
    b.addEventListener('click', () => window.harness.reveal(p));
    out.appendChild(b);
  }
  if (f && !f.s.outputs.length) out.appendChild(el('div', 'muted', 'No files yet'));
  renderLimits();
  renderLayout();
}

// ---- plan usage limits ------------------------------------------------------
const WINDOW_LABELS = { five_hour: '5-hour limit', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' };

function fmtReset(epochSec) {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `Resets at ${time}`;
  return `Resets ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function renderLimits() {
  const box = $('limits');
  box.replaceChildren();
  const windows = Object.entries(state.limits?.windows ?? {});
  if (!windows.length) {
    box.appendChild(el('div', 'muted', 'Shown after your first message'));
    return;
  }
  // Windows past their reset have been refilled; don't show stale numbers as current.
  const now = Date.now() / 1000;
  for (const [key, w] of windows) {
    const expired = w.resetsAt && w.resetsAt < now;
    const pct = expired ? 0 : Math.min(100, Math.round(w.utilization * 100));
    const row = el('div', 'limit');
    const head = el('div', 'limit-head');
    head.append(el('span', null, WINDOW_LABELS[key] ?? key.replace(/_/g, ' ')), el('span', null, `${pct}%`));
    const bar = el('div', 'bar');
    const fill = el('i', pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : '');
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    row.append(head, bar, el('div', 'limit-sub', expired ? 'Reset' : fmtReset(w.resetsAt)));
    box.appendChild(row);
  }
  if (state.limits.at) box.appendChild(el('div', 'limit-sub', `Updated ${new Date(state.limits.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`));
}

function renderChrome() {
  const s = activeSession();
  $('title').textContent = s ? s.title : 'New session';
  const busy = !!(s && runtime.has(s.id));
  $('folderBar').hidden = !!s; // folder is chosen only before a session starts
  if (!s) {
    const cur = defaultFolder();
    $('folderName').textContent = cur ? state.projects.find((p) => p.path === cur)?.name ?? baseName(cur) : 'No folder';
  }
  $('send').hidden = busy;
  $('stop').hidden = !busy;
  $('perm').value = state.settings.permissionMode;
  fillAgentSelects();
}

// Agent / model / effort selectors in the composer. Options come from the adapter.
let adapterList = [];
const currentAdapter = () => adapterList.find((a) => a.id === state.settings.adapterId) ?? adapterList[0];

function fillSelect(sel, items, value) {
  sel.replaceChildren(...items.map((i) => Object.assign(el('option', null, i.label), { value: i.id })));
  sel.value = items.some((i) => i.id === value) ? value : items[0]?.id ?? '';
  sel.hidden = items.length < 2;
}

function fillAgentSelects() {
  const a = currentAdapter();
  if (!a) return;
  fillSelect($('adapterSel'), adapterList, a.id);
  fillSelect($('modelSel'), a.models, state.settings.model);
  fillSelect($('effortSel'), a.efforts, state.settings.effort);
  $('setAdapter').value = a.id;
}

function refresh() {
  renderSidebar();
  renderLog();
  renderPanel();
  renderChrome();
}

// ---- agent events -------------------------------------------------------
window.harness.onEvent(({ runId, event }) => {
  const run = runs.get(runId);
  if (!run) return;
  const f = findSession(run.sessionId);
  if (!f) {
    if (event.type === 'exit') runs.delete(runId);
    return;
  }
  const s = f.s;
  const isActive = state.active === s.id;
  let rerender = true;

  switch (event.type) {
    case 'init':
      s.claudeSessionId = event.sessionId;
      rerender = false;
      break;
    case 'text-delta': {
      let last = s.items[s.items.length - 1];
      if (last?.t === 'assistant') {
        last.text += event.text;
        if (isActive) renderRich(log.lastElementChild, last.text);
        if (isActive) log.scrollTop = log.scrollHeight;
        rerender = false;
      } else {
        s.items.push({ t: 'assistant', text: event.text });
      }
      break;
    }
    case 'tool-use':
      s.items.push({ t: 'tool', id: event.id, name: event.name, input: event.input });
      if (WRITE_TOOLS.has(event.name) && event.input?.file_path && !s.outputs.includes(event.input.file_path)) {
        s.outputs.push(event.input.file_path);
      }
      break;
    case 'tool-result': {
      const t = s.items.find((i) => i.t === 'tool' && i.id === event.id);
      if (t) {
        t.result = event.content;
        t.isError = event.isError;
      }
      break;
    }
    case 'rate-limit':
      if (Object.keys(event.windows).length) state.limits = { windows: event.windows, status: event.status, at: Date.now() };
      renderLimits();
      rerender = false;
      break;
    case 'result': {
      s.turns++;
      const parts = [];
      if (event.durationMs) parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
      if (event.costUsd != null) {
        s.cost += event.costUsd;
        parts.push(`$${event.costUsd.toFixed(4)} (API-equivalent)`);
      }
      if (parts.length) s.items.push({ t: 'footer', text: parts.join(' · ') });
      if (event.isError && event.text) s.items.push({ t: 'error', text: event.text });
      break;
    }
    case 'error':
      s.items.push({ t: 'error', text: event.message });
      break;
    case 'exit':
      runs.delete(runId);
      runtime.delete(s.id);
      break;
  }

  if (rerender) {
    if (isActive) renderLog();
    renderSidebar();
    renderPanel();
    renderChrome();
  }
  save();
});

// ---- actions ------------------------------------------------------------
async function send() {
  const text = $('prompt').value.trim();
  if (!text) return;
  let s = activeSession();
  if (!s) s = newSession(addProject(defaultFolder()));
  if (runtime.has(s.id)) return;
  const f = findSession(s.id);

  s.items.push({ t: 'user', text });
  if (s.title === 'New session') s.title = text.length > 48 ? `${text.slice(0, 48)}…` : text;
  $('prompt').value = '';
  autosize();

  const runId = uid();
  runs.set(runId, { sessionId: s.id });
  runtime.set(s.id, { runId });
  refresh();
  try {
    await window.harness.run({
      runId,
      adapterId: state.settings.adapterId,
      prompt: text,
      cwd: f.p.path || undefined,
      extraDirs: s.extraDirs ?? [],
      sessionId: s.claudeSessionId,
      permissionMode: state.settings.permissionMode,
      model: state.settings.model || undefined,
      effort: state.settings.effort || undefined,
      binary: state.settings.binary || undefined,
    });
  } catch (e) {
    s.items.push({ t: 'error', text: String(e.message || e) });
    runs.delete(runId);
    runtime.delete(s.id);
    refresh();
  }
  save();
}

function autosize() {
  const t = $('prompt');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
$('prompt').addEventListener('input', autosize);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$('stop').addEventListener('click', () => {
  const r = runtime.get(state.active);
  if (r) window.harness.cancel(r.runId);
});
$('perm').addEventListener('change', (e) => {
  state.settings.permissionMode = e.target.value;
  renderPanel();
  save();
});
$('new').addEventListener('click', () => startDraft());
$('folderBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('folderMenu');
  if (m.hidden) renderFolderMenu();
  m.hidden = !m.hidden;
});
document.addEventListener('click', closeFolderMenu);
$('addDir').addEventListener('click', async () => {
  const f = state.active ? findSession(state.active) : null;
  if (!f) return;
  const dir = await window.harness.pickFolder();
  if (!dir || dir === f.p.path) return;
  f.s.extraDirs = f.s.extraDirs ?? [];
  if (!f.s.extraDirs.includes(dir)) f.s.extraDirs.push(dir);
  renderPanel();
  save();
});
$('searchBtn').addEventListener('click', toggleSearch);
$('search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  renderSidebar();
});
function toggleSearch() {
  const box = $('search');
  box.hidden = !box.hidden;
  if (box.hidden) {
    box.value = '';
    query = '';
    renderSidebar();
  } else box.focus();
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    toggleSearch();
  }
});
$('togglePanel').addEventListener('click', () => {
  state.panelOpen = !state.panelOpen;
  renderPanel();
  save();
});

// settings dialog
$('settings').addEventListener('click', () => { $('dlg').showModal(); syncBrowser(); });
function setAdapter(id) {
  state.settings.adapterId = id;
  // model/effort lists differ per agent; drop choices the new agent doesn't offer
  const a = currentAdapter();
  if (!a.models.some((m) => m.id === state.settings.model)) state.settings.model = '';
  if (!a.efforts.some((m) => m.id === state.settings.effort)) state.settings.effort = '';
  renderChrome();
  save();
}
$('setAdapter').addEventListener('change', (e) => setAdapter(e.target.value));
$('adapterSel').addEventListener('change', (e) => setAdapter(e.target.value));
$('modelSel').addEventListener('change', (e) => { state.settings.model = e.target.value; save(); });
$('effortSel').addEventListener('change', (e) => { state.settings.effort = e.target.value; save(); });
$('setBinary').addEventListener('input', (e) => {
  state.settings.binary = e.target.value.trim();
  save();
});

$('browseBinary').addEventListener('click', async () => {
  const f = await window.harness.pickFile();
  if (f) {
    $('setBinary').value = f;
    state.settings.binary = f;
    save();
  }
});
$('clearBinary').addEventListener('click', () => {
  $('setBinary').value = '';
  state.settings.binary = '';
  save();
});

// ---- theme ----------------------------------------------------------------
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = state.settings.theme;
  const resolved = pref === 'system' ? (systemDark.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
  window.harness.setTheme(pref, resolved === 'light' ? '#f6faff' : '#14181e'); // native title bar + window background
}
systemDark.addEventListener('change', () => state.settings.theme === 'system' && applyTheme());
$('setTheme').addEventListener('change', (e) => {
  state.settings.theme = e.target.value;
  applyTheme();
  save();
});

// ---- app updates ------------------------------------------------------------
let appVersion = '';
let updateText = '';
function showUpdateStatus(text) {
  updateText = text;
  $('updateStatus').textContent = `Version ${appVersion}${text ? ` · ${text}` : ''}`;
}
window.harness.onUpdate((e) => {
  switch (e.type) {
    case 'checking': showUpdateStatus('Checking for updates…'); break;
    case 'available': showUpdateStatus(`Downloading ${e.version}…`); break;
    case 'progress': showUpdateStatus(`Downloading… ${e.percent}%`); break;
    case 'none': showUpdateStatus('Up to date'); break;
    case 'dev': showUpdateStatus('Updates work in the installed app only'); break;
    case 'error':
      // GitHub answers 404 when there is no release yet or the repo is private.
      showUpdateStatus(/404|not found|no published versions|latest\.yml/i.test(e.message || '')
        ? 'No published release found yet'
        : "Couldn't check for updates");
      break;
    case 'ready': {
      showUpdateStatus(`${e.version} ready to install`);
      const b = $('updateBanner');
      b.textContent = `Update ${e.version} ready — restart`;
      b.hidden = false;
      break;
    }
  }
});
$('updateBanner').addEventListener('click', () => window.harness.installUpdate());
$('checkUpdate').addEventListener('click', () => window.harness.checkForUpdates());

// ---- first-run onboarding ------------------------------------------------
const ob = { url: null, st: null, cancelled: false };
const binaryOverride = () => state.settings.binary || undefined;

function obButtons(list) {
  const box = $('obActions');
  box.replaceChildren();
  for (const [label, fn, primary] of list) {
    const b = el('button', primary ? 'primary' : 'ghost', label);
    b.type = 'button';
    b.addEventListener('click', fn);
    box.appendChild(b);
  }
}

function obShow(title, text, { code = false, error = '', log = false } = {}) {
  $('onboard').hidden = false;
  $('obTitle').textContent = title;
  $('obText').textContent = text;
  $('obCode').hidden = !code;
  $('obError').hidden = !error;
  $('obError').textContent = error;
  $('obLog').hidden = !log;
  if (code) $('obCodeInput').focus();
  syncBrowser();
}
const obHide = () => { $('onboard').hidden = true; syncBrowser(); };

function renderAccount(st) {
  $('account').textContent = !st.found
    ? 'Account: Claude Code not found'
    : st.loggedIn
      ? `Account: ${st.email || 'signed in'}${st.plan ? ` · ${st.plan}` : ''}`
      : 'Account: not signed in';
}

async function runCheck({ silent = false } = {}) {
  const st = await window.harness.setup.status(binaryOverride());
  ob.st = st;
  renderAccount(st);
  if (st.found && st.loggedIn) {
    if (silent) obHide(); else obDone(st);
    return true;
  }
  if (st.found) obLoginScreen(); else obMissingScreen();
  return false;
}

function obDone(st) {
  obShow("You're signed in", `${st.email || 'Claude account'}${st.plan ? ` · ${st.plan}` : ''}`);
  obButtons([['Continue', obHide, true]]);
}

function obMissingScreen(msg) {
  obShow(
    'Claude Code not found',
    'This app talks to Claude through Claude Code, using your subscription. Install it with the official installer, or locate it yourself.',
    { error: msg || '' },
  );
  obButtons([['Install Claude Code', obInstall, true], ['Locate file…', obLocate], ['Re-check', () => runCheck()], ['Skip for now', obHide]]);
}

function obLoginScreen(msg) {
  obShow('Sign in with Claude', 'Use the Claude account that has your Pro or Max subscription. A browser window will open.', { error: msg || '' });
  obButtons([['Sign in with Claude', obLogin, true], ['Re-check', () => runCheck()], ['Skip for now', obHide]]);
}

async function obInstall() {
  if (!(await window.harness.setup.install())) return;
  $('obLog').textContent = '';
  obShow('Installing Claude Code', 'Running the official installer…', { log: true });
  obButtons([]);
}

async function obLocate() {
  const f = await window.harness.pickFile();
  if (!f) return;
  state.settings.binary = f;
  $('setBinary').value = f;
  save();
  runCheck();
}

async function obLogin() {
  ob.cancelled = false;
  try {
    await window.harness.setup.startLogin(binaryOverride());
  } catch (e) {
    obLoginScreen(String(e.message || e));
    return;
  }
  ob.url = null;
  $('obCodeInput').value = '';
  obShow('Waiting for sign-in', 'Approve access in the browser window, then paste the code shown on that page below.', { code: true });
  obButtons([['Open page again', () => ob.url && window.harness.setup.openUrl(ob.url)], ['Cancel', obCancel]]);
}

function obCancel() {
  ob.cancelled = true;
  window.harness.setup.cancelLogin();
  runCheck();
}

async function obSubmitCode() {
  const v = $('obCodeInput').value.trim();
  if (!v) return;
  if (await window.harness.setup.submitCode(v)) {
    $('obCodeInput').value = '';
    $('obCode').hidden = true;
    $('obText').textContent = 'Checking code…';
  } else {
    obLoginScreen('Sign-in is no longer running. Click Sign in to start again.');
  }
}

window.harness.onSetupEvent(({ kind, event }) => {
  if (kind === 'login') {
    if (event.type === 'url') ob.url = event.url;
    else if (event.type === 'error') obLoginScreen(event.message);
    else if (event.type === 'done') {
      if (ob.cancelled) { ob.cancelled = false; return; }
      window.harness.setup.status(binaryOverride()).then((st) => {
        ob.st = st;
        renderAccount(st);
        if (st.loggedIn) obDone(st);
        else obLoginScreen("That code wasn't accepted. Each code works once, for the link it came from. Click Sign in to get a fresh link and try again.");
      });
    }
  } else if (kind === 'install') {
    if (event.type === 'out') {
      const l = $('obLog');
      l.textContent = (l.textContent + event.text).slice(-4000);
      l.scrollTop = l.scrollHeight;
    } else if (event.type === 'error') obMissingScreen(event.message);
    else if (event.type === 'done') {
      runCheck().then((ok) => {
        if (!ok && ob.st && !ob.st.found) obMissingScreen('The installer finished but Claude Code still was not found. Use "Locate file…" to point to it.');
      });
    }
  }
});

$('obSubmit').addEventListener('click', obSubmitCode);
$('obCodeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); obSubmitCode(); }
});
$('runSetup').addEventListener('click', () => { $('dlg').close(); runCheck(); });

// ---- dock: browser + terminal ---------------------------------------------
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
function renderLayout() {
  const d = state.dock;
  // a saved width may not fit a smaller window; keep room for the chat
  d.width = Math.min(d.width, Math.max(300, window.innerWidth - state.sideWidth - (state.panelOpen ? state.panelWidth : 0) - 320));
  const cols = [`${state.sideWidth}px`, 'minmax(0, 1fr)'];
  if (d.open) cols.push(`${d.width}px`);
  if (state.panelOpen) cols.push(`${state.panelWidth}px`);
  $('app').style.gridTemplateColumns = cols.join(' ');
  $('app').classList.toggle('no-panel', !state.panelOpen);
  $('dock').hidden = !d.open;
  $('browserPane').hidden = d.tab !== 'browser';
  $('termPane').hidden = d.tab !== 'terminal';
  $('toggleBrowser').classList.toggle('on', d.open && d.tab === 'browser');
  $('toggleTerminal').classList.toggle('on', d.open && d.tab === 'terminal');
  $('togglePanel').classList.toggle('on', state.panelOpen);
  syncBrowser();
}

function openDock(tab) {
  const d = state.dock;
  // clicking the button for the pane that's already showing closes the dock
  if (d.open && d.tab === tab) d.open = false;
  else { d.open = true; d.tab = tab; }
  renderLayout();
  save();
  if (d.open && tab === 'terminal') { renderTermBar(); $('termIn').focus(); }
}

// The browser is a native view floating above the page, so it must be moved to sit
// over #browserHost and hidden whenever a dialog or overlay is on screen.
function syncBrowser() {
  const d = state.dock;
  const show = d.open && d.tab === 'browser' && !$('dlg').open && $('onboard').hidden;
  if (show) {
    const r = $('browserHost').getBoundingClientRect();
    window.harness.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  window.harness.browser.setVisible(show);
}

function browserGo(text) {
  const t = text.trim();
  if (!t) return;
  window.harness.browser.go(t);
}

// terminal: one flowing screen, PowerShell-style prompt with the input inline
const term = { running: false, history: [], hi: -1, cwd: null };
const TERM_ID = 'main';
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const termDir = () => term.cwd ?? defaultFolder();
const termPromptText = () => `PS ${termDir() || '~'}>`;

function renderTermBar() {
  $('termPrompt').textContent = termPromptText();
  $('termKill').hidden = !term.running;
  $('termPrompt').hidden = term.running;
  $('termIn').hidden = term.running;
}

function termScroll() {
  const s = $('termScreen');
  s.scrollTop = s.scrollHeight;
}

function termPrint(text, cls) {
  const out = $('termOut');
  if (cls) out.appendChild(el('span', cls, text));
  else out.appendChild(document.createTextNode(text));
  while (out.textContent.length > 200000 && out.firstChild) out.removeChild(out.firstChild);
  termScroll();
}

async function termSubmit(command) {
  if (term.running) return;
  if (!command.trim()) { termPrint(`${termPromptText()}\n`); return; }
  term.history.push(command);
  term.hi = term.history.length;
  termPrint(`${termPromptText()} ${command}\n`);
  term.running = true;
  renderTermBar();
  try {
    await window.harness.term.run({ termId: TERM_ID, command, cwd: termDir() || undefined });
  } catch (e) {
    termPrint(`${String(e.message || e)}\n`, 'bad');
    term.running = false;
    renderTermBar();
  }
}

// drag handle: reports the pointer's x while held
function makeResizer(handle, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('drag');
    const move = (ev) => onMove(ev.clientX);
    const up = () => {
      handle.classList.remove('drag');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

function initDock() {
  const h = window.harness;
  const d = state.dock;
  d.width = clamp(Number(d.width) || 420, 300, 1200);
  state.sideWidth = clamp(Number(state.sideWidth) || 240, 160, 600);
  state.panelWidth = clamp(Number(state.panelWidth) || 250, 200, 600);

  $('toggleBrowser').addEventListener('click', () => openDock('browser'));
  $('toggleTerminal').addEventListener('click', () => openDock('terminal'));
  $('dockClose').addEventListener('click', () => { d.open = false; renderLayout(); save(); });
  $('bClose').addEventListener('click', () => { d.open = false; renderLayout(); save(); });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); openDock('terminal'); }
  });

  // each handle sets its column's width from the pointer, keeping the chat >= 320px
  const MIN_MAIN = 320;
  const used = (skip) =>
    (skip === 'side' ? 0 : state.sideWidth) + (skip === 'dock' || !d.open ? 0 : d.width) + (skip === 'panel' || !state.panelOpen ? 0 : state.panelWidth);
  const fit = (skip, min, want) => clamp(Math.round(want), min, Math.max(min, window.innerWidth - used(skip) - MIN_MAIN));
  makeResizer($('sideResize'), (x) => { state.sideWidth = fit('side', 160, x); renderLayout(); });
  makeResizer($('dockResize'), (x) => { d.width = fit('dock', 300, window.innerWidth - x - (state.panelOpen ? state.panelWidth : 0)); renderLayout(); });
  makeResizer($('panelResize'), (x) => { state.panelWidth = fit('panel', 200, window.innerWidth - x); renderLayout(); });

  new ResizeObserver(syncBrowser).observe($('browserHost'));
  window.addEventListener('resize', syncBrowser);
  $('dlg').addEventListener('close', syncBrowser);

  // browser controls
  $('bBack').addEventListener('click', () => h.browser.nav('back'));
  $('bFwd').addEventListener('click', () => h.browser.nav('forward'));
  $('bReload').addEventListener('click', () => h.browser.nav('reload'));
  $('bExternal').addEventListener('click', () => h.browser.openExternal());
  $('bUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); browserGo($('bUrl').value); e.target.blur(); }
  });
  $('bUrl').addEventListener('focus', (e) => e.target.select());
  h.browser.onState((s) => {
    if (document.activeElement !== $('bUrl')) $('bUrl').value = s.url;
    $('bBack').disabled = !s.canGoBack;
    $('bFwd').disabled = !s.canGoForward;
    $('bReload').textContent = s.loading ? '…' : '↻';
    if (s.url) { d.url = s.url; save(); }
  });
  if (d.url && d.open && d.tab === 'browser') { $('bUrl').value = d.url; h.browser.go(d.url); }

  // terminal
  h.term.onEvent((ev) => {
    if (ev.termId !== TERM_ID) return;
    if (ev.type === 'out') termPrint(stripAnsi(ev.text));
    else if (ev.type === 'exit') {
      if (ev.code) termPrint(`[exit ${ev.code}]\n`, 'bad');
      term.running = false;
      renderTermBar();
      $('termIn').focus();
      termScroll();
    }
  });
  $('termIn').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = $('termIn').value;
      $('termIn').value = '';
      termSubmit(v);
    } else if (e.key === 'ArrowUp' && term.history.length) {
      e.preventDefault();
      term.hi = Math.max(0, term.hi - 1);
      $('termIn').value = term.history[term.hi] ?? '';
    } else if (e.key === 'ArrowDown' && term.history.length) {
      e.preventDefault();
      term.hi = Math.min(term.history.length, term.hi + 1);
      $('termIn').value = term.history[term.hi] ?? '';
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      $('termOut').replaceChildren();
    }
  });
  // Ctrl+C stops a running command (the input is hidden then, so listen on the pane)
  $('termPane').addEventListener('keydown', (e) => {
    if (e.key === 'c' && e.ctrlKey && term.running) h.term.kill(TERM_ID);
  });
  $('termScreen').addEventListener('click', () => {
    if (!getSelection().toString()) $('termIn').focus(); // don't steal focus while selecting output
  });
  $('termKill').addEventListener('click', () => h.term.kill(TERM_ID));
  $('termClear').addEventListener('click', () => { $('termOut').replaceChildren(); $('termIn').focus(); });
  $('termPrompt').addEventListener('click', async (e) => {
    e.stopPropagation();
    const dir = await h.pickFolder();
    if (dir) { term.cwd = dir; renderTermBar(); $('termIn').focus(); }
  });
  renderTermBar();
}

// ---- boot ---------------------------------------------------------------
(async () => {
  const saved = await window.harness.loadState();
  if (saved) {
    state = { ...state, ...saved, settings: { ...state.settings, ...saved.settings } };
    if (!findSession(state.active)) state.active = state.projects[0]?.sessions[0]?.id ?? null;
  }
  adapterList = await window.harness.listAdapters();
  for (const a of adapterList) {
    const o = el('option', null, a.label);
    o.value = a.id;
    $('setAdapter').appendChild(o);
  }
  $('setAdapter').value = state.settings.adapterId;
  if (state.limits?.at && Date.now() - state.limits.at > 7 * 864e5) state.limits = null;
  initDock();
  $('setBinary').value = state.settings.binary;
  $('setTheme').value = state.settings.theme;
  applyTheme();
  appVersion = await window.harness.appVersion();
  showUpdateStatus(updateText);
  const found = await window.harness.detectClaude();
  $('detected').textContent = found ? `Auto-detected: ${found}` : 'No bundled claude.exe found; will try "claude" on PATH.';
  refresh();
  runCheck({ silent: true });
})();
