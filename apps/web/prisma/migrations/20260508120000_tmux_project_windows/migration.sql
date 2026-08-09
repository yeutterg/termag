DROP INDEX "Session_tmuxName_key";

ALTER TABLE "Project" ADD COLUMN "tmuxSessionName" TEXT;
ALTER TABLE "Project" ADD COLUMN "tmuxManaged" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Session" ADD COLUMN "tmuxWindowName" TEXT;
ALTER TABLE "Session" ADD COLUMN "tmuxManaged" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Project"
SET "tmuxSessionName" = 'termag-' || "id"
WHERE "tmuxSessionName" IS NULL;

UPDATE "Session"
SET "tmuxWindowName" = CASE
  WHEN "kind" = 'ctrl' THEN 'ctrl'
  WHEN "tabId" IS NOT NULL THEN 'tab-' || "tabId"
  ELSE "kind" || '-' || "id"
END
WHERE "tmuxWindowName" IS NULL;

UPDATE "Session"
SET "tmuxName" = (
  SELECT "tmuxSessionName"
  FROM "Project"
  WHERE "Project"."id" = "Session"."projectId"
) || ':' || "tmuxWindowName";

CREATE UNIQUE INDEX "Project_userId_rootKey_tmuxSessionName_key"
ON "Project"("userId", "rootKey", "tmuxSessionName");

CREATE INDEX "Session_tmuxName_idx" ON "Session"("tmuxName");
