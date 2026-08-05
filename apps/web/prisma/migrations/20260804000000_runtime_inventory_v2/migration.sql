ALTER TABLE "AgentToken" ADD COLUMN "protocolVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AgentToken" ADD COLUMN "capabilities" TEXT;
ALTER TABLE "AgentToken" ADD COLUMN "lastInventoryAt" DATETIME;

ALTER TABLE "Project" ADD COLUMN "deviceId" TEXT;
ALTER TABLE "Project" ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'tmux';
ALTER TABLE "Project" ADD COLUMN "runtimeSessionId" TEXT;
ALTER TABLE "Project" ADD COLUMN "runtimeSessionName" TEXT;
ALTER TABLE "Project" ADD COLUMN "runtimeSpaceName" TEXT;
ALTER TABLE "Project" ADD COLUMN "runtimeIconStyle" TEXT;
ALTER TABLE "Project" ADD COLUMN "runtimeOrdinal" INTEGER;
ALTER TABLE "Project" ADD COLUMN "runtimeFocused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Project" ADD COLUMN "runtimeRevision" INTEGER;
ALTER TABLE "Project" ADD COLUMN "layout" TEXT;
ALTER TABLE "Project" ADD COLUMN "creationPath" TEXT;
ALTER TABLE "Project" ADD COLUMN "mirrored" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "archivedAt" DATETIME;

ALTER TABLE "Tab" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Tab" ADD COLUMN "runtimeTabId" TEXT;
ALTER TABLE "Tab" ADD COLUMN "runtimeTabName" TEXT;
ALTER TABLE "Tab" ADD COLUMN "runtimeTabStatus" TEXT;
ALTER TABLE "Tab" ADD COLUMN "runtimePaneId" TEXT;
ALTER TABLE "Tab" ADD COLUMN "runtimePaneName" TEXT;
ALTER TABLE "Tab" ADD COLUMN "runtimePaneIndex" INTEGER;
ALTER TABLE "Tab" ADD COLUMN "layout" TEXT;
ALTER TABLE "Tab" ADD COLUMN "focused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tab" ADD COLUMN "archivedAt" DATETIME;

ALTER TABLE "Session" ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'tmux';
ALTER TABLE "Session" ADD COLUMN "runtimeSessionId" TEXT;
ALTER TABLE "Session" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Session" ADD COLUMN "terminalId" TEXT;
ALTER TABLE "Session" ADD COLUMN "controllerMode" TEXT NOT NULL DEFAULT 'observe';
ALTER TABLE "Session" ADD COLUMN "archivedAt" DATETIME;

CREATE INDEX "Project_userId_deviceId_runtime_runtimeSessionId_idx" ON "Project"("userId", "deviceId", "runtime", "runtimeSessionId");
CREATE UNIQUE INDEX "Project_userId_deviceId_runtime_runtimeSessionId_externalId_key" ON "Project"("userId", "deviceId", "runtime", "runtimeSessionId", "externalId");
CREATE UNIQUE INDEX "Tab_projectId_runtimePaneId_key" ON "Tab"("projectId", "runtimePaneId");
CREATE INDEX "Tab_projectId_runtimeTabId_runtimePaneIndex_idx" ON "Tab"("projectId", "runtimeTabId", "runtimePaneIndex");
CREATE INDEX "Session_runtime_runtimeSessionId_externalId_idx" ON "Session"("runtime", "runtimeSessionId", "externalId");
