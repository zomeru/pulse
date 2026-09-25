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

// Ceiling on one connection, measured from the moment it was accepted. The
// lease is what marks two people busy to the rest of the map, so a lease that
// can be renewed forever is a way to pin a stranger: hold the connection open
// without ever saying anything and their dot stays unavailable to everyone.
// Past this point the lease is no longer renewed and the reaper ends the
// connection like any other expired reservation.
export const MAX_CONNECTION_MS = 60 * 60 * 1000;

// How many signals one recipient may have waiting. Above this the oldest are
// dropped on write, so a flood costs the recipient a page of rows rather than an
// unbounded response or an unbounded table.
export const MAX_MAILBOX_ROWS = 50;

// How many of those rows a single poll returns. Delivery is at-least-once and
// acknowledged, so the rest arrive on the next poll.
export const MAX_INBOX_READ = 50;

// The map is capped so one flood of joins cannot turn every poll into a large
// response for every online user.
export const MAX_PEERS_PER_POLL = 1_000;

// The reaper is a table-wide sweep. Running it on every request meant one poll
// cost a second full sweep, so it is throttled per warm instance. This is a
// cost control, not a security control — nothing depends on it being exact.
export const REAP_MIN_INTERVAL_MS = 2_000;
