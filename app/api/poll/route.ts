import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { reapStaleConnections } from "@/lib/coordination";
import { ACTIVE_LEASE_MS, STALE_MS } from "@/lib/presence";
import type { PollResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/poll?id= — the single endpoint that drives the live map.
// It (1) heartbeats only the caller, (2) expires stale presence and active
// connections, (3) returns filtered online peers, and (4) reads this user's
// mailbox with at-least-once delivery.
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const connectionId = request.nextUrl.searchParams.get("connectionId");

  if (!id) {
    return Response.json({ error: "missing id" }, { status: 400 });
  }
  if (connectionId && (connectionId.length < 8 || connectionId.length > 128)) {
    return Response.json({ error: "invalid connection" }, { status: 400 });
  }

  const acknowledgedSignalIds = (request.nextUrl.searchParams.get("ack") ?? "")
    .split(",")
    .map((signalId) => signalId.trim())
    .filter((signalId) => signalId.length > 0 && signalId.length <= 128)
    .slice(0, 100);

  const now = Date.now();
  await prisma.presence.updateMany({
    where: { id },
    data: { lastSeen: new Date(now) },
  });
  if (connectionId) {
    // Only a currently connected client may renew the active lease. A stale
    // token cannot keep an old reservation (or a newer session) alive.
    await prisma.presence.updateMany({
      where: {
        id,
        connectionId,
        connectionExpiresAt: { gt: new Date(now) },
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
  const terminations = await reapStaleConnections(now);
  const endedConnectionIds = new Set(
    terminations
      .filter((termination) => termination.memberIds.includes(id))
      .map((termination) => termination.connectionId),
  );

  const peers = await prisma.presence.findMany({
    where: {
      id: { not: id },
      lastSeen: { gte: new Date(now - STALE_MS) },
    },
    select: { id: true, lat: true, lng: true, busy: true },
  });

  // Signals are delivered at least once. The client de-duplicates them by
  // remembering their IDs; leaving rows for the short signal TTL prevents a
  // lost HTTP response from permanently losing a request or end notification.
  // reapStaleConnections() removes old mailbox rows above.
  const inbox = await prisma.signal.findMany({
    where: { toId: id },
    orderBy: { createdAt: "asc" },
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

  return Response.json(response);
}
