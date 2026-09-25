// Runtime validation for everything a client can put in a request.
//
// TypeScript types vanish at runtime and this API is called by whatever the
// browser felt like sending, so every externally controlled value is checked
// here before it reaches Postgres. The formats are deliberately narrow: the
// browser generates all of these with crypto.randomUUID() (or the server issues
// the token), so there is no legitimate value outside these patterns.

import type { SignalType } from "@/lib/types";

// Session ids, connection tokens, page instance tokens and signal ids are all
// UUIDs. We accept the base64url alphabet too because a future client is free
// to generate a shorter id, and we never want a schema change to become an
// outage.
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const SIGNAL_TYPES: readonly SignalType[] = [
  "request",
  "accept",
  "decline",
  "offer",
  "answer",
  "ice",
  "end",
];

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isIncarnationId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function isSignalType(value: unknown): value is SignalType {
  return typeof value === "string" && SIGNAL_TYPES.includes(value as SignalType);
}

/**
 * A session description is a few kilobytes; anything larger is either a mistake
 * or an attempt to make the server hold a large string. A browser SDP is ~2-4 KB
 * and a single ICE candidate is a few hundred bytes, so these caps leave a wide
 * margin over what WebRTC actually produces.
 */
export const MAX_SDP_PAYLOAD = 24 * 1024;
export const MAX_ICE_PAYLOAD = 4 * 1024;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_JOIN_BODY_BYTES = 4 * 1024;
export const MAX_LEAVE_BODY_BYTES = 4 * 1024;
// A poll is a query string, not a body. 100 acknowledgements is what one poll
// can return, and a UUID plus separator is 37 characters.
export const MAX_POLL_URL_LENGTH = 8 * 1024;
export const MAX_ACK_IDS = 100;

/**
 * Only SDP and ICE carry a payload. Letting `request`/`decline`/`end` carry one
 * would just be a way to push 64 KB of junk into someone's mailbox.
 */
export function payloadLimitFor(type: SignalType): number {
  switch (type) {
    case "offer":
    case "answer":
      return MAX_SDP_PAYLOAD;
    case "ice":
      return MAX_ICE_PAYLOAD;
    default:
      return 0;
  }
}

export function isValidPayload(
  type: SignalType,
  payload: unknown,
): payload is string | null {
  if (payload === undefined || payload === null) return true;
  if (typeof payload !== "string") return false;
  return payload.length > 0 && payload.length <= payloadLimitFor(type);
}

/**
 * Ack list from a poll. Bounded in count *and* length, and anything malformed is
 * dropped rather than rejected — a stale client sending an odd id should not
 * lose its heartbeat.
 */
export function parseAckList(raw: string | null): string[] {
  if (!raw) return [];
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    if (ids.length >= MAX_ACK_IDS) break;
    const id = part.trim();
    if (ID_PATTERN.test(id)) ids.push(id);
  }
  return ids;
}
