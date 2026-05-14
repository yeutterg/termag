import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, unlink } from 'node:fs/promises';
import { createReadStream, type ReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import * as pty from '@lydell/node-pty';
import { wrapWithBanner } from './banner';

const execFileAsync = promisify(execFile);

export interface Stream {
  tmuxName: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface RealAttachOpts {
  ws: WebSocket;
  streamId: string;
  tmuxName: string;
  tmuxSessionName?: string;
  tmuxWindowName?: string;
  createMode?: 'session' | 'window' | 'none';
  cwd: string;
  spawnCommand: string;
  cols: number;
  rows: number;
}

export interface FakeAttachOpts {
  ws: WebSocket;
  streamId: string;
  tmuxName: string;
  kind: string;
  cwd: { rootKey?: string; relativePath?: string };
}

const FIFO_DIR = join(tmpdir(), 'termag-agent');

// Pause the fifo reader when any subscriber's WebSocket has more than 1 MB
// queued; resume when every subscriber drains below half. Without this, a
// chatty agent on a saturated uplink would let the WS buffer grow until the
// agent OOMs.
const BACKPRESSURE_HIGH = 1024 * 1024;
const BACKPRESSURE_LOW = BACKPRESSURE_HIGH / 2;
const BACKPRESSURE_TICK_MS = 50;

// Capture this many lines of pane history when a browser re-attaches to an
// existing tmux session, so the user sees the agent's current screen state
// instead of a blank pane while waiting for the next byte of live output.
const REATTACH_HISTORY_LINES = 2000;

type Subscriber = {
  streamId: string;
  ws: WebSocket;
};

type PipeReader = {
  tmuxName: string;
  fifoPath: string;
  reader: ReadStream;
  decoder: StringDecoder;
  subscribers: Map<string, Subscriber>;
  closed: boolean;
};

// Keyed by tmuxName, not by streamId — multiple browser tabs viewing the
// same session share one pipe-pane and one fifo reader. tmux's pipe-pane
// only allows ONE active pipe per pane, so we have to fan out on our side.
const pipeReaders = new Map<string, PipeReader>();
// Concurrent attaches to the same tmuxName share one in-flight startPipeReader
// promise. Without this two attaches that interleave at an await would both
// call mkfifo + pipe-pane and clobber each other's fifo path.
const pendingPipeStarts = new Map<string, Promise<PipeReader>>();
// Each fifo path includes a monotonic counter so a cleanup of a stale pipe
// reader can never unlink the fifo of the next pipe reader to start.
let pipeSeq = 0;

async function ensureFifoDir() {
  await mkdir(FIFO_DIR, { recursive: true, mode: 0o700 });
}

async function ensureTmuxSession(tmuxName: string, cwd: string, command: string): Promise<{ wasNew: boolean }> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', tmuxName]);
    return { wasNew: false };
  } catch {
    const resolved = command === '$SHELL' ? (process.env.SHELL || '/bin/zsh') : command;
    const shellCommand = wrapWithBanner(resolved);
    try {
      await execFileAsync('tmux', [
        'new-session', '-d', '-s', tmuxName, '-c', cwd,
        '-x', '120', '-y', '32', shellCommand
      ]);
      await execFileAsync('tmux', ['set-option', '-t', tmuxName, '-w', 'window-size', 'largest']);
      await execFileAsync('tmux', ['set-option', '-t', tmuxName, 'history-limit', '10000']);
      return { wasNew: true };
    } catch (err) {
      // Concurrent attach race: another caller created the session between
      // our has-session check and our new-session call. Confirm and proceed
      // as if it were already there.
      try {
        await execFileAsync('tmux', ['has-session', '-t', tmuxName]);
        return { wasNew: false };
      } catch {
        throw err;
      }
    }
  }
}

async function tmuxTargetExists(target: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['display-message', '-p', '-t', target, '#{session_name}']);
    return true;
  } catch {
    return false;
  }
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

async function ensureTmuxWindow(sessionName: string, windowName: string, cwd: string, command: string): Promise<{ wasNew: boolean }> {
  if (await tmuxWindowExists(sessionName, windowName)) return { wasNew: false };
  const resolved = command === '$SHELL' ? (process.env.SHELL || '/bin/zsh') : command;
  const shellCommand = wrapWithBanner(resolved);

  if (!(await tmuxSessionExists(sessionName))) {
    try {
      await execFileAsync('tmux', [
        'new-session', '-d', '-s', sessionName, '-n', windowName, '-c', cwd,
        '-x', '120', '-y', '32', shellCommand
      ]);
      await execFileAsync('tmux', ['set-option', '-t', sessionName, '-w', 'window-size', 'largest']);
      await execFileAsync('tmux', ['set-option', '-t', sessionName, 'history-limit', '10000']);
      return { wasNew: true };
    } catch (err) {
      if (await tmuxWindowExists(sessionName, windowName)) return { wasNew: false };
      if (await tmuxSessionExists(sessionName)) {
        await execFileAsync('tmux', ['new-window', '-d', '-t', sessionName, '-n', windowName, '-c', cwd, shellCommand]);
        await execFileAsync('tmux', ['set-option', '-t', sessionName, '-w', 'window-size', 'largest']);
        await execFileAsync('tmux', ['set-option', '-t', sessionName, 'history-limit', '10000']);
        return { wasNew: true };
      }
      throw err;
    }
  }

  try {
    await execFileAsync('tmux', ['new-window', '-d', '-t', sessionName, '-n', windowName, '-c', cwd, shellCommand]);
    await execFileAsync('tmux', ['set-option', '-t', sessionName, '-w', 'window-size', 'largest']);
    await execFileAsync('tmux', ['set-option', '-t', sessionName, 'history-limit', '10000']);
    return { wasNew: true };
  } catch (err) {
    if (await tmuxWindowExists(sessionName, windowName)) return { wasNew: false };
    throw err;
  }
}

async function ensureTmuxTarget(opts: RealAttachOpts): Promise<{ wasNew: boolean; target: string }> {
  if (opts.createMode === 'none') {
    if (!(await tmuxTargetExists(opts.tmuxName))) {
      throw new Error(`tmux target not found: ${opts.tmuxName}`);
    }
    return { wasNew: false, target: opts.tmuxName };
  }
  if (opts.createMode === 'window' && opts.tmuxSessionName && opts.tmuxWindowName) {
    if (await tmuxTargetExists(opts.tmuxName)) return { wasNew: false, target: opts.tmuxName };
    const result = await ensureTmuxWindow(opts.tmuxSessionName, opts.tmuxWindowName, opts.cwd, opts.spawnCommand);
    return { ...result, target: `${opts.tmuxSessionName}:${opts.tmuxWindowName}` };
  }
  const result = await ensureTmuxSession(opts.tmuxName, opts.cwd, opts.spawnCommand);
  return { ...result, target: opts.tmuxName };
}

async function resolveTmuxWindowId(target: string): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', target, '#{window_id}']);
  return stdout.trim() || target;
}

async function resolveTmuxSessionName(target: string): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', target, '#{session_name}']);
  return stdout.trim();
}

async function teardownMatchingPipeReaders(predicate: (tmuxName: string) => boolean) {
  for (const [tmuxName, pipeReader] of [...pipeReaders.entries()]) {
    if (!predicate(tmuxName)) continue;
    pipeReaders.delete(tmuxName);
    await teardownPipeReader(pipeReader, /* sendExit */ true);
  }
}

export async function killTmuxSession(tmuxSessionName: string) {
  if (!tmuxSessionName) return;
  await teardownMatchingPipeReaders((tmuxName) => tmuxName === tmuxSessionName || tmuxName.startsWith(`${tmuxSessionName}:`));
  try {
    await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]);
  } catch {
    // already gone
  }
}

export async function killTmuxWindow(tmuxName: string) {
  if (!tmuxName) return;
  await teardownMatchingPipeReaders((name) => name === tmuxName);
  try {
    await execFileAsync('tmux', ['kill-window', '-t', tmuxName]);
  } catch {
    // already gone
  }
}

export async function renameTmuxWindow(tmuxName: string, name: string): Promise<{ tmuxName: string; tmuxWindowName: string }> {
  const trimmed = name.trim();
  if (!tmuxName || !trimmed) throw new Error('tmux target and window name are required');
  await execFileAsync('tmux', ['rename-window', '-t', tmuxName, trimmed]);
  return {
    tmuxName: await resolveTmuxWindowId(tmuxName),
    tmuxWindowName: trimmed
  };
}

function sendJson(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendData(ws: WebSocket, streamId: string, data: string) {
  if (data.length === 0) return;
  sendJson(ws, { type: 'terminal-data', streamId, data });
}

// tmux targets can contain punctuation such as ":" or "@", so fifo filenames
// use a sanitized display form. The pipe-pane command still gets shell-quoted
// because tmux invokes it via /bin/sh -c.
function shellQuoteForPipePane(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeFifoName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'tmux';
}

async function startPipeReader(tmuxName: string): Promise<PipeReader> {
  pipeSeq += 1;
  const fifoPath = join(FIFO_DIR, `${safeFifoName(tmuxName)}-${process.pid}-${pipeSeq}.fifo`);
  await unlink(fifoPath).catch(() => {});
  await execFileAsync('mkfifo', ['-m', '600', fifoPath]);

  // -O opens the pipe (replacing any prior one for this pane). The cat
  // process tmux spawns blocks on opening the fifo for write until our
  // createReadStream below opens the read side; the kernel rendezvous
  // handles the order safely.
  await execFileAsync('tmux', [
    'pipe-pane', '-t', tmuxName, '-O', `cat > ${shellQuoteForPipePane(fifoPath)}`
  ]);

  const reader = createReadStream(fifoPath, { highWaterMark: 64 * 1024 });
  const decoder = new StringDecoder('utf8');

  const pipeReader: PipeReader = {
    tmuxName,
    fifoPath,
    reader,
    decoder,
    subscribers: new Map(),
    closed: false
  };

  let backpressureWatcher: NodeJS.Timeout | null = null;
  function clearBackpressureWatcher() {
    if (backpressureWatcher) {
      clearInterval(backpressureWatcher);
      backpressureWatcher = null;
    }
  }
  function shouldPause(): boolean {
    for (const sub of pipeReader.subscribers.values()) {
      if (sub.ws.bufferedAmount > BACKPRESSURE_HIGH) return true;
    }
    return false;
  }
  function allDrained(): boolean {
    for (const sub of pipeReader.subscribers.values()) {
      if (sub.ws.bufferedAmount > BACKPRESSURE_LOW) return false;
    }
    return true;
  }
  function watchBackpressure() {
    if (backpressureWatcher || pipeReader.closed) return;
    backpressureWatcher = setInterval(() => {
      if (pipeReader.closed) {
        clearBackpressureWatcher();
        return;
      }
      if (allDrained()) {
        clearBackpressureWatcher();
        reader.resume();
      }
    }, BACKPRESSURE_TICK_MS);
  }

  reader.on('data', (chunk) => {
    if (pipeReader.closed) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const text = decoder.write(buf);
    if (!text) return;
    for (const sub of pipeReader.subscribers.values()) {
      sendData(sub.ws, sub.streamId, text);
    }
    if (shouldPause()) {
      reader.pause();
      watchBackpressure();
    }
  });

  const handleEnd = () => {
    if (pipeReader.closed) return;
    pipeReader.closed = true;
    clearBackpressureWatcher();
    // Notify every subscriber that the pane is gone.
    for (const sub of pipeReader.subscribers.values()) {
      sendJson(sub.ws, { type: 'terminal-exit', streamId: sub.streamId });
    }
    pipeReader.subscribers.clear();
    pipeReaders.delete(tmuxName);
    void cleanupPipeArtifacts(pipeReader);
  };

  reader.on('end', handleEnd);
  reader.on('error', handleEnd);

  return pipeReader;
}

async function cleanupPipeArtifacts(pipeReader: PipeReader) {
  try { pipeReader.reader.destroy(); } catch { /* already destroyed */ }
  // Toggle pipe-pane off (no -O = stop). Don't kill the tmux session itself
  // — that's the whole point of using tmux. The session lives on so the
  // user can re-attach later.
  try { await execFileAsync('tmux', ['pipe-pane', '-t', pipeReader.tmuxName]); } catch { /* pane gone */ }
  try { await unlink(pipeReader.fifoPath); } catch { /* already gone */ }
}

async function teardownPipeReader(pipeReader: PipeReader, sendExit: boolean) {
  if (pipeReader.closed) return;
  pipeReader.closed = true;
  if (sendExit) {
    for (const sub of pipeReader.subscribers.values()) {
      sendJson(sub.ws, { type: 'terminal-exit', streamId: sub.streamId });
    }
  }
  pipeReader.subscribers.clear();
  await cleanupPipeArtifacts(pipeReader);
}

export async function attachReal(opts: RealAttachOpts): Promise<Stream> {
  if (opts.createMode !== 'none') {
    await mkdir(opts.cwd, { recursive: true });
  }

  const { wasNew, target } = await ensureTmuxTarget(opts);
  const tmuxName = await resolveTmuxWindowId(target);
  const tmuxSessionName = opts.tmuxSessionName || await resolveTmuxSessionName(tmuxName);
  if (opts.createMode === 'window' && opts.tmuxWindowName) {
    await execFileAsync('tmux', ['rename-window', '-t', tmuxName, opts.tmuxWindowName]).catch(() => {});
  }

  // A real tmux client is the only path that renders the browser exactly like
  // a local terminal: pane borders, inactive panes, the status line, and tmux
  // keybindings are all generated by tmux itself inside this PTY.
  if (!wasNew) await execFileAsync('tmux', ['select-window', '-t', tmuxName]).catch(() => {});
  await execFileAsync('tmux', ['set-option', '-t', tmuxSessionName, '-w', 'window-size', 'largest']).catch(() => {});

  const term = pty.spawn('tmux', ['attach-session', '-t', tmuxSessionName], {
    name: 'xterm-256color',
    cols: opts.cols > 0 ? opts.cols : 80,
    rows: opts.rows > 0 ? opts.rows : 24,
    cwd: opts.cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    }
  });

  const streamId = opts.streamId;
  let detached = false;
  term.onData((data) => {
    if (!detached) sendData(opts.ws, streamId, data);
  });
  term.onExit(() => {
    if (!detached) sendJson(opts.ws, { type: 'terminal-exit', streamId });
  });

  return {
    tmuxName,
    write(data: string) {
      if (detached || !data) return;
      term.write(data);
    },
    resize(cols: number, rows: number) {
      if (detached || cols <= 0 || rows <= 0) return;
      term.resize(cols, rows);
    },
    close() {
      if (detached) return;
      detached = true;
      term.kill();
    }
  };
}

export function attachFake(opts: FakeAttachOpts): Stream {
  sendData(
    opts.ws,
    opts.streamId,
    `\r\n[fake-agent] attached ${opts.kind} ${opts.tmuxName}\r\n` +
      `[fake-agent] cwd ${opts.cwd?.rootKey || 'Local device'}/${opts.cwd?.relativePath || ''}\r\n$ `
  );

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
    sendData(
      opts.ws,
      opts.streamId,
      `\r\n[fake-agent] ${new Date().toLocaleTimeString()} ${lines[tick % lines.length]}\r\n$ `
    );
  }, 3500);

  return {
    tmuxName: opts.tmuxName,
    write(data: string) {
      const printable = data.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\x1b/g, 'Esc');
      sendData(opts.ws, opts.streamId, `${data}\r\n[fake-agent] received input: ${printable}\r\n$ `);
    },
    resize() { /* no-op */ },
    close() {
      clearInterval(timer);
    }
  };
}
