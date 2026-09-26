export type DescType = "offer" | "answer" | "ice";
export type PeerControl =
  | "video-request"
  | "video-accept"
  | "video-decline"
  | "video-end"
  // UI feedback only — a throttled "they are typing" signal, exchanged on the
  // same data channel as chat. Never persisted, never seen by the server.
  | "typing";

// What travels on the data channel is deliberately *only* what belongs to the two
// people already talking: chat, call control, and the typing indicator.
//
// A wave (Phase 4) is a message to a stranger you are not in a conversation with,
// so it cannot come through here — there is no channel to it. It rides the same
// transient signal mailbox a connection request uses, and the same rules apply:
// nothing is stored, nothing is logged, and the row is gone within a minute.
// Pushing it through the server is the honest choice; inventing a second
// out-of-band transport for it would be the one that needed justifying.

interface PeerCallbacks {
  onSignal: (type: DescType, payload: string) => void;
  onChat: (text: string) => void;
  onControl: (ctrl: PeerControl) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onChannelOpen: () => void;
  onChannelClose: () => void;
  onChannelError: () => void;
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export class PeerSession {
  private readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  private localStream: MediaStream | null = null;
  private closed = false;
  private readonly cb: PeerCallbacks;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private signalQueue: Promise<void> = Promise.resolve();

  constructor(initiator: boolean, cb: PeerCallbacks) {
    this.cb = cb;
    this.polite = !initiator;
    this.pc = new RTCPeerConnection(ICE_CONFIG);

    this.pc.onicecandidate = ({ candidate }) => {
      if (this.closed || !candidate) return;
      this.cb.onSignal("ice", JSON.stringify(candidate));
    };

    this.pc.onnegotiationneeded = async () => {
      if (this.closed) return;
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.closed || !this.pc.localDescription) return;
        this.cb.onSignal("offer", JSON.stringify(this.pc.localDescription));
      } catch {
        if (!this.closed) this.cb.onChannelError();
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.ontrack = ({ streams }) => {
      if (!this.closed) this.cb.onRemoteStream(streams[0] ?? null);
    };

    this.pc.onconnectionstatechange = () => {
      if (!this.closed) this.cb.onConnectionState(this.pc.connectionState);
    };

    if (initiator) {
      this.dc = this.pc.createDataChannel("chat");
      this.wireDataChannel(this.dc);
    } else {
      this.pc.ondatachannel = (event) => {
        if (this.closed) {
          event.channel.close();
          return;
        }
        this.dc = event.channel;
        this.wireDataChannel(this.dc);
      };
    }
  }

  private wireDataChannel(dc: RTCDataChannel) {
    dc.onopen = () => {
      if (!this.closed) this.cb.onChannelOpen();
    };
    dc.onclose = () => {
      if (!this.closed) this.cb.onChannelClose();
    };
    dc.onerror = () => {
      if (!this.closed) this.cb.onChannelError();
    };
    dc.onmessage = (event) => {
      if (this.closed) return;
      try {
        const message = JSON.parse(event.data as string);
        if (message.t === "chat" && typeof message.text === "string") {
          this.cb.onChat(message.text);
        } else if (
          message.t === "ctrl" &&
          typeof message.ctrl === "string"
        ) {
          this.cb.onControl(message.ctrl as PeerControl);
        }
      } catch {
        // Ignore malformed peer data; it must not tear down a valid session.
      }
    };
  }

  handleSignal(type: DescType, payload: string): Promise<void> {
    const operation = this.signalQueue.then(() =>
      this.handleSignalInternal(type, payload),
    );
    this.signalQueue = operation.catch(() => {});
    return operation.catch(() => {
      if (!this.closed) this.cb.onChannelError();
    });
  }

  private async handleSignalInternal(type: DescType, payload: string) {
    if (this.closed) return;
    const data = JSON.parse(payload);

    if (type === "ice") {
      if (!this.pc.remoteDescription) {
        this.pendingCandidates.push(data);
        return;
      }
      try {
        await this.pc.addIceCandidate(data);
      } catch {}
      return;
    }

    const desc = data as RTCSessionDescriptionInit;
    const offerCollision =
      desc.type === "offer" &&
      (this.makingOffer || this.pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    await this.pc.setRemoteDescription(desc);
    if (this.closed) return;
    await this.flushPendingCandidates();
    if (this.closed) return;
    if (desc.type === "offer") {
      await this.pc.setLocalDescription();
      if (!this.closed && this.pc.localDescription) {
        this.cb.onSignal("answer", JSON.stringify(this.pc.localDescription));
      }
    }
  }

  private async flushPendingCandidates() {
    if (this.pendingCandidates.length === 0 || this.closed) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      if (this.closed) return;
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  sendChat(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) return false;
    return this.safeSend({ t: "chat", text: normalized });
  }

  sendControl(ctrl: PeerControl): boolean {
    return this.safeSend({ t: "ctrl", ctrl });
  }

  private safeSend(obj: unknown): boolean {
    if (this.closed || !this.dc || this.dc.readyState !== "open") {
      return false;
    }
    try {
      this.dc.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  async startVideo(): Promise<MediaStream> {
    if (!this.localStream) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      if (this.closed) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error("Peer session closed");
      }
      this.localStream = stream;
      for (const track of stream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }
    }
    return this.localStream;
  }

  stopVideo() {
    const stream = this.localStream;
    this.localStream = null;
    if (!stream) return;

    for (const track of stream.getTracks()) track.stop();
    for (const sender of this.pc.getSenders()) {
      if (sender.track) {
        try {
          this.pc.removeTrack(sender);
        } catch {}
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopVideo();
    this.pendingCandidates = [];

    if (this.dc) {
      this.dc.onopen = null;
      this.dc.onclose = null;
      this.dc.onerror = null;
      this.dc.onmessage = null;
      try {
        this.dc.close();
      } catch {}
      this.dc = null;
    }

    this.pc.onicecandidate = null;
    this.pc.onnegotiationneeded = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ondatachannel = null;
    try {
      this.pc.close();
    } catch {}
  }
}
