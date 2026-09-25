// Client-side helpers for talking to the coordination API.
import type { PollResponse, SignalType } from "@/lib/types";

async function assertOk(response: Response, operation: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${operation} failed: ${response.status}`);
  }
}

export async function join(
  id: string,
  lat: number,
  lng: number,
  incarnationId?: string,
): Promise<void> {
  const response = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, lat, lng, incarnationId }),
  });
  await assertOk(response, "join");
}

export async function poll(
  id: string,
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
  });
  await assertOk(response, "poll");
  return response.json() as Promise<PollResponse>;
}

export async function sendSignal(
  fromId: string,
  toId: string,
  type: SignalType,
  connectionId: string,
  payload?: string,
): Promise<void> {
  const response = await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromId, toId, type, connectionId, payload }),
  });
  await assertOk(response, "signal");
}

// Best-effort page lifecycle cleanup. The server's presence heartbeat/TTL is
// the authoritative fallback when a browser cannot deliver this request.
export function leave(
  id: string,
  connectionId?: string,
  incarnationId?: string,
): void {
  const body = JSON.stringify({ id, connectionId, incarnationId });
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    try {
      if (navigator.sendBeacon("/api/leave", body)) return;
    } catch {}
  }

  void fetch("/api/leave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}
