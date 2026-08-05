const { createSshStreamRegistry } = require("./ssh-session-stream");

function createSshHostLifecycle({
  prisma,
  broadcastStatus,
  sendJson,
  sanitizeText,
  pollIntervalMs = 30_000,
  sshHelpers = null,
  streamRegistry: providedStreamRegistry = null,
}) {
  const hosts = new Map();
  const loadedUsers = new Set();
  const streamRegistry = providedStreamRegistry || createSshStreamRegistry({ prisma });

  function helpers() {
    // Keep node-pty and the SSH implementation out of the default broker
    // startup path. Most installations only use their local Rust agents.
    return sshHelpers || require("./ssh");
  }

  function forUser(userId) {
    return hosts.get(userId) || new Map();
  }

  function publicStatus(record) {
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

  function statuses(userId) {
    return [...forUser(userId).values()].map(publicStatus);
  }

  async function refresh(userId, options = {}) {
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
    } catch (error) {
      console.error("[ssh] could not load hosts for user", userId, error.message);
      return;
    }
    loadedUsers.add(userId);
    if (!hosts.has(userId)) {
      hosts.set(userId, new Map());
    }
    const current = hosts.get(userId);
    const wantedIds = new Set(rows.map(row => row.id));

    for (const [hostId, record] of current) {
      if (!wantedIds.has(hostId)) {
        if (record.pollHandle) {
          clearInterval(record.pollHandle);
        }
        streamRegistry.forgetHost(userId, hostId);
        current.delete(hostId);
      }
    }

    for (const row of rows) {
      const spec = { id: row.id, name: row.name, host: row.host, port: row.port, user: row.user };
      const existing = current.get(row.id);
      if (existing) {
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
      probe(userId, row.id).catch(() => {});
      if (pollIntervalMs > 0) {
        const handle = setInterval(() => {
          probe(userId, row.id).catch(() => {});
        }, pollIntervalMs);
        handle.unref?.();
        record.pollHandle = handle;
      }
    }
    if (current.size === 0) {
      hosts.delete(userId);
    }
    if (options.broadcast !== false) {
      broadcastStatus(userId, true);
    }
  }

  async function probe(userId, hostId) {
    const record = forUser(userId).get(hostId);
    if (!record) {
      return { ok: false, error: "host not registered" };
    }
    if (record.probeInFlight) {
      return record.probeInFlight;
    }
    record.probeInFlight = (async () => {
      try {
        const previous = {
          connected: record.connected,
          error: record.lastError,
          sessions: sessionFingerprint(record.tmuxSessions),
        };
        const { probeSshHost, listSshTmuxSessions } = helpers();
        const result = await probeSshHost(record.spec);
        if (!forUser(userId).has(hostId)) {
          return { ok: false, error: "host removed during probe" };
        }
        if (result.ok) {
          record.connected = true;
          record.lastSeenAt = new Date();
          record.lastError = null;
          record.tmuxSessions = await listSshTmuxSessions(record.spec);
        } else {
          record.connected = false;
          record.lastError = result.error || "probe failed";
          record.tmuxSessions = [];
        }
        if (!forUser(userId).has(hostId)) {
          return { ok: result.ok, error: result.error || null, sessions: [] };
        }
        prisma.sshHost
          .update({
            where: { id: hostId },
            data: { lastSeenAt: record.lastSeenAt, lastError: record.lastError },
          })
          .catch(() => {});
        if (
          previous.connected !== record.connected ||
          previous.error !== record.lastError ||
          previous.sessions !== sessionFingerprint(record.tmuxSessions)
        ) {
          broadcastStatus(userId, true);
        }
        return { ok: result.ok, error: result.error || null, sessions: record.tmuxSessions };
      } finally {
        record.probeInFlight = null;
      }
    })();
    return record.probeInFlight;
  }

  function forget(userId, hostId) {
    const map = forUser(userId);
    const record = map.get(hostId);
    if (!record) {
      return;
    }
    if (record.pollHandle) {
      clearInterval(record.pollHandle);
    }
    map.delete(hostId);
    streamRegistry.forgetHost(userId, hostId);
    if (map.size === 0) {
      hosts.delete(userId);
    }
    broadcastStatus(userId, true);
  }

  function snapshots(userId) {
    return [...forUser(userId).values()].map(record => ({
      rootKey: record.spec.name,
      sessions: record.tmuxSessions.map(session => ({
        name: session.name,
        path: session.path || "",
        windowCount: session.windowCount || 0,
        windows: [],
      })),
    }));
  }

  async function handleAttach(ws, userId, hostId, tmuxName, cols, rows) {
    const record = forUser(userId).get(hostId);
    if (!record) {
      ws.close(1008, "ssh host not registered");
      return;
    }
    let known = record.tmuxSessions.some(session => session.name === tmuxName);
    if (!known) {
      const cacheAge = record.lastSeenAt ? Date.now() - record.lastSeenAt.getTime() : Infinity;
      if (cacheAge > 15_000) {
        try {
          await probe(userId, hostId);
        } catch {}
        known =
          forUser(userId)
            .get(hostId)
            ?.tmuxSessions?.some(session => session.name === tmuxName) ?? false;
      }
    }
    if (!known) {
      ws.close(1008, "unknown tmux session — refresh device status");
      return;
    }
    const stream = createStream(ws, { userId, hostSpec: record.spec, tmuxName, cols, rows });
    if (!stream) {
      return;
    }
    try {
      await stream.subscribe(ws, cols, rows);
    } catch (error) {
      fatal(ws, error?.message || "subscribe failed", "subscribe failed");
      return;
    }
    writeAttachAudit(userId, record.spec, tmuxName, ws).catch(() => {});
  }

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
    } catch (error) {
      console.error("[share-attach] DB lookup failed:", error?.message || error);
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
    const stream = createStream(ws, {
      userId: link.userId,
      hostSpec: link.sshHost,
      tmuxName: link.tmuxName,
      cols,
      rows,
    });
    if (!stream) {
      return;
    }
    try {
      await stream.subscribe(ws, cols, rows, { readOnly: true });
    } catch (error) {
      fatal(ws, error?.message || "subscribe failed", "subscribe failed");
      return;
    }
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
          payload: JSON.stringify({ kind: "share-attach", code, tmuxName: link.tmuxName }),
          userId: link.userId,
        },
      })
      .catch(() => {});
  }

  function createStream(ws, options) {
    try {
      return streamRegistry.getOrCreate(options);
    } catch (error) {
      fatal(ws, error?.message || "ssh spawn failed", "ssh spawn failed");
      return null;
    }
  }

  function fatal(ws, message, reason) {
    sendJson(ws, { type: "fatal", message: sanitizeText(message, 200) });
    ws.close(1011, reason);
  }

  function writeAttachAudit(userId, hostSpec, tmuxName, ws) {
    const ip =
      process.env.TERMAG_TRUSTED_PROXY === "true" ? null : ws._socket?.remoteAddress || null;
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

  function close() {
    for (const [userId, records] of hosts) {
      for (const [hostId, record] of records) {
        if (record.pollHandle) {
          clearInterval(record.pollHandle);
        }
        streamRegistry.forgetHost(userId, hostId);
      }
    }
    hosts.clear();
    loadedUsers.clear();
  }

  return {
    hasUser: userId => loadedUsers.has(userId),
    statuses,
    snapshots,
    refresh,
    probe,
    forget,
    handleAttach,
    handleShareAttach,
    close,
  };
}

function sessionFingerprint(sessions) {
  if (!Array.isArray(sessions)) {
    return "";
  }
  return sessions
    .map(session => `${session.name}|${session.windowCount}|${session.path || ""}`)
    .join("\n");
}

module.exports = { createSshHostLifecycle };
