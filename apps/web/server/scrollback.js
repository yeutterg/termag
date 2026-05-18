function lineCount(data) {
  return Math.max(1, (data.match(/\n/g) || []).length);
}

/**
 * Appends a chunk of pty output to a session's scrollback. Trims oldest chunks
 * down to ~10K lines but always preserves the most recent chunk, so a single
 * huge write doesn't wipe itself.
 */
async function appendScrollback(prisma, sessionId, data) {
  const lines = lineCount(data);
  await prisma.scrollbackChunk.create({ data: { sessionId, data, lineCount: lines } });

  const chunks = await prisma.scrollbackChunk.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, lineCount: true }
  });

  let total = 0;
  const deleteIds = [];
  for (let i = 0; i < chunks.length; i += 1) {
    total += chunks[i].lineCount;
    if (i > 0 && total > 10000) deleteIds.push(chunks[i].id);
  }
  if (deleteIds.length) {
    await prisma.scrollbackChunk.deleteMany({ where: { id: { in: deleteIds } } });
  }
}

// Default retention window. Scrollback often captures secrets the user typed,
// echoed env vars, API responses — assume it's sensitive. 7 days balances
// "useful for context after reconnect" against "minimize blast radius if the
// DB leaks". Override per-deployment with TERMAG_SCROLLBACK_TTL_DAYS.
const DEFAULT_TTL_DAYS = 7;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

function ttlDays() {
  const raw = Number(process.env.TERMAG_SCROLLBACK_TTL_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_DAYS;
  return Math.min(365, Math.floor(raw));
}

async function pruneExpiredScrollback(prisma) {
  const cutoff = new Date(Date.now() - ttlDays() * 24 * 60 * 60 * 1000);
  const result = await prisma.scrollbackChunk.deleteMany({
    where: { createdAt: { lt: cutoff } }
  });
  if (result.count > 0) {
    console.log(`[scrollback] pruned ${result.count} chunk(s) older than ${ttlDays()}d`);
  }
  return result.count;
}

/**
 * Starts the periodic scrollback prune. Runs immediately on boot, then every
 * 6h. The interval is .unref()'d so a clean broker shutdown isn't blocked by
 * a pending prune timer. Failures are logged and swallowed — the next tick
 * will try again. Returns a stop() handle for tests.
 */
function startScrollbackPrune(prisma) {
  const run = () => {
    pruneExpiredScrollback(prisma).catch((err) => {
      console.error('[scrollback] prune failed:', err instanceof Error ? err.message : String(err));
    });
  };
  run();
  const handle = setInterval(run, PRUNE_INTERVAL_MS);
  handle.unref();
  return () => clearInterval(handle);
}

module.exports = { appendScrollback, pruneExpiredScrollback, startScrollbackPrune };
