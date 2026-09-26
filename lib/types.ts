// Shared types across client + API.

// Signal mailbox message types.
export type SignalType =
  | "request" // connection request (tap a dot)
  | "accept" // recipient accepted
  | "decline" // recipient declined (or auto-declined while busy)
  | "offer" // WebRTC SDP offer
  | "answer" // WebRTC SDP answer
  | "ice" // WebRTC ICE candidate
  | "end" // hang up / leave the connection
  | "wave"; // one-way hello to a stranger you are *not* in a conversation with
//             (Phase 4). Carries no payload, reserves nothing, and is the only
//             type that is legitimate outside a connection: there is no
//             connection to join and no data channel to relay it on, so it rides
//             the same transient mailbox a request does.

export interface PeerDot {
  id: string;
  lat: number;
  lng: number;
  busy: boolean;
}

export interface SignalMsg {
  id: string;
  fromId: string;
  toId: string;
  type: SignalType;
  payload: string | null;
  connectionId: string | null;
  createdAt: string;
}

export interface PollResponse {
  peers: PeerDot[];
  signals: SignalMsg[];
  endedConnectionIds: string[];
}
