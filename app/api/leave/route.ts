import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { terminateConnection } from "@/lib/coordination";
import {
  apiError,
  handleApi,
  isSameOrigin,
  jsonResponse,
  readJsonObject,
} from "@/lib/http";
import { isSessionToken } from "@/lib/session";
import {
  MAX_LEAVE_BODY_BYTES,
  isConnectionId,
  isIncarnationId,
  isSessionId,
} from "@/lib/validate";
import {
  clientSubject,
  enforceRateLimit,
  LEAVE_LIMITS,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/leave — body { id, sessionToken, connectionId?, incarnationId }.
//
// Best-effort lifecycle cleanup. The server heartbeat/TTL remains the
// authoritative path when a browser cannot deliver a beacon or fetch.
//
// This used to be the most dangerous endpoint in the app. It accepted a bare
// `{ id }` and treated "no connectionId supplied" and "no incarnationId
// supplied" as *matches* — so anybody who knew a session id (and the poll
// endpoint publishes every one of them) could end that stranger's live call and
// delete their dot. Now the caller must present the token that owns the row,
// and must present the page's incarnation id: a delayed unload beacon from a
// page that has already been replaced is rejected instead of deleting whatever
// took its place.
export async function POST(request: NextRequest) {
  return handleApi("leave", async () => {
    if (!isSameOrigin(request)) return apiError(403, "cross_origin");

    const body = await readJsonObject(request, MAX_LEAVE_BODY_BYTES);
    if (!body.ok) return body.response;

    const { id, sessionToken, connectionId, incarnationId } = body.value;

    if (!isSessionId(id)) return apiError(400, "invalid_id");
    if (!isSessionToken(sessionToken)) return apiError(401, "unknown_session");
    if (!isIncarnationId(incarnationId)) {
      return apiError(400, "invalid_incarnation");
    }
    if (connectionId !== undefined && !isConnectionId(connectionId)) {
      return apiError(400, "invalid_connection");
    }

    const limit = await enforceRateLimit(
      "leave:session",
      sessionToken,
      LEAVE_LIMITS.perSession,
    );
    if (!limit.allowed) return limit.response;

    const presence = await prisma.presence.findFirst({
      where: { id, sessionToken },
      select: { connectionId: true, incarnationId: true },
    });
    if (!presence) {
      // Nothing to clean up that this caller owns. Still charge the address, so
      // walking ids one at a time costs the same as presenting one token.
      const anonymous = await enforceRateLimit(
        "leave:ip",
        clientSubject(request),
        LEAVE_LIMITS.unauthenticated,
      );
      return anonymous.allowed
        ? apiError(401, "unknown_session")
        : anonymous.response;
    }

    // A delayed pagehide/unmount request must not delete a newer page or
    // connection that reused the same browser session id.
    if (presence.incarnationId !== incarnationId) {
      if (connectionId) {
        await terminateConnection(connectionId, id, "end");
      }
      return jsonResponse({ ok: true, ignored: true });
    }

    const activeConnectionId = presence.connectionId ?? undefined;
    if (activeConnectionId) {
      // terminateConnection clears the token and creates the one terminal
      // notification that must survive this request.
      await terminateConnection(activeConnectionId, id, "end");
    }
    await prisma.signal.deleteMany({
      where: {
        connectionId: null,
        OR: [{ toId: id }, { fromId: id }],
      },
    });
    // Compare-and-delete: only this row, only this token, and only while it is
    // idle. If a new connection was reserved after the read above, its non-null
    // token prevents this delayed request from deleting it.
    await prisma.presence.deleteMany({
      where: { id, sessionToken, connectionId: null },
    });

    return jsonResponse({ ok: true });
  });
}
