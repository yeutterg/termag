-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "tmuxName" TEXT NOT NULL,
    "tmuxWindowName" TEXT,
    "tmuxManaged" BOOLEAN NOT NULL DEFAULT true,
    "agentType" TEXT,
    "spawnCommand" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sleeping',
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "projectId" TEXT,
    "sshHostId" TEXT,
    "tabId" TEXT,
    CONSTRAINT "Session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Session_sshHostId_fkey" FOREIGN KEY ("sshHostId") REFERENCES "SshHost" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Session_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "Tab" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Session" ("agentType", "createdAt", "id", "kind", "lastSeenAt", "projectId", "spawnCommand", "status", "tabId", "tmuxManaged", "tmuxName", "tmuxWindowName", "updatedAt") SELECT "agentType", "createdAt", "id", "kind", "lastSeenAt", "projectId", "spawnCommand", "status", "tabId", "tmuxManaged", "tmuxName", "tmuxWindowName", "updatedAt" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE UNIQUE INDEX "Session_tabId_key" ON "Session"("tabId");
CREATE INDEX "Session_projectId_kind_idx" ON "Session"("projectId", "kind");
CREATE INDEX "Session_sshHostId_idx" ON "Session"("sshHostId");
CREATE INDEX "Session_tmuxName_idx" ON "Session"("tmuxName");
CREATE UNIQUE INDEX "Session_sshHostId_tmuxName_key" ON "Session"("sshHostId", "tmuxName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
