import { createPacket, decodePacket, decodePackets, derivePasswordVerifier, encodePacket, makeJoinProof } from "../src/protocol";
import { describe, expect, it } from "vitest";

describe("FYMP/1 protocol", () => {
  it("round-trips Chinese text without markdown corruption", () => {
    const packet = createPacket("lobby-chat", "room-1", "player-1", 1, { text: "你好，世界 § / + =" });
    expect(decodePacket(encodePacket(packet))).toEqual(packet);
  });

  it("extracts packets from rendered private-message text", () => {
    const one = createPacket("ping", "r", "a", 1, {});
    const two = createPacket("pong", "r", "b", 2, {});
    expect(decodePackets(`前文\n${encodePacket(one)}\n其它消息\n${encodePacket(two)}`).map(packet => packet.id)).toEqual([one.id, two.id]);
  });

  it("creates stable verifier and challenge-bound proof", async () => {
    const verifier = await derivePasswordVerifier("房主", "秘密");
    expect(verifier).toBe(await derivePasswordVerifier("房主", "秘密"));
    expect(await makeJoinProof(verifier, "r", "c1", "{}")).not.toBe(await makeJoinProof(verifier, "r", "c2", "{}"));
  });

  it("round-trips revisioned room roster control packets", () => {
    const joined = createPacket("member-joined", "room-1", "host-1", 8, {
      revision: 3,
      member: { id: "guest-2", displayName: "新成员" },
    });
    const removed = createPacket("member-removed", "room-1", "host-1", 9, {
      revision: 4,
      memberId: "guest-2",
    });
    expect(decodePacket(encodePacket(joined))).toEqual(joined);
    expect(decodePacket(encodePacket(removed))).toEqual(removed);
  });
});
