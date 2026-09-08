export type Role = "host" | "guest" | null;
export type RoomPhase = "idle" | "lobby" | "playing" | "closed";
export type MemberStatus = "online" | "ready" | "waiting" | "offline";

export interface PlayerProfile {
  id: string;
  platformName: string;
  displayName: string;
  basicInfo: string;
  appearance: string;
  info: string;
}

export interface RoomMember extends PlayerProfile {
  status: MemberStatus;
  channelUrl?: string;
}

export interface RoomState {
  roomId: string;
  role: Role;
  phase: RoomPhase;
  hostName: string;
  workSuffix: string;
  workTitle: string;
  members: RoomMember[];
  round: number;
  passwordVerifier?: string;
}

export interface DomainCandidate {
  label: string;
  origin: string;
  status: "untested" | "testing" | "online" | "slow" | "offline";
  latencyMs?: number;
}

export interface AppState {
  selectedOrigin: string;
  profile: PlayerProfile;
  room: RoomState;
}

export type PacketType =
  | "hello"
  | "challenge"
  | "join-proof"
  | "join-accept"
  | "members-sync"
  | "member-joined"
  | "member-removed"
  | "roster"
  | "lobby-chat"
  | "game-start"
  | "turn-submit"
  | "turn-state"
  | "round-input"
  | "round-input-ack"
  | "round-result"
  | "round-result-ack"
  | "plugin-settings-sync"
  | "work-settings-sync"
  | "model-sync"
  | "message-operation"
  | "message-operation-ack"
  | "room-chat-submit"
  | "room-chat-append"
  | "room-chat-sync-request"
  | "room-chat-sync"
  | "conversation-anchor"
  | "anchor-ready"
  | "chunk"
  | "ping"
  | "pong"
  | "error";

export interface Packet<T = unknown> {
  v: 1;
  id: string;
  roomId: string;
  type: PacketType;
  from: string;
  seq: number;
  ts: number;
  payload: T;
}

export interface RoundResultPayload {
  round: number;
  inputs: Array<{ playerId: string; displayName: string; text: string }>;
  mergedInput: string;
  output: string;
  model: string;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  generatedAt: number;
}
