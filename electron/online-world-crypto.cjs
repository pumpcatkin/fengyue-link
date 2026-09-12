const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { canonicalJson } = require("./online-world-protocol.cjs");

function generateOnlineWorldIdentity() {
  const signing = crypto.generateKeyPairSync("ed25519");
  const encryption = crypto.generateKeyPairSync("x25519");
  return {
    version: 1,
    signingPublicKey: signing.publicKey.export({ type: "spki", format: "pem" }),
    signingPrivateKey: signing.privateKey.export({ type: "pkcs8", format: "pem" }),
    encryptionPublicKey: encryption.publicKey.export({ type: "spki", format: "pem" }),
    encryptionPrivateKey: encryption.privateKey.export({ type: "pkcs8", format: "pem" })
  };
}

function deriveSealedKey(privateKey, publicKey, context) {
  const shared = crypto.diffieHellman({
    privateKey: privateKey?.type === "private" ? privateKey : crypto.createPrivateKey(privateKey),
    publicKey: publicKey?.type === "public" ? publicKey : crypto.createPublicKey(publicKey)
  });
  return crypto.hkdfSync("sha256", shared, Buffer.from("FYOW/3 sealed box", "utf8"), Buffer.from(String(context || ""), "utf8"), 32);
}

function sealJson(value, receiverPublicKey, context = "") {
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const ephemeralPublicKey = ephemeral.publicKey.export({ type: "spki", format: "pem" });
  const key = deriveSealedKey(ephemeral.privateKey, receiverPublicKey, context);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(context), "utf8"));
  const plaintext = zlib.gzipSync(Buffer.from(canonicalJson(value), "utf8"), { level: 9, mtime: 0 });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: "X25519-HKDF-SHA256+A256GCM",
    compression: "gzip",
    ephemeralPublicKey,
    iv: iv.toString("base64url"),
    ciphertext: encrypted.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
}

function openSealedJson(box, receiverPrivateKey, context = "") {
  if (box?.version !== 1 || box?.algorithm !== "X25519-HKDF-SHA256+A256GCM") throw new Error("不支持的 FYOW 密文版本");
  const key = deriveSealedKey(receiverPrivateKey, box.ephemeralPublicKey, context);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(box.iv), "base64url"));
  decipher.setAAD(Buffer.from(String(context), "utf8"));
  decipher.setAuthTag(Buffer.from(String(box.tag), "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(String(box.ciphertext), "base64url")), decipher.final()]);
  const decoded = box.compression === "gzip" ? zlib.gunzipSync(plaintext, { maxOutputLength: 8 * 1024 * 1024 }) : plaintext;
  return JSON.parse(decoded.toString("utf8"));
}

function publicIdentity(identity) {
  return {
    signingPublicKey: identity.signingPublicKey,
    encryptionPublicKey: identity.encryptionPublicKey
  };
}

module.exports = { generateOnlineWorldIdentity, sealJson, openSealedJson, publicIdentity };
