"use client";

import { useEffect } from "react";

/**
 * Mobile Safari (and Chrome Android) do not shrink the *layout* viewport when
 * the on-screen keyboard opens, so a `100dvh` composer ends up underneath the
 * keyboard and the message list gets no room. `visualViewport` does report the
 * shrunken height, so we mirror it into `--app-vh` and let the shell size
 * itself from that.
 *
 * Only writes when the value actually changes, and uses passive listeners so
 * it can never interfere with scroll or typing.
 */
export function useVisualViewportVar(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    let frame = 0;
    let last = -1;

    const sync = () => {
      frame = 0;
      const next = Math.round(viewport.height);
      if (next === last) return;
      last = next;
      document.documentElement.style.setProperty("--app-vh", `${next}px`);
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(sync);
    };

    sync();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
    };
  }, []);
}
