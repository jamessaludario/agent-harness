// Slash commands in the composer. Skills from the memory bank become /skill-name;
// a few built-ins (/memory, /new) sit alongside. Loaded after memory.js.

(() => {
  const slug = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const menu = $('slashMenu');
  const prompt = $('prompt');
  let items = [];
  let index = 0;

  const builtins = [
    { name: 'memory', desc: 'Open the memory bank', run: () => window.__mem?.open() },
    { name: 'new', desc: 'Start a new session', run: () => startDraft() },
  ];

  // skills visible in the current project (global ones, or limited to this folder)
  function skillCommands() {
    const here = (state.active ? findSession(state.active)?.p.path : defaultFolder()) || '';
    const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    const seen = new Set(builtins.map((b) => b.name));
    const out = [];
    for (const e of window.__mem?.skills() ?? []) {
      if (e.scope && norm(e.scope) !== norm(here)) continue;
      const name = slug(e.title);
      if (!name || seen.has(name)) continue; // never shadow a built-in or an earlier skill
      seen.add(name);
      out.push({ name, desc: e.description || e.body.slice(0, 80), skill: { id: e.id, name } });
    }
    return out;
  }

  const allCommands = () => [...skillCommands(), ...builtins];

  /** Called by send(): handles built-ins, or tells it which skill the message invokes. */
  window.resolveSlash = (text) => {
    const m = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!m) return null;
    const cmd = allCommands().find((c) => c.name === m[1].toLowerCase());
    if (!cmd) return null; // unknown: sent as ordinary text
    if (cmd.run) {
      cmd.run();
      return { handled: true };
    }
    return { skill: cmd.skill, args: (m[2] || '').trim() };
  };

  function close() {
    menu.hidden = true;
    items = [];
  }

  function choose(cmd) {
    prompt.value = `/${cmd.name} `;
    close();
    prompt.focus();
    prompt.dispatchEvent(new Event('input')); // let the composer resize
  }

  function draw() {
    menu.replaceChildren();
    items.forEach((c, i) => {
      const b = el('button', `menu-item slash-item${i === index ? ' active' : ''}`);
      b.type = 'button';
      b.append(el('span', 'slash-name', `/${c.name}`), el('span', 'slash-desc ellipsis', c.desc));
      b.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the textarea
        choose(c);
      });
      menu.appendChild(b);
    });
    menu.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function update() {
    // only while typing the command word itself: "/", "/dra"
    const m = /^\/([a-z0-9-]*)$/i.exec(prompt.value);
    if (!m) return close();
    const q = m[1].toLowerCase();
    items = allCommands().filter((c) => c.name.includes(q)).sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)));
    if (!items.length) return close();
    index = Math.min(index, items.length - 1);
    menu.hidden = false;
    draw();
  }

  prompt.addEventListener('input', () => {
    index = 0;
    update();
  });
  prompt.addEventListener('blur', () => setTimeout(close, 100));

  // capture phase: run before the composer's own Enter-to-send handler
  prompt.addEventListener(
    'keydown',
    (e) => {
      if (menu.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        draw();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(items[index]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    },
    true,
  );
})();
