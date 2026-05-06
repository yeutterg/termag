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

module.exports = { appendScrollback };
