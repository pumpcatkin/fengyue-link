import type { Packet, PacketType } from "./types";

export const WIRE_PREFIX = "§FYMP1§";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createPacket<T>(type: PacketType, roomId: string, from: string, seq: number, payload: T): Packet<T> {
  return { v: 1, id: makeId(), roomId, type, from, seq, ts: Date.now(), payload };
}

export function encodePacket(packet: Packet): string {
  const bytes = new TextEncoder().encode(JSON.stringify(packet));
  return WIRE_PREFIX + bytesToBase64Url(bytes);
}

export function decodePacket(text: string): Packet | null {
  const start = text.indexOf(WIRE_PREFIX);
  if (start < 0) return null;
  const wire = text.slice(start + WIRE_PREFIX.length).trim().split(/\s/)[0] ?? "";
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlToBytes(wire))) as Partial<Packet>;
    if (value.v !== 1 || typeof value.id !== "string" || typeof value.roomId !== "string" || typeof value.type !== "string") return null;
    return value as Packet;
  } catch {
    return null;
  }
}

export function decodePackets(text: string): Packet[] {
  const packets: Packet[] = [];
  let cursor = 0;
  while ((cursor = text.indexOf(WIRE_PREFIX, cursor)) >= 0) {
    const packet = decodePacket(text.slice(cursor));
    if (packet) packets.push(packet);
    cursor += WIRE_PREFIX.length;
  }
  return packets;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function derivePasswordVerifier(hostName: string, password: string): Promise<string> {
  return sha256(`FYMP/1\u0000${hostName.trim().toLocaleLowerCase()}\u0000${password}`);
}

export async function makeJoinProof(verifier: string, roomId: string, challenge: string, profileJson: string): Promise<string> {
  return sha256(`${verifier}\u0000${roomId}\u0000${challenge}\u0000${profileJson}`);
}
