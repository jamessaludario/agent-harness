// Files pane: tabbed viewer on the left (rendered markdown, images, syntax-highlighted code with
// line numbers) and a folder tree on the right with a filter, content search and git markers.
// Also makes file names in chat clickable. Loaded after renderer.js and shares its globals.

(() => {
  const api = window.harness.files;
  const MAX_TABS = 8;
  const MAX_ROWS = 8000; // longest file shown as per-line rows
  const tabs = []; // { path, name, data, mode }
  let active = -1;
  let rootIdx = 0;
  let treeShown = true;
  let git = { files: {}, untrackedDirs: [], changedDirs: [] };
  let sideW = 0;
  let widened = null; // dock width to return to
  let filterTimer = 0;
  const expanded = new Set();
  const resolved = new Map(); // "base|candidate" -> real path (positive results only)

  const dirname = (p) => p.replace(/[\\/][^\\/]*$/, '');
  const lc = (p) => String(p).toLowerCase();
  const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function roots() {
    const f = state.active ? findSession(state.active) : null;
    const folder = f ? f.p.path : defaultFolder();
    return [folder, ...(f?.s.extraDirs ?? [])].filter(Boolean);
  }
  const currentRoot = () => roots()[rootIdx] || '';

  // ---- file type glyphs and git markers ------------------------------------------------
  const GLYPH = { py: '‹›', js: '‹›', ts: '‹›', tsx: '‹›', jsx: '‹›', mjs: '‹›', html: '‹›', css: '‹›', sh: '‹›', ps1: '‹›', json: '{}', yml: '{}', yaml: '{}', toml: '{}', md: '▤', txt: '▤', csv: '▦', png: '▣', jpg: '▣', jpeg: '▣', gif: '▣', webp: '▣', svg: '▣', zip: '▥', gz: '▥' };
  const extOf = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');
  const glyph = (n) => GLYPH[extOf(n)] || '▫';

  function gitCode(p) {
    if (git.files[p]) return git.files[p];
    return git.untrackedDirs.some((d) => lc(p).startsWith(`${lc(d)}\\`) || lc(p).startsWith(`${lc(d)}/`) || lc(p) === lc(d)) ? 'U' : '';
  }
  const dirChanged = (p) => git.changedDirs.some((d) => lc(d) === lc(p)) || git.untrackedDirs.some((d) => lc(d) === lc(p));

  // ---- showing / hiding the pane ------------------------------------------------------------
  function showFiles() {
    const d = state.dock;
    if (!(d.open && d.tab === 'files')) {
      d.open = true;
      d.tab = 'files';
      if (d.width < 640) d.width = 720; // viewer + file list need room (clamped to the window by renderLayout)
      renderLayout();
      save();
    }
    buildTree();
  }

  const applySide = () => {
    if (sideW) $('fSide').style.width = `${sideW}px`;
    $('fSide').hidden = !treeShown;
  };

  // ---- tree ------------------------------------------------------------------------------------
  function fillRoots() {
    const r = roots();
    const sel = $('fRoot');
    if (rootIdx >= r.length) rootIdx = 0;
    sel.replaceChildren(...r.map((p, i) => Object.assign(el('option', null, baseName(p)), { value: String(i), title: p })));
    sel.value = String(rootIdx);
    sel.hidden = r.length < 2;
    return r;
  }

  function fileRow(e, depth) {
    const row = el('div', 'f-row');
    row.style.paddingLeft = `${10 + depth * 14}px`;
    row.title = e.path;
    if (e.dir) {
      row.append(el('span', 'f-chev', expanded.has(e.path) ? '▾' : '▸'), el('span', 'ellipsis', e.name));
      if (dirChanged(e.path)) row.append(el('span', 'f-dot', '●'));
    } else {
      const code = gitCode(e.path);
      const ic = el('span', `f-ic t-${extOf(e.name) || 'x'}`, glyph(e.name));
      const name = el('span', `ellipsis${code && code !== 'D' ? ' chg' : ''}`, e.name);
      row.append(ic, name);
      if (code) row.append(el('span', `f-git g-${code}`, code));
      if (tabs[active]?.path === e.path) row.classList.add('on');
    }
    return row;
  }

  async function renderDir(parent, dir, depth) {
    let res;
    try {
      res = await api.list(dir, roots());
    } catch (e) {
      parent.appendChild(el('div', 'f-note', cleanErr(e)));
      return;
    }
    for (const e of res.entries) {
      const row = fileRow(e, depth);
      parent.appendChild(row);
      if (e.dir) {
        const box = el('div');
        parent.appendChild(box);
        if (expanded.has(e.path)) await renderDir(box, e.path, depth + 1);
        row.addEventListener('click', async () => {
          if (expanded.has(e.path)) {
            expanded.delete(e.path);
            box.replaceChildren();
            row.firstChild.textContent = '▸';
          } else {
            expanded.add(e.path);
            row.firstChild.textContent = '▾';
            await renderDir(box, e.path, depth + 1);
          }
        });
      } else {
        row.addEventListener('click', () => openFile(e.path));
      }
    }
    if (res.truncated) parent.appendChild(el('div', 'f-note', 'Only the first entries are shown. Use the filter to find the rest.'));
  }

  async function buildTree() {
    const r = fillRoots();
    applySide();
    const tree = $('fTree');
    if (!r.length) {
      tree.replaceChildren(el('div', 'f-note', 'Pick a folder for this session to browse its files.'));
      return;
    }
    if ($('fFilter').value.trim()) return runFilter();
    try {
      git = await api.git(r[rootIdx], roots());
    } catch {
      git = { files: {}, untrackedDirs: [], changedDirs: [] };
    }
    const box = el('div');
    await renderDir(box, r[rootIdx], 0);
    tree.replaceChildren(box);
  }

  // ---- filter: names, or "?text" to search inside files ------------------------------------------
  function relTo(root, p) {
    return lc(p).startsWith(lc(root)) ? p.slice(root.length).replace(/^[\\/]/, '') : p;
  }

  async function runFilter() {
    const raw = $('fFilter').value.trim();
    const tree = $('fTree');
    if (!raw) return buildTree();
    const root = currentRoot();
    const box = el('div');
    tree.replaceChildren(el('div', 'f-note', raw.startsWith('?') ? 'Searching…' : 'Looking…'));
    try {
      if (raw.startsWith('?')) {
        const q = raw.slice(1).trim();
        if (q.length < 2) return tree.replaceChildren(el('div', 'f-note', 'Type at least 2 characters to search inside files.'));
        const res = await api.search(root, q, roots());
        if ($('fFilter').value.trim() !== raw) return; // superseded by newer typing
        let lastFile = '';
        for (const h of res.hits) {
          if (h.path !== lastFile) {
            lastFile = h.path;
            box.appendChild(el('div', 'f-hit-file ellipsis', relTo(root, h.path)));
          }
          const row = el('div', 'f-hit');
          row.title = `${h.path}:${h.line}`;
          row.append(el('span', 'f-hit-ln', String(h.line)), el('span', 'ellipsis', h.text));
          row.addEventListener('click', () => openFile(h.path, h.line));
          box.appendChild(row);
        }
        if (!res.hits.length) box.appendChild(el('div', 'f-note', 'No matches.'));
        else if (res.capped) box.appendChild(el('div', 'f-note', 'Showing the first matches only.'));
      } else {
        const found = await api.find(root, raw, roots());
        if ($('fFilter').value.trim() !== raw) return;
        for (const e of found) {
          const row = fileRow({ ...e, path: e.path }, 0);
          row.style.paddingLeft = '10px';
          const rel = relTo(root, e.path);
          row.lastChild?.classList.contains('f-git') || row.append(el('span', 'f-sub ellipsis', rel.includes('\\') || rel.includes('/') ? dirname(rel) : ''));
          row.addEventListener('click', () => {
            if (e.dir) {
              // reveal the folder in the normal tree
              for (let d = e.path; lc(d).startsWith(lc(root)) && d.length > root.length; d = dirname(d)) expanded.add(d);
              $('fFilter').value = '';
              buildTree();
            } else openFile(e.path);
          });
          box.appendChild(row);
        }
        if (!found.length) box.appendChild(el('div', 'f-note', 'Nothing matches.'));
      }
    } catch (e) {
      box.appendChild(el('div', 'f-note', cleanErr(e)));
    }
    tree.replaceChildren(box);
  }

  // ---- tabs & viewer ---------------------------------------------------------------------------------
  async function openFile(p, line) {
    showFiles();
    let i = tabs.findIndex((t) => lc(t.path) === lc(p));
    if (i < 0) {
      try {
        const data = await api.read(p, roots());
        if (tabs.length >= MAX_TABS) closeTab(active === 0 ? 1 : 0);
        tabs.push({ path: data.path, name: data.name, data, mode: data.ext === '.md' || data.ext === '.markdown' ? 'rendered' : 'source' });
        i = tabs.length - 1;
        api.watch(data.path, roots());
      } catch (e) {
        alert(cleanErr(e));
        return;
      }
    }
    active = i;
    if (line) tabs[i].mode = 'source'; // a search hit points at a line, so show the text
    renderTabs();
    renderView(line);
    highlightTree();
  }

  function closeTab(i) {
    if (i < 0 || i >= tabs.length) return;
    api.unwatch(tabs[i].path);
    tabs.splice(i, 1);
    if (active >= tabs.length) active = tabs.length - 1;
    else if (i < active) active -= 1;
    renderTabs();
    renderView();
    highlightTree();
  }

  function renderTabs() {
    const bar = $('fTabs');
    bar.replaceChildren();
    tabs.forEach((t, i) => {
      const b = el('div', `fx-tab${i === active ? ' on' : ''}`);
      b.title = t.path;
      b.append(el('span', 'ellipsis', t.name));
      const x = el('button', 'x shown', '×');
      x.type = 'button';
      x.title = 'Close';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(i); });
      b.appendChild(x);
      b.addEventListener('click', () => { active = i; renderTabs(); renderView(); highlightTree(); });
      bar.appendChild(b);
    });
  }

  function highlightTree() {
    document.querySelectorAll('#fTree .f-row').forEach((r) => r.classList.toggle('on', !!tabs[active] && lc(r.title) === lc(tabs[active].path)));
  }

  function crumb(p) {
    const r = roots().find((x) => lc(p).startsWith(lc(x)));
    const rel = r ? relTo(r, p) : p;
    return rel.split(/[\\/]/).join('  \\  ');
  }

  function codeView(d, line) {
    const rows = d.text.split(/\r?\n/);
    const wrap = el('div', 'f-lines');
    const tokens = rows.length <= MAX_ROWS ? window.highlightCode?.(d.text, d.ext) : null;
    for (let i = 0; i < Math.min(rows.length, MAX_ROWS); i++) {
      const row = el('div', 'f-line');
      row.dataset.n = String(i + 1);
      row.appendChild(el('span', 'f-g', String(i + 1)));
      const code = el('span', 'f-c');
      if (tokens?.[i]?.length) for (const t of tokens[i]) code.appendChild(t.c ? el('span', `tk-${t.c}`, t.s) : document.createTextNode(t.s));
      else code.textContent = rows[i] || ' ';
      row.appendChild(code);
      wrap.appendChild(row);
    }
    if (rows.length > MAX_ROWS) wrap.appendChild(el('div', 'f-note', `Showing the first ${MAX_ROWS} lines of ${rows.length}.`));
    if (d.truncated) wrap.appendChild(el('div', 'f-note', 'File is large; showing the first part only.'));
    if (line) {
      const target = wrap.children[Math.min(line, MAX_ROWS) - 1];
      if (target) {
        target.classList.add('hit');
        requestAnimationFrame(() => target.scrollIntoView({ block: 'center' }));
      }
    }
    return wrap;
  }

  function renderView(line) {
    const view = $('fView');
    const t = tabs[active];
    $('fBar').hidden = !t;
    if (!t) {
      view.replaceChildren(el('div', 'f-empty muted', 'Click a file in the list, or a file name in the chat, to preview it here.'));
      return;
    }
    $('fPath').textContent = crumb(t.path);
    $('fPath').title = t.path;
    const d = t.data;
    const isMd = d.kind === 'text' && (d.ext === '.md' || d.ext === '.markdown');
    $('fmMode').hidden = !isMd;
    $('fmMode').firstChild.textContent = t.mode === 'rendered' ? 'View source' : 'View rendered';

    if (d.kind === 'text' && isMd && t.mode === 'rendered') {
      const box = el('div', 'msg assistant f-md');
      renderMarkdown(box, d.text);
      view.replaceChildren(box);
      linkifyFiles(box, dirname(t.path));
    } else if (d.kind === 'text') {
      view.replaceChildren(codeView(d, line));
    } else if (d.kind === 'image') {
      const img = el('img', 'f-img');
      img.alt = d.name;
      img.src = d.dataUrl;
      view.replaceChildren(img);
    } else {
      view.replaceChildren(el('div', 'f-empty muted', d.kind === 'toolarge' ? 'This file is too large to preview.' : 'No preview for this kind of file. Use Reveal in folder (⋯) to open its location.'));
    }
  }

  async function reloadTab(p) {
    const i = tabs.findIndex((t) => lc(t.path) === lc(p));
    if (i < 0) return;
    try {
      tabs[i].data = await api.read(tabs[i].path, roots());
    } catch {
      return; // briefly missing while being rewritten
    }
    if (i === active) {
      const v = $('fView');
      const top = v.scrollTop;
      renderView();
      v.scrollTop = top;
    }
  }

  // ---- file links in chat / rendered markdown -------------------------------------------------------
  /** Marks path-looking inline code and markdown links that point at real files as clickable. */
  async function linkifyFiles(root, base = '') {
    const nodes = [...root.querySelectorAll('[data-cand]')];
    if (!nodes.length) return;
    const cands = [...new Set(nodes.map((n) => n.dataset.cand))].filter((c) => !resolved.has(`${base}|${c}`));
    if (cands.length) {
      let out = [];
      try {
        out = await api.resolve(cands, roots(), base);
      } catch {
        out = [];
      }
      cands.forEach((c, i) => out[i] && resolved.set(`${base}|${c}`, out[i]));
    }
    for (const n of nodes) {
      const p = resolved.get(`${base}|${n.dataset.cand}`);
      if (p) {
        n.dataset.file = p;
        n.classList.add('file-link');
        n.title = `Open ${baseName(p)} in Files`;
      } else if (n.tagName === 'A') {
        n.classList.add('file-missing');
        n.title = 'File not found';
      }
    }
  }

  document.addEventListener('click', (e) => {
    const n = e.target.closest?.('.file-link[data-file]');
    if (!n) {
      if (!e.target.closest?.('#fMoreMenu, #fMore')) $('fMoreMenu').hidden = true;
      return;
    }
    e.preventDefault();
    openFile(n.dataset.file);
  });

  // ---- wiring -------------------------------------------------------------------------------------------
  const closeDock = () => { state.dock.open = false; renderLayout(); save(); };
  $('toggleFiles').addEventListener('click', () => {
    const d = state.dock;
    if (d.open && d.tab === 'files') closeDock();
    else showFiles();
  });
  $('fClose').addEventListener('click', closeDock);
  $('fSearch').addEventListener('click', () => {
    treeShown = true;
    applySide();
    $('fFilter').focus();
  });
  $('fCollapse').addEventListener('click', () => { expanded.clear(); $('fFilter').value = ''; buildTree(); });
  $('fToggleTree').addEventListener('click', () => { treeShown = !treeShown; applySide(); });
  $('fFilter').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(runFilter, 250);
  });
  $('fFilter').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('fFilter').value = ''; buildTree(); }
  });
  $('fRoot').addEventListener('change', (e) => { rootIdx = Number(e.target.value) || 0; buildTree(); });

  $('fMore').addEventListener('click', (e) => {
    e.stopPropagation();
    $('fMoreMenu').hidden = !$('fMoreMenu').hidden;
  });
  $('fmRefresh').addEventListener('click', () => { $('fMoreMenu').hidden = true; buildTree(); tabs.forEach((t) => reloadTab(t.path)); });
  $('fmMode').addEventListener('click', () => {
    $('fMoreMenu').hidden = true;
    const t = tabs[active];
    if (!t) return;
    t.mode = t.mode === 'rendered' ? 'source' : 'rendered';
    renderView();
  });
  $('fmReveal').addEventListener('click', () => { $('fMoreMenu').hidden = true; if (tabs[active]) window.harness.reveal(tabs[active].path); });
  $('fmCopy').addEventListener('click', async () => {
    $('fMoreMenu').hidden = true;
    if (tabs[active]) try { await navigator.clipboard.writeText(tabs[active].path); } catch { /* clipboard unavailable */ }
  });

  $('fExpand').addEventListener('click', () => {
    const d = state.dock;
    if (widened) { d.width = widened; widened = null; } else { widened = d.width; d.width = 5000; } // renderLayout clamps to the window
    renderLayout();
    save();
  });

  makeResizer($('fSideResize'), (x) => {
    const r = $('filesPane').getBoundingClientRect();
    sideW = Math.min(Math.max(Math.round(r.right - x), 150), Math.max(150, r.width - 240));
    state.filesSide = sideW;
    applySide();
  });
  sideW = Number(state.filesSide) || 230;

  api.onChanged((p) => reloadTab(p));

  // session/folder switches rebuild the tree; open tabs stay until closed
  let lastRoots = '';
  window.onRefresh = () => {
    const key = roots().join('|');
    if (key === lastRoots) return;
    lastRoots = key;
    rootIdx = 0;
    expanded.clear();
    $('fFilter').value = '';
    if (state.dock.open && state.dock.tab === 'files') buildTree();
  };

  window.openFileInPane = openFile;
  window.linkifyFiles = linkifyFiles;
  applySide();
  renderView();
  if (state.dock.open && state.dock.tab === 'files') buildTree();
})();
