"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { useEscapeKey } from "@/app/hooks/useEscapeKey";
import {
  ChevronDownIcon,
  LockIcon,
  PhoneOffIcon,
  SendIcon,
  VideoIcon,
} from "./Icon";

export interface ChatMessage {
  id: number;
  mine: boolean;
  text: string;
  at: number;
}

const MAX_LENGTH = 2000;
const NEAR_BOTTOM_PX = 90;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ChatPanel({
  messages,
  connected,
  videoRequested,
  peerTyping,
  compact,
  onSend,
  onTyping,
  onStartVideo,
  onCancelVideo,
  onEnd,
}: {
  messages: ChatMessage[];
  connected: boolean;
  videoRequested: boolean;
  peerTyping: boolean;
  compact: boolean;
  onSend: (text: string) => boolean;
  onTyping: () => void;
  onStartVideo: () => void;
  onCancelVideo: () => void;
  onEnd: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true);
  const lastTypingSent = useRef(0);

  // Autoscroll only when the reader is already at the bottom, so scrolling back
  // through the conversation is never yanked away by an incoming message.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !pinnedRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [messages, peerTyping]);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    pinnedRef.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
      NEAR_BOTTOM_PX;
  }, []);

  // Focus the composer as soon as the channel is live — the single most
  // common next action after a connection is established.
  useEffect(() => {
    if (connected && !compact) inputRef.current?.focus();
  }, [connected, compact]);

  useEscapeKey(connected && compact, () => setCollapsed(true));

  function grow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }

  function submit() {
    const text = draft.trim();
    if (!text || !connected) return;
    if (onSend(text)) setDraft("");
    requestAnimationFrame(grow);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // `isComposing` keeps IME input (Japanese, Chinese, Korean) from being
    // swallowed as a send.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  }

  function onChange(value: string) {
    setDraft(value);
    const now = Date.now();
    if (value && now - lastTypingSent.current > 1600) {
      lastTypingSent.current = now;
      onTyping();
    }
  }

  const peek = compact && collapsed;

  return (
    <div className="absolute inset-x-0 bottom-0 top-[var(--topbar-h)] z-20 overflow-hidden sm:left-auto sm:w-[26rem] sm:overflow-visible">
      {/* Full conversation. Opaque on phones — a full-width translucent panel
          over the map makes both unreadable — glass once it is a side rail. */}
      <section
        aria-label="Conversation with a stranger"
        aria-hidden={peek}
        className={cn(
          "flex h-full w-full flex-col border-0 bg-[#060a13]",
          "transition-transform duration-[450ms]",
          "sm:pulse-glass sm:border-l sm:rounded-bl-3xl",
          peek
            ? "pointer-events-none -translate-y-2 opacity-0"
            : "translate-y-0 opacity-100",
        )}
        style={{ transitionTimingFunction: "var(--ease-out-expo)" }}
      >
        {/* Header */}
        <header className="flex items-center gap-3 px-4 pb-3 pt-3.5">
          <span
            className="pulse-orbit shrink-0"
            data-busy={connected ? "false" : "true"}
            aria-hidden="true"
            style={{
              width: "2.5rem",
              height: "2.5rem",
              ["--tone" as string]: connected
                ? "var(--color-signal)"
                : "var(--color-ink-faint)",
            }}
          />

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium leading-tight text-ink">
              Stranger
            </h2>
            <p className="truncate text-xs leading-tight text-ink-faint">
              {connected ? "Connected · peer-to-peer" : "Linking up…"}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {compact && (
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                className="grid h-11 w-11 place-items-center rounded-2xl border border-hairline text-ink-soft transition-colors hover:border-ink-faint hover:text-ink"
                aria-label="Peek at the map"
                title="Peek at the map"
              >
                <ChevronDownIcon className="h-5 w-5" />
              </button>
            )}
            <button
              type="button"
              onClick={onStartVideo}
              disabled={!connected || videoRequested}
              className={cn(
                "grid h-11 w-11 place-items-center rounded-2xl border transition-all",
                videoRequested
                  ? "border-signal/40 bg-signal/10 text-signal"
                  : "border-hairline text-ink-soft hover:border-ink-faint hover:text-ink",
                (!connected || videoRequested) && "opacity-40",
              )}
              aria-label="Start a video call"
              title={videoRequested ? "Video requested" : "Start video call"}
            >
              <VideoIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={onEnd}
              className="grid h-11 w-11 place-items-center rounded-2xl border border-alert/25 text-alert transition-colors hover:border-alert/50 hover:bg-alert/10"
              aria-label="End the conversation"
              title="End conversation"
            >
              <PhoneOffIcon className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="mx-4 h-px bg-hairline-soft" />

        {/* Awaiting video acceptance — a cancellable wait, not a dead end. */}
        {videoRequested && (
          <div className="pulse-enter-fast mx-3 mt-3 flex items-center gap-2.5 rounded-2xl border border-signal/20 bg-signal/[0.07] px-3 py-2.5">
            <span className="pulse-typing flex items-center gap-1" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <p className="min-w-0 flex-1 text-xs leading-snug text-ink-soft">
              Waiting for them to accept the call…
            </p>
            <button
              type="button"
              onClick={onCancelVideo}
              className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-ink-faint transition-colors hover:text-ink"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Messages */}
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          className="pulse-scroll flex-1 overflow-y-auto overscroll-contain px-4 py-4"
        >
          {!connected ? (
            <LinkingState />
          ) : messages.length === 0 ? (
            <EmptyState />
          ) : (
            /* Anchored to the bottom: a short conversation should sit next to
               the composer, where a conversation happens, not float at the top
               of an empty column. */
            <div className="flex min-h-full flex-col justify-end">
              <ol className="space-y-0.5">
                {messages.map((message, index) => {
                  const previous = messages[index - 1];
                  const grouped = previous?.mine === message.mine;
                  return (
                    <li
                      key={message.id}
                      className={cn(
                        "pulse-bubble flex",
                        message.mine ? "justify-end" : "justify-start",
                        grouped ? "mt-0.5" : "mt-2.5 first:mt-0",
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[82%] sm:max-w-[78%]",
                          message.mine ? "items-end" : "items-start",
                        )}
                      >
                        <div
                          className={cn(
                            "rounded-2xl px-3.5 py-2 text-[0.8125rem] leading-relaxed break-words whitespace-pre-wrap",
                            message.mine
                              ? "rounded-br-md bg-signal text-void"
                              : "rounded-bl-md border border-hairline-soft bg-white/[0.055] text-ink",
                          )}
                        >
                          {message.text}
                        </div>
                        {(grouped === false || index === messages.length - 1) && (
                          <time
                            className={cn(
                              "mt-1 block font-mono text-[0.5625rem] tracking-wider text-ink-faint/80",
                              message.mine ? "text-right" : "text-left",
                            )}
                          >
                            {clock(message.at)}
                          </time>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {peerTyping && connected && (
            <div className="mt-3 flex items-center gap-2" aria-live="polite">
              <span className="sr-only">Stranger is typing</span>
              <span
                className="pulse-typing flex items-center gap-1 rounded-2xl rounded-bl-md border border-hairline-soft bg-white/[0.055] px-3.5 py-3"
                aria-hidden="true"
              >
                <span />
                <span />
                <span />
              </span>
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="border-t border-hairline-soft px-3 pt-3"
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              maxLength={MAX_LENGTH}
              disabled={!connected}
              placeholder={connected ? "Say something…" : "Linking up…"}
              aria-label="Message"
              className={cn(
                "max-h-[132px] min-h-11 flex-1 resize-none rounded-2xl border border-hairline-soft",
                "bg-white/[0.04] px-3.5 py-2.5 text-[0.9375rem] leading-6",
                "transition-colors placeholder:text-ink-faint",
                "focus:border-signal/45 focus:bg-white/[0.06] focus:outline-none",
                "disabled:opacity-50",
              )}
            />
            <button
              type="submit"
              disabled={!connected || !draft.trim()}
              className={cn(
                "grid h-11 w-11 shrink-0 place-items-center rounded-2xl transition-all",
                "bg-signal text-void hover:bg-[#7bf7d6]",
                "disabled:bg-white/[0.06] disabled:text-ink-faint",
              )}
              aria-label="Send message"
            >
              <SendIcon className="h-5 w-5" />
            </button>
          </div>

          <p className="pulse-hint flex items-center justify-center gap-1.5 py-2.5">
            <LockIcon className="h-3 w-3" />
            Goes straight to them. Never stored.
          </p>
        </form>
      </section>

      {/* Map peek — on a phone the conversation owns the screen. This gives
          the map back without ending anything, because the map is the place,
          not the background. */}
      {compact && (
        <div
          className={cn(
            "pulse-glass-strong absolute inset-x-0 bottom-0 z-10 flex items-center gap-3",
            "rounded-none border-x-0 border-b-0 px-4 pb-[max(0.875rem,var(--safe-b))] pt-3",
            "transition-all duration-[450ms]",
            peek
              ? "pointer-events-auto translate-y-0 opacity-100"
              : "pointer-events-none translate-y-6 opacity-0",
          )}
          style={{ transitionTimingFunction: "var(--ease-out-expo)" }}
        >
          <span
            className="pulse-orbit shrink-0"
            data-busy={connected ? "false" : "true"}
            aria-hidden="true"
            style={{ width: "2rem", height: "2rem" }}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium leading-tight text-ink">
              Stranger
            </p>
            <p className="truncate text-xs leading-tight text-ink-faint">
              {connected ? "Connected" : "Linking up…"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex h-11 items-center gap-1.5 rounded-2xl border border-hairline px-3 text-xs font-medium text-ink-soft"
          >
            <ChevronDownIcon className="h-4 w-4 rotate-180" />
            Open
          </button>
          <button
            type="button"
            onClick={onEnd}
            className="grid h-11 w-11 place-items-center rounded-2xl border border-alert/25 text-alert"
            aria-label="End the conversation"
          >
            <PhoneOffIcon className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}

function LinkingState() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-2 py-10 text-center">
      <span className="pulse-orbit" data-busy="true" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-ink">Linking you up</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          Opening a direct line between the two of you. This takes a second or
          two.
        </p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-2 py-10 text-center">
      <span
        className="h-2 w-2 rounded-full bg-signal/70 shadow-[0_0_14px_2px_rgba(95,240,200,0.45)]"
        aria-hidden="true"
      />
      <div>
        <p className="text-sm font-medium text-ink">Say hello</p>
        <p className="mt-1 max-w-[15rem] text-xs leading-relaxed text-ink-soft">
          You&rsquo;re talking to a stranger with no name, no profile and no
          history. Whatever you say goes straight to them.
        </p>
      </div>
    </div>
  );
}
