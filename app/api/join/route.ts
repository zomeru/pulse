import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyPrivacyOffset, isValidLatLng } from "@/lib/geo";
import { reapStaleConnections } from "@/lib/coordination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/join — body { id, lat, lng, incarnationId } (raw coords).
// Applies a 1–3 km privacy offset and upserts the presence row. Raw
// coordinates are never stored.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const { id, lat, lng, incarnationId } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (typeof id !== "string" || id.length < 8 || id.length > 64) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }
  if (
    incarnationId !== undefined &&
    (typeof incarnationId !== "string" ||
      incarnationId.length < 8 ||
      incarnationId.length > 128)
  ) {
    return Response.json({ error: "invalid incarnation" }, { status: 400 });
  }
  if (!isValidLatLng(lat, lng)) {
    return Response.json({ error: "invalid coordinates" }, { status: 400 });
  }

  const offset = applyPrivacyOffset(lat as number, lng as number);

  // Keep lazy TTL cleanup running even when an existing user has not polled
  // recently. This is a read/cleanup pass; the caller's row is written below.
  await reapStaleConnections();

  await prisma.presence.upsert({
    where: { id },
    create: {
      id,
      incarnationId: typeof incarnationId === "string" ? incarnationId : null,
      lat: offset.lat,
      lng: offset.lng,
      busy: false,
      lastSeen: new Date(),
    },
    update: {
      ...(typeof incarnationId === "string" ? { incarnationId } : {}),
      lat: offset.lat,
      lng: offset.lng,
      lastSeen: new Date(),
    },
  });

  return Response.json({ ok: true });
}
