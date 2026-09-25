import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { reserveConnection, terminateConnection } from "@/lib/coordination";
import { RESERVATION_TTL_MS, STALE_MS } from "@/lib/presence";
import type { SignalType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES: SignalType[] = [
  "request",
  "accept",
  "decline",
  "offer",
  "answer",
  "ice",
  "end",
];

const MAX_PAYLOAD = 64 * 1024; // SDP/ICE are small; cap to be safe.

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isConnectionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 128
  );
}

async function connectionIsActive(
  fromId: string,
  toId: string,
  connectionId: string,
): Promise<boolean> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_MS);
  const members = await prisma.presence.findMany({
    where: {
      id: { in: [fromId, toId] },
      connectionId,
      busy: true,
      lastSeen: { gte: staleCutoff },
      connectionExpiresAt: { gt: now },
    },
    select: { id: true, peerId: true },
  });
  if (members.length !== 2) return false;
  const from = members.find((member) => member.id === fromId);
  const to = members.find((member) => member.id === toId);
  return from?.peerId === toId && to?.peerId === fromId;
}

async function sendDecline(
  targetId: string,
  initiatorId: string,
  connectionId: string,
): Promise<void> {
  await prisma.signal.create({
    data: {
      fromId: targetId,
      toId: initiatorId,
      type: "decline",
      payload: null,
      connectionId,
    },
  });
}

// POST /api/signal — body { fromId, toId, type, connectionId, payload? }
// A request reserves a token on both presence rows. Every later message is
// checked against that token, and end/decline cleanup is token-qualified.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { fromId, toId, type, connectionId, payload } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (!isId(fromId) || !isId(toId) || fromId === toId) {
    return Response.json({ error: "invalid ids" }, { status: 400 });
  }
  if (typeof type !== "string" || !VALID_TYPES.includes(type as SignalType)) {
    return Response.json({ error: "invalid type" }, { status: 400 });
  }
  if (!isConnectionId(connectionId)) {
    return Response.json({ error: "invalid connection" }, { status: 400 });
  }
  if (
    payload !== undefined &&
    payload !== null &&
    (typeof payload !== "string" || payload.length > MAX_PAYLOAD)
  ) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  const signalType = type as SignalType;
  const payloadStr = typeof payload === "string" ? payload : null;

  if (signalType === "request") {
    const terminalSignal = await prisma.signal.findFirst({
      where: { connectionId, type: { in: ["decline", "end"] } },
      select: { id: true },
    });
    if (terminalSignal) {
      return Response.json({ ok: true, ended: true });
    }

    const reservation = await reserveConnection({
      requesterId: fromId,
      targetId: toId,
      connectionId,
    });
    if (reservation === "declined") {
      // The target may have disappeared between the map click and this POST;
      // a decline is still useful to the requester and is safe to retry.
      await sendDecline(toId, fromId, connectionId);
      return Response.json({ ok: true, autoDeclined: true });
    }
  } else if (signalType === "decline" || signalType === "end") {
    // A delayed end from an old token is a successful no-op, not an error.
    await terminateConnection(connectionId, fromId, signalType);
    return Response.json({ ok: true });
  } else if (!(await connectionIsActive(fromId, toId, connectionId))) {
    return Response.json({ error: "connection is no longer active" }, { status: 409 });
  }

  if (signalType === "accept") {
    const accepted = await prisma.presence.updateMany({
      where: { id: { in: [fromId, toId] }, connectionId },
      data: { connectionExpiresAt: new Date(Date.now() + RESERVATION_TTL_MS) },
    });
    if (accepted.count !== 2) {
      return Response.json({ error: "connection is no longer active" }, { status: 409 });
    }
  }

  await prisma.signal.create({
    data: {
      fromId,
      toId,
      type: signalType,
      payload: payloadStr,
      connectionId,
    },
  });

  return Response.json({ ok: true });
}
