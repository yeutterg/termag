#!/usr/bin/env node

import { exec } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const execAsync = promisify(exec);

type Json = Record<string, unknown>;
type PtyModule = typeof import('node-pty');

interface RealStream {
  kind: 'real';
  pty: ReturnType<PtyModule['spawn']>;
  tmuxName: string;
}

interface FakeStream {
  kind: 'fake';
  timer: ReturnType<typeof setInterval>;
  tmuxName: string;
}

type Stream = RealStream | FakeStream;

const streams = new Map<string, Stream>();
const isFake = process.env.TERMAG_AGENT_FAKE === 'true';
const tag = isFake ? 'fake-agent' : 'agent';

const termagUrl = process.env.TERMAG_URL || (isFake ? 'ws://localhost:3000/api/ws/agent' : undefined);
const token = process.env.TERMAG_AGENT_TOKEN
  || process.env.TERMAG_PREVIEW_AGENT_TOKEN
  || (isFake ? 'tmag_preview_local_agent_token' : undefined);
const baseReconnectMs = Number(process.env.TERMAG_RECONNECT_MS || 1000);
const maxReconnectMs = Number(process.env.TERMAG_RECONNECT_MAX_MS || 30000);
const roots = parseRoots(process.env.TERMAG_AGENT_ROOTS);

if (!termagUrl || !token) {
  console.error('TERMAG_URL and TERMAG_AGENT_TOKEN are required.');
  process.exit(1);
}

let reconnectAttempts = 0;

function nextReconnectDelay() {
  const delay = baseReconnectMs * 2 ** Math.min(reconnectAttempts, 6);
  return Math.min(maxReconnectMs, delay);
}

// node-pty is a native module; load it lazily so fake mode runs on machines
// that can't compile it.
let ptyModule: PtyModule | null = null;
function getPty(): PtyModule {
  if (!ptyModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty') as PtyModule;
  }
  return ptyModule;
}

connect();

function connect() {
  const url = new URL(termagUrl!);
  url.searchParams.set('token', token!);
  const ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectAttempts = 0;
    console.log(`[${tag}] connected to ${url.origin}${url.pathname}`);
  });

  ws.on('message', async (raw) => {
    let msg: Json;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
    const type = String(msg.type || '');

    try {
      switch (type) {
        case 'terminal-attach':
          await handleAttach(ws, msg);
          respond(ws, requestId, { ok: true });
          break;
        case 'terminal-input':
          writeInput(ws, msg);
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        case 'terminal-resize':
          resize(msg);
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        case 'terminal-close':
          closeStream(String(msg.streamId || ''));
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        case 'tmux-kill':
          if (!isFake) await killTmux(String(msg.tmuxName || ''));
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        case 'hello':
          break;
        default:
          if (requestId) respond(ws, requestId, null, `Unknown command: ${type}`);
      }
    } catch (err) {
      if (requestId) respond(ws, requestId, null, err instanceof Error ? err.message : String(err));
    }
  });

  ws.on('close', () => {
    const delay = nextReconnectDelay();
    reconnectAttempts += 1;
    console.log(`[${tag}] disconnected; reconnecting in ${delay}ms`);
    for (const streamId of [...streams.keys()]) closeStream(streamId);
    setTimeout(connect, delay);
  });

  ws.on('error', (err) => {
    console.error(`[${tag}] ${err.message}`);
  });
}

async function handleAttach(ws: WebSocket, msg: Json) {
  return isFake ? handleAttachFake(ws, msg) : handleAttachReal(ws, msg);
}

async function handleAttachReal(ws: WebSocket, msg: Json) {
  const streamId = String(msg.streamId || '');
  const tmuxName = String(msg.tmuxName || '');
  const spawnCommand = String(msg.spawnCommand || '$SHELL');
  const cols = Number(msg.cols || 80);
  const rows = Number(msg.rows || 24);
  const cwd = resolveCwd(msg.cwd as Json | undefined);

  if (!streamId || !tmuxName) throw new Error('streamId and tmuxName are required');

  await mkdir(cwd, { recursive: true });
  await ensureTmuxSession(tmuxName, cwd, spawnCommand);

  closeStream(streamId);

  const term = getPty().spawn('tmux', ['attach-session', '-t', tmuxName], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      HOME: os.homedir(),
      USER: os.userInfo().username,
      SHELL: process.env.SHELL || '/bin/zsh'
    }
  });

  streams.set(streamId, { kind: 'real', pty: term, tmuxName });

  term.onData((data) => {
    send(ws, { type: 'terminal-data', streamId, data });
  });

  term.onExit(() => {
    streams.delete(streamId);
    send(ws, { type: 'terminal-exit', streamId });
  });
}

function handleAttachFake(ws: WebSocket, msg: Json) {
  const streamId = String(msg.streamId || '');
  const kind = String(msg.kind || 'agent');
  const tmuxName = String(msg.tmuxName || 'termag-preview');
  const cwd = msg.cwd as { rootKey?: string; relativePath?: string } | undefined;
  if (!streamId) return;

  closeStream(streamId);

  send(ws, {
    type: 'terminal-data',
    streamId,
    data: `\r\n[fake-agent] attached ${kind} ${tmuxName}\r\n[fake-agent] cwd ${cwd?.rootKey || 'WIP'}/${cwd?.relativePath || ''}\r\n$ `
  });

  let tick = 0;
  const lines = [
    'reading project context',
    'checking git status',
    'streaming terminal output',
    'waiting for browser input',
    'writing preview scrollback'
  ];
  const timer = setInterval(() => {
    tick += 1;
    send(ws, {
      type: 'terminal-data',
      streamId,
      data: `\r\n[fake-agent] ${new Date().toLocaleTimeString()} ${lines[tick % lines.length]}\r\n$ `
    });
  }, 3500);
  streams.set(streamId, { kind: 'fake', timer, tmuxName });
}

async function ensureTmuxSession(tmuxName: string, cwd: string, command: string) {
  try {
    await execAsync(`tmux has-session -t ${sh(tmuxName)} 2>/dev/null`);
    return;
  } catch {
    const shellCommand = command === '$SHELL' ? (process.env.SHELL || '/bin/zsh') : command;
    await execAsync(`tmux new-session -d -s ${sh(tmuxName)} -c ${sh(cwd)} -x 120 -y 32 ${sh(shellCommand)}`);
    await execAsync(`tmux set-option -t ${sh(tmuxName)} -w window-size largest`);
    await execAsync(`tmux set-option -t ${sh(tmuxName)} history-limit 10000`);
  }
}

async function killTmux(tmuxName: string) {
  if (!tmuxName) return;
  try {
    await execAsync(`tmux kill-session -t ${sh(tmuxName)}`);
  } catch {
    // already gone
  }
}

function writeInput(ws: WebSocket, msg: Json) {
  const streamId = String(msg.streamId || '');
  const stream = streams.get(streamId);
  const data = typeof msg.data === 'string' ? msg.data : '';
  if (!stream || !data) return;
  if (stream.kind === 'real') {
    stream.pty.write(data);
    return;
  }
  // Fake mode: echo input back so the browser sees something happen.
  const printable = data.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(//g, 'Esc');
  send(ws, { type: 'terminal-data', streamId, data: `${data}\r\n[fake-agent] received input: ${printable}\r\n$ ` });
}

function resize(msg: Json) {
  const stream = streams.get(String(msg.streamId || ''));
  if (!stream || stream.kind !== 'real') return;
  const cols = Number(msg.cols || 0);
  const rows = Number(msg.rows || 0);
  if (cols > 0 && rows > 0) stream.pty.resize(cols, rows);
}

function closeStream(streamId: string) {
  const stream = streams.get(streamId);
  if (!stream) return;
  streams.delete(streamId);
  if (stream.kind === 'real') {
    try {
      stream.pty.kill();
    } catch {
      // already gone
    }
  } else {
    clearInterval(stream.timer);
  }
}

function resolveCwd(cwd?: Json) {
  const rootKey = String(cwd?.rootKey || Object.keys(roots)[0] || 'WIP');
  const relativePath = String(cwd?.relativePath || '').replace(/^\//, '');
  const root = roots[rootKey];
  if (!root) throw new Error(`Unknown root ${rootKey}`);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes root ${rootKey}`);
  }
  return resolvedPath;
}

function parseRoots(raw?: string): Record<string, string> {
  const fallback = { WIP: path.join(os.homedir(), 'WIP') };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.keys(parsed).length
      ? Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, expandRoot(value)]))
      : fallback;
  } catch {
    return fallback;
  }
}

function expandRoot(root: string) {
  if (root === '~') return os.homedir();
  if (root.startsWith('~/')) return path.join(os.homedir(), root.slice(2));
  if (root === '$HOME') return os.homedir();
  if (root.startsWith('$HOME/')) return path.join(os.homedir(), root.slice(6));
  return root;
}

function respond(ws: WebSocket, requestId: string | undefined, data: unknown, error?: string) {
  if (!requestId) return;
  send(ws, error ? { requestId, error } : { requestId, data });
}

function send(ws: WebSocket, msg: Json) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sh(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
