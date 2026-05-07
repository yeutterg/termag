#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { type Stream, attachReal, attachFake, killTmux } from './streams';

const execFileAsync = promisify(execFile);

type Json = Record<string, unknown>;

const isFake = process.env.TERMAG_AGENT_FAKE === 'true';
const tag = isFake ? 'fake-agent' : 'agent';

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 60_000;

const streams = new Map<string, Stream>();

let pkgVersion = '0.0.0';
try {
  // CJS build: __dirname is the directory containing the compiled JS file.
  // We walk one level up to find package.json next to dist/.
  const pkgPath = path.join(__dirname, '..', 'package.json');
  pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.0.0';
} catch {
  // running without package.json available; version reporting falls back to 0.0.0
}

const subcommand = process.argv[2];
if (subcommand === 'update') {
  void runUpdate();
} else if (subcommand === '--version' || subcommand === '-v') {
  console.log(pkgVersion);
  process.exit(0);
} else if (subcommand === '--help' || subcommand === '-h') {
  printHelp();
  process.exit(0);
} else {
  void run();
}

function printHelp() {
  console.log(`termag-agent ${pkgVersion}

Usage:
  termag-agent              connect to the broker and serve sessions (default)
  termag-agent update       upgrade the agent in place (auto-detects npm vs brew)
  termag-agent --version    print version
  termag-agent --help       show this message

Environment:
  TERMAG_URL                wss://… or ws://localhost… of /api/ws/agent
  TERMAG_AGENT_TOKEN        bearer token created in the web Settings dialog
  TERMAG_AGENT_ROOTS        JSON map of named roots, e.g. {"WIP":"~/WIP"}
  TERMAG_RECONNECT_MS       initial reconnect delay (default 1000)
  TERMAG_RECONNECT_MAX_MS   max reconnect delay (default 30000)
`);
}

async function runUpdate() {
  const here = __filename;
  const installedViaBrew = /\/Cellar\/|\/homebrew\//i.test(here);
  if (installedViaBrew) {
    console.log('[agent] detected brew install — running: brew upgrade termag-agent');
    spawn('brew', ['upgrade', 'termag-agent'], { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1));
  } else {
    console.log('[agent] running: npm install -g @termag/agent');
    spawn('npm', ['install', '-g', '@termag/agent'], { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1));
  }
}

async function run() {
  const termagUrl = process.env.TERMAG_URL || (isFake ? 'ws://localhost:3000/api/ws/agent' : undefined);
  const token = process.env.TERMAG_AGENT_TOKEN
    || process.env.TERMAG_PREVIEW_AGENT_TOKEN
    || (isFake ? 'tmag_preview_local_agent_token' : undefined);

  if (!termagUrl || !token) {
    console.error('TERMAG_URL and TERMAG_AGENT_TOKEN are required.');
    process.exit(1);
  }

  let validatedUrl: URL;
  try {
    validatedUrl = validateUrl(termagUrl);
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  await preflightTmux();

  connect(validatedUrl, token);
}

// Reject ws:// for non-localhost. A misconfigured TERMAG_URL or DNS poisoning
// would otherwise leak the agent token to whoever's at the other end. wss is
// always allowed; ws is only allowed when pointed at the local machine.
function validateUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`TERMAG_URL must be ws:// or wss:// (got ${url.protocol})`);
  }
  if (url.protocol === 'ws:') {
    const host = url.hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!local) {
      throw new Error(`TERMAG_URL must use wss:// for non-localhost hosts (got ${host}). Use a TLS reverse proxy or an SSH tunnel for the broker.`);
    }
  }
  return url;
}

async function preflightTmux() {
  if (isFake) return;
  let stdout: string;
  try {
    const result = await execFileAsync('tmux', ['-V']);
    stdout = result.stdout;
  } catch {
    console.error(`[${tag}] tmux is not installed. Install it first: brew install tmux  /  apt install tmux  /  dnf install tmux`);
    process.exit(1);
  }
  const match = /tmux\s+(\d+)\.(\d+)/.exec(stdout);
  if (!match) {
    console.warn(`[${tag}] could not parse tmux version: ${stdout.trim()} — continuing anyway`);
    return;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 7)) {
    console.error(`[${tag}] tmux ${major}.${minor} is too old. Install tmux 2.7+ (resize-window requires 2.7).`);
    process.exit(1);
  }
}

const baseReconnectMs = positiveNumber(process.env.TERMAG_RECONNECT_MS, 1000);
const maxReconnectMs = positiveNumber(process.env.TERMAG_RECONNECT_MAX_MS, 30000);
const roots = parseRoots(process.env.TERMAG_AGENT_ROOTS);
let reconnectAttempts = 0;

function positiveNumber(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nextReconnectDelay() {
  const delay = baseReconnectMs * 2 ** Math.min(reconnectAttempts, 6);
  return Math.min(maxReconnectMs, delay);
}

function connect(validatedUrl: URL, token: string) {
  const url = new URL(validatedUrl.toString());
  url.searchParams.set('token', token);
  const ws = new WebSocket(url);

  // Heartbeat: ping every 30s, expect pong within PONG_TIMEOUT. Silent NAT
  // drops, dropped wifi without RST, and idle proxies all leave a websocket
  // looking "open" forever — the close handler never fires. The ping/pong
  // round-trip detects that case so we can force a reconnect.
  let lastPongAt = Date.now();
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  ws.on('open', () => {
    reconnectAttempts = 0;
    lastPongAt = Date.now();
    console.log(`[${tag}] connected to ${validatedUrl.origin}${validatedUrl.pathname} (v${pkgVersion})`);

    pingTimer = setInterval(() => {
      if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        console.warn(`[${tag}] no pong in ${PONG_TIMEOUT_MS}ms — terminating dead connection`);
        try { ws.terminate(); } catch { /* already gone */ }
        return;
      }
      try { ws.ping(); } catch { /* socket already in error state */ }
    }, PING_INTERVAL_MS);

    // Health: periodic structured snapshot the broker can surface in Settings.
    // The broker silently ignores unknown message types today, so this is
    // forward-compat scaffolding the web UI can start consuming whenever.
    sendHealth(ws);
    healthTimer = setInterval(() => sendHealth(ws), HEALTH_INTERVAL_MS);
  });

  ws.on('pong', () => {
    lastPongAt = Date.now();
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
        case 'terminal-attach': {
          await handleAttach(ws, msg);
          respond(ws, requestId, { ok: true });
          break;
        }
        case 'terminal-input': {
          writeInput(msg);
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        }
        case 'terminal-resize': {
          resizeStream(msg);
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        }
        case 'terminal-close': {
          closeStream(String(msg.streamId || ''));
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        }
        case 'tmux-kill': {
          if (!isFake) await killTmux(String(msg.tmuxName || ''));
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        }
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
    clearTimers();
    const delay = nextReconnectDelay();
    reconnectAttempts += 1;
    console.log(`[${tag}] disconnected; reconnecting in ${delay}ms`);
    // Tear down our local stream readers — the tmux sessions themselves stay
    // alive on disk so the next agent connection can re-attach to them.
    for (const stream of [...streams.values()]) {
      stream.close();
    }
    streams.clear();
    setTimeout(() => connect(validatedUrl, token), delay);
  });

  ws.on('error', (err) => {
    console.error(`[${tag}] ${err.message}`);
  });
}

function sendHealth(ws: WebSocket) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  ws.send(JSON.stringify({
    type: 'health',
    streamCount: streams.size,
    uptimeSec: Math.floor(process.uptime()),
    memMb,
    version: pkgVersion,
    fake: isFake
  }));
}

async function handleAttach(ws: WebSocket, msg: Json) {
  const streamId = String(msg.streamId || '');
  if (!streamId) throw new Error('streamId is required');

  // Replace any existing stream for this streamId — the broker re-issues
  // attach on reconnect.
  const existing = streams.get(streamId);
  if (existing) {
    existing.close();
    streams.delete(streamId);
  }

  if (isFake) {
    const stream = attachFake({
      ws,
      streamId,
      tmuxName: String(msg.tmuxName || 'termag-preview'),
      kind: String(msg.kind || 'agent'),
      cwd: (msg.cwd as { rootKey?: string; relativePath?: string } | undefined) || {}
    });
    streams.set(streamId, stream);
    return;
  }

  const tmuxName = String(msg.tmuxName || '');
  const spawnCommand = String(msg.spawnCommand || '$SHELL');
  const cols = Number(msg.cols || 80);
  const rows = Number(msg.rows || 24);
  const cwd = resolveCwd(msg.cwd as Json | undefined);
  if (!tmuxName) throw new Error('tmuxName is required');

  const stream = await attachReal({ ws, streamId, tmuxName, cwd, spawnCommand, cols, rows });
  streams.set(streamId, stream);
}

function writeInput(msg: Json) {
  const stream = streams.get(String(msg.streamId || ''));
  const data = typeof msg.data === 'string' ? msg.data : '';
  if (stream && data) stream.write(data);
}

function resizeStream(msg: Json) {
  const stream = streams.get(String(msg.streamId || ''));
  if (!stream) return;
  const cols = Number(msg.cols || 0);
  const rows = Number(msg.rows || 0);
  stream.resize(cols, rows);
}

function closeStream(streamId: string) {
  const stream = streams.get(streamId);
  if (!stream) return;
  streams.delete(streamId);
  stream.close();
}

function resolveCwd(cwd?: Json) {
  const rootKey = String(cwd?.rootKey || Object.keys(roots)[0] || 'WIP');
  const relativePath = String(cwd?.relativePath || '').replace(/^\/+/, '');
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
    const entries = Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
      .map(([key, value]) => [key, expandRoot(value)]);
    return entries.length ? Object.fromEntries(entries) : fallback;
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
  if (!requestId || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(error ? { requestId, error } : { requestId, data }));
}

// Clean shutdown: kill our local readers but leave the tmux sessions alive
// so the next agent process can pick them up.
function shutdown() {
  for (const stream of [...streams.values()]) stream.close();
  streams.clear();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
