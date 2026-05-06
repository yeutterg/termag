const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const next = require('next');
const { WebSocketServer } = require('ws');
const { PrismaClient } = require('@prisma/client');
const { createBroker } = require('./server/broker');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = Number(process.env.PORT || 3000);

// In trusted-network mode (default) NextAuth is bypassed entirely, but its
// module still complains at boot if no secret is set. Provide a stable
// throwaway so the log is clean. OAuth users (TERMAG_TRUSTED_NETWORK=false)
// must set their own NEXTAUTH_SECRET — they'll see the warning if missing.
if (process.env.TERMAG_TRUSTED_NETWORK !== 'false' && !process.env.NEXTAUTH_SECRET) {
  process.env.NEXTAUTH_SECRET = 'termag-trusted-mode-unused';
}
const app = next({ dev, hostname, port, dir: path.resolve(__dirname) });
const handle = app.getRequestHandler();
const prisma = new PrismaClient();
const pidFile = path.join(__dirname, '.termag-server.json');
let httpServer;

function writePidFile() {
  fs.writeFileSync(
    pidFile,
    JSON.stringify(
      { pid: process.pid, dev, hostname, port, startedAt: new Date().toISOString() },
      null,
      2
    )
  );
}

function removePidFile() {
  try {
    const info = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (info.pid !== process.pid) return;
  } catch (err) {
    if (err.code === 'ENOENT') return;
  }
  fs.rmSync(pidFile, { force: true });
}

function shutdown() {
  removePidFile();
  if (!httpServer) {
    process.exit(0);
    return;
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('exit', removePidFile);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGHUP', shutdown);

app.prepare().then(() => {
  const handleUpgrade = app.getUpgradeHandler();
  const server = http.createServer((req, res) => handle(req, res));
  httpServer = server;
  // permessage-deflate: terminal output is highly compressible (repeating
  // ANSI escapes, paths, tokens) — typically 60-80% reduction on the wire.
  // threshold 1KB keeps small control messages uncompressed (no CPU cost
  // for them, no context-takeover memory hit). level 3 balances CPU and ratio.
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 3 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true
    }
  });
  const broker = createBroker({ prisma, wss });

  // Route handlers reach the broker through globalThis (same Node process).
  globalThis.termagBroker = broker;

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/ws/')) {
      handleUpgrade(req, socket, head).catch((err) => {
        console.error('[next-upgrade]', err);
        socket.destroy();
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/api/ws/agent') {
        const token = url.searchParams.get('token') || req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (!token) {
          ws.close(1008, 'token required');
          return;
        }
        broker.registerAgent(ws, token).catch((err) => {
          console.error('[agent-register]', err);
          ws.close(1011, 'agent auth failed');
        });
        return;
      }
      broker.registerBrowser(ws, req, url).catch((err) => {
        console.error('[browser-ws]', err);
        ws.close(1011, 'server error');
      });
    });
  });

  server.listen(port, hostname, () => {
    writePidFile();
    console.log(`termag listening on http://${hostname}:${port}`);
  });
});
