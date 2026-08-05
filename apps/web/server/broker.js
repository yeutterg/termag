const crypto = require("node:crypto");
const { WebSocket } = require("ws");
const { getToken } = require("next-auth/jwt");
const { appendScrollback, readScrollback, startScrollbackPrune } = require("./scrollback");
const { createSshStreamRegistry } = require("./ssh-session-stream");
const { reconcileInventory } = require("./inventory-v2");

// Wire-protocol constant shared with the agent. Keep in sync with
// apps/agent/src/index.ts → WS_REPLACED_REASON.
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
  // SSH host state. sshHosts is userId → Map(hostId → { spec, status,
  // sessions, pollHandle }) — the in-memory mirror of the SshHost rows
  // and their last probe result. The shared pty per (host, tmuxName) lives
  // in the SshSessionStream registry below, which handles multi-subscriber
  // fan-out and scrollback persistence.
  const sshHosts = new Map();
  const sshStreamRegistry = createSshStreamRegistry({ prisma });
  const SSH_POLL_INTERVAL_MS = 30_000;
  // Last PTY fast-path status we received per session, with the epoch-ms it
  // landed. The poll classifier prefers this over poll facts while it's
  // fresh AND the session still has an attached browser stream — the PTY
  // path reacts to live output/BEL faster than the 30s health tick.
  const ptyStatusBySession = new Map(); // sessionId -> { status, at }
  const terminalSequenceBySession = new Map();
  const terminalCheckpoints = new Map();
  const terminalCheckpointRequests = new Map();
  const MAX_CHECKPOINT_CACHE_BYTES = 64 * 1024 * 1024;
  let terminalCheckpointBytes = 0;

  function deleteTerminalCheckpoint(sessionId) {
    const checkpoint = terminalCheckpoints.get(sessionId);
    if (!checkpoint) {
      return;
    }
    terminalCheckpointBytes = Math.max(
      0,
      terminalCheckpointBytes - checkpoint.fullBytes - checkpoint.tailBytes
    );
    terminalCheckpoints.delete(sessionId);
  }

  function trimCheckpointCache(exemptSessionId) {
    while (terminalCheckpointBytes > MAX_CHECKPOINT_CACHE_BYTES) {
      let oldest = null;
      for (const [sessionId, checkpoint] of terminalCheckpoints) {
        if (sessionId === exemptSessionId) {
          continue;
        }
        if (!oldest || checkpoint.at < oldest.checkpoint.at) {
          oldest = { sessionId, checkpoint };
        }
      }
      if (!oldest) {
        break;
      }
      deleteTerminalCheckpoint(oldest.sessionId);
    }
  }
  // A window whose last output is younger than this counts as actively
  // working — fresh output beats a stale bell flag. Env-overridable to match
  // the HEALTH_INTERVAL_MS tuning pattern over in apps/agent/src/index.ts.
  const WORKING_THRESHOLD_SEC = Number(process.env.TERMAG_WORKING_THRESHOLD_SEC) || 8;
  // How long a PTY-reported status stays authoritative before the poll
  // classifier takes back over (the PTY path stops refreshing on output stop).
  const PTY_FRESH_MS = Number(process.env.TERMAG_PTY_FRESH_MS) || 5000;
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
    for (const [sessionId, state] of terminalSequenceBySession) {
      if (state.at < cutoff && !activeSessions.has(sessionId)) {
        terminalSequenceBySession.delete(sessionId);
      }
    }
    for (const [sessionId, state] of terminalCheckpoints) {
      if (state.at < cutoff && !activeSessions.has(sessionId)) {
        deleteTerminalCheckpoint(sessionId);
      }
    }
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
    return [
      ...connectedAgents(userId).map(publicAgentStatus),
      ...[...sshHostsForUser(userId).values()].map(publicSshHostStatus),
    ];
  }

  function normalizeTmuxSessions(input) {
    const sessions = Array.isArray(input) ? input : [];
    return sessions
      .map(session => ({
        name: typeof session?.name === "string" ? session.name : "",
        path: typeof session?.path === "string" ? session.path : undefined,
        windowCount: Number.isFinite(Number(session?.windowCount))
          ? Number(session.windowCount)
          : undefined,
        windows: Array.isArray(session?.windows)
          ? session.windows
              .map(window => ({
                index: Number.isFinite(Number(window?.index)) ? Number(window.index) : 0,
                id: typeof window?.id === "string" ? window.id : "",
                name: typeof window?.name === "string" ? window.name : "",
                target: typeof window?.target === "string" ? window.target : "",
                path: typeof window?.path === "string" ? window.path : undefined,
                // Poll facts the agent attaches per window for the broker's status
                // classifier. All optional — older agents omit them and the
                // classifier falls through to its existing branches. Coerce with
                // the same Number.isFinite/typeof guards used for the core fields.
                activityAgeSec: Number.isFinite(Number(window?.activityAgeSec))
                  ? Number(window.activityAgeSec)
                  : undefined,
                bell: typeof window?.bell === "boolean" ? window.bell : undefined,
                currentCommand:
                  typeof window?.currentCommand === "string" ? window.currentCommand : undefined,
                lastExit: Number.isFinite(Number(window?.lastExit))
                  ? Number(window.lastExit)
                  : undefined,
              }))
              .filter(window => window.target || window.id || window.name)
          : [],
      }))
      .filter(session => session.name);
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

    const previous = terminalSequenceBySession.get(anchor.sessionId);
    const expectedSequence = previous
      ? previous.sequence === 0xffffffff
        ? 1
        : previous.sequence + 1
      : frame.sequence;
    if (!frame.full && previous && frame.sequence !== expectedSequence) {
      // A checkpoint plus ANSI deltas is only replayable as one contiguous
      // byte sequence. Once any frame is missing, retaining/appending to that
      // cache would make the next viewer's screen plausibly but silently
      // corrupt, so discard it and force a fresh runtime checkpoint.
      deleteTerminalCheckpoint(anchor.sessionId);
      for (const stream of browserStreams.values()) {
        if (
          stream.sessionId === anchor.sessionId &&
          streamBelongsToAgent(stream, userId, deviceName)
        ) {
          markNeedsResync(stream, "terminal frame sequence was interrupted");
          scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
        }
      }
      terminalSequenceBySession.set(anchor.sessionId, {
        sequence: frame.sequence,
        at: Date.now(),
      });
      return;
    }
    terminalSequenceBySession.set(anchor.sessionId, {
      sequence: frame.sequence,
      at: Date.now(),
    });

    let checkpoint = terminalCheckpoints.get(anchor.sessionId);
    if (frame.full) {
      terminalCheckpointRequests.delete(anchor.sessionId);
      deleteTerminalCheckpoint(anchor.sessionId);
      checkpoint = {
        full: [Buffer.from(frame.data)],
        fullBytes: frame.data.length,
        building: !frame.checkpointEnd,
        tail: [],
        tailBytes: 0,
        sequence: frame.sequence,
        at: Date.now(),
      };
      terminalCheckpoints.set(anchor.sessionId, checkpoint);
      terminalCheckpointBytes += checkpoint.fullBytes;
    } else if (frame.checkpointContinuation) {
      if (checkpoint?.building) {
        checkpoint.full.push(Buffer.from(frame.data));
        checkpoint.fullBytes += frame.data.length;
        terminalCheckpointBytes += frame.data.length;
        checkpoint.sequence = frame.sequence;
        checkpoint.at = Date.now();
        checkpoint.building = !frame.checkpointEnd;
      } else {
        // A continuation without its start cannot seed future replay. It is
        // still fanned to already-live viewers below, which may have received
        // the start before this broker lost cache state.
        deleteTerminalCheckpoint(anchor.sessionId);
        checkpoint = null;
      }
      if (checkpoint?.fullBytes > 4 * 1024 * 1024) {
        deleteTerminalCheckpoint(anchor.sessionId);
        checkpoint = null;
      }
    } else if (checkpoint?.building) {
      // A checkpoint start must be followed only by explicitly-marked
      // continuation frames through checkpointEnd. Treat any other frame as
      // a protocol gap instead of caching a partial terminal state.
      deleteTerminalCheckpoint(anchor.sessionId);
      checkpoint = null;
    } else if (checkpoint) {
      const tailChunk = Buffer.from(frame.data);
      checkpoint.tail.push(tailChunk);
      checkpoint.tailBytes += tailChunk.length;
      terminalCheckpointBytes += tailChunk.length;
      checkpoint.sequence = frame.sequence;
      checkpoint.at = Date.now();
      // ANSI deltas are ordered state transitions: dropping the middle and
      // retaining only a tail would produce a plausible-looking but corrupt
      // replay. Invalidate the cache instead; the next viewer asks the local
      // runtime for a fresh bounded checkpoint.
      if (checkpoint.tailBytes > 1024 * 1024) {
        deleteTerminalCheckpoint(anchor.sessionId);
        checkpoint = null;
      }
    }
    trimCheckpointCache(anchor.sessionId);

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

  function addTmuxTarget(targets, value) {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      targets.add(trimmed);
    }
  }

  function scopedTmuxTarget(sessionName, target) {
    return `${sessionName}\u0000${target}`;
  }

  function buildLiveTmuxState(tmuxSessions) {
    const state = {
      sessions: new Set(),
      windows: new Set(),
      globalWindows: new Set(),
      // window-target-key -> { activityAgeSec, bell, currentCommand, lastExit }.
      // Keyed by the SAME scoped + global keys we add to the Sets above so the
      // classifier can look up the poll facts for whichever target matched a
      // session (tmuxSessionIsLive scopes by project, falls back to global).
      facts: new Map(),
    };
    const sessions = Array.isArray(tmuxSessions) ? tmuxSessions : [];
    for (const session of sessions) {
      const sessionName = typeof session?.name === "string" ? session.name.trim() : "";
      if (!sessionName) {
        continue;
      }
      state.sessions.add(sessionName);
      const windows = Array.isArray(session.windows) ? session.windows : [];
      for (const window of windows) {
        const targets = new Set();
        addTmuxTarget(targets, window?.target);
        addTmuxTarget(targets, window?.id);
        addTmuxTarget(targets, window?.name);
        const facts = {
          activityAgeSec: window?.activityAgeSec,
          bell: window?.bell,
          currentCommand: window?.currentCommand,
          lastExit: window?.lastExit,
        };
        for (const target of targets) {
          state.globalWindows.add(target);
          state.windows.add(scopedTmuxTarget(sessionName, target));
          // Store the facts under both the global and the scoped key so the
          // matched-target lookup works regardless of which path matched.
          state.facts.set(target, facts);
          state.facts.set(scopedTmuxTarget(sessionName, target), facts);
        }
      }
    }
    return state;
  }

  function sessionTargetCandidates(session, projectSessionName) {
    const candidates = new Set();
    addTmuxTarget(candidates, session.tmuxName);
    addTmuxTarget(candidates, session.tmuxWindowName);
    if (projectSessionName && typeof session.tmuxName === "string") {
      const prefix = `${projectSessionName}:`;
      if (session.tmuxName.startsWith(prefix)) {
        addTmuxTarget(candidates, session.tmuxName.slice(prefix.length));
      }
    }
    return candidates;
  }

  function tmuxSessionIsLive(session, tmuxState) {
    const projectSessionName =
      typeof session.project?.tmuxSessionName === "string"
        ? session.project.tmuxSessionName.trim()
        : "";
    const tmuxName = typeof session.tmuxName === "string" ? session.tmuxName.trim() : "";
    if (projectSessionName) {
      if (tmuxName === projectSessionName && tmuxState.sessions.has(projectSessionName)) {
        return true;
      }
      for (const candidate of sessionTargetCandidates(session, projectSessionName)) {
        if (tmuxState.windows.has(scopedTmuxTarget(projectSessionName, candidate))) {
          return true;
        }
      }
      return false;
    }
    if (tmuxState.sessions.has(tmuxName)) {
      return true;
    }
    for (const candidate of sessionTargetCandidates(session, "")) {
      if (tmuxState.globalWindows.has(candidate)) {
        return true;
      }
    }
    return false;
  }

  // Find the poll facts for whichever live window this session matched. Mirrors
  // the match order in tmuxSessionIsLive: scoped-by-project first (when the
  // project has a tmux session name), else the global window keys. Returns the
  // facts object stored by buildLiveTmuxState, or null if no window matched
  // (e.g. the session is live via the session-name Set, not a window).
  function pollFactsForSession(session, tmuxState) {
    const projectSessionName =
      typeof session.project?.tmuxSessionName === "string"
        ? session.project.tmuxSessionName.trim()
        : "";
    if (projectSessionName) {
      for (const candidate of sessionTargetCandidates(session, projectSessionName)) {
        const facts = tmuxState.facts.get(scopedTmuxTarget(projectSessionName, candidate));
        if (facts) {
          return facts;
        }
      }
      return null;
    }
    for (const candidate of sessionTargetCandidates(session, "")) {
      const facts = tmuxState.facts.get(candidate);
      if (facts) {
        return facts;
      }
    }
    return null;
  }

  // Shell process names that mean the prompt has returned (program exited) —
  // login shells show with a leading dash. Used by the classifier's idle branch.
  const SHELL_COMMAND_RE = /^(zsh|bash|sh|fish|ksh|dash|-zsh|-bash)$/;

  // Classify a LIVE session per the shared wire contract. PTY fast-path wins
  // while fresh AND a browser is attached; otherwise derive from poll facts.
  function classifyLiveTmuxSession(session, facts) {
    // Precedence: a recent PTY status for a session with an attached browser
    // stream reflects live output/BEL faster than the ~10s health poll. Without an
    // attached stream there's no PTY feeding us, so the fast-path is stale.
    const pty = ptyStatusBySession.get(session.id);
    if (pty && Date.now() - pty.at < PTY_FRESH_MS) {
      for (const stream of browserStreams.values()) {
        if (stream.sessionId === session.id && stream.attached === true) {
          return pty.status;
        }
      }
    }
    if (facts) {
      // (a) fresh output beats a stale bell flag.
      if (
        typeof facts.activityAgeSec === "number" &&
        facts.activityAgeSec < WORKING_THRESHOLD_SEC
      ) {
        return "working";
      }
      // (b) bell rung (BEL or window-flags '!') and not actively outputting.
      if (facts.bell === true) {
        return "waiting";
      }
      // (c) last command exited non-zero.
      if (typeof facts.lastExit === "number" && facts.lastExit !== 0) {
        return "error";
      }
      // (d) a shell prompt is back — the program finished and isn't an error.
      if (typeof facts.currentCommand === "string" && SHELL_COMMAND_RE.test(facts.currentCommand)) {
        return "idle";
      }
      // (e) something is running but not outputting — treat as waiting.
      return "waiting";
    }
    // No window facts (live via session-name only / older agent): preserve the
    // previous non-sleeping status, defaulting to idle, as before.
    return session.status && session.status !== "sleeping" ? session.status : "idle";
  }

  async function reconcileDeviceTmuxStatus(userId, deviceName, tmuxSessions) {
    const tmuxState = buildLiveTmuxState(tmuxSessions);
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
      const live = tmuxSessionIsLive(session, tmuxState);
      const nextStatus = live
        ? classifyLiveTmuxSession(session, pollFactsForSession(session, tmuxState))
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
          tmuxSessions: normalizeTmuxSessions(msg.tmux?.sessions),
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
        deleteTerminalCheckpoint(anchor.sessionId);
        terminalSequenceBySession.delete(anchor.sessionId);
        terminalCheckpointRequests.delete(anchor.sessionId);
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
      await handleShareAttach(ws, code, cols, rows);
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
      if (!sshHosts.has(userId)) {
        refreshSshHosts(userId, { broadcast: true }).catch(() => {});
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
      if (!sshHosts.has(userId)) {
        await refreshSshHosts(userId, { broadcast: false });
      }
      await handleSshAttach(ws, userId, hostId, tmuxName, cols, rows);
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
        terminalSequenceBySession.delete(sessionId);
        deleteTerminalCheckpoint(sessionId);
        terminalCheckpointRequests.delete(sessionId);
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
      const checkpoint = terminalCheckpoints.get(sessionId);
      if (checkpoint) {
        const replayEpoch = stream.replayEpoch;
        sendJson(ws, { type: "checkpoint", sequence: checkpoint.sequence });
        const replayed = await sendReplayChunks(
          ws,
          [...checkpoint.full, ...checkpoint.tail],
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
          const lastCheckpointRequest = terminalCheckpointRequests.get(sessionId) || 0;
          const requestCheckpoint =
            !terminalCheckpoints.has(sessionId) && Date.now() - lastCheckpointRequest > 5000;
          if (requestCheckpoint) {
            terminalCheckpointRequests.set(sessionId, Date.now());
          }
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
          terminalCheckpointRequests.delete(sessionId);
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

  // ─── SSH host state machinery ──────────────────────────────────────────
  //
  // Each SshHost row becomes an in-memory record with a 30s poller that
  // refreshes reachability + tmux session list. The records back the
  // connectedDevices() + listTmuxSessions() responses so SSH hosts appear
  // in the web UI's device list and in `termag list` alongside agents.

  function sshHostsForUser(userId) {
    return sshHosts.get(userId) || new Map();
  }

  function publicSshHostStatus(record) {
    return {
      name: record.spec.name,
      connected: Boolean(record.connected),
      lastSeenAt: record.lastSeenAt?.toISOString?.() || null,
      kind: "ssh",
      version: "ssh",
      lastError: record.lastError || null,
      deviceId: record.spec.id,
      tmuxSessions: record.tmuxSessions.map(session => ({
        name: session.name,
        path: session.path || "",
        windowCount: session.windowCount || 0,
        windows: [],
      })),
    };
  }

  // Idempotent: reload SshHost rows from the DB, start polling new ones,
  // stop polling removed ones, leave still-present rows alone.
  async function refreshSshHosts(userId, options = {}) {
    let rows;
    try {
      rows = await prisma.sshHost.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          host: true,
          port: true,
          user: true,
          lastSeenAt: true,
          lastError: true,
        },
      });
    } catch (err) {
      console.error("[ssh] could not load hosts for user", userId, err.message);
      return;
    }
    if (!sshHosts.has(userId)) {
      sshHosts.set(userId, new Map());
    }
    const current = sshHosts.get(userId);
    const wantIds = new Set(rows.map(row => row.id));

    // Stop polling removed hosts.
    for (const [hostId, record] of current) {
      if (!wantIds.has(hostId)) {
        if (record.pollHandle) {
          clearInterval(record.pollHandle);
        }
        current.delete(hostId);
      }
    }

    for (const row of rows) {
      const spec = { id: row.id, name: row.name, host: row.host, port: row.port, user: row.user };
      const existing = current.get(row.id);
      if (existing) {
        // Update spec in case the host/user/port changed in the DB.
        existing.spec = spec;
        continue;
      }
      const record = {
        spec,
        connected: false,
        lastSeenAt: row.lastSeenAt || null,
        lastError: row.lastError || null,
        tmuxSessions: [],
        pollHandle: null,
      };
      current.set(row.id, record);
      // Kick off an immediate probe so newly-added hosts feel responsive,
      // then schedule the recurring poll.
      probeAndStoreSshHost(userId, row.id).catch(() => {});
      const handle = setInterval(() => {
        probeAndStoreSshHost(userId, row.id).catch(() => {});
      }, SSH_POLL_INTERVAL_MS);
      handle.unref();
      record.pollHandle = handle;
    }
    if (current.size === 0) {
      sshHosts.delete(userId);
    }
    if (options.broadcast !== false) {
      broadcastStatus(userId, true);
    }
  }

  async function probeAndStoreSshHost(userId, hostId) {
    const record = sshHostsForUser(userId).get(hostId);
    if (!record) {
      return { ok: false, error: "host not registered" };
    }
    // Coalesce concurrent probes for the same host. The 30s poll can
    // overlap with a manual "Test connection" or an attach-time probe; we
    // don't want two ssh subprocesses racing to write the same record.
    // Whoever started first wins; latecomers wait on its promise.
    if (record.probeInFlight) {
      return record.probeInFlight;
    }

    record.probeInFlight = (async () => {
      try {
        // Capture pre-probe state so we only broadcast when something
        // changed. Polling every 30s × N users × M hosts would otherwise
        // spam every browser's status WS even when nothing is different.
        const prevConnected = record.connected;
        const prevError = record.lastError;
        const prevSessionFingerprint = sessionFingerprint(record.tmuxSessions);

        // Lazy require so the ssh helper (and its node-pty dep) only
        // loads when SSH features are actually exercised.
        const { probeSshHost, listSshTmuxSessions } = require("./ssh");
        const probe = await probeSshHost(record.spec);
        // The host may have been removed while the probe was in flight.
        if (!sshHostsForUser(userId).has(hostId)) {
          return { ok: false, error: "host removed during probe" };
        }
        if (probe.ok) {
          record.connected = true;
          record.lastSeenAt = new Date();
          record.lastError = null;
          record.tmuxSessions = await listSshTmuxSessions(record.spec);
        } else {
          record.connected = false;
          record.lastError = probe.error || "probe failed";
          record.tmuxSessions = [];
        }
        if (!sshHostsForUser(userId).has(hostId)) {
          return { ok: probe.ok, error: probe.error || null, sessions: [] };
        }
        prisma.sshHost
          .update({
            where: { id: hostId },
            data: { lastSeenAt: record.lastSeenAt, lastError: record.lastError },
          })
          .catch(() => {});
        const changed =
          prevConnected !== record.connected ||
          prevError !== record.lastError ||
          prevSessionFingerprint !== sessionFingerprint(record.tmuxSessions);
        if (changed) {
          broadcastStatus(userId, true);
        }
        return { ok: probe.ok, error: probe.error || null, sessions: record.tmuxSessions };
      } finally {
        record.probeInFlight = null;
      }
    })();
    return record.probeInFlight;
  }

  function sessionFingerprint(sessions) {
    if (!Array.isArray(sessions)) {
      return "";
    }
    return sessions.map(s => `${s.name}|${s.windowCount}|${s.path || ""}`).join("\n");
  }

  function forgetSshHost(userId, hostId) {
    const map = sshHostsForUser(userId);
    const record = map.get(hostId);
    if (!record) {
      return;
    }
    if (record.pollHandle) {
      clearInterval(record.pollHandle);
    }
    map.delete(hostId);
    // Tear down any shared streams pointing at this host. The registry
    // closes each subscriber's ws and kills the pty in one shot.
    sshStreamRegistry.forgetHost(userId, hostId);
    if (map.size === 0) {
      sshHosts.delete(userId);
    }
    broadcastStatus(userId, true);
  }

  function sshDeviceSnapshots(userId) {
    return [...sshHostsForUser(userId).values()].map(record => ({
      rootKey: record.spec.name,
      sessions: record.tmuxSessions.map(session => ({
        name: session.name,
        path: session.path || "",
        windowCount: session.windowCount || 0,
        windows: [],
      })),
    }));
  }

  async function handleSshAttach(ws, userId, hostId, tmuxName, cols, rows) {
    const record = sshHostsForUser(userId).get(hostId);
    if (!record) {
      ws.close(1008, "ssh host not registered");
      return;
    }
    // Friendly allowlist: the requested tmux session must show up in our
    // cached probe. Catches typos and prevents a hostile client from
    // blind-firing arbitrary session names. (The pty spawn re-validates
    // the name with a strict regex on the way to the remote shell — this
    // check is for UX.)
    //
    // If the cache doesn't have it AND the cache is stale (>15s since last
    // probe), force an inline probe and recheck — covers the case where
    // the user just created a tmux session on the remote and the 30s poll
    // hasn't run yet. Without this, freshly-created sessions feel broken
    // for up to half a minute after first creation.
    let known = record.tmuxSessions.some(session => session.name === tmuxName);
    if (!known) {
      const cacheAge = record.lastSeenAt ? Date.now() - record.lastSeenAt.getTime() : Infinity;
      if (cacheAge > 15_000) {
        try {
          await probeAndStoreSshHost(userId, hostId);
        } catch {}
        const fresh = sshHostsForUser(userId).get(hostId);
        known = fresh?.tmuxSessions?.some(session => session.name === tmuxName) ?? false;
      }
    }
    if (!known) {
      ws.close(1008, "unknown tmux session — refresh device status");
      return;
    }
    let stream;
    try {
      stream = sshStreamRegistry.getOrCreate({
        userId,
        hostSpec: record.spec,
        tmuxName,
        cols,
        rows,
      });
    } catch (err) {
      sendJson(ws, {
        type: "fatal",
        message: sanitizeAgentText(err?.message || "ssh spawn failed", 200),
      });
      ws.close(1011, "ssh spawn failed");
      return;
    }
    try {
      // subscribe() wires its own ws.on('close') for unsubscribe — the
      // caller doesn't need a teardown handle. Wiring it inside subscribe
      // closes a race where the WS could close during the async scrollback
      // replay before the caller had a chance to attach a close handler.
      await stream.subscribe(ws, cols, rows);
    } catch (err) {
      sendJson(ws, {
        type: "fatal",
        message: sanitizeAgentText(err?.message || "subscribe failed", 200),
      });
      ws.close(1011, "subscribe failed");
      return;
    }
    // Audit: record the attach. SSH attaches give shell access to a
    // remote machine, so this is one of the higher-value forensic
    // events. We log on attach (not detach) — pair with the
    // SshSessionStream lifecycle to derive detach times if needed.
    writeSshAttachAudit(userId, record.spec, tmuxName, ws).catch(() => {});
  }

  /**
   * Public share-link attach. The code authenticates the viewer; we
   * resolve it to (userId, sshHostId, tmuxName), validate TTL +
   * revocation, then subscribe as a read-only viewer to the owner's
   * existing SshSessionStream. We do NOT call refreshSshHosts here —
   * the link's existence implies the owner had the host loaded recently.
   */
  async function handleShareAttach(ws, code, cols, rows) {
    let link;
    try {
      link = await prisma.shareLink.findUnique({
        where: { code },
        select: {
          id: true,
          userId: true,
          sshHostId: true,
          tmuxName: true,
          expiresAt: true,
          revokedAt: true,
          sshHost: { select: { id: true, name: true, host: true, port: true, user: true } },
        },
      });
    } catch (err) {
      console.error("[share-attach] DB lookup failed:", err?.message || err);
      ws.close(1011, "lookup failed");
      return;
    }
    if (
      !link ||
      link.revokedAt ||
      link.expiresAt < new Date() ||
      !link.sshHostId ||
      !link.sshHost ||
      !link.tmuxName
    ) {
      ws.close(1008, "share link unavailable");
      return;
    }
    // Ensure the SshSessionStream for the owner exists by reusing the
    // same getOrCreate path (it'll spawn a pty if no one's attached yet).
    // We pass the owner's userId so accounting matches the host owner.
    let stream;
    try {
      stream = sshStreamRegistry.getOrCreate({
        userId: link.userId,
        hostSpec: link.sshHost,
        tmuxName: link.tmuxName,
        cols,
        rows,
      });
    } catch (err) {
      sendJson(ws, {
        type: "fatal",
        message: sanitizeAgentText(err?.message || "ssh spawn failed", 200),
      });
      ws.close(1011, "ssh spawn failed");
      return;
    }
    try {
      await stream.subscribe(ws, cols, rows, { readOnly: true });
    } catch (err) {
      sendJson(ws, {
        type: "fatal",
        message: sanitizeAgentText(err?.message || "subscribe failed", 200),
      });
      ws.close(1011, "subscribe failed");
      return;
    }
    // Audit + bookkeeping: increment use count, update lastUsedAt.
    // Fire-and-forget so a slow DB doesn't hold up the live stream.
    prisma.shareLink
      .update({
        where: { id: link.id },
        data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
      })
      .catch(() => {});
    prisma.auditEvent
      .create({
        data: {
          action: "attach",
          subjectType: "session",
          deviceName: link.sshHost.name,
          ip: ws._socket?.remoteAddress || null,
          userAgent: null,
          payload: JSON.stringify({
            kind: "share-attach",
            code: link.code || code,
            tmuxName: link.tmuxName,
          }),
          userId: link.userId,
        },
      })
      .catch(() => {});
  }

  function writeSshAttachAudit(userId, hostSpec, tmuxName, ws) {
    // Pull the originating request's IP off the upgrade socket. The WS
    // request itself was consumed by `handleUpgrade`, so we read from
    // the underlying socket's remoteAddress as a best-effort. Same XFF
    // policy as the audit lib: only honored when behind a trusted proxy.
    const ip =
      process.env.TERMAG_TRUSTED_PROXY === "true"
        ? null // header-based ip would require keeping the upgrade headers around — skip for now
        : ws._socket?.remoteAddress || null;
    return prisma.auditEvent.create({
      data: {
        action: "attach",
        subjectType: "session",
        subjectId: null,
        deviceName: hostSpec.name,
        ip,
        userAgent: null,
        payload: JSON.stringify({ kind: "ssh", host: hostSpec.host, tmuxName }),
        userId,
      },
    });
  }

  return {
    registerAgent,
    registerBrowser,
    refreshUser(userId) {
      broadcastStatus(userId, true);
    },
    connectedDevices(userId) {
      // Merge agent-backed devices with SSH-host devices. SSH hosts that
      // haven't been loaded yet (e.g., first call after broker restart)
      // get loaded asynchronously here — the first call returns whatever
      // is in-memory; subsequent calls see the full list. The status WS
      // path also calls refreshSshHosts on connect, so browsers don't see
      // an incomplete picture in practice.
      if (!sshHosts.has(userId)) {
        refreshSshHosts(userId).catch(() => {});
      }
      return [
        ...connectedAgents(userId).map(publicAgentStatus),
        ...[...sshHostsForUser(userId).values()].map(publicSshHostStatus),
      ];
    },
    refreshSshHosts,
    probeSshHost: probeAndStoreSshHost,
    forgetSshHost,
    // Fire-and-forget poke that asks a specific device's agent to send a
    // fresh health ping right now. Used by the publish API so the UI sees
    // the new tmux state without waiting for the next scheduled health
    // tick (HEALTH_INTERVAL_MS gap would otherwise show false missing-targets).
    requestHealthRefresh(userId, deviceName) {
      const agent = agentForUser(userId, deviceName);
      if (!agent) {
        return;
      }
      sendJson(agent.ws, { type: "health-request" });
    },
    async listTmuxSessions(userId) {
      const liveAgents = connectedAgents(userId);
      const agentResults = await Promise.all(
        liveAgents.map(async agent => {
          try {
            const data = await sendToAgent(userId, agent.deviceName, "tmux-list", {}, 5000);
            const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
            return sessions.map(session => ({ ...session, rootKey: agent.deviceName }));
          } catch {
            return [];
          }
        })
      );
      // Merge in cached SSH-host tmux sessions. Each session takes the
      // host's name as its rootKey so the existing per-device grouping
      // in the UI / CLI just works.
      const sshResults = sshDeviceSnapshots(userId).flatMap(snap =>
        snap.sessions.map(session => ({ ...session, rootKey: snap.rootKey }))
      );
      return [...agentResults.flat(), ...sshResults];
    },
    async listDirectory(userId, deviceName, rootKey, relativePath) {
      if (!agentForUser(userId, deviceName)) {
        throw new Error("Agent offline");
      }
      return sendToAgent(
        userId,
        deviceName,
        "list-directory",
        { rootKey, relativePath: relativePath || "" },
        5000
      );
    },
    async mutateRuntime(userId, deviceName, operation, payload = {}, timeoutMs = 10000) {
      const allowed = new Set([
        "runtime.create-session",
        "runtime.create-space",
        "runtime.create-tab",
        "runtime.rename-space",
        "runtime.rename-tab",
        "runtime.rename-pane",
        "runtime.close-tab",
        "runtime.close-pane",
        "runtime.close-space",
        "runtime.close-session",
      ]);
      if (!allowed.has(operation)) {
        throw new Error("Unsupported runtime operation");
      }
      if (!agentForUser(userId, deviceName)) {
        throw new Error("Agent offline");
      }
      return sendToAgent(userId, deviceName, operation, payload, timeoutMs);
    },
    async startCaffeinate(userId, deviceName, mode, reason, durationMs) {
      const agent = agentForUser(userId, deviceName);
      if (!agent) {
        throw new Error("Agent offline");
      }
      const wireMode =
        agent.protocolVersion >= 2
          ? mode
          : mode === "terminals-awake"
            ? "while-task"
            : mode === "display-awake"
              ? "forever"
              : mode === "ac-awake"
                ? "while-task"
                : mode;
      return sendToAgent(
        userId,
        deviceName,
        "caffeinate-start",
        { mode: wireMode, reason, durationMs },
        5000
      );
    },
    async stopCaffeinate(userId, deviceName) {
      if (!agentForUser(userId, deviceName)) {
        throw new Error("Agent offline");
      }
      return sendToAgent(userId, deviceName, "caffeinate-stop", {}, 5000);
    },
    async acquirePowerLease(userId, deviceName, leaseId, mode, reason, durationMs, renew = false) {
      const agent = agentForUser(userId, deviceName);
      if (!agent) {
        throw new Error("Agent offline");
      }
      if (agent.protocolVersion < 2 || !agent.capabilities?.powerPolicy) {
        throw new Error("Agent does not support renewable power leases");
      }
      return sendToAgent(
        userId,
        deviceName,
        renew ? "power.renew" : "power.acquire",
        { leaseId, mode, reason, durationMs },
        5000
      );
    },
    async releasePowerLease(userId, deviceName, leaseId) {
      const agent = agentForUser(userId, deviceName);
      if (!agent) {
        throw new Error("Agent offline");
      }
      if (agent.protocolVersion < 2 || !agent.capabilities?.powerPolicy) {
        throw new Error("Agent does not support renewable power leases");
      }
      return sendToAgent(userId, deviceName, "power.release", { leaseId }, 5000);
    },
    async getCaffeinateStatus(userId, deviceName) {
      if (!agentForUser(userId, deviceName)) {
        throw new Error("Agent offline");
      }
      const result = await sendToAgent(userId, deviceName, "caffeinate-status", {}, 5000);
      return result?.state || result;
    },
    killTmuxSession(userId, deviceName, tmuxSessionName, timeoutMs = 5000) {
      if (!tmuxSessionName || !agentForUser(userId, deviceName)) {
        return Promise.resolve(false);
      }
      return sendToAgent(userId, deviceName, "tmux-kill-session", { tmuxSessionName }, timeoutMs)
        .then(() => true)
        .catch(() => false);
    },
    killTmuxWindow(userId, deviceName, tmuxName, timeoutMs = 5000) {
      if (!tmuxName || !agentForUser(userId, deviceName)) {
        return Promise.resolve(false);
      }
      return sendToAgent(userId, deviceName, "tmux-kill-window", { tmuxName }, timeoutMs)
        .then(() => true)
        .catch(() => false);
    },
    renameTmuxWindow(userId, deviceName, tmuxName, name, timeoutMs = 5000) {
      if (!tmuxName || !name || !agentForUser(userId, deviceName)) {
        return Promise.resolve(null);
      }
      return sendToAgent(
        userId,
        deviceName,
        "tmux-rename-window",
        { tmuxName, name },
        timeoutMs
      ).catch(() => null);
    },
    disconnectAgentToken(userId, tokenId) {
      let kicked = false;
      for (const agent of agentsForUser(userId).values()) {
        if (agent.tokenId === tokenId && agent.ws.readyState === WebSocket.OPEN) {
          agent.ws.close(1008, "token revoked");
          kicked = true;
        }
      }
      // The ws.close above eventually triggers broadcastStatus on the
      // close handler, but that runs *after* the close round-trip. Fire
      // an immediate broadcast so the web UI's "connected" dot updates
      // instantly rather than waiting up to ~30s for the next health
      // tick (or the close to round-trip back).
      if (kicked) {
        broadcastStatus(userId, true);
      }
    },
    killTmux(userId, tmuxName, timeoutMs = 5000) {
      if (!tmuxName || !agentForUser(userId)) {
        return Promise.resolve(false);
      }
      return sendToAgent(userId, undefined, "tmux-kill", { tmuxName }, timeoutMs)
        .then(() => true)
        .catch(() => false);
    },
  };
}

module.exports = { createBroker, parseAgentTerminalFrame };
