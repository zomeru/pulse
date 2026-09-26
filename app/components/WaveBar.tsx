"use client";

import { cn } from "@/lib/cn";
import { CloseIcon, RippleIcon } from "./Icon";

/**
 * The armed state of the wave tool.
 *
 * A mode with no visible state is a mode nobody trusts, and "waving" is a mode
 * that changes what tapping a dot *means* — so it says so, in the same
 * bottom-anchored instrument voice as the rest of the app, with the cancel in a
 * 44px target where a thumb already is.
 *
 * It also does the teaching. A feature you have to discover is a feature most
 * people never find, and the whole of "what does this button do" fits in one
 * sentence that is only ever on screen while the mode is on.
 *
 * When a wave is already out, the sentence changes to describe the way back:
 * an unanswered thread has to be takeable, or a map can end up showing a
 * conversation that is not going to happen.
 */
export default function WaveBar({
  sent,
  onCancel,
}: {
  sent: boolean;
  onCancel: () => void;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[calc(1rem+var(--safe-b))] sm:px-5 sm:pb-8"
      role="status"
      aria-live="polite"
    >
      <div className="pulse-glass-strong pulse-enter pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-3xl p-3.5 sm:gap-3.5 sm:p-4">
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-signal/30 bg-signal/10 text-signal"
          aria-hidden="true"
        >
          <RippleIcon className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="pulse-label text-signal">Waving</p>
          <p className="mt-1 text-[0.8125rem] leading-snug text-ink-soft">
            {sent
              ? "One is out there. Tap another light, or take it back."
              : "Tap any light to send one wave. No answer needed, and nothing is saved."}
          </p>
        </div>

        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "flex h-11 shrink-0 items-center gap-1.5 rounded-2xl border px-3.5 text-sm font-medium",
            "transition-colors hover:border-ink-faint hover:text-ink",
            sent
              ? "border-signal/40 bg-signal/10 text-signal"
              : "border-hairline text-ink-soft",
          )}
        >
          <CloseIcon className="h-4 w-4" />
          {sent ? "Undo" : "Stop"}
        </button>
      </div>
    </div>
  );
}
