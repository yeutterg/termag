import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import WebSocket from 'ws';
import { type BannerContext, wrapWithBanner } from './banner';
import { destroyMatchingSessionStreams, SessionStream } from './session-stream';

const execFileAsync = promisify(execFile);

export interface Stream {
  tmuxName: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Promote this stream to driver. No-op for read-only subscribers. */
  claimDrive?(): void;
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
  readOnly?: boolean;
  /** Replay the SessionStream's recent-output ring buffer on subscribe. */
  replayRecent?: boolean;
  /**
   * Optional context baked into the banner printed at fresh-tmux-pane
   * creation: termag version, project name, device name. cwd and shell are
   * filled in by the spawn site from the resolved values that go to tmux.
   */
  agentVersion?: string;
  projectName?: string;
  deviceName?: string;
}

export interface FakeAttachOpts {
  ws: WebSocket;
  streamId: string;
  tmuxName: string;
  kind: string;
  cwd: { rootKey?: string; relativePath?: string };
}

async function ensureTmuxSession(tmuxName: string, cwd: string, command: string, bannerCtx?: BannerContext): Promise<{ wasNew: boolean }> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', tmuxName]);
    return { wasNew: false };
  } catch {
    const resolved = command === '$SHELL' ? (process.env.SHELL || '/bin/zsh') : command;
    const shellCommand = wrapWithBanner(resolved, { ...bannerCtx, cwd, shell: resolved });
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
    // display-message with a missing -t exits 0 with empty stdout on some
    // tmux builds — checking the truthiness of the result is the only
    // reliable signal. Without this, a fresh project (no tmux session yet)
    // looks "exists already" and ensureTmuxTarget skips the create step.
    const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', target, '#{session_name}']);
    return stdout.trim().length > 0;
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

async function ensureTmuxWindow(sessionName: string, windowName: string, cwd: string, command: string, bannerCtx?: BannerContext): Promise<{ wasNew: boolean }> {
  if (await tmuxWindowExists(sessionName, windowName)) return { wasNew: false };
  const resolved = command === '$SHELL' ? (process.env.SHELL || '/bin/zsh') : command;
  const shellCommand = wrapWithBanner(resolved, { ...bannerCtx, cwd, shell: resolved });

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
  const bannerCtx: BannerContext = {
    version: opts.agentVersion,
    projectName: opts.projectName,
    deviceName: opts.deviceName
  };
  if (opts.createMode === 'window' && opts.tmuxSessionName && opts.tmuxWindowName) {
    if (await tmuxTargetExists(opts.tmuxName)) return { wasNew: false, target: opts.tmuxName };
    const result = await ensureTmuxWindow(opts.tmuxSessionName, opts.tmuxWindowName, opts.cwd, opts.spawnCommand, bannerCtx);
    return { ...result, target: `${opts.tmuxSessionName}:${opts.tmuxWindowName}` };
  }
  const result = await ensureTmuxSession(opts.tmuxName, opts.cwd, opts.spawnCommand, bannerCtx);
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

export async function killTmuxSession(tmuxSessionName: string) {
  if (!tmuxSessionName) return;
  destroyMatchingSessionStreams((tmuxName) => tmuxName === tmuxSessionName || tmuxName.startsWith(`${tmuxSessionName}:`));
  try {
    await execFileAsync('tmux', ['kill-session', '-t', tmuxSessionName]);
  } catch {
    // already gone
  }
}

export async function killTmuxWindow(tmuxName: string) {
  if (!tmuxName) return;
  destroyMatchingSessionStreams((name) => name === tmuxName);
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

function sendData(ws: WebSocket, streamId: string, data: string) {
  if (data.length === 0) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'terminal-data', streamId, data }));
  }
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

  if (!wasNew) await execFileAsync('tmux', ['select-window', '-t', tmuxName]).catch(() => {});
  await execFileAsync('tmux', ['set-option', '-t', tmuxSessionName, '-w', 'window-size', 'largest']).catch(() => {});

  // SessionStream multiplexes one tmux client (one PTY) across every browser
  // attached to this tmuxName. The wrapper returned below is just an adapter
  // that routes per-stream input/resize/close into the shared SessionStream.
  const sessionStream = SessionStream.getOrCreate(tmuxName, {
    tmuxSessionName,
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows
  });
  sessionStream.subscribe({
    streamId: opts.streamId,
    ws: opts.ws,
    cols: opts.cols,
    rows: opts.rows,
    readOnly: opts.readOnly === true,
    replayRecent: opts.replayRecent === true
  });

  let detached = false;
  return {
    tmuxName,
    write(data: string) {
      if (detached || !data) return;
      sessionStream.writeInput(opts.streamId, data);
    },
    resize(cols: number, rows: number) {
      if (detached || cols <= 0 || rows <= 0) return;
      sessionStream.resize(opts.streamId, cols, rows);
    },
    claimDrive() {
      if (detached) return;
      sessionStream.claimDrive(opts.streamId);
    },
    close() {
      if (detached) return;
      detached = true;
      sessionStream.unsubscribe(opts.streamId);
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
