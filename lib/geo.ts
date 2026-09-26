// Privacy offset: move a real coordinate 1–3 km in a random direction so the
// dot is placed *near* the user, never at their exact location. A fresh random
// offset is generated each session (this runs once per join), so the same user
// lands somewhere different every time.

const KM_PER_DEG_LAT = 111.32;

export function applyPrivacyOffset(
  lat: number,
  lng: number,
): { lat: number; lng: number } {
  const distanceKm = 1 + Math.random() * 2; // 1–3 km
  const bearing = Math.random() * 2 * Math.PI; // random direction

  const dLat = (distanceKm * Math.cos(bearing)) / KM_PER_DEG_LAT;
  const latRad = (lat * Math.PI) / 180;
  const dLng =
    (distanceKm * Math.sin(bearing)) /
    (KM_PER_DEG_LAT * Math.cos(latRad) || KM_PER_DEG_LAT);

  return {
    lat: clamp(lat + dLat, -90, 90),
    lng: wrapLng(lng + dLng),
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function wrapLng(lng: number): number {
  // Keep longitude in [-180, 180].
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Great-circle distance between two points, in kilometres.
 *
 * Phase 4 uses this to tell someone how far away the stranger who waved at them
 * is, and the number is computed **in the browser, from coordinates the browser
 * already has** — the two offset dots from the poll response. It is never sent to
 * the server and it never leaves the machine, so it is not a new disclosure
 * channel: the receiver could have measured it themselves.
 *
 * It is also only an estimate. Both points are already 1–3 km from the person
 * behind them, so two dots that are genuinely far apart are accurate to a few
 * kilometres and two dots that are genuinely near each other are not meaningful
 * at all. The UI says "about" for exactly that reason, and never resolves below
 * a kilometre, where pretending to precision would be the misleading part.
 */
const EARTH_RADIUS_KM = 6371;

export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = Math.PI / 180;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const dLat = lat2 - lat1;
  // Shortest way round: two dots either side of the antimeridian are close, not
  // most of the way apart.
  const dLng = (((b.lng - a.lng + 540) % 360) - 180) * toRad;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A distance to put in front of a person. Rounds to a step that matches the
 * uncertainty, and never below a kilometre: the two dots are each up to 3 km
 * from the stranger behind them, so "380 m" would be a number we cannot stand
 * behind.
 */
export function formatKm(km: number): string {
  const step = km < 100 ? 1 : km < 10_000 ? 10 : 100;
  const rounded = Math.max(step, Math.round(km / step) * step);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

