"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { useEscapeKey } from "@/app/hooks/useEscapeKey";
import { LockIcon } from "./Icon";

/**
 * The one decision the user has to make mid-session: someone wants to talk.
 *
 * Phase 1 covered the screen with a scrim and a centred card, which felt like
 * a modal interrupting the map. This is a bottom-anchored card instead: the
 * map stays visible behind it (you can see the light that is calling), it
 * never blocks the map itself, and it can be dismissed with Escape or by
 * simply ignoring it. Focus moves to Accept so the keyboard path is obvious.
 */
export default function ConnectionPrompt({
  title,
  subtitle,
  detail,
  acceptLabel,
  declineLabel,
  tone = "signal",
  onAccept,
  onDecline,
}: {
  title: string;
  subtitle?: string;
  detail?: string;
  acceptLabel: string;
  declineLabel: string;
  tone?: "signal" | "self" | "alert";
  onAccept: () => void;
  onDecline: () => void;
}) {
  const acceptRef = useRef<HTMLButtonElement>(null);
  const toneVar =
    tone === "alert"
      ? "var(--color-alert)"
      : tone === "self"
        ? "var(--color-self)"
        : "var(--color-signal)";

  useEffect(() => {
    acceptRef.current?.focus();
  }, []);

  useEscapeKey(true, onDecline);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[calc(1rem+var(--safe-b))] sm:px-5 sm:pb-8"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="pulse-prompt-title"
        aria-describedby={subtitle || detail ? "pulse-prompt-body" : undefined}
        className="pulse-glass-strong pulse-enter pointer-events-auto w-full max-w-sm rounded-3xl p-4 sm:p-5"
      >
        <div className="flex items-start gap-3.5">
          <span
            className="pulse-orbit mt-0.5 shrink-0"
            aria-hidden="true"
            style={{ ["--tone" as string]: toneVar }}
          />

          <div className="min-w-0 flex-1">
            <h2
              id="pulse-prompt-title"
              className="text-[0.9375rem] font-medium leading-snug text-ink"
            >
              {title}
            </h2>
            <div id="pulse-prompt-body" className="mt-1 space-y-1">
              {subtitle && (
                <p className="text-[0.8125rem] leading-relaxed text-ink-soft">
                  {subtitle}
                </p>
              )}
              {detail && (
                <p className="pulse-hint flex items-start gap-1.5">
                  <LockIcon className="mt-px h-3 w-3 shrink-0" />
                  <span>{detail}</span>
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onDecline}
            className={cn(
              "min-h-11 flex-1 rounded-2xl border border-hairline px-4 text-sm font-medium",
              "text-ink-soft transition-colors hover:border-ink-faint hover:text-ink",
            )}
          >
            {declineLabel}
          </button>
          <button
            type="button"
            ref={acceptRef}
            onClick={onAccept}
            className={cn(
              "min-h-11 flex-[1.35] rounded-2xl px-4 text-sm font-semibold",
              "bg-signal text-void transition-[background-color,transform] hover:bg-[#7bf7d6] active:scale-[0.98]",
            )}
          >
            {acceptLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
