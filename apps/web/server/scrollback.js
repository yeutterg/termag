// This module is intentionally CommonJS because it is loaded by the custom broker.

const { StringDecoder } = require("node:string_decoder");

const DEFAULT_MAX_LINES = 2500;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_BATCH_BYTES = 64 * 1024;
const DEFAULT_BATCH_MS = 100;
const STATE_IDLE_TTL_MS = 5 * 60 * 1000;
const MAX_READ_CHUNKS = 512;

function positiveEnv(name, fallback, cap) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(cap, Math.floor(value));
}

function limits() {
  const maxBytes = positiveEnv("TERMAG_SCROLLBACK_MAX_BYTES", DEFAULT_MAX_BYTES, 64 * 1024 * 1024);
  return {
    maxLines: positiveEnv("TERMAG_SCROLLBACK_MAX_LINES", DEFAULT_MAX_LINES, 100_000),
    maxBytes,
    batchBytes: Math.min(
      maxBytes,
      positiveEnv("TERMAG_SCROLLBACK_BATCH_BYTES", DEFAULT_BATCH_BYTES, 1024 * 1024)
    ),
    batchMs: positiveEnv("TERMAG_SCROLLBACK_BATCH_MS", DEFAULT_BATCH_MS, 2000),
  };
}

function trailingUtf8(value, maxBytes) {
  if (bytes(value) <= maxBytes) {
    return value;
  }
  const encoded = Buffer.from(value, "utf8");
  let start = encoded.length - maxBytes;
  // A byte-bounded tail can begin in the middle of a UTF-8 code point.
  // Advance to the next leading byte instead of materializing replacement
  // characters (which can themselves exceed the requested byte bound).
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return encoded.subarray(start).toString("utf8");
}

function bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function lineCount(data) {
  if (!data) {
    return 0;
  }
  let count = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count + (data.charCodeAt(data.length - 1) === 10 ? 0 : 1);
}

function trailingLines(value, maxLines) {
  if (lineCount(value) <= maxLines) {
    return value;
  }
  let lines = value.endsWith("\n") ? 0 : 1;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value.charCodeAt(index) !== 10) {
      continue;
    }
    lines += 1;
    if (lines > maxLines) {
      return value.slice(index + 1);
    }
  }
  return value;
}

function createScrollbackStore(prisma) {
  const states = new Map();
  const config = limits();

  function stateFor(sessionId) {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        initialized: false,
        entries: [],
        totalLines: 0,
        totalBytes: 0,
        pending: [],
        pendingBytes: 0,
        flushTimer: null,
        cleanupTimer: null,
        queue: Promise.resolve(),
        touchedAt: Date.now(),
        decoder: new StringDecoder("utf8"),
        nextSeq: 1,
      };
      states.set(sessionId, state);
    }
    state.touchedAt = Date.now();
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = null;
    }
    return state;
  }

  async function initialize(sessionId, state) {
    if (state.initialized) {
      return;
    }
    const chunks = await prisma.scrollbackChunk.findMany({
      where: { sessionId },
      orderBy: [{ seq: "asc" }, { createdAt: "asc" }],
      select: { id: true, data: true, lineCount: true, seq: true },
    });
    state.entries = chunks.map(chunk => ({
      id: chunk.id,
      lines: chunk.lineCount,
      bytes: bytes(chunk.data),
    }));
    state.totalLines = state.entries.reduce((total, entry) => total + entry.lines, 0);
    state.totalBytes = state.entries.reduce((total, entry) => total + entry.bytes, 0);
    // Continue this session's sequence rather than restarting it, so chunks
    // written before a broker restart still sort ahead of new ones.
    state.nextSeq = chunks.reduce((highest, chunk) => Math.max(highest, chunk.seq ?? 0), 0) + 1;
    state.initialized = true;
  }

  function scheduleCleanup(sessionId, state) {
    if (state.cleanupTimer || state.pendingBytes > 0 || state.flushTimer) {
      return;
    }
    state.cleanupTimer = setTimeout(() => {
      state.cleanupTimer = null;
      if (
        state.pendingBytes === 0 &&
        !state.flushTimer &&
        Date.now() - state.touchedAt >= STATE_IDLE_TTL_MS
      ) {
        states.delete(sessionId);
      }
    }, STATE_IDLE_TTL_MS);
    state.cleanupTimer.unref?.();
  }

  async function persistBatch(sessionId, state, data) {
    await initialize(sessionId, state);
    data = trailingLines(data, config.maxLines);
    data = trailingUtf8(data, config.maxBytes);
    const lines = lineCount(data);
    const byteCount = bytes(data);
    const created = await prisma.scrollbackChunk.create({
      data: { sessionId, data, lineCount: lines, seq: state.nextSeq++ },
      select: { id: true },
    });
    state.entries.push({ id: created.id, lines, bytes: byteCount });
    state.totalLines += lines;
    state.totalBytes += byteCount;

    const deleteIds = [];
    while (
      state.entries.length > 1 &&
      (state.totalLines > config.maxLines || state.totalBytes > config.maxBytes)
    ) {
      const oldest = state.entries.shift();
      if (!oldest) {
        break;
      }
      state.totalLines -= oldest.lines;
      state.totalBytes -= oldest.bytes;
      deleteIds.push(oldest.id);
    }
    if (deleteIds.length > 0) {
      await prisma.scrollbackChunk.deleteMany({ where: { id: { in: deleteIds } } });
    }
  }

  function flush(sessionId) {
    const state = states.get(sessionId);
    if (!state) {
      return Promise.resolve();
    }
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.pendingBytes === 0) {
      scheduleCleanup(sessionId, state);
      return state.queue;
    }
    const data = state.pending.join("");
    state.pending = [];
    state.pendingBytes = 0;
    state.queue = state.queue
      .then(() => persistBatch(sessionId, state, data))
      .finally(() => scheduleCleanup(sessionId, state));
    return state.queue;
  }

  function append(sessionId, data) {
    if (!sessionId || data === undefined || data === null) {
      return Promise.resolve();
    }
    const state = stateFor(sessionId);
    let text;
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
      text = state.decoder.write(Buffer.from(data));
    } else {
      // Preserve ordering if a legacy text frame follows binary bytes whose
      // final UTF-8 sequence was incomplete, then start a fresh decoder for
      // subsequent raw frames.
      text = state.decoder.end() + String(data);
      state.decoder = new StringDecoder("utf8");
    }
    if (!text) {
      // StringDecoder can legitimately retain an incomplete UTF-8 sequence.
      // Give that state the same idle lifetime as ordinary buffers so a
      // disconnected session ending mid-codepoint cannot leave a permanent
      // map entry.
      scheduleCleanup(sessionId, state);
      return state.queue;
    }
    state.pending.push(text);
    state.pendingBytes += bytes(text);
    if (state.pendingBytes >= config.batchBytes) {
      return flush(sessionId);
    }
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        flush(sessionId).catch(error =>
          console.error("[scrollback]", error instanceof Error ? error.message : String(error))
        );
      }, config.batchMs);
      state.flushTimer.unref?.();
    }
    return state.queue;
  }

  async function read(sessionId, options = {}) {
    await flush(sessionId);
    const maxLines = Math.min(
      config.maxLines,
      Number.isFinite(options.maxLines)
        ? Math.max(1, Math.floor(options.maxLines))
        : config.maxLines
    );
    const maxBytes = Math.min(
      config.maxBytes,
      Number.isFinite(options.maxBytes)
        ? Math.max(1024, Math.floor(options.maxBytes))
        : config.maxBytes
    );
    const chunks = await prisma.scrollbackChunk.findMany({
      where: { sessionId },
      orderBy: [{ seq: "desc" }, { createdAt: "desc" }],
      select: { data: true, lineCount: true },
      take: MAX_READ_CHUNKS,
    });
    const selected = [];
    let selectedLines = 0;
    let selectedBytes = 0;
    for (const chunk of chunks) {
      const remainingLines = maxLines - selectedLines;
      const remainingBytes = maxBytes - selectedBytes;
      let data = trailingLines(chunk.data, remainingLines);
      data = trailingUtf8(data, remainingBytes);
      if (!data) {
        break;
      }
      const chunkLines = lineCount(data);
      const chunkBytes = bytes(data);
      selected.push(data);
      selectedLines += chunkLines;
      selectedBytes += chunkBytes;
      if (selectedLines >= maxLines || selectedBytes >= maxBytes) {
        break;
      }
      // If this row had to be truncated, no earlier history can precede its
      // retained suffix without creating a chronological gap.
      if (data !== chunk.data) {
        break;
      }
    }
    selected.reverse();
    return selected;
  }

  async function close() {
    const sessionIds = [...states.keys()];
    for (const state of states.values()) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
      }
      if (state.cleanupTimer) {
        clearTimeout(state.cleanupTimer);
      }
      state.flushTimer = null;
      state.cleanupTimer = null;
      const trailing = state.decoder.end();
      if (trailing) {
        state.pending.push(trailing);
        state.pendingBytes += bytes(trailing);
      }
    }
    await Promise.all(sessionIds.map(sessionId => flush(sessionId)));
    for (const state of states.values()) {
      if (state.cleanupTimer) {
        clearTimeout(state.cleanupTimer);
      }
    }
    states.clear();
  }

  return { append, read, flush, close, config, _states: states };
}

const stores = new WeakMap();
function storeFor(prisma) {
  let store = stores.get(prisma);
  if (!store) {
    store = createScrollbackStore(prisma);
    stores.set(prisma, store);
  }
  return store;
}

function appendScrollback(prisma, sessionId, data) {
  return storeFor(prisma).append(sessionId, data);
}

function readScrollback(prisma, sessionId, options) {
  return storeFor(prisma).read(sessionId, options);
}

// Scrollback can capture secrets. Keep a short default retention window even
// though each individual session is byte-bounded.
const DEFAULT_TTL_DAYS = 7;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function ttlDays() {
  return positiveEnv("TERMAG_SCROLLBACK_TTL_DAYS", DEFAULT_TTL_DAYS, 365);
}

async function pruneExpiredScrollback(prisma) {
  const cutoff = new Date(Date.now() - ttlDays() * 24 * 60 * 60 * 1000);
  const result = await prisma.scrollbackChunk.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (result.count > 0) {
    // eslint-disable-next-line no-console -- successful maintenance belongs in operational logs
    console.log(`[scrollback] pruned ${result.count} chunk(s) older than ${ttlDays()}d`);
  }
  return result.count;
}

function startScrollbackPrune(prisma) {
  const run = () => {
    pruneExpiredScrollback(prisma).catch(error => {
      console.error(
        "[scrollback] prune failed:",
        error instanceof Error ? error.message : String(error)
      );
    });
  };
  run();
  const handle = setInterval(run, PRUNE_INTERVAL_MS);
  handle.unref?.();
  return () => clearInterval(handle);
}

module.exports = {
  appendScrollback,
  createScrollbackStore,
  lineCount,
  pruneExpiredScrollback,
  readScrollback,
  startScrollbackPrune,
};
