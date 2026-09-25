// Server-side capability for an anonymous presence row.
//
// Pulse has no accounts, and it should not grow any. But "no accounts" is not
// "no identity": a presence id is a *public address* — /api/poll returns every
// online id so a dot can be tapped — so on its own it proves nothing. Without a
// secret, anyone can read another session's mailbox, keep their dot alive
// forever, or delete them.
//
// So each session gets a 256-bit token, issued by the server when the row is
// created. The browser keeps it in memory and presents it on every request. It
// is never sent to another participant, never written to a log, and never
// leaves this process except in a request body/header. Possession of the id *and*
// the token is what makes a request about that id legitimate.

import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32; // 256 bits, base64url-encoded to exactly 43 characters
export const SESSION_TOKEN_LENGTH = 43;

export function issueSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function isSessionToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === SESSION_TOKEN_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * Stable, non-reversible key for a rate-limit subject. The limiter stores these,
 * so a raw session token or client IP never lands in the database.
 */
export function hashSubject(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 24);
}
