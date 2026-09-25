"use client";

import { useEffect, useRef, useState } from "react";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Map as MapboxMap, Marker } from "mapbox-gl";
import type { PeerDot } from "@/lib/types";
import { peerColor, peerPhase } from "@/lib/presence-colors";
import { restyleMap, setPaint } from "@/app/lib/map-style";

const TOKEN =
  process.env.NEXT_PUBLIC_MAPBOX_TOKEN ??
  "pk.eyJ1IjoicHVsc2UtbWFwIiwiYSI6ImNrMDBkZW1vMDAwMDAwMDAifQ.AAAAAAAAAAAAAAAAAAAAAA";

const LINK_SOURCE = "pulse-link";
/** How long to wait for the map to have a real box before giving up. */
const LAYOUT_FRAMES = 30;
/** Never hold the splash screen longer than this, even if a tile is slow. */
const READY_FALLBACK_MS = 8_000;

type MarkerState = "idle" | "busy" | "target" | "linked";

type PeerEntry = {
  marker: Marker;
  element: HTMLButtonElement;
  /** `""` until the first reconcile, so the initial state always writes. */
  state: MarkerState | "";
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

function peerLabel(state: MarkerState, canConnect: boolean): string {
  if (state === "busy") return "In a conversation";
  if (state === "target" || state === "linked") return "Your connection";
  return canConnect ? "Tap to connect" : "Unavailable";
}

/**
 * A "find me" control that lives in Mapbox's own control stack. Living inside
 * the stack (instead of an absolutely-positioned button of our own) means the
 * map controls can never drift out of alignment with each other, and a single
 * CSS offset in globals.css moves the whole group below the top bar.
 */
class RecenterControl {
  private readonly onRecenter: () => void;
  private readonly button: HTMLButtonElement;

  constructor(onRecenter: () => void) {
    this.onRecenter = onRecenter;
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "pulse-recenter";
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

export default function WorldMap({
  peers,
  me,
  target,
  onPeerClick,
  canConnect,
}: {
  peers: PeerDot[];
  me: { lat: number; lng: number } | null;
  /** The peer this session is currently negotiating with, if any. */
  target: { peerId: string; state: "target" | "linked" } | null;
  onPeerClick: (id: string) => void;
  canConnect: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const peersRef = useRef(new Map<string, PeerEntry>());
  const selfMarkerRef = useRef<Marker | null>(null);
  const accuracyRef = useRef<Marker | null>(null);
  const linkFrame = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // Marker handlers are bound once, so the live click handler and connect
  // state have to be read through refs (synced in an effect, never in render).
  const onPeerClickRef = useRef(onPeerClick);
  const canConnectRef = useRef(canConnect);
  const targetRef = useRef(target);
  const meRef = useRef(me);
  useEffect(() => {
    onPeerClickRef.current = onPeerClick;
    canConnectRef.current = canConnect;
    targetRef.current = target;
    meRef.current = me;
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
        // minZoom stays just above 0 so the world is not drawn three times
        // side by side.
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
      });
      observer.observe(container);
      resizeObserverRef.current = observer;

      // Attribution lives bottom-left, stacked above the required Mapbox logo,
      // so the chat panel on the right can never sit on top of it. The zoom and
      // recentre controls go top-left for the same reason: on desktop the
      // conversation owns the right third of the screen.
      map.addControl(new gl.AttributionControl({ compact: true }), "bottom-left");
      map.addControl(new gl.NavigationControl({ showCompass: false }), "top-left");
      map.addControl(
        new gl.ScaleControl({ maxWidth: 80, unit: "metric" }),
        "bottom-left",
      );
      // Recentre joins the native stack rather than floating on its own, so
      // there is exactly one place the map's controls live.
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
    })();

    return () => {
      cancelled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (linkFrame.current !== null) {
        window.cancelAnimationFrame(linkFrame.current);
        linkFrame.current = null;
      }
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
          };
          entries.set(peer.id, entry);
        }

        entry.marker.setLngLat([peer.lng, peer.lat]);

        // The peer you are negotiating with wins over everything else: while a
        // request is out the server already marks them busy, and rendering a
        // dimmed "unavailable" dot while we are literally asking them to talk
        // would be a lie.
        const state: MarkerState =
          active?.peerId === peer.id
            ? active.state
            : !canConnectRef.current || peer.busy
              ? "busy"
              : "idle";

        if (entry.state !== state) {
          entry.element.dataset.state = state;
          entry.state = state;
          const interactive = state === "idle";
          entry.element.setAttribute("aria-disabled", String(!interactive));
          entry.element.setAttribute(
            "aria-label",
            interactive
              ? "Anonymous stranger on the map. Tap to request a connection."
              : state === "busy"
                ? "Anonymous stranger already in a conversation"
                : "Stranger you are connecting with",
          );
          entry.label.textContent = peerLabel(state, canConnectRef.current);
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
  }, [peers, ready, target]);

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
