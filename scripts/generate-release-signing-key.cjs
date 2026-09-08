const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const projectRoot = path.resolve(__dirname, "..");
const requestedOutput = argument("out");
if (!requestedOutput) throw new Error("请使用 --out=项目目录外的绝对路径指定密钥目录");
const outputDirectory = path.resolve(requestedOutput);
const relativeToProject = path.relative(projectRoot, outputDirectory);
if (!relativeToProject || (!relativeToProject.startsWith("..") && !path.isAbsolute(relativeToProject))) {
  throw new Error("发布私钥必须保存在项目目录之外");
}
const privateKeyPath = path.join(outputDirectory, "fengyue-release-ed25519-private.pem");
const publicKeyPath = path.join(outputDirectory, "fengyue-release-ed25519-public.pem");

if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) {
  throw new Error(`签名密钥已存在，已停止以避免覆盖：${outputDirectory}`);
}

fs.mkdirSync(outputDirectory, { recursive: true });
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });

const fingerprint = crypto
  .createHash("sha256")
  .update(publicKey.export({ type: "spki", format: "der" }))
  .digest("hex")
  .match(/.{1,4}/g)
  .join("-");

process.stdout.write(`签名密钥已生成。\n公钥：${publicKeyPath}\n公钥指纹：${fingerprint}\n`);
