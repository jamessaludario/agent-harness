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

function validDir(d) {
  try {
    return typeof d === 'string' && path.isAbsolute(d) && !UNSAFE_PATH.test(d) && fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
}

function buildArgs({ sessionId, permissionMode, model, extraDirs }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (permissionMode) {
    if (!PERMISSION_MODES.has(permissionMode)) throw new Error('Invalid permission mode');
    args.push('--permission-mode', permissionMode);
  }
  if (model) {
    if (!SAFE_TOKEN.test(model)) throw new Error('Invalid model name');
    args.push('--model', model);
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
    case 'result':
      emit({
        type: 'result',
        text: msg.result ?? '',
        isError: !!msg.is_error,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
      });
      break;
    default:
      break;
  }
}

/**
 * Start one turn. Returns { cancel() }.
 * opts: { prompt, cwd, sessionId, permissionMode, model, binary }
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

module.exports = { id, label, run };
