const path = require('node:path');
const crypto = require('node:crypto');
// Load .env.local etc. so the seed user matches whatever the dev server uses.
require('@next/env').loadEnvConfig(path.resolve(__dirname, '..'));
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Match the trusted-mode resolution in lib/auth.ts so `npm run preview:seed`
// populates the same user that the dev server resolves to. Falls back to the
// dev-auth or legacy preview email for backward compat.
const PREVIEW_EMAIL = (
  process.env.TERMAG_TRUSTED_USER_EMAIL
  || process.env.TERMAG_ALLOWED_EMAIL
  || process.env.TERMAG_DEV_AUTH_EMAIL
  || 'trusted@termag.local'
).toLowerCase().trim();
const PREVIEW_DEVICE_NAME = (process.env.TERMAG_PREVIEW_DEVICE_NAME || 'Preview device').trim();
const PREVIEW_TOKEN = process.env.TERMAG_PREVIEW_AGENT_TOKEN?.trim();
if (!PREVIEW_TOKEN) {
  console.error('Set TERMAG_PREVIEW_AGENT_TOKEN before running preview seed, for example: TERMAG_PREVIEW_AGENT_TOKEN="tmag_$(openssl rand -hex 32)" npm run preview:seed -w apps/web');
  process.exit(1);
}

const CLAUDE_SPAWN = 'claude --dangerously-skip-permissions';
const CODEX_SPAWN = 'codex --dangerously-bypass-approvals-and-sandbox';

const PROJECTS = [
  {
    name: 'termag-rebuild',
    relativePath: 'termag',
    agentType: 'codex',
    agentSpawnCommand: CODEX_SPAWN,
    status: 'working',
    ageMs: 0,
    tabs: [
      { name: 'Broker', status: 'working', scrollback: 'Codex preview session\r\nScanning server.js websocket routing...\r\n✓ /api/ws/agent authenticated\r\n✓ scrollback replay wired\r\nWorking on reconnect edge cases...\r\n' },
      { name: 'UI Polish', status: 'waiting', scrollback: 'Codex preview session\r\nReviewing sidebar density and terminal pane layout...\r\nNeed user input: keep ctrl pane visible on desktop?\r\n' }
    ]
  },
  {
    name: 'restful-api',
    relativePath: 'restful-api',
    agentType: 'claude',
    agentSpawnCommand: CLAUDE_SPAWN,
    status: 'idle',
    ageMs: 60_000,
    tabs: [
      { name: 'Auth Flow', status: 'idle', scrollback: 'Claude preview session\r\nImplemented token rotation plan.\r\nAll tests green.\r\n' },
      { name: 'SQLite Cache', status: 'working', scrollback: 'Claude preview session\r\nProfiling query shape for recent project lists...\r\n' }
    ]
  },
  {
    name: 'garden-notes',
    relativePath: 'garden-notes',
    agentType: 'codex',
    agentSpawnCommand: CODEX_SPAWN,
    status: 'sleeping',
    ageMs: 120_000,
    tabs: [
      { name: 'Cleanup', status: 'sleeping', scrollback: 'Codex preview session\r\nLaptop agent was offline. Scrollback is still visible.\r\n' }
    ]
  }
];

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tmuxName(projectId, tabId) {
  return `${tmuxSessionName(projectId)}:${tmuxWindowName(tabId)}`;
}

function tmuxSessionName(projectId) {
  return `termag-${projectId}`;
}

function tmuxWindowName(tabId) {
  return tabId === 'ctrl' ? 'ctrl' : `tab-${tabId}`;
}

async function ensureProject(user, spec, openedAt) {
  const project = await prisma.project.upsert({
    where: { userId_name: { userId: user.id, name: spec.name } },
    update: {
      rootKey: PREVIEW_DEVICE_NAME,
      relativePath: spec.relativePath,
      agentType: spec.agentType,
      agentSpawnCommand: spec.agentSpawnCommand,
      status: spec.status,
      openedAt
    },
    create: {
      userId: user.id,
      name: spec.name,
      rootKey: PREVIEW_DEVICE_NAME,
      relativePath: spec.relativePath,
      agentType: spec.agentType,
      agentSpawnCommand: spec.agentSpawnCommand,
      status: spec.status,
      openedAt
    }
  });
  const projectTmuxSessionName = tmuxSessionName(project.id);
  await prisma.project.update({
    where: { id: project.id },
    data: { tmuxSessionName: projectTmuxSessionName, tmuxManaged: true }
  });

  const existingTabs = await prisma.tab.findMany({ where: { projectId: project.id } });
  if (existingTabs.length > 0) return project;

  for (let i = 0; i < spec.tabs.length; i += 1) {
    const tabSpec = spec.tabs[i];
    const tab = await prisma.tab.create({
      data: { projectId: project.id, name: tabSpec.name, ordinal: i + 1, status: tabSpec.status }
    });
    const session = await prisma.session.create({
      data: {
        projectId: project.id,
        tabId: tab.id,
        kind: 'agent',
        tmuxName: tmuxName(project.id, tab.id),
        tmuxWindowName: tmuxWindowName(tab.id),
        tmuxManaged: true,
        status: tabSpec.status,
        lastSeenAt: new Date()
      }
    });
    await prisma.scrollbackChunk.create({
      data: { sessionId: session.id, lineCount: 8, data: tabSpec.scrollback }
    });
  }

  const ctrlSession = await prisma.session.create({
    data: {
      projectId: project.id,
      kind: 'ctrl',
      tmuxName: tmuxName(project.id, 'ctrl'),
      tmuxWindowName: tmuxWindowName('ctrl'),
      tmuxManaged: true,
      status: 'idle',
      lastSeenAt: new Date()
    }
  });
  await prisma.scrollbackChunk.create({
    data: {
      sessionId: ctrlSession.id,
      lineCount: 5,
      data: `termag ctrl for ${spec.name}\r\n$ git status --short\r\n$ npm test\r\npreview shell ready\r\n`
    }
  });

  return project;
}

async function main() {
  const user = await prisma.user.upsert({
    where: { email: PREVIEW_EMAIL },
    update: { displayName: 'Preview User', theme: 'light' },
    create: { email: PREVIEW_EMAIL, displayName: 'Preview User', theme: 'light' }
  });

  const tokenPrefix = `${PREVIEW_TOKEN.slice(0, 13)}...`;
  await prisma.agentToken.upsert({
    where: { tokenHash: hashToken(PREVIEW_TOKEN) },
    update: { userId: user.id, name: PREVIEW_DEVICE_NAME, tokenPrefix, revokedAt: null },
    create: { userId: user.id, name: PREVIEW_DEVICE_NAME, tokenHash: hashToken(PREVIEW_TOKEN), tokenPrefix }
  });

  const now = Date.now();
  for (const spec of PROJECTS) {
    await ensureProject(user, spec, new Date(now - spec.ageMs));
  }

  console.log(`Preview user: ${PREVIEW_EMAIL}`);
  console.log(`Preview device: ${PREVIEW_DEVICE_NAME}`);
  console.log(`Preview agent token prefix: ${tokenPrefix}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
