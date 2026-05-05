const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const PREVIEW_EMAIL = process.env.TERMAG_DEV_AUTH_EMAIL || 'preview@termag.local';
const PREVIEW_TOKEN = process.env.TERMAG_PREVIEW_AGENT_TOKEN || 'tmag_preview_local_agent_token';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function tmuxName(projectId, tabId) {
  return `termag-${projectId}-${tabId}`;
}

async function ensureProject(user, data) {
  const project = await prisma.project.upsert({
    where: { userId_name: { userId: user.id, name: data.name } },
    update: {
      rootKey: data.rootKey,
      relativePath: data.relativePath,
      agentType: data.agentType,
      agentSpawnCommand: data.agentSpawnCommand,
      status: data.status,
      openedAt: data.openedAt
    },
    create: {
      userId: user.id,
      name: data.name,
      rootKey: data.rootKey,
      relativePath: data.relativePath,
      agentType: data.agentType,
      agentSpawnCommand: data.agentSpawnCommand,
      status: data.status,
      openedAt: data.openedAt
    }
  });

  const existingTabs = await prisma.tab.findMany({ where: { projectId: project.id } });
  if (existingTabs.length === 0) {
    for (let i = 0; i < data.tabs.length; i += 1) {
      const tabSpec = data.tabs[i];
      const tab = await prisma.tab.create({
        data: {
          projectId: project.id,
          name: tabSpec.name,
          ordinal: i + 1,
          status: tabSpec.status
        }
      });
      const session = await prisma.session.create({
        data: {
          projectId: project.id,
          tabId: tab.id,
          kind: 'agent',
          tmuxName: tmuxName(project.id, tab.id),
          status: tabSpec.status,
          lastSeenAt: new Date()
        }
      });
      await prisma.scrollbackChunk.create({
        data: {
          sessionId: session.id,
          lineCount: 8,
          data: tabSpec.scrollback
        }
      });
    }

    const ctrlSession = await prisma.session.create({
      data: {
        projectId: project.id,
        kind: 'ctrl',
        tmuxName: tmuxName(project.id, 'ctrl'),
        status: 'idle',
        lastSeenAt: new Date()
      }
    });
    await prisma.scrollbackChunk.create({
      data: {
        sessionId: ctrlSession.id,
        lineCount: 5,
        data: `termag ctrl for ${data.name}\r\n$ git status --short\r\n$ npm test\r\npreview shell ready\r\n`
      }
    });
  }

  return project;
}

async function main() {
  const user = await prisma.user.upsert({
    where: { email: PREVIEW_EMAIL },
    update: { displayName: 'Preview User', theme: 'light' },
    create: { email: PREVIEW_EMAIL, displayName: 'Preview User', theme: 'light' }
  });

  await prisma.agentToken.upsert({
    where: { tokenHash: hashToken(PREVIEW_TOKEN) },
    update: {
      userId: user.id,
      name: 'Preview fake agent',
      tokenPrefix: `${PREVIEW_TOKEN.slice(0, 13)}...`,
      revokedAt: null
    },
    create: {
      userId: user.id,
      name: 'Preview fake agent',
      tokenHash: hashToken(PREVIEW_TOKEN),
      tokenPrefix: `${PREVIEW_TOKEN.slice(0, 13)}...`
    }
  });

  const now = Date.now();
  await ensureProject(user, {
    name: 'termag-rebuild',
    rootKey: 'WIP',
    relativePath: 'termag',
    agentType: 'codex',
    agentSpawnCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
    status: 'working',
    openedAt: new Date(now),
    tabs: [
      {
        name: 'Broker',
        status: 'working',
        scrollback: 'Codex preview session\r\nScanning server.js websocket routing...\r\n✓ /api/ws/agent authenticated\r\n✓ scrollback replay wired\r\nWorking on reconnect edge cases...\r\n'
      },
      {
        name: 'UI Polish',
        status: 'waiting',
        scrollback: 'Codex preview session\r\nReviewing sidebar density and terminal pane layout...\r\nNeed user input: keep ctrl pane visible on desktop?\r\n'
      }
    ]
  });

  await ensureProject(user, {
    name: 'restful-api',
    rootKey: 'WIP',
    relativePath: 'restful-api',
    agentType: 'claude',
    agentSpawnCommand: 'claude --dangerously-skip-permissions',
    status: 'idle',
    openedAt: new Date(now - 60_000),
    tabs: [
      {
        name: 'Auth Flow',
        status: 'idle',
        scrollback: 'Claude preview session\r\nImplemented token rotation plan.\r\nAll tests green.\r\n'
      },
      {
        name: 'SQLite Cache',
        status: 'working',
        scrollback: 'Claude preview session\r\nProfiling query shape for recent project lists...\r\n'
      }
    ]
  });

  await ensureProject(user, {
    name: 'garden-notes',
    rootKey: 'WIP',
    relativePath: 'garden-notes',
    agentType: 'codex',
    agentSpawnCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
    status: 'sleeping',
    openedAt: new Date(now - 120_000),
    tabs: [
      {
        name: 'Cleanup',
        status: 'sleeping',
        scrollback: 'Codex preview session\r\nLaptop agent was offline. Scrollback is still visible.\r\n'
      }
    ]
  });

  console.log(`Preview user: ${PREVIEW_EMAIL}`);
  console.log(`Preview agent token: ${PREVIEW_TOKEN}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
