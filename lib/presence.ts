// How long a presence row survives without a heartbeat (poll). After this the
// dot is treated as offline and removed — implements "dot disappears when the
// user leaves" even if their tab closed without a clean leave.
export const STALE_MS = 15_000;

// Signals are retained for at-least-once delivery and cleaned up after this.
export const SIGNAL_TTL_MS = 60_000;

// A requested/negotiating connection gets a bounded server lease. A client
// renews this only after the data channel is connected, so a lost offer or a
// stuck negotiation cannot keep both presence rows busy forever.
export const RESERVATION_TTL_MS = 45_000;

// A connected client renews this lease through its poll request. It is longer
// than the presence heartbeat interval so ordinary network jitter is harmless.
export const ACTIVE_LEASE_MS = 30_000;

// Client poll interval. Kept here so client + server reason about the same cadence.
export const POLL_INTERVAL_MS = 1_500;
