import { prisma } from "@/lib/prisma";
import {
  MAX_MAILBOX_ROWS,
  REAP_MIN_INTERVAL_MS,
  RESERVATION_TTL_MS,
  SIGNAL_TTL_MS,
  STALE_MS,
} from "@/lib/presence";
import type { SignalType } from "@/lib/types";

const CONNECTION_CLEAR = {
  busy: false,
  connectionId: null,
  peerId: null,
  connectionStartedAt: null,
  connectionExpiresAt: null,
} as const;

export type ReservationResult = "reserved" | "already" | "declined";
export type TerminationSignal = Extract<SignalType, "decline" | "end">;

export interface TerminationResult {
  connectionId: string;
  memberIds: string[];
  notifiedPeerId: string | null;
  /**
   * True when the caller was not a participant in the connection it named, and
   * the request was therefore ignored. Refusing (rather than acting) is the
   * point: a connection token is a capability for its two participants, not a
   * handle on a stranger's call.
   */
  refused: boolean;
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

async function clearConnection(
  connectionId: string,
  memberIds: string[],
): Promise<void> {
  // Scoped to the ids we actually reserved. Clearing "every row with this token"
  // would also clear rows a *different* reservation legitimately owns.
  if (memberIds.length === 0) return;
  await prisma.presence.updateMany({
    where: { connectionId, id: { in: memberIds } },
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
      await clearConnection(connectionId, [targetId, requesterId]);
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
    await clearConnection(connectionId, [targetId, requesterId]);
    return "declined";
  }

  const leaseRenewal = await prisma.presence.updateMany({
    where: { connectionId, id: { in: [targetId, requesterId] } },
    data: { connectionExpiresAt: new Date(now + RESERVATION_TTL_MS) },
  });
  if (leaseRenewal.count !== 2) {
    await clearConnection(connectionId, [targetId, requesterId]);
    return "declined";
  }

  return targetAlreadyReserved || sourceAlreadyReserved ? "already" : "reserved";
}

/**
 * End one connection. Only rows carrying connectionId are changed, so a delayed
 * cleanup from an old session cannot clear a new one.
 *
 * The caller must be one of the two participants. `detachedActor` exists only
 * for the reaper, which has just deleted a stale participant's row and still
 * owes its peer a terminal notification.
 */
export async function terminateConnection(
  connectionId: string,
  actorId: string,
  signalType: TerminationSignal,
  { detachedActor = false }: { detachedActor?: boolean } = {},
): Promise<TerminationResult> {
  const members = await prisma.presence.findMany({
    where: { connectionId },
    select: { id: true },
  });
  const memberIds = members.map((member) => member.id);

  if (memberIds.length === 0) {
    return { connectionId, memberIds, notifiedPeerId: null, refused: false };
  }

  if (!detachedActor && !memberIds.includes(actorId)) {
    // The actor is not in this connection. Acting here would let anyone holding
    // a leaked or replayed token end somebody else's call.
    return { connectionId, memberIds, notifiedPeerId: null, refused: true };
  }

  // Notify the participants that still exist, plus the actor when the reaper
  // already claimed it: its row is cleared rather than deleted, so it can still
  // read one poll's worth of mailbox and this is how it learns that the
  // connection it thought it had is gone.
  const recipients = detachedActor
    ? [...new Set([...memberIds, actorId])]
    : memberIds;
  const notifiedPeerIds: string[] = [];
  for (const recipientId of recipients) {
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
    where: { connectionId, id: { in: memberIds } },
    data: CONNECTION_CLEAR,
  });

  if (cleared.count === 0 || notifiedPeerIds.length === 0) {
    return { connectionId, memberIds, notifiedPeerId: null, refused: false };
  }

  return {
    connectionId,
    memberIds,
    notifiedPeerId: notifiedPeerIds[0] ?? null,
    refused: false,
  };
}

/**
 * Keep a recipient's mailbox bounded. Ordering is (createdAt, id) so the cut is
 * stable when several rows share a timestamp.
 */
export async function trimMailbox(
  toId: string,
  keep: number = MAX_MAILBOX_ROWS,
): Promise<void> {
  const boundary = await prisma.signal.findFirst({
    where: { toId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: keep,
    select: { createdAt: true, id: true },
  });
  if (!boundary) return;
  await prisma.signal.deleteMany({
    where: {
      toId,
      OR: [
        { createdAt: { lt: boundary.createdAt } },
        { createdAt: boundary.createdAt, id: { lte: boundary.id } },
      ],
    },
  });
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
        await terminateConnection(row.connectionId, row.id, "end", {
          // The claim above cleared the actor's row, so it can no longer show up
          // as a member. Holding the token *was* the membership — that is why we
          // were allowed to claim it.
          detachedActor: true,
        }),
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
        await terminateConnection(row.connectionId, row.id, "end", {
          // The row is gone, so it cannot prove membership any more. It was a
          // member a moment ago — that is the whole reason we are here.
          detachedActor: true,
        }),
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
      connectionStartedAt: null,
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

let lastSweep = 0;

/**
 * Run the reaper, but not on every single request.
 *
 * `reapStaleConnections` is a handful of table-wide statements, and join and
 * poll both used to run it every time — so one request cost a second full sweep
 * of the coordination tables, which is exactly the wrong cost curve under load.
 *
 * This throttle is per warm instance and is *not* a security boundary (a cold
 * start simply runs it); it is here to stop paying for the same work twice in a
 * second. Correctness does not depend on it: the reaper only has to run
 * somewhere every couple of seconds, and every live user polls every 1.5s.
 */
export async function reapIfDue(
  now = Date.now(),
  intervalMs = REAP_MIN_INTERVAL_MS,
): Promise<TerminationResult[]> {
  if (now - lastSweep < intervalMs) return [];
  lastSweep = now;
  try {
    return await reapStaleConnections(now);
  } catch {
    // A sweep failure must not fail a poll; the next one will try again.
    return [];
  }
}
