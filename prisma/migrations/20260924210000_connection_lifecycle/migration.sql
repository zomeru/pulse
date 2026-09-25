-- AlterTable
ALTER TABLE "Presence" ADD COLUMN     "connectionExpiresAt" TIMESTAMP(3),
ADD COLUMN     "connectionId" TEXT,
ADD COLUMN     "incarnationId" TEXT,
ADD COLUMN     "peerId" TEXT;

-- AlterTable
ALTER TABLE "Signal" ADD COLUMN     "connectionId" TEXT;

-- Transitional busy rows from the pre-token schema must not survive the
-- migration as permanently busy users.
UPDATE "Presence"
SET "busy" = false,
    "connectionExpiresAt" = NULL,
    "connectionId" = NULL,
    "incarnationId" = NULL,
    "peerId" = NULL
WHERE "busy" = true;

-- CreateIndex
CREATE INDEX "Presence_incarnationId_idx" ON "Presence"("incarnationId");

-- CreateIndex
CREATE INDEX "Presence_connectionId_idx" ON "Presence"("connectionId");

-- CreateIndex
CREATE INDEX "Presence_connectionExpiresAt_idx" ON "Presence"("connectionExpiresAt");

-- CreateIndex
CREATE INDEX "Signal_toId_createdAt_idx" ON "Signal"("toId", "createdAt");

-- CreateIndex
CREATE INDEX "Signal_connectionId_idx" ON "Signal"("connectionId");
