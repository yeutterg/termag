import * as pty from '@lydell/node-pty';
import WebSocket from 'ws';

// Multi-subscriber shared-PTY abstraction. One tmux client process per
// tmuxName, fanned out to every browser that's attached to the same session.
// Replaces the old per-attach pty.spawn — three browsers on the same project
// used to mean three tmux clients + three independent screen-state buffers;
// now they share one PTY and see the same byte stream.
//
// Driver model: last-typer-wins with a grace window. Whichever subscriber
// most recently sent input is the driver; everyone else's input is silently
// dropped. The grace window prevents thrash when two people happen to type
// at the same time — the existing driver keeps the wheel for DRIVER_GRACE_MS
// after their last keystroke.
//
// PTY size policy: smallest viewer wins. The PTY is resized to the minimum
// cols/rows across all subscribers, so no one ever sees cropped content.
// Big-screen viewers see padding instead.

const RECENT_BUFFER_BYTES = 64 * 1024;  // late-joiner replay window
const IDLE_TEARDOWN_MS = 30_000;        // PTY lifetime after last unsubscribe
const DRIVER_GRACE_MS = 2_000;          // driver keeps wheel after last input
// Re-emit 'working' at most this often during continuous output so the
// broker's PTY-precedence window never lapses mid-stream. On output stop we
// simply stop refreshing and the broker poll classifier takes over.
const WORKING_EMIT_THROTTLE_MS = 1_500;

export type SubscriberOptions = {
  streamId: string;
  ws: WebSocket;
  cols: number;
  rows: number;
  readOnly?: boolean;
  /**
   * If true, send the recent-output ring buffer to this subscriber on join.
   * Use this only when no other subscriber has been attached recently —
   * otherwise the bytes are already in the broker's DB scrollback and the
   * subscriber would see them twice (DB chunks + recent buffer overlap).
   */
  replayRecent?: boolean;
};

export type SessionSpawnOptions = {
  tmuxSessionName: string;
  cwd: string;
  cols: number;
  rows: number;
};

type Subscriber = {
  streamId: string;
  ws: WebSocket;
  cols: number;
  rows: number;
  readOnly: boolean;
  lastInputAt: number;
};

const sessionStreams = new Map<string, SessionStream>();

export class SessionStream {
  readonly tmuxName: string;
  private pty: pty.IPty;
  private subscribers: Map<string, Subscriber> = new Map();
  private driverId: string | null = null;
  private recentBuffer: Buffer[] = [];
  private recentBufferBytes = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastWorkingEmitAt = 0;  // throttle for the PTY 'working' fast-path

  static getOrCreate(tmuxName: string, opts: SessionSpawnOptions): SessionStream {
    const existing = sessionStreams.get(tmuxName);
    if (existing) {
      existing.cancelIdleTimer();
      return existing;
    }
    const created = new SessionStream(tmuxName, opts);
    sessionStreams.set(tmuxName, created);
    return created;
  }

  static get(tmuxName: string): SessionStream | undefined {
    return sessionStreams.get(tmuxName);
  }

  private constructor(tmuxName: string, opts: SessionSpawnOptions) {
    this.tmuxName = tmuxName;
    this.pty = pty.spawn('tmux', ['attach-session', '-t', opts.tmuxSessionName], {
      name: 'xterm-256color',
      cols: opts.cols > 0 ? opts.cols : 80,
      rows: opts.rows > 0 ? opts.rows : 24,
      cwd: opts.cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    });
    this.pty.onData((data) => this.handleData(data));
    this.pty.onExit(() => this.handleExit());
  }

  subscribe(opts: SubscriberOptions): void {
    if (this.closed) return;
    this.cancelIdleTimer();
    const sub: Subscriber = {
      streamId: opts.streamId,
      ws: opts.ws,
      cols: opts.cols > 0 ? opts.cols : 80,
      rows: opts.rows > 0 ? opts.rows : 24,
      readOnly: opts.readOnly === true,
      lastInputAt: 0
    };
    this.subscribers.set(sub.streamId, sub);
    // Recent-output replay: only fire when the broker says nobody else was
    // attached, i.e. there's no primary writing the same bytes to the DB.
    // The default path (broker has another subscriber attached) gets a
    // clean stream — the broker's DB scrollback already covered history.
    if (opts.replayRecent) {
      for (const chunk of this.recentBuffer) {
        this.sendDataTo(sub, chunk.toString('utf8'));
      }
    }
    // First non-read-only subscriber becomes driver automatically.
    if (!this.driverId && !sub.readOnly) {
      this.setDriver(sub.streamId);
    } else {
      this.notifyDriver(sub);
    }
    this.recomputeSize();
  }

  unsubscribe(streamId: string): void {
    const sub = this.subscribers.get(streamId);
    if (!sub) return;
    const wasDriver = this.driverId === streamId;
    this.subscribers.delete(streamId);
    if (wasDriver) {
      const next = [...this.subscribers.values()].find((s) => !s.readOnly);
      this.setDriver(next ? next.streamId : null);
    }
    if (this.subscribers.size === 0) {
      this.scheduleIdleTeardown();
    } else {
      this.recomputeSize();
    }
  }

  writeInput(streamId: string, data: string): boolean {
    const sub = this.subscribers.get(streamId);
    if (!sub || sub.readOnly || !data) return false;
    const now = Date.now();
    if (this.driverId !== streamId) {
      // Grace window: only steal driver if there is no current driver, or the
      // current driver has been idle for DRIVER_GRACE_MS. Stops two people
      // typing at once from causing a driver-change tornado.
      const currentDriver = this.driverId ? this.subscribers.get(this.driverId) : undefined;
      const driverIdle = !currentDriver
        || currentDriver.readOnly
        || now - currentDriver.lastInputAt > DRIVER_GRACE_MS;
      if (!driverIdle) return false;
      this.setDriver(streamId);
    }
    // Only record the timestamp on accepted input. Recording it on dropped
    // input would muddy future driver-idle checks if this subscriber later
    // gets promoted via setDriver (their lastInputAt would predate the
    // promotion).
    sub.lastInputAt = now;
    this.pty.write(data);
    return true;
  }

  resize(streamId: string, cols: number, rows: number): void {
    const sub = this.subscribers.get(streamId);
    if (!sub) return;
    if (cols > 0) sub.cols = cols;
    if (rows > 0) sub.rows = rows;
    this.recomputeSize();
  }

  claimDrive(streamId: string): void {
    const sub = this.subscribers.get(streamId);
    if (!sub || sub.readOnly) return;
    // Reset the claimer's input timestamp so they get the full grace window
    // immediately — otherwise another subscriber could steal the wheel on
    // their next keystroke (now - lastInputAt would be huge against a
    // never-typed claimer).
    sub.lastInputAt = Date.now();
    this.setDriver(streamId);
  }

  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  /**
   * External-trigger cleanup — used when the underlying tmux target is
   * killed by something other than the PTY exiting (e.g. the menu helper or
   * the cleanup API). Notifies every subscriber, removes the stream from
   * the registry, and kills the PTY explicitly so we don't burn CPU
   * processing output for a subscriberless session while we wait for the
   * upstream tmux death to ripple back to us.
   */
  terminate(): void {
    this.handleExit();
    try {
      this.pty.kill();
    } catch {
      // Already exited (the normal path — tmux upstream kill caused
      // pty.onExit which already called handleExit).
    }
  }

  private setDriver(streamId: string | null): void {
    if (this.driverId === streamId) return;
    this.driverId = streamId;
    for (const sub of this.subscribers.values()) this.notifyDriver(sub);
  }

  private notifyDriver(sub: Subscriber): void {
    sendJson(sub.ws, {
      type: 'driver-changed',
      streamId: sub.streamId,
      driver: this.driverId === sub.streamId,
      readOnly: sub.readOnly
    });
  }

  private recomputeSize(): void {
    if (this.subscribers.size === 0) return;
    let cols = Infinity;
    let rows = Infinity;
    for (const sub of this.subscribers.values()) {
      cols = Math.min(cols, sub.cols);
      rows = Math.min(rows, sub.rows);
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // PTY may have just exited.
    }
  }

  private handleData(data: string): void {
    const buf = Buffer.from(data, 'utf8');
    this.recentBuffer.push(buf);
    this.recentBufferBytes += buf.byteLength;
    while (this.recentBufferBytes > RECENT_BUFFER_BYTES && this.recentBuffer.length > 1) {
      const dropped = this.recentBuffer.shift();
      if (dropped) this.recentBufferBytes -= dropped.byteLength;
    }
    for (const sub of this.subscribers.values()) {
      this.sendDataTo(sub, data);
    }
    // PTY fast-path status. A BEL byte (char 7) means attention/done — emit
    // 'waiting' immediately. Otherwise any output means the program is busy;
    // refresh 'working' but throttled so we don't spam the broker during a
    // continuous stream while still keeping its precedence window fresh.
    if (data.indexOf('\x07') !== -1) {
      this.emitStatus('waiting');
    } else {
      const now = Date.now();
      if (now - this.lastWorkingEmitAt >= WORKING_EMIT_THROTTLE_MS) {
        this.lastWorkingEmitAt = now;
        this.emitStatus('working');
      }
    }
  }

  // Fan a PTY-derived status to every subscriber's agent->broker socket. The
  // broker maps any of the session's streamIds back to the same sessionId, so
  // emitting per-subscriber is fine. No subscribers -> nothing to send.
  private emitStatus(status: 'working' | 'waiting'): void {
    for (const sub of this.subscribers.values()) {
      sendJson(sub.ws, { type: 'status', streamId: sub.streamId, status });
    }
  }

  private handleExit(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscribers.values()) {
      sendJson(sub.ws, { type: 'terminal-exit', streamId: sub.streamId });
    }
    this.subscribers.clear();
    sessionStreams.delete(this.tmuxName);
    this.cancelIdleTimer();
  }

  private sendDataTo(sub: Subscriber, data: string): void {
    if (!data) return;
    if (sub.ws.readyState !== WebSocket.OPEN) return;
    try {
      sub.ws.send(JSON.stringify({ type: 'terminal-data', streamId: sub.streamId, data }));
    } catch {
      // The socket may have transitioned to a non-OPEN state between the
      // readyState check and the send. Drop the frame; the subscriber will
      // be removed by closeStream when the WS close finishes propagating.
    }
  }

  private scheduleIdleTeardown(): void {
    if (this.idleTimer || this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.subscribers.size > 0) return;
      this.destroy();
    }, IDLE_TEARDOWN_MS);
  }

  private cancelIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private destroy(): void {
    if (this.closed) return;
    this.closed = true;
    sessionStreams.delete(this.tmuxName);
    try {
      this.pty.kill();
    } catch {
      // already gone
    }
  }
}

/**
 * Force-close every SessionStream matching the predicate. Used by
 * killTmuxSession / killTmuxWindow when an external caller (the menu helper,
 * the cleanup API) destroys the underlying tmux target — we don't want
 * orphan PTYs holding on to a dead pane.
 */
export function destroyMatchingSessionStreams(predicate: (tmuxName: string) => boolean): void {
  for (const [tmuxName, stream] of [...sessionStreams.entries()]) {
    if (!predicate(tmuxName)) continue;
    sessionStreams.delete(tmuxName);
    stream.terminate();
  }
}

function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}
