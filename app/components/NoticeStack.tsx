"use client";

import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { AlertIcon, CheckIcon, CloseIcon } from "./Icon";

export type Notice = { id: number; text: string; tone: "info" | "error" };

/**
 * One live region for the whole app. Session outcomes ("Stranger left.",
 * "No answer.") are the only way the user learns something went wrong, so they
 * get a real toast: announced politely, dismissible, and long enough to read.
 */
export default function NoticeStack({
  notices,
  onDismiss,
}: {
  notices: Notice[];
  onDismiss: (id: number) => void;
}) {
  if (notices.length === 0) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 z-50 flex flex-col items-center gap-2",
        "px-3 pt-[calc(var(--topbar-h)+2.2rem)]",
      )}
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {notices.map((notice) => (
        <Toast key={notice.id} notice={notice} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(notice.id), 4600);
    return () => window.clearTimeout(timer);
  }, [notice.id, onDismiss]);

  const isError = notice.tone === "error";

  return (
    <div
      className={cn(
        "pulse-glass-strong animate-toast-in pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-2.5",
        "rounded-2xl py-2.5 pl-3.5 pr-2.5",
        isError && "border-alert/25",
      )}
    >
      <span
        className={cn(
          "grid h-5 w-5 shrink-0 place-items-center rounded-full",
          isError
            ? "bg-alert/15 text-alert"
            : "bg-signal/15 text-signal",
        )}
        aria-hidden="true"
      >
        {isError ? (
          <AlertIcon className="h-3.5 w-3.5" />
        ) : (
          <CheckIcon className="h-3.5 w-3.5" />
        )}
      </span>
      <p className="text-[0.8125rem] leading-snug text-ink">{notice.text}</p>
      <button
        type="button"
        onClick={() => onDismiss(notice.id)}
        className="ml-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:text-ink"
        aria-label="Dismiss notification"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
