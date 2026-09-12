import crypto from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const protocol = require("../electron/online-world-protocol.cjs");

describe("online game world comment protocol", () => {
  it("splits and reconstructs records under the platform comment limit", () => {
    const record = {
      schema: protocol.FYOW_SCHEMAS.snapshot,
      snapshotId: crypto.randomUUID(),
      revision: 81,
      state: { map: Array.from({ length: 4096 }, (_, index) => ({ index, owner: `玩家-${index % 23}`, soldiers: index * 3 })) }
    };
    const parts = protocol.encodeCommentRecord(record);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part: string) => part.length <= 1000)).toBe(true);
    const assembled = protocol.assembleCommentRecords(parts.map((content: string, index: number) => ({ id: `c${index}`, content })));
    expect(assembled.incomplete).toEqual([]);
    expect(assembled.invalid).toEqual([]);
    expect(assembled.records[0].record).toEqual(record);
  });

  it("stops a full history scan once an intact snapshot covers older events", () => {
    const snapshot = { schema: protocol.FYOW_SCHEMAS.snapshot, snapshotId: "snap", revision: 50, stateHash: "x" };
    const event = { schema: protocol.FYOW_SCHEMAS.event, eventId: "event", revision: 42 };
    const comments = [...protocol.encodeCommentRecord(snapshot), ...protocol.encodeCommentRecord(event)].map((content: string, index: number) => ({ id: `${index}`, content }));
    const assembled = protocol.assembleCommentRecords(comments);
    expect(protocol.historyPageDecision({ pageComments: comments, assembled, fullScan: true })).toMatchObject({ stop: true, reason: "covered-by-snapshot", snapshotRevision: 50 });
  });

  it("does not read older pages when the newest page already contains a complete snapshot", () => {
    const snapshot = { schema: protocol.FYOW_SCHEMAS.snapshot, snapshotId: "only-snapshot", revision: 8, stateHash: "x" };
    const comments = protocol.encodeCommentRecord(snapshot).map((content: string, index: number) => ({ id: `s${index}`, content }));
    const assembled = protocol.assembleCommentRecords(comments);
    expect(protocol.historyPageDecision({ pageComments: comments, assembled, fullScan: true })).toMatchObject({ stop: true, reason: "covered-by-snapshot", snapshotRevision: 8 });
  });

  it("continues past a known comment when a newer record is split across the page boundary", () => {
    const snapshot = { schema: protocol.FYOW_SCHEMAS.snapshot, snapshotId: "large", revision: 9, state: { text: crypto.randomBytes(2400).toString("hex") } };
    const chunks = protocol.encodeCommentRecord(snapshot, 300).map((content: string, index: number) => ({ id: `part-${index}`, content }));
    expect(chunks.length).toBeGreaterThan(2);
    const page = [{ id: "known", content: "ordinary" }, ...chunks.slice(0, 2)];
    const assembled = protocol.assembleCommentRecords(page);
    expect(protocol.historyPageDecision({ pageComments: page, assembled, knownCommentIds: ["known"], fullScan: false })).toMatchObject({ stop: false, reason: "need-older-pages" });
  });

  it("signs reset directives and detects modification", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const directive = protocol.createResetDirective({ gameId: "g", seasonId: "s", oldWorkId: "old", newWorkId: "new", newWorkUrl: "https://example/new", exportSha256: "a".repeat(64) });
    const signed = protocol.signRecord(directive, privateKey);
    expect(protocol.verifySignedRecord(signed, publicKey)).toBe(true);
    expect(protocol.verifySignedRecord({ ...signed, newWorkId: "forged" }, publicKey)).toBe(false);
  });
});
