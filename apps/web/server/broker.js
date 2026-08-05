const crypto = require("node:crypto");
const { WebSocket } = require("ws");
const { getToken } = require("next-auth/jwt");
const { appendScrollback, readScrollback, startScrollbackPrune } = require("./scrollback");
const { createSshHostLifecycle } = require("./ssh-host-lifecycle");
const { reconcileInventory } = require("./inventory-v2");
const { createBrokerRpc } = require("./broker-rpc");
const { createTerminalCheckpointStore } = require("./terminal-checkpoint-store");
const { createTmuxStatusClassifier } = require("./tmux-status");

// Wire-protocol constant shared with the agent. Keep in sync with
// Keep this in sync with the Rust agent's replacement close handling.
const WS_REPLACED_REASON = "replaced";
// Real agent tokens are `tmag_` + 43-char base64url(32) = 48 chars. Floor
// of 32 / cap of 256 keeps a generous band while preventing blind probes
// of arbitrary-shaped strings from reaching the DB-backed hash lookup.
const AGENT_TOKEN_MIN_LENGTH = 32;
const AGENT_TOKEN_MAX_LENGTH = 256;
const VALID_SESSION_STATUSES = new Set([
  "blocked",
  "working",
  "done",
  "idle",
  "unknown",
  "offline",
  // Protocol v1 compatibility during the Rust rollout.
  "waiting",
  "error",
  "sleeping",
]);

function sendJson(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Terminal output goes as a raw binary frame — drops JSON-string overhead
// (escape chars, type wrapper) and combines well with permessage-deflate.
// Browser sets ws.binaryType='arraybuffer' and writes received bytes directly
// into xterm. Control messages (ready/sleeping/exit/refresh/agent) stay JSON.
function sendOutput(ws, data) {
  if (ws.readyState !== WebSocket.OPEN || !data) {
    return false;
  }
  if (ws.bufferedAmount > WS_SEND_HIGH_WATER) {
    return false;
  }
  ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  return true;
}

async function sendReplayChunks(ws, chunks, isCurrent = () => true) {
  const deadline = Date.now() + 30_000;
  for (const data of chunks) {
    while (
      isCurrent() &&
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount > WS_SEND_LOW_WATER
    ) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise(resolve => {
        const timer = setTimeout(resolve, BACKPRESSURE_RETRY_MS);
        timer.unref?.();
      });
    }
    if (!isCurrent() || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  }
  return true;
}

const COALESCE_MS = 16; // ~60fps flush — imperceptible latency
const PAUSE_DROP_LIMIT = 64 * 1024; // bytes buffered while paused; older bytes dropped
const ACTIVE_BUFFER_LIMIT = 256 * 1024;
const WS_SEND_HIGH_WATER = 1024 * 1024;
const WS_SEND_LOW_WATER = 256 * 1024;
const BACKPRESSURE_RETRY_MS = 50;

function asBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
}

function bufferedBytes(stream) {
  return stream.outBytes || 0;
}

function clearOutputBuffer(stream) {
  stream.outChunks = [];
  stream.outBytes = 0;
}

function markNeedsResync(stream, reason) {
  clearOutputBuffer(stream);
  stream.needsResync = true;
  stream.resyncReason = reason || "terminal output fell behind";
}

function scheduleFlush(stream, delay = COALESCE_MS) {
  if (stream.flushTimer) {
    return;
  }
  stream.flushTimer = setTimeout(() => {
    stream.flushTimer = null;
    flushStream(stream);
  }, delay);
  stream.flushTimer.unref?.();
}

function bufferAndFlush(stream, data) {
  if (!stream || !data) {
    return;
  }
  if (stream.needsResync) {
    scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
    return;
  }
  const chunk = asBuffer(data);
  stream.outChunks ||= [];
  stream.outChunks.push(chunk);
  stream.outBytes = bufferedBytes(stream) + chunk.length;
  if (stream.paused) {
    if (stream.outBytes > PAUSE_DROP_LIMIT) {
      markNeedsResync(stream, "output changed while this terminal was paused");
      stream.pausedTrimmed = true;
    }
    return;
  }
  if (stream.outBytes > ACTIVE_BUFFER_LIMIT) {
    markNeedsResync(stream, "browser could not keep up with terminal output");
    scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
    return;
  }
  scheduleFlush(stream);
}

function flushStream(stream) {
  if (!stream) {
    return;
  }
  if (stream.paused) {
    return;
  }
  if (stream.needsResync) {
    if (stream.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (stream.ws.bufferedAmount > WS_SEND_LOW_WATER) {
      scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
      return;
    }
    if (!stream.resyncSent) {
      stream.resyncSent = true;
      sendJson(stream.ws, {
        type: "resync",
        message: stream.resyncReason || "terminal state needs a fresh checkpoint",
      });
    }
    return;
  }
  if (!bufferedBytes(stream)) {
    return;
  }
  if (stream.ws.bufferedAmount > WS_SEND_HIGH_WATER) {
    if (stream.outBytes > ACTIVE_BUFFER_LIMIT) {
      markNeedsResync(stream, "browser WebSocket remained backpressured");
    }
    scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
    return;
  }
  const data =
    stream.outChunks.length === 1
      ? stream.outChunks[0]
      : Buffer.concat(stream.outChunks, stream.outBytes);
  clearOutputBuffer(stream);
  if (!sendOutput(stream.ws, data)) {
    stream.outChunks = [data];
    stream.outBytes = data.length;
    scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
  }
}

// Agent protocol v2.1 binary terminal frame:
//   4 bytes "TMG2", 1 byte flags (bit 0 = full checkpoint), 4 byte sequence,
//   2 byte stream-id length, UTF-8 stream id, then raw terminal bytes.
const AGENT_TERMINAL_MAGIC = Buffer.from("TMG2");
const AGENT_TERMINAL_HEADER_BYTES = 11;

function parseAgentTerminalFrame(raw) {
  const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (frame.length < AGENT_TERMINAL_HEADER_BYTES) {
    return null;
  }
  if (!frame.subarray(0, 4).equals(AGENT_TERMINAL_MAGIC)) {
    return null;
  }
  const flags = frame[4];
  const sequence = frame.readUInt32BE(5);
  const streamIdLength = frame.readUInt16BE(9);
  const payloadStart = AGENT_TERMINAL_HEADER_BYTES + streamIdLength;
  if (streamIdLength === 0 || streamIdLength > 512 || payloadStart > frame.length) {
    return null;
  }
  const streamId = frame.subarray(AGENT_TERMINAL_HEADER_BYTES, payloadStart).toString("utf8");
  return {
    streamId,
    sequence,
    full: (flags & 1) === 1,
    checkpointContinuation: (flags & (1 << 1)) !== 0,
    checkpointEnd: (flags & (1 << 2)) !== 0,
    data: frame.subarray(payloadStart),
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookieHeader(header) {
  const cookies = {};
  if (!header) {
    return cookies;
  }
  const value = Array.isArray(header) ? header.join(";") : header;
  for (const part of value.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (!name) {
      continue;
    }
    const rawCookieValue = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawCookieValue);
    } catch {
      cookies[name] = rawCookieValue;
    }
  }
  return cookies;
}

function trustedNetworkEnabled() {
  // Opt-in. Set TERMAG_TRUSTED_NETWORK=true to bypass OAuth when behind a
  // private-network ACL. Default is OAuth — secure-by-default for fresh
  // deployments. Must stay in sync with apps/web/lib/auth.ts.
  return process.env.TERMAG_TRUSTED_NETWORK === "true";
}

function trustedUserEmail() {
  return (
    process.env.TERMAG_TRUSTED_USER_EMAIL?.toLowerCase().trim() ||
    process.env.TERMAG_ALLOWED_EMAIL?.toLowerCase().trim() ||
    "trusted@termag.local"
  );
}

/**
 * Cleans an untrusted string we received from an agent before re-emitting
 * it (typically as the .message of an Error that will surface in a JSON
 * response, or in a status broadcast). Strips C0/C1 control bytes that
 * could inject ANSI sequences or line breaks into the UI, and caps length
 * so a runaway agent can't bloat browser responses.
 */
// Bounded cache of recently-rejected token hashes. A short-lived (5 min)
// memory of "this hash isn't in our DB" lets us short-circuit a repeat
// guess from the same attacker before a Prisma round-trip. Capped so a
// rotating-token attacker can't pump it to OOM. Values are the expiration
// timestamp; we check it lazily on read.
const REJECTED_TOKEN_TTL_MS = 5 * 60 * 1000;
const REJECTED_TOKEN_CAP = 5000;
const rejectedTokenExpiry = new Map();

function tokenRecentlyRejected(hash) {
  const exp = rejectedTokenExpiry.get(hash);
  if (!exp) {
    return false;
  }
  if (exp < Date.now()) {
    rejectedTokenExpiry.delete(hash);
    return false;
  }
  return true;
}

function rememberRejectedToken(hash) {
  const now = Date.now();
  rejectedTokenExpiry.set(hash, now + REJECTED_TOKEN_TTL_MS);
  if (rejectedTokenExpiry.size <= REJECTED_TOKEN_CAP) {
    return;
  }
  // Sweep expired first; if we're still over the cap, drop oldest by
  // insertion order (Map iteration order is insertion order).
  for (const [h, exp] of rejectedTokenExpiry) {
    if (exp < now) {
      rejectedTokenExpiry.delete(h);
    }
  }
  while (rejectedTokenExpiry.size > REJECTED_TOKEN_CAP) {
    const firstKey = rejectedTokenExpiry.keys().next().value;
    if (firstKey === undefined) {
      break;
    }
    rejectedTokenExpiry.delete(firstKey);
  }
}

function sanitizeAgentText(value, maxLen = 1024) {
  if (typeof value !== "string") {
    return "";
  }

  const stripped = value.replace(/[\x00-\x1F\x7F-\x9F]/g, " ");
  return stripped.length > maxLen ? stripped.slice(0, maxLen - 1) + "…" : stripped;
}

function terminalDimension(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

const REPLAY_QUEUE_CAP = 256 * 1024;
const REPLAY_QUEUE_TRIM = 192 * 1024;

function pushReplayQueue(stream, data) {
  if (!data) {
    return;
  }
  const chunk = asBuffer(data);
  stream.replayQueue.push(chunk);
  stream.replayQueueBytes += chunk.length;
  if (stream.replayQueueBytes <= REPLAY_QUEUE_CAP) {
    return;
  }
  stream.replayQueueTruncated = true;
  while (stream.replayQueueBytes > REPLAY_QUEUE_TRIM && stream.replayQueue.length > 1) {
    const dropped = stream.replayQueue.shift();
    stream.replayQueueBytes -= dropped.length;
  }
}

function passwordGateEnabled() {
  return trustedNetworkEnabled() && Boolean(process.env.TERMAG_PASSWORD);
}

function expectedPasswordCookie() {
  return crypto
    .createHash("sha256")
    .update(process.env.TERMAG_PASSWORD || "")
    .digest("hex");
}

function safeTimingEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function passwordCookieValid(cookies) {
  if (!passwordGateEnabled()) {
    return true;
  }
  const expected = expectedPasswordCookie();
  const got = cookies["termag-auth"];
  return Boolean(got && safeTimingEqual(got, expected));
}

async function userIdFromRequest(req, prisma) {
  // Bearer token (CLI / non-browser clients) — checked first so a session
  // cookie left behind in a terminal session doesn't take precedence over
  // the explicit Authorization header that termag attach / list pass.
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    const bearer = match?.[1]?.trim();
    if (
      bearer &&
      bearer.length >= AGENT_TOKEN_MIN_LENGTH &&
      bearer.length <= AGENT_TOKEN_MAX_LENGTH
    ) {
      const record = await prisma.agentToken.findFirst({
        where: { tokenHash: hashToken(bearer), revokedAt: null },
        select: { id: true, userId: true },
      });
      if (record) {
        prisma.agentToken
          .update({
            where: { id: record.id },
            data: { lastUsedAt: new Date() },
          })
          .catch(() => {});
        return record.userId;
      }
    }
  }
  if (trustedNetworkEnabled()) {
    if (!passwordCookieValid(parseCookieHeader(req.headers.cookie))) {
      return null;
    }
    const user = await prisma.user.upsert({
      where: { email: trustedUserEmail() },
      update: {},
      create: { email: trustedUserEmail(), displayName: "Trusted User", theme: "dark" },
    });
    return user.id;
  }
  const token = await getToken({
    req: { headers: req.headers, cookies: parseCookieHeader(req.headers.cookie) },
    secret: process.env.NEXTAUTH_SECRET,
  });
  return token?.sub;
}

/**
 * Builds the in-memory broker that owns:
 *  - the laptop-agent connection per user (`agents`)
 *  - browser terminal streams (`browserStreams`)
 *  - the primary stream per session for scrollback ownership (`sessionPrimary`)
 *
 * Returns the registration entry points called from the WebSocket upgrade
 * handler, plus a `killTmux` helper the Next.js
 * route handlers reach through globalThis.
 */
function createBroker({ prisma, wss }) {
  const agents = new Map();
  const inventoryReconciliations = new Map();
  const browserStreams = new Map();
  const sessionPrimary = new Map();
  // Last PTY fast-path status we received per session, with the epoch-ms it
  // landed. The poll classifier prefers this over poll facts while it's
  // fresh AND the session still has an attached browser stream — the PTY
  // path reacts to live output/BEL faster than the 30s health tick.
  const ptyStatusBySession = new Map(); // sessionId -> { status, at }
  const terminalState = createTerminalCheckpointStore({
    activeSessionIds: () =>
      new Set([...browserStreams.values()].map(stream => stream.sessionId).filter(Boolean)),
  });
  // A window whose last output is younger than this counts as actively
  // working — fresh output beats a stale bell flag. Env-overridable to match
  // the health interval used by the Rust agent.
  const WORKING_THRESHOLD_SEC = Number(process.env.TERMAG_WORKING_THRESHOLD_SEC) || 8;
  // How long a PTY-reported status stays authoritative before the poll
  // classifier takes back over (the PTY path stops refreshing on output stop).
  const PTY_FRESH_MS = Number(process.env.TERMAG_PTY_FRESH_MS) || 5000;
  const tmuxStatus = createTmuxStatusClassifier({
    ptyStatuses: ptyStatusBySession,
    workingThresholdSec: WORKING_THRESHOLD_SEC,
    ptyFreshMs: PTY_FRESH_MS,
    hasAttachedViewer: sessionId =>
      [...browserStreams.values()].some(
        stream => stream.sessionId === sessionId && stream.attached === true
      ),
  });
  const sshLifecycle = createSshHostLifecycle({
    prisma,
    broadcastStatus,
    sendJson,
    sanitizeText: sanitizeAgentText,
  });
  const TRANSIENT_STATE_TTL_MS = 10 * 60 * 1000;
  let seq = 0;

  const transientStateSweep = setInterval(() => {
    const cutoff = Date.now() - TRANSIENT_STATE_TTL_MS;
    const activeSessions = new Set(
      [...browserStreams.values()].map(stream => stream.sessionId).filter(Boolean)
    );
    for (const [sessionId, state] of ptyStatusBySession) {
      if (state.at < cutoff && !activeSessions.has(sessionId)) {
        ptyStatusBySession.delete(sessionId);
      }
    }
    terminalState.sweep();
  }, 60_000);
  transientStateSweep.unref?.();

  // Schedule the scrollback TTL prune as part of broker boot. Runs once
  // immediately so a freshly-started broker that's been off for a while
  // catches up; afterwards it ticks every 6h. The handle is .unref()'d
  // inside startScrollbackPrune so it doesn't keep the process alive.
  startScrollbackPrune(prisma);

  function nextRequestId() {
    seq += 1;
    return `req_${seq}_${Date.now()}`;
  }

  function agentsForUser(userId) {
    return agents.get(userId) || new Map();
  }

  function publicAgentStatus(agent) {
    return {
      name: agent.deviceName,
      deviceId: agent.tokenId,
      connected: agent.ws.readyState === WebSocket.OPEN,
      lastSeenAt: agent.lastSeenAt?.toISOString?.() || null,
      protocolVersion: agent.protocolVersion || 1,
      capabilities: agent.capabilities || {},
      runtimeSessions: Array.isArray(agent.inventory?.runtimes)
        ? agent.inventory.runtimes.map(runtime => ({
            kind: runtime.kind,
            available: runtime.available,
            sessions: Array.isArray(runtime.sessions)
              ? runtime.sessions.map(session => ({ id: session.id, name: session.name }))
              : [],
          }))
        : [],
      ...(agent.health || {}),
    };
  }

  function deviceStatuses(userId) {
    return [...connectedAgents(userId).map(publicAgentStatus), ...sshLifecycle.statuses(userId)];
  }

  function streamBelongsToAgent(stream, userId, deviceName) {
    return stream?.userId === userId && stream.deviceName === deviceName;
  }

  function routeSharedTerminalData(userId, deviceName, frame) {
    const anchor = browserStreams.get(frame.streamId);
    if (!streamBelongsToAgent(anchor, userId, deviceName)) {
      return;
    }
    if (!frame.data || frame.data.length > 256 * 1024) {
      return;
    }

    const checkpointResult = terminalState.ingest(anchor.sessionId, frame);
    if (checkpointResult.gap) {
      // A checkpoint plus ANSI deltas is only replayable as one contiguous
      // byte sequence. Once any frame is missing, retaining/appending to that
      // cache would make the next viewer's screen plausibly but silently
      // corrupt, so discard it and force a fresh runtime checkpoint.
      for (const stream of browserStreams.values()) {
        if (
          stream.sessionId === anchor.sessionId &&
          streamBelongsToAgent(stream, userId, deviceName)
        ) {
          markNeedsResync(stream, "terminal frame sequence was interrupted");
          scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
        }
      }
      return;
    }

    for (const stream of browserStreams.values()) {
      if (
        stream.sessionId !== anchor.sessionId ||
        !streamBelongsToAgent(stream, userId, deviceName)
      ) {
        continue;
      }
      if (frame.full) {
        if (stream.replaying) {
          stream.replayEpoch += 1;
        }
        stream.needsResync = false;
        stream.resyncSent = false;
        clearOutputBuffer(stream);
        sendJson(stream.ws, { type: "checkpoint", sequence: frame.sequence });
      }
      if (stream.replaying) {
        pushReplayQueue(stream, frame.data);
      } else {
        bufferAndFlush(stream, frame.data);
      }
    }

    if (anchor.persistScrollback) {
      appendScrollback(prisma, anchor.sessionId, frame.data).catch(error =>
        console.error("[scrollback]", error instanceof Error ? error.message : String(error))
      );
    }
  }

  function connectedAgents(userId) {
    return [...agentsForUser(userId).values()].filter(
      agent => agent.ws.readyState === WebSocket.OPEN
    );
  }

  function agentForUser(userId, deviceName) {
    const userAgents = agentsForUser(userId);
    const exact = deviceName ? userAgents.get(deviceName) : null;
    if (exact?.ws.readyState === WebSocket.OPEN) {
      return exact;
    }
    if (deviceName) {
      return null;
    }
    const live = [...userAgents.values()].filter(agent => agent.ws.readyState === WebSocket.OPEN);
    return live.length > 0 ? live[0] : null;
  }

  function setAgent(userId, deviceName, agent) {
    let userAgents = agents.get(userId);
    if (!userAgents) {
      userAgents = new Map();
      agents.set(userId, userAgents);
    }
    userAgents.set(deviceName, agent);
  }

  function removeAgent(userId, deviceName, ws) {
    const userAgents = agents.get(userId);
    if (!userAgents || userAgents.get(deviceName)?.ws !== ws) {
      return false;
    }
    userAgents.delete(deviceName);
    if (userAgents.size === 0) {
      agents.delete(userId);
    }
    return true;
  }

  async function reconcileAgentInventory(agent, rawSnapshot) {
    const key = `${agent.userId}\u0000${agent.deviceName}`;
    const previous = inventoryReconciliations.get(key) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => {
        // Serialize old/new connections for the same device. This prevents a
        // slow snapshot from the replaced socket from committing after the
        // replacement's newer tree and resurrecting stale local state.
        if (agentsForUser(agent.userId).get(agent.deviceName) !== agent) {
          return null;
        }
        return reconcileInventory({
          prisma,
          userId: agent.userId,
          deviceId: agent.tokenId,
          deviceName: agent.deviceName,
          rawSnapshot,
        });
      });
    inventoryReconciliations.set(key, task);
    try {
      return await task;
    } finally {
      if (inventoryReconciliations.get(key) === task) {
        inventoryReconciliations.delete(key);
      }
    }
  }

  function sendToAgent(userId, deviceName, type, payload = {}, timeoutMs = 15000) {
    const agent = agentForUser(userId, deviceName);
    if (!agent) {
      return Promise.reject(new Error("Agent offline"));
    }
    const requestId = nextRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.pending.delete(requestId);
        reject(new Error(`${type} timed out`));
      }, timeoutMs);
      agent.pending.set(requestId, { resolve, reject, timer });
      sendJson(agent.ws, { requestId, type, ...payload });
    });
  }

  function sendAgentEvent(userId, deviceName, type, payload = {}, legacyTimeoutMs = 1000) {
    const agent = agentForUser(userId, deviceName);
    if (!agent) {
      return false;
    }
    if ((agent.protocolVersion || 1) >= 2) {
      // High-frequency terminal input/resize messages do not need a reply.
      // Omitting requestId keeps large pastes from allocating one Promise,
      // timeout, and pending-map entry per chunk in the cloud broker.
      sendJson(agent.ws, { type, ...payload });
      return true;
    }
    sendToAgent(userId, deviceName, type, payload, legacyTimeoutMs).catch(() => {});
    return true;
  }

  function claimPrimary(sessionId, streamId) {
    if (!sessionPrimary.has(sessionId)) {
      sessionPrimary.set(sessionId, streamId);
    }
  }

  function releasePrimary(sessionId, streamId) {
    if (sessionPrimary.get(sessionId) !== streamId) {
      return;
    }
    sessionPrimary.delete(sessionId);
    for (const [otherId, other] of browserStreams) {
      if (other.sessionId === sessionId) {
        sessionPrimary.set(sessionId, otherId);
        return;
      }
    }
  }

  async function updateProjectStatus(projectId) {
    const sessions = await prisma.session.findMany({
      where: { projectId },
      select: { status: true },
    });
    const statuses = sessions.map(session => session.status);
    const status =
      ["blocked", "error", "working", "waiting", "done", "idle", "unknown", "offline"].find(
        candidate => statuses.includes(candidate)
      ) || "sleeping";
    const project = await prisma.project
      .findUnique({
        where: { id: projectId },
        select: { status: true },
      })
      .catch(() => null);
    if (project?.status !== status) {
      await prisma.project.update({ where: { id: projectId }, data: { status } }).catch(() => {});
    }
    return status;
  }

  async function reconcileDeviceTmuxStatus(userId, deviceName, tmuxSessions) {
    const tmuxState = tmuxStatus.buildLiveState(tmuxSessions);
    const sessions = await prisma.session.findMany({
      where: { project: { userId, rootKey: deviceName } },
      select: {
        id: true,
        projectId: true,
        tabId: true,
        tmuxName: true,
        tmuxWindowName: true,
        status: true,
        project: { select: { tmuxSessionName: true, status: true } },
        tab: { select: { status: true } },
      },
    });
    const now = new Date();
    const updates = [];
    const projectStatuses = new Map();
    let changed = false;

    for (const session of sessions) {
      projectStatuses.set(session.projectId, session.project.status);
      const live = tmuxStatus.isLive(session, tmuxState);
      const nextStatus = live
        ? tmuxStatus.classify(session, tmuxStatus.factsFor(session, tmuxState))
        : "sleeping";
      if (session.status !== nextStatus) {
        changed = true;
        updates.push(
          prisma.session
            .update({
              where: { id: session.id },
              data:
                nextStatus === "sleeping"
                  ? { status: nextStatus }
                  : { status: nextStatus, lastSeenAt: now },
            })
            .catch(() => {})
        );
      } else if (live) {
        updates.push(
          prisma.session
            .update({
              where: { id: session.id },
              data: { lastSeenAt: now },
            })
            .catch(() => {})
        );
      }
      if (session.tabId && session.tab?.status !== nextStatus) {
        changed = true;
        updates.push(
          prisma.tab
            .update({ where: { id: session.tabId }, data: { status: nextStatus } })
            .catch(() => {})
        );
      }
    }

    await Promise.all(updates);
    for (const [projectId, oldStatus] of projectStatuses) {
      const nextStatus = await updateProjectStatus(projectId);
      if (nextStatus !== oldStatus) {
        changed = true;
      }
    }
    return changed;
  }

  function broadcastStatus(userId, refresh = false, projectPatches = null) {
    const devices = deviceStatuses(userId);
    for (const client of wss.clients) {
      if (client._termagStatusUserId === userId && client.readyState === WebSocket.OPEN) {
        sendJson(client, {
          type: "agent",
          connected: devices.some(device => device.connected),
          devices,
        });
        if (refresh) {
          sendJson(client, { type: "refresh" });
        } else if (Array.isArray(projectPatches) && projectPatches.length > 0) {
          sendJson(client, { type: "projects.patch", projects: projectPatches });
        }
      }
    }
  }

  async function registerAgent(ws, token) {
    if (
      typeof token !== "string" ||
      token.length < AGENT_TOKEN_MIN_LENGTH ||
      token.length > AGENT_TOKEN_MAX_LENGTH ||
      !token.startsWith("tmag_")
    ) {
      ws.close(1008, "invalid token");
      return;
    }
    // Suppress the DB lookup when we've recently rejected this exact token
    // hash. Stops a probing attacker from forcing one indexed Prisma read
    // per guess (each is ~1 ms but adds up at thousands/sec).
    const tokenHash = hashToken(token);
    if (tokenRecentlyRejected(tokenHash)) {
      ws.close(1008, "invalid token");
      return;
    }
    const record = await prisma.agentToken.findFirst({
      where: { tokenHash, revokedAt: null },
      include: { user: true },
    });
    if (!record) {
      rememberRejectedToken(tokenHash);
      ws.close(1008, "invalid token");
      return;
    }

    await prisma.agentToken.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    });

    const deviceName = record.name || "Local device";
    const existing = agentsForUser(record.userId).get(deviceName);
    if (existing) {
      // Eagerly reject any in-flight requests pinned to the outgoing agent.
      // Without this they would block on their own 15s timeout — long enough
      // for browser attaches issued during the replacement window to feel
      // frozen even though the new agent is already up.
      for (const pending of existing.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Agent replaced by a newer connection"));
      }
      existing.pending.clear();
      if (existing.ws.readyState === WebSocket.OPEN) {
        existing.ws.close(1000, WS_REPLACED_REASON);
      }
    }

    const agent = {
      ws,
      userId: record.userId,
      deviceName,
      tokenId: record.id,
      pending: new Map(),
      lastSeenAt: new Date(),
      health: null,
      protocolVersion: 1,
      capabilities: {},
      inventory: null,
      inventoryProcessing: false,
      pendingInventory: null,
    };
    setAgent(record.userId, deviceName, agent);

    await prisma.session.updateMany({
      where: { project: { userId: record.userId, rootKey: deviceName } },
      data: { lastSeenAt: new Date() },
    });
    broadcastStatus(record.userId, true);

    // Re-attach any browser streams that were left orphaned by a prior agent disconnect.
    for (const stream of browserStreams.values()) {
      if (
        stream.userId === record.userId &&
        stream.deviceName === deviceName &&
        !stream.attached &&
        !stream.replaying &&
        typeof stream.reattach === "function"
      ) {
        // Skip streams still draining the scrollback snapshot — they'll call
        // attachToAgent themselves once the snapshot is drained.
        stream.reattach().catch(() => {});
      }
    }

    ws.on("message", async (raw, isBinary) => {
      if (isBinary) {
        const frame = parseAgentTerminalFrame(raw);
        if (frame) {
          routeSharedTerminalData(record.userId, deviceName, frame);
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.requestId && agent.pending.has(msg.requestId)) {
        const pending = agent.pending.get(msg.requestId);
        clearTimeout(pending.timer);
        agent.pending.delete(msg.requestId);
        if (msg.error) {
          // Sanitize agent-supplied error strings before raising them as
          // Errors that may be surfaced to browser JSON responses. A
          // compromised agent could otherwise inject ANSI codes, line
          // breaks, or arbitrary-length payloads into the web UI.
          pending.reject(new Error(sanitizeAgentText(msg.error, 512)));
        } else {
          pending.resolve(msg.data ?? {});
        }
        return;
      }

      if (msg.type === "health") {
        agent.lastSeenAt = new Date();
        agent.protocolVersion = Number(msg.protocolVersion) || agent.protocolVersion || 1;
        agent.health = {
          version: typeof msg.version === "string" ? msg.version : null,
          fake: Boolean(msg.fake),
          streamCount: Number.isFinite(Number(msg.streamCount)) ? Number(msg.streamCount) : 0,
          uptimeSec: Number.isFinite(Number(msg.uptimeSec)) ? Number(msg.uptimeSec) : 0,
          memMb: Number.isFinite(Number(msg.memMb)) ? Number(msg.memMb) : 0,
          memPeakMb: Number.isFinite(Number(msg.memPeakMb)) ? Number(msg.memPeakMb) : 0,
          roots: msg.roots && typeof msg.roots === "object" ? msg.roots : {},
          tmuxSessions: tmuxStatus.normalizeSessions(msg.tmux?.sessions),
        };
        const changed =
          agent.protocolVersion >= 2
            ? false
            : await reconcileDeviceTmuxStatus(record.userId, deviceName, msg.tmux?.sessions);
        broadcastStatus(record.userId, changed);
        return;
      }

      if (msg.type === "inventory.snapshot") {
        if (
          Number(msg.protocolVersion) !== 2 ||
          !msg.inventory ||
          typeof msg.inventory !== "object"
        ) {
          return;
        }
        const revision = Number(msg.inventory.revision) || 0;
        if (revision <= (Number(agent.inventory?.revision) || -1)) {
          return;
        }
        // Keep only the newest pending snapshot while a reconciliation is in
        // flight. HerdR can emit a burst of focus/layout/status events; replaying
        // every intermediate tree adds DB churn without adding user-visible state.
        if (!agent.pendingInventory || revision >= agent.pendingInventory.revision) {
          agent.pendingInventory = { revision, msg };
        }
        if (agent.inventoryProcessing) {
          return;
        }
        agent.inventoryProcessing = true;
        void (async () => {
          try {
            while (agent.pendingInventory) {
              const pending = agent.pendingInventory;
              agent.pendingInventory = null;
              if (pending.revision <= (Number(agent.inventory?.revision) || -1)) {
                continue;
              }
              const result = await reconcileAgentInventory(agent, pending.msg.inventory);
              if (!result) {
                break;
              }
              agent.protocolVersion = 2;
              agent.capabilities =
                pending.msg.capabilities && typeof pending.msg.capabilities === "object"
                  ? pending.msg.capabilities
                  : {};
              agent.inventory = result.snapshot;
              agent.lastSeenAt = new Date();
              await prisma.agentToken
                .update({
                  where: { id: record.id },
                  data: {
                    protocolVersion: 2,
                    capabilities: JSON.stringify(agent.capabilities),
                    lastInventoryAt: new Date(),
                  },
                })
                .catch(() => {});
              broadcastStatus(
                record.userId,
                result.structuralChanged,
                result.structuralChanged ? null : result.patches
              );
            }
          } catch (err) {
            console.error("[inventory-v2]", sanitizeAgentText(err?.message || err, 512));
          } finally {
            agent.inventoryProcessing = false;
          }
        })();
        return;
      }

      if (msg.type === "terminal-data" && msg.streamId) {
        const stream = browserStreams.get(msg.streamId);
        if (
          !streamBelongsToAgent(stream, record.userId, deviceName) ||
          typeof msg.data !== "string"
        ) {
          return;
        }
        // Per-message cap. WebSocketServer.maxPayload already bounds the
        // outer frame at 1 MB, but defense in depth — a malicious agent
        // can otherwise pipe gigabytes through appendScrollback over
        // many small frames. Anything legitimate is well under 64 KB.
        if (msg.data.length > 256 * 1024) {
          return;
        }
        bufferAndFlush(stream, msg.data);
        // Replay-queue + scrollback writes are gated on the primary check.
        // With the multi-subscriber model the agent emits one terminal-data
        // per attached browser for every PTY byte, so N subscribers means N
        // copies of the same bytes arrive here. Only one of those streamIds
        // is primary at a time; running the writes for all of them would
        // (a) write each byte N times to the DB and (b) push N copies into
        // any same-session replaying stream's queue, giving the late-joiner
        // N copies of the output.
        if (sessionPrimary.get(stream.sessionId) === msg.streamId) {
          for (const other of browserStreams.values()) {
            if (other === stream || !other.replaying) {
              continue;
            }
            if (other.sessionId !== stream.sessionId) {
              continue;
            }
            pushReplayQueue(other, msg.data);
          }
          appendScrollback(prisma, stream.sessionId, msg.data).catch(err =>
            console.error("[scrollback]", err.message)
          );
        }
        return;
      }

      if (msg.type === "terminal-gap" && msg.streamId) {
        const anchor = browserStreams.get(msg.streamId);
        if (!streamBelongsToAgent(anchor, record.userId, deviceName)) {
          return;
        }
        terminalState.drop(anchor.sessionId);
        for (const stream of browserStreams.values()) {
          if (
            stream.sessionId === anchor.sessionId &&
            streamBelongsToAgent(stream, record.userId, deviceName)
          ) {
            markNeedsResync(stream, "local terminal output exceeded its bounded queue");
            scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
          }
        }
        return;
      }

      if (msg.type === "driver-changed" && msg.streamId) {
        // Agent → broker → browser. The agent's SessionStream re-broadcasts on
        // every driver change so each subscriber knows whether they're the
        // current driver or read-only.
        const stream = browserStreams.get(msg.streamId);
        if (!streamBelongsToAgent(stream, record.userId, deviceName)) {
          return;
        }
        sendJson(stream.ws, {
          type: "driver-changed",
          driver: Boolean(msg.driver),
          readOnly: Boolean(msg.readOnly),
        });
        return;
      }

      if (msg.type === "terminal-exit" && msg.streamId) {
        const stream = browserStreams.get(msg.streamId);
        if (streamBelongsToAgent(stream, record.userId, deviceName)) {
          stream.attached = false;
          sendJson(stream.ws, { type: "exit" });
          const exitedSession = await prisma.session
            .findUnique({
              where: { id: stream.sessionId },
              select: {
                tabId: true,
                projectId: true,
                project: { select: { mirrored: true } },
              },
            })
            .catch(() => null);
          if (exitedSession && !exitedSession.project?.mirrored) {
            await prisma.session
              .update({
                where: { id: stream.sessionId },
                data: { status: "sleeping" },
              })
              .catch(() => {});
          }
          if (exitedSession?.tabId && !exitedSession.project?.mirrored) {
            await prisma.tab
              .update({ where: { id: exitedSession.tabId }, data: { status: "sleeping" } })
              .catch(() => {});
          }
          if (exitedSession?.projectId && !exitedSession.project?.mirrored) {
            await updateProjectStatus(exitedSession.projectId);
          }
          broadcastStatus(stream.userId, true);
        }
        return;
      }

      if (msg.type === "status" && msg.status) {
        if (!VALID_SESSION_STATUSES.has(msg.status)) {
          return;
        }
        // Accept either an explicit sessionId or the PTY fast-path streamId,
        // which we resolve back to its session via the browserStreams map.
        const sessionId = msg.sessionId || browserStreams.get(msg.streamId)?.sessionId;
        if (!sessionId) {
          return;
        }
        const session = await prisma.session
          .findFirst({
            where: { id: sessionId, project: { userId: record.userId, rootKey: deviceName } },
            select: { id: true, tabId: true, projectId: true },
          })
          .catch(() => null);
        if (!session) {
          return;
        }
        // Record the fast-path status so the poll classifier prefers it while
        // fresh (PTY_FRESH_MS) and the session still has an attached browser.
        ptyStatusBySession.set(session.id, { status: msg.status, at: Date.now() });
        await prisma.session
          .update({
            where: { id: session.id },
            data: { status: msg.status, lastSeenAt: new Date() },
          })
          .catch(() => {});
        if (session.tabId) {
          await prisma.tab
            .update({ where: { id: session.tabId }, data: { status: msg.status } })
            .catch(() => {});
        }
        await updateProjectStatus(session.projectId);
        broadcastStatus(record.userId, true);
      }
    });

    ws.on("close", async () => {
      if (!removeAgent(record.userId, deviceName, ws)) {
        return;
      }
      for (const pending of agent.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Agent disconnected"));
      }
      agent.pending.clear();
      for (const stream of browserStreams.values()) {
        if (
          stream.userId === record.userId &&
          stream.deviceName === deviceName &&
          stream.attached
        ) {
          stream.attached = false;
          sendJson(stream.ws, {
            type: "sleeping",
            message: "Agent disconnected; reconnect termag on your laptop.",
          });
        }
      }
      const offlineStatus = agent.protocolVersion >= 2 ? "offline" : "sleeping";
      await prisma.project.updateMany({
        where: { userId: record.userId, rootKey: deviceName },
        data: { status: offlineStatus },
      });
      await prisma.session.updateMany({
        where: { project: { userId: record.userId, rootKey: deviceName } },
        data: { status: offlineStatus },
      });
      await prisma.tab.updateMany({
        where: { project: { userId: record.userId, rootKey: deviceName } },
        data: { status: offlineStatus },
      });
      broadcastStatus(record.userId, true);
    });

    sendJson(ws, {
      type: "hello",
      userId: record.userId,
      deviceName,
      protocolVersion: 2,
      capabilities: { inventorySnapshots: true, typedMutations: true },
    });
  }

  async function registerBrowser(ws, req, url) {
    // Share endpoint is public — the share code itself authenticates
    // the viewer. Handle it before the userIdFromRequest gate so a
    // signed-out user with a valid share link can still attach.
    if (url.pathname === "/api/ws/share-terminal") {
      const code = url.searchParams.get("code");
      const cols = terminalDimension(url.searchParams.get("cols"), 80, 20, 500);
      const rows = terminalDimension(url.searchParams.get("rows"), 24, 5, 200);
      if (!code) {
        ws.close(1008, "code required");
        return;
      }
      await sshLifecycle.handleShareAttach(ws, code, cols, rows);
      return;
    }

    const userId = await userIdFromRequest(req, prisma);
    if (!userId) {
      ws.close(1008, "login required");
      return;
    }

    if (url.pathname === "/api/ws/status") {
      ws._termagStatusUserId = userId;
      // Load SSH host state from the DB on first contact so this browser
      // sees its hosts immediately. We don't AWAIT the refresh — that
      // would block the WS handshake on a slow probe. Instead we send
      // whatever we have synchronously and let the probe broadcast a
      // status update when it lands. refreshSshHosts() itself short-
      // circuits when the user is already loaded, so this is cheap.
      if (!sshLifecycle.hasUser(userId)) {
        sshLifecycle.refresh(userId, { broadcast: true }).catch(() => {});
      }
      const devices = deviceStatuses(userId);
      sendJson(ws, { type: "agent", connected: devices.some(device => device.connected), devices });
      return;
    }

    if (url.pathname === "/api/ws/ssh-terminal") {
      const hostId = url.searchParams.get("hostId");
      const tmuxName = url.searchParams.get("tmuxName");
      const cols = terminalDimension(url.searchParams.get("cols"), 80, 20, 500);
      const rows = terminalDimension(url.searchParams.get("rows"), 24, 5, 200);
      if (!hostId || !tmuxName) {
        ws.close(1008, "hostId and tmuxName required");
        return;
      }
      // Make sure host state is loaded so handleSshAttach can find the
      // record by id. We only block if we don't have the user's hosts
      // yet (e.g., right after broker restart); subsequent attaches
      // skip the load. The handler does its own session-not-known check.
      if (!sshLifecycle.hasUser(userId)) {
        await sshLifecycle.refresh(userId, { broadcast: false });
      }
      await sshLifecycle.handleAttach(ws, userId, hostId, tmuxName, cols, rows);
      return;
    }

    const sessionId = url.searchParams.get("sessionId");
    const cols = terminalDimension(url.searchParams.get("cols"), 80, 20, 500);
    const rows = terminalDimension(url.searchParams.get("rows"), 24, 5, 200);
    const readOnly = url.searchParams.get("readonly") === "1";
    // Mobile / save-data hints. Browser appends `&saveData=1` when the user
    // is on a metered connection or iOS Low Data Mode; UA detects phones.
    const ua = req.headers["user-agent"] || "";
    const saveData = url.searchParams.get("saveData") === "1";
    const isPhone = /iPhone|iPod|Android.*Mobile/.test(ua);
    const lowBandwidth = saveData || isPhone;
    if (!sessionId) {
      ws.close(1008, "sessionId required");
      return;
    }

    const session = await prisma.session.findFirst({
      where: { id: sessionId, project: { userId } },
      include: { project: true, tab: true },
    });
    if (!session) {
      ws.close(1008, "session forbidden");
      return;
    }

    await prisma.project.update({
      where: { id: session.projectId },
      data: { openedAt: new Date() },
    });

    // Register-and-snapshot: register the stream BEFORE reading scrollback so
    // any data the primary stream writes during our read lands in this
    // stream's replayQueue. After the snapshot completes we drain the queue
    // before claiming primary or attaching to the agent, so the byte order
    // the browser sees is: historical chunks → bytes written during replay →
    // live data from our own agent attach. Without this, fast output from
    // another viewer's primary stream during a slow scrollback read would be
    // silently missing from this browser's xterm scrollback (the row still
    // exists in the DB but is invisible until next reconnect).
    const streamId = `stream_${nextRequestId()}`;
    const stream = {
      ws,
      userId,
      deviceName: session.project.rootKey,
      sessionId,
      attached: false,
      attachPromise: null,
      cols,
      rows,
      readOnly,
      persistScrollback: !session.project.mirrored,
      // While true, terminal-data handlers push live bytes to replayQueue so
      // they cannot overtake the bounded history/checkpoint being drained.
      // Mirrored runtimes skip DB history but still need this ordering gate
      // while an in-memory checkpoint is backpressured to the browser.
      replaying: true,
      replayQueue: [],
      replayQueueBytes: 0,
      replayQueueTruncated: false,
      replayEpoch: 0,
      outChunks: [],
      outBytes: 0,
      needsResync: false,
      resyncSent: false,
      reattach: () => attachToAgent(),
    };
    browserStreams.set(streamId, stream);

    // Install cleanup before any awaited replay work. A client can disappear
    // while a multi-megabyte checkpoint is yielding to WebSocket
    // backpressure; waiting until after attach would retain the stream and
    // its queued bytes indefinitely.
    let streamClosed = false;
    const cleanupStream = () => {
      if (streamClosed) {
        return;
      }
      streamClosed = true;
      const wasAttached = stream.attached;
      stream.attached = false;
      if (stream.flushTimer) {
        clearTimeout(stream.flushTimer);
      }
      clearOutputBuffer(stream);
      stream.replayQueue = [];
      stream.replayQueueBytes = 0;
      browserStreams.delete(streamId);
      releasePrimary(sessionId, streamId);
      if (![...browserStreams.values()].some(other => other.sessionId === sessionId)) {
        ptyStatusBySession.delete(sessionId);
        terminalState.drop(sessionId);
      }
      if (wasAttached) {
        sendAgentEvent(userId, session.project.rootKey, "terminal-close", { streamId }, 1000);
      }
    };
    ws.once("close", cleanupStream);

    const abortReplay = () => {
      cleanupStream();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1012, "terminal replay stalled");
      }
    };

    if (session.project.mirrored) {
      const checkpoint = terminalState.replay(sessionId);
      if (checkpoint) {
        const replayEpoch = stream.replayEpoch;
        sendJson(ws, { type: "checkpoint", sequence: checkpoint.sequence });
        const replayed = await sendReplayChunks(
          ws,
          checkpoint.chunks,
          () => stream.replayEpoch === replayEpoch
        );
        // A fresh full checkpoint intentionally supersedes stale replay and
        // has already been queued. Any other interruption is a dead/stalled
        // browser and must release its retained state immediately.
        if (!replayed && stream.replayEpoch === replayEpoch) {
          abortReplay();
          return;
        }
      }
    }

    if (stream.replaying && !session.project.mirrored) {
      let chunks = [];
      try {
        chunks = await readScrollback(prisma, sessionId, {
          maxLines: lowBandwidth ? 500 : 2500,
          maxBytes: lowBandwidth ? 1024 * 1024 : 4 * 1024 * 1024,
        });
      } catch (error) {
        console.error("[scrollback]", error instanceof Error ? error.message : String(error));
      }
      if (!(await sendReplayChunks(ws, chunks))) {
        abortReplay();
        return;
      }
    }

    // Drain the replay queue and exit replaying mode. The browser might have
    // disconnected during the snapshot — bail out if so.
    if (!browserStreams.has(streamId)) {
      return;
    }
    stream.replaying = false;
    if (stream.replayQueueTruncated) {
      // Terminal output is stateful: sending a retained tail after dropping
      // bytes in the middle can leave xterm looking plausible but wrong.
      // Reconnect and replay a complete runtime checkpoint / DB snapshot.
      stream.replayQueue = [];
      stream.replayQueueBytes = 0;
      markNeedsResync(stream, "terminal output changed too quickly during attach");
      scheduleFlush(stream, 0);
      return;
    }
    if (!(await sendReplayChunks(ws, stream.replayQueue))) {
      abortReplay();
      return;
    }
    stream.replayQueue = [];
    stream.replayQueueBytes = 0;

    claimPrimary(sessionId, streamId);

    async function markSessionStatus(status) {
      await prisma.session
        .update({
          where: { id: session.id },
          data: { status, lastSeenAt: status === "sleeping" ? session.lastSeenAt : new Date() },
        })
        .catch(() => {});
      if (session.tabId) {
        await prisma.tab.update({ where: { id: session.tabId }, data: { status } }).catch(() => {});
      }
      await updateProjectStatus(session.projectId);
      broadcastStatus(userId, true);
    }

    async function attachToAgent() {
      if (stream.attached) {
        return true;
      }
      if (stream.attachPromise) {
        return stream.attachPromise;
      }
      stream.attachPromise = (async () => {
        try {
          // replayRecent: only true when no other browser is attached or
          // mid-attach for this session at the moment we send terminal-
          // attach. If someone else is already there, the DB scrollback we
          // just replayed already covers the recent bytes, and the agent's
          // recent-output ring would duplicate them. The valuable case is
          // the idle-window reattach where no primary was writing during
          // the gap — the agent's ring is the only place that data lives.
          // Counting `attachPromise` too catches the post-agent-restart
          // reattach storm where every stream is mid-flight simultaneously.
          const anotherAttached = [...browserStreams.values()].some(
            other =>
              other !== stream &&
              other.sessionId === sessionId &&
              (other.attached || other.attachPromise)
          );
          const requestCheckpoint = terminalState.claimCheckpointRequest(sessionId);
          const attachResult = await sendToAgent(
            userId,
            session.project.rootKey,
            "terminal-attach",
            {
              streamId,
              sessionId,
              tmuxName: session.tmuxName,
              tmuxSessionName: session.project.tmuxSessionName,
              tmuxWindowName: session.tmuxWindowName,
              createMode:
                session.tmuxManaged === false
                  ? "none"
                  : session.project.tmuxSessionName && session.tmuxWindowName
                    ? "window"
                    : "session",
              kind: session.kind,
              cwd: { rootKey: session.project.rootKey, relativePath: session.project.relativePath },
              // projectName goes into the banner the agent prints when it
              // creates the underlying tmux pane so the user lands with full
              // context (project / device / cwd / shell / version) visible.
              projectName: session.project.name,
              spawnCommand:
                session.kind === "ctrl"
                  ? session.project.ctrlSpawnCommand
                  : session.spawnCommand || session.project.agentSpawnCommand,
              runtimeTarget: {
                runtime: session.runtime || session.project.runtime || "tmux",
                runtimeSessionId:
                  session.runtimeSessionId ||
                  session.project.runtimeSessionId ||
                  session.project.tmuxSessionName ||
                  session.tmuxName,
                paneId: session.externalId || session.tmuxName,
                terminalId: session.terminalId || session.externalId || session.tmuxName,
                tmuxSession:
                  session.project.tmuxSessionName ||
                  session.runtimeSessionId ||
                  session.project.runtimeSessionId,
                cwd: session.project.creationPath || undefined,
              },
              cols: stream.cols,
              rows: stream.rows,
              readOnly: stream.readOnly === true,
              requestCheckpoint,
              replayRecent: !anotherAttached,
            }
          );
          if (streamClosed || ws.readyState !== WebSocket.OPEN) {
            // The browser can close while the agent is creating/attaching the
            // runtime. Early cleanup saw `attached=false`, so explicitly undo
            // the just-completed attach to avoid an orphan subscriber in the
            // lightweight agent registry.
            sendAgentEvent(userId, session.project.rootKey, "terminal-close", { streamId }, 1000);
            return false;
          }
          // Mark before any persistence await so the already-installed close
          // handler can undo the agent attach if the browser disappears while
          // tmux metadata is being updated.
          stream.attached = true;
          if (attachResult?.tmuxName && attachResult.tmuxName !== session.tmuxName) {
            session.tmuxName = attachResult.tmuxName;
            await prisma.session
              .update({
                where: { id: session.id },
                data: { tmuxName: attachResult.tmuxName },
              })
              .catch(() => {});
          }
          if (streamClosed) {
            return false;
          }
          // Claim primary lazily: covers the case where the previous primary
          // failed to reattach and cleared the slot. Without this, our
          // terminal-data would fan out fine but never make it into the DB
          // scrollback because the primary check would be against a dead
          // streamId.
          if (!sessionPrimary.has(sessionId)) {
            sessionPrimary.set(sessionId, streamId);
          }
          if (!session.project.mirrored) {
            await markSessionStatus("idle");
          }
          if (streamClosed) {
            return false;
          }
          sendJson(ws, { type: "ready" });
          return true;
        } catch {
          terminalState.releaseCheckpointRequest(sessionId);
          stream.attached = false;
          // If we were holding the primary slot but failed to attach (e.g.
          // tmux session was destroyed during agent restart), hand it off
          // to another already-attached stream — or clear the slot so the
          // next successful attach can claim it. Otherwise scrollback
          // writes block forever on a dead primary.
          if (sessionPrimary.get(sessionId) === streamId) {
            sessionPrimary.delete(sessionId);
            for (const [otherId, other] of browserStreams) {
              if (other.sessionId === sessionId && other.attached) {
                sessionPrimary.set(sessionId, otherId);
                break;
              }
            }
          }
          if (!session.project.mirrored) {
            await markSessionStatus("sleeping");
          }
          sendJson(ws, {
            type: "sleeping",
            message: "Agent offline; open termag on your laptop to reconnect.",
          });
          return false;
        } finally {
          stream.attachPromise = null;
        }
      })();
      return stream.attachPromise;
    }

    await attachToAgent();

    ws.on("message", async raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "input") {
        if (
          stream.readOnly ||
          typeof msg.data !== "string" ||
          Buffer.byteLength(msg.data, "utf8") > 256 * 1024
        ) {
          return;
        } // Read-only viewers never write to the PTY.
        if (!(await attachToAgent())) {
          return;
        }
        sendAgentEvent(
          userId,
          session.project.rootKey,
          "terminal-input",
          { streamId, data: msg.data },
          1000
        );
      }
      if (msg.type === "resize") {
        stream.cols = terminalDimension(msg.cols, stream.cols, 20, 500);
        stream.rows = terminalDimension(msg.rows, stream.rows, 5, 200);
        if (stream.attached) {
          sendAgentEvent(
            userId,
            session.project.rootKey,
            "terminal-resize",
            { streamId, cols: stream.cols, rows: stream.rows },
            1000
          );
        }
      }
      if (
        msg.type === "kill" &&
        session.tmuxManaged !== false &&
        agentForUser(userId, session.project.rootKey)
      ) {
        sendAgentEvent(
          userId,
          session.project.rootKey,
          "tmux-kill-window",
          { tmuxName: session.tmuxName },
          5000
        );
      }
      if (msg.type === "claim-drive" && stream.attached && !stream.readOnly) {
        sendAgentEvent(userId, session.project.rootKey, "terminal-claim-drive", { streamId }, 1000);
      }
      if (msg.type === "pause") {
        // Browser tab/app is hidden — stop forwarding output. Buffer is
        // capped at PAUSE_DROP_LIMIT to bound memory; older bytes drop.
        stream.paused = true;
      }
      if (msg.type === "resume") {
        stream.paused = false;
        if (stream.pausedTrimmed) {
          stream.pausedTrimmed = false;
        }
        flushStream(stream);
      }
    });
  }

  return {
    registerAgent,
    registerBrowser,
    ...createBrokerRpc({
      WebSocket,
      agentsForUser,
      connectedAgents,
      publicAgentStatus,
      agentForUser,
      sendJson,
      sendToAgent,
      broadcastStatus,
      sshLifecycle,
    }),
  };
}

module.exports = { createBroker, parseAgentTerminalFrame };
