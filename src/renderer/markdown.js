// Small, safe markdown renderer for assistant messages. Builds DOM nodes only
// (never innerHTML), so model output cannot inject markup or script.
// Supports: headings, paragraphs, bold/italic/strike, inline code, fenced code
// (with copy button), bullet/numbered lists (nested), blockquotes, tables,
// horizontal rules and http(s) links. Tolerates half-streamed input.

(function () {
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // something/that/looks/like/a/file.ext (no spaces); the Files pane checks whether it really exists
  const PATH_LIKE = /^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?[\w.@~+-]+(?:[\\/][\w.@~+-]+)*\.[A-Za-z0-9]{1,8}$/;
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n][^\n]*?\*\*)|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*?\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"])/g;

  function link(parent, label, href, plain) {
    const a = mk('a', 'md-link');
    a.dataset.href = href; // opened via the app, never navigated in place
    a.title = href;
    a.setAttribute('role', 'link');
    a.tabIndex = 0;
    if (plain) a.textContent = label; // a bare URL's label is the URL itself
    else inline(a, label);
    parent.appendChild(a);
  }

  function inline(parent, text) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const s = m[0];
      if (m[1]) {
        const code = parent.appendChild(mk('code', null, s.slice(1, -1)));
        if (PATH_LIKE.test(code.textContent)) code.dataset.cand = code.textContent;
      }
      else if (m[2]) inline(parent.appendChild(mk('strong')), s.slice(2, -2));
      else if (m[3]) inline(parent.appendChild(mk('del')), s.slice(2, -2));
      else if (m[4]) inline(parent.appendChild(mk('em')), s.slice(1, -1));
      else if (m[5]) {
        const close = s.indexOf('](');
        const label = s.slice(1, close);
        const target = s.slice(close + 2, -1);
        if (/^https?:\/\//i.test(target)) link(parent, label, target);
        else if (/^file:/i.test(target) || (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))) {
          // a link to a file on disk: opened in the Files pane when it exists
          const a = mk('a', 'md-link');
          a.dataset.cand = target;
          inline(a, label);
          parent.appendChild(a);
        } else parent.appendChild(document.createTextNode(label)); // other schemes stay inert text
      } else link(parent, s, s, true);
      last = m.index + s.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // paragraph text keeps single newlines as line breaks
  function inlineLines(parent, lines) {
    lines.forEach((line, i) => {
      if (i) parent.appendChild(mk('br'));
      inline(parent, line);
    });
  }

  function codeBlock(lang, body) {
    const wrap = mk('div', 'md-code');
    const head = mk('div', 'md-code-head');
    head.appendChild(mk('span', null, lang || 'text'));
    const copy = mk('button', 'md-copy', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(body);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Failed';
      }
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    });
    head.appendChild(copy);
    wrap.append(head, mk('pre', null, body));
    return wrap;
  }

  const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function table(lines) {
    const head = cells(lines[0]);
    const aligns = cells(lines[1]).map((c) => (/^:-*:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
    const t = mk('table', 'md-table');
    // a table whose header row is empty (key/value style) gets no header bar
    const thead = head.some(Boolean) ? t.appendChild(mk('thead')).appendChild(mk('tr')) : null;
    head.forEach((h, i) => {
      const th = mk('th');
      if (aligns[i]) th.style.textAlign = aligns[i];
      inline(th, h);
      thead?.appendChild(th);
    });
    const tbody = t.appendChild(mk('tbody'));
    for (const row of lines.slice(2)) {
      const tr = tbody.appendChild(mk('tr'));
      cells(row).forEach((c, i) => {
        const td = mk('td');
        if (aligns[i]) td.style.textAlign = aligns[i];
        inline(td, c);
        tr.appendChild(td);
      });
    }
    // columns that only hold short values (IDs, verdicts, types) never wrap; long text columns do
    const cols = Math.max(head.length, ...lines.slice(2).map((r) => cells(r).length));
    for (let c = 0; c < cols; c++) {
      const col = [...t.rows].map((r) => r.cells[c]).filter(Boolean);
      if (col.every((cell) => cell.textContent.length <= 18)) col.forEach((cell) => cell.classList.add('nw'));
    }
    const scroll = mk('div', 'md-table-wrap');
    scroll.appendChild(t);
    return scroll;
  }

  function list(lines) {
    const root = mk(/^\s*\d/.test(lines[0].replace(/^\s*/, '')) ? 'ol' : 'ul');
    const stack = [{ indent: LIST.exec(lines[0])[1].length, el: root }];
    let item = null;
    for (const raw of lines) {
      const m = LIST.exec(raw);
      if (!m) {
        // continuation of the current item
        if (item && raw.trim()) {
          item.appendChild(mk('br'));
          inline(item, raw.trim());
        }
        continue;
      }
      const indent = m[1].length;
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
      let top = stack[stack.length - 1];
      if (indent > top.indent && item) {
        const sub = mk(/\d/.test(m[2]) ? 'ol' : 'ul');
        item.appendChild(sub);
        top = { indent, el: sub };
        stack.push(top);
      }
      item = top.el.appendChild(mk('li'));
      const task = /^\[( |x|X)\]\s+/.exec(m[3]);
      if (task) {
        const box = mk('input');
        box.type = 'checkbox';
        box.disabled = true;
        box.checked = task[1] !== ' ';
        item.appendChild(box);
        inline(item, m[3].slice(task[0].length));
      } else inline(item, m[3]);
    }
    return root;
  }

  function render(target, text) {
    const frag = document.createDocumentFragment();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++; // closing fence (absent while streaming)
        frag.appendChild(codeBlock(fence[1], body.join('\n')));
        continue;
      }
      const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        inline(frag.appendChild(mk('h' + Math.min(h[1].length + 1, 5), 'md-h')), h[2]);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { frag.appendChild(mk('hr')); i++; continue; }
      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
        const q = frag.appendChild(mk('blockquote'));
        render(q, body.join('\n'));
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]) && !isTableSep(line)) {
        const rows = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(lines[i++]);
        frag.appendChild(table(rows));
        continue;
      }
      if (LIST.test(line)) {
        const block = [];
        const first = LIST.exec(line);
        const kind = (m) => (/\d/.test(m[2]) ? 'ol' : 'ul');
        // a top-level item of the other kind (bullets vs numbers) starts a new list
        const sameList = (l) => {
          const m = LIST.exec(l);
          return !m || m[1].length !== first[1].length || kind(m) === kind(first);
        };
        while (i < lines.length) {
          if (LIST.test(lines[i])) {
            if (!sameList(lines[i])) break;
            block.push(lines[i++]);
          } else if (lines[i].trim() && /^\s+/.test(lines[i]) && block.length) block.push(lines[i++]);
          else if (!lines[i].trim() && i + 1 < lines.length && LIST.test(lines[i + 1]) && sameList(lines[i + 1])) i++;
          else break;
        }
        frag.appendChild(list(block));
        continue;
      }
      const para = [lines[i++]]; // always consume one line so odd input can't stall the loop
      while (
        i < lines.length && lines[i].trim() &&
        !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !LIST.test(lines[i]) && !/^\s*>/.test(lines[i])
      ) para.push(lines[i++]);
      inlineLines(frag.appendChild(mk('p')), para);
    }
    target.replaceChildren(frag);
  }

  window.renderMarkdown = render;
})();
