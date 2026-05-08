#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import WebSocket from 'ws';
import { type Stream, attachReal, attachFake, killTmuxSession, killTmuxWindow, renameTmuxWindow } from './streams';

const execFileAsync = promisify(execFile);

type Json = Record<string, unknown>;

const isFake = process.env.TERMAG_AGENT_FAKE === 'true';
const tag = isFake ? 'fake-agent' : 'agent';
const insecureLocalTls = process.env.TERMAG_TLS_INSECURE_SKIP_VERIFY === 'true';

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
} else if (subcommand === 'connect') {
  void runConnect(process.argv.slice(3));
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
  termag-agent connect      publish current tmux window/session to the web UI
  termag-agent update       upgrade the agent in place (auto-detects npm vs brew)
  termag-agent --version    print version
  termag-agent --help       show this message

Environment:
  TERMAG_URL                wss://… or ws://localhost… of /api/ws/agent
  TERMAG_AGENT_TOKEN        bearer token created in the web New Device dialog
  TERMAG_AGENT_ROOTS        JSON map of device labels to roots, e.g. {"Mac Mini":"~/Code"}
  TERMAG_TLS_INSECURE_SKIP_VERIFY
                            allow self-signed localhost TLS only (default false)
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
    console.log('[agent] running: npm install -g termag-agent');
    spawn('npm', ['install', '-g', 'termag-agent'], { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1));
  }
}

type ConnectArgs = {
  projectName: string;
  tabName?: string;
  mode: 'window' | 'session';
};

type TmuxWindowInfo = {
  index: number;
  id: string;
  name: string;
  target: string;
  path: string;
};

type TmuxContext = {
  sessionName: string;
  sessionPath: string;
  currentWindow: TmuxWindowInfo;
  windows: TmuxWindowInfo[];
};

async function runConnect(args: string[]) {
  let parsedArgs: ConnectArgs;
  try {
    parsedArgs = parseConnectArgs(args);
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? err.message : String(err)}`);
    printConnectHelp();
    process.exit(1);
  }

  const termagUrl = process.env.TERMAG_URL;
  const token = process.env.TERMAG_AGENT_TOKEN || process.env.TERMAG_PREVIEW_AGENT_TOKEN;
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

  let tmux: TmuxContext;
  try {
    tmux = await detectTmuxContext();
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const windows = parsedArgs.mode === 'session'
    ? tmux.windows
    : [{
      ...tmux.currentWindow,
      name: parsedArgs.tabName || tmux.currentWindow.name
    }];

  const publishUrl = publishUrlFromAgentUrl(validatedUrl);
  try {
    const result = await postJson(
      publishUrl,
      token,
      {
        projectName: parsedArgs.projectName,
        tmuxSessionName: tmux.sessionName,
        path: tmux.currentWindow.path || tmux.sessionPath,
        windows: windows.map((window) => ({
          name: window.name,
          target: window.target,
          windowName: window.id || window.name,
          ordinal: window.index
        }))
      },
      insecureLocalTls && publishUrl.protocol === 'https:' && isLocalHost(publishUrl.hostname)
    );
    const tabCount = Array.isArray(result?.tabs) ? result.tabs.length : windows.length;
    console.log(`[${tag}] published ${parsedArgs.mode === 'session' ? 'session' : 'window'} "${tmux.sessionName}" to project "${parsedArgs.projectName}" (${tabCount} tab${tabCount === 1 ? '' : 's'}).`);
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function parseConnectArgs(args: string[]): ConnectArgs {
  let projectName = '';
  let tabName = '';
  let mode: 'window' | 'session' = 'window';
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printConnectHelp();
      process.exit(0);
    }
    if (arg === '--session') {
      mode = 'session';
      continue;
    }
    if (arg === '--window') {
      mode = 'window';
      continue;
    }
    if (arg === '--project' || arg === '-p') {
      projectName = requiredFlagValue(arg, args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--tab' || arg === '-t') {
      tabName = requiredFlagValue(arg, args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--project=')) {
      projectName = arg.slice('--project='.length);
      continue;
    }
    if (arg.startsWith('--tab=')) {
      tabName = arg.slice('--tab='.length);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown connect option: ${arg}`);
    positional.push(arg);
  }

  if (!projectName && positional.length > 0) projectName = positional.shift() || '';
  if (!tabName && positional.length > 0) tabName = positional.shift() || '';
  projectName = projectName.trim();
  tabName = tabName.trim();
  if (!projectName) throw new Error('connect requires --project <name>');
  return { projectName, tabName: tabName || undefined, mode };
}

function requiredFlagValue(flag: string, value: string | undefined) {
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function printConnectHelp() {
  console.log(`termag-agent connect

Usage:
  termag-agent connect --project <name> [--tab <name>]
  termag-agent connect --project <name> --session
  termag-agent connect <name> [tab-name]

Publishes the current tmux window, or every window in the current tmux
session with --session, to the Termag web UI. Run this from inside tmux.
`);
}

const TMUX_FIELD_SEPARATOR = '\x1f';

async function detectTmuxContext(): Promise<TmuxContext> {
  if (!process.env.TMUX) {
    throw new Error('termag-agent connect must run inside tmux. Start or attach tmux first, then rerun connect.');
  }

  const currentFormat = [
    '#{session_name}',
    '#{session_path}',
    '#{window_index}',
    '#{window_id}',
    '#{window_name}',
    '#{pane_current_path}'
  ].join(TMUX_FIELD_SEPARATOR);
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', currentFormat]);
  const [sessionName = '', sessionPath = '', rawWindowIndex = '0', windowId = '', windowName = '', panePath = ''] = stdout.trimEnd().split(TMUX_FIELD_SEPARATOR);
  if (!sessionName || !windowId) throw new Error('Could not detect current tmux session/window.');

  const currentWindow = {
    index: Number(rawWindowIndex) || 0,
    id: windowId,
    name: windowName || `Window ${rawWindowIndex}`,
    target: windowId,
    path: panePath || sessionPath
  };

  const windows = await listCurrentTmuxWindows(sessionName, sessionPath);
  return {
    sessionName,
    sessionPath,
    currentWindow,
    windows: windows.length > 0 ? windows : [currentWindow]
  };
}

async function listCurrentTmuxWindows(sessionName: string, sessionPath: string): Promise<TmuxWindowInfo[]> {
  const windowFormat = [
    '#{window_index}',
    '#{window_id}',
    '#{window_name}',
    '#{pane_active}',
    '#{pane_current_path}'
  ].join(TMUX_FIELD_SEPARATOR);
  const { stdout } = await execFileAsync('tmux', ['list-panes', '-t', sessionName, '-F', windowFormat]);
  const windows: TmuxWindowInfo[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [rawIndex = '0', windowId = '', windowName = '', paneActive = '', panePath = ''] = line.split(TMUX_FIELD_SEPARATOR);
    if (paneActive !== '1' || !windowId || seen.has(windowId)) continue;
    seen.add(windowId);
    windows.push({
      index: Number(rawIndex) || windows.length,
      id: windowId,
      name: windowName || `Window ${rawIndex}`,
      target: windowId,
      path: panePath || sessionPath
    });
  }
  return windows.sort((a, b) => a.index - b.index);
}

function publishUrlFromAgentUrl(agentUrl: URL) {
  const url = new URL(agentUrl.toString());
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/api/tmux/publish';
  url.search = '';
  return url;
}

function postJson(url: URL, token: string, payload: unknown, skipTlsVerify: boolean): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        },
        rejectUnauthorized: !skipTlsVerify
      } as HttpsRequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: Record<string, unknown> = {};
          if (text) {
            try {
              data = JSON.parse(text) as Record<string, unknown>;
            } catch {
              data = { error: text };
            }
          }
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(String(data.error || `Publish failed with HTTP ${res.statusCode}`)));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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
    if (!isLocalHost(host)) {
      throw new Error(`TERMAG_URL must use wss:// for non-localhost hosts (got ${host}). Use a TLS reverse proxy or an SSH tunnel for the broker.`);
    }
  }
  if (insecureLocalTls && (url.protocol !== 'wss:' || !isLocalHost(url.hostname))) {
    throw new Error('TERMAG_TLS_INSECURE_SKIP_VERIFY=true is only allowed with wss://localhost, wss://127.0.0.1, or wss://[::1].');
  }
  return url;
}

function isLocalHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
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
  const ws = new WebSocket(
    url,
    insecureLocalTls && validatedUrl.protocol === 'wss:' && isLocalHost(validatedUrl.hostname)
      ? { rejectUnauthorized: false }
      : undefined
  );

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

    // Health: periodic structured snapshot the broker surfaces in Devices.
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
          const result = await handleAttach(ws, msg);
          respond(ws, requestId, result);
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
          if (!isFake) await killTmuxSession(String(msg.tmuxName || ''));
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        }
        case 'tmux-kill-session': {
          if (!isFake) await killTmuxSession(String(msg.tmuxSessionName || msg.tmuxName || ''));
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        }
        case 'tmux-kill-window': {
          if (!isFake) await killTmuxWindow(String(msg.tmuxName || ''));
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        }
        case 'tmux-rename-window': {
          const result = isFake
            ? { tmuxName: String(msg.tmuxName || ''), tmuxWindowName: String(msg.name || '') }
            : await renameTmuxWindow(String(msg.tmuxName || ''), String(msg.name || ''));
          respond(ws, requestId, result);
          break;
        }
        case 'tmux-list': {
          const sessions = isFake ? fakeTmuxSessions() : await listTmuxSessions();
          respond(ws, requestId, { sessions });
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
    fake: isFake,
    roots
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
    return { tmuxName: stream.tmuxName };
  }

  const tmuxName = String(msg.tmuxName || '');
  const tmuxSessionName = typeof msg.tmuxSessionName === 'string' ? msg.tmuxSessionName : undefined;
  const tmuxWindowName = typeof msg.tmuxWindowName === 'string' ? msg.tmuxWindowName : undefined;
  const rawCreateMode = String(msg.createMode || 'session');
  const createMode = rawCreateMode === 'none' || rawCreateMode === 'window' ? rawCreateMode : 'session';
  const spawnCommand = String(msg.spawnCommand || '$SHELL');
  const cols = Number(msg.cols || 80);
  const rows = Number(msg.rows || 24);
  const cwd = createMode === 'none' ? process.cwd() : resolveCwd(msg.cwd as Json | undefined);
  if (!tmuxName) throw new Error('tmuxName is required');

  const stream = await attachReal({ ws, streamId, tmuxName, tmuxSessionName, tmuxWindowName, createMode, cwd, spawnCommand, cols, rows });
  streams.set(streamId, stream);
  return { tmuxName: stream.tmuxName };
}

async function listTmuxSessions() {
  let sessionStdout = '';
  try {
    const result = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_path}\t#{session_windows}']);
    sessionStdout = result.stdout;
  } catch {
    return [];
  }

  const sessions = new Map<string, {
    name: string;
    path: string;
    windowCount: number;
    windows: Array<{ index: number; id: string; name: string; target: string; path: string }>;
  }>();

  for (const line of sessionStdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, sessionPath = '', rawWindowCount = '0'] = line.split('\t');
    if (!name) continue;
    sessions.set(name, {
      name,
      path: sessionPath,
      windowCount: Number(rawWindowCount) || 0,
      windows: []
    });
  }

  let paneStdout = '';
  try {
    const result = await execFileAsync('tmux', [
      'list-panes', '-a',
      '-F', '#{session_name}\t#{window_index}\t#{window_id}\t#{window_name}\t#{pane_active}\t#{pane_current_path}'
    ]);
    paneStdout = result.stdout;
  } catch {
    return [...sessions.values()];
  }

  const seenWindows = new Set<string>();
  for (const line of paneStdout.split('\n')) {
    if (!line.trim()) continue;
    const [sessionName, rawIndex = '0', windowId = '', windowName = '', paneActive = '', panePath = ''] = line.split('\t');
    if (paneActive !== '1') continue;
    const session = sessions.get(sessionName);
    if (!session || !windowId || seenWindows.has(windowId)) continue;
    seenWindows.add(windowId);
    session.windows.push({
      index: Number(rawIndex) || session.windows.length,
      id: windowId,
      name: windowName || `Window ${rawIndex}`,
      target: windowId,
      path: panePath || session.path
    });
  }

  return [...sessions.values()].map((session) => ({
    ...session,
    windows: session.windows.sort((a, b) => a.index - b.index)
  }));
}

function fakeTmuxSessions() {
  return [
    {
      name: 'restful-esp32',
      path: '~/Code/Restful-ESP32',
      windowCount: 2,
      windows: [
        { index: 0, id: '@101', name: 'codex', target: '@101', path: '~/Code/Restful-ESP32' },
        { index: 1, id: '@102', name: 'gemini', target: '@102', path: '~/Code/Restful-ESP32' }
      ]
    },
    {
      name: 'home-server',
      path: '~/Code/home-server',
      windowCount: 1,
      windows: [
        { index: 0, id: '@103', name: 'claude', target: '@103', path: '~/Code/home-server' }
      ]
    }
  ];
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
  const rootKey = String(cwd?.rootKey || Object.keys(roots)[0] || 'Local device');
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
  const fallback = { 'Local device': path.join(os.homedir(), 'Code') };
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
