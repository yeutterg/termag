DROP INDEX IF EXISTS "Tab_projectId_ordinal_key";
CREATE INDEX IF NOT EXISTS "Tab_projectId_ordinal_idx" ON "Tab"("projectId", "ordinal");
