// Memory bank UI. Loaded after renderer.js and shares its globals ($, el, state, save, syncBrowser).

(() => {
  const TYPE_LABELS = { rule: 'Rule', standard: 'Standard', decision: 'Decision', preference: 'Preference', note: 'Note', skill: 'Skill' };
  const TABS = [
    ['all', 'All'],
    ['rule', 'Rules'],
    ['standard', 'Standards'],
    ['decision', 'Decisions'],
    ['preference', 'Preferences'],
    ['note', 'Notes'],
    ['skill', 'Skills'],
    ['review', 'Review'],
  ];
  const LEARN_HELP = {
    off: 'Nothing is learned automatically.',
    suggest:
      'When a message states something lasting ("always…", "never…", "from now on…", "we use…"), it is queued under Review. Free, but can be noisy.',
    smart:
      'Same trigger, then Haiku decides whether it is a durable rule and how confident it is (at least 70% to be queued). Uses a little of your plan on those messages only.',
  };

  let data = { settings: { learning: 'suggest' }, entries: [], criteria: {} };
  let tab = 'all';
  let editing = null; // entry being edited, or {} for a new one
  let toastEntry = null;

  const api = () => window.harness.memory;
  const projectPath = () => (state.active ? findSession(state.active)?.p.path : defaultFolder()) || '';

  async function reload() {
    data = await api().list();
    renderBadge();
    if ($('memDlg').open) render();
  }

  function pendingCount() {
    return data.entries.filter((e) => e.status === 'pending').length;
  }

  function renderBadge() {
    const n = pendingCount();
    $('memBadge').hidden = !n;
    $('memBadge').textContent = String(n);
  }

  function scopeLabel(e) {
    return e.scope ? baseName(e.scope) : 'All projects';
  }

  function renderTabs() {
    const box = $('memTabs');
    box.replaceChildren();
    for (const [key, label] of TABS) {
      const count = key === 'review' ? pendingCount() : key === 'all' ? data.entries.filter((e) => e.status === 'active').length : data.entries.filter((e) => e.status === 'active' && e.type === key).length;
      const b = el('button', `mem-tab${tab === key ? ' on' : ''}`, `${label}${count ? ` ${count}` : ''}`);
      b.type = 'button';
      b.addEventListener('click', () => {
        tab = key;
        closeForm();
        render();
      });
      box.appendChild(b);
    }
  }

  function chip(text, cls) {
    return el('span', `chip-sm${cls ? ` ${cls}` : ''}`, text);
  }

  function card(e) {
    const c = el('div', `mem-card${e.enabled || e.status === 'pending' ? '' : ' off'}`);
    const top = el('div', 'mem-card-top');
    top.append(el('span', 'mem-title ellipsis', e.title));
    top.append(chip(TYPE_LABELS[e.type]), chip(scopeLabel(e), 'scope'));
    if (e.source === 'learned') top.append(chip('learned', 'learned'));
    if (e.stale) top.append(chip('unused', 'stale'));
    c.appendChild(top);
    if (e.description) c.appendChild(el('div', 'mem-desc muted', e.description));
    const body = el('div', 'mem-body', e.body);
    c.appendChild(body);

    const row = el('div', 'mem-actions');
    if (e.status === 'pending') {
      if (typeof e.confidence === 'number') row.append(el('span', 'muted', `confidence ${Math.round(e.confidence * 100)}%`));
      row.append(el('span', 'spacer'));
      const accept = el('button', 'primary-sm', 'Remember');
      accept.type = 'button';
      accept.addEventListener('click', async () => { await api().resolve(e.id, true); reload(); });
      const edit = el('button', 'ghost-sm', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => openForm({ ...e, resolveOnSave: true }));
      const no = el('button', 'ghost-sm', 'Dismiss');
      no.type = 'button';
      no.addEventListener('click', async () => { await api().resolve(e.id, false); reload(); });
      row.append(no, edit, accept);
    } else {
      const label = el('label', 'switch');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = e.enabled;
      cb.addEventListener('change', async () => { await api().toggle(e.id, cb.checked); reload(); });
      label.append(cb, el('span', 'knob'), el('span', 'muted', cb.checked ? 'On' : 'Off'));
      row.append(label);
      if (e.uses) row.append(el('span', 'muted', `used ${e.uses}×`));
      row.append(el('span', 'spacer'));
      if (e.type === 'skill' && e.body.length > 2500) {
        const cond = el('button', 'ghost-sm', 'Condense');
        cond.type = 'button';
        cond.title = 'Shorten this skill with Haiku so it fits the memory budget (the original text is replaced)';
        cond.addEventListener('click', async () => {
          cond.disabled = true;
          cond.textContent = 'Condensing…';
          try { await api().condense(e.id); } catch (err) { alert(String(err.message || err)); }
          reload();
        });
        row.append(cond);
      }
      const edit = el('button', 'ghost-sm', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => openForm(e));
      const del = el('button', 'ghost-sm danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete "${e.title}"?`)) return;
        await api().remove(e.id);
        reload();
      });
      row.append(edit, del);
    }
    c.appendChild(row);
    return c;
  }

  function render() {
    renderTabs();
    $('memLearn').value = data.settings.learning;
    $('memLearnHelp').textContent = LEARN_HELP[data.settings.learning] || '';
    const list = $('memList');
    list.replaceChildren();
    const items = data.entries.filter((e) => (tab === 'review' ? e.status === 'pending' : e.status === 'active' && (tab === 'all' || e.type === tab)));
    if (!items.length) {
      const msg =
        tab === 'review'
          ? 'Nothing to review. Suggestions from your messages show up here.'
          : 'Nothing here yet. Use + Add for a rule, standard or decision, or Import skill… to turn a SKILL.md into memory.';
      list.appendChild(el('div', 'mem-empty muted', msg));
    }
    for (const e of items) list.appendChild(card(e));
  }

  // ---- add / edit form ------------------------------------------------------
  function fillScopes(current) {
    const sel = $('mfScope');
    sel.replaceChildren();
    const add = (value, label) => {
      const o = el('option', null, label);
      o.value = value;
      sel.appendChild(o);
    };
    add('', 'All projects');
    const proj = projectPath();
    if (proj) add(proj, `Only ${baseName(proj)}`);
    if (current && current !== proj) add(current, `Only ${baseName(current)}`);
    sel.value = current ?? '';
  }

  function openForm(e = {}) {
    editing = e;
    $('mfType').value = e.type || (tab !== 'all' && tab !== 'review' ? tab : 'rule');
    $('mfTitle').value = e.title || '';
    $('mfBody').value = e.body || '';
    $('mfBody').placeholder = $('mfType').value === 'skill' ? 'Paste the skill text (a SKILL.md with name/description front matter works)' : 'What should the agent remember?';
    fillScopes(e.scope ?? '');
    $('mfError').hidden = true;
    $('memForm').hidden = false;
    $('memList').hidden = true;
    $('mfTitle').focus();
  }

  function closeForm() {
    editing = null;
    $('memForm').hidden = true;
    $('memList').hidden = false;
  }

  $('mfType').addEventListener('change', () => {
    $('mfBody').placeholder = $('mfType').value === 'skill' ? 'Paste the skill text (a SKILL.md with name/description front matter works)' : 'What should the agent remember?';
  });

  $('memForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const entry = {
      ...(editing?.id ? { id: editing.id, description: editing.description } : {}),
      type: $('mfType').value,
      title: $('mfTitle').value.trim(),
      body: $('mfBody').value.trim(),
      scope: $('mfScope').value,
      enabled: editing?.enabled !== false,
      source: editing?.source,
    };
    if (!entry.body) {
      $('mfError').textContent = 'Add some content first.';
      $('mfError').hidden = false;
      return;
    }
    try {
      const saved = await api().save(entry);
      if (editing?.resolveOnSave) await api().resolve(saved.id, true);
      closeForm();
      await reload();
    } catch (err) {
      $('mfError').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      $('mfError').hidden = false;
    }
  });
  $('mfCancel').addEventListener('click', closeForm);
  $('memAdd').addEventListener('click', () => openForm({}));

  $('memSkill').addEventListener('click', async () => {
    try {
      const skill = await api().importSkill();
      if (!skill) return;
      tab = 'skill';
      render();
      openForm({ type: 'skill', title: skill.title, description: skill.description, body: skill.body, source: 'skill', scope: '' });
    } catch (err) {
      alert(String(err.message || err));
    }
  });

  $('memLearn').addEventListener('change', async (e) => {
    await api().setLearning(e.target.value);
    reload();
  });

  // ---- open / close ---------------------------------------------------------
  async function openDialog(startTab) {
    if (startTab) tab = startTab;
    closeForm();
    await reload();
    if (!$('memDlg').open) $('memDlg').showModal();
    render();
    syncBrowser();
  }
  $('memoryBtn').addEventListener('click', () => openDialog());
  $('memClose').addEventListener('click', () => $('memDlg').close());
  $('memDlg').addEventListener('close', syncBrowser);

  // ---- toast for freshly learned suggestions -----------------------------------
  const hideToast = () => { $('memToast').hidden = true; toastEntry = null; };
  api().onLearned((entry) => {
    toastEntry = entry;
    $('memToastText').textContent = `Remember this? “${entry.body.length > 90 ? `${entry.body.slice(0, 90)}…` : entry.body}”`;
    $('memToast').hidden = false;
    reload();
  });
  $('memToastReview').addEventListener('click', () => { hideToast(); openDialog('review'); });
  $('memToastClose').addEventListener('click', hideToast);

  reload();
})();
