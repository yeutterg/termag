-- Protocol v2 makes the local runtime inventory authoritative. The broker
-- stores one bounded snapshot per device instead of continuously mirroring
-- terminal organization and output into relational rows.
ALTER TABLE "AgentToken" ADD COLUMN "inventorySnapshot" TEXT;
ALTER TABLE "AgentToken" ADD COLUMN "activeName" TEXT;

-- Keep the newest live token if an older application race admitted duplicate
-- names. Offline/revoked rows deliberately keep NULL so a name can be reused.
UPDATE "AgentToken" AS token
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE token."revokedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "AgentToken" AS newer
    WHERE newer."userId" = token."userId"
      AND newer."name" = token."name"
      AND newer."revokedAt" IS NULL
      AND (
        newer."createdAt" > token."createdAt"
        OR (newer."createdAt" = token."createdAt" AND newer."id" > token."id")
      )
  );

UPDATE "AgentToken" SET "activeName" = "name" WHERE "revokedAt" IS NULL;
CREATE UNIQUE INDEX "AgentToken_userId_activeName_key" ON "AgentToken"("userId", "activeName");

UPDATE "AgentToken" SET "protocolVersion" = 2 WHERE "protocolVersion" < 2;

DROP TABLE IF EXISTS "ScrollbackChunk";
DROP TABLE IF EXISTS "ShareLink";
DROP TABLE IF EXISTS "Session";
DROP TABLE IF EXISTS "Tab";
DROP TABLE IF EXISTS "Project";
DROP TABLE IF EXISTS "SshHost";
DROP TABLE IF EXISTS "AuditEvent";
