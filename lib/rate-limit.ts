// Abuse limits.
//
// Pulse runs on Vercel, where every request can be a different, warm-but-empty
// function instance. An in-process Map would be a rate limiter in name only: it
// resets on a cold start and is invisible to the other instances an attacker is
// spread across. Postgres is the only shared, already-required piece of
// infrastructure here, so the window counters live in it. Every instance reads
// and writes the same row, which makes the limit global.
//
// The cost is one small indexed write per request, which is why the limits are
// deliberately loose for legitimate traffic (the client polls every 1.5s, i.e.
// ~7 requests per 10s window) and tight for the endpoints that cost other
// people rather than just the caller.
//
// Keys are `scope:hash(subject)`. The subject is a session token or a client
// address; both are hashed before they touch the database, so this table can
// never be used to reconstruct either.

import { prisma } from "@/lib/prisma";
import { hashSubject } from "@/lib/session";
import { tooManyRequests } from "@/lib/http";

export interface LimitRule {
  /** Requests allowed per window. */
  limit: number;
  /** Window length. Fixed windows, deliberately: they need no read-modify-write
   *  beyond a single conditional increment. */
  windowMs: number;
}

export type LimitResult =
  | { allowed: true }
  | { allowed: false; response: Response };

async function denied(key: string, rule: LimitRule): Promise<LimitResult> {
  // Only reached on the rare "already over the limit" path, where one indexed
  // read to report an accurate Retry-After is worth it.
  let retryAfterSeconds = rule.windowMs / 1000;
  try {
    const row = await prisma.rateLimit.findUnique({
      where: { key },
      select: { resetAt: true },
    });
    if (row) retryAfterSeconds = (row.resetAt.getTime() - Date.now()) / 1000;
  } catch {
    // Report the window we know about.
  }
  return { allowed: false, response: tooManyRequests(retryAfterSeconds) };
}

let sweeps = 0;

/**
 * Fixed-window counter. The increment is conditional on being under the limit,
 * so the database — not this process — decides who is over it, and concurrent
 * requests from different instances cannot both slip past.
 */
export async function enforceRateLimit(
  scope: string,
  subject: string,
  rule: LimitRule,
): Promise<LimitResult> {
  const key = `${scope}:${hashSubject(subject)}`;
  const now = new Date();
  const resetAt = new Date(now.getTime() + rule.windowMs);

  // The common case: one conditional write, and the caller is inside the limit.
  const allowed = await prisma.rateLimit.updateMany({
    where: { key, count: { lt: rule.limit }, resetAt: { gt: now } },
    data: { count: { increment: 1 } },
  });
  if (allowed.count === 1) return { allowed: true };

  // Either the window has rolled over, or this subject is genuinely over the
  // limit. Drop the spent bucket, then make sure a live one exists.
  await prisma.rateLimit
    .deleteMany({ where: { key, resetAt: { lte: now } } })
    .catch(() => {});
  await prisma.rateLimit
    .createMany({ data: [{ key, count: 0, resetAt }], skipDuplicates: true })
    .catch(() => {});
  maybeSweep();

  // One conditional increment decides it, whoever created the row.
  const raced = await prisma.rateLimit.updateMany({
    where: { key, count: { lt: rule.limit }, resetAt: { gt: now } },
    data: { count: { increment: 1 } },
  });
  if (raced.count === 1) return { allowed: true };

  return denied(key, rule);
}

/**
 * Buckets are deleted when their window rolls over, but only for subjects that
 * come back. A sweep every so often bounds the table for subjects that never
 * return. Best-effort, and cheap because resetAt is indexed.
 */
function maybeSweep(): void {
  if (++sweeps % 500 !== 0) return;
  void prisma.rateLimit
    .deleteMany({ where: { resetAt: { lt: new Date() } } })
    .catch(() => {});
}

/** Best-effort caller identity. Hashed by the limiter; never stored raw. */
export function clientSubject(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return `ip:${first}`;
  }
  return `ip:${request.headers.get("x-real-ip")?.trim() || "unknown"}`;
}

// --- The rules -------------------------------------------------------------
//
// Every number below is headroom over the real client, except the request
// cooldown, which exists to make "tap a dot" unhurried for a human and
// impossible to automate at speed.

export const JOIN_LIMITS = {
  // A family or a campus behind one NAT share an address, so this is loose; the
  // global bucket below is what actually bounds the table.
  perClient: { limit: 60, windowMs: 60_000 } satisfies LimitRule,
  global: { limit: 600, windowMs: 60_000 } satisfies LimitRule,
};

export const POLL_LIMITS = {
  // ~7 per 10s is a healthy client; 30 leaves room for a slow network and a
  // second tab without ever tripping a real user.
  perSession: { limit: 30, windowMs: 10_000 } satisfies LimitRule,
  // No token means no session, so the address is all there is to go on.
  unauthenticated: { limit: 30, windowMs: 10_000 } satisfies LimitRule,
};

export const SIGNAL_LIMITS = {
  // A negotiation is a handful of signals: one request/accept, one offer, one
  // answer, then trickled ICE. 60 per 10s is far beyond that.
  perSession: { limit: 60, windowMs: 10_000 } satisfies LimitRule,
  perConnection: { limit: 40, windowMs: 10_000 } satisfies LimitRule,
  unauthenticated: { limit: 20, windowMs: 10_000 } satisfies LimitRule,
  // A human cannot tap a dot faster than this. This is the anti-harassment
  // control: without it a script can keep a stranger's prompt alive by asking,
  // declining, asking again.
  requestCooldown: { limit: 1, windowMs: 3_000 } satisfies LimitRule,
  // A wave is a single empty message, so there is nothing in it to abuse — but
  // it still lands on somebody's screen, and an empty message that keeps
  // arriving is harassment with the payload left out. Two shapes worth
  // bounding: hammering *one* stranger, and spraying the whole map.
  // 1 per 20s per ordered pair is unhurried for a human (you get one thought
  // about it) and impossible to automate; 20/minute per session is far more
  // than waving honestly.
  wavePerTarget: { limit: 1, windowMs: 20_000 } satisfies LimitRule,
  wavePerSession: { limit: 20, windowMs: 60_000 } satisfies LimitRule,
};

export const LEAVE_LIMITS = {
  perSession: { limit: 20, windowMs: 60_000 } satisfies LimitRule,
  unauthenticated: { limit: 20, windowMs: 60_000 } satisfies LimitRule,
};
