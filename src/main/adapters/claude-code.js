// Claude Code CLI adapter.
// Drives the official `claude` CLI as a subprocess so authentication (Pro/Max
// login or API key) is handled entirely by Claude Code itself. We never touch
// credentials.
//
// Normalized events emitted via onEvent:
//   { type: 'init', sessionId }
//   { type: 'text-delta', text }
//   { type: 'tool-use', id, name, input }
//   { type: 'tool-result', id, content, isError }
//   { type: 'result', text, isError, costUsd, durationMs }
//   { type: 'error', message }
//   { type: 'exit', code }

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const id = 'claude-code';
const label = 'Claude Code (CLI)';

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const SAFE_TOKEN = /^[A-Za-z0-9._:-]+$/; // args are concatenated into a shell line on Windows

const UNSAFE_PATH = /["&|<>^%\r\n]/; // could break out of a shell command line on Windows

function validFile(f) {
  try {
    return typeof f === 'string' && path.isAbsolute(f) && !UNSAFE_PATH.test(f) && fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

function validDir(d) {
  try {
    return typeof d === 'string' && path.isAbsolute(d) && !UNSAFE_PATH.test(d) && fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
}

// What the UI may offer for this agent ('' = let the CLI choose).
const models = [
  { id: '', label: 'Default model' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
];
const efforts = [
  { id: '', label: 'Default effort' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];
const EFFORTS = new Set(efforts.map((e) => e.id).filter(Boolean));

// "Tool" or "Tool(pattern)", e.g. PowerShell(gh *). Kept strict because args may reach a Windows shell line.
const TOOL_RULE = /^[A-Za-z][A-Za-z0-9_]*(\([A-Za-z0-9 _.:\/\\*@=+-]{1,120}\))?$/;

function buildArgs({ sessionId, permissionMode, model, effort, extraDirs, memoryFile, allowedTools, mcpConfigFile }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (memoryFile) {
    // memory bank text lives in a file so it never touches the command line
    if (!validFile(memoryFile)) throw new Error('Memory file is missing or has unsupported characters');
    args.push('--append-system-prompt-file', memoryFile);
  }
  if (permissionMode) {
    if (!PERMISSION_MODES.has(permissionMode)) throw new Error('Invalid permission mode');
    args.push('--permission-mode', permissionMode);
  }
  if (model) {
    if (!SAFE_TOKEN.test(model)) throw new Error('Invalid model name');
    args.push('--model', model);
  }
  if (mcpConfigFile) {
    if (!validFile(mcpConfigFile)) throw new Error('MCP config file is missing or has unsupported characters');
    args.push('--mcp-config', mcpConfigFile);
  }
  if (Array.isArray(allowedTools) && allowedTools.length) {
    // Headless runs cannot ask for approval, so anything not pre-allowed is simply denied.
    const rules = [...new Set(allowedTools.map((r) => String(r).trim()).filter(Boolean))].slice(0, 100);
    for (const r of rules) if (!TOOL_RULE.test(r)) throw new Error(`Invalid allowed-command rule: ${r}`);
    if (rules.length) args.push('--allowedTools', rules.join(','));
  }
  if (effort) {
    if (!EFFORTS.has(effort)) throw new Error('Invalid effort level');
    args.push('--effort', effort);
  }
  if (sessionId) {
    if (!SAFE_TOKEN.test(sessionId)) throw new Error('Invalid session id');
    args.push('--resume', sessionId);
  }
  // Extra folders the agent may read/edit besides the working directory.
  for (const d of extraDirs ?? []) {
    if (!validDir(d)) throw new Error(`Folder is missing or has unsupported characters: ${d}`);
    args.push('--add-dir', d);
  }
  return args;
}

function normalize(msg, state, emit) {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init' && msg.session_id) emit({ type: 'init', sessionId: msg.session_id });
      break;
    case 'stream_event': {
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        state.streamedText = true;
        emit({ type: 'text-delta', text: ev.delta.text });
      }
      break;
    }
    case 'assistant': {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'tool_use') {
          emit({ type: 'tool-use', id: block.id, name: block.name, input: block.input });
        } else if (block.type === 'text' && !state.streamedText) {
          emit({ type: 'text-delta', text: block.text });
        }
      }
      state.streamedText = false;
      break;
    }
    case 'user': {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const text = Array.isArray(block.content)
              ? block.content.map((c) => c.text ?? '').join('')
              : String(block.content ?? '');
            emit({ type: 'tool-result', id: block.tool_use_id, content: text, isError: !!block.is_error });
          }
        }
      }
      break;
    }
    case 'rate_limit_event': {
      // Plan usage as reported by Claude Code itself (no credentials touched).
      const i = msg.rate_limit_info;
      if (i && typeof i === 'object') {
        // unifiedWindows: { five_hour: { utilization (0-1), resetsAt (epoch s) }, seven_day: {...} }
        const windows = {};
        for (const [k, w] of Object.entries(i.unifiedWindows ?? {})) {
          if (w && typeof w.utilization === 'number') {
            windows[k] = { utilization: w.utilization, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null };
          }
        }
        emit({ type: 'rate-limit', status: String(i.status ?? ''), windows });
      }
      break;
    }
    case 'result':
      emit({
        type: 'result',
        text: msg.result ?? '',
        isError: !!msg.is_error,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        // tools the CLI refused because nobody could approve them in a headless run
        denials: (Array.isArray(msg.permission_denials) ? msg.permission_denials : []).slice(0, 20).map((d) => ({
          tool: String(d.tool_name ?? ''),
          command: typeof d.tool_input?.command === 'string' ? d.tool_input.command.slice(0, 300) : '',
          target: String(d.tool_input?.file_path ?? d.tool_input?.url ?? d.tool_input?.path ?? '').slice(0, 300),
        })),
      });
      break;
    default:
      break;
  }
}

/**
 * Start one turn. Returns { cancel() }.
 * opts: { prompt, cwd, sessionId, permissionMode, model, effort, binary }
 */
function run(opts, onEvent) {
  const binary = opts.binary || 'claude';
  const useShell = process.platform === 'win32' && !/\.exe$/i.test(binary);
  // A real .exe needs no shell. Only .cmd/.bat shims or a bare PATH lookup do;
  // there, args are validated and quoted when they contain spaces.
  // The user prompt goes over stdin, never the command line.
  const args = buildArgs(opts).map((a) => (useShell && /\s/.test(a) ? `"${a}"` : a));
  const child = spawn(binary, args, {
    cwd: opts.cwd || process.cwd(),
    env: cliEnv(),
    shell: useShell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const state = { streamedText: false };
  let buffer = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        normalize(JSON.parse(line), state, onEvent);
      } catch {
        // ignore non-JSON noise
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderr += c));

  child.on('error', (err) => {
    const hint =
      err.code === 'ENOENT'
        ? `Could not find "${binary}". Install Claude Code and sign in (run \`claude\` once), or set the binary path in the toolbar.`
        : err.message;
    onEvent({ type: 'error', message: hint });
  });

  child.on('close', (code) => {
    if (code !== 0 && stderr.trim()) {
      onEvent({ type: 'error', message: stderr.trim().slice(-2000) });
    }
    onEvent({ type: 'exit', code });
  });

  child.stdin.write(opts.prompt);
  child.stdin.end();

  return {
    cancel() {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    },
  };
}

/**
 * Environment for the CLI. On Windows, Claude Code checks PowerShell commands by launching a parser
 * with a 5 s limit; a cold PowerShell start inside this app can exceed that, and the command is then
 * rejected as "malformed syntax". Give it more time unless the user already set a value.
 */
function cliEnv() {
  return { ...process.env, CLAUDE_CODE_PWSH_PARSE_TIMEOUT_MS: process.env.CLAUDE_CODE_PWSH_PARSE_TIMEOUT_MS || '30000' };
}

/**
 * One-shot, tool-less question to a (cheap) model. Resolves with the reply text.
 * Used by the memory bank to distill lessons and condense skills.
 */
function ask({ prompt, model = 'claude-haiku-5-5', binary, cwd, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const bin = binary || 'claude';
    const useShell = process.platform === 'win32' && !/\.exe$/i.test(bin);
    if (!SAFE_TOKEN.test(model)) return reject(new Error('Invalid model name'));
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--model', model, '--tools', useShell ? '""' : ''];
    const child = spawn(bin, args, { cwd: cwd || process.cwd(), shell: useShell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().slice(-500) || `exit ${code}`));
      try {
        resolve(String(JSON.parse(out).result ?? ''));
      } catch {
        resolve(out);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

module.exports = { id, label, models, efforts, run, ask };
