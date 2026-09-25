import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { reapIfDue } from "@/lib/coordination";
import {
  ACTIVE_LEASE_MS,
  MAX_CONNECTION_MS,
  MAX_INBOX_READ,
  MAX_PEERS_PER_POLL,
  STALE_MS,
} from "@/lib/presence";
import type { PollResponse } from "@/lib/types";
import { apiError, handleApi, jsonResponse } from "@/lib/http";
import { isSessionToken } from "@/lib/session";
import {
  MAX_ACK_IDS,
  MAX_POLL_URL_LENGTH,
  isConnectionId,
  isSessionId,
  parseAckList,
} from "@/lib/validate";
import {
  clientSubject,
  enforceRateLimit,
  POLL_LIMITS,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/poll?id=&connectionId=&ack= with header x-pulse-session.
//
// The single endpoint that drives the live map. It (1) heartbeats only the
// caller, (2) expires stale presence and active connections, (3) returns
// filtered online peers, and (4) reads this user's mailbox with at-least-once
// delivery.
//
// It is also the most sensitive endpoint in the app: it heartbeats a row, renews
// a connection lease, deletes acknowledged signals and returns a private
// mailbox. A session id is not a credential — every id in the `peers` list
// below is handed to every caller — so the whole endpoint is gated on the
// session token, and the heartbeat is the gate: no token, no row touched, and
// nothing read.
export async function GET(request: NextRequest) {
  return handleApi("poll", async () => {
    if (request.nextUrl.href.length > MAX_POLL_URL_LENGTH) {
      return apiError(414, "url_too_long");
    }

    const id = request.nextUrl.searchParams.get("id");
    const connectionId = request.nextUrl.searchParams.get("connectionId");
    const sessionToken = request.headers.get("x-pulse-session");

    if (!isSessionId(id)) return apiError(400, "invalid_id");
    if (connectionId !== null && !isConnectionId(connectionId)) {
      return apiError(400, "invalid_connection");
    }
    if (!isSessionToken(sessionToken)) return apiError(401, "unknown_session");

    // A well-formed token is its own bucket, so a slow network or a second tab
    // never costs a real user their heartbeat. A missing or malformed token is
    // rejected above without touching the database at all, so an unauthenticated
    // flood is charged to the address instead — below, once it has failed to
    // authenticate.
    const limit = await enforceRateLimit(
      "poll:session",
      sessionToken,
      POLL_LIMITS.perSession,
    );
    if (!limit.allowed) return limit.response;

    const acknowledgedSignalIds = parseAckList(
      request.nextUrl.searchParams.get("ack"),
    ).slice(0, MAX_ACK_IDS);

    const now = Date.now();

    // Authentication and heartbeat in one conditional write. This is the gate:
    // a token that does not own this id updates nothing, so none of the reads
    // or writes below can run on somebody else's behalf.
    const heartbeat = await prisma.presence.updateMany({
      where: { id, sessionToken },
      data: { lastSeen: new Date(now) },
    });
    if (heartbeat.count !== 1) {
      // A well-formed token that is not this row's. Charge the address too, so
      // presenting a different one on every attempt buys nothing.
      const anonymous = await enforceRateLimit(
        "poll:ip",
        clientSubject(request),
        POLL_LIMITS.unauthenticated,
      );
      return anonymous.allowed
        ? apiError(401, "unknown_session")
        : anonymous.response;
    }

    if (connectionId) {
      // Only a currently connected client may renew the active lease. A stale
      // token cannot keep an old reservation (or a newer session) alive.
      //
      // Two conditions keep this from becoming a way to hold a stranger: the
      // reservation must still be live, and the connection must still be inside
      // its maximum lifetime. `connectionStartedAt` is stamped once, by `accept`,
      // so neither side can push the deadline out by asking again.
      await prisma.presence.updateMany({
        where: {
          id,
          connectionId,
          connectionExpiresAt: { gt: new Date(now) },
          connectionStartedAt: { gte: new Date(now - MAX_CONNECTION_MS) },
        },
        data: { connectionExpiresAt: new Date(now + ACTIVE_LEASE_MS) },
      });
    }

    if (acknowledgedSignalIds.length > 0) {
      // Delete only signals this client says it processed. If the response was
      // lost, the client never sends the acknowledgement and receives them again.
      await prisma.signal.deleteMany({
        where: {
          toId: id,
          id: { in: acknowledgedSignalIds },
        },
      });
    }

    // This is deliberately scoped to the caller's heartbeat. Refreshing every
    // presence row would keep crashed users alive forever while another user
    // continued polling.
    const terminations = await reapIfDue(now);
    const endedConnectionIds = new Set(
      terminations
        .filter((termination) => termination.memberIds.includes(id))
        .map((termination) => termination.connectionId),
    );

    // Bounded. An unbounded map is a product decision we do not need to make
    // before there is a reason to, and an unbounded response is a lever anyone
    // flooding `join` could pull.
    const peers = await prisma.presence.findMany({
      where: {
        id: { not: id },
        lastSeen: { gte: new Date(now - STALE_MS) },
      },
      select: { id: true, lat: true, lng: true, busy: true },
      take: MAX_PEERS_PER_POLL,
    });

    // Signals are delivered at least once, oldest first, and only a bounded
    // slice at a time: an unacknowledged backlog should cost the recipient a
    // page of rows, not an unbounded response. The client acknowledges what it
    // processed and collects the rest on the following poll.
    // reapIfDue() removes rows past the signal TTL.
    const inbox = await prisma.signal.findMany({
      where: { toId: id },
      orderBy: { createdAt: "asc" },
      take: MAX_INBOX_READ,
    });

    const response: PollResponse = {
      peers: peers.map((peer) => ({
        id: peer.id,
        lat: peer.lat,
        lng: peer.lng,
        busy: peer.busy,
      })),
      signals: inbox.map((signal) => ({
        id: signal.id,
        fromId: signal.fromId,
        toId: signal.toId,
        type: signal.type as PollResponse["signals"][number]["type"],
        payload: signal.payload,
        connectionId: signal.connectionId,
        createdAt: signal.createdAt.toISOString(),
      })),
      endedConnectionIds: [...endedConnectionIds],
    };

    return jsonResponse(response);
  });
}
