"use client";

import { useEffect, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Map as MapboxMap, Marker } from "mapbox-gl";
import type { PeerDot } from "@/lib/types";
import { peerColor, peerPhase, waveColor } from "@/lib/presence-colors";
import { restyleMap, setPaint } from "@/app/lib/map-style";

const TOKEN =
  process.env.NEXT_PUBLIC_MAPBOX_TOKEN ??
  "pk.eyJ1IjoicHVsc2UtbWFwIiwiYSI6ImNrMDBkZW1vMDAwMDAwMDAifQ.AAAAAAAAAAAAAAAAAAAAAA";

const LINK_SOURCE = "pulse-link";
const WAVE_SOURCE = "pulse-wave";
/** How long to wait for the map to have a real box before giving up. */
const LAYOUT_FRAMES = 30;
/** Never hold the splash screen longer than this, even if a tile is slow. */
const READY_FALLBACK_MS = 8_000;
/** How long the light takes to cross from one dot to the other. */
const WAVE_TRAVEL_MS = 1150;
/** How far the arc bows off the straight line, as a fraction of its own length
 *  and a hard cap in degrees. A dead-straight line reads as a wire; a curve
 *  reads as something travelling. */
const WAVE_BOW_RATIO = 0.16;
const WAVE_BOW_MAX = 18;

type MarkerState =
  | "idle"
  | "busy"
  | "target"
  | "linked"
  | "waving"
  | "mutual";

/** What the map needs to know about waves. Deliberately not the whole state
 *  machine: the map draws threads, the app decides whether they are real. */
export interface WaveView {
  /** The wave tool is armed — a tap on a dot waves instead of connecting. */
  armed: boolean;
  /** The stranger a thread runs to, and whether it has been answered. */
  link: { peerId: string; mutual: boolean } | null;
  /** Strangers waiting to be waved back. */
  incoming: string[];
}

type PeerEntry = {
  marker: Marker;
  element: HTMLButtonElement;
  /** `""` until the first reconcile, so the initial state always writes. */
  state: MarkerState | "";
  armed: boolean;
  label: HTMLSpanElement;
};

const EMPTY_LINE = {
  type: "FeatureCollection" as const,
  features: [],
};

/** Same crosshair as the React icon, in raw SVG for the imperative control. */
const crosshairSvg =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="7.2"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
  '<path d="M12 1.8v3.2M12 19v3.2M22.2 12H19M5 12H1.8"/></svg>';

const waveSvg =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2.4 12a9.6 9.6 0 0 1 19.2 0"/>' +
  '<path d="M5.8 12a6.2 6.2 0 0 1 12.4 0"/>' +
  '<path d="M9.2 12a2.8 2.8 0 0 1 5.6 0"/></svg>';

function peerLabel(
  state: MarkerState,
  canConnect: boolean,
  armed: boolean,
  incoming: boolean,
): string {
  if (state === "busy") return "In a conversation";
  if (state === "target" || state === "linked") return "Your connection";
  if (state === "mutual") return "You both waved";
  if (state === "waving") {
    return incoming ? "Waved at you" : "Wave sent · no answer needed";
  }
  if (armed && canConnect) return "Tap to wave";
  return canConnect ? "Tap to connect" : "Unavailable";
}

/**
 * A "find me" control that lives in Mapbox's own control stack, so the map
 * controls can never drift out of alignment with each other.
 *
 * `mapboxgl-ctrl` is not cosmetic here: Mapbox's corner containers are
 * `pointer-events: none` and only `map.addControl`'s *built-in* controls add
 * that class themselves, so a custom control without it is invisible to the
 * pointer and every click lands on the canvas instead. It also brings the
 * `float: left; clear: both` that stacks the controls vertically.
 */
class RecenterControl {
  private readonly onRecenter: () => void;
  private readonly button: HTMLButtonElement;

  constructor(onRecenter: () => void) {
    this.onRecenter = onRecenter;
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "pulse-recenter mapboxgl-ctrl";
    this.button.setAttribute("aria-label", "Find my position on the map");
    this.button.title = "Find me";
    this.button.innerHTML = crosshairSvg;
    this.button.addEventListener("click", () => this.onRecenter());
  }

  onAdd(): HTMLElement {
    return this.button;
  }

  onRemove(): void {
    this.button.remove();
  }
}

/**
 * The wave tool, in the same control stack.
 *
 * It is a real `aria-pressed` toggle, so the mode is reachable from the
 * keyboard and announced, and the badge is how a wave that arrived while you were
 * mid-conversation gets to you afterwards: it is held rather than shown (the chat
 * owns the screen), and this is where it waits without interrupting anything.
 */
class WaveControl {
  private readonly button: HTMLButtonElement;
  private readonly badge: HTMLSpanElement;
  private readonly onToggle: () => void;

  constructor(onToggle: () => void) {
    this.onToggle = onToggle;
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "pulse-recenter pulse-wave-control mapboxgl-ctrl";
    this.button.setAttribute("aria-pressed", "false");
    this.button.setAttribute("aria-label", "Wave instead of connecting");
    this.button.title = "Wave instead of connecting";

    this.badge = document.createElement("span");
    this.badge.className = "pulse-wave-control__badge";
    this.badge.hidden = true;
    this.badge.setAttribute("aria-hidden", "true");

    this.button.innerHTML = waveSvg;
    this.button.appendChild(this.badge);
    this.button.addEventListener("click", () => this.onToggle());
  }

  onAdd(): HTMLElement {
    return this.button;
  }

  onRemove(): void {
    this.button.remove();
  }

  set(armed: boolean, waiting: number): void {
    this.button.setAttribute("aria-pressed", String(armed));
    this.button.classList.toggle("is-armed", armed);
    this.button.classList.toggle("has-waiting", waiting > 0);
    const label = armed
      ? "Stop waving"
      : waiting > 0
        ? `Wave instead of connecting. ${waiting} ${waiting === 1 ? "stranger has" : "strangers have"} waved at you.`
        : "Wave instead of connecting";
    this.button.setAttribute("aria-label", label);
    this.button.title = label;
    this.badge.hidden = waiting === 0;
    this.badge.textContent = waiting > 1 ? String(waiting) : "";
  }
}

/**
 * The path a wave takes: a three-point arc bowed off the straight line between
 * the two dots.
 *
 * The longitudes are normalised first, which matters more than the bow. Two
 * lights either side of the antimeridian are close together, and a LineString
 * from -179 to +179 draws the long way round — a wave would cross the entire
 * planet to reach the person standing next to it.
 */
function waveArc(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): [number, number][] {
  let deltaLng = to.lng - from.lng;
  if (deltaLng > 180) deltaLng -= 360;
  if (deltaLng < -180) deltaLng += 360;
  const endLng = from.lng + deltaLng;

  const deltaLat = to.lat - from.lat;
  const span = Math.hypot(deltaLng, deltaLat);
  if (span < 1e-6) {
    return [
      [from.lng, from.lat],
      [endLng, to.lat],
    ];
  }

  const bow = Math.min(span * WAVE_BOW_RATIO, WAVE_BOW_MAX);
  // Perpendicular to the chord, in degree space. The bow is a gesture, not a
  // measurement, so an unprojected one is fine and needs no math.
  const midLng = from.lng + deltaLng / 2 - (deltaLat / span) * bow;
  const midLat = (from.lat + to.lat) / 2 + (deltaLng / span) * bow;

  return [
    [from.lng, from.lat],
    [(((midLng + 180) % 360) + 360) % 360 - 180, midLat],
    [endLng, to.lat],
  ];
}

/**
 * The zoom at which the whole world exactly spans `width` pixels.
 *
 * Without it, a wide viewport can reach Mapbox's low zoom levels where the
 * world is *narrower* than the screen: the map then draws the world flanked
 * by two half-copies, which reads as a map that has drifted off centre. This
 * is derived from the current zoom rather than hardcoding Mapbox's tile size,
 * because the tile size cancels out of the ratio.
 */
function worldFitsZoom(map: MapboxMap, width: number): number {
  const current = map.getZoom();
  const worldNow = 512 * 2 ** current;
  const fits = current + Math.log2(Math.max(width, 1) / worldNow);
  return Math.min(Math.max(fits, -1), 20);
}

export default function WorldMap({
  peers,
  me,
  selfId,
  target,
  wave,
  onPeerClick,
  canConnect,
  onToggleWave,
}: {
  peers: PeerDot[];
  me: { lat: number; lng: number } | null;
  /**
   * Our own session id. Not needed to draw a dot — only to derive the shared wave
   * colour, which both ends must agree on without ever being sent.
   */
  selfId: string;
  /** The peer this session is currently negotiating with, if any. */
  target: { peerId: string; state: "target" | "linked" } | null;
  wave: WaveView;
  onPeerClick: (id: string) => void;
  canConnect: boolean;
  onToggleWave: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const peersRef = useRef(new Map<string, PeerEntry>());
  const selfMarkerRef = useRef<Marker | null>(null);
  const accuracyRef = useRef<Marker | null>(null);
  const linkFrame = useRef<number | null>(null);
  const waveFrame = useRef<number | null>(null);
  const waveControlRef = useRef<WaveControl | null>(null);
  /** Identity of the thread currently drawn, so a re-render (or the 1.5s poll
   *  that changes `peers`) does not restart the sweep that carries the light. */
  const waveDrawn = useRef("");
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Marker handlers are bound once, so the live click handler and connect
  // state have to be read through refs (synced in an effect, never in render).
  const onPeerClickRef = useRef(onPeerClick);
  const canConnectRef = useRef(canConnect);
  const targetRef = useRef(target);
  const meRef = useRef(me);
  const waveRef = useRef(wave);
  useEffect(() => {
    onPeerClickRef.current = onPeerClick;
    canConnectRef.current = canConnect;
    targetRef.current = target;
    meRef.current = me;
    waveRef.current = wave;
  });

  // ---------------------------------------------------------------- map init
  useEffect(() => {
    const container = containerRef.current;
    if (!TOKEN || !container) return;
    let cancelled = false;
    const entries = peersRef.current;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      const gl = (await import("mapbox-gl")).default;
      if (cancelled) return;

      // Mapbox measures its container once, during construction, and only
      // fires `load` after that first frame. The map sits inside a
      // percentage-height chain that is not guaranteed to be laid out on the
      // frame we run on: constructing against a 0px box leaves a canvas 1px
      // tall *and* a map whose `load` never arrives, which reads to the user
      // as a permanently black screen. Wait for a real box first; the window
      // is bounded so a genuinely hidden container cannot wedge the app.
      for (let frame = 0; frame < LAYOUT_FRAMES; frame += 1) {
        if (cancelled || container.clientHeight >= 2) break;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      }
      if (cancelled) return;

      gl.accessToken = TOKEN;
      const map = new gl.Map({
        container,
        style: "mapbox://styles/mapbox/dark-v11",
        // Open on the user when we know where they are, else the whole world.
        center: me ? [me.lng, me.lat] : [0, 18],
        zoom: me ? 3.4 : 1.3,
        // No maxZoom: Mapbox's own ceiling lets you keep going to street
        // level, which is the whole point of a map you are invited to explore.
        minZoom: 1.1,
        attributionControl: false,
        // Rotation is disorienting in a product about place; it is off.
        dragRotate: false,
        pitchWithRotate: false,
        fadeDuration: 120,
      });
      mapRef.current = map;

      // Mapbox sizes its canvas from the container's bounding box exactly once,
      // during construction, and then again only on a *window* resize. Pulse's
      // container is sized by the app shell instead — `100dvh` mirrored from
      // `visualViewport` so the mobile keyboard can shrink it — so if the shell
      // has not been laid out yet Mapbox bakes in a 1px canvas. A 1px canvas
      // never requests a tile, which means `load` never fires, which means the
      // restyle never happens: a permanently black map.
      //
      // Owning the resize is therefore not a workaround, it is the contract.
      let lastWidth = -1;
      let lastHeight = -1;
      const observer = new ResizeObserver((entries) => {
        const box = entries[entries.length - 1]?.contentRect;
        if (!box) return;
        const width = Math.round(box.width);
        const height = Math.round(box.height);
        if (width === lastWidth && height === lastHeight) return;
        lastWidth = width;
        lastHeight = height;
        map.resize();
        // The floor for zoom-out depends on the viewport: a wider screen can
        // reach a lower zoom, so the "whole world" zoom moves with it.
        map.setMinZoom(worldFitsZoom(map, width));
      });
      observer.observe(container);
      resizeObserverRef.current = observer;
      map.setMinZoom(worldFitsZoom(map, container.clientWidth || 800));

      // Attribution lives bottom-left, stacked above the required Mapbox logo,
      // so the chat panel on the right can never sit on top of it. Zoom and
      // recentre go top-left for the same reason: on desktop the conversation
      // owns the right third of the screen. Recentre is added first because
      // Mapbox appends, which puts it above the zoom-in button.
      map.addControl(new gl.AttributionControl({ compact: true }), "bottom-left");
      map.addControl(
        new gl.ScaleControl({ maxWidth: 80, unit: "metric" }),
        "bottom-left",
      );
      map.addControl(
        new RecenterControl(() => {
          const location = meRef.current;
          if (!location) return;
          map.easeTo({
            center: [location.lng, location.lat],
            zoom: Math.max(map.getZoom(), 5.2),
            duration: 900,
          });
        }),
        "top-left",
      );
      // Wave, then zoom, then recentre: Mapbox appends, so this reads as
      // "gesture, then navigation".
      const waveControl = new WaveControl(() => onToggleWave());
      waveControlRef.current = waveControl;
      map.addControl(waveControl, "top-left");
      map.addControl(new gl.NavigationControl({ showCompass: false }), "top-left");

      map.on("error", (event) => {
        // A single tile 404 must not blank the whole planet; only a failure
        // before the style loads counts as "the map did not load".
        if (
          !map.loaded() &&
          /style|glyphs|sprite/i.test(String(event.error?.message))
        ) {
          setFailed(true);
        }
      });

      // Lift the splash as soon as the style exists, and restyle there too.
      // `load` waits for the first fully rendered frame, which a slow tile can
      // hold up indefinitely — and the restyle does not need a rendered frame,
      // only a loaded style. Hanging the whole visual treatment off `load` is
      // how you get an unstyled map with no error to explain it.
      let styled = false;
      const applyStyle = () => {
        if (cancelled || styled) return;
        styled = true;
        restyleMap(map);
        try {
          map.addSource(LINK_SOURCE, {
            type: "geojson",
            data: EMPTY_LINE,
            lineMetrics: true,
          });
          map.addLayer({
            id: `${LINK_SOURCE}-glow`,
            type: "line",
            source: LINK_SOURCE,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "rgba(95, 240, 200, 0.22)",
              "line-width": 10,
              "line-blur": 8,
            },
          });
          map.addLayer({
            id: `${LINK_SOURCE}-core`,
            type: "line",
            source: LINK_SOURCE,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "rgba(150, 255, 226, 0.85)",
              "line-width": 1.4,
              "line-dasharray": [2, 3],
              // The gradient plus `line-progress` below is what makes the
              // signal appear to travel from you to them.
              "line-gradient": [
                "interpolate",
                ["linear"],
                ["line-progress"],
                0,
                "rgba(150, 255, 226, 0)",
                0.35,
                "rgba(150, 255, 226, 0.9)",
                1,
                "rgba(150, 255, 226, 0.15)",
              ],
            },
          });

          // --- waves -------------------------------------------------------
          // A separate source and pair of layers, not a second feature on the
          // link line: a wave and a connection are never both running (asking
          // supersedes waving), and they must never be able to overwrite each
          // other's `line-progress` mid-animation.
          map.addSource(WAVE_SOURCE, {
            type: "geojson",
            data: EMPTY_LINE,
            lineMetrics: true,
          });
          map.addLayer({
            id: `${WAVE_SOURCE}-glow`,
            type: "line",
            source: WAVE_SOURCE,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "rgba(95, 240, 200, 0.2)",
              "line-width": 9,
              "line-blur": 7,
              "line-opacity": 0,
            },
          });
          map.addLayer({
            id: `${WAVE_SOURCE}-core`,
            type: "line",
            source: WAVE_SOURCE,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              // Repainted per-thread from the shared wave colour.
              "line-color": "rgba(150, 255, 226, 0.9)",
              "line-width": 1.6,
              "line-dasharray": [3, 4],
              "line-opacity": 0,
              // The light is a gradient revealed by `line-progress`, not a dot
              // moving along the path: a gradient needs no projection maths, no
              // extra DOM node, and cannot drift out of sync with the camera.
              "line-gradient": [
                "interpolate",
                ["linear"],
                ["line-progress"],
                0,
                "rgba(255, 255, 255, 0)",
                0.3,
                "rgba(255, 255, 255, 0.95)",
                1,
                "rgba(255, 255, 255, 0.1)",
              ],
            },
          });
        } catch {
          // The link line is decoration; a style that rejects it still works.
        }
      };
      map.on("style.load", () => {
        if (cancelled) return;
        applyStyle();
        map.resize();
        setReady(true);
      });

      // A slow tile must never leave someone staring at a splash screen.
      fallbackTimer = setTimeout(() => {
        if (!cancelled) setReady(true);
      }, READY_FALLBACK_MS);

      map.on("load", () => {
        if (cancelled) return;
        applyStyle();
        map.resize();
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        setReady(true);
      });

      // On the zoom-out floor the entire world is on screen at once, so holding
      // the camera over the user buys nothing and costs a lot: the ocean behind
      // you fills half the frame while the continents pile up against one edge.
      // From Asia or the Pacific that reads as a globe sitting off to one side
      // of the screen, and the framing differs depending on where you happen to
      // be. So at the floor we hand the view to the conventional
      // Greenwich-centred world and every reader gets the same picture. Only
      // the longitude moves; latitude is left alone so the view does not jump
      // further than it has to.
      //
      // On `zoomend` only, never `moveend`: this settles the view the moment the
      // floor is reached, and a pan after that is the reader's to make and is
      // never second-guessed. The `lng` guard is also what stops this recursing
      // — the ease lands on 0, so the next `zoomend` returns immediately.
      map.on("zoomend", () => {
        if (cancelled) return;
        if (map.getZoom() > map.getMinZoom() + 0.01) return;
        const { lat, lng } = map.getCenter();
        if (Math.abs(lng) < 0.5) return;
        map.easeTo({ center: [0, lat], duration: 600 });
      });
    })();

    return () => {
      cancelled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (linkFrame.current !== null) {
        window.cancelAnimationFrame(linkFrame.current);
        linkFrame.current = null;
      }
      if (waveFrame.current !== null) {
        window.cancelAnimationFrame(waveFrame.current);
        waveFrame.current = null;
      }
      waveDrawn.current = "";
      waveControlRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      peersRef.current = entries;
      entries.forEach((entry) => entry.marker.remove());
      entries.clear();
      selfMarkerRef.current?.remove();
      selfMarkerRef.current = null;
      accuracyRef.current?.remove();
      accuracyRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
    };
    // `me` is read only for the initial camera; we don't want to re-init.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------- "you are here"
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !me) return;
    let cancelled = false;

    (async () => {
      const gl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      if (!selfMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "pulse-self";
        el.innerHTML =
          '<span class="pulse-self__halo"></span>' +
          '<span class="pulse-self__breath"></span>' +
          '<span class="pulse-self__core"></span>' +
          '<span class="pulse-self__label">You</span>';
        selfMarkerRef.current = new gl.Marker({ element: el, anchor: "center" })
          .setLngLat([me.lng, me.lat])
          .addTo(map);
      } else {
        selfMarkerRef.current.setLngLat([me.lng, me.lat]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [me, ready]);

  // The privacy offset, made visible: a quiet 3 km ring around your real
  // position. It reassures rather than exposes — your light is visibly *near*
  // you, never on top of you.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !me) return;
    let cancelled = false;
    let detach: (() => void) | null = null;

    (async () => {
      const gl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      if (!accuracyRef.current) {
        const el = document.createElement("div");
        el.className = "pulse-accuracy";
        el.setAttribute("aria-hidden", "true");
        accuracyRef.current = new gl.Marker({ element: el, anchor: "center" })
          .setLngLat([me.lng, me.lat])
          .addTo(map);
      }
      const update = () => {
        const el = accuracyRef.current?.getElement();
        if (!el) return;
        const east = 3_000 / (111_320 * Math.cos((me.lat * Math.PI) / 180));
        const p1 = map.project([me.lng, me.lat]);
        const p2 = map.project([me.lng + east, me.lat]);
        const px = Math.abs(p2.x - p1.x);
        el.style.width = `${px}px`;
        el.style.height = `${px}px`;
        // Below this zoom the ring is sub-pixel; showing it would be noise.
        el.style.opacity = map.getZoom() >= 5.2 && px > 8 ? "1" : "0";
      };
      update();
      map.on("move", update);
      map.on("zoom", update);
      detach = () => {
        map.off("move", update);
        map.off("zoom", update);
      };
    })();

    return () => {
      cancelled = true;
      detach?.();
    };
  }, [me, ready]);

  // ------------------------------------------------------------------ markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;

    (async () => {
      const gl = (await import("mapbox-gl")).default;
      if (cancelled) return;
      const entries = peersRef.current;
      const seen = new Set<string>();
      const active = targetRef.current;

      for (const peer of peers) {
        seen.add(peer.id);
        let entry = entries.get(peer.id);
        if (!entry) {
          const el = document.createElement("button");
          el.type = "button";
          el.className = "pulse-marker pulse-marker-host";
          el.style.setProperty("--beacon", peerColor(peer.id));
          el.style.setProperty("--i", String(peerPhase(peer.id)));
          el.innerHTML =
            '<span class="pulse-marker__glow"></span>' +
            '<span class="pulse-marker__ring"></span>' +
            '<span class="pulse-marker__core"></span>' +
            '<span class="pulse-marker__label">Tap to connect</span>';

          // A busy peer is present but not actionable. `aria-disabled` keeps it
          // announced and focusable without implying the click will do
          // anything, which is exactly the "looks tappable but is not" trap.
          el.addEventListener("click", (event) => {
            event.stopPropagation();
            if (el.dataset.state === "idle" && canConnectRef.current) {
              onPeerClickRef.current(peer.id);
            }
          });

          const marker = new gl.Marker({ element: el, anchor: "center" })
            .setLngLat([peer.lng, peer.lat])
            .addTo(map);
          entry = {
            marker,
            element: el,
            label: el.querySelector(".pulse-marker__label") as HTMLSpanElement,
            state: "",
            armed: false,
          };
          entries.set(peer.id, entry);
        }

        entry.marker.setLngLat([peer.lng, peer.lat]);

        // The peer you are negotiating with wins over everything else: while a
        // request is out the server already marks them busy, and rendering a
        // dimmed "unavailable" dot while we are literally asking them to talk
        // would be a lie. A wave thread wins next: it is the only other thing
        // this dot is to us right now.
        const thread = waveRef.current;
        const isLink = thread?.link?.peerId === peer.id;
        // A wave that has arrived and not been answered looks exactly like one
        // that has been sent and not come back: there is a wave between these two
        // dots and no answer is due. Drawing only the sender's side would make
        // the map react for the person who waved and sit still for the person
        // who was waved at, which is the wrong way round — this is the light that
        // just arrived, and the map should be the first place you see it.
        const isWavingIn = !isLink && thread?.incoming.includes(peer.id) === true;
        const state: MarkerState = isLink
          ? thread.link?.mutual
            ? "mutual"
            : "waving"
          : isWavingIn
            ? "waving"
            : active?.peerId === peer.id
              ? active.state
              : !canConnectRef.current || peer.busy
                ? "busy"
                : "idle";

        if (entry.state !== state || entry.armed !== thread?.armed) {
          entry.state = state;
          entry.armed = thread?.armed === true;
          const interactive = state === "idle";
          entry.element.dataset.state = state;
          // The wave colour both ends derive from the same two ids, so the two
          // markers on two screens are the same light. Only meaningful when a
          // thread exists; otherwise the marker keeps its own beacon colour.
          if (isLink || isWavingIn) {
            entry.element.style.setProperty(
              "--wave",
              waveColor(selfId, peer.id),
            );
          }
          entry.element.setAttribute("aria-disabled", String(!interactive));
          entry.element.setAttribute(
            "aria-label",
            interactive
              ? thread?.armed
                ? "Anonymous stranger on the map. Tap to send them a wave."
                : "Anonymous stranger on the map. Tap to request a connection."
              : state === "busy"
                ? "Anonymous stranger already in a conversation"
                : state === "mutual"
                  ? "Stranger who waved back. You can connect."
                  : state === "waving"
                    ? isWavingIn
                      ? "Stranger who waved at you"
                      : "Stranger you waved at. No answer is needed."
                    : "Stranger you are connecting with",
          );
          entry.label.textContent = peerLabel(
            state,
            canConnectRef.current,
            thread?.armed === true,
            isWavingIn,
          );
        }
      }

      // Dots leave when their owner does; the server's TTL makes that prompt.
      for (const [id, entry] of entries) {
        if (seen.has(id)) continue;
        entry.marker.remove();
        entries.delete(id);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [peers, ready, target, wave, selfId]);

  // ------------------------------------------------------------- link + camera
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const source = map.getSource(LINK_SOURCE) as
      | { setData(data: unknown): void }
      | undefined;
    if (!source) return;

    if (linkFrame.current !== null) {
      window.cancelAnimationFrame(linkFrame.current);
      linkFrame.current = null;
    }

    const peer = target
      ? peers.find((candidate) => candidate.id === target.peerId)
      : undefined;
    if (!target || !me || !peer) {
      source.setData(EMPTY_LINE);
      return;
    }

    source.setData({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [me.lng, me.lat],
          [peer.lng, peer.lat],
        ],
      },
    });

    // One short sweep on entry, then it settles into a quiet dashed line.
    if (target.state === "target" && !prefersReducedMotion()) {
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / 1500);
        const eased = 1 - Math.pow(1 - t, 3);
        setPaint(map, `${LINK_SOURCE}-core`, "line-progress", eased);
        setPaint(map, `${LINK_SOURCE}-glow`, "line-progress", eased);
        linkFrame.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      linkFrame.current = requestAnimationFrame(step);
    }
  }, [target, peers, me, ready]);

  // -------------------------------------------------------------------- waves
  //
  // One thread, one arc, one light. The animation is keyed on the *identity* of
  // the thread rather than on this effect's dependencies, because `peers` changes
  // every 1.5 seconds: without that guard the light would restart its journey
  // across the world on every poll.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const source = map.getSource(WAVE_SOURCE) as
      | { setData(data: unknown): void }
      | undefined;
    if (!source) return;

    if (waveFrame.current !== null) {
      window.cancelAnimationFrame(waveFrame.current);
      waveFrame.current = null;
    }

    const link = wave.link;
    const peer = link
      ? peers.find((candidate) => candidate.id === link.peerId)
      : undefined;
    if (!link || !me || !peer) {
      source.setData(EMPTY_LINE);
      waveDrawn.current = "";
      setPaint(map, `${WAVE_SOURCE}-core`, "line-opacity", 0);
      setPaint(map, `${WAVE_SOURCE}-glow`, "line-opacity", 0);
      return;
    }

    const key = `${peer.id}:${link.mutual ? "mutual" : "out"}`;
    if (waveDrawn.current === key) return;
    waveDrawn.current = key;

    source.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: waveArc(me, peer) },
    });

    // One shared colour, and it replaces the app's signal green: this arc is not
    // the app talking, it is a light that belongs to the two people on it.
    const colour = waveColor(selfId, peer.id);
    setPaint(map, `${WAVE_SOURCE}-core`, "line-color", colour);
    setPaint(map, `${WAVE_SOURCE}-glow`, "line-color", colour);
    setPaint(map, `${WAVE_SOURCE}-core`, "line-opacity", 1);
    setPaint(map, `${WAVE_SOURCE}-glow`, "line-opacity", 1);

    // Reduced motion gets the same picture with the light already arrived, which
    // is the honest translation: the information is "a wave is between these two
    // dots", not "something moved".
    if (prefersReducedMotion()) {
      setPaint(map, `${WAVE_SOURCE}-core`, "line-progress", 1);
      setPaint(map, `${WAVE_SOURCE}-glow`, "line-progress", 1);
      if (link.mutual) {
        setPaint(map, `${WAVE_SOURCE}-core`, "line-opacity", 0.6);
        setPaint(map, `${WAVE_SOURCE}-glow`, "line-opacity", 0.35);
      }
      return;
    }

    const mutual = link.mutual;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / WAVE_TRAVEL_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      setPaint(map, `${WAVE_SOURCE}-core`, "line-progress", eased);
      setPaint(map, `${WAVE_SOURCE}-glow`, "line-progress", eased);
      if (t < 1) {
        waveFrame.current = requestAnimationFrame(step);
        return;
      }
      // Arrived. An unanswered wave settles back to a quiet thread rather than
      // staying lit: a wave needs no answer, and a line that keeps asking is a
      // line the map should not draw.
      waveFrame.current = null;
      setPaint(map, `${WAVE_SOURCE}-core`, "line-opacity", mutual ? 0.62 : 0.34);
      setPaint(map, `${WAVE_SOURCE}-glow`, "line-opacity", mutual ? 0.4 : 0.16);
    };
    waveFrame.current = requestAnimationFrame(step);
  }, [wave, peers, me, ready, selfId]);

  // The tool's armed state and its waiting badge. Kept out of the map's init
  // effect so arming costs no re-initialisation and no listener. The container
  // class is how every available dot learns it is waveable.
  //
  // `ready` is in the dependencies because the control is created inside the map
  // init: without it, the first `set` can land before the control exists and be
  // never retried.
  useEffect(() => {
    waveControlRef.current?.set(wave.armed, wave.incoming.length);
    containerRef.current?.classList.toggle("pulse-wave-armed", wave.armed);
  }, [wave, ready]);

  // Frame both ends of a live connection. This is a deliberate camera move on a
  // real state change, not a hijack: without it, accepting a request from
  // across an ocean leaves you staring at empty water.
  const framedRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !me || !target) return;
    if (framedRef.current === target.peerId) return;
    framedRef.current = target.peerId;

    const peer = peers.find((candidate) => candidate.id === target.peerId);
    if (!peer) return;

    const wide = window.matchMedia("(min-width: 768px)").matches;
    map.fitBounds(
      [
        [me.lng, me.lat],
        [peer.lng, peer.lat],
      ],
      {
        // On desktop the chat panel owns the right edge, so the framing has to
        // know about it or both beacons end up underneath the conversation.
        padding: wide
          ? { top: 150, right: 470, bottom: 150, left: 130 }
          : { top: 170, right: 90, bottom: 210, left: 90 },
        // This is a ceiling on the *automatic* framing, not on the user. Set
        // too low it fights the zoom: connect to someone in your own city and
        // the map would slam out to a continent view. 11 keeps both beacons
        // comfortably in frame without ever zooming past a city.
        maxZoom: 11,
        duration: 1600,
        // `essential` stays false so Mapbox honours prefers-reduced-motion.
      },
    );
  }, [target, peers, me, ready]);

  const hasPeers = peers.length > 0;
  const hasAvailable = peers.some((peer) => !peer.busy);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full bg-void" />

      {/* Atmosphere: a vignette and a whisper of grain, so the map reads as
          photographed rather than rendered. */}
      <div className="pulse-vignette pointer-events-none absolute inset-0" />
      <div className="pulse-grain pointer-events-none absolute inset-0" />

      {!ready && !failed && (
        <div className="pulse-enter absolute inset-0 grid place-items-center bg-void">
          <div className="pulse-grid absolute inset-0 opacity-60" />
          <div className="relative flex flex-col items-center gap-4 px-8 text-center">
            <span
              className="pulse-orbit"
              style={{ ["--tone" as string]: "var(--color-signal)" }}
            />
            <p className="pulse-label text-ink-soft">Finding your place</p>
            <p className="max-w-[16rem] text-xs leading-relaxed text-ink-faint">
              Painting the world. You&rsquo;re about to be a light on it.
            </p>
          </div>
        </div>
      )}

      {!TOKEN || failed ? (
        <div className="absolute inset-0 grid place-items-center bg-void px-6">
          <div className="pulse-glass-strong pulse-enter max-w-sm rounded-3xl p-6 text-center">
            <p className="pulse-label text-alert">Map unavailable</p>
            <h2 className="mt-3 text-lg font-medium text-ink">
              Pulse needs a Mapbox token to draw the world
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Set{" "}
              <code className="rounded bg-void/70 px-1 py-0.5 font-mono text-xs text-signal">
                NEXT_PUBLIC_MAPBOX_TOKEN
              </code>{" "}
              in <code className="font-mono text-xs">.env</code> and restart. Chat
              and video still work without it.
            </p>
          </div>
        </div>
      ) : null}

      {/* Empty state — the screen most first-time users will ever see. */}
      {ready && !hasPeers && (
        <MapNote
          title="Nobody else is here yet"
          body="The map fills as people arrive. You’re the first light."
        />
      )}

      {/* Everyone present is busy. Say so, rather than showing a wall of dots
          that look tappable and are not. */}
      {ready && hasPeers && !hasAvailable && !target && (
        <MapNote
          title="Everyone here is talking"
          body="Hold on — a light will free up in a moment."
        />
      )}
    </div>
  );
}

function MapNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="pulse-enter pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4 pb-[calc(2rem+var(--safe-b))] sm:pb-28">
      <div className="pulse-glass-strong max-w-xs rounded-3xl px-5 py-4 text-center">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">{body}</p>
      </div>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
