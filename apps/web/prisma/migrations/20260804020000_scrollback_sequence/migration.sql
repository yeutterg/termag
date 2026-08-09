-- Explicit replay order for scrollback chunks.
--
-- Reads previously ordered by createdAt alone. That column has millisecond
-- precision and ScrollbackChunk.id is a cuid (not time-sortable), so two
-- byte-triggered flushes landing in the same millisecond had no defined
-- order and could replay a burst of terminal output scrambled.
ALTER TABLE "ScrollbackChunk" ADD COLUMN "seq" INTEGER NOT NULL DEFAULT 0;

-- Backfill in recorded creation order, breaking same-millisecond ties by id
-- so the result is at least deterministic for rows written before this.
UPDATE "ScrollbackChunk"
SET "seq" = (
  SELECT COUNT(*)
  FROM "ScrollbackChunk" AS earlier
  WHERE earlier."sessionId" = "ScrollbackChunk"."sessionId"
    AND (
      earlier."createdAt" < "ScrollbackChunk"."createdAt"
      OR (
        earlier."createdAt" = "ScrollbackChunk"."createdAt"
        AND earlier."id" <= "ScrollbackChunk"."id"
      )
    )
);

CREATE INDEX IF NOT EXISTS "ScrollbackChunk_sessionId_seq_idx"
  ON "ScrollbackChunk"("sessionId", "seq");
