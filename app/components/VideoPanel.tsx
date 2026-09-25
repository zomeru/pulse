"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useEscapeKey } from "@/app/hooks/useEscapeKey";
import {
  CameraIcon,
  CameraOffIcon,
  LockIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
} from "./Icon";

/**
 * A call, not a fullscreen <video>.
 *
 * Two decisions worth calling out:
 *  1. The remote feed is `object-contain` over a blurred copy of itself, so a
 *     portrait phone camera is never cropped to a face and a letterboxed
 *     desktop stream never gets hard-cut. The local self-view stays
 *     `object-cover` in 3:4, where cropping is what you want.
 *  2. Mic and camera toggles only flip `track.enabled`. No renegotiation, no
 *     new signal type, no server round trip — and the peer sees it instantly
 *     because it is the same track.
 */
export default function VideoPanel({
  localStream,
  remoteStream,
  connected,
  onEnd,
}: {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  connected: boolean;
  onEnd: () => void;
}) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const backdropRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (localRef.current && localRef.current.srcObject !== localStream) {
      localRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (backdropRef.current && backdropRef.current.srcObject !== remoteStream) {
      backdropRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (remoteRef.current && remoteRef.current.srcObject !== remoteStream) {
      remoteRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Call duration. Started once, when the panel mounts.
  const [startedAt] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [startedAt]);

  useEscapeKey(true, onEnd);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !next;
  }

  function toggleCamera() {
    const next = !cameraOff;
    setCameraOff(next);
    for (const track of localStream?.getVideoTracks() ?? []) track.enabled = !next;
  }

  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-void"
      role="region"
      aria-label="Video call"
    >
      {/* Call header */}
      <header
        className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(0.875rem,var(--safe-t))]"
      >
        <span className="pulse-orbit shrink-0" data-busy="false" aria-hidden="true" style={{ width: "1.75rem", height: "1.75rem" }} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium leading-tight text-ink">
            Stranger
          </h2>
          <p className="truncate text-xs leading-tight text-ink-faint">
            {connected ? "Live · peer-to-peer" : "Reconnecting…"}
          </p>
        </div>
        <span className="pulse-label flex items-center gap-2 rounded-full border border-hairline-soft px-2.5 py-1.5 text-ink-soft">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-alert" />
          {clock}
        </span>
      </header>

      {/* Stage */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-t-3xl bg-[#02040a]">
        <video
          ref={backdropRef}
          autoPlay
          playsInline
          muted
          aria-hidden="true"
          className={cn(
            "absolute inset-0 h-full w-full scale-110 object-cover transition-opacity duration-700",
            remoteStream ? "opacity-40 blur-3xl" : "opacity-0",
          )}
        />
        <video
          ref={remoteRef}
          autoPlay
          playsInline
          className="absolute inset-0 h-full w-full object-contain"
        />

        {!remoteStream && (
          <div className="absolute inset-0 grid place-items-center px-8">
            <div className="flex flex-col items-center gap-4 text-center">
              <span className="pulse-orbit" data-busy="true" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-ink">
                  Waiting for their camera
                </p>
                <p className="mt-1 max-w-[16rem] text-xs leading-relaxed text-ink-soft">
                  The call is open. Their video appears the moment they turn
                  theirs on.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Self view */}
        <div
          className={cn(
            "absolute right-3 overflow-hidden rounded-2xl border border-hairline bg-surface-2",
            "shadow-[0_18px_40px_-18px_rgba(0,0,0,0.9)]",
            "top-3 w-[26%] max-w-[9.5rem] min-w-[5.5rem] sm:top-4 sm:right-4",
          )}
        >
          <div className="relative aspect-[3/4] w-full">
            <video
              ref={localRef}
              autoPlay
              playsInline
              muted
              className={cn(
                "h-full w-full scale-x-[-1] object-cover transition-opacity duration-300",
                cameraOff ? "opacity-0" : "opacity-100",
              )}
            />
            {cameraOff && (
              <div className="absolute inset-0 grid place-items-center bg-surface-2">
                <CameraOffIcon className="h-5 w-5 text-ink-faint" />
              </div>
            )}
            <span className="pulse-label absolute inset-x-0 bottom-0 bg-gradient-to-t from-void/90 to-transparent px-2 pb-1.5 pt-4 text-[0.5rem] text-ink-soft">
              You
            </span>
            {muted && (
              <span
                className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-void/75 text-alert"
                aria-label="Microphone muted"
              >
                <MicOffIcon className="h-3 w-3" />
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div
        className="shrink-0 bg-void px-4 pb-[max(1rem,var(--safe-b))] pt-4"
        style={{ paddingBottom: "max(1rem, var(--safe-b))" }}
      >
        <div className="mx-auto flex w-fit items-center gap-3">
          <ControlButton
            active={muted}
            onClick={toggleMute}
            label={muted ? "Unmute microphone" : "Mute microphone"}
            icon={muted ? MicOffIcon : MicIcon}
          />
          <ControlButton
            active={cameraOff}
            onClick={toggleCamera}
            label={cameraOff ? "Turn camera on" : "Turn camera off"}
            icon={cameraOff ? CameraOffIcon : CameraIcon}
          />
          <ControlButton
            onClick={onEnd}
            label="End call and return to text"
            icon={PhoneOffIcon}
            hangup
          />
        </div>
        <p className="pulse-hint mt-3 flex items-center justify-center gap-1.5 text-center">
          <LockIcon className="h-3 w-3" />
          Never recorded. Never stored.
        </p>
      </div>
    </div>
  );
}

function ControlButton({
  onClick,
  label,
  icon: Icon,
  active = false,
  hangup = false,
}: {
  onClick: () => void;
  label: string;
  icon: (props: { className?: string }) => React.ReactElement;
  active?: boolean;
  hangup?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "grid place-items-center rounded-full transition-all duration-200 active:scale-95",
        hangup
          ? "h-14 w-14 bg-alert text-void hover:bg-[#ff93a4]"
          : "h-12 w-12 border",
        !hangup &&
          (active
            ? "border-alert/40 bg-alert/15 text-alert"
            : "border-hairline bg-white/[0.05] text-ink hover:border-ink-faint hover:text-white"),
      )}
    >
      <Icon className={hangup ? "h-6 w-6" : "h-5 w-5"} />
    </button>
  );
}
