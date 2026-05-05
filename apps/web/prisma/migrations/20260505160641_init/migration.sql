-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "image" TEXT,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    "userId" TEXT NOT NULL,
    CONSTRAINT "AgentToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rootKey" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "agentSpawnCommand" TEXT NOT NULL,
    "ctrlSpawnCommand" TEXT NOT NULL DEFAULT '$SHELL',
    "status" TEXT NOT NULL DEFAULT 'sleeping',
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tab" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sleeping',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "projectId" TEXT NOT NULL,
    CONSTRAINT "Tab_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "tmuxName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sleeping',
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "projectId" TEXT NOT NULL,
    "tabId" TEXT,
    CONSTRAINT "Session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Session_tabId_fkey" FOREIGN KEY ("tabId") REFERENCES "Tab" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScrollbackChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "data" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT NOT NULL,
    CONSTRAINT "ScrollbackChunk_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToken_tokenHash_key" ON "AgentToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentToken_userId_idx" ON "AgentToken"("userId");

-- CreateIndex
CREATE INDEX "Project_userId_openedAt_idx" ON "Project"("userId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Project_userId_name_key" ON "Project"("userId", "name");

-- CreateIndex
CREATE INDEX "Tab_projectId_idx" ON "Tab"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Tab_projectId_ordinal_key" ON "Tab"("projectId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tmuxName_key" ON "Session"("tmuxName");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tabId_key" ON "Session"("tabId");

-- CreateIndex
CREATE INDEX "Session_projectId_kind_idx" ON "Session"("projectId", "kind");

-- CreateIndex
CREATE INDEX "ScrollbackChunk_sessionId_createdAt_idx" ON "ScrollbackChunk"("sessionId", "createdAt");
