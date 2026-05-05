#!/usr/bin/env node

import { exec } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import WebSocket from 'ws';

const execAsync = promisify(exec);

type Json = Record<string, unknown>;

interface Stream {
  pty: pty.IPty;
  tmuxName: string;
}

const streams = new Map<string, Stream>();

const termagUrl = process.env.TERMAG_URL;
const token = process.env.TERMAG_AGENT_TOKEN;
const reconnectMs = Number(process.env.TERMAG_RECONNECT_MS || 3000);
const roots = parseRoots(process.env.TERMAG_AGENT_ROOTS);

if (!termagUrl || !token) {
  console.error('TERMAG_URL and TERMAG_AGENT_TOKEN are required.');
  process.exit(1);
}

connect();

function connect() {
  const url = new URL(termagUrl!);
  url.searchParams.set('token', token!);
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`[agent] connected to ${url.origin}${url.pathname}`);
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
          writeInput(msg);
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
          await killTmux(String(msg.tmuxName || ''));
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
    console.log(`[agent] disconnected; reconnecting in ${reconnectMs}ms`);
    for (const streamId of [...streams.keys()]) closeStream(streamId);
    setTimeout(connect, reconnectMs);
  });

  ws.on('error', (err) => {
    console.error(`[agent] ${err.message}`);
  });
}

async function handleAttach(ws: WebSocket, msg: Json) {
  const streamId = String(msg.streamId || '');
  const tmuxName = String(msg.tmuxName || '');
  const spawnCommand = String(msg.spawnCommand || '$SHELL');
  const cols = Number(msg.cols || 80);
  const rows = Number(msg.rows || 24);
  const cwd = resolveCwd(msg.cwd as Json | undefined);

  if (!streamId || !tmuxName) throw new Error('streamId and tmuxName are required');

  await mkdir(cwd, { recursive: true });
  await ensureTmuxSession(tmuxName, cwd, spawnCommand);

  const term = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
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

  streams.set(streamId, { pty: term, tmuxName });

  term.onData((data) => {
    send(ws, { type: 'terminal-data', streamId, data });
  });

  term.onExit(() => {
    streams.delete(streamId);
    send(ws, { type: 'terminal-exit', streamId });
  });
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
    // Already gone.
  }
}

function writeInput(msg: Json) {
  const stream = streams.get(String(msg.streamId || ''));
  const data = typeof msg.data === 'string' ? msg.data : '';
  if (stream && data) stream.pty.write(data);
}

function resize(msg: Json) {
  const stream = streams.get(String(msg.streamId || ''));
  const cols = Number(msg.cols || 0);
  const rows = Number(msg.rows || 0);
  if (stream && cols > 0 && rows > 0) stream.pty.resize(cols, rows);
}

function closeStream(streamId: string) {
  const stream = streams.get(streamId);
  if (!stream) return;
  stream.pty.kill();
  streams.delete(streamId);
}

function resolveCwd(cwd?: Json) {
  const rootKey = String(cwd?.rootKey || Object.keys(roots)[0] || 'WIP');
  const relativePath = String(cwd?.relativePath || '').replace(/^\//, '');
  const root = roots[rootKey];
  if (!root) throw new Error(`Unknown root ${rootKey}`);
  return path.resolve(root, relativePath);
}

function parseRoots(raw?: string): Record<string, string> {
  if (!raw) return { WIP: path.join(os.homedir(), 'WIP') };
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.keys(parsed).length ? parsed : { WIP: path.join(os.homedir(), 'WIP') };
  } catch {
    return { WIP: path.join(os.homedir(), 'WIP') };
  }
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
