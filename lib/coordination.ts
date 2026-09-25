import { prisma } from "@/lib/prisma";
import {
  RESERVATION_TTL_MS,
  SIGNAL_TTL_MS,
  STALE_MS,
} from "@/lib/presence";
import type { SignalType } from "@/lib/types";

const CONNECTION_CLEAR = {
  busy: false,
  connectionId: null,
  peerId: null,
  connectionExpiresAt: null,
} as const;

export type ReservationResult = "reserved" | "already" | "declined";
export type TerminationSignal = Extract<SignalType, "decline" | "end">;

export interface TerminationResult {
  connectionId: string;
  memberIds: string[];
  notifiedPeerId: string | null;
}

function includeActor(
  result: TerminationResult,
  actorId: string,
): TerminationResult {
  if (!result.memberIds.includes(actorId)) {
    result.memberIds.push(actorId);
  }
  return result;
}

function isFresh(lastSeen: Date, staleCutoff: Date): boolean {
  return lastSeen.getTime() >= staleCutoff.getTime();
}

function hasLiveLease(
  connectionExpiresAt: Date | null,
  now: number,
): boolean {
  return connectionExpiresAt !== null && connectionExpiresAt.getTime() > now;
}

function connectionMatches(
  row: {
    connectionId: string | null;
    peerId: string | null;
  },
  connectionId: string,
  peerId: string,
): boolean {
  return row.connectionId === connectionId && row.peerId === peerId;
}

async function clearConnection(connectionId: string): Promise<void> {
  await prisma.presence.updateMany({
    where: { connectionId },
    data: CONNECTION_CLEAR,
  });
}

/**
 * Reserve both presence rows for a request. The conditional updates make a
 * repeated request for the same token harmless without allowing a stale
 * cleanup to affect a later connection.
 */
export async function reserveConnection({
  requesterId,
  targetId,
  connectionId,
  now = Date.now(),
}: {
  requesterId: string;
  targetId: string;
  connectionId: string;
  now?: number;
}): Promise<ReservationResult> {
  if (requesterId === targetId) return "declined";

  const staleCutoff = new Date(now - STALE_MS);
  const targetResult = await prisma.presence.updateMany({
    where: {
      id: targetId,
      lastSeen: { gte: staleCutoff },
      busy: false,
      connectionId: null,
    },
    data: {
      busy: true,
      connectionId,
      peerId: requesterId,
      connectionExpiresAt: new Date(now + RESERVATION_TTL_MS),
    },
  });

  let targetAlreadyReserved = false;
  if (targetResult.count === 0) {
    const target = await prisma.presence.findUnique({
      where: { id: targetId },
      select: {
        connectionId: true,
        peerId: true,
        lastSeen: true,
        connectionExpiresAt: true,
      },
    });
    if (
      !target ||
      !isFresh(target.lastSeen, staleCutoff) ||
      !hasLiveLease(target.connectionExpiresAt, now) ||
      !connectionMatches(target, connectionId, requesterId)
    ) {
      return "declined";
    }
    targetAlreadyReserved = true;
  }

  const sourceResult = await prisma.presence.updateMany({
    where: {
      id: requesterId,
      lastSeen: { gte: staleCutoff },
      busy: false,
      connectionId: null,
    },
    data: {
      busy: true,
      connectionId,
      peerId: targetId,
      connectionExpiresAt: new Date(now + RESERVATION_TTL_MS),
    },
  });

  let sourceAlreadyReserved = false;
  if (sourceResult.count === 0) {
    const source = await prisma.presence.findUnique({
      where: { id: requesterId },
      select: {
        connectionId: true,
        peerId: true,
        lastSeen: true,
        connectionExpiresAt: true,
      },
    });
    if (
      !source ||
      !isFresh(source.lastSeen, staleCutoff) ||
      !hasLiveLease(source.connectionExpiresAt, now) ||
      !connectionMatches(source, connectionId, targetId)
    ) {
      await clearConnection(connectionId);
      return "declined";
    }
    sourceAlreadyReserved = true;
  }

  const members = await prisma.presence.findMany({
    where: { connectionId },
    select: {
      id: true,
      connectionId: true,
      peerId: true,
      connectionExpiresAt: true,
    },
  });
  const targetMember = members.find((member) => member.id === targetId);
  const sourceMember = members.find((member) => member.id === requesterId);
  if (
    members.length !== 2 ||
    !targetMember ||
    !sourceMember ||
    !hasLiveLease(targetMember.connectionExpiresAt, now) ||
    !hasLiveLease(sourceMember.connectionExpiresAt, now) ||
    !connectionMatches(targetMember, connectionId, requesterId) ||
    !connectionMatches(sourceMember, connectionId, targetId)
  ) {
    await clearConnection(connectionId);
    return "declined";
  }

  const leaseRenewal = await prisma.presence.updateMany({
    where: { connectionId },
    data: { connectionExpiresAt: new Date(now + RESERVATION_TTL_MS) },
  });
  if (leaseRenewal.count !== 2) {
    await clearConnection(connectionId);
    return "declined";
  }

  return targetAlreadyReserved || sourceAlreadyReserved ? "already" : "reserved";
}

/**
 * End one token-qualified connection. Only rows carrying connectionId are
 * changed, so a delayed cleanup from an old session cannot clear a new one.
 */
export async function terminateConnection(
  connectionId: string,
  actorId: string,
  signalType: TerminationSignal,
): Promise<TerminationResult> {
  const members = await prisma.presence.findMany({
    where: { connectionId },
    select: { id: true },
  });
  const memberIds = members.map((member) => member.id);

  if (memberIds.length === 0) {
    return { connectionId, memberIds, notifiedPeerId: null };
  }

  const recipients = [...new Set(memberIds)];
  if (memberIds.length > 0) recipients.push(actorId);
  const notifiedPeerIds: string[] = [];
  for (const recipientId of new Set(recipients)) {
    try {
      // Write terminal markers before clearing the reservation. A delayed
      // request can then observe the tombstone and cannot reserve this token
      // again. Mailbox rows are intentionally retained until SIGNAL_TTL_MS.
      await prisma.signal.create({
        data: {
          fromId: actorId,
          toId: recipientId,
          type: signalType,
          payload: null,
          connectionId,
        },
      });
      notifiedPeerIds.push(recipientId);
    } catch {
      // Cleanup must still proceed if signaling storage is temporarily
      // unavailable; the lease/TTL path remains a fallback.
    }
  }

  const cleared = await prisma.presence.updateMany({
    where: { connectionId },
    data: CONNECTION_CLEAR,
  });

  if (cleared.count === 0 || notifiedPeerIds.length === 0) {
    return { connectionId, memberIds, notifiedPeerId: null };
  }

  return {
    connectionId,
    memberIds,
    notifiedPeerId: notifiedPeerIds[0] ?? null,
  };
}

/**
 * Lazily remove expired presence and repair any reservation whose peer has
 * expired. Polling is the heartbeat in this architecture, so this function is
 * the TTL fallback for crashes, power loss, and missed unload events.
 */
export async function reapStaleConnections(now = Date.now()): Promise<TerminationResult[]> {
  const staleCutoff = new Date(now - STALE_MS);
  const signalCutoff = new Date(now - SIGNAL_TTL_MS);
  const terminated: TerminationResult[] = [];
  const handledTokens = new Set<string>();

  // A requested/negotiating connection can expire even while both browsers
  // continue to heartbeat. Claim the actor conditionally first: if its poll
  // renewed the lease after this query, the claim affects zero rows and the
  // live connection is left alone.
  const expiredRows = await prisma.presence.findMany({
    where: {
      connectionId: { not: null },
      connectionExpiresAt: { lt: new Date(now) },
    },
    select: { id: true, connectionId: true },
  });
  for (const row of expiredRows) {
    if (!row.connectionId || handledTokens.has(row.connectionId)) continue;
    const claimed = await prisma.presence.updateMany({
      where: {
        id: row.id,
        connectionId: row.connectionId,
        connectionExpiresAt: { lt: new Date(now) },
      },
      data: CONNECTION_CLEAR,
    });
    if (claimed.count === 0) continue;
    handledTokens.add(row.connectionId);
    terminated.push(
      includeActor(
        await terminateConnection(row.connectionId, row.id, "end"),
        row.id,
      ),
    );
  }

  const staleRows = await prisma.presence.findMany({
    where: { lastSeen: { lt: staleCutoff } },
    select: { id: true, connectionId: true },
  });

  for (const row of staleRows) {
    if (!row.connectionId) continue;
    if (handledTokens.has(row.connectionId)) continue;

    // Delete/claim the stale actor conditionally before touching its peer.
    // This prevents a concurrent heartbeat from being cleared by a stale
    // snapshot.
    const claimed = await prisma.presence.deleteMany({
      where: {
        id: row.id,
        connectionId: row.connectionId,
        lastSeen: { lt: staleCutoff },
      },
    });
    if (claimed.count === 0) continue;
    handledTokens.add(row.connectionId);
    terminated.push(
      includeActor(
        await terminateConnection(row.connectionId, row.id, "end"),
        row.id,
      ),
    );
  }

  // A row can remain fresh while its peer is stale (for example, if the peer
  // crashed between two polls). Check those links before deleting stale rows
  // so the surviving side is notified as well.
  const freshRows = await prisma.presence.findMany({
    where: {
      lastSeen: { gte: staleCutoff },
      connectionId: { not: null },
    },
    select: { id: true, connectionId: true, peerId: true },
  });
  const freshById = new Map(freshRows.map((row) => [row.id, row]));

  for (const row of freshRows) {
    if (!row.connectionId || handledTokens.has(row.connectionId)) continue;
    const peer = row.peerId ? freshById.get(row.peerId) : undefined;
    if (
      !peer ||
      peer.connectionId !== row.connectionId ||
      peer.peerId !== row.id
    ) {
      handledTokens.add(row.connectionId);
      terminated.push(
        includeActor(
          await terminateConnection(row.connectionId, row.id, "end"),
          row.id,
        ),
      );
    }
  }

  // Transitional rows from the pre-token schema must not remain busy forever
  // while continuing to heartbeat.
  await prisma.presence.updateMany({
    where: { busy: true, connectionId: null },
    data: {
      busy: false,
      peerId: null,
      connectionExpiresAt: null,
    },
  });

  await prisma.presence.deleteMany({
    where: { lastSeen: { lt: staleCutoff } },
  });
  await prisma.signal.deleteMany({
    where: { createdAt: { lt: signalCutoff } },
  });

  return terminated;
}
