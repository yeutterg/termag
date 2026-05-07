-- AlterTable
ALTER TABLE "Project" ADD COLUMN "position" REAL;

-- CreateIndex
CREATE INDEX "Project_userId_position_idx" ON "Project"("userId", "position");
