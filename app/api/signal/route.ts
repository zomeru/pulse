import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  reserveConnection,
  terminateConnection,
  trimMailbox,
} from "@/lib/coordination";
import { RESERVATION_TTL_MS, STALE_MS } from "@/lib/presence";
import type { SignalType } from "@/lib/types";
import {
  apiError,
  handleApi,
  isSameOrigin,
  jsonResponse,
  readJsonObject,
} from "@/lib/http";
import { isSessionToken } from "@/lib/session";
import {
  MAX_BODY_BYTES,
  isConnectionId,
  isSessionId,
  isSignalType,
  isValidPayload,
} from "@/lib/validate";
import {
  clientSubject,
  enforceRateLimit,
  SIGNAL_LIMITS,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Both participants must still hold the connection, still be fresh, still have a
 * live lease, and still name each other. Membership is proved by the rows
 * themselves, which no caller can forge: the session token proves the sender
 * owns its own row, and this proves that row is one half of *this* connection.
 */
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

// POST /api/signal — body { fromId, toId, type, connectionId, sessionToken, payload? }
//
// This is the WebRTC handshake relay, and it is the endpoint where a forged
// message would do the most damage: an injected `offer`/`answer`/`ice` is
// attacker-controlled data handed to a stranger's browser. Four things are
// checked, in this order:
//
//   1. the session token proves the caller owns `fromId`. A caller cannot
//      announce messages on behalf of a participant it does not hold;
//   2. `connectionId` is checked against the server's own reservation, so a
//      message can only ever be delivered inside a connection that exists;
//   3. a reservation is only made for a `request`, and only while both rows are
//      free — so nobody can push a stranger into a connection, or write into
//      somebody else's, by guessing an id;
//   4. a request reserves both rows under a token, and every later message of
//      every type must present that same token while it is still live.
//
// A `request` is the only message whose `fromId` the server cannot verify beyond
// token ownership, because *being* the requester is what a reservation is. That
// is inherent to anonymous signalling and is why an unexpected request is
// declined by the client rather than acted on.
export async function POST(request: NextRequest) {
  return handleApi("signal", async () => {
    if (!isSameOrigin(request)) return apiError(403, "cross_origin");

    const body = await readJsonObject(request, MAX_BODY_BYTES);
    if (!body.ok) return body.response;

    const { fromId, toId, type, connectionId, sessionToken, payload } = body.value;

    if (!isSessionId(fromId) || !isSessionId(toId) || fromId === toId) {
      return apiError(400, "invalid_ids");
    }
    if (!isSignalType(type)) return apiError(400, "invalid_type");
    if (!isConnectionId(connectionId)) {
      return apiError(400, "invalid_connection");
    }
    if (!isValidPayload(type, payload)) {
      return apiError(400, "invalid_payload");
    }

    // Limit on the session when we have a usable token, on the address otherwise,
    // so a flood cannot mint a fresh bucket by inventing a token.
    const limit = await enforceRateLimit(
      "signal:session",
      isSessionToken(sessionToken) ? sessionToken : clientSubject(request),
      isSessionToken(sessionToken)
        ? SIGNAL_LIMITS.perSession
        : SIGNAL_LIMITS.unauthenticated,
    );
    if (!limit.allowed) return limit.response;

    // 1. Identity: this token must own the row it is speaking for. A token that
    // is not even well-formed finds no row, so this one check covers "not ours",
    // "malformed" and "not a session at all".
    const presented = isSessionToken(sessionToken) ? sessionToken : "";
    const sender = await prisma.presence.findFirst({
      where: { id: fromId, sessionToken: presented },
      select: { id: true },
    });
    if (!sender) return apiError(401, "unknown_session");

    // A single connection cannot flood one mailbox. The connection token is a
    // secret, so this bucket is only reachable by the two participants.
    const perConnection = await enforceRateLimit(
      "signal:connection",
      connectionId,
      SIGNAL_LIMITS.perConnection,
    );
    if (!perConnection.allowed) return perConnection.response;

    const signalType: SignalType = type;

    if (signalType === "request") {
      // Asking is deliberately unhurried: a human cannot tap a dot faster than
      // this, so a script cannot keep re-opening a stranger's prompt.
      const cooldown = await enforceRateLimit(
        "signal:request",
        sessionToken as string,
        SIGNAL_LIMITS.requestCooldown,
      );
      if (!cooldown.allowed) return cooldown.response;

      const terminalSignal = await prisma.signal.findFirst({
        where: { connectionId, type: { in: ["decline", "end"] } },
        select: { id: true },
      });
      if (terminalSignal) {
        return jsonResponse({ ok: true, ended: true });
      }

      const reservation = await reserveConnection({
        requesterId: fromId,
        targetId: toId,
        connectionId,
      });
      if (reservation === "declined") {
        // The target may have disappeared between the map click and this POST,
        // or been busy already. The old code answered by writing a `decline`
        // signal *from the target* — the server speaking in a real stranger's
        // name, for a decision that stranger never made. The requester is told
        // directly instead, and the target's client is left alone.
        return jsonResponse({ ok: true, autoDeclined: true });
      }
    } else if (signalType === "decline" || signalType === "end") {
      // Membership is enforced inside terminateConnection: a token the caller
      // is not a member of resolves to a no-op rather than tearing down
      // somebody else's connection. A delayed end from a token that is already
      // gone stays a successful no-op, which is what the client expects.
      const terminated = await terminateConnection(
        connectionId,
        fromId,
        signalType,
      );
      return jsonResponse(terminated.refused ? { ok: true, ignored: true } : { ok: true });
    } else if (!(await connectionIsActive(fromId, toId, connectionId))) {
      return apiError(409, "connection_not_active");
    }

    if (signalType === "accept") {
      const now = new Date();
      // Stamped once, and only while it is null, so a client cannot restart the
      // clock on the connection-duration cap by replaying `accept`.
      await prisma.presence.updateMany({
        where: {
          id: { in: [fromId, toId] },
          connectionId,
          connectionStartedAt: null,
        },
        data: { connectionStartedAt: now },
      });
      const accepted = await prisma.presence.updateMany({
        where: { id: { in: [fromId, toId] }, connectionId },
        data: { connectionExpiresAt: new Date(now.getTime() + RESERVATION_TTL_MS) },
      });
      if (accepted.count !== 2) {
        return apiError(409, "connection_not_active");
      }
    }

    await prisma.signal.create({
      data: {
        fromId,
        toId,
        type: signalType,
        payload: typeof payload === "string" ? payload : null,
        connectionId,
      },
    });

    // Bound the recipient's mailbox. Without this, one connection could fill the
    // table and make every one of the recipient's polls read it back.
    await trimMailbox(toId);

    return jsonResponse({ ok: true });
  });
}
