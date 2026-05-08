const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { getToken } = require('next-auth/jwt');
const { appendScrollback } = require('./scrollback');

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
  if (ws.readyState !== WebSocket.OPEN || !data) return;
  ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
}

const COALESCE_MS = 16;       // ~60fps flush — imperceptible latency
const PAUSE_DROP_LIMIT = 64 * 1024; // bytes buffered while paused; older bytes dropped

function bufferAndFlush(stream, data) {
  if (!stream || !data) return;
  stream.outBuffer = (stream.outBuffer || '') + data;
  if (stream.paused) {
    if (stream.outBuffer.length > PAUSE_DROP_LIMIT) {
      stream.outBuffer = stream.outBuffer.slice(-PAUSE_DROP_LIMIT);
      stream.pausedTrimmed = true;
    }
    return;
  }
  if (stream.flushTimer) return;
  stream.flushTimer = setTimeout(() => {
    stream.flushTimer = null;
    flushStream(stream);
  }, COALESCE_MS);
}

function flushStream(stream) {
  if (!stream || !stream.outBuffer) return;
  if (stream.paused) return;
  const data = stream.outBuffer;
  stream.outBuffer = '';
  sendOutput(stream.ws, data);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookieHeader(header) {
  const cookies = {};
  if (!header) return cookies;
  const value = Array.isArray(header) ? header.join(';') : header;
  for (const part of value.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
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
  // On by default. Opt out with TERMAG_TRUSTED_NETWORK=false to require OAuth.
  return process.env.TERMAG_TRUSTED_NETWORK !== 'false';
}

function trustedUserEmail() {
  return (
    process.env.TERMAG_TRUSTED_USER_EMAIL?.toLowerCase().trim()
    || process.env.TERMAG_ALLOWED_EMAIL?.toLowerCase().trim()
    || 'trusted@termag.local'
  );
}

function passwordGateEnabled() {
  return trustedNetworkEnabled() && Boolean(process.env.TERMAG_PASSWORD);
}

function expectedPasswordCookie() {
  return crypto.createHash('sha256').update(process.env.TERMAG_PASSWORD || '').digest('hex');
}

function safeTimingEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function passwordCookieValid(cookies) {
  if (!passwordGateEnabled()) return true;
  const expected = expectedPasswordCookie();
  const got = cookies['termag-auth'];
  return Boolean(got && safeTimingEqual(got, expected));
}

async function userIdFromRequest(req, prisma) {
  if (trustedNetworkEnabled()) {
    if (!passwordCookieValid(parseCookieHeader(req.headers.cookie))) return null;
    const user = await prisma.user.upsert({
      where: { email: trustedUserEmail() },
      update: {},
      create: { email: trustedUserEmail(), displayName: 'Trusted User', theme: 'dark' }
    });
    return user.id;
  }
  const token = await getToken({
    req: { headers: req.headers, cookies: parseCookieHeader(req.headers.cookie) },
    secret: process.env.NEXTAUTH_SECRET
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
  const browserStreams = new Map();
  const sessionPrimary = new Map();
  let seq = 0;

  function nextRequestId() {
    seq += 1;
    return `req_${seq}_${Date.now()}`;
  }

  function agentsForUser(userId) {
    return agents.get(userId) || new Map();
  }

  function connectedAgents(userId) {
    return [...agentsForUser(userId).values()].filter((agent) => agent.ws.readyState === WebSocket.OPEN);
  }

  function agentForUser(userId, deviceName) {
    const userAgents = agentsForUser(userId);
    const exact = deviceName ? userAgents.get(deviceName) : null;
    if (exact?.ws.readyState === WebSocket.OPEN) return exact;
    if (deviceName) return null;
    const live = [...userAgents.values()].filter((agent) => agent.ws.readyState === WebSocket.OPEN);
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
    if (!userAgents || userAgents.get(deviceName)?.ws !== ws) return false;
    userAgents.delete(deviceName);
    if (userAgents.size === 0) agents.delete(userId);
    return true;
  }

  function sendToAgent(userId, deviceName, type, payload = {}, timeoutMs = 15000) {
    const agent = agentForUser(userId, deviceName);
    if (!agent) return Promise.reject(new Error('Agent offline'));
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

  function claimPrimary(sessionId, streamId) {
    if (!sessionPrimary.has(sessionId)) sessionPrimary.set(sessionId, streamId);
  }

  function releasePrimary(sessionId, streamId) {
    if (sessionPrimary.get(sessionId) !== streamId) return;
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
      select: { status: true }
    });
    const statuses = sessions.map((session) => session.status);
    const status = ['error', 'waiting', 'working', 'idle'].find((candidate) => statuses.includes(candidate)) || 'sleeping';
    await prisma.project.update({ where: { id: projectId }, data: { status } }).catch(() => {});
    return status;
  }

  function broadcastStatus(userId, refresh = false) {
    const devices = connectedAgents(userId).map((agent) => agent.deviceName);
    for (const client of wss.clients) {
      if (client._termagStatusUserId === userId && client.readyState === WebSocket.OPEN) {
        sendJson(client, { type: 'agent', connected: devices.length > 0, devices });
        if (refresh) sendJson(client, { type: 'refresh' });
      }
    }
  }

  async function registerAgent(ws, token) {
    const record = await prisma.agentToken.findFirst({
      where: { tokenHash: hashToken(token), revokedAt: null },
      include: { user: true }
    });
    if (!record) {
      ws.close(1008, 'invalid token');
      return;
    }

    await prisma.agentToken.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() }
    });

    const deviceName = record.name || 'Local device';
    const existing = agentsForUser(record.userId).get(deviceName);
    if (existing?.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(1000, 'replaced');
    }

    const agent = { ws, userId: record.userId, deviceName, tokenId: record.id, pending: new Map() };
    setAgent(record.userId, deviceName, agent);

    await prisma.project.updateMany({
      where: { userId: record.userId, rootKey: deviceName },
      data: { status: 'idle' }
    });
    await prisma.session.updateMany({
      where: { project: { userId: record.userId, rootKey: deviceName } },
      data: { status: 'idle', lastSeenAt: new Date() }
    });
    await prisma.tab.updateMany({
      where: { project: { userId: record.userId, rootKey: deviceName } },
      data: { status: 'idle' }
    });
    broadcastStatus(record.userId, true);

    // Re-attach any browser streams that were left orphaned by a prior agent disconnect.
    for (const stream of browserStreams.values()) {
      if (stream.userId === record.userId && stream.deviceName === deviceName && !stream.attached && typeof stream.reattach === 'function') {
        stream.reattach().catch(() => {});
      }
    }

    ws.on('message', async (raw) => {
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
        msg.error ? pending.reject(new Error(msg.error)) : pending.resolve(msg.data ?? {});
        return;
      }

      if (msg.type === 'terminal-data' && msg.streamId) {
        const stream = browserStreams.get(msg.streamId);
        if (!stream) return;
        bufferAndFlush(stream, msg.data);
        if (sessionPrimary.get(stream.sessionId) === msg.streamId) {
          appendScrollback(prisma, stream.sessionId, msg.data).catch((err) => console.error('[scrollback]', err.message));
        }
        return;
      }

      if (msg.type === 'terminal-exit' && msg.streamId) {
        const stream = browserStreams.get(msg.streamId);
        if (stream) {
          stream.attached = false;
          sendJson(stream.ws, { type: 'exit' });
          await prisma.session.update({
            where: { id: stream.sessionId },
            data: { status: 'sleeping' }
          }).catch(() => {});
          const exitedSession = await prisma.session.findUnique({
            where: { id: stream.sessionId },
            select: { tabId: true, projectId: true }
          }).catch(() => null);
          if (exitedSession?.tabId) {
            await prisma.tab.update({ where: { id: exitedSession.tabId }, data: { status: 'sleeping' } }).catch(() => {});
          }
          if (exitedSession?.projectId) {
            await updateProjectStatus(exitedSession.projectId);
          }
          broadcastStatus(stream.userId, true);
        }
        return;
      }

      if (msg.type === 'status' && msg.sessionId && msg.status) {
        const updated = await prisma.session.update({
          where: { id: msg.sessionId },
          data: { status: msg.status, lastSeenAt: new Date() }
        }).catch(() => {});
        if (updated?.tabId) {
          await prisma.tab.update({ where: { id: updated.tabId }, data: { status: msg.status } }).catch(() => {});
        }
        if (updated?.projectId) {
          await updateProjectStatus(updated.projectId);
        }
        broadcastStatus(record.userId, true);
      }
    });

    ws.on('close', async () => {
      if (!removeAgent(record.userId, deviceName, ws)) return;
      for (const pending of agent.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Agent disconnected'));
      }
      for (const stream of browserStreams.values()) {
        if (stream.userId === record.userId && stream.deviceName === deviceName && stream.attached) {
          stream.attached = false;
          sendJson(stream.ws, { type: 'sleeping', message: 'Agent disconnected; reconnect termag-agent on your laptop.' });
        }
      }
      await prisma.project.updateMany({
        where: { userId: record.userId, rootKey: deviceName },
        data: { status: 'sleeping' }
      });
      await prisma.session.updateMany({
        where: { project: { userId: record.userId, rootKey: deviceName } },
        data: { status: 'sleeping' }
      });
      await prisma.tab.updateMany({
        where: { project: { userId: record.userId, rootKey: deviceName } },
        data: { status: 'sleeping' }
      });
      broadcastStatus(record.userId, true);
    });

    sendJson(ws, { type: 'hello', userId: record.userId, deviceName });
  }

  async function registerBrowser(ws, req, url) {
    const userId = await userIdFromRequest(req, prisma);
    if (!userId) {
      ws.close(1008, 'login required');
      return;
    }

    if (url.pathname === '/api/ws/status') {
      ws._termagStatusUserId = userId;
      const devices = connectedAgents(userId).map((agent) => agent.deviceName);
      sendJson(ws, { type: 'agent', connected: devices.length > 0, devices });
      return;
    }

    const sessionId = url.searchParams.get('sessionId');
    const cols = Number(url.searchParams.get('cols') || 80);
    const rows = Number(url.searchParams.get('rows') || 24);
    // Mobile / save-data hints. Browser appends `&saveData=1` when the user
    // is on a metered connection or iOS Low Data Mode; UA detects phones.
    const ua = req.headers['user-agent'] || '';
    const saveData = url.searchParams.get('saveData') === '1';
    const isPhone = /iPhone|iPod|Android.*Mobile/.test(ua);
    const lowBandwidth = saveData || isPhone;
    if (!sessionId) {
      ws.close(1008, 'sessionId required');
      return;
    }

    const session = await prisma.session.findFirst({
      where: { id: sessionId, project: { userId } },
      include: { project: true, tab: true }
    });
    if (!session) {
      ws.close(1008, 'session forbidden');
      return;
    }

    await prisma.project.update({ where: { id: session.projectId }, data: { openedAt: new Date() } });

    // On mobile/saveData: send only the most recent ~500 lines of scrollback.
    // Otherwise replay everything (~10K-line cap from appendScrollback).
    if (lowBandwidth) {
      // Cap at 64 chunks newest-first; with the broker's coalesce-window
      // sizing this comfortably covers 500+ lines without materializing
      // the whole 10K-line history into Node memory just to slice it.
      const recentChunks = await prisma.scrollbackChunk.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        select: { data: true, lineCount: true },
        take: 64
      });
      let lines = 0;
      const slice = [];
      for (const chunk of recentChunks) {
        slice.push(chunk);
        lines += chunk.lineCount;
        if (lines >= 500) break;
      }
      slice.reverse();
      for (const chunk of slice) sendOutput(ws, chunk.data);
    } else {
      const chunks = await prisma.scrollbackChunk.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'asc' },
        select: { data: true }
      });
      for (const chunk of chunks) sendOutput(ws, chunk.data);
    }

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
      reattach: () => attachToAgent()
    };
    browserStreams.set(streamId, stream);
    claimPrimary(sessionId, streamId);

    async function markSessionStatus(status) {
      await prisma.session.update({
        where: { id: session.id },
        data: { status, lastSeenAt: status === 'sleeping' ? session.lastSeenAt : new Date() }
      }).catch(() => {});
      if (session.tabId) {
        await prisma.tab.update({ where: { id: session.tabId }, data: { status } }).catch(() => {});
      }
      await updateProjectStatus(session.projectId);
      broadcastStatus(userId, true);
    }

    async function attachToAgent() {
      if (stream.attached) return true;
      if (stream.attachPromise) return stream.attachPromise;
      stream.attachPromise = (async () => {
        try {
          await sendToAgent(userId, session.project.rootKey, 'terminal-attach', {
            streamId,
            sessionId,
            tmuxName: session.tmuxName,
            tmuxSessionName: session.project.tmuxSessionName,
            tmuxWindowName: session.tmuxWindowName,
            createMode: session.tmuxManaged === false
              ? 'none'
              : (session.project.tmuxSessionName && session.tmuxWindowName ? 'window' : 'session'),
            kind: session.kind,
            cwd: { rootKey: session.project.rootKey, relativePath: session.project.relativePath },
            spawnCommand: session.kind === 'ctrl'
              ? session.project.ctrlSpawnCommand
              : (session.spawnCommand || session.project.agentSpawnCommand),
            cols: stream.cols,
            rows: stream.rows
          });
          stream.attached = true;
          await markSessionStatus('idle');
          sendJson(ws, { type: 'ready' });
          return true;
        } catch {
          stream.attached = false;
          await markSessionStatus('sleeping');
          sendJson(ws, { type: 'sleeping', message: 'Agent offline; open termag-agent on your laptop to reconnect.' });
          return false;
        } finally {
          stream.attachPromise = null;
        }
      })();
      return stream.attachPromise;
    }

    await attachToAgent();

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input') {
        if (!(await attachToAgent())) return;
        sendToAgent(userId, session.project.rootKey, 'terminal-input', { streamId, data: msg.data }, 1000).catch(() => {});
      }
      if (msg.type === 'resize') {
        if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          stream.cols = msg.cols;
          stream.rows = msg.rows;
        }
        if (stream.attached) {
          sendToAgent(userId, session.project.rootKey, 'terminal-resize', { streamId, cols: msg.cols, rows: msg.rows }, 1000).catch(() => {});
        }
      }
      if (msg.type === 'kill' && session.tmuxManaged !== false && agentForUser(userId, session.project.rootKey)) {
        sendToAgent(userId, session.project.rootKey, 'tmux-kill-window', { tmuxName: session.tmuxName }, 5000).catch(() => {});
      }
      if (msg.type === 'pause') {
        // Browser tab/app is hidden — stop forwarding output. Buffer is
        // capped at PAUSE_DROP_LIMIT to bound memory; older bytes drop.
        stream.paused = true;
      }
      if (msg.type === 'resume') {
        stream.paused = false;
        if (stream.pausedTrimmed) {
          sendOutput(stream.ws, '\r\n[output trimmed while paused]\r\n');
          stream.pausedTrimmed = false;
        }
        flushStream(stream);
      }
    });

    ws.on('close', () => {
      const wasAttached = stream.attached;
      if (stream.flushTimer) clearTimeout(stream.flushTimer);
      browserStreams.delete(streamId);
      releasePrimary(sessionId, streamId);
      if (wasAttached) sendToAgent(userId, session.project.rootKey, 'terminal-close', { streamId }, 1000).catch(() => {});
    });
  }

  return {
    registerAgent,
    registerBrowser,
    refreshUser(userId) {
      broadcastStatus(userId, true);
    },
    async listTmuxSessions(userId) {
      const liveAgents = connectedAgents(userId);
      const results = await Promise.all(liveAgents.map(async (agent) => {
        try {
          const data = await sendToAgent(userId, agent.deviceName, 'tmux-list', {}, 5000);
          const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
          return sessions.map((session) => ({ ...session, rootKey: agent.deviceName }));
        } catch {
          return [];
        }
      }));
      return results.flat();
    },
    killTmuxSession(userId, deviceName, tmuxSessionName, timeoutMs = 5000) {
      if (!tmuxSessionName || !agentForUser(userId, deviceName)) return Promise.resolve(false);
      return sendToAgent(userId, deviceName, 'tmux-kill-session', { tmuxSessionName }, timeoutMs)
        .then(() => true)
        .catch(() => false);
    },
    killTmuxWindow(userId, deviceName, tmuxName, timeoutMs = 5000) {
      if (!tmuxName || !agentForUser(userId, deviceName)) return Promise.resolve(false);
      return sendToAgent(userId, deviceName, 'tmux-kill-window', { tmuxName }, timeoutMs)
        .then(() => true)
        .catch(() => false);
    },
    killTmux(userId, tmuxName, timeoutMs = 5000) {
      if (!tmuxName || !agentForUser(userId)) return Promise.resolve(false);
      return sendToAgent(userId, undefined, 'tmux-kill', { tmuxName }, timeoutMs)
        .then(() => true)
        .catch(() => false);
    }
  };
}

module.exports = { createBroker };
