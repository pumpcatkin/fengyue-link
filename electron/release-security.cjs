const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
let physicalFs = fs;
try {
  // Electron's regular fs presents app.asar as a virtual directory. Integrity
  // checks must read the physical archive bytes instead.
  physicalFs = require("original-fs");
} catch {}

const OFFICIAL_REPOSITORY = "pumpcatkin/fengyue-link";
const OFFICIAL_RELEASE_PAGE = `https://github.com/${OFFICIAL_REPOSITORY}/releases/latest`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases/latest`;
const RELEASE_MANIFEST_ASSET = "release-manifest.json";
const RELEASE_SIGNATURE_ASSET = "release-manifest.sig";
const RUNTIME_PROOF_DIRECTORY = "release-proof";
const RUNTIME_PROOF_MANIFEST_ASSET = "runtime-manifest.json";
const RUNTIME_PROOF_SIGNATURE_ASSET = "runtime-manifest.sig";
const LATEST_MANIFEST_URL = `${OFFICIAL_RELEASE_PAGE}/download/${RELEASE_MANIFEST_ASSET}`;
const LATEST_SIGNATURE_URL = `${OFFICIAL_RELEASE_PAGE}/download/${RELEASE_SIGNATURE_ASSET}`;
const RELEASE_MANIFEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAdx0xnuHbZGmfIvv+RCOR715+4mAJUoPS07c4jfES8OI=
-----END PUBLIC KEY-----`;
const RELEASE_KEY_FINGERPRINT = "7f2c-4d81-1494-1585-e7ec-6af4-7587-d891-8eab-5425-a939-693e-5adf-3343-b073-dcec";
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 4096;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
// GitHub can briefly reset an individual asset request while the desktop
// proxy is reconnecting. Keep a single startup deadline, but allow a few
// short attempts inside it so a transient transport error does not strand
// the login page.
const NETWORK_TIMEOUT_MS = 30000;
const NETWORK_RETRY_ATTEMPTS = 3;
const NETWORK_ATTEMPT_TIMEOUT_MS = 9000;
const NETWORK_RETRY_DELAYS_MS = [350, 800];
// These two files are the complete trust boundary for application code at
// runtime: app.asar contains the main/preload/renderer code and the executable
// is the Electron host which loads it. Keep this deliberately small so every
// startup can check it before credentials or a platform token are used.
const RUNTIME_INTEGRITY_FILE_COUNT = 2;

class ReleaseSecurityError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ReleaseSecurityError";
    this.code = code;
    this.details = details;
  }
}

function parseVersion(value) {
  const normalized = String(value || "").trim().replace(/^v/i, "");
  const match = normalized.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    raw: normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new ReleaseSecurityError("invalid-version", "版本号格式无效");
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] > b[field] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = physicalFs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = physicalFs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    physicalFs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function sha256FileAsync(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = physicalFs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    stream.on("data", chunk => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function decodeSignature(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length > MAX_SIGNATURE_BYTES) {
    throw new ReleaseSecurityError("invalid-signature", "发布清单签名格式无效");
  }
  const signature = Buffer.from(text, "base64");
  if (signature.length !== 64) throw new ReleaseSecurityError("invalid-signature", "发布清单签名长度无效");
  return signature;
}

function verifyManifestSignature(manifestBytes, signatureValue, publicKey = RELEASE_MANIFEST_PUBLIC_KEY) {
  const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
  if (!bytes.length || bytes.length > MAX_MANIFEST_BYTES) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单大小无效");
  }
  const signature = decodeSignature(signatureValue);
  if (!crypto.verify(null, bytes, publicKey, signature)) {
    throw new ReleaseSecurityError("signature-mismatch", "发布清单未通过官方数字签名验证");
  }
  return true;
}

function normalizeSha256(value, fieldName) {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ReleaseSecurityError("invalid-manifest", `${fieldName} 的 SHA-256 无效`);
  }
  return digest;
}

function exactReleasePage(tag) {
  return `https://github.com/${OFFICIAL_REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`;
}

function exactReleaseAssetUrl(tag, name) {
  return `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function officialInstallerName(version) {
  const normalized = parseVersion(version)?.raw;
  if (!normalized) throw new ReleaseSecurityError("invalid-version", "安装包版本号格式无效");
  return `fengyue-link-${normalized}-setup.exe`;
}

function validateReleaseMetadata(value) {
  if (!value || typeof value !== "object" || value.draft || value.prerelease) {
    throw new ReleaseSecurityError("invalid-release", "GitHub 最新版本信息无效");
  }
  const tag = String(value.tag_name || "").trim();
  const version = parseVersion(tag)?.raw;
  if (!version) throw new ReleaseSecurityError("invalid-release", "GitHub 最新版本标签无效");
  if (String(value.html_url || "") !== exactReleasePage(tag)) {
    throw new ReleaseSecurityError("invalid-release", "GitHub 发布页地址与唯一官方仓库不一致");
  }
  const assets = Array.isArray(value.assets) ? value.assets : [];
  const expectedPrefix = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases/assets/`;
  const resolveAsset = (name, maxBytes) => {
    const matches = assets.filter(asset => asset?.name === name && asset?.state === "uploaded");
    if (matches.length !== 1) throw new ReleaseSecurityError("missing-asset", `GitHub 版本缺少唯一的 ${name}`);
    const asset = matches[0];
    if (!String(asset.url || "").startsWith(expectedPrefix)) {
      throw new ReleaseSecurityError("invalid-release", `${name} 下载地址不属于唯一官方仓库`);
    }
    const size = Number(asset.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
      throw new ReleaseSecurityError("invalid-release", `${name} 文件大小无效`);
    }
    return { name, url: String(asset.url), size };
  };
  return {
    id: Number(value.id) || null,
    tag,
    version,
    htmlUrl: String(value.html_url),
    publishedAt: String(value.published_at || ""),
    manifestAsset: resolveAsset(RELEASE_MANIFEST_ASSET, MAX_MANIFEST_BYTES),
    signatureAsset: resolveAsset(RELEASE_SIGNATURE_ASSET, MAX_SIGNATURE_BYTES),
    installerAsset: resolveAsset(officialInstallerName(version), MAX_INSTALLER_BYTES)
  };
}

function validateManifestForRelease(value, release) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单不是有效对象");
  }
  if (value.schemaVersion !== 1 || value.product !== "fengyue-link" || value.appId !== "cc.aiero.fengyue.link") {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单的产品身份无效");
  }
  const version = parseVersion(value.version)?.raw;
  if (!version || version !== release.version || String(value.tag || "") !== release.tag) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单版本与 GitHub 标签不一致");
  }
  if (value.officialReleasePage !== OFFICIAL_RELEASE_PAGE || value.releasePage !== release.htmlUrl) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单指向的发布页不属于唯一官方仓库");
  }
  const appAsar = value.files?.appAsar;
  const executable = value.files?.executable;
  const installer = value.files?.installer;
  const appAsarSize = Number(appAsar?.size);
  const executableSize = Number(executable?.size);
  const installerSize = Number(installer?.size);
  if (appAsar?.path !== "resources/app.asar" || !Number.isSafeInteger(appAsarSize) || appAsarSize <= 0) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单中的 app.asar 信息无效");
  }
  if (String(installer?.name || "") !== officialInstallerName(version)
      || !Number.isSafeInteger(installerSize) || installerSize <= 0) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单中的安装包信息无效");
  }
  if (release.installerAsset && installerSize !== release.installerAsset.size) {
    throw new ReleaseSecurityError("asset-size-mismatch", "签名清单中的安装包大小与 GitHub 版本记录不一致");
  }
  if (executable?.name !== "风月联机工具.exe" || !Number.isSafeInteger(executableSize) || executableSize <= 0) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单中的主程序信息无效");
  }
  return {
    schemaVersion: 1,
    product: value.product,
    appId: value.appId,
    version,
    tag: release.tag,
    releasePage: release.htmlUrl,
    officialReleasePage: OFFICIAL_RELEASE_PAGE,
    publishedAt: String(value.publishedAt || ""),
    files: {
      appAsar: { path: appAsar.path, size: appAsarSize, sha256: normalizeSha256(appAsar.sha256, "app.asar") },
      executable: { name: executable.name, size: executableSize, sha256: normalizeSha256(executable.sha256, "主程序") },
      installer: { name: String(installer.name), size: installerSize, sha256: normalizeSha256(installer.sha256, "安装包") }
    }
  };
}

function validateManifestForRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单不是有效对象");
  }
  if (value.schemaVersion !== 1 || value.product !== "fengyue-link" || value.appId !== "cc.aiero.fengyue.link") {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单的产品身份无效");
  }
  const version = parseVersion(value.version)?.raw;
  const tag = String(value.tag || "").trim();
  if (!version || tag !== `v${version}`) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单版本与标签不一致");
  }
  if (value.officialReleasePage !== OFFICIAL_RELEASE_PAGE || value.releasePage !== exactReleasePage(tag)) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单指向的发布页不属于唯一官方仓库");
  }
  const appAsar = value.files?.appAsar;
  const executable = value.files?.executable;
  const appAsarSize = Number(appAsar?.size);
  const executableSize = Number(executable?.size);
  if (appAsar?.path !== "resources/app.asar" || !Number.isSafeInteger(appAsarSize) || appAsarSize <= 0) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单中的 app.asar 信息无效");
  }
  if (executable?.name !== "风月联机工具.exe" || !Number.isSafeInteger(executableSize) || executableSize <= 0) {
    throw new ReleaseSecurityError("invalid-manifest", "发布清单中的主程序信息无效");
  }
  return {
    version,
    tag,
    releasePage: exactReleasePage(tag),
    files: {
      appAsar: { path: appAsar.path, size: appAsarSize, sha256: normalizeSha256(appAsar.sha256, "app.asar") },
      executable: { name: executable.name, size: executableSize, sha256: normalizeSha256(executable.sha256, "主程序") }
    }
  };
}

async function readBoundedResponse(response, maxBytes, label) {
  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    throw new ReleaseSecurityError("network-response", `${label}请求失败（HTTP ${status}）`, {
      status,
      retryable: status === 408 || status === 429 || status >= 500
    });
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ReleaseSecurityError("oversized-response", `${label}超过安全大小上限`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) {
    throw new ReleaseSecurityError("oversized-response", `${label}大小无效`);
  }
  return bytes;
}

class ReleaseSecurityGate {
  constructor(options) {
    this.net = options.net;
    this.appVersion = String(options.appVersion || "");
    this.isPackaged = Boolean(options.isPackaged);
    this.resourcesPath = String(options.resourcesPath || "");
    this.executablePath = String(options.executablePath || "");
    this.userDataPath = String(options.userDataPath || "");
    this.runtimeProofPublicKey = options.runtimeProofPublicKey || RELEASE_MANIFEST_PUBLIC_KEY;
    const requestedTimeout = Number(options.networkTimeoutMs);
    this.networkTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(Math.max(Math.trunc(requestedTimeout), 250), NETWORK_TIMEOUT_MS)
      : NETWORK_TIMEOUT_MS;
    this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : () => {};
    this.inFlight = null;
    this.initializationPromise = null;
    this.currentArtifact = null;
    this.latestVerification = null;
    this.securityState = this.isPackaged
      ? this.makeState("required", false, "每次启动都会对照版本号")
      : this.makeState("development", true, "开发模式不进行版本号对照");
  }

  makeState(status, verified, message, extra = {}) {
    return {
      status,
      verified: Boolean(verified),
      message: String(message || ""),
      currentVersion: this.appVersion,
      latestVersion: null,
      officialReleasePage: OFFICIAL_RELEASE_PAGE,
      checkedAt: null,
      source: null,
      ...extra
    };
  }

  state() {
    return { ...this.securityState };
  }

  setState(status, verified, message, extra = {}) {
    this.securityState = this.makeState(status, verified, message, extra);
    this.onStateChange(this.state());
    return this.state();
  }

  artifactPath() {
    return path.join(this.resourcesPath, "app.asar");
  }

  async readCurrentArtifacts() {
    const appAsarFile = this.artifactPath();
    if (!physicalFs.existsSync(appAsarFile) || !physicalFs.statSync(appAsarFile).isFile()) {
      throw new ReleaseSecurityError("missing-artifact", `安装目录缺少需要验证的 app.asar：${appAsarFile}`);
    }
    if (!this.executablePath || !physicalFs.existsSync(this.executablePath) || !physicalFs.statSync(this.executablePath).isFile()) {
      throw new ReleaseSecurityError("missing-artifact", "安装目录缺少需要验证的主程序");
    }
    const appAsarStat = physicalFs.statSync(appAsarFile);
    const executableStat = physicalFs.statSync(this.executablePath);
    const [appAsarSha256, executableSha256] = await Promise.all([
      sha256FileAsync(appAsarFile),
      sha256FileAsync(this.executablePath)
    ]);
    return {
      appAsar: { file: appAsarFile, size: appAsarStat.size, sha256: appAsarSha256 },
      executable: { file: this.executablePath, size: executableStat.size, sha256: executableSha256 }
    };
  }

  async initialize() {
    if (!this.isPackaged) return this.state();
    // A failed startup check must be retryable from the login action. A
    // successful check remains authoritative for this process lifetime.
    if (this.securityState.verified) return this.state();
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeStartupVerification().finally(() => {
        this.initializationPromise = null;
      });
    }
    return this.initializationPromise;
  }

  async initializeStartupVerification() {
    if (!this.inFlight) this.inFlight = this.verifyBundledRuntime().finally(() => { this.inFlight = null; });
    try {
      return await this.inFlight;
    } catch {
      return this.state();
    }
  }

  runtimeProofPaths() {
    const directory = path.join(this.resourcesPath, RUNTIME_PROOF_DIRECTORY);
    return {
      manifest: path.join(directory, RUNTIME_PROOF_MANIFEST_ASSET),
      signature: path.join(directory, RUNTIME_PROOF_SIGNATURE_ASSET)
    };
  }

  readBundledRuntimeProof() {
    const files = this.runtimeProofPaths();
    for (const [label, file, maxBytes] of [
      [RUNTIME_PROOF_MANIFEST_ASSET, files.manifest, MAX_MANIFEST_BYTES],
      [RUNTIME_PROOF_SIGNATURE_ASSET, files.signature, MAX_SIGNATURE_BYTES]
    ]) {
      if (!physicalFs.existsSync(file) || !physicalFs.statSync(file).isFile()) {
        throw new ReleaseSecurityError("missing-runtime-proof", `安装目录缺少 ${label}`);
      }
      const size = physicalFs.statSync(file).size;
      if (size <= 0 || size > maxBytes) {
        throw new ReleaseSecurityError("invalid-runtime-proof", `${label} 大小无效`);
      }
    }
    const manifestBytes = physicalFs.readFileSync(files.manifest);
    const signatureBytes = physicalFs.readFileSync(files.signature);
    verifyManifestSignature(manifestBytes, signatureBytes, this.runtimeProofPublicKey);
    let rawManifest;
    try { rawManifest = JSON.parse(manifestBytes.toString("utf8")); }
    catch { throw new ReleaseSecurityError("invalid-manifest", "内置运行证明无法解析"); }
    return validateManifestForRuntime(rawManifest);
  }

  async verifyBundledRuntime() {
    if (!this.isPackaged) return this.state();
    this.setState("checking", false, "正在对照版本号…");
    try {
      const manifest = this.readBundledRuntimeProof();
      if (manifest.version !== parseVersion(this.appVersion)?.raw) {
        throw new ReleaseSecurityError("runtime-version-mismatch", "内置运行证明与程序版本不一致");
      }
      const artifacts = await this.readCurrentArtifacts();
      if (artifacts.appAsar.size !== manifest.files.appAsar.size || artifacts.appAsar.sha256 !== manifest.files.appAsar.sha256
          || artifacts.executable.size !== manifest.files.executable.size || artifacts.executable.sha256 !== manifest.files.executable.sha256) {
        throw new ReleaseSecurityError("artifact-mismatch", "本地程序文件与官方签名版本不一致，可能已损坏或被修改");
      }
      this.currentArtifact = artifacts;
      return this.setState("verified", true, `版本号对照完成：v${this.appVersion}`, {
        latestVersion: manifest.version,
        checkedAt: new Date().toISOString(),
        source: "bundled-signed-runtime-proof",
        releasePage: manifest.releasePage,
        verifiedFileCount: RUNTIME_INTEGRITY_FILE_COUNT
      });
    } catch (error) {
      this.setFailure(error);
      throw error;
    }
  }

  async fetch(url, options, maxBytes, label, deadlineAt) {
    let lastError = null;
    for (let attempt = 0; attempt < NETWORK_RETRY_ATTEMPTS; attempt += 1) {
      const remainingMs = Math.trunc(Number(deadlineAt) - Date.now());
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        throw new ReleaseSecurityError("network-timeout", `${label}连接超时`);
      }
      const attemptTimeout = Math.min(remainingMs, NETWORK_ATTEMPT_TIMEOUT_MS);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeout);
      try {
        const response = await this.net.fetch(url, { ...options, redirect: "follow", signal: controller.signal });
        return await readBoundedResponse(response, maxBytes, label);
      } catch (error) {
        const retryableResponse = error instanceof ReleaseSecurityError
          && error.code === "network-response"
          && Boolean(error.details?.retryable);
        if (error instanceof ReleaseSecurityError
            && !["network-timeout", "network-error"].includes(error.code)
            && !retryableResponse) throw error;
        const timedOut = error?.name === "AbortError" || error?.code === "network-timeout";
        lastError = error instanceof ReleaseSecurityError
          ? error
          : new ReleaseSecurityError(timedOut ? "network-timeout" : "network-error", timedOut ? `${label}连接超时` : `${label}连接失败`);
      } finally {
        clearTimeout(timer);
      }
      if (attempt + 1 >= NETWORK_RETRY_ATTEMPTS) break;
      const delayMs = NETWORK_RETRY_DELAYS_MS[attempt] || 0;
      const afterAttemptMs = Math.trunc(Number(deadlineAt) - Date.now());
      if (afterAttemptMs <= delayMs) break;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    throw lastError || new ReleaseSecurityError("network-error", `${label}连接失败`);
  }

  async fetchLatestVerification(deadlineAt) {
    const assetHeaders = {
      Accept: "application/octet-stream",
      "User-Agent": `fengyue-link/${this.appVersion}`
    };
    const [manifestBytes, signatureBytes] = await Promise.all([
      this.fetch(LATEST_MANIFEST_URL, { headers: assetHeaders }, MAX_MANIFEST_BYTES, RELEASE_MANIFEST_ASSET, deadlineAt),
      this.fetch(LATEST_SIGNATURE_URL, { headers: assetHeaders }, MAX_SIGNATURE_BYTES, RELEASE_SIGNATURE_ASSET, deadlineAt)
    ]);
    verifyManifestSignature(manifestBytes, signatureBytes);
    let rawManifest;
    try { rawManifest = JSON.parse(manifestBytes.toString("utf8")); }
    catch { throw new ReleaseSecurityError("invalid-manifest", "发布清单无法解析"); }
    const version = parseVersion(rawManifest?.version)?.raw;
    const tag = String(rawManifest?.tag || "").trim();
    if (!version || tag !== `v${version}`) {
      throw new ReleaseSecurityError("invalid-manifest", "发布清单版本与标签不一致");
    }
    const installerName = officialInstallerName(version);
    const installerSize = Number(rawManifest?.files?.installer?.size);
    const release = {
      id: null,
      tag,
      version,
      htmlUrl: exactReleasePage(tag),
      publishedAt: String(rawManifest?.publishedAt || ""),
      manifestAsset: { name: RELEASE_MANIFEST_ASSET, url: LATEST_MANIFEST_URL, size: manifestBytes.length },
      signatureAsset: { name: RELEASE_SIGNATURE_ASSET, url: LATEST_SIGNATURE_URL, size: signatureBytes.length },
      installerAsset: { name: installerName, url: exactReleaseAssetUrl(tag, installerName), size: installerSize }
    };
    const manifest = validateManifestForRelease(rawManifest, release);
    const result = { release, manifest, manifestBytes, signatureBytes };
    this.latestVerification = result;
    return result;
  }

  async fetchRuntimeVerification(deadlineAt) {
    const assetHeaders = {
      Accept: "application/octet-stream",
      "User-Agent": `fengyue-link/${this.appVersion}`
    };
    const [manifestBytes, signatureBytes] = await Promise.all([
      this.fetch(LATEST_MANIFEST_URL, { headers: assetHeaders }, MAX_MANIFEST_BYTES, RELEASE_MANIFEST_ASSET, deadlineAt),
      this.fetch(LATEST_SIGNATURE_URL, { headers: assetHeaders }, MAX_SIGNATURE_BYTES, RELEASE_SIGNATURE_ASSET, deadlineAt)
    ]);
    verifyManifestSignature(manifestBytes, signatureBytes);
    let rawManifest;
    try { rawManifest = JSON.parse(manifestBytes.toString("utf8")); }
    catch { throw new ReleaseSecurityError("invalid-manifest", "发布清单无法解析"); }
    const manifest = validateManifestForRuntime(rawManifest);
    return { manifest, manifestBytes, signatureBytes };
  }

  signedUpdateSnapshot(result = this.latestVerification) {
    if (!result?.release || !result?.manifest) return null;
    return {
      version: result.manifest.version,
      tag: result.release.tag,
      releasePage: result.release.htmlUrl,
      installer: {
        name: result.manifest.files.installer.name,
        size: result.manifest.files.installer.size,
        sha256: result.manifest.files.installer.sha256,
        assetUrl: result.release.installerAsset.url
      }
    };
  }

  async fetchSignedUpdate(expectedVersion = null) {
    const expected = expectedVersion ? parseVersion(expectedVersion)?.raw : null;
    if (expectedVersion && !expected) throw new ReleaseSecurityError("invalid-version", "待更新版本号格式无效");
    let result = this.latestVerification;
    if (!result || (expected && result.manifest.version !== expected)) {
      result = await this.fetchLatestVerification(Date.now() + this.networkTimeoutMs);
    }
    if (expected && result.manifest.version !== expected) {
      throw new ReleaseSecurityError("update-version-mismatch", "自动更新版本与官方签名版本不一致");
    }
    return this.signedUpdateSnapshot(result);
  }

  setFailure(error) {
    const issue = error instanceof ReleaseSecurityError
      ? error
      : new ReleaseSecurityError("verification-failed", "官方版本安全验证失败");
    const status = issue.code === "update-required"
      ? "update-required"
      : ["artifact-mismatch", "signature-mismatch", "unregistered-version", "runtime-version-mismatch", "missing-runtime-proof", "invalid-runtime-proof"].includes(issue.code)
        ? "blocked"
        : "unavailable";
    const temporaryNetworkIssue = ["network-timeout", "network-error"].includes(issue.code)
      || (issue.code === "network-response" && Boolean(issue.details?.retryable));
    const publicMessage = issue.code === "update-required"
      ? `发现新版本 v${issue.details?.latestVersion || ""}`.trim()
      : temporaryNetworkIssue
        ? "版本号对照暂未完成"
        : "版本号对照未通过";
    return this.setState(status, false, publicMessage, {
      errorCode: issue.code,
      latestVersion: issue.details?.latestVersion || null,
      releasePage: issue.details?.releasePage || null
    });
  }

  async verifyOnline() {
    if (!this.isPackaged) return this.state();
    this.setState("checking", false, "正在对照版本号…");
    try {
      const deadlineAt = Date.now() + this.networkTimeoutMs;
      const result = await this.fetchRuntimeVerification(deadlineAt);
      const comparison = compareVersions(this.appVersion, result.manifest.version);
      if (comparison < 0) {
        throw new ReleaseSecurityError("update-required", `发现新版本 v${result.manifest.version}`, {
          latestVersion: result.manifest.version,
          releasePage: result.manifest.releasePage
        });
      }
      if (comparison > 0) {
        throw new ReleaseSecurityError("unregistered-version", `当前 v${this.appVersion} 尚未在唯一官方发布页登记`);
      }
      const artifacts = await this.readCurrentArtifacts();
      if (artifacts.appAsar.size !== result.manifest.files.appAsar.size || artifacts.appAsar.sha256 !== result.manifest.files.appAsar.sha256
          || artifacts.executable.size !== result.manifest.files.executable.size || artifacts.executable.sha256 !== result.manifest.files.executable.sha256) {
        throw new ReleaseSecurityError("artifact-mismatch", "本地程序文件与官方签名版本不一致，可能已损坏或被修改");
      }
      this.currentArtifact = artifacts;
      const checkedAt = new Date().toISOString();
      const verifiedState = this.setState("verified", true, `版本号对照完成：v${this.appVersion}`, {
        latestVersion: result.manifest.version,
        checkedAt,
        source: "startup-github-signed-manifest",
        releasePage: result.manifest.releasePage,
        verifiedFileCount: RUNTIME_INTEGRITY_FILE_COUNT
      });
      return verifiedState;
    } catch (error) {
      const failureState = this.setFailure(error);
      throw error;
    }
  }

  async ensureVerified() {
    await this.initialize();
    if (!this.isPackaged) return this.state();
    if (this.securityState.verified) return this.state();
    throw new ReleaseSecurityError(
      this.securityState.errorCode || "verification-failed",
      this.securityState.message || "版本号对照未通过"
    );
  }
}

module.exports = {
  OFFICIAL_REPOSITORY,
  OFFICIAL_RELEASE_PAGE,
  LATEST_RELEASE_API,
  LATEST_MANIFEST_URL,
  LATEST_SIGNATURE_URL,
  RELEASE_MANIFEST_ASSET,
  RELEASE_SIGNATURE_ASSET,
  RUNTIME_PROOF_DIRECTORY,
  RUNTIME_PROOF_MANIFEST_ASSET,
  RUNTIME_PROOF_SIGNATURE_ASSET,
  MAX_INSTALLER_BYTES,
  RELEASE_MANIFEST_PUBLIC_KEY,
  RELEASE_KEY_FINGERPRINT,
  ReleaseSecurityError,
  ReleaseSecurityGate,
  parseVersion,
  compareVersions,
  sha256File,
  sha256FileAsync,
  verifyManifestSignature,
  validateReleaseMetadata,
  validateManifestForRelease,
  validateManifestForRuntime,
  exactReleasePage,
  exactReleaseAssetUrl,
  officialInstallerName,
  RUNTIME_INTEGRITY_FILE_COUNT
};
