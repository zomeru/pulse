"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a media query through `useSyncExternalStore`, so the value is
 * read during render instead of being pushed in by an effect (which would
 * cost an extra render on every mount and can flash the wrong layout).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
