// Client-side helpers for talking to the coordination API.
//
// The session token is issued by /api/join and kept in memory for the lifetime
// of the page. It is the server's proof that we own the presence row we are
// talking about, so every call carries it — and because it is a bearer secret
// rather than a claim about identity, there is nothing else to keep in sync and
// nothing to store.
import type { PollResponse, SignalType } from "@/lib/types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`${code} (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** The server does not know this session, or it is not ours to act on. */
  get isUnknownSession(): boolean {
    return this.status === 401 || this.code === "session_taken";
  }

  /** Trying again cannot help. */
  get isTerminal(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

async function assertOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  let code = "request_failed";
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      code = (body as { error: string }).error;
    }
  } catch {
    // A non-JSON error body is not worth reporting.
  }
  throw new ApiError(response.status, code === "request_failed" ? operation : code);
}

export interface JoinResult {
  sessionToken: string;
}

/**
 * Create or refresh this session's dot. `sessionToken` is only sent when we
 * already have one — leaving it off is what asks the server to mint a new
 * session, which it only does for an id nobody holds.
 */
export async function join(
  id: string,
  lat: number,
  lng: number,
  incarnationId: string,
  sessionToken?: string,
): Promise<JoinResult> {
  const response = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, lat, lng, incarnationId, sessionToken }),
  });
  await assertOk(response, "join");
  const body = (await response.json()) as JoinResult;
  return body;
}

export async function poll(
  id: string,
  sessionToken: string,
  connectionId?: string,
  acknowledgedSignalIds: string[] = [],
): Promise<PollResponse> {
  const query = new URLSearchParams({ id });
  if (connectionId) query.set("connectionId", connectionId);
  if (acknowledgedSignalIds.length > 0) {
    query.set("ack", acknowledgedSignalIds.slice(0, 100).join(","));
  }
  const response = await fetch(`/api/poll?${query.toString()}`, {
    cache: "no-store",
    headers: { "x-pulse-session": sessionToken },
  });
  await assertOk(response, "poll");
  return response.json() as Promise<PollResponse>;
}

export interface SignalRequest {
  fromId: string;
  toId: string;
  type: SignalType;
  connectionId: string;
  sessionToken: string;
  payload?: string;
}

export interface SignalResult {
  /** The target was gone or already busy, so no reservation was made. */
  autoDeclined?: boolean;
  /** The connection had already been torn down; nothing to do. */
  ended?: boolean;
  /** The caller was not a participant in the connection it named. */
  ignored?: boolean;
}

export async function sendSignal(
  request: SignalRequest,
): Promise<SignalResult> {
  const response = await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  await assertOk(response, "signal");
  return (await response.json()) as SignalResult;
}

// Best-effort page lifecycle cleanup. The server's presence heartbeat/TTL is
// the authoritative fallback when a browser cannot deliver this request.
//
// The token travels in the body because `navigator.sendBeacon` cannot set
// headers, and leave is exactly the request that has to survive a closing tab.
export function leave(
  id: string,
  sessionToken: string,
  incarnationId: string,
  connectionId?: string,
): void {
  const body = JSON.stringify({ id, sessionToken, incarnationId, connectionId });
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    try {
      if (navigator.sendBeacon("/api/leave", body)) return;
    } catch {
      // Fall through to fetch.
    }
  }

  void fetch("/api/leave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}
