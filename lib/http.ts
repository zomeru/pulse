// Shared HTTP plumbing for the four API routes: uniform responses, a bounded
// body reader, the cross-origin guard, and a single place where an unexpected
// exception becomes a response instead of a stack trace.

import type { NextRequest } from "next/server";

// Nothing this API returns may be cached: it is a live map and a live mailbox.
const NO_STORE = "no-store, no-cache, must-revalidate, max-age=0";

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": NO_STORE, ...headers },
  });
}

/**
 * Every failure is a short, stable machine code. No SQL, no stack traces, no
 * database identifiers — an error body is something an attacker can read on
 * purpose, so it carries nothing they could not have guessed.
 */
export function apiError(
  status: number,
  code: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error: code }, status, headers);
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return apiError(429, "rate_limited", {
    "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });
}

/**
 * Reject state-changing requests that came from another site.
 *
 * The session token is the real defence (a cross-origin page cannot read it),
 * so this is belt and braces — it also means a future endpoint that forgets to
 * check a token is not automatically driveable from someone's page.
 *
 * A missing Origin header is allowed: non-browser clients (curl, the WebRTC
 * test rig) legitimately do not send one, and they are not the threat model.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  // No Origin at all: not a browser request, so nothing to protect against.
  if (!origin) return true;
  // An opaque origin (sandboxed frame, file://) can never be our own.
  if (origin === "null") return false;

  const hosts = [
    request.headers.get("host"),
    firstValue(request.headers.get("x-forwarded-host")),
  ].filter((value): value is string => Boolean(value));

  if (hosts.length === 0) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return hosts.includes(originHost);
}

function firstValue(header: string | null): string | null {
  if (!header) return null;
  return header.split(",")[0]?.trim() || null;
}

export type BodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response };

/**
 * Read a JSON object body with a hard byte cap.
 *
 * `request.json()` will happily buffer whatever it is given, and a declared
 * content-length cannot be trusted (it can be absent, or a lie). So the body is
 * streamed and abandoned the moment it exceeds the limit. Only a plain object is
 * accepted: these endpoints take named fields, and accepting an array or a
 * primitive would just push the shape check further downstream.
 */
export async function readJsonObject(
  request: NextRequest,
  maxBytes: number,
): Promise<BodyResult> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  // `navigator.sendBeacon` cannot set headers and sends text/plain; leave
  // handles cleanup on page unload, so that shape has to keep working.
  const allowed =
    contentType === "" ||
    contentType.startsWith("application/json") ||
    contentType.startsWith("text/plain");
  if (!allowed) {
    return { ok: false, response: apiError(415, "unsupported_media_type") };
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, response: apiError(413, "body_too_large") };
  }

  if (!request.body) return { ok: true, value: {} };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: apiError(413, "body_too_large") };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: apiError(400, "invalid_body") };
  }

  if (total === 0) return { ok: true, value: {} };

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return { ok: false, response: apiError(400, "invalid_body") };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: apiError(400, "invalid_body") };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Log an unexpected failure without putting anything sensitive in the log, and
 * answer with a generic body. Prisma errors can quote the failing invocation and
 * its arguments, which here means session ids, connection tokens and mailbox
 * payloads — none of which belong in a log line that anyone with dashboard
 * access can read.
 */
export function logApiError(route: string, error: unknown): void {
  if (process.env.NODE_ENV === "development") {
    console.error(`[api/${route}]`, error);
    return;
  }
  const name = error instanceof Error ? error.name : typeof error;
  console.error(`[api/${route}] unhandled ${name}`);
}

export async function handleApi(
  route: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    logApiError(route, error);
    return apiError(500, "internal_error");
  }
}
