"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { AlertIcon, LockIcon, SendIcon } from "./Icon";

export default function EntryGate({
  onReady,
}: {
  onReady: (lat: number, lng: number) => void;
}) {
  const [status, setStatus] = useState<"idle" | "locating" | "error">("idle");
  const [error, setError] = useState<string>("");

  function enter() {
    if (!("geolocation" in navigator)) {
      setStatus("error");
      setError(
        "This browser can't share a location, so it can't place you on the map.",
      );
      return;
    }
    setStatus("locating");
    setError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => onReady(pos.coords.latitude, pos.coords.longitude),
      (err) => {
        setStatus("error");
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Pulse needs location access to put you on the map. Enable it in your browser's site settings and try again."
            : "We couldn't get a fix on you. Check that location services are on, then try again.",
        );
      },
      // High accuracy + maximumAge:0 forces a fresh fix (Wi-Fi/GPS scan)
      // instead of reusing the browser's cached IP-based location.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  const locating = status === "locating";

  return (
    <main className="pulse-vignette relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-void px-6 py-10">
      {/* Atmosphere: a slow drift of light behind the type. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-signal/[0.07] blur-[100px]"
      />
      <div className="pulse-grid pointer-events-none absolute inset-0 opacity-25" />

      <div className="pulse-enter relative flex w-full max-w-sm flex-col items-center text-center">
        <GlobeMark />

        <h1 className="mt-7 text-[2.75rem] font-semibold leading-none tracking-[-0.03em] text-ink">
          Pulse
        </h1>

        <p className="mt-3 max-w-[19rem] text-[0.9375rem] leading-relaxed text-ink-soft">
          Everyone here is a light on the world. Tap one, say hello, and find
          out who&rsquo;s out there.
        </p>

        <button
          type="button"
          onClick={enter}
          disabled={locating}
          className={cn(
            "group mt-8 flex h-13 w-full items-center justify-center gap-2.5 rounded-2xl px-6 py-4",
            "bg-signal text-[0.9375rem] font-semibold text-void",
            "shadow-[0_18px_50px_-18px_rgba(95,240,200,0.7)]",
            "transition-all duration-300",
            "hover:bg-[#7bf7d6] active:scale-[0.985]",
            "disabled:cursor-wait disabled:opacity-90",
          )}
        >
          {locating ? (
            <>
              <span
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-void/25 border-t-void"
                aria-hidden="true"
              />
              Finding you…
            </>
          ) : (
            <>
              Enter Pulse
              <SendIcon className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
            </>
          )}
        </button>

        {/* The browser prompt is the one thing that can stall this screen, so
            we say it out loud instead of letting it look like a hang. */}
        {locating && (
          <p
            className="pulse-enter-fast mt-3 text-xs leading-relaxed text-ink-soft"
            role="status"
          >
            Your browser will ask for location access. Pulse uses it once, to
            place your light, then forgets it.
          </p>
        )}

        {status === "error" && (
          <div
            className="pulse-enter-fast mt-4 flex items-start gap-2.5 rounded-2xl border border-alert/25 bg-alert/[0.07] p-3 text-left"
            role="alert"
          >
            <AlertIcon className="mt-px h-4 w-4 shrink-0 text-alert" />
            <p className="text-xs leading-relaxed text-ink-soft">{error}</p>
          </div>
        )}

        <ul className="mt-9 flex flex-col items-center gap-1.5 text-ink-faint">
          <li className="pulse-hint flex items-center gap-1.5">
            <LockIcon className="h-3 w-3 shrink-0" />
            No account. No history. Nothing kept.
          </li>
          <li className="pulse-hint">
            Your light sits 1&ndash;3&nbsp;km from where you are, never on top of
            it.
          </li>
          <li className="pulse-hint">Closing the tab takes you off the map.</li>
        </ul>
      </div>
    </main>
  );
}

/**
 * The product in one image: a wire globe with three people on it. Cheaper and
 * faster to read than a paragraph, and it sets the "living world" tone before
 * the user has granted anything.
 */
function GlobeMark() {
  return (
    <svg
      viewBox="0 0 240 132"
      className="h-[7.5rem] w-[13.5rem] overflow-visible"
      role="img"
      aria-label="A wire globe with three anonymous people as points of light"
    >
      <g
        fill="none"
        stroke="currentColor"
        className="text-ink-faint"
        strokeWidth="0.75"
        opacity="0.4"
      >
        <ellipse cx="120" cy="66" rx="104" ry="60" />
        <ellipse cx="120" cy="66" rx="104" ry="34" />
        <ellipse cx="120" cy="66" rx="66" ry="60" />
        <ellipse cx="120" cy="66" rx="30" ry="60" />
        <path d="M16 66h208" />
      </g>

      <g className="pulse-marker-scale">
        {/* you */}
        <circle cx="120" cy="66" r="17" fill="rgba(211,231,255,0.10)" />
        <circle cx="120" cy="66" r="3.5" fill="#d3e7ff" />

        {/* strangers */}
        <circle cx="58" cy="46" r="13" fill="rgba(95,240,200,0.10)" />
        <circle cx="58" cy="46" r="2.75" fill="#5ff0c8" className="pulse-glint" />

        <circle cx="184" cy="84" r="13" fill="rgba(195,164,255,0.10)" />
        <circle cx="184" cy="84" r="2.75" fill="#c3a4ff" className="pulse-glint-alt" />

        <circle cx="150" cy="30" r="11" fill="rgba(255,158,199,0.10)" />
        <circle cx="150" cy="30" r="2.25" fill="#ff9ec7" className="pulse-glint-slow" />
      </g>
    </svg>
  );
}
