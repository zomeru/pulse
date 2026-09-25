-- Phase 3: bind every session to a server-issued capability.
--
-- `Presence.id` is a *public* address (the poll endpoint hands it to every other
-- user so dots can be tapped), so it cannot double as proof of ownership. Every
-- request that reads or changes a session's state now has to present the
-- `sessionToken` issued when that session was created, and leave requests also
-- have to present the page's `incarnationId`.
--
-- Both columns become NOT NULL. The tables hold nothing durable — a presence row
-- is deleted within STALE_MS (15s) of its last heartbeat and a signal row within
-- SIGNAL_TTL_MS (60s) — so rotating this schema costs at most one polling
-- interval of ghost rows and is not a data loss. Rows are cleared here so the
-- NOT NULL constraints apply cleanly, and so no row survives without a token.

-- AlterTable
ALTER TABLE "Presence" ADD COLUMN     "sessionToken" TEXT,
ADD COLUMN     "connectionStartedAt" TIMESTAMP(3);

DELETE FROM "Signal";
DELETE FROM "Presence";

ALTER TABLE "Presence" ALTER COLUMN "sessionToken" SET NOT NULL,
ALTER COLUMN "incarnationId" SET NOT NULL;

-- The incarnation guard is now read through the primary key next to
-- sessionToken, so this index no longer has a reader.
DROP INDEX "Presence_incarnationId_idx";
