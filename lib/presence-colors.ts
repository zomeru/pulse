// Presence colours for strangers.
//
// The first version hashed a session id straight into `hsl(0-360)`, which
// produced muddy olives and harsh pinks next to the map. Pulse needs the map
// to read as one system, so peers draw from a small curated set: similar
// lightness, all high-chroma against deep navy, each one obviously a light
// rather than a pin.
//
// "You" is deliberately NOT in this list — self is ice white, strangers are
// coloured, so the two are never confusable at a glance.

const PEER_COLORS = [
  "#5ff0c8", // aqua
  "#8ab4ff", // azure
  "#c3a4ff", // violet
  "#ff9ec7", // rose
  "#ffd28a", // sand
  "#7ee787", // mint
  "#9ad5ff", // ice
  "#ffa87a", // ember
] as const;

/** FNV-1a — stable, cheap, and spreads UUIDs evenly across the palette. */
function hash(id: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    value ^= id.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

export function peerColor(id: string): string {
  return PEER_COLORS[hash(id) % PEER_COLORS.length];
}

/** Per-peer animation phase, so a crowded map never pulses in lockstep. */
export function peerPhase(id: string): number {
  return hash(id) % 8;
}

/**
 * The colour of a wave, agreed by both ends without ever being agreed *on*.
 *
 * `peerColor` is a function of one id, so two people holding the same two ids
 * can derive the same colour independently — no round trip, no shared state, and
 * nothing stored. Ordering the pair first makes it commutative, which is the
 * whole point: whoever sends the wave and whoever receives it must end up looking
 * at the same light travelling between the same two dots.
 *
 * The pleasant accident: because a peer's colour is stable for the life of their
 * session, a wave is the first time a stranger's colour becomes *yours*. It is
 * the closest thing to recognising a face Pulse can offer, and it costs nothing
 * to revoke — close the tab and the colour is a different one next time.
 */
export function waveColor(a: string, b: string): string {
  return peerColor(a < b ? a : b);
}
