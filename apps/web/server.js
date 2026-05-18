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
const trustedNetwork = process.env.TERMAG_TRUSTED_NETWORK === 'true';

// In trusted-network mode NextAuth is bypassed entirely, but its module
// still complains at boot if no secret is set. Provide a stable throwaway
// so the log is clean. OAuth users must set their own NEXTAUTH_SECRET —
// they'll see the warning from NextAuth itself if missing.
if (trustedNetwork && !process.env.NEXTAUTH_SECRET) {
  process.env.NEXTAUTH_SECRET = 'termag-trusted-mode-unused';
}

// Misconfiguration check. "trusted-network on + non-loopback bind + no
// password gate" = broker wide-open to anyone who can route to the host.
// Hard-error in production (saves you from a real incident); loud warn in
// dev (lets you bind 0.0.0.0 for LAN testing without being locked out).
function isLoopbackBind(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
const exposedTrustedMode = trustedNetwork && !isLoopbackBind(hostname) && !process.env.TERMAG_PASSWORD;
if (exposedTrustedMode) {
  const msg =
    `TERMAG_TRUSTED_NETWORK=true bound to non-loopback (${hostname}) with no TERMAG_PASSWORD. ` +
    'Anyone who can reach this host can attach to your sessions. Pick one:\n' +
    '  - set TERMAG_PASSWORD to a long random string (shared-password gate), or\n' +
    '  - set HOSTNAME=127.0.0.1 (loopback only — front it with Tailscale/Caddy/etc.), or\n' +
    '  - set TERMAG_TRUSTED_NETWORK=false and configure OAuth (see .env.example).';
  if (dev) {
    console.warn(`\n\x1b[33m[termag] WARNING:\x1b[0m ${msg}\n`);
  } else {
    console.error(`[termag] refusing to start: ${msg}`);
    process.exit(1);
  }
}
if (!trustedNetwork && !process.env.NEXTAUTH_SECRET) {
  console.error('[termag] refusing to start: TERMAG_TRUSTED_NETWORK is not "true" and NEXTAUTH_SECRET is missing. Generate one with `openssl rand -hex 32`.');
  process.exit(1);
}
const app = next({ dev, hostname, port, dir: path.resolve(__dirname) });
const handle = app.getRequestHandler();
const prisma = new PrismaClient();
const pidFile = path.join(__dirname, '.termag-server.json');
let httpServer;
const AGENT_TOKEN_MAX_LENGTH = 512;

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

function rejectUpgrade(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function hostFromOrigin(value) {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

function allowedBrowserOriginHosts() {
  const values = [
    process.env.NEXTAUTH_URL,
    ...(process.env.TERMAG_ALLOWED_ORIGINS || '').split(',')
  ];
  return new Set(values.map(hostFromOrigin).filter(Boolean));
}

function browserOriginAllowed(req) {
  // Reject anything that isn't a properly-formed Origin. "null" (sandboxed
  // iframes, data: URLs, etc.) fails the URL parse below and falls through
  // to rejection — defense in depth is to short-circuit it explicitly.
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  const originHost = hostFromOrigin(origin);
  if (!originHost) return false;
  // Prefer an explicit allowlist (NEXTAUTH_URL + TERMAG_ALLOWED_ORIGINS).
  // If allowlist matches we're done — trust the deployment config over any
  // header the client sent.
  const allowed = allowedBrowserOriginHosts();
  if (allowed.has(originHost)) return true;
  // Only fall back to comparing Origin against the Host header when no
  // allowlist is configured. The fallback trusts that req.headers.host is
  // accurate, which is true behind a reverse proxy that normalizes Host
  // (Caddy, nginx) but NOT for a direct attacker hitting the bare port.
  // Logging the fallback once per process keeps it visible so deployments
  // notice they're missing config.
  if (allowed.size === 0) {
    if (originHost === req.headers.host) {
      warnOriginFallbackOnce();
      return true;
    }
  }
  return false;
}

function bearerAuthPresent(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  return typeof header === 'string' && /^Bearer\s+\S+/i.test(header);
}

let originFallbackWarned = false;
function warnOriginFallbackOnce() {
  if (originFallbackWarned) return;
  originFallbackWarned = true;
  console.warn(
    '[termag] WS Origin allowlist is empty — falling back to Host-header comparison. ' +
    'Set NEXTAUTH_URL or TERMAG_ALLOWED_ORIGINS to a known-good host to close this gap.'
  );
}

function agentTokenFromRequest(req) {
  // Authorization header only. We used to accept ?token= in the query string,
  // but query strings end up in reverse-proxy access logs, browser history,
  // and APM traces — that's a long-lived agent-token leak vector. Bearer-only
  // closes it. (Both agent code paths already send the header.)
  return req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() || '';
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
    // 1 MB is generous for terminal protocol frames (keystrokes are bytes,
    // even resize + control messages are tiny). Default is unlimited, which
    // means a single malicious or compromised peer can send a multi-GB
    // frame and OOM the broker before any handler runs.
    maxPayload: 1024 * 1024,
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
    if (url.pathname !== '/api/ws/agent' && !bearerAuthPresent(req) && !browserOriginAllowed(req)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/api/ws/agent') {
        const token = agentTokenFromRequest(req);
        if (!token || token.length > AGENT_TOKEN_MAX_LENGTH) {
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
