const http = require('node:http');
const next = require('next');
const { WebSocketServer, WebSocket } = require('ws');
const { PrismaClient } = require('@prisma/client');
const { getToken } = require('next-auth/jwt');
const crypto = require('node:crypto');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const prisma = new PrismaClient();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function lineCount(data) {
  return Math.max(1, (data.match(/\n/g) || []).length);
}

async function appendScrollback(sessionId, data) {
  const lines = lineCount(data);
  await prisma.scrollbackChunk.create({ data: { sessionId, data, lineCount: lines } });

  const chunks = await prisma.scrollbackChunk.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, lineCount: true }
  });

  let total = 0;
  const deleteIds = [];
  for (const chunk of chunks) {
    total += chunk.lineCount;
    if (total > 10000) deleteIds.push(chunk.id);
  }
  if (deleteIds.length) {
    await prisma.scrollbackChunk.deleteMany({ where: { id: { in: deleteIds } } });
  }
}

function sendJson(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => handle(req, res));
  const wss = new WebSocketServer({ noServer: true });

  const agents = new Map();
  const browserStreams = new Map();
  let seq = 0;

  function nextRequestId() {
    seq += 1;
    return `req_${seq}_${Date.now()}`;
  }

  function agentForUser(userId) {
    const agent = agents.get(userId);
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) return null;
    return agent;
  }

  function sendToAgent(userId, type, payload = {}, timeoutMs = 15000) {
    const agent = agentForUser(userId);
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

    const existing = agents.get(record.userId);
    if (existing?.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(1000, 'replaced');
    }

    const agent = { ws, userId: record.userId, pending: new Map() };
    agents.set(record.userId, agent);

    await prisma.project.updateMany({
      where: { userId: record.userId },
      data: { status: 'idle' }
    });
    await prisma.session.updateMany({
      where: { project: { userId: record.userId } },
      data: { status: 'idle', lastSeenAt: new Date() }
    });
    broadcastStatus(record.userId, true);

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
        sendJson(stream.ws, { type: 'output', data: msg.data });
        appendScrollback(stream.sessionId, msg.data).catch((err) => console.error('[scrollback]', err.message));
        return;
      }

      if (msg.type === 'terminal-exit' && msg.streamId) {
        const stream = browserStreams.get(msg.streamId);
        if (stream) sendJson(stream.ws, { type: 'exit' });
        return;
      }

      if (msg.type === 'status' && msg.sessionId && msg.status) {
        await prisma.session.update({
          where: { id: msg.sessionId },
          data: { status: msg.status, lastSeenAt: new Date() }
        }).catch(() => {});
        broadcastStatus(record.userId, true);
      }
    });

    ws.on('close', async () => {
      if (agents.get(record.userId)?.ws === ws) {
        agents.delete(record.userId);
        for (const pending of agent.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Agent disconnected'));
        }
        await prisma.project.updateMany({
          where: { userId: record.userId },
          data: { status: 'sleeping' }
        });
        await prisma.session.updateMany({
          where: { project: { userId: record.userId } },
          data: { status: 'sleeping' }
        });
        broadcastStatus(record.userId, true);
      }
    });

    sendJson(ws, { type: 'hello', userId: record.userId });
  }

  async function registerBrowser(ws, req, url) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    const userId = token?.sub;
    if (!userId) {
      ws.close(1008, 'login required');
      return;
    }

    if (url.pathname === '/api/ws/status') {
      ws._termagStatusUserId = userId;
      sendJson(ws, { type: 'agent', connected: Boolean(agentForUser(userId)) });
      return;
    }

    const sessionId = url.searchParams.get('sessionId');
    const cols = Number(url.searchParams.get('cols') || 80);
    const rows = Number(url.searchParams.get('rows') || 24);
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

    const chunks = await prisma.scrollbackChunk.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { data: true }
    });
    for (const chunk of chunks) sendJson(ws, { type: 'output', data: chunk.data });

    const streamId = `stream_${nextRequestId()}`;
    browserStreams.set(streamId, { ws, userId, sessionId });

    try {
      await sendToAgent(userId, 'terminal-attach', {
        streamId,
        sessionId,
        tmuxName: session.tmuxName,
        kind: session.kind,
        cwd: { rootKey: session.project.rootKey, relativePath: session.project.relativePath },
        spawnCommand: session.kind === 'ctrl' ? session.project.ctrlSpawnCommand : session.project.agentSpawnCommand,
        cols,
        rows
      });
      await prisma.session.update({
        where: { id: session.id },
        data: { status: 'idle', lastSeenAt: new Date() }
      });
      if (session.tabId) {
        await prisma.tab.update({ where: { id: session.tabId }, data: { status: 'idle' } });
      }
      await prisma.project.update({ where: { id: session.projectId }, data: { status: 'idle' } });
      broadcastStatus(userId, true);
      sendJson(ws, { type: 'ready' });
    } catch (err) {
      await prisma.session.update({ where: { id: session.id }, data: { status: 'sleeping' } }).catch(() => {});
      sendJson(ws, { type: 'sleeping', message: 'Agent offline; open termag-agent on your laptop to reconnect.' });
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!agentForUser(userId)) return;
      if (msg.type === 'input') sendToAgent(userId, 'terminal-input', { streamId, data: msg.data }, 1000).catch(() => {});
      if (msg.type === 'resize') sendToAgent(userId, 'terminal-resize', { streamId, cols: msg.cols, rows: msg.rows }, 1000).catch(() => {});
      if (msg.type === 'kill') sendToAgent(userId, 'tmux-kill', { tmuxName: session.tmuxName }, 5000).catch(() => {});
    });

    ws.on('close', () => {
      browserStreams.delete(streamId);
      sendToAgent(userId, 'terminal-close', { streamId }, 1000).catch(() => {});
    });
  }

  function broadcastStatus(userId, refresh = false) {
    for (const client of wss.clients) {
      if (client._termagStatusUserId === userId && client.readyState === WebSocket.OPEN) {
        sendJson(client, { type: 'agent', connected: Boolean(agentForUser(userId)) });
        if (refresh) sendJson(client, { type: 'refresh' });
      }
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/ws/')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/api/ws/agent') {
        const token = url.searchParams.get('token') || req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (!token) {
          ws.close(1008, 'token required');
          return;
        }
        registerAgent(ws, token).catch((err) => {
          console.error('[agent-register]', err);
          ws.close(1011, 'agent auth failed');
        });
        return;
      }
      registerBrowser(ws, req, url).catch((err) => {
        console.error('[browser-ws]', err);
        ws.close(1011, 'server error');
      });
    });
  });

  server.listen(port, hostname, () => {
    console.log(`termag listening on http://${hostname}:${port}`);
  });
});
