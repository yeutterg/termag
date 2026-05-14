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
import { startMacMenuBar, stopMacMenuBar } from './menubar';
import { listDirectory } from './fs';
import { wrapWithBanner } from './banner';

const execFileAsync = promisify(execFile);

type Json = Record<string, unknown>;
type NodeError = Error & { code?: string };

const isFake = process.env.TERMAG_AGENT_FAKE === 'true';
const tag = isFake ? 'fake-agent' : 'agent';
const insecureLocalTls = process.env.TERMAG_TLS_INSECURE_SKIP_VERIFY === 'true';

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
// Health interval is configurable so cellular-tethered agents can dial it
// down. Default 10s; clamped to [1s, 5min] to keep both runaway pings and
// effectively-disabled health off the table.
const HEALTH_INTERVAL_MS = (() => {
  const raw = Number.parseInt(process.env.TERMAG_HEALTH_INTERVAL_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 10_000;
  return Math.min(300_000, Math.max(1_000, raw));
})();

// Wire-protocol constant shared with the broker. Keep in sync with
// apps/web/server/broker.js → WS_REPLACED_REASON.
const WS_REPLACED_REASON = 'replaced';

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

const argv = process.argv.slice(2);
const subcommand = argv[0];
if (subcommand === 'update') {
  void runUpdate();
} else if (subcommand === 'connect') {
  void runConnect(argv.slice(1));
} else if (subcommand === '--version' || subcommand === '-v') {
  console.log(pkgVersion);
  process.exit(0);
} else if (subcommand === '--help' || subcommand === '-h') {
  printHelp();
  process.exit(0);
} else if (looksLikeConnectArgs(argv)) {
  void runConnect(argv);
} else if (subcommand?.startsWith('-')) {
  console.error(`[${tag}] Unknown option: ${subcommand}`);
  printHelp();
  process.exit(1);
} else {
  void run();
}

function printHelp() {
  console.log(`termag ${pkgVersion}

Usage:
  termag              connect to the broker and serve sessions (default)
  termag connect      publish current tmux window/session to the web UI
  termag -p/--project shorthand for "termag connect --project"
  termag update       upgrade the agent in place (auto-detects npm vs brew)
  termag --version    print version
  termag --help       show this message

Environment:
  TERMAG_URL                wss://… or ws://localhost… of /api/ws/agent
  TERMAG_AGENT_TOKEN        bearer token created in the web New Device dialog
  TERMAG_AGENT_ROOTS        JSON map of device labels to roots, e.g. {"Mac Mini":"~/Code"}
  TERMAG_TLS_INSECURE_SKIP_VERIFY
                            allow self-signed localhost TLS only (default false)
  TERMAG_RECONNECT_MS       initial reconnect delay (default 1000)
  TERMAG_RECONNECT_MAX_MS   max reconnect delay (default 30000)
  TERMAG_MAC_MENUBAR        macOS menu bar helper toggle (default false)
  TERMAG_TERMINAL_APP       Terminal, iTerm2, Ghostty, or auto for menu actions
  TERMAG_CONFIG             config file path (default ~/.termag/config.json)
`);
}

function looksLikeConnectArgs(args: string[]) {
  return args.some((arg) => (
    arg === '--project'
    || arg === '-p'
    || arg.startsWith('--project=')
    || arg === '--tab'
    || arg === '-t'
    || arg.startsWith('--tab=')
    || arg === '--session'
    || arg === '--window'
  ));
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
  localAttach?: boolean;
  startAgent: boolean;
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
  createdSession?: boolean;
  createdWindow?: boolean;
  createdFromShell?: boolean;
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

  const connectArgs = await resolveConnectArgs(parsedArgs);

  let tmux: TmuxContext;
  try {
    tmux = await detectOrCreateTmuxContext(connectArgs);
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const windows = connectArgs.mode === 'session'
    ? tmux.windows
    : [{
      ...tmux.currentWindow,
      name: connectArgs.tabName || tmux.currentWindow.name
    }];

  const publishUrl = publishUrlFromAgentUrl(validatedUrl);
  try {
    const result = await postJson(
      publishUrl,
      token,
      {
        projectName: connectArgs.projectName,
        tmuxSessionName: tmux.sessionName,
        path: publishPathForCwd(tmux.currentWindow.path || tmux.sessionPath),
        windows: windows.map((window) => ({
          name: window.name,
          target: window.target,
          windowName: window.id || window.name,
          ordinal: window.index
        }))
      },
      insecureLocalTls && publishUrl.protocol === 'https:' && isLocalHost(publishUrl.hostname)
    );
    const totalTabs = Array.isArray(result?.tabs) ? result.tabs.length : windows.length;
    const added = typeof result?.addedWindowCount === 'number' ? result.addedWindowCount : windows.length;
    const skipped = Math.max(0, windows.length - added);
    const what = connectArgs.mode === 'session' ? 'session' : 'window';
    if (added === 0) {
      console.log(`[${tag}] ${what} "${tmux.sessionName}" already published to project "${connectArgs.projectName}" (${totalTabs} tab${totalTabs === 1 ? '' : 's'}, no changes).`);
    } else if (skipped > 0) {
      console.log(`[${tag}] published ${added} new tab${added === 1 ? '' : 's'} to project "${connectArgs.projectName}" (${skipped} already existed; ${totalTabs} total).`);
    } else {
      console.log(`[${tag}] published ${what} "${tmux.sessionName}" to project "${connectArgs.projectName}" (${added} tab${added === 1 ? '' : 's'}).`);
    }
    if (tmux.createdFromShell) {
      const action = tmux.createdSession ? 'created tmux session' : tmux.createdWindow ? 'created tmux window in existing session' : 'using existing tmux window';
      console.log(`[${tag}] ${action} "${tmux.sessionName}" at ${tmux.currentWindow.path}. Attach locally with: tmux attach -t ${shellArgForLog(tmux.sessionName)}`);
    }
    if (connectArgs.startAgent) {
      startBackgroundAgent();
    }
    if (shouldAttachLocal(connectArgs, tmux)) {
      const code = await attachLocalTmux(tmux);
      process.exit(code);
    }
  } catch (err) {
    console.error(`[${tag}] ${err instanceof Error ? formatConnectionError(err, publishUrl) : String(err)}`);
    process.exit(1);
  }
}

function parseConnectArgs(args: string[]): ConnectArgs {
  let projectName = '';
  let tabName = '';
  let mode: 'window' | 'session' = 'window';
  let localAttach: boolean | undefined;
  let startAgent = true;
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
    if (arg === '--attach') {
      localAttach = true;
      continue;
    }
    if (arg === '--no-attach') {
      localAttach = false;
      continue;
    }
    if (arg === '--background-agent') {
      startAgent = true;
      continue;
    }
    if (arg === '--no-background-agent' || arg === '--no-agent') {
      startAgent = false;
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
  return { projectName, tabName: tabName || undefined, mode, localAttach, startAgent };
}

function requiredFlagValue(flag: string, value: string | undefined) {
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function printConnectHelp() {
  console.log(`termag connect

Usage:
  termag connect --project <project>            # current tmux window only
  termag connect --project <project> --tab <label>
  termag connect --project <project> --session  # every window in this tmux session
  termag connect                                # infer project from git/cwd
  termag connect <project> [tab-label]          # positional shorthand

  --project, -p   Project name to publish to (created on first connect).
                  Defaults to the current git repo or directory name.
  --tab, -t       Override the tab label shown in the web UI. Free-form
                  text — NOT a tmux window index. Defaults to the current
                  tmux window's name, or "shell" outside tmux.
  --session       Publish every window in the current tmux session as
                  separate tabs.
  --no-attach     Outside tmux, create/publish the tmux session but do not
                  attach this terminal to it.
  --no-agent      Do NOT start a background termag websocket process after
                  publishing. By default a single background agent is
                  spawned (one per device); subsequent connects skip the
                  spawn if a live one is found via ~/.termag/agent.pid.

Publishes the current tmux window, or every window in the current tmux
session with --session, to the termag web UI. When run outside tmux, this
creates or reuses a detached tmux session named after the project and a window
named after --tab, then attaches this terminal when running interactively.
`);
}

const TMUX_FIELD_SEPARATOR = '\x1f';

async function resolveConnectArgs(args: ConnectArgs): Promise<ConnectArgs> {
  const projectName = args.projectName.trim() || await inferProjectName();
  return { ...args, projectName };
}

async function inferProjectName() {
  const cwd = process.cwd();
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    const rootName = path.basename(stdout.trim());
    if (rootName) return rootName;
  } catch {
    // Not a git worktree; fall back to the directory name below.
  }
  return path.basename(cwd) || 'termag';
}

async function detectOrCreateTmuxContext(args: ConnectArgs): Promise<TmuxContext> {
  if (process.env.TMUX) return detectTmuxContext();
  return createTmuxContextFromShell(args);
}

async function detectTmuxContext(): Promise<TmuxContext> {
  if (!process.env.TMUX) {
    throw new Error('termag connect must run inside tmux. Start or attach tmux first, then rerun connect.');
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

async function createTmuxContextFromShell(args: ConnectArgs): Promise<TmuxContext> {
  const cwd = process.cwd();
  const sessionName = safeTmuxName(args.projectName, 'termag');
  const windowName = safeTmuxName(args.tabName || defaultShellTabName(), 'shell');
  const resolvedShell = process.env.SHELL || '/bin/zsh';
  const shellCommand = wrapWithBanner(resolvedShell);
  let createdSession = false;
  let createdWindow = false;

  // Concurrent `termag connect` invocations can both reach the existence
  // check before either has created the session/window. Catch failure and
  // re-check rather than crashing the second caller.
  if (!(await tmuxSessionExists(sessionName))) {
    try {
      await execFileAsync('tmux', [
        'new-session', '-d', '-s', sessionName, '-n', windowName, '-c', cwd,
        '-x', '120', '-y', '32', shellCommand
      ]);
      await configureTmuxSession(sessionName);
      createdSession = true;
      createdWindow = true;
    } catch (err) {
      if (!(await tmuxSessionExists(sessionName))) throw err;
    }
  }
  if (!createdWindow && !(await tmuxWindowExists(sessionName, windowName))) {
    try {
      await execFileAsync('tmux', ['new-window', '-d', '-t', sessionName, '-n', windowName, '-c', cwd, shellCommand]);
      await configureTmuxSession(sessionName);
      createdWindow = true;
    } catch (err) {
      if (!(await tmuxWindowExists(sessionName, windowName))) throw err;
    }
  }

  const currentWindow = await tmuxWindowInfo(`${sessionName}:${windowName}`, cwd);
  const windows = await listCurrentTmuxWindows(sessionName, cwd);
  return {
    sessionName,
    sessionPath: cwd,
    currentWindow,
    windows: windows.length > 0 ? windows : [currentWindow],
    createdSession,
    createdWindow,
    createdFromShell: true
  };
}

async function configureTmuxSession(sessionName: string) {
  await execFileAsync('tmux', ['set-option', '-t', sessionName, '-w', 'window-size', 'largest']).catch(() => {});
  await execFileAsync('tmux', ['set-option', '-t', sessionName, 'history-limit', '10000']).catch(() => {});
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxWindowExists(sessionName: string, windowName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('tmux', ['list-windows', '-t', sessionName, '-F', '#W']);
    return stdout.split('\n').some((line) => line.trim() === windowName);
  } catch {
    return false;
  }
}

async function tmuxWindowInfo(target: string, fallbackPath: string): Promise<TmuxWindowInfo> {
  const format = [
    '#{window_index}',
    '#{window_id}',
    '#{window_name}',
    '#{pane_current_path}'
  ].join(TMUX_FIELD_SEPARATOR);
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', target, format]);
  const [rawIndex = '0', windowId = '', windowName = '', panePath = ''] = stdout.trimEnd().split(TMUX_FIELD_SEPARATOR);
  if (!windowId) throw new Error(`Could not detect tmux window ${target}.`);
  return {
    index: Number(rawIndex) || 0,
    id: windowId,
    name: windowName || `Window ${rawIndex}`,
    target: windowId,
    path: panePath || fallbackPath
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
  const { stdout } = await execFileAsync('tmux', ['list-panes', '-s', '-t', sessionName, '-F', windowFormat]);
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

function safeTmuxName(raw: string, fallback: string) {
  return raw
    .trim()
    .replace(/[:\r\n\t]/g, ' ')
    .replace(/[^a-zA-Z0-9_. -]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    || fallback;
}

function shellArgForLog(value: string) {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultShellTabName() {
  return process.env.TERMAG_DEFAULT_TAB?.trim()
    || process.env.TERMAG_TAB?.trim()
    || 'shell';
}

function publishPathForCwd(cwd: string): string | undefined {
  const absoluteCwd = path.resolve(expandRoot(cwd));
  const candidates = Object.entries(parseRoots(process.env.TERMAG_AGENT_ROOTS))
    .map(([rootKey, rootPath]) => ({ rootKey, rootPath: path.resolve(expandRoot(rootPath)) }))
    .sort((a, b) => b.rootPath.length - a.rootPath.length);

  for (const candidate of candidates) {
    if (absoluteCwd === candidate.rootPath) return undefined;
    if (absoluteCwd.startsWith(`${candidate.rootPath}${path.sep}`)) {
      return path.relative(candidate.rootPath, absoluteCwd);
    }
  }

  return cwd;
}

function startBackgroundAgent() {
  // Guard against multiple `termag connect` invocations spawning duplicate
  // background agents that would thrash kicking each other via the broker's
  // "replaced" close. Skip if a live PID is already on file.
  const existingPid = readLivePid();
  if (existingPid !== null) {
    console.log(`[${tag}] background agent already running (pid ${existingPid}); skipping spawn.`);
    return;
  }
  const command = currentAgentCommand();
  try {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();
    if (child.pid) writePidFile(child.pid);
    console.log(`[${tag}] background agent started (pid ${child.pid}).`);
  } catch (err) {
    console.warn(`[${tag}] could not start background agent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const PID_FILE = path.join(os.homedir(), '.termag', 'agent.pid');

function readLivePid(): number | null {
  try {
    const raw = readFileSync(PID_FILE, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // signal 0 = liveness probe; throws if process is gone
    // PID-recycle guard: kill(pid, 0) succeeds even if a different program now
    // owns the recycled pid. Verify the process is actually our agent before
    // skipping a spawn.
    if (!pidIsTermagAgent(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

function pidIsTermagAgent(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      return TERMAG_PROCESS_PATTERN.test(cmdline);
    }
    // macOS / BSD have no /proc; ask ps for the command of the pid.
    const fs = require('node:child_process') as typeof import('node:child_process');
    const stdout = fs.execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000
    });
    return TERMAG_PROCESS_PATTERN.test(stdout);
  } catch {
    // ps failed (pid gone, permission denied, etc.) — assume not ours.
    return false;
  }
}

const TERMAG_PROCESS_PATTERN = /termag(-agent)?(\b|[\s\/]|\.js)/i;

function writePidFile(pid: number) {
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PID_FILE, `${pid}\n`, { mode: 0o600 });
  } catch {
    // Non-fatal — agent will run without a PID file; only loses dedup.
  }
}

function removePidFile() {
  // Only unlink if the file still records THIS process's pid. If a newer
  // agent has already overwritten the file with its own pid (the common
  // "replaced" sequence), unlinking would erase the live agent's record
  // and let a subsequent `termag connect` spawn a duplicate, kicking us
  // into a thrash loop. Read-then-check-then-unlink is racy in theory but
  // safe in practice for a personal-tool single-machine workflow.
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (Number.parseInt(raw, 10) !== process.pid) return;
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already gone, never created, or unreadable.
  }
}

function currentAgentCommand() {
  if (__filename.endsWith('.ts')) {
    let tsxLoader = 'tsx';
    try {
      tsxLoader = require.resolve('tsx');
    } catch {
      // Fall back to package resolution from the child process cwd.
    }
    return { cmd: process.execPath, args: ['--import', tsxLoader, __filename] };
  }
  return { cmd: process.execPath, args: [__filename] };
}

function shouldAttachLocal(args: ConnectArgs, tmux: TmuxContext) {
  if (!tmux.createdFromShell || process.env.TMUX) return false;
  if (args.localAttach === false) return false;
  return args.localAttach === true || (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
}

async function attachLocalTmux(tmux: TmuxContext) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn(`[${tag}] cannot attach local terminal because stdin/stdout are not TTYs.`);
    return 0;
  }

  await execFileAsync('tmux', ['select-window', '-t', tmux.currentWindow.target]).catch(() => {});
  return new Promise<number>((resolve) => {
    const child = spawn('tmux', ['attach-session', '-t', tmux.sessionName], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(`[${tag}] could not attach tmux session: ${err.message}`);
      resolve(1);
    });
  });
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
  startMacMenuBar({ tag });

  // Record this process as the live agent so future `termag connect`
  // invocations skip spawning a duplicate. Cleanup happens on shutdown +
  // on "replaced" close.
  writePidFile(process.pid);
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
    void sendHealth(ws);
    healthTimer = setInterval(() => { void sendHealth(ws); }, HEALTH_INTERVAL_MS);
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
        case 'list-directory': {
          const requestedRootKey = typeof msg.rootKey === 'string' && msg.rootKey ? msg.rootKey : Object.keys(roots)[0] || '';
          const requestedRelative = typeof msg.relativePath === 'string' ? msg.relativePath : '';
          if (!requestedRootKey || !roots[requestedRootKey]) {
            respond(ws, requestId, { roots, entries: [] }, `Unknown root ${requestedRootKey}`);
            break;
          }
          const listing = await listDirectory(roots, requestedRootKey, requestedRelative);
          respond(ws, requestId, { ...listing, roots });
          break;
        }
        case 'hello':
          break;
        case 'health-request':
          // Broker pokes us when something just changed (e.g., a publish API
          // call) and the UI needs current tmux state without waiting for
          // the next scheduled tick.
          await sendHealth(ws);
          if (requestId) respond(ws, requestId, { ok: true });
          break;
        default:
          if (requestId) respond(ws, requestId, null, `Unknown command: ${type}`);
      }
    } catch (err) {
      if (requestId) respond(ws, requestId, null, err instanceof Error ? err.message : String(err));
    }
  });

  ws.on('close', (code: number, reason: Buffer | string) => {
    clearTimers();
    // Tear down local stream readers — tmux sessions themselves stay alive
    // so the next agent connection can re-attach.
    for (const stream of [...streams.values()]) {
      stream.close();
    }
    streams.clear();
    // The broker closes us with code 1000 + reason "replaced" when another
    // agent process for the same user connects. Reconnecting would just
    // start a thrash loop with that newer agent. Exit cleanly instead.
    const reasonText = Buffer.isBuffer(reason) ? reason.toString() : String(reason || '');
    if (code === 1000 && reasonText === WS_REPLACED_REASON) {
      console.log(`[${tag}] connection replaced by another agent process; exiting.`);
      stopMacMenuBar();
      removePidFile();
      process.exit(0);
    }
    // Code 1008 = Policy Violation. The broker uses this for invalid tokens
    // and revoked devices. No amount of reconnecting will fix the underlying
    // problem; exit with a clear error so the user notices.
    if (code === 1008) {
      console.error(`[${tag}] broker rejected the connection: ${reasonText || 'policy violation'}.`);
      console.error(`[${tag}] check TERMAG_AGENT_TOKEN — was the device token revoked or replaced?`);
      stopMacMenuBar();
      removePidFile();
      process.exit(1);
    }
    const delay = nextReconnectDelay();
    reconnectAttempts += 1;
    console.log(`[${tag}] disconnected; reconnecting in ${delay}ms`);
    setTimeout(() => connect(validatedUrl, token), delay);
  });

  ws.on('error', (err) => {
    console.error(`[${tag}] ${formatConnectionError(err, validatedUrl)}`);
  });
}

const TLS_CERT_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);

function formatConnectionError(err: Error, url: URL) {
  const rawCode = (err as NodeError).code;
  const code = typeof rawCode === 'string' ? rawCode : '';
  if (!TLS_CERT_ERROR_CODES.has(code) && !/certificate|self[- ]signed|issuer cert/i.test(err.message)) {
    return err.message;
  }

  const target = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  if (url.protocol === 'wss:' && isLocalHost(url.hostname) && !insecureLocalTls) {
    return `${err.message}. ${target} is using a local TLS certificate; for local Docker/Caddy previews, set TERMAG_TLS_INSECURE_SKIP_VERIFY=true and restart the agent.`;
  }

  return `${err.message}. Node does not trust the TLS certificate for ${target}; use a publicly trusted certificate with the full chain, or set NODE_EXTRA_CA_CERTS to your private CA PEM file.`;
}

async function sendHealth(ws: WebSocket) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const memMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const tmuxSessions = isFake ? fakeTmuxSessions() : await listTmuxSessions();
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'health',
    streamCount: streams.size,
    uptimeSec: Math.floor(process.uptime()),
    memMb,
    version: pkgVersion,
    fake: isFake,
    roots,
    tmux: { sessions: tmuxSessions }
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
  stopMacMenuBar();
  removePidFile();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
