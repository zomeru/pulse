"use client";

import { useEffect, useRef, useState } from "react";
import EntryGate from "./components/EntryGate";
import WorldMap from "./components/WorldMap";
import ConnectionPrompt from "./components/ConnectionPrompt";
import ChatPanel, { type ChatMessage } from "./components/ChatPanel";
import VideoPanel from "./components/VideoPanel";
import { join, leave, poll, sendSignal } from "@/lib/api";
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
  const [phase, setPhase] = useState<"gate" | "live">("gate");
  const [sessionId] = useState(() => crypto.randomUUID());
  const [incarnationId, setIncarnationId] = useState(() => crypto.randomUUID());
  const [peers, setPeers] = useState<PeerDot[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
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
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifecycleVersion = useRef(0);
  const endedConnections = useRef(new Set<string>());
  const processedSignals = useRef(new Map<string, number>());
  const pendingSignalAcks = useRef<string[]>([]);
  const terminalTimers = useRef(
    new Set<ReturnType<typeof setTimeout>>(),
  );

  function showNotice(text: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, 3500);
  }

  function addMessage(mine: boolean, text: string) {
    setMessages((previous) => [
      ...previous,
      { id: msgId.current++, mine, text },
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

  // Retry only the terminal notification; this never starts a new peer.
  function sendTerminalSignal(
    peerId: string,
    connectionId: string,
    type: "end" | "decline",
  ) {
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await sendSignal(sessionId, peerId, type, connectionId);
          return;
        } catch {
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

    // Clear the ref/state before closing WebRTC so synchronous close events
    // cannot re-enter this path or affect a later connection.
    setConn({ kind: "idle" });
    closePeer();
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
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
          void sendSignal(sessionId, peerId, type, connectionId, payload).catch(
            () => {},
          );
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
          setVideo("incoming");
        }
        break;
      case "video-accept":
        if (videoRef.current === "requesting" && expected) {
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
              peer.sendControl("video-end");
              showNotice("Camera unavailable.");
            });
        }
        break;
      case "video-decline":
        if (videoRef.current === "requesting") {
          setVideo("none");
          showNotice("Video declined.");
        }
        break;
      case "video-end":
        peer.stopVideo();
        setLocalStream(null);
        setRemoteStream(null);
        setVideo("none");
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

    void sendSignal(sessionId, peerId, "request", connectionId).catch(() => {
      if (matchesConnection(connRef.current, expected)) {
        finishConnection("Connection request failed.", "end", expected);
      }
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

    void sendSignal(
      sessionId,
      expected.peerId,
      "accept",
      expected.connectionId,
    ).catch(() => {
      if (matchesConnection(connRef.current, expected)) {
        finishConnection("Connection could not start.", "end", expected);
      }
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
    setVideo("requesting");
    if (!peer.sendControl("video-request")) {
      setVideo("none");
      showNotice("Video could not start.");
    }
  }

  function acceptVideo() {
    const peer = peerRef.current;
    const expected = currentConnectionRef();
    if (!peer || !expected || connRef.current.kind !== "connected") return;

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
        showNotice("Camera unavailable.");
      });
  }

  function declineVideo() {
    const peer = peerRef.current;
    const expected = currentConnectionRef();
    if (!peer || !expected || !isCurrentPeer(peer, expected)) return;
    peer.sendControl("video-decline");
    setVideo("none");
  }

  function endVideo() {
    const peer = peerRef.current;
    const expected = currentConnectionRef();
    if (!peer || !expected || !isCurrentPeer(peer, expected)) return;
    peer.stopVideo();
    peer.sendControl("video-end");
    setLocalStream(null);
    setRemoteStream(null);
    setVideo("none");
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
          void sendSignal(
            sessionId,
            signal.fromId,
            "decline",
            connectionId,
          ).catch(() => {});
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
  useEffect(() => {
    processSignalRef.current = processSignal;
    finishConnectionRef.current = finishConnection;
    reconcileMissingPeerRef.current = reconcileMissingPeer;
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
      try {
        const data = await poll(
          sessionId,
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
      } catch {}
      if (active) timer = setTimeout(tick, POLL_INTERVAL_MS);
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
      leave(sessionId, current?.connectionId, incarnationRef.current);
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
      void join(
        sessionId,
        location.lat,
        location.lng,
        nextIncarnationId,
      ).catch(() => {});
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
      clearTerminalTimers();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [sessionId, phase]);

  async function handleReady(lat: number, lng: number) {
    const location = { lat, lng };
    myLocationRef.current = location;
    setMyLocation(location);
    await join(sessionId, lat, lng, incarnationRef.current);
    setPhase("live");
  }

  if (phase === "gate") {
    return <EntryGate onReady={handleReady} />;
  }

  const inChat = conn.kind === "connecting" || conn.kind === "connected";

  return (
    <main className="fixed inset-0 overflow-hidden">
      <WorldMap
        peers={peers}
        me={myLocation}
        onPeerClick={requestConnection}
        canConnect={conn.kind === "idle"}
      />

      {notice && (
        <div className="absolute left-1/2 top-20 z-30 -translate-x-1/2 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          {notice}
        </div>
      )}

      {conn.kind === "requesting" && (
        <div className="absolute left-1/2 top-20 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          <span>Requesting connection…</span>
          <button
            onClick={cancelRequest}
            className="rounded-full bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600"
          >
            Cancel
          </button>
        </div>
      )}

      {conn.kind === "incoming" && (
        <ConnectionPrompt
          title="A stranger wants to connect"
          acceptLabel="Accept"
          declineLabel="Decline"
          onAccept={acceptIncoming}
          onDecline={declineIncoming}
        />
      )}

      {inChat && (
        <ChatPanel
          messages={messages}
          connected={conn.kind === "connected"}
          videoBusy={video !== "none"}
          onSend={(text) => {
            const sent = peerRef.current?.sendChat(text) ?? false;
            if (!sent) {
              showNotice("Message could not be sent.");
              return false;
            }
            addMessage(true, text);
            return true;
          }}
          onStartVideo={startVideoRequest}
          onEnd={endConnection}
        />
      )}

      {video === "requesting" && (
        <div className="absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full bg-zinc-800/90 px-4 py-2 text-sm text-zinc-100 shadow-lg backdrop-blur">
          Waiting for stranger to accept video…
        </div>
      )}

      {video === "incoming" && (
        <ConnectionPrompt
          title="Start video call?"
          subtitle="The stranger wants to turn on video."
          acceptLabel="Accept"
          declineLabel="Decline"
          onAccept={acceptVideo}
          onDecline={declineVideo}
        />
      )}

      {video === "active" && (
        <VideoPanel
          localStream={localStream}
          remoteStream={remoteStream}
          onEnd={endVideo}
        />
      )}
    </main>
  );
}
