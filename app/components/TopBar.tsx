"use client";

import { LockIcon, WaveIcon } from "./Icon";
import { cn } from "@/lib/cn";

/**
 * The connection flow, compressed into four words. Phase 2 has a lot of
 * transient states (idle → requesting → incoming → connecting → connected →
 * video) and showing each one as its own floating panel is how you end up
 * with a UI nobody can read. Instead the top bar carries one status readout
 * and every overlay below is a *response* to it.
 */
export type FlowStage = "explore" | "request" | "link" | "talk";

const STAGES: Array<{ key: FlowStage; label: string; hint: string }> = [
  {
    key: "explore",
    label: "Exploring",
    hint: "Everyone here is a stranger. Tap any light to say hello.",
  },
  {
    key: "request",
    label: "Reaching out",
    hint: "Waiting for a stranger to answer your request.",
  },
  {
    key: "link",
    label: "Linking",
    hint: "Setting up a direct line between the two of you.",
  },
  {
    key: "talk",
    label: "Talking",
    hint: "Connected. Text and video travel peer to peer.",
  },
];

/**
 * The one step whose wording depends on which side of it you are on. Telling
 * someone who is *receiving* a request that they are "waiting for a stranger
 * to answer" is the kind of small lie that makes a flow feel broken.
 */
const INCOMING = {
  label: "Wants to talk",
  hint: "A stranger is asking to connect. You can say no.",
};

export function stageIndex(stage: FlowStage): number {
  return STAGES.findIndex((entry) => entry.key === stage);
}

export default function TopBar({
  stage,
  incoming,
  online,
  sync,
  compact,
}: {
  stage: FlowStage;
  /** True when this client is the one being asked to connect. */
  incoming: boolean;
  online: number;
  sync: "live" | "reconnecting";
  compact: boolean;
}) {
  const current = stageIndex(stage);
  const copy =
    current === 1 && incoming
      ? { ...STAGES[current], ...INCOMING }
      : STAGES[current];

  return (
    <header
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-30 select-none",
        "px-3 pt-[max(0.75rem,var(--safe-t))] sm:px-5",
      )}
    >
      <div
        className={cn(
          "pulse-glass pointer-events-auto mx-auto flex max-w-[70rem] items-center gap-3 rounded-2xl",
          "px-3 py-2.5 sm:px-4",
          sync === "reconnecting" && "border-alert/30",
        )}
      >
        {/* Wordmark */}
        <div className="flex shrink-0 items-center gap-2">
          <span className="relative grid h-2.5 w-2.5 place-items-center">
            <span className="pulse-wordmark absolute inset-0 rounded-full bg-signal/25" />
            <span className="h-2 w-2 rounded-full bg-signal shadow-[0_0_10px_1px_rgba(95,240,200,0.75)]" />
          </span>
          <span className="pulse-label text-[0.6875rem] font-medium tracking-[0.34em] text-ink">
            Pulse
          </span>
        </div>

        {/* Status readout. On narrow screens the stage name rides inline and
            the sentence is dropped, so the whole bar stays one short row. */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="hidden h-3 w-px shrink-0 bg-hairline md:block" />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium leading-tight text-ink-soft md:text-[0.8125rem]">
              <span className="text-ink md:hidden">{copy.label}</span>
              <span className="hidden md:inline">
                {copy.label}
                <span className="mx-2 text-ink-faint">·</span>
                {copy.hint}
              </span>
            </p>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-end gap-2 md:flex-none">
          {sync === "reconnecting" && (
            <span
              className="pulse-label flex items-center gap-1.5 rounded-full bg-alert/12 px-2 py-1 text-alert"
              role="status"
            >
              <WaveIcon className="h-3 w-3" />
              Reconnecting
            </span>
          )}

          {!compact && (
            <span
              className="pulse-label hidden items-center gap-1.5 rounded-full border border-hairline-soft px-2.5 py-1.5 text-ink-faint sm:flex"
              title="No accounts, no history, nothing stored"
            >
              <LockIcon className="h-3 w-3" />
              No history
            </span>
          )}

          <span
            className="pulse-label flex items-center gap-1.5 rounded-full border border-hairline-soft px-2.5 py-1.5 text-ink-soft"
            aria-label={`${online} ${online === 1 ? "stranger" : "strangers"} online`}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-signal" />
            </span>
            {online}
          </span>
        </div>
      </div>

      {/* Progress hairline: the flow, in four quiet segments. */}
      <div
        className="mx-auto mt-1.5 flex max-w-[70rem] gap-1"
        aria-hidden="true"
      >
        {STAGES.map((entry, index) => (
          <span
            key={entry.key}
            className={cn(
              "h-px flex-1 rounded-full transition-all duration-500",
              index < current
                ? "bg-signal/70"
                : index === current
                  ? "bg-signal shadow-[0_0_6px_rgba(95,240,200,0.8)]"
                  : "bg-hairline",
            )}
          />
        ))}
      </div>
    </header>
  );
}
