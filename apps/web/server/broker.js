const crypto = require("node:crypto");
const { WebSocket } = require("ws");
const { normalizeSnapshot } = require("./inventory-v2");
const { createInventoryPatch } = require("./inventory-patch");
const { createBrokerRpc } = require("./broker-rpc");
const { decodeRuntimeId } = require("./runtime-id");
const { createTerminalCheckpointStore } = require("./terminal-checkpoint-store");

const WS_REPLACED_REASON = "replaced";
const AGENT_TOKEN_MIN_LENGTH = 32;
const AGENT_TOKEN_MAX_LENGTH = 256;
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;
const COALESCE_MS = 16;
const LOW_DATA_COALESCE_MS = 64;
const REPLAY_BATCH_BYTES = 64 * 1024;
const LOW_DATA_REPLAY_BATCH_BYTES = 128 * 1024;
const DEFAULT_CHECKPOINT_HISTORY_LINES = 2000;
const DEFAULT_CHECKPOINT_MAX_BYTES = 1024 * 1024;
const LOW_DATA_CHECKPOINT_HISTORY_LINES = 300;
const LOW_DATA_CHECKPOINT_MAX_BYTES = 256 * 1024;
const PAUSE_DROP_LIMIT = 64 * 1024;
const LIVE_FLUSH_BYTES = 192 * 1024;
const ACTIVE_BUFFER_LIMIT = 256 * 1024;
const WS_SEND_HIGH_WATER = 1024 * 1024;
const WS_SEND_LOW_WATER = 256 * 1024;
const BACKPRESSURE_RETRY_MS = 50;
const REPLAY_QUEUE_CAP = 256 * 1024;
const REPLAY_QUEUE_TRIM = 192 * 1024;
const AGENT_TERMINAL_MAGIC = Buffer.from("TMG2");
const AGENT_TERMINAL_HEADER_BYTES = 11;
const REJECTED_TOKEN_TTL_MS = 5 * 60 * 1000;
const REJECTED_TOKEN_CAP = 1024;
const rejectedTokenExpiry = new Map();
let getNextAuthToken;

function sendJson(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendOutput(ws, data) {
  if (ws.readyState !== WebSocket.OPEN || !data || ws.bufferedAmount > WS_SEND_HIGH_WATER) {
    return false;
  }
  ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  return true;
}

function* coalesceReplayChunks(chunks, targetBytes = REPLAY_BATCH_BYTES) {
  let pending = [];
  let pendingBytes = 0;
  for (const data of chunks) {
    const chunk = asBuffer(data);
    if (pendingBytes && pendingBytes + chunk.length > targetBytes) {
      yield pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
    }
    if (chunk.length >= targetBytes) {
      yield chunk;
      continue;
    }
    pending.push(chunk);
    pendingBytes += chunk.length;
  }
  if (pendingBytes) {
    yield pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
  }
}

async function sendReplayChunks(
  ws,
  chunks,
  isCurrent = () => true,
  targetBytes = REPLAY_BATCH_BYTES
) {
  const deadline = Date.now() + 30_000;
  for (const data of coalesceReplayChunks(chunks, targetBytes)) {
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

function asBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
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
  stream.outChunks.push(chunk);
  stream.outBytes += chunk.length;
  if (stream.paused) {
    if (stream.outBytes > PAUSE_DROP_LIMIT) {
      markNeedsResync(stream, "output changed while this terminal was paused");
    }
    return;
  }
  if (stream.outBytes > ACTIVE_BUFFER_LIMIT) {
    markNeedsResync(stream, "browser could not keep up with terminal output");
  }
  // Preserve the low-data batching window for ordinary interactive output,
  // but do not let one near-maximum agent frame wait long enough to collide
  // with the next frame and trigger an unnecessary resync.
  if (!stream.needsResync && stream.outBytes >= LIVE_FLUSH_BYTES) {
    flushStream(stream);
    return;
  }
  scheduleFlush(
    stream,
    stream.needsResync ? BACKPRESSURE_RETRY_MS : stream.flushDelay || COALESCE_MS
  );
}

function flushStream(stream) {
  if (!stream || stream.paused) {
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
  if (!stream.outBytes) {
    return;
  }
  if (stream.ws.bufferedAmount > WS_SEND_HIGH_WATER) {
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
    stream.replayQueueBytes -= stream.replayQueue.shift().length;
  }
}

function parseAgentTerminalFrame(raw) {
  const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (
    frame.length < AGENT_TERMINAL_HEADER_BYTES ||
    !frame.subarray(0, 4).equals(AGENT_TERMINAL_MAGIC)
  ) {
    return null;
  }
  const flags = frame[4];
  const sequence = frame.readUInt32BE(5);
  const streamIdLength = frame.readUInt16BE(9);
  const payloadStart = AGENT_TERMINAL_HEADER_BYTES + streamIdLength;
  if (streamIdLength === 0 || streamIdLength > 512 || payloadStart > frame.length) {
    return null;
  }
  return {
    streamId: frame.subarray(AGENT_TERMINAL_HEADER_BYTES, payloadStart).toString("utf8"),
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
  const value = Array.isArray(header) ? header.join(";") : header || "";
  for (const part of value.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

function trustedNetworkEnabled() {
  return process.env.TERMINALZ_TRUSTED_NETWORK === "true";
}

function trustedUserEmail() {
  return (
    process.env.TERMINALZ_TRUSTED_USER_EMAIL?.toLowerCase().trim() ||
    process.env.TERMINALZ_ALLOWED_EMAIL?.toLowerCase().trim() ||
    "trusted@terminalz.local"
  );
}

function passwordCookieValid(cookies) {
  if (!trustedNetworkEnabled() || !process.env.TERMINALZ_PASSWORD) {
    return true;
  }
  const expected = hashToken(process.env.TERMINALZ_PASSWORD);
  const got = cookies["terminalz-auth"] || cookies["termag-auth"] || "";
  const left = Buffer.from(got);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function userIdFromRequest(req, prisma) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader === "string") {
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim();
    if (
      bearer?.startsWith("tmag_") &&
      bearer.length >= AGENT_TOKEN_MIN_LENGTH &&
      bearer.length <= AGENT_TOKEN_MAX_LENGTH
    ) {
      const record = await prisma.agentToken.findFirst({
        where: { tokenHash: hashToken(bearer), revokedAt: null },
        select: { id: true, userId: true },
      });
      if (record) {
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
  getNextAuthToken ||= require("next-auth/jwt").getToken;
  const token = await getNextAuthToken({
    req: { headers: req.headers, cookies: parseCookieHeader(req.headers.cookie) },
    secret: process.env.NEXTAUTH_SECRET,
  });
  return token?.sub || null;
}

function sanitizeAgentText(value, maxLen = 1024) {
  if (typeof value !== "string") {
    return "";
  }
  const stripped = value.replace(/[\x00-\x1F\x7F-\x9F]/g, " ");
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen - 1)}…` : stripped;
}

const CAPABILITY_KEYS = [
  "inventorySnapshots",
  "typedMutations",
  "sharedTerminalStreams",
  "herdr",
  "tmux",
  "directoryPolicy",
  "powerPolicy",
  "gitOperations",
  "fileUploads",
];

function normalizeCapabilities(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(CAPABILITY_KEYS.map(key => [key, source[key] === true]));
}

function normalizeRootMap(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, 128)
      .flatMap(([key, path]) => {
        const safeKey = sanitizeAgentText(key, 120).trim();
        const safePath = sanitizeAgentText(path, 2048).trim();
        return safeKey && safePath ? [[safeKey, safePath]] : [];
      })
  );
}

function terminalDimension(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function tokenRecentlyRejected(hash) {
  const expiry = rejectedTokenExpiry.get(hash);
  if (!expiry) {
    return false;
  }
  if (expiry < Date.now()) {
    rejectedTokenExpiry.delete(hash);
    return false;
  }
  return true;
}

function rememberRejectedToken(hash) {
  const now = Date.now();
  rejectedTokenExpiry.set(hash, now + REJECTED_TOKEN_TTL_MS);
  for (const [key, expiry] of rejectedTokenExpiry) {
    if (expiry < now) {
      rejectedTokenExpiry.delete(key);
    }
  }
  while (rejectedTokenExpiry.size > REJECTED_TOKEN_CAP) {
    rejectedTokenExpiry.delete(rejectedTokenExpiry.keys().next().value);
  }
}

function createBroker({ prisma, wss }) {
  const agents = new Map();
  const browserStreams = new Map();
  const terminalState = createTerminalCheckpointStore({
    activeSessionIds: () => new Set([...browserStreams.values()].map(stream => stream.stateKey)),
  });
  let sequence = 0;
  const sweep = setInterval(() => terminalState.sweep(), 60_000);
  sweep.unref?.();

  function nextRequestId() {
    sequence += 1;
    return `req_${sequence}_${Date.now()}`;
  }

  function agentsForUser(userId) {
    return agents.get(userId) || new Map();
  }

  function connectedAgents(userId) {
    return [...agentsForUser(userId).values()].filter(
      agent => agent.ws.readyState === WebSocket.OPEN
    );
  }

  function agentForUser(userId, deviceName) {
    const candidates = connectedAgents(userId);
    return deviceName
      ? candidates.find(agent => agent.deviceName === deviceName) || null
      : candidates[0] || null;
  }

  function publicAgentStatus(agent) {
    const inventoryRoots = Array.isArray(agent.inventory?.roots)
      ? Object.fromEntries(agent.inventory.roots.map(root => [root.key, root.path]))
      : null;
    return {
      name: agent.deviceName,
      deviceId: agent.tokenId,
      connected: agent.ws.readyState === WebSocket.OPEN,
      protocolVersion: 2,
      capabilities: agent.capabilities || {},
      runtimeSessions: Array.isArray(agent.inventory?.runtimes)
        ? agent.inventory.runtimes.map(runtime => ({
            kind: runtime.kind,
            available: runtime.available,
            sessions: runtime.sessions.map(session => ({ id: session.id, name: session.name })),
          }))
        : [],
      ...(agent.health || {}),
      roots: inventoryRoots || agent.health?.roots || {},
    };
  }

  function deviceStatuses(userId) {
    return connectedAgents(userId).map(publicAgentStatus);
  }

  function broadcastStatus(userId, refresh = false) {
    const devices = deviceStatuses(userId);
    for (const client of wss.clients) {
      if (client._termagStatusUserId === userId && client.readyState === WebSocket.OPEN) {
        sendJson(client, { type: "agent", connected: devices.length > 0, devices });
        if (refresh) {
          sendJson(client, { type: "refresh" });
        }
      }
    }
  }

  function broadcastDeviceHealth(userId, agent) {
    const device = {
      name: agent.deviceName,
      deviceId: agent.tokenId,
      connected: agent.ws.readyState === WebSocket.OPEN,
      protocolVersion: 2,
      version: agent.health?.version ?? null,
      streamCount: agent.health?.streamCount ?? 0,
      uptimeSec: agent.health?.uptimeSec ?? 0,
      memMb: agent.health?.memMb ?? 0,
      memPeakMb: agent.health?.memPeakMb ?? 0,
    };
    for (const client of wss.clients) {
      if (client._termagStatusUserId === userId && client.readyState === WebSocket.OPEN) {
        sendJson(client, { type: "device-health", device });
      }
    }
  }

  function broadcastInventoryPatch(userId, patch) {
    if (!patch?.projects?.length) {
      return;
    }
    for (const client of wss.clients) {
      if (client._termagStatusUserId === userId && client.readyState === WebSocket.OPEN) {
        sendJson(client, patch);
      }
    }
  }

  function sendToAgent(userId, deviceName, type, payload = {}, timeoutMs = 15_000) {
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

  function sendAgentEvent(userId, deviceName, type, payload = {}) {
    const agent = agentForUser(userId, deviceName);
    if (!agent) {
      return false;
    }
    sendJson(agent.ws, { type, ...payload });
    return true;
  }

  function findRuntimeTarget(userId, encodedSessionId) {
    const identity = decodeRuntimeId(encodedSessionId, "session");
    if (!identity?.tabId || !identity.paneId || !identity.terminalId) {
      return null;
    }
    const agent = connectedAgents(userId).find(
      candidate => candidate.tokenId === identity.deviceId
    );
    const runtime = agent?.inventory?.runtimes?.find(
      item => item.kind === identity.runtime && item.available
    );
    const runtimeSession = runtime?.sessions?.find(item => item.id === identity.runtimeSessionId);
    const space = runtimeSession?.spaces?.find(item => item.id === identity.spaceId);
    const tab = space?.tabs?.find(item => item.id === identity.tabId);
    const pane = tab?.panes?.find(item => item.id === identity.paneId);
    if (
      !agent ||
      !runtimeSession ||
      !space ||
      !tab ||
      !pane ||
      pane.terminalId !== identity.terminalId
    ) {
      return null;
    }
    return { agent, identity, runtimeSession, space, tab, pane };
  }

  function routeTerminalFrame(userId, deviceName, frame) {
    const anchor = browserStreams.get(frame.streamId);
    if (
      !anchor ||
      anchor.userId !== userId ||
      anchor.deviceName !== deviceName ||
      !frame.data ||
      frame.data.length > 256 * 1024
    ) {
      return;
    }
    const result = terminalState.ingest(anchor.stateKey, frame);
    if (result.gap) {
      for (const stream of browserStreams.values()) {
        if (stream.stateKey === anchor.stateKey) {
          markNeedsResync(stream, "terminal frame sequence was interrupted");
          scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
        }
      }
      return;
    }
    for (const stream of browserStreams.values()) {
      if (stream.stateKey !== anchor.stateKey || stream.userId !== userId) {
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
  }

  async function registerAgent(ws, token) {
    if (
      typeof token !== "string" ||
      !token.startsWith("tmag_") ||
      token.length < AGENT_TOKEN_MIN_LENGTH ||
      token.length > AGENT_TOKEN_MAX_LENGTH
    ) {
      ws.close(1008, "invalid token");
      return;
    }
    const tokenHash = hashToken(token);
    if (tokenRecentlyRejected(tokenHash)) {
      ws.close(1008, "invalid token");
      return;
    }
    const record = await prisma.agentToken.findFirst({
      where: { tokenHash, revokedAt: null },
      select: { id: true, userId: true, name: true },
    });
    if (!record) {
      rememberRejectedToken(tokenHash);
      ws.close(1008, "invalid token");
      return;
    }
    const deviceName = record.name || "Local device";
    let userAgents = agents.get(record.userId);
    if (!userAgents) {
      userAgents = new Map();
      agents.set(record.userId, userAgents);
    }
    const previous = userAgents.get(deviceName);
    if (previous) {
      for (const pending of previous.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Agent replaced by a newer connection"));
      }
      previous.pending.clear();
      previous.ws.close(1000, WS_REPLACED_REASON);
    }
    const agent = {
      ws,
      userId: record.userId,
      deviceName,
      tokenId: record.id,
      pending: new Map(),
      health: null,
      capabilities: {},
      inventory: null,
      inventoryProcessing: false,
      pendingInventory: null,
    };
    userAgents.set(deviceName, agent);
    await prisma.agentToken.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date(), protocolVersion: 2 },
    });
    broadcastStatus(record.userId, true);

    for (const stream of browserStreams.values()) {
      if (stream.userId === record.userId && stream.deviceName === deviceName && !stream.attached) {
        stream.reattach?.().catch(() => {});
      }
    }

    ws.on("message", async (raw, isBinary) => {
      if (isBinary) {
        const frame = parseAgentTerminalFrame(raw);
        if (frame) {
          routeTerminalFrame(record.userId, deviceName, frame);
        }
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.requestId && agent.pending.has(message.requestId)) {
        const pending = agent.pending.get(message.requestId);
        clearTimeout(pending.timer);
        agent.pending.delete(message.requestId);
        if (message.error) {
          pending.reject(new Error(sanitizeAgentText(message.error, 512)));
        } else {
          pending.resolve(message.data ?? {});
        }
        return;
      }
      if (message.type === "health") {
        if (Number(message.protocolVersion) !== 2) {
          ws.close(1008, "protocol v2 required");
          return;
        }
        agent.health = {
          version: typeof message.version === "string" ? message.version : null,
          streamCount: Number(message.streamCount) || 0,
          uptimeSec: Number(message.uptimeSec) || 0,
          memMb: Number(message.memMb) || 0,
          memPeakMb: Number(message.memPeakMb) || 0,
          roots: normalizeRootMap(message.roots),
        };
        broadcastDeviceHealth(record.userId, agent);
        return;
      }
      if (message.type === "inventory.snapshot") {
        if (Number(message.protocolVersion) !== 2 || !message.inventory) {
          ws.close(1008, "protocol v2 inventory required");
          return;
        }
        const revision = Number(message.inventory.revision) || 0;
        if (revision <= (agent.inventory ? Number(agent.inventory.revision) : -1)) {
          return;
        }
        if (!agent.pendingInventory || revision >= agent.pendingInventory.revision) {
          agent.pendingInventory = { revision, message };
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
              if (pending.revision <= (agent.inventory ? Number(agent.inventory.revision) : -1)) {
                continue;
              }
              const snapshot = normalizeSnapshot(pending.message.inventory);
              const serialized = JSON.stringify(snapshot);
              if (serialized.length > MAX_INVENTORY_BYTES) {
                throw new Error("inventory snapshot exceeded 4 MiB");
              }
              const previousInventory = agent.inventory;
              const previousCapabilities = agent.capabilities;
              const nextCapabilities = normalizeCapabilities(pending.message.capabilities);
              const patch = createInventoryPatch(previousInventory, snapshot, record.id);
              const capabilitiesChanged =
                JSON.stringify(previousCapabilities) !== JSON.stringify(nextCapabilities);
              agent.capabilities = nextCapabilities;
              agent.inventory = snapshot;
              await prisma.agentToken.update({
                where: { id: record.id },
                data: {
                  protocolVersion: 2,
                  capabilities: JSON.stringify(agent.capabilities),
                  inventorySnapshot: serialized,
                  lastInventoryAt: new Date(),
                },
              });
              for (const stream of browserStreams.values()) {
                if (
                  stream.userId === record.userId &&
                  stream.deviceName === deviceName &&
                  !stream.attached
                ) {
                  void stream.reattach?.();
                }
              }
              if (patch) {
                if (capabilitiesChanged) {
                  broadcastStatus(record.userId);
                }
                broadcastInventoryPatch(record.userId, patch);
              } else {
                broadcastStatus(record.userId, true);
              }
            }
          } catch (error) {
            console.error("[inventory]", sanitizeAgentText(error?.message || String(error), 512));
          } finally {
            agent.inventoryProcessing = false;
          }
        })();
        return;
      }
      if (message.type === "terminal-gap" && message.streamId) {
        const anchor = browserStreams.get(message.streamId);
        if (!anchor || anchor.userId !== record.userId || anchor.deviceName !== deviceName) {
          return;
        }
        terminalState.drop(anchor.stateKey);
        for (const stream of browserStreams.values()) {
          if (stream.stateKey === anchor.stateKey) {
            markNeedsResync(stream, "local terminal output exceeded its bounded queue");
            scheduleFlush(stream, BACKPRESSURE_RETRY_MS);
          }
        }
        return;
      }
      if (message.type === "driver-changed" && message.streamId) {
        const stream = browserStreams.get(message.streamId);
        if (stream?.userId === record.userId && stream.deviceName === deviceName) {
          stream.driver = Boolean(message.driver);
          stream.readOnly = Boolean(message.readOnly);
          sendJson(stream.ws, {
            type: "driver-changed",
            driver: stream.driver,
            readOnly: stream.readOnly,
          });
        }
        return;
      }
      if (message.type === "terminal-exit" && message.streamId) {
        const stream = browserStreams.get(message.streamId);
        if (stream?.userId === record.userId && stream.deviceName === deviceName) {
          stream.attached = false;
          stream.driver = false;
          sendJson(stream.ws, { type: "exit" });
          broadcastStatus(record.userId, true);
        }
      }
    });

    ws.on("close", () => {
      if (agentsForUser(record.userId).get(deviceName) !== agent) {
        return;
      }
      userAgents.delete(deviceName);
      if (userAgents.size === 0) {
        agents.delete(record.userId);
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
          stream.driver = false;
          sendJson(stream.ws, { type: "sleeping", message: "Agent disconnected" });
        }
      }
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
    const userId = await userIdFromRequest(req, prisma);
    if (!userId) {
      ws.close(1008, "login required");
      return;
    }
    if (url.pathname === "/api/ws/status") {
      ws._termagStatusUserId = userId;
      const devices = deviceStatuses(userId);
      sendJson(ws, { type: "agent", connected: devices.length > 0, devices });
      return;
    }
    if (url.pathname !== "/api/ws/terminal") {
      ws.close(1008, "unsupported websocket endpoint");
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    const target = sessionId && findRuntimeTarget(userId, sessionId);
    if (!sessionId || !target) {
      const devices = deviceStatuses(userId);
      console.warn(
        `[terminal-ws-target] unavailable session=${sessionId ? "present" : "missing"} devices=${devices.length} runtimes=${devices.reduce((count, device) => count + (device.runtimes?.length || 0), 0)}`
      );
      ws.close(1008, "runtime terminal unavailable");
      return;
    }
    const cols = terminalDimension(url.searchParams.get("cols"), 80, 20, 500);
    const rows = terminalDimension(url.searchParams.get("rows"), 24, 5, 200);
    const lowData = url.searchParams.get("dataMode") === "low";
    const streamId = `stream_${nextRequestId()}`;
    const stream = {
      ws,
      userId,
      deviceName: target.agent.deviceName,
      sessionId,
      stateKey: target.identity.runtime === "herdr" ? streamId : sessionId,
      target,
      attached: false,
      attachPromise: null,
      driver: false,
      readOnly: false,
      cols,
      rows,
      replaying: true,
      replayQueue: [],
      replayQueueBytes: 0,
      replayQueueTruncated: false,
      replayEpoch: 0,
      outChunks: [],
      outBytes: 0,
      needsResync: false,
      resyncSent: false,
      paused: false,
      lowData,
      flushDelay: lowData ? LOW_DATA_COALESCE_MS : COALESCE_MS,
    };
    browserStreams.set(streamId, stream);
    let closed = false;

    function cleanup() {
      if (closed) {
        return;
      }
      closed = true;
      if (stream.flushTimer) {
        clearTimeout(stream.flushTimer);
      }
      clearOutputBuffer(stream);
      stream.replayQueue = [];
      browserStreams.delete(streamId);
      if (stream.attached) {
        sendAgentEvent(userId, stream.deviceName, "terminal-close", { streamId });
      }
      if (![...browserStreams.values()].some(other => other.stateKey === stream.stateKey)) {
        terminalState.drop(stream.stateKey);
      }
    }
    ws.once("close", (code, reason) => {
      if (code !== 1000) {
        const extensions = Object.keys(ws._extensions || {}).join(",") || "none";
        const userAgent = sanitizeAgentText(req.headers["user-agent"] || "unknown", 160);
        console.warn(
          `[terminal-ws-close] code=${code} reason=${sanitizeAgentText(reason?.toString(), 160) || "none"} extensions=${extensions} agent=${userAgent}`
        );
      }
      cleanup();
    });
    ws.on("error", error => {
      console.warn(
        `[terminal-ws-error] ${sanitizeAgentText(error?.message || String(error), 256)}`
      );
    });

    const checkpoint = terminalState.replay(stream.stateKey);
    if (checkpoint) {
      const epoch = stream.replayEpoch;
      sendJson(ws, { type: "checkpoint", sequence: checkpoint.sequence });
      if (
        !(await sendReplayChunks(
          ws,
          checkpoint.chunks,
          () => stream.replayEpoch === epoch,
          lowData ? LOW_DATA_REPLAY_BATCH_BYTES : REPLAY_BATCH_BYTES
        ))
      ) {
        cleanup();
        ws.close(1012, "terminal replay stalled");
        return;
      }
    }
    if (closed) {
      return;
    }
    stream.replaying = false;
    if (
      stream.replayQueueTruncated ||
      !(await sendReplayChunks(
        ws,
        stream.replayQueue,
        () => true,
        lowData ? LOW_DATA_REPLAY_BATCH_BYTES : REPLAY_BATCH_BYTES
      ))
    ) {
      markNeedsResync(stream, "terminal output changed too quickly during attach");
      scheduleFlush(stream, 0);
      return;
    }
    stream.replayQueue = [];
    stream.replayQueueBytes = 0;

    async function attachToAgent() {
      if (stream.attached) {
        return true;
      }
      if (stream.attachPromise) {
        return stream.attachPromise;
      }
      stream.attachPromise = (async () => {
        try {
          const current = findRuntimeTarget(userId, sessionId);
          if (!current) {
            throw new Error("runtime terminal unavailable");
          }
          stream.target = current;
          stream.deviceName = current.agent.deviceName;
          stream.driver = false;
          const identity = current.identity;
          await sendToAgent(userId, stream.deviceName, "terminal-attach", {
            streamId,
            sessionId,
            runtimeTarget: {
              runtime: identity.runtime,
              runtimeSessionId: identity.runtimeSessionId,
              paneId: identity.paneId,
              terminalId: identity.terminalId,
              tmuxSession: identity.runtimeSessionId,
              cwd: current.pane.cwd || current.runtimeSession.path || undefined,
            },
            cols: stream.cols,
            rows: stream.rows,
            readOnly: false,
            requestCheckpoint: terminalState.claimCheckpointRequest(stream.stateKey),
            checkpointHistoryLines: lowData
              ? LOW_DATA_CHECKPOINT_HISTORY_LINES
              : DEFAULT_CHECKPOINT_HISTORY_LINES,
            checkpointMaxBytes: lowData
              ? LOW_DATA_CHECKPOINT_MAX_BYTES
              : DEFAULT_CHECKPOINT_MAX_BYTES,
          });
          if (closed || ws.readyState !== WebSocket.OPEN) {
            sendAgentEvent(userId, stream.deviceName, "terminal-close", { streamId });
            return false;
          }
          stream.attached = true;
          sendJson(ws, { type: "ready" });
          return true;
        } catch (error) {
          terminalState.releaseCheckpointRequest(stream.stateKey);
          stream.attached = false;
          stream.driver = false;
          sendJson(ws, {
            type: "sleeping",
            message: sanitizeAgentText(error?.message || "Agent offline", 256),
          });
          return false;
        } finally {
          stream.attachPromise = null;
        }
      })();
      return stream.attachPromise;
    }
    stream.reattach = attachToAgent;
    await attachToAgent();

    ws.on("message", async raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "ping") {
        sendJson(ws, { type: "pong" });
      } else if (message.type === "input") {
        const inputId = typeof message.inputId === "string" ? message.inputId : "";
        const wantsConfirmation = inputId.length > 0;
        const confirmed = /^[a-f0-9]{32}$/i.test(inputId);
        const invalid =
          (wantsConfirmation && !confirmed) ||
          typeof message.data !== "string" ||
          Buffer.byteLength(message.data || "", "utf8") > 256 * 1024;
        if (invalid || stream.readOnly || !(await attachToAgent())) {
          if (inputId) {
            sendJson(ws, {
              type: "terminal-input-error",
              inputId,
              message: invalid
                ? "Invalid terminal input"
                : stream.readOnly
                  ? "Terminal is read-only"
                  : "Agent is not attached to this terminal",
            });
          }
          return;
        }
        // Protocol v2 terminal-input is an atomic claim+write at the agent.
        // This keeps the latest keystroke authoritative even when two browser
        // connections interact with the same pane at nearly the same time.
        if (confirmed) {
          try {
            await sendToAgent(userId, stream.deviceName, "terminal-input", {
              streamId,
              data: message.data,
            });
            sendJson(ws, { type: "terminal-input-complete", inputId });
          } catch (error) {
            sendJson(ws, {
              type: "terminal-input-error",
              inputId,
              message: sanitizeAgentText(error?.message || "Terminal input failed", 256),
            });
          }
        } else {
          sendAgentEvent(userId, stream.deviceName, "terminal-input", {
            streamId,
            data: message.data,
          });
        }
      } else if (message.type === "resize") {
        stream.cols = terminalDimension(message.cols, stream.cols, 20, 500);
        stream.rows = terminalDimension(message.rows, stream.rows, 5, 200);
        if (stream.attached) {
          sendAgentEvent(userId, stream.deviceName, "terminal-resize", {
            streamId,
            cols: stream.cols,
            rows: stream.rows,
          });
        }
      } else if (message.type === "claim-drive" && stream.attached) {
        stream.driver = true;
        sendAgentEvent(userId, stream.deviceName, "terminal-claim-drive", { streamId });
      } else if (message.type === "release-drive" && stream.attached) {
        stream.driver = false;
        sendAgentEvent(userId, stream.deviceName, "terminal-release-drive", { streamId });
      } else if (message.type === "file-upload-chunk" && stream.attached) {
        const uploadId = typeof message.uploadId === "string" ? message.uploadId : "";
        const fileName = typeof message.fileName === "string" ? message.fileName : "";
        const data = typeof message.data === "string" ? message.data : "";
        const offset = Number(message.offset);
        if (
          !/^[a-f0-9]{32}$/i.test(uploadId) ||
          !fileName ||
          fileName.length > 255 ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          data.length > 400_000
        ) {
          sendJson(ws, {
            type: "file-upload-error",
            uploadId,
            offset,
            message: "Invalid upload chunk",
          });
          return;
        }
        try {
          const current = findRuntimeTarget(userId, sessionId);
          const cwd = current?.pane?.cwd;
          const roots = current?.agent?.inventory?.roots || [];
          // Hermes can run inside a Docker container while Herdr remains on
          // the host. The space name is the container identity in that setup;
          // this value comes from the connected agent's inventory, never from
          // a browser-supplied path or command. The machine agent still
          // validates the name and local directory policy before using it.
          const tabAgent = String(current?.pane?.agent || current?.tab?.name || "").toLowerCase();
          const containerName =
            current?.identity?.runtime === "herdr" &&
            tabAgent === "hermes" &&
            /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(current?.space?.name || "")
              ? current.space.name
              : undefined;
          const cwdRoot = roots
            .filter(
              item =>
                item?.key &&
                item?.path &&
                (cwd === item.path || cwd?.startsWith(`${item.path.replace(/\/+$/, "")}/`))
            )
            .sort((left, right) => right.path.length - left.path.length)[0];
          // A containerized pane's reported cwd belongs to the host-side Herdr
          // process and need not be inside the container's data bind. Select
          // the explicitly configured root named for that container instead.
          const containerRoot = containerName
            ? roots.find(item => item?.key === containerName && item?.path)
            : undefined;
          const root = containerRoot || cwdRoot;
          if (!current || !cwd || !root || (containerName && !containerRoot)) {
            throw new Error("Terminal directory is outside the configured upload roots");
          }
          const base = root.path.replace(/\/+$/, "");
          const relativeDirectory = containerName
            ? ""
            : cwd === base
              ? ""
              : cwd.slice(base.length + 1);
          const result = await sendToAgent(userId, stream.deviceName, "file.upload-chunk", {
            rootKey: root.key,
            relativeDirectory,
            fileName,
            uploadId,
            offset,
            data,
            ...(containerName ? { containerName } : {}),
          });
          sendJson(ws, {
            type: "file-upload-complete",
            uploadId,
            offset,
            path: result.path,
          });
        } catch (error) {
          sendJson(ws, {
            type: "file-upload-error",
            uploadId,
            offset,
            message: sanitizeAgentText(error?.message || "Upload failed", 256),
          });
        }
      } else if (message.type === "hibernate") {
        stream.paused = true;
        clearOutputBuffer(stream);
        stream.replayQueue = [];
        stream.replayQueueBytes = 0;
        stream.replayQueueTruncated = false;
        terminalState.drop(stream.stateKey);
        if (stream.attached) {
          sendAgentEvent(userId, stream.deviceName, "terminal-close", { streamId });
          stream.attached = false;
          stream.driver = false;
        }
      } else if (message.type === "wake") {
        stream.paused = false;
        await attachToAgent();
        flushStream(stream);
      } else if (message.type === "pause") {
        stream.paused = true;
      } else if (message.type === "resume") {
        stream.paused = false;
        flushStream(stream);
      }
    });
  }

  return {
    registerAgent,
    registerBrowser,
    ...createBrokerRpc({
      WebSocket,
      connectedAgents,
      publicAgentStatus,
      agentForUser,
      sendJson,
      sendToAgent,
      broadcastStatus,
    }),
  };
}

module.exports = { coalesceReplayChunks, createBroker, parseAgentTerminalFrame };
