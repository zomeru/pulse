-- Phase 3: abuse limits, and the index the TTL sweep was missing.
--
-- The rate limiter lives in Postgres rather than in process memory because a
-- Vercel function instance is a new, empty process as often as it is a warm one,
-- and an attacker is spread across many of them. A Map would reset on every cold
-- start and be invisible to the instances they are not currently talking to.

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimit_resetAt_idx" ON "RateLimit"("resetAt");

-- reapStaleConnections() deletes expired signals on every pass, and it filters
-- on createdAt alone. Without this index that was a sequential scan of the whole
-- mailbox table every couple of seconds.
CREATE INDEX "Signal_createdAt_idx" ON "Signal"("createdAt");
