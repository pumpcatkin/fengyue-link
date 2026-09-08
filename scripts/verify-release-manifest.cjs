const fs = require("node:fs");
const path = require("node:path");
const {
  RELEASE_KEY_FINGERPRINT,
  exactReleasePage,
  sha256File,
  validateManifestForRelease,
  verifyManifestSignature
} = require("../electron/release-security.cjs");

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const projectRoot = path.resolve(__dirname, "..");
const manifestDirectory = path.resolve(argument("dir") || path.join(projectRoot, "release", "github"));
const manifestPath = path.join(manifestDirectory, "release-manifest.json");
const signaturePath = path.join(manifestDirectory, "release-manifest.sig");
for (const file of [manifestPath, signaturePath]) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`缺少验证文件：${file}`);
}

const manifestBytes = fs.readFileSync(manifestPath);
const signature = fs.readFileSync(signaturePath);
verifyManifestSignature(manifestBytes, signature);
const rawManifest = JSON.parse(manifestBytes.toString("utf8"));
const release = {
  id: null,
  tag: String(rawManifest.tag || ""),
  version: String(rawManifest.version || ""),
  htmlUrl: exactReleasePage(String(rawManifest.tag || ""))
};
const manifest = validateManifestForRelease(rawManifest, release);

const requestedInstaller = argument("installer");
if (requestedInstaller) {
  const installerPath = path.resolve(requestedInstaller);
  const stat = fs.statSync(installerPath);
  const digest = sha256File(installerPath);
  if (stat.size !== manifest.files.installer.size || digest !== manifest.files.installer.sha256) {
    throw new Error("安装包未通过签名发布清单的 SHA-256 完整性验证");
  }
}

process.stdout.write([
  `v${manifest.version} 发布清单签名有效。`,
  requestedInstaller ? "安装包完整性验证有效。" : "未指定 --installer，仅验证发布清单签名。",
  `唯一官方发布页：${manifest.officialReleasePage}`,
  `公钥指纹：${RELEASE_KEY_FINGERPRINT}`
].join("\n") + "\n");
