import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyPrivacyOffset, isValidLatLng } from "@/lib/geo";
import { reapIfDue } from "@/lib/coordination";
import {
  apiError,
  handleApi,
  isSameOrigin,
  jsonResponse,
  readJsonObject,
} from "@/lib/http";
import { issueSessionToken, isSessionToken } from "@/lib/session";
import {
  MAX_JOIN_BODY_BYTES,
  isIncarnationId,
  isSessionId,
} from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/join — body { id, lat, lng, incarnationId, sessionToken? }.
//
// This is the only endpoint that does not require a session token, because it is
// where one is issued. The trade is explicit: the first join for an id creates
// the row and mints the token, and every later join must present the token that
// row already holds. A third party who knows somebody's id — and every id is
// public, because the poll endpoint hands out the whole map — therefore cannot
// move their dot, rewrite their incarnation id or take over their session. They
// get a 409 and keep nothing.
//
// Raw coordinates are never stored: the privacy offset is applied here.
export async function POST(request: NextRequest) {
  return handleApi("join", async () => {
    if (!isSameOrigin(request)) return apiError(403, "cross_origin");

    const body = await readJsonObject(request, MAX_JOIN_BODY_BYTES);
    if (!body.ok) return body.response;

    const { id, lat, lng, incarnationId, sessionToken } = body.value;

    if (!isSessionId(id)) return apiError(400, "invalid_id");
    if (!isIncarnationId(incarnationId)) {
      return apiError(400, "invalid_incarnation");
    }
    if (!isValidLatLng(lat, lng)) return apiError(400, "invalid_coordinates");
    // Present-but-wrong is a client bug; absent means "first join for this id".
    if (sessionToken !== undefined && !isSessionToken(sessionToken)) {
      return apiError(400, "invalid_session");
    }

    const offset = applyPrivacyOffset(lat as number, lng as number);
    const lastSeen = new Date();

    // Read/cleanup pass. Throttled, so it does not turn every join into a
    // second full sweep of the tables.
    await reapIfDue();

    // Update first, and make it conditional on owning the row: a returning
    // browser only ever re-sends the token it was issued. No read-then-write,
    // so there is no window in which somebody else's token can be substituted.
    const updated = await prisma.presence.updateMany({
      where: { id, sessionToken: sessionToken ?? "" },
      data: { lat: offset.lat, lng: offset.lng, lastSeen, incarnationId },
    });
    if (updated.count === 1) {
      return jsonResponse({ ok: true, sessionToken });
    }

    const fresh = issueSessionToken();
    try {
      await prisma.presence.create({
        data: {
          id,
          sessionToken: fresh,
          incarnationId,
          lat: offset.lat,
          lng: offset.lng,
          busy: false,
          lastSeen,
        },
      });
    } catch (error) {
      // The id belongs to a row whose token we cannot prove — either somebody
      // else owns it, or two first-joins raced. Either way this caller has to
      // start a new session rather than retry with the same id.
      if (isUniqueViolation(error)) return apiError(409, "session_taken");
      throw error;
    }

    return jsonResponse({ ok: true, sessionToken: fresh });
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}
