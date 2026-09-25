import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { terminateConnection } from "@/lib/coordination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/leave — body { id, connectionId?, incarnationId? }.
// This is best-effort lifecycle cleanup. The server heartbeat/TTL remains the
// authoritative path when a browser cannot deliver a beacon or fetch.
export async function POST(request: NextRequest) {
  let id: string | undefined;
  let connectionId: string | undefined;
  let incarnationId: string | undefined;
  try {
    const text = await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    id = typeof body.id === "string" ? body.id : undefined;
    connectionId =
      typeof body.connectionId === "string" ? body.connectionId : undefined;
    incarnationId =
      typeof body.incarnationId === "string" ? body.incarnationId : undefined;
  } catch {
    id = undefined;
    connectionId = undefined;
    incarnationId = undefined;
  }

  if (!id) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const presence = await prisma.presence.findUnique({
    where: { id },
    select: { connectionId: true, incarnationId: true },
  });

  // A delayed pagehide/unmount request must not delete a newer page or
  // connection that reused the same browser session id.
  const incarnationMatches =
    !incarnationId || presence?.incarnationId === incarnationId;
  const connectionMatches =
    !connectionId || presence?.connectionId === connectionId;
  if (!incarnationMatches || !connectionMatches) {
    if (connectionId) {
      await terminateConnection(connectionId, id, "end");
    }
    return Response.json({ ok: true });
  }

  const activeConnectionId = presence?.connectionId ?? undefined;
  if (activeConnectionId) {
    // terminateConnection clears the token and creates the one terminal
    // notification that must survive this request.
    await terminateConnection(activeConnectionId, id, "end");
    await prisma.signal.deleteMany({
      where: {
        connectionId: null,
        OR: [{ toId: id }, { fromId: id }],
      },
    });
  } else {
    await prisma.signal.deleteMany({
      where: {
        connectionId: null,
        OR: [{ toId: id }, { fromId: id }],
      },
    });
  }
  // Compare-and-delete only an idle row. If a new connection was reserved
  // after the cleanup read, its non-null token prevents this delayed leave
  // request from deleting it.
  await prisma.presence.deleteMany({
    where: {
      id,
      connectionId: null,
      ...(incarnationId ? { incarnationId } : {}),
    },
  });

  return Response.json({ ok: true });
}
