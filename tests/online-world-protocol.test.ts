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
    expect(parts.every((part: string) => part.length <= 980)).toBe(true);
    expect(parts.slice(0, -1).every((part: string) => part.endsWith(protocol.FYOW_CONTINUE_MARKER))).toBe(true);
    expect(parts.at(-1).endsWith(protocol.FYOW_CONTINUE_MARKER)).toBe(false);
    const assembled = protocol.assembleCommentRecords(parts.map((content: string, index: number) => ({ id: `c${index}`, content })));
    expect(assembled.incomplete).toEqual([]);
    expect(assembled.invalid).toEqual([]);
    expect(assembled.records[0].record).toEqual(record);
  });

  it("classifies public territory changes separately from private actions", () => {
    const record = { schema: protocol.FYOW_SCHEMAS.mapDelta, mapDeltaId: "map-1", changes: { cells: { "2,3": { ownerAccountId: "a", soldiers: 20, generalIds: [] } }, generals: {} } };
    const comments = protocol.encodeCommentRecord(record).map((content: string, index: number) => ({ id: `m${index}`, content }));
    const assembled = protocol.assembleCommentRecords(comments);
    expect(assembled.records).toHaveLength(1);
    expect(assembled.records[0].kind).toBe("MAP");
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

  it("classifies signed author moderation directives as authority records", () => {
    const directive = { schema: protocol.FYOW_SCHEMAS.authority, authorityId: "auth-1", type: "player-ban", targetAccountId: "player" };
    const comments = protocol.encodeCommentRecord(directive).map((content: string, index: number) => ({ id: `a${index}`, content }));
    const assembled = protocol.assembleCommentRecords(comments);
    expect(assembled.records[0].kind).toBe("AUTH");
    expect(assembled.records[0].record).toEqual(directive);
  });

  it("keeps legacy root fragments readable and binds native replies to one author and root", () => {
    const record = { schema: protocol.FYOW_SCHEMAS.worldChat, messageId: "threaded-chat", text: crypto.randomBytes(2500).toString("hex") };
    const parts = protocol.encodeCommentRecord(record);
    const legacy = parts.map((content: string, index: number) => ({ id: `legacy-${index}`, account_id: "player", content: content.replace(/§CONTINUE§$/, "") }));
    expect(protocol.assembleCommentRecords(legacy).records[0].record).toEqual(record);
    const threaded = parts.map((content: string, index: number) => ({ id: `chunk-${index}`, account_id: "player", ...(index ? { parent_id: "chunk-0" } : {}), content }));
    expect(protocol.assembleCommentRecords(threaded).records[0].record).toEqual(record);
    const crossAuthor = threaded.map((item: any, index: number) => index ? { ...item, account_id: "intruder" } : item);
    expect(protocol.assembleCommentRecords(crossAuthor).records).toEqual([]);
    const crossRoot = threaded.map((item: any, index: number) => index === 1 ? { ...item, parent_id: "unrelated-root" } : item);
    expect(protocol.assembleCommentRecords(crossRoot).records).toEqual([]);
    expect(protocol.assembleCommentRecords(crossRoot).invalid[0].error).toMatch(/原评论/);
  });

  it("rejects truncated content, inconsistent continuation markers and mismatched wire headers", () => {
    const record = { schema: protocol.FYOW_SCHEMAS.worldChat, messageId: "checked-chat", text: crypto.randomBytes(1700).toString("hex") };
    const parts = protocol.encodeCommentRecord(record);
    const wrap = (content: string, index: number) => ({ id: `chunk-${index}`, account_id: "player", content });
    const truncated = parts.map((content: string, index: number) => wrap(index === 1 ? content.slice(0, -20) : content, index));
    expect(protocol.assembleCommentRecords(truncated).records).toEqual([]);
    const missingMarker = parts.map((content: string, index: number) => wrap(index === 0 ? content.replace(/§CONTINUE§$/, "") : content, index));
    expect(protocol.assembleCommentRecords(missingMarker).invalid[0].error).toMatch(/续接标记/);
    const forgedKind = parts.map((content: string, index: number) => wrap(content.replace("§WCHAT§", "§AUTH§"), index));
    expect(protocol.assembleCommentRecords(forgedKind).invalid[0].error).toMatch(/类型或编号/);
  });

  it("extracts large native children lists without walking account metadata or losing their root provenance", () => {
    const record = { schema: protocol.FYOW_SCHEMAS.snapshot, snapshotId: "nested-native", revision: 8, state: { archive: crypto.randomBytes(70_000).toString("hex") } };
    const chunks = protocol.encodeCommentRecord(record);
    expect(chunks.length).toBeGreaterThan(120);
    const account = () => ({
      id: "author",
      medals: Array.from({ length: 100 }, (_, index) => ({ id: `not-a-comment-${index}`, content: "profile metadata", nested: { avatar: { urls: ["avatar"] } } }))
    });
    const children = chunks.slice(1).map((content: string, index: number) => ({
      id: `reply-${index}`, account: account(), content, created_at: 200 + index
    }));
    const nestedLast = children.pop();
    (children[0] as any).replies = { items: [nestedLast] };
    const root = { id: "root", account: account(), content: chunks[0], created_at: 100, children };
    const extracted = protocol.extractCommentItems({ data: { items: [root] } });
    expect(extracted).toHaveLength(chunks.length);
    expect(extracted.rootCount).toBe(1);
    expect(extracted.rootIds).toEqual(["root"]);
    expect(Object.keys(extracted)).not.toContain("rootCount");
    expect(extracted.slice(1).every((item: any) => item._fyowRootId === "root")).toBe(true);
    expect(extracted.some((item: any) => item.id.startsWith("not-a-comment"))).toBe(false);
    expect(protocol.assembleCommentRecords(extracted).records[0].record).toEqual(record);
  });

  it("extracts all 512 comment fragments even when each one has a large profile object", () => {
    const children = Array.from({ length: 511 }, (_, index) => ({
      id: `fragment-${index + 1}`, content: "fragment", account: { id: "author", medals: Array.from({ length: 100 }, () => ({ icon: { theme: {} } })) }
    }));
    const extracted = protocol.extractCommentItems([{ id: "fragment-0", content: "root", children }]);
    expect(extracted).toHaveLength(512);
    expect(extracted.rootCount).toBe(1);
    expect(extracted.at(-1)._fyowRootId).toBe("fragment-0");
  });

  it("assembles retried roots independently and ignores orphan copies once the same record is complete", () => {
    const record = { schema: protocol.FYOW_SCHEMAS.snapshot, snapshotId: "retry-roots", revision: 7, state: { archive: crypto.randomBytes(2500).toString("hex") } };
    const chunks = protocol.encodeCommentRecord(record);
    const branch = (id: string) => chunks.map((content: string, index: number) => ({
      id: index ? `${id}-reply-${index}` : id, account_id: "author", content, ...(index ? { parent_id: id } : {})
    }));
    const first = branch("first");
    const second = branch("second");
    const recovered = protocol.assembleCommentRecords([first[0], ...second]);
    expect(recovered.records).toHaveLength(1);
    expect(recovered.records[0].root.id).toBe("second");
    expect(recovered.records[0].record).toEqual(record);
    expect(recovered.incomplete).toEqual([]);
    expect(recovered.invalid).toEqual([]);
    const duplicated = protocol.assembleCommentRecords([...first, ...second]);
    expect(duplicated.records).toHaveLength(2);
    expect(duplicated.records.every((item: any) => item.sources.every((source: any) => !source.parent_id || source.parent_id === item.root.id))).toBe(true);
    expect(duplicated.incomplete).toEqual([]);
    expect(duplicated.invalid).toEqual([]);
  });
});
