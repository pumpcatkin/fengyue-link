import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cryptoLayer = require("../electron/online-world-crypto.cjs");

describe("online world private vault encryption", () => {
  it("seals player data for one X25519 identity and binds the game context", () => {
    const receiver = cryptoLayer.generateOnlineWorldIdentity();
    const stranger = cryptoLayer.generateOnlineWorldIdentity();
    const box = cryptoLayer.sealJson({ orientation: "women", generals: ["g1"] }, receiver.encryptionPublicKey, "work/season/player");
    expect(cryptoLayer.openSealedJson(box, receiver.encryptionPrivateKey, "work/season/player")).toEqual({ orientation: "women", generals: ["g1"] });
    expect(() => cryptoLayer.openSealedJson(box, stranger.encryptionPrivateKey, "work/season/player")).toThrow();
    expect(() => cryptoLayer.openSealedJson(box, receiver.encryptionPrivateKey, "other-context")).toThrow();
  });
});
