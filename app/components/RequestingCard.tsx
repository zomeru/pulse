"use client";

import { CloseIcon } from "./Icon";
import { useEscapeKey } from "@/app/hooks/useEscapeKey";

/**
 * The waiting state. Phase 1 had a lone pill at the top of the screen with a
 * Cancel button, which read as a browser toast rather than something you are
 * part of. This is anchored where the eye already is (bottom centre, over the
 * map) and it says what is actually happening: your request is out, nobody has
 * answered yet, and you can take it back.
 */
export default function RequestingCard({ onCancel }: { onCancel: () => void }) {
  useEscapeKey(true, onCancel);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[calc(1rem+var(--safe-b))] sm:px-5 sm:pb-8"
      role="status"
      aria-live="polite"
    >
      <div className="pulse-glass-strong pulse-enter pointer-events-auto flex w-full max-w-sm items-center gap-3.5 rounded-3xl p-4 sm:p-5">
        <span
          className="pulse-orbit shrink-0"
          data-busy="true"
          aria-hidden="true"
          style={{
            width: "2.75rem",
            height: "2.75rem",
            ["--tone" as string]: "var(--color-signal)",
          }}
        />

        <div className="min-w-0 flex-1">
          <h2 className="text-[0.9375rem] font-medium leading-snug text-ink">
            Reaching out
          </h2>
          <p className="mt-0.5 text-[0.8125rem] leading-snug text-ink-soft">
            They have about 30 seconds to answer.
          </p>
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-2xl border border-hairline px-3.5 text-sm font-medium text-ink-soft transition-colors hover:border-ink-faint hover:text-ink"
        >
          <CloseIcon className="h-4 w-4" />
          Cancel
        </button>
      </div>
    </div>
  );
}
