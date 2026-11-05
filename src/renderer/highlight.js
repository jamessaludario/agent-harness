// Small regex-based syntax highlighter for the Files pane. Produces tokens only (the caller
// builds DOM nodes), so file contents can never inject markup. Not a full parser: it covers
// comments, strings, numbers, keywords, function/class names and JSON keys well enough to read.

(() => {
  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
  const PY = words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case');
  const JS = words('as async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield interface type enum implements public private protected readonly declare namespace abstract');
  const SH = words('if then else elif fi for while do done case esac function in return export local echo cd exit set unset source alias param begin end foreach switch break continue try catch finally Write-Host Write-Output');
  const CONST = words('True False None true false null undefined NaN Infinity self this');

  const LANGS = {
    py: { kw: PY, line: '#', strings: "py" },
    js: { kw: JS, line: '//', block: true, strings: 'js' },
    json: { kw: new Set(), json: true, strings: 'json' },
    sh: { kw: SH, line: '#', strings: 'json' },
    yaml: { kw: new Set(), line: '#', keys: true, strings: 'json' },
    css: { kw: new Set(), block: true, strings: 'json', css: true },
    html: { kw: new Set(), markup: true, strings: 'json' },
  };
  const BY_EXT = {
    '.py': 'py', '.pyw': 'py',
    '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js',
    '.json': 'json', '.jsonc': 'json',
    '.sh': 'sh', '.bash': 'sh', '.ps1': 'sh', '.bat': 'sh', '.cmd': 'sh',
    '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'yaml', '.ini': 'yaml', '.cfg': 'yaml', '.env': 'yaml', '.gitignore': 'yaml',
    '.css': 'css', '.scss': 'css',
    '.html': 'html', '.htm': 'html', '.xml': 'html', '.svg': 'html', '.vue': 'html',
  };

  function ruleFor(lang) {
    const parts = [];
    if (lang.markup) parts.push('<!--[\\s\\S]*?-->');
    if (lang.block) parts.push('\\/\\*[\\s\\S]*?\\*\\/');
    if (lang.line === '//') parts.push('\\/\\/[^\\n]*');
    if (lang.line === '#') parts.push('#[^\\n]*');
    const q = { py: `(?:[rRbBfFuU]{0,2})(?:"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|"(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*')`,
      js: '`(?:\\\\[\\s\\S]|[^`\\\\])*`|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'',
      json: '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'' }[lang.strings];
    parts.push(q);
    return new RegExp(`(${parts.slice(0, -1).join('|') || '(?!)'})|(${q})|(\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)|(<\\/?[A-Za-z][\\w:-]*|\\/?>)|([A-Za-z_$][\\w$-]*)`, 'g');
  }

  const cache = new Map();

  /** @returns {{c: string, s: string}[][]} lines of tokens, or null when the type is not highlighted */
  function highlight(text, ext) {
    const key = BY_EXT[String(ext || '').toLowerCase()];
    const lang = LANGS[key];
    if (!lang) return null;
    if (!cache.has(key)) cache.set(key, ruleFor(lang));
    const re = cache.get(key);
    re.lastIndex = 0;
    const tokens = [];
    let last = 0;
    let prev = '';
    const push = (c, s) => s && tokens.push({ c, s });
    for (let m; (m = re.exec(text)); ) {
      push('', text.slice(last, m.index));
      const s = m[0];
      let cls = '';
      if (m[1]) cls = 'com';
      else if (m[2]) {
        cls = 'str';
        // JSON / YAML keys: a string followed by a colon
        if ((lang.json || lang.keys) && /^\s*:/.test(text.slice(m.index + s.length, m.index + s.length + 3))) cls = 'key';
      } else if (m[3]) cls = 'num';
      else if (m[4]) cls = lang.markup ? 'kw' : '';
      else if (m[5]) {
        if (CONST.has(s)) cls = 'const';
        else if (lang.kw.has(s)) cls = 'kw';
        else if (prev === 'def' || prev === 'function') cls = 'fn';
        else if (prev === 'class') cls = 'cls';
        else if (lang.keys && text[m.index + s.length] === ':' ) cls = 'key';
        else if (text[m.index + s.length] === '(' && !lang.markup) cls = 'fn';
        prev = s;
      }
      if (!m[5]) prev = '';
      push(cls, s);
      last = m.index + s.length;
    }
    push('', text.slice(last));

    // split into lines (comments/strings can span several)
    const lines = [[]];
    for (const t of tokens) {
      const bits = t.s.split('\n');
      bits.forEach((b, i) => {
        if (i) lines.push([]);
        if (b) lines[lines.length - 1].push({ c: t.c, s: b.replace(/\r$/, '') });
      });
    }
    return lines;
  }

  window.highlightCode = highlight;
})();
