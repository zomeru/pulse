"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import EntryGate from "./components/EntryGate";
import WorldMap from "./components/WorldMap";
import ConnectionPrompt from "./components/ConnectionPrompt";
import RequestingCard from "./components/RequestingCard";
import ChatPanel, { type ChatMessage } from "./components/ChatPanel";
import VideoPanel from "./components/VideoPanel";
import NoticeStack, { type Notice } from "./components/NoticeStack";
import TopBar, { type FlowStage } from "./components/TopBar";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useVisualViewportVar } from "./hooks/useVisualViewport";
import {
  ApiError,
  join,
  leave,
  poll,
  sendSignal,
} from "@/lib/api";
import { PeerSession, type DescType, type PeerControl } from "@/lib/webrtc";
import { POLL_INTERVAL_MS, SIGNAL_TTL_MS } from "@/lib/presence";
import { type PeerDot, type SignalMsg } from "@/lib/types";

type ConnectionRef = {
  peerId: string;
  connectionId: string;
};

type ActiveConn = {
  kind: "requesting" | "incoming" | "connecting" | "connected";
  peerId: string;
  connectionId: string;
};

type Conn = { kind: "idle" } | ActiveConn;

type VideoState = "none" | "requesting" | "incoming" | "active";

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 30_000;
const PEER_DISCONNECT_GRACE_MS = 10_000;
const MISSING_PEER_GRACE_MS = POLL_INTERVAL_MS * 2;
const VIDEO_REQUEST_TIMEOUT_MS = 30_000;
const TYPING_TTL_MS = 3_200;
const POLL_FAILURES_BEFORE_WARN = 3;

function isActiveConnection(conn: Conn): conn is ActiveConn {
  return conn.kind !== "idle";
}

function matchesConnection(
  conn: Conn,
  expected: ConnectionRef,
): boolean {
  return (
    isActiveConnection(conn) &&
    conn.peerId === expected.peerId &&
    conn.connectionId === expected.connectionId
  );
}

export default function Home() {
  useVisualViewportVar();
  const compact = useMediaQuery("(max-width: 639px)");

  const [phase, setPhase] = useState<"gate" | "live">("gate");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [incarnationId, setIncarnationId] = useState(() => crypto.randomUUID());
  // Server-issued proof that we own the presence row we are talking about. Held
  // in a ref because it is set once per session and read from callbacks and
  // async continuations that would otherwise close over a stale copy.
  const sessionTokenRef = useRef("");
  const sessionRotations = useRef(0);
  const [peers, setPeers] = useState<PeerDot[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [sync, setSync] = useState<"live" | "reconnecting">("live");
  const [peerTyping, setPeerTyping] = useState(false);
  const [mediaError, setMediaError] = useState<"caller" | "callee" | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  const [conn, setConnState] = useState<Conn>({ kind: "idle" });
  const connRef = useRef<Conn>(conn);
  const setConn = (next: Conn) => {
    connRef.current = next;
    setConnState(next);
  };

  const [video, setVideoState] = useState<VideoState>("none");
  const videoRef = useRef<VideoState>(video);
  const setVideo = (next: VideoState) => {
    videoRef.current = next;
    setVideoState(next);
  };

  const peersRef = useRef<PeerDot[]>([]);
  const incarnationRef = useRef(incarnationId);
  const leftOnPageHide = useRef(false);
  const myLocationRef = useRef<{ lat: number; lng: number } | null>(null);
  const peerRef = useRef<PeerSession | null>(null);
  const msgId = useRef(0);
  const requestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const missingPeerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peerDisconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRequestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeSeq = useRef(0);
  const pollFailures = useRef(0);
  const lifecycleVersion = useRef(0);
  const endedConnections = useRef(new Set<string>());
  const processedSignals = useRef(new Map<string, number>());
  const pendingSignalAcks = useRef<string[]>([]);
  const terminalTimers = useRef(
    new Set<ReturnType<typeof setTimeout>>(),
  );

  const dismissNotice = useCallback((id: number) => {
    setNotices((previous) => previous.filter((n) => n.id !== id));
  }, []);

  function showNotice(text: string, tone: "info" | "error" = "info") {
    const id = noticeSeq.current++;
    // Never stack more than three; the oldest one is the least relevant.
    setNotices((previous) => [...previous.slice(-2), { id, text, tone }]);
  }

  function addMessage(mine: boolean, text: string) {
    setMessages((previous) => [
      ...previous,
      { id: msgId.current++, mine, text, at: Date.now() },
    ]);
  }

  function claimSignal(signalId: string): boolean {
    const now = Date.now();
    for (const [id, seenAt] of processedSignals.current) {
      if (now - seenAt > SIGNAL_TTL_MS * 2) {
        processedSignals.current.delete(id);
      }
    }
    if (processedSignals.current.has(signalId)) return false;
    processedSignals.current.set(signalId, now);
    return true;
  }

  function rememberSignalAck(signalId: string) {
    if (pendingSignalAcks.current.includes(signalId)) return;
    pendingSignalAcks.current.push(signalId);
    if (pendingSignalAcks.current.length > 1000) {
      pendingSignalAcks.current.shift();
    }
  }

  function clearRequestTimer() {
    if (!requestTimer.current) return;
    clearTimeout(requestTimer.current);
    requestTimer.current = null;
  }

  function clearMissingPeerTimer() {
    if (!missingPeerTimer.current) return;
    clearTimeout(missingPeerTimer.current);
    missingPeerTimer.current = null;
  }

  function clearConnectionTimer() {
    if (!connectionTimer.current) return;
    clearTimeout(connectionTimer.current);
    connectionTimer.current = null;
  }

  function clearPeerDisconnectTimer() {
    if (!peerDisconnectTimer.current) return;
    clearTimeout(peerDisconnectTimer.current);
    peerDisconnectTimer.current = null;
  }

  function clearVideoRequestTimer() {
    if (!videoRequestTimer.current) return;
    clearTimeout(videoRequestTimer.current);
    videoRequestTimer.current = null;
  }

  function clearTypingTimer() {
    if (!typingTimer.current) return;
    clearTimeout(typingTimer.current);
    typingTimer.current = null;
    setPeerTyping(false);
  }

  function closePeer() {
    const peer = peerRef.current;
    peerRef.current = null;
    peer?.close();
  }

  function currentConnectionRef(): ConnectionRef | null {
    const current = connRef.current;
    return isActiveConnection(current)
      ? { peerId: current.peerId, connectionId: current.connectionId }
      : null;
  }

  function isCurrentPeer(
    peer: PeerSession,
    expected: ConnectionRef,
  ): boolean {
    return peerRef.current === peer && matchesConnection(connRef.current, expected);
  }

  function clearTerminalTimers() {
    for (const timer of terminalTimers.current) clearTimeout(timer);
    terminalTimers.current.clear();
  }

  /**
   * Open (or re-open) the server-side session for this page and keep the token
   * it issues.
   *
   * A join can legitimately fail with "session_taken": the id is ours in the
   * browser but the server has given it to somebody else, or our row was reaped
   * and the id was claimed in between. Ids are public — the whole map is handed
   * out to every caller — so the honest response is to take a new one rather
   * than argue. One retry, because that is the only failure that retrying fixes.
   */
  async function openSession(location: { lat: number; lng: number }) {
    let id = sessionId;
    let token = sessionTokenRef.current;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await join(
          id,
          location.lat,
          location.lng,
          incarnationRef.current,
          token || undefined,
        );
        sessionTokenRef.current = result.sessionToken;
        return;
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !error.isUnknownSession ||
          attempt === 1
        ) {
          throw error;
        }
        id = crypto.randomUUID();
        token = "";
        sessionTokenRef.current = "";
        const nextIncarnationId = crypto.randomUUID();
        incarnationRef.current = nextIncarnationId;
        setIncarnationId(nextIncarnationId);
        setSessionId(id);
        sessionRotations.current += 1;
      }
    }
  }

  /**
   * The server no longer knows this session, so anything we think we have is
   * already gone: drop it and come back as a new one. Bounded, because if
   * several rotations in a row fail the cause is not the session id.
   */
  async function recoverSession(): Promise<boolean> {
    const location = myLocationRef.current;
    if (!location || sessionRotations.current >= 3) return false;
    finishConnectionRef.current(undefined, null);
    try {
      await openSession(location);
      return true;
    } catch {
      return false;
    }
  }

  // Retry only the terminal notification; this never starts a new peer.
  function sendTerminalSignal(
    peerId: string,
    connectionId: string,
    type: "end" | "decline",
  ) {
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await sendSignal({
            fromId: sessionId,
            toId: peerId,
            type,
            connectionId,
            sessionToken: sessionTokenRef.current,
          });
          return;
        } catch (error) {
          // A refusal will not become an acceptance.
          if (error instanceof ApiError && error.isTerminal) return;
          if (attempt < 2) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                terminalTimers.current.delete(timer);
                resolve();
              }, 250 * (attempt + 1));
              terminalTimers.current.add(timer);
            });
          }
        }
      }
    })();
  }

  /**
   * The one local terminal path for a connection. It is token- and
   * generation-guarded, idempotent, and never waits for a network request.
   */
  function finishConnection(
    message?: string,
    signalType: "end" | "decline" | null = "end",
    expected?: ConnectionRef,
  ): boolean {
    const current = connRef.current;
    if (!isActiveConnection(current)) return false;
    if (expected && !matchesConnection(current, expected)) return false;

    const ended: ConnectionRef = {
      peerId: current.peerId,
      connectionId: current.connectionId,
    };
    endedConnections.current.add(ended.connectionId);
    lifecycleVersion.current += 1;
    clearTerminalTimers();
    clearRequestTimer();
    clearMissingPeerTimer();
    clearConnectionTimer();
    clearPeerDisconnectTimer();
    clearVideoRequestTimer();
    clearTypingTimer();

    // Clear the ref/state before closing WebRTC so synchronous close events
    // cannot re-enter this path or affect a later connection.
    setConn({ kind: "idle" });
    closePeer();
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
    setMediaError(null);
    setMessages([]);

    if (signalType) {
      sendTerminalSignal(ended.peerId, ended.connectionId, signalType);
    }
    if (message) showNotice(message);
    return true;
  }

  function startPeer(
    peerId: string,
    initiator: boolean,
    connectionId: string,
  ) {
    const expected = { peerId, connectionId };
    let disconnected = false;
    const peer = new PeerSession(initiator, {
      onSignal: (type: DescType, payload: string) => {
        if (isCurrentPeer(peer, expected)) {
          void sendSignal({
            fromId: sessionId,
            toId: peerId,
            type,
            connectionId,
            payload,
            sessionToken: sessionTokenRef.current,
          }).catch(() => {});
        }
      },
      onChat: (text) => {
        if (isCurrentPeer(peer, expected)) addMessage(false, text);
      },
      onControl: (ctrl) => {
        if (isCurrentPeer(peer, expected)) handleControl(ctrl, expected);
      },
      onRemoteStream: (stream) => {
        if (isCurrentPeer(peer, expected)) setRemoteStream(stream);
      },
      onConnectionState: (state) => {
        if (!isCurrentPeer(peer, expected)) return;
        if (state === "disconnected") {
          disconnected = true;
          clearPeerDisconnectTimer();
          peerDisconnectTimer.current = setTimeout(() => {
            peerDisconnectTimer.current = null;
            if (disconnected && isCurrentPeer(peer, expected)) {
              finishConnection("Connection lost.", "end", expected);
            }
          }, PEER_DISCONNECT_GRACE_MS);
        } else {
          disconnected = false;
          clearPeerDisconnectTimer();
        }
        if (state === "failed" || state === "closed") {
          finishConnection("Connection closed.", "end", expected);
        }
      },
      onChannelOpen: () => {
        if (!isCurrentPeer(peer, expected)) return;
        clearConnectionTimer();
        const current = connRef.current;
        if (current.kind === "connecting") {
          setConn({ kind: "connected", ...expected });
        }
      },
      onChannelClose: () => {
        if (isCurrentPeer(peer, expected)) {
          finishConnection("Connection closed.", "end", expected);
        }
      },
      onChannelError: () => {
        if (isCurrentPeer(peer, expected)) {
          finishConnection("Connection error.", "end", expected);
        }
      },
    });
    peerRef.current = peer;
    clearConnectionTimer();
    connectionTimer.current = setTimeout(() => {
      connectionTimer.current = null;
      if (isCurrentPeer(peer, expected)) {
        finishConnection("Connection timed out.", "end", expected);
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  function handleControl(ctrl: PeerControl, expected?: ConnectionRef) {
    const peer = peerRef.current;
    if (!peer || (expected && !isCurrentPeer(peer, expected))) return;

    switch (ctrl) {
      case "video-request":
        if (videoRef.current === "none" && isActiveConnection(connRef.current)) {
          // We are no longer the one waiting.
          clearVideoRequestTimer();
          setMediaError(null);
          setVideo("incoming");
        }
        break;
      case "video-accept":
        if (videoRef.current === "requesting" && expected) {
          clearVideoRequestTimer();
          peer
            .startVideo()
            .then((stream) => {
              if (!isCurrentPeer(peer, expected)) {
                for (const track of stream.getTracks()) track.stop();
                return;
              }
              setLocalStream(stream);
              setVideo("active");
            })
            .catch(() => {
              if (!isCurrentPeer(peer, expected)) return;
              setVideo("none");
              setMediaError("caller");
              peer.sendControl("video-end");
            });
        }
        break;
      case "video-decline":
        if (videoRef.current === "requesting") {
          clearVideoRequestTimer();
          setVideo("none");
          showNotice("They'd rather keep it to text.");
        } else if (videoRef.current === "incoming") {
          // The requester withdrew the call.
          setVideo("none");
        }
        break;
      case "video-end":
        clearVideoRequestTimer();
        peer.stopVideo();
        setLocalStream(null);
        setRemoteStream(null);
        setMediaError(null);
        setVideo("none");
        break;
      case "typing":
        if (typingTimer.current) clearTimeout(typingTimer.current);
        setPeerTyping(true);
        typingTimer.current = setTimeout(() => {
          typingTimer.current = null;
          setPeerTyping(false);
        }, TYPING_TTL_MS);
        break;
    }
  }

  function requestConnection(peerId: string) {
    if (connRef.current.kind !== "idle") return;

    const connectionId = crypto.randomUUID();
    const expected = { peerId, connectionId };
    lifecycleVersion.current += 1;
    clearRequestTimer();
    clearMissingPeerTimer();
    setConn({ kind: "requesting", ...expected });

    void sendSignal({
      fromId: sessionId,
      toId: peerId,
      type: "request",
      connectionId,
      sessionToken: sessionTokenRef.current,
    })
      .then((result) => {
        if (!matchesConnection(connRef.current, expected)) return;
        // Nobody was there to answer. The server tells us directly rather than
        // delivering a rejection the target never sent.
        if (result.autoDeclined) {
          finishConnection("They're not available right now.", null, expected);
        }
      })
      .catch((error: unknown) => {
        if (!matchesConnection(connRef.current, expected)) return;
        if (error instanceof ApiError && error.isUnknownSession) {
          void recoverSession();
          return;
        }
        finishConnection("Connection request failed.", "end", expected);
      });

    requestTimer.current = setTimeout(() => {
      requestTimer.current = null;
      if (matchesConnection(connRef.current, expected)) {
        finishConnection("No answer.", "end", expected);
      }
    }, REQUEST_TIMEOUT_MS);
  }

  function cancelRequest() {
    finishConnection();
  }

  function acceptIncoming() {
    const current = connRef.current;
    if (current.kind !== "incoming") return;

    const expected = {
      peerId: current.peerId,
      connectionId: current.connectionId,
    };
    clearRequestTimer();
    setConn({ kind: "connecting", ...expected });
    try {
      startPeer(expected.peerId, false, expected.connectionId);
    } catch {
      finishConnection("Connection could not start.", "end", expected);
      return;
    }

    void sendSignal({
      fromId: sessionId,
      toId: expected.peerId,
      type: "accept",
      connectionId: expected.connectionId,
      sessionToken: sessionTokenRef.current,
    }).catch((error: unknown) => {
      if (!matchesConnection(connRef.current, expected)) return;
      if (error instanceof ApiError && error.isUnknownSession) {
        void recoverSession();
        return;
      }
      finishConnection("Connection could not start.", "end", expected);
    });
  }

  function declineIncoming() {
    const current = connRef.current;
    if (current.kind !== "incoming") return;
    finishConnection("Request declined.", "decline", {
      peerId: current.peerId,
      connectionId: current.connectionId,
    });
  }

  function endConnection() {
    finishConnection();
  }

  function startVideoRequest() {
    const current = connRef.current;
    const peer = peerRef.current;
    if (current.kind !== "connected" || !peer) return;
    clearVideoRequestTimer();
    setMediaError(null);
    setVideo("requesting");
    if (!peer.sendControl("video-request")) {
      setVideo("none");
      showNotice("The call couldn't be started. Try again in a moment.", "error");
      return;
    }
    // Without this the UI would sit on "waiting" forever if the other side
    // simply walked away. A withdrawn request is not a failed connection.
    videoRequestTimer.current = setTimeout(() => {
      videoRequestTimer.current = null;
      if (videoRef.current !== "requesting") return;
      peer.sendControl("video-decline");
      setVideo("none");
      showNotice("No answer on the call.");
    }, VIDEO_REQUEST_TIMEOUT_MS);
  }

  function cancelVideoRequest() {
    if (videoRef.current !== "requesting") return;
    clearVideoRequestTimer();
    peerRef.current?.sendControl("video-decline");
    setVideo("none");
  }

  function acceptVideo() {
    const peer = peerRef.current;
    const expected = currentConnectionRef();
    if (!peer || !expected || connRef.current.kind !== "connected") return;

    setMediaError(null);
    peer
      .startVideo()
      .then((stream) => {
        if (!isCurrentPeer(peer, expected)) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        setLocalStream(stream);
        peer.sendControl("video-accept");
        setVideo("active");
      })
      .catch(() => {
        if (!isCurrentPeer(peer, expected)) return;
        peer.sendControl("video-decline");
        setVideo("none");
        setMediaError("callee");
      });
  }

  function declineVideo() {
    const peer = peerRef.current;
    const expected = currentConnectionRef();
    if (!peer || !expected || !isCurrentPeer(peer, expected)) return;
    clearVideoRequestTimer();
    peer.sendControl("video-decline");
    setVideo("none");
    setMediaError(null);
  }

  function endVideo() {
    const peer = peerRef.current;
    const expected = currentConnectionRef();
    if (!peer || !expected || !isCurrentPeer(peer, expected)) return;
    clearVideoRequestTimer();
    peer.stopVideo();
    peer.sendControl("video-end");
    setLocalStream(null);
    setRemoteStream(null);
    setMediaError(null);
    setVideo("none");
  }

  function sendTyping() {
    peerRef.current?.sendControl("typing");
  }

  function processSignal(signal: SignalMsg) {
    const connectionId = signal.connectionId;
    if (!connectionId || endedConnections.current.has(connectionId)) return;

    const current = connRef.current;
    switch (signal.type) {
      case "request": {
        if (current.kind === "idle") {
          lifecycleVersion.current += 1;
          clearRequestTimer();
          clearMissingPeerTimer();
          setConn({
            kind: "incoming",
            peerId: signal.fromId,
            connectionId,
          });
        } else if (
          !matchesConnection(current, {
            peerId: signal.fromId,
            connectionId,
          })
        ) {
          void sendSignal({
            fromId: sessionId,
            toId: signal.fromId,
            type: "decline",
            connectionId,
            sessionToken: sessionTokenRef.current,
          }).catch(() => {});
        }
        break;
      }
      case "accept": {
        if (
          current.kind === "requesting" &&
          current.peerId === signal.fromId &&
          current.connectionId === connectionId
        ) {
          const expected = {
            peerId: signal.fromId,
            connectionId,
          };
          clearRequestTimer();
          setConn({ kind: "connecting", ...expected });
          try {
            startPeer(expected.peerId, true, expected.connectionId);
          } catch {
            finishConnection("Connection could not start.", "end", expected);
          }
        }
        break;
      }
      case "decline": {
        endedConnections.current.add(connectionId);
        const expected = {
          peerId: signal.fromId,
          connectionId,
        };
        if (matchesConnection(connRef.current, expected)) {
          finishConnection("Request declined.", null, expected);
        }
        break;
      }
      case "offer":
      case "answer":
      case "ice": {
        const expected = {
          peerId: signal.fromId,
          connectionId,
        };
        if (
          (connRef.current.kind === "connecting" ||
            connRef.current.kind === "connected") &&
          peerRef.current &&
          matchesConnection(connRef.current, expected)
        ) {
          void peerRef.current.handleSignal(
            signal.type as DescType,
            signal.payload ?? "",
          );
        }
        break;
      }
      case "end": {
        endedConnections.current.add(connectionId);
        const expected = {
          peerId: signal.fromId,
          connectionId,
        };
        if (matchesConnection(connRef.current, expected)) {
          finishConnection("Stranger disconnected.", null, expected);
        }
        break;
      }
    }
  }

  function reconcileMissingPeer(nextPeers: PeerDot[], observed: Conn) {
    if (
      !isActiveConnection(observed) ||
      !matchesConnection(connRef.current, observed)
    ) {
      return;
    }

    const expected = {
      peerId: observed.peerId,
      connectionId: observed.connectionId,
    };
    if (nextPeers.some((peer) => peer.id === expected.peerId)) {
      clearMissingPeerTimer();
      return;
    }
    if (missingPeerTimer.current) return;

    missingPeerTimer.current = setTimeout(() => {
      missingPeerTimer.current = null;
      if (
        matchesConnection(connRef.current, expected) &&
        !peersRef.current.some((peer) => peer.id === expected.peerId)
      ) {
        finishConnection("Stranger disconnected.", null, expected);
      }
    }, MISSING_PEER_GRACE_MS);
  }

  const processSignalRef = useRef(processSignal);
  const finishConnectionRef = useRef(finishConnection);
  const reconcileMissingPeerRef = useRef(reconcileMissingPeer);
  const recoverSessionRef = useRef(recoverSession);
  const openSessionRef = useRef(openSession);
  useEffect(() => {
    processSignalRef.current = processSignal;
    finishConnectionRef.current = finishConnection;
    reconcileMissingPeerRef.current = reconcileMissingPeer;
    recoverSessionRef.current = recoverSession;
    openSessionRef.current = openSession;
  });

  useEffect(() => {
    if (phase !== "live" || !sessionId) return;
    let active = true;
    let requestSequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const requestId = ++requestSequence;
      const observedConnection = connRef.current;
      const observedVersion = lifecycleVersion.current;
      const leaseConnectionId =
        observedConnection.kind === "connected"
          ? observedConnection.connectionId
          : undefined;
      const acknowledgedSignalIds = pendingSignalAcks.current.slice(0, 100);
      let delay = POLL_INTERVAL_MS;
      try {
        const data = await poll(
          sessionId,
          sessionTokenRef.current,
          leaseConnectionId,
          acknowledgedSignalIds,
        );
        if (!active || requestId !== requestSequence) return;
        pendingSignalAcks.current = pendingSignalAcks.current.filter(
          (signalId) => !acknowledgedSignalIds.includes(signalId),
        );

        peersRef.current = data.peers;
        setPeers(data.peers);

        for (const connectionId of data.endedConnectionIds ?? []) {
          endedConnections.current.add(connectionId);
          const current = connRef.current;
          if (
            isActiveConnection(current) &&
            current.connectionId === connectionId
          ) {
            finishConnectionRef.current("Stranger disconnected.", null, {
              peerId: current.peerId,
              connectionId,
            });
          }
        }

        for (const signal of data.signals) {
          if (claimSignal(signal.id)) {
            processSignalRef.current(signal);
          }
          rememberSignalAck(signal.id);
        }

        // A response started before a connect/end transition must not be used
        // to infer presence for the new lifecycle.
        if (lifecycleVersion.current === observedVersion) {
          reconcileMissingPeerRef.current(data.peers, observedConnection);
        }
        pollFailures.current = 0;
        setSync("live");
      } catch (error) {
        if (error instanceof ApiError && error.isUnknownSession) {
          // The row is gone (reaped, or claimed by a new session). Come back as
          // somebody new rather than polling a dot that isn't ours.
          await recoverSessionRef.current();
        } else if (error instanceof ApiError && error.status === 429) {
          // Being asked to slow down is not a broken connection: back off and
          // stay quiet about it so the dot does not look lost.
          delay = POLL_INTERVAL_MS * 3;
        } else {
          // The heartbeat is what keeps this dot on the map, so a run of failed
          // polls is worth surfacing rather than swallowing silently.
          pollFailures.current += 1;
          if (pollFailures.current >= POLL_FAILURES_BEFORE_WARN) {
            setSync("reconnecting");
          }
        }
      }
      if (active) timer = setTimeout(tick, delay);
    };
    tick();

    return () => {
      active = false;
      requestSequence += 1;
      if (timer) clearTimeout(timer);
    };
  }, [phase, sessionId]);

  useEffect(() => {
    if (!sessionId || phase !== "live") return;

    const onLeave = (event?: Event) => {
      // A persisted page is frozen, not gone. Keep the session available and
      // rejoin on pageshow in case its presence lease expired while frozen.
      if (event && "persisted" in event && event.persisted) return;
      const current = currentConnectionRef();
      if (current) {
        finishConnectionRef.current(undefined, null, current);
      }
      leftOnPageHide.current = true;
      // Only meaningful once the server has issued us a token; without one the
      // server cannot tell this request from anybody else's.
      if (sessionTokenRef.current) {
        leave(
          sessionId,
          sessionTokenRef.current,
          incarnationRef.current,
          current?.connectionId,
        );
      }
    };

    const onPageShow = (event: PageTransitionEvent) => {
      const location = myLocationRef.current;
      if (!event.persisted || !location) return;
      const nextIncarnationId = leftOnPageHide.current
        ? crypto.randomUUID()
        : incarnationRef.current;
      if (leftOnPageHide.current) {
        incarnationRef.current = nextIncarnationId;
        setIncarnationId(nextIncarnationId);
        leftOnPageHide.current = false;
      }
      void openSessionRef.current(location).catch(() => {});
    };

    // pagehide covers normal navigation and tab/window closure. beforeunload
    // remains only a best-effort supplement; TTL cleanup is authoritative.
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("pageshow", onPageShow);
      onLeave();
      clearRequestTimer();
      clearMissingPeerTimer();
      clearConnectionTimer();
      clearPeerDisconnectTimer();
      clearVideoRequestTimer();
      clearTerminalTimers();
    };
  }, [sessionId, phase]);

  async function handleReady(lat: number, lng: number) {
    const location = { lat, lng };
    myLocationRef.current = location;
    setMyLocation(location);
    sessionRotations.current = 0;
    await openSession(location);
    setPhase("live");
  }

  if (phase === "gate") {
    return <EntryGate onReady={handleReady} />;
  }

  const inChat = conn.kind === "connecting" || conn.kind === "connected";

  const stage: FlowStage =
    conn.kind === "idle"
      ? "explore"
      : conn.kind === "connecting"
        ? "link"
        : conn.kind === "connected"
          ? "talk"
          : "request";

  const mapTarget = isActiveConnection(conn)
    ? {
        peerId: conn.peerId,
        state: conn.kind === "connected" ? ("linked" as const) : ("target" as const),
      }
    : null;

  return (
    <main className="fixed inset-x-0 top-0 h-[var(--app-vh)] overflow-hidden bg-void">
      <WorldMap
        peers={peers}
        me={myLocation}
        target={mapTarget}
        onPeerClick={requestConnection}
        canConnect={conn.kind === "idle"}
      />

      <TopBar
        stage={stage}
        incoming={conn.kind === "incoming"}
        online={peers.length}
        sync={sync}
        compact={compact}
      />

      <NoticeStack notices={notices} onDismiss={dismissNotice} />

      {conn.kind === "requesting" && (
        <RequestingCard onCancel={cancelRequest} />
      )}

      {conn.kind === "incoming" && (
        <ConnectionPrompt
          title="Someone wants to talk"
          subtitle="They're a stranger, and you'll stay anonymous to each other."
          detail="Chat and video go straight between the two of you."
          acceptLabel="Connect"
          declineLabel="Not now"
          onAccept={acceptIncoming}
          onDecline={declineIncoming}
        />
      )}

      {inChat && (
        <ChatPanel
          messages={messages}
          connected={conn.kind === "connected"}
          videoRequested={video === "requesting"}
          peerTyping={peerTyping}
          compact={compact}
          onSend={(text) => {
            const sent = peerRef.current?.sendChat(text) ?? false;
            if (!sent) {
              showNotice("That message didn't make it. Try again.", "error");
              return false;
            }
            addMessage(true, text);
            return true;
          }}
          onTyping={sendTyping}
          onStartVideo={startVideoRequest}
          onCancelVideo={cancelVideoRequest}
          onEnd={endConnection}
        />
      )}

      {video === "incoming" && (
        <ConnectionPrompt
          title="They'd like to turn on video"
          subtitle="You'll see each other for as long as you both want."
          detail="Never recorded, never stored."
          tone="self"
          acceptLabel="Join call"
          declineLabel="Keep texting"
          onAccept={acceptVideo}
          onDecline={declineVideo}
        />
      )}

      {mediaError && (
        <ConnectionPrompt
          title="We can't reach your camera"
          subtitle="Your browser blocked camera or microphone access for this site."
          detail="Allow it in the address bar, then try again — or stay here in text."
          tone="alert"
          acceptLabel="Try again"
          declineLabel="Stay in text"
          onAccept={mediaError === "callee" ? acceptVideo : startVideoRequest}
          onDecline={() => setMediaError(null)}
        />
      )}

      {video === "active" && (
        <VideoPanel
          localStream={localStream}
          remoteStream={remoteStream}
          connected={conn.kind === "connected"}
          onEnd={endVideo}
        />
      )}
    </main>
  );
}
