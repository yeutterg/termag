const { WebSocket } = require('ws');
const { appendScrollback } = require('./scrollback');

// One PTY shared across N browser subscribers. Parallel to the agent-side
// SessionStream in apps/agent/src/session-stream.ts but lives here in the
// broker because the broker is the PTY owner for ssh attaches.
//
// Lifecycle:
//   getOrCreate(...) → stream (start a fresh ssh pty if no peer stream exists)
//   stream.subscribe(ws, cols, rows) → ws receives output, sends input
//   when last subscriber leaves: 30s idle timer; if no one re-subscribes,
//     pty is killed and stream evicted from the registry.
//   forgetHost(userId, hostId) tears down all matching streams immediately.
//
// SSH attaches do NOT implement the drive model — tmux on the remote side
// already supports multiple concurrent clients per session, so we let it
// handle multi-typing naturally. Every subscriber can type; every
// subscriber sees all output.

const RECENT_BUFFER_BYTES = 64 * 1024;
const IDLE_TEARDOWN_MS = 30_000;

const MAX_TMUX_NAME_LENGTH = 240;

function assertSafeTmuxName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TMUX_NAME_LENGTH) {
    throw new Error('Unsafe tmux session name');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new Error('Unsafe tmux session name');
  }
}

function key(userId, hostId, tmuxName) {
  return JSON.stringify([userId, hostId, tmuxName]);
}

function createSshStreamRegistry({ prisma }) {
  const streams = new Map(); // key → SshSessionStream

  function getOrCreate({ userId, hostSpec, tmuxName, cols, rows }) {
    assertSafeTmuxName(tmuxName);
    const k = key(userId, hostSpec.id, tmuxName);
    const existing = streams.get(k);
    if (existing) {
      // Live stream — if its PTY is dead from a remote tmux exit but the
      // teardown timer hasn't fired yet, drop it and start fresh. (Edge
      // case: subscriber returns within the 30s window AFTER tmux died.)
      if (!existing.alive) {
        existing.dispose('replaced');
      } else {
        return existing;
      }
    }
    const stream = new SshSessionStream({
      registryKey: k,
      userId,
      hostSpec,
      tmuxName,
      cols,
      rows,
      prisma,
      onDispose: () => streams.delete(k)
    });
    streams.set(k, stream);
    return stream;
  }

  function forgetHost(userId, hostId) {
    for (const stream of [...streams.values()]) {
      if (stream.userId === userId && stream.hostSpec.id === hostId) {
        stream.dispose('host removed');
      }
    }
  }

  return { getOrCreate, forgetHost };
}

class SshSessionStream {
  constructor(opts) {
    this.registryKey = opts.registryKey;
    this.userId = opts.userId;
    this.hostSpec = opts.hostSpec;
    this.tmuxName = opts.tmuxName;
    this.prisma = opts.prisma;
    this.onDispose = opts.onDispose;
    // Per-subscriber dims are tracked in subscribers; instance cols/rows
    // hold the current pty dimensions (= min across all live subscribers).
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.subscribers = new Map(); // subscriberId → { ws, cols, rows }
    this.subSeq = 0;
    // `alive` flips false when the pty dies OR dispose runs; new
    // subscribers are rejected once it's false. `disposed` is the
    // separate "we've run final cleanup" flag — kept distinct from
    // `alive` so dispose() is idempotent without short-circuiting the
    // first call when alive was already false (e.g., pty-exit path).
    this.alive = true;
    this.disposed = false;
    this.idleTimer = null;
    // Rolling buffer of recent pty output. Catches new subscribers up to
    // "the last few screens" without a DB round-trip; for older history
    // we fall back to the persisted ScrollbackChunk table.
    this.recentBuffer = [];
    this.recentBytes = 0;
    // Lazy-set Session row id; populated on first subscribe.
    this.sessionDbId = null;
    this.dbSessionPromise = null;

    const { spawnSshTmuxAttach } = require('./ssh');
    this.pty = spawnSshTmuxAttach({
      host: this.hostSpec,
      tmuxName: this.tmuxName,
      cols: this.cols,
      rows: this.rows
    });

    this.pty.onData((data) => this.handlePtyData(data));
    this.pty.onExit(() => {
      this.alive = false;
      this.broadcastExit();
      this.dispose('pty exit');
    });
  }

  /**
   * Find-or-create the persistent Session row that owns the scrollback for
   * this (sshHost, tmuxName) pair. We do this once per stream, lazily, so
   * a stream that exists only for a few seconds doesn't churn DB rows.
   *
   * On hard failure we return null and clear `dbSessionPromise` so the
   * next subscriber retries instead of getting stuck with a pinned-null
   * result forever (a transient DB hiccup on the very first subscribe
   * would otherwise permanently disable scrollback for this stream).
   */
  async ensureDbSession() {
    if (this.sessionDbId) return this.sessionDbId;
    if (this.dbSessionPromise) return this.dbSessionPromise;
    this.dbSessionPromise = (async () => {
      try {
        const existing = await this.prisma.session.findFirst({
          where: { sshHostId: this.hostSpec.id, tmuxName: this.tmuxName },
          select: { id: true }
        });
        if (existing) {
          this.sessionDbId = existing.id;
          return existing.id;
        }
        const created = await this.prisma.session.create({
          data: {
            kind: 'ssh',
            tmuxName: this.tmuxName,
            sshHostId: this.hostSpec.id,
            tmuxManaged: false
          },
          select: { id: true }
        });
        this.sessionDbId = created.id;
        return created.id;
      } catch (err) {
        // If the DB write fails (e.g., concurrent inserts → unique
        // violation), retry the lookup once. Either way, don't kill the
        // stream — scrollback persistence is a nicety, not a hard
        // requirement.
        const retry = await this.prisma.session
          .findFirst({ where: { sshHostId: this.hostSpec.id, tmuxName: this.tmuxName }, select: { id: true } })
          .catch(() => null);
        if (retry) {
          this.sessionDbId = retry.id;
          return retry.id;
        }
        console.error('[ssh-stream] could not allocate Session row:', err?.message || err);
        return null;
      }
    })();
    const result = await this.dbSessionPromise;
    if (!result) this.dbSessionPromise = null; // allow retry on next subscribe
    return result;
  }

  handlePtyData(data) {
    // Fan-out to live subscribers.
    for (const sub of this.subscribers.values()) {
      sendBinary(sub.ws, data);
    }
    // Append to recent buffer (in-memory shorthand for replay).
    this.recentBuffer.push(data);
    this.recentBytes += Buffer.byteLength(data);
    while (this.recentBytes > RECENT_BUFFER_BYTES && this.recentBuffer.length > 1) {
      const dropped = this.recentBuffer.shift();
      this.recentBytes -= Buffer.byteLength(dropped);
    }
    // Persist asynchronously so a slow disk can't backpressure the pty.
    // Errors are logged but don't propagate — the live attach keeps
    // working even if SQLite is unhappy.
    if (this.sessionDbId) {
      appendScrollback(this.prisma, this.sessionDbId, data).catch((err) => {
        console.error('[ssh-scrollback]', err?.message || err);
      });
    }
  }

  broadcastExit() {
    for (const sub of this.subscribers.values()) {
      try {
        sub.ws.send(JSON.stringify({ type: 'exit' }));
      } catch {}
      try { sub.ws.close(1000, 'ssh exited'); } catch {}
    }
    this.subscribers.clear();
  }

  /**
   * Hook up a browser WS as a subscriber. Returns a teardown handle that
   * the caller invokes on ws close. The caller is responsible for closing
   * the ws on fatal subscribe errors (we throw).
   *
   * Multi-subscriber resize uses smallest-wins: the pty is sized to the
   * minimum cols/rows across all attached subscribers so a small mobile
   * client doesn't get mangled output when a desktop is also attached.
   */
  async subscribe(ws, cols, rows, options = {}) {
    if (!this.alive) throw new Error('stream already torn down');
    // Cancel any pending idle teardown — we have a subscriber again.
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const subscriberId = `sub_${++this.subSeq}_${Date.now()}`;
    const sub = {
      ws,
      cols: clampDim(cols, 80, 20, 500),
      rows: clampDim(rows, 24, 5, 200),
      readOnly: Boolean(options.readOnly)
    };
    this.subscribers.set(subscriberId, sub);
    // Read-only subscribers (share-link viewers) don't influence pty
    // sizing — their window size shouldn't shrink the pty for the
    // owner. Only writers participate in the smallest-wins calculation.
    if (!sub.readOnly) this.recomputePtySize();
    // Wire close handler SYNCHRONOUSLY before any await. If the WS closes
    // during the scrollback fetch below, this handler still fires and
    // unsubscribes us cleanly. Previously the caller wired close after
    // `await subscribe(ws)`, which left a permanent dangling subscriber
    // when the ws closed mid-replay (idle teardown checks size > 0 so an
    // abandoned-during-subscribe stream would keep the pty alive forever).
    const handleClose = () => {
      ws.off('close', handleClose);
      this.unsubscribe(subscriberId);
    };
    ws.on('close', handleClose);

    // Inbound message handler also goes here, pre-await — input typed
    // while we're still streaming scrollback is rare but valid; flush it
    // to the pty as it arrives instead of dropping the first few keys.
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.handleSubscriberMessage(subscriberId, msg);
    });

    // Replay history before live data so the user sees a coherent stream:
    // 1) DB tail (chunks OLDER than what's in the recent buffer),
    // 2) recent buffer (the last ~64KB held in memory).
    //
    // We fetch the newest 200 chunks (desc) then reverse so writes go in
    // chronological order. The previous "asc + take 200" got the OLDEST
    // 200 chunks, which is the opposite of what a late joiner wants.
    //
    // Dedup: the recent buffer mirrors the most-recent pty output that
    // appendScrollback has also persisted. Without dedup the late joiner
    // sees the tail twice. We compute the total size of the recent
    // buffer in bytes and skip a prefix of the DB tail that overlaps.
    const dbId = await this.ensureDbSession();
    // After an await, the stream may have been disposed (host removed,
    // pty exit). Bail before sending any frames to a doomed ws.
    if (!this.alive) {
      this.subscribers.delete(subscriberId);
      throw new Error('stream torn down during subscribe');
    }
    if (dbId) {
      try {
        // Snapshot the recent-buffer entry count BEFORE the DB read. That
        // count tells us exactly how many trailing DB chunks will be
        // re-emitted by `for (const data of this.recentBuffer)` below —
        // appendScrollback writes one chunk per handlePtyData call and
        // each call also pushes one entry into recentBuffer, so the
        // mapping is 1:1 for the in-memory window. Skipping that many
        // chunks from the end of the DB tail cleanly avoids the late
        // joiner seeing the most-recent output twice.
        const recentEntryCount = this.recentBuffer.length;
        const tail = await this.prisma.scrollbackChunk.findMany({
          where: { sessionId: dbId },
          orderBy: { createdAt: 'desc' },
          select: { data: true },
          // Fetch newest-first; we reverse below for chronological writes.
          // 200 ≈ several screenfuls; tune later if users want more.
          take: 200
        });
        if (!this.alive) {
          this.subscribers.delete(subscriberId);
          throw new Error('stream torn down during subscribe');
        }
        tail.reverse();
        const dbSlice = recentEntryCount > 0 && tail.length > recentEntryCount
          ? tail.slice(0, tail.length - recentEntryCount)
          : (recentEntryCount >= tail.length ? [] : tail);
        for (const chunk of dbSlice) sendBinary(ws, chunk.data);
      } catch (err) {
        if (err?.message === 'stream torn down during subscribe') throw err;
        console.error('[ssh-stream] scrollback fetch failed:', err?.message || err);
      }
    }
    for (const data of this.recentBuffer) sendBinary(ws, data);

    // Initial control frame so the pane drops out of "connecting" state.
    sendJson(ws, { type: 'driver-changed', driver: !sub.readOnly, readOnly: sub.readOnly });
    this.broadcastSubscriberCount();
  }

  handleSubscriberMessage(subscriberId, msg) {
    if (!this.alive) return;
    const sub = this.subscribers.get(subscriberId);
    if (!sub) return;
    if (msg.type === 'input' && typeof msg.data === 'string') {
      // Read-only viewers (share link recipients) can't drive the pty.
      // Silently drop their keystrokes — surface a one-time hint via
      // the driver-changed flag they already received on subscribe.
      if (sub.readOnly) return;
      if (msg.data.length > 64 * 1024) return;
      try { this.pty.write(msg.data); } catch {}
      return;
    }
    if (msg.type === 'resize') {
      // Read-only subscribers don't influence pty dimensions, period.
      if (sub.readOnly) return;
      sub.cols = clampDim(msg.cols, sub.cols, 20, 500);
      sub.rows = clampDim(msg.rows, sub.rows, 5, 200);
      this.recomputePtySize();
      return;
    }
    // Deliberately no 'kill' handler: a single subscriber should not be
    // able to tear down a stream that other browsers (or a CLI attach)
    // are sharing. Detach by closing the WS; the stream tears itself
    // down via idle teardown when the last subscriber leaves.
  }

  /**
   * Tell every subscriber the new subscriber count. Fires on subscribe /
   * unsubscribe so each browser can show a "👁 N" chip when more than one
   * client is attached. Lightweight — one int per change event.
   */
  broadcastSubscriberCount() {
    const count = this.subscribers.size;
    for (const sub of this.subscribers.values()) {
      try { sub.ws.send(JSON.stringify({ type: 'subscribers', count })); } catch {}
    }
  }

  /**
   * Resize the pty to the smallest cols/rows reported by any active
   * subscriber. This avoids the "fight" where two browsers with different
   * window sizes thrash the pty between two dimensions; instead we honor
   * the smallest, which means everyone gets readable output (smaller
   * clients aren't truncated by a too-wide pty).
   */
  recomputePtySize() {
    if (this.subscribers.size === 0) return;
    let minCols = Infinity;
    let minRows = Infinity;
    for (const sub of this.subscribers.values()) {
      if (sub.cols < minCols) minCols = sub.cols;
      if (sub.rows < minRows) minRows = sub.rows;
    }
    if (!Number.isFinite(minCols) || !Number.isFinite(minRows)) return;
    if (minCols === this.cols && minRows === this.rows) return;
    this.cols = minCols;
    this.rows = minRows;
    try { this.pty.resize(this.cols, this.rows); } catch {}
  }

  unsubscribe(subscriberId) {
    const sub = this.subscribers.get(subscriberId);
    if (!sub) return;
    this.subscribers.delete(subscriberId);
    // A leaving subscriber may have been the smallest dimension cap. Let
    // the remaining subscribers reclaim their full window.
    this.recomputePtySize();
    // Tell remaining viewers the count dropped.
    this.broadcastSubscriberCount();
    if (this.subscribers.size === 0 && this.alive) {
      // Start the idle teardown timer. If another subscriber joins
      // before it fires, the timer is cancelled. Without idle teardown
      // an abandoned attach would keep the ssh subprocess running
      // forever.
      this.idleTimer = setTimeout(() => {
        if (this.subscribers.size === 0) this.dispose('idle teardown');
      }, IDLE_TEARDOWN_MS);
      this.idleTimer.unref?.();
    }
  }

  /**
   * Final cleanup. Idempotent via the `disposed` flag — earlier versions
   * keyed off `alive && subscribers.size > 0` which silently no-op'd when
   * dispose was called from the pty.onExit handler (which had already
   * cleared subscribers via broadcastExit). That left the stream entry
   * leaked in the registry Map AND any pending idleTimer still queued,
   * which would later fire dispose against the dead stream — a slow leak
   * proportional to the number of remote tmux sessions that ever exited.
   */
  dispose(reason) {
    if (this.disposed) return;
    this.disposed = true;
    this.alive = false;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const sub of this.subscribers.values()) {
      try { sub.ws.close(1000, reason); } catch {}
    }
    this.subscribers.clear();
    try { this.pty.kill(); } catch {}
    try { this.onDispose(); } catch {}
  }
}

function clampDim(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function sendBinary(ws, data) {
  if (ws.readyState !== WebSocket.OPEN || !data) return;
  ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
}

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch {}
}

module.exports = { createSshStreamRegistry };
