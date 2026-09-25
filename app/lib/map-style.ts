import type { Map as MapboxMap } from "mapbox-gl";

/**
 * Phase 2 map treatment.
 *
 * Two facts about `dark-v11` shape this file, and both are counter-intuitive
 * enough to be worth writing down:
 *
 *  1. There is no land polygon. The style paints the *background* as land and
 *     then draws water on top of it. So "land vs sea" is a background/fill
 *     relationship, and the coastline you see is the water polygon's outline —
 *     which means the single cheapest way to get a luminous coast is
 *     `fill-outline-color` on the water layer.
 *  2. The default style labels every city, road and point of interest. Those
 *     labels are what make a basemap feel like a product demo, and they fight
 *     the dots for attention. We keep only country and continent names.
 *
 * Everything is applied defensively: Mapbox reshuffles layer ids between style
 * versions, and a restyle that throws must never take the map down with it.
 */

/**
 * Land is lit, sea is not. The ramp is narrow but must stay legible — land has
 * to read as a different substance from water at a glance, and labels need
 * enough contrast to survive the vignette that sits on top of them.
 */
const INK = {
  land: "#111b2d",
  sea: "#050a14",
  coast: "rgba(125, 216, 230, 0.55)",
  coastFar: "rgba(125, 216, 230, 0.26)",
  waterway: "rgba(125, 216, 230, 0.2)",
  road: "rgba(150, 190, 235, 0.15)",
  admin: "rgba(150, 190, 235, 0.22)",
  label: "rgba(208, 228, 248, 0.6)",
  labelMinor: "rgba(176, 200, 228, 0.38)",
} as const;

type LayerSpec = {
  id: string;
  type: string;
  sourceLayer?: string;
};

/**
 * `setPaintProperty` / `setLayoutProperty` are typed against closed unions of
 * Mapbox paint keys, which is unhelpful when every property is discovered at
 * runtime — hence the casts.
 */
export function setPaint(
  map: MapboxMap,
  layerId: string,
  property: string,
  value: unknown,
): void {
  try {
    (
      map.setPaintProperty as unknown as (
        layerId: string,
        property: string,
        value: unknown,
      ) => unknown
    )(layerId, property, value);
  } catch {
    // Layer or property missing in this style version — skip silently.
  }
}

function hide(map: MapboxMap, layerId: string): void {
  try {
    (
      map.setLayoutProperty as unknown as (
        layerId: string,
        property: string,
        value: unknown,
      ) => unknown
    )(layerId, "visibility", "none");
  } catch {
    // As above.
  }
}

export function restyleMap(map: MapboxMap): void {
  // `getStyle()` hands back live paint/layout objects. Writing to the style
  // while iterating that array mutates the collection mid-loop, which leaves the
  // map with half-written declarations. Snapshot the descriptors first.
  const layers: LayerSpec[] = (map.getStyle().layers ?? []).map((layer) => ({
    id: layer.id,
    type: layer.type,
    sourceLayer: (layer as { "source-layer"?: string })["source-layer"],
  }));

  for (const { id, type } of layers) {
    // The continent itself.
    if (type === "background") {
      setPaint(map, id, "background-color", INK.land);
      continue;
    }

    // Ocean and lakes. The outline of this polygon *is* the coastline.
    if (type === "fill" && id === "water") {
      setPaint(map, id, "fill-color", INK.sea);
      setPaint(map, id, "fill-outline-color", INK.coast);
      continue;
    }

    // Rivers and streams.
    if (type === "line" && id === "waterway") {
      setPaint(map, id, "line-color", INK.waterway);
      continue;
    }

    // Built and zoned land (park, industrial, residential, buildings,
    // runways, structures) is noise at every zoom Pulse cares about.
    if (
      type === "fill" &&
      (id === "landuse" ||
        id === "national-park" ||
        id === "building" ||
        id === "land-structure-polygon" ||
        id === "aeroway-polygon")
    ) {
      hide(map, id);
      continue;
    }

    if (type === "line" && (id === "land-structure-line" || id === "aeroway-line")) {
      hide(map, id);
      continue;
    }

    // Roads: present when you zoom in, never loud enough to compete.
    if (type === "line" && /^(road|tunnel|bridge)-/.test(id)) {
      setPaint(map, id, "line-color", INK.road);
      continue;
    }

    // Country borders stay — they are how you know which continent you are
    // looking at — but the wide "casing" pass behind them does not.
    if (type === "line" && id.startsWith("admin-")) {
      if (id.endsWith("-bg")) hide(map, id);
      else setPaint(map, id, "line-color", INK.admin);
      continue;
    }

    if (type === "symbol") {
      // Place names are what makes dark-v11 feel like a product demo. Keep
      // only the ones that orient you on a planet.
      if (id !== "country-label" && id !== "continent-label") {
        hide(map, id);
        continue;
      }

      setPaint(map, id, "text-color", INK.label);
      setPaint(map, id, "text-halo-color", INK.sea);
      setPaint(map, id, "text-halo-width", 1.3);
      setPaint(map, id, "text-letter-spacing", 0.18);
      setPaint(map, id, "text-transform", "uppercase");
      continue;
    }
  }
}
