const { app, BrowserWindow, WebContentsView, ipcMain, net, session, shell, Menu, safeStorage, clipboard, dialog, globalShortcut } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const zlib = require("node:zlib");
const { atomicWriteFileSync, atomicWriteJsonSync, readJsonWithBackupSync, sanitizeLogDetail, pruneSessionLogDirectory } = require("./runtime-utils.cjs");
const {
  upsertMultiplayerPrefix,
  upsertMultiplayerProfiles,
  PREFIX_ADAPTER_SCHEMA,
  PREFIX_ADAPTER_MAX_SAMPLES,
  normalizePrefixAdapter,
  parsePrefixAdapterSuggestion,
  formatPrefixAdapterRequest,
  isExcludedPrefixAdapterSample,
  getPathValue,
  resolveConversationPromptFields,
  buildConversationPromptPatch,
  formatMultiplayerTurnInput
} = require("./multiplayer-prompts.cjs");
const {
  PLUGIN_PHASES,
  EFFECT_JUDGE_PLUGIN_ID,
  normalizePluginSettings,
  normalizeEffectJudgeSettings,
  buildEffectJudgeRequest,
  parseEffectJudgeResponse,
  mapEffectDegreesToFaces,
  applyEffectJudgeSelections,
  runPluginStack
} = require("./plugin-pipeline.cjs");
const {
  PERSPECTIVE_PLUGIN_ID, PERSPECTIVE_APP_ID, PERSPECTIVE_MAX_ATTEMPTS, PERSPECTIVE_ATTEMPT_TIMEOUT_MS, WITHHELD_OUTPUT,
  normalizePerspectiveSettings, upsertPerspectivePrefix, buildPerspectiveRequest,
  parsePerspectiveResponse, outputFingerprint, personalizeResult
} = require("./perspective-split.cjs");
const { publicGlobalConfig, countConfigCharacters, changedGlobalFields } = require("./work-settings.cjs");
const { mutatePlatformConversation, updateConversationAnchors } = require("./conversation-management.cjs");
const { modelMetric, selectGuestModel, matchesConfiguredModel } = require("./guest-model-policy.cjs");
const { installGuestOutputGuard } = require("./guest-output-guard.cjs");
const { buildPerspectiveRetryModelPlan, modelKey: perspectiveRetryModelKey } = require("./perspective-retry-model.cjs");
const {
  OFFICIAL_RELEASE_PAGE,
  ReleaseSecurityGate
} = require("./release-security.cjs");
const { OfficialUpdateService } = require("./update-service.cjs");
const { configuredAuthorUrl, publicAuthorInfo } = require("./author-info.cjs");
const { orderLoginCandidates, loginError, assertLoginActive, waitForLoginTask, pauseLogin, platformLoginError, runLoginFailover } = require("./login-failover.cjs");
const { requestPlatformJson, platformRequestError } = require("./platform-transport.cjs");
const {
  OFFICIAL_DOMAIN_DIRECTORY_URLS,
  FALLBACK_PLATFORM_ORIGINS,
  normalizePublishedOrigin,
  mergePublishedOrigins
} = require("./domain-directory.cjs");
const { OnlineWorldService } = require("./online-world-service.cjs");
const { generateOnlineWorldIdentity } = require("./online-world-crypto.cjs");
const {
  validateGameCard,
  summarizeGameCard,
  gameCardLibraryKey,
  loadGameCardLibrary,
  saveGameCardLibrary,
  readGameCardFile,
  scanGameCardDirectory,
  removeGameCardDirectoryFiles,
  rebindGameCard
} = require("./online-world-card.cjs");
const { consumeModelEventStream, createModelRequestPayload, normalizeModelPoints } = require("./model-stream.cjs");
const { normalizeCatalog, runAutoModel, abortError, assertActive } = require("./auto-model-router.cjs");

const DEFAULT_ORIGIN = "https://staging.aiero.cc";
const RELEASE_CHANNEL = "official";
const APPLICATION_ID = "cc.aiero.fengyue.link";
const APPLICATION_NAME = "风月联机工具";
const DOMAIN_DIRECTORY_URLS = OFFICIAL_DOMAIN_DIRECTORY_URLS;
const OFFICIAL_FALLBACK_ORIGINS = FALLBACK_PLATFORM_ORIGINS;
const TRUSTED_PLATFORM_ORIGINS = new Set([DEFAULT_ORIGIN, ...OFFICIAL_FALLBACK_ORIGINS]);
const WORK_PATH = /\/(?:zh\/)?explore\/installed\/[^/?#]+/;
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WIRE_PREFIX = "§FYMP1§";
const ADMIN_EMAIL = "8zhua@test.com";
const PREFIX_ADAPTER_APP_ID = "649fbb98-07b3-4cbd-a7ed-3e3d224dca87";
const EFFECT_JUDGE_APP_ID = "8769d311-9a37-48e0-9b19-caf7590c6f15";

app.setName(APPLICATION_NAME);

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(item => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function safeProfileId(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "default";
}

function instanceLaunchSpec(profileId, packaged = app.isPackaged, executable = process.execPath, projectRoot = PROJECT_ROOT) {
  const id = safeProfileId(profileId);
  return packaged
    ? { command: executable, args: [`--profile=${id}`], cwd: path.dirname(executable) }
    : { command: executable, args: [projectRoot, `--profile=${id}`], cwd: projectRoot };
}

const spawnedInstanceProcesses = new Set();

function stopSpawnedInstanceProcesses() {
  for (const child of [...spawnedInstanceProcesses]) {
    const pid = Number(child?.pid) || 0;
    if (!pid) continue;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        }).unref();
      } else {
        process.kill(-pid, "SIGTERM");
      }
    } catch {}
  }
  spawnedInstanceProcesses.clear();
}

function selectedOriginPath(profileId) {
  return path.join(app.getPath("userData"), "node-selections", `${safeProfileId(profileId)}.json`);
}

function loadSelectedOrigin(profileId) {
  const file = selectedOriginPath(profileId);
  if (!fs.existsSync(file)) return null;
  try {
    const origin = normalizeOrigin(readJsonWithBackupSync(fs, file, value => TRUSTED_PLATFORM_ORIGINS.has(normalizeOrigin(value?.origin))).value?.origin);
    return TRUSTED_PLATFORM_ORIGINS.has(origin) ? origin : null;
  }
  catch { return null; }
}

function saveSelectedOrigin(profileId, origin) {
  const file = selectedOriginPath(profileId);
  const normalized = normalizeOrigin(origin);
  if (!TRUSTED_PLATFORM_ORIGINS.has(normalized)) throw new Error("拒绝保存未受信任的平台节点");
  atomicWriteJsonSync(fs, file, { version: 1, origin: normalized, updatedAt: Date.now() }, { pretty: true });
}

function profileInstanceLockPath(profileId) {
  return path.join(app.getPath("userData"), "instance-locks", `${safeProfileId(profileId)}.lock`);
}

function processIsAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch { return false; }
}

function acquireProfileInstanceLock(profileId) {
  const file = profileInstanceLockPath(profileId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, profileId, createdAt: Date.now() }), "utf8");
      fs.closeSync(descriptor);
      descriptor = null;
      return { acquired: true, file, ownerPid: process.pid };
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (error?.code !== "EEXIST") return { acquired: false, file, ownerPid: null, error: error?.message || String(error) };
      let ownerPid = null;
      try { ownerPid = Number(JSON.parse(fs.readFileSync(file, "utf8"))?.pid) || null; } catch {}
      if (ownerPid && ownerPid !== process.pid && processIsAlive(ownerPid)) return { acquired: false, file, ownerPid };
      try { fs.rmSync(file, { force: true }); }
      catch (removeError) { return { acquired: false, file, ownerPid, error: removeError?.message || String(removeError) }; }
    }
  }
  return { acquired: false, file, ownerPid: null, error: "无法取得账号实例锁" };
}

function releaseProfileInstanceLock(lock) {
  if (!lock?.acquired || !lock.file || !fs.existsSync(lock.file)) return;
  try {
    const ownerPid = Number(JSON.parse(fs.readFileSync(lock.file, "utf8"))?.pid) || null;
    if (ownerPid === process.pid) fs.rmSync(lock.file, { force: true });
  } catch {}
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch { return false; }
}

function credentialPath(profileId) {
  return path.join(app.getPath("userData"), "credentials", `${safeProfileId(profileId)}.json`);
}

function loadCredentials(profileId) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const file = credentialPath(profileId);
  if (!fs.existsSync(file)) return null;
  try {
    const payload = readJsonWithBackupSync(fs, file, value => typeof value?.encrypted === "string" && value.encrypted.length > 0).value;
    if (!payload?.encrypted) return null;
    return JSON.parse(safeStorage.decryptString(Buffer.from(payload.encrypted, "base64")));
  } catch { return null; }
}

function saveCredentials(profileId, credentials) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统无法使用 Windows 加密存储");
  const file = credentialPath(profileId);
  const encrypted = safeStorage.encryptString(JSON.stringify({
    account: credentials.account,
    password: credentials.password,
    autoLogin: Boolean(credentials.autoLogin)
  })).toString("base64");
  atomicWriteJsonSync(fs, file, { version: 2, encrypted });
}

function clearCredentials(profileId) {
  const file = credentialPath(profileId);
  for (const candidate of [file, `${file}.bak`]) if (fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
}

function onlineWorldIdentityPath(profileId, accountId) {
  return path.join(app.getPath("userData"), "online-world", "identities", `${safeProfileId(profileId)}-${safeProfileId(accountId || "unknown")}.json`);
}

function onlineWorldCachePath(profileId) {
  return path.join(app.getPath("userData"), "online-world", "cache", `${safeProfileId(profileId)}.json`);
}

function onlineWorldCardLibraryPath(profileId) {
  return path.join(app.getPath("userData"), "online-world", "cards", `${safeProfileId(profileId)}.json`);
}

function onlineWorldCardInstallDirectory() {
  return path.join(app.getPath("userData"), "游戏卡");
}

function loadOrCreateOnlineWorldIdentity(profileId, accountId) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统不能加密保存在线世界设备密钥");
  if (!accountId) throw new Error("登录账号尚未完成在线世界设备绑定");
  const file = onlineWorldIdentityPath(profileId, accountId);
  if (fs.existsSync(file)) {
    try {
      const payload = readJsonWithBackupSync(fs, file, value => value?.version === 1 && typeof value?.encrypted === "string").value;
      const identity = JSON.parse(safeStorage.decryptString(Buffer.from(payload.encrypted, "base64")));
      if (identity?.version === 1 && identity.signingPrivateKey && identity.encryptionPrivateKey) return identity;
    } catch {}
  }
  const identity = generateOnlineWorldIdentity();
  const encrypted = safeStorage.encryptString(JSON.stringify(identity)).toString("base64");
  atomicWriteJsonSync(fs, file, { version: 1, encrypted }, { pretty: false });
  return identity;
}

function saveAnchorPath(profileId) {
  return path.join(app.getPath("userData"), "save-anchors", `${safeProfileId(profileId)}.json`);
}

function sessionLogPath(profileId) {
  return path.join(app.getPath("userData"), "session-logs", `${safeProfileId(profileId)}-${process.pid}.jsonl`);
}

function loadSaveAnchors(profileId) {
  const file = saveAnchorPath(profileId);
  if (!fs.existsSync(file)) return { version: 1, accounts: {} };
  try {
    const data = readJsonWithBackupSync(fs, file, value => value?.version === 1 && value.accounts && typeof value.accounts === "object").value;
    return data?.version === 1 && data.accounts && typeof data.accounts === "object" ? data : { version: 1, accounts: {} };
  } catch { return { version: 1, accounts: {} }; }
}

function writeSaveAnchors(profileId, data) {
  const file = saveAnchorPath(profileId);
  atomicWriteJsonSync(fs, file, data, { pretty: true });
}

function prefixAdaptersPath() {
  return path.join(app.getPath("userData"), "multiplayer-prefix-adapters.json");
}

function loadPrefixAdapters() {
  const file = prefixAdaptersPath();
  if (!fs.existsSync(file)) return { version: 1, adapters: {} };
  try {
    const data = readJsonWithBackupSync(fs, file, value => value?.version === 1 && value.adapters && typeof value.adapters === "object").value;
    return data?.version === 1 && data.adapters && typeof data.adapters === "object"
      ? data
      : { version: 1, adapters: {} };
  } catch { return { version: 1, adapters: {} }; }
}

function writePrefixAdapters(data) {
  const file = prefixAdaptersPath();
  atomicWriteJsonSync(fs, file, data, { pretty: true });
}

function pluginSettingsPath(profileId) {
  return path.join(app.getPath("userData"), "plugin-settings", `${safeProfileId(profileId)}.json`);
}

function loadPluginSettings(profileId) {
  const file = pluginSettingsPath(profileId);
  if (!fs.existsSync(file)) return normalizePluginSettings();
  try { return normalizePluginSettings(readJsonWithBackupSync(fs, file, value => value && typeof value === "object" && !Array.isArray(value)).value); }
  catch { return normalizePluginSettings(); }
}

function writePluginSettings(profileId, data) {
  const file = pluginSettingsPath(profileId);
  atomicWriteJsonSync(fs, file, normalizePluginSettings(data), { pretty: true });
}

function characterProfilesPath(profileId) {
  return path.join(app.getPath("userData"), "character-profiles", `${safeProfileId(profileId)}.json`);
}

function emptyCharacterProfile() {
  return {
    id: crypto.randomUUID(),
    label: "默认设定",
    displayName: "",
    basicInfo: "",
    appearance: "",
    info: "",
    updatedAt: Date.now()
  };
}

function composeCharacterInfo(basicInfo, appearance) {
  const sections = [];
  const normalizedBasic = String(basicInfo || "").trim();
  const normalizedAppearance = String(appearance || "").trim();
  if (normalizedBasic) sections.push(`【基础设定】\n${normalizedBasic}`);
  if (normalizedAppearance) sections.push(`【外观设定】\n${normalizedAppearance}`);
  return sections.join("\n\n");
}

function normalizeCharacterProfiles(value) {
  const items = Array.isArray(value?.items) ? value.items.map(item => {
    const basicInfo = String(item?.basicInfo ?? item?.info ?? "");
    const appearance = String(item?.appearance ?? "");
    return {
      id: String(item?.id || crypto.randomUUID()),
      label: String(item?.label || item?.displayName || "未命名设定").trim() || "未命名设定",
      displayName: String(item?.displayName || "").trim(),
      basicInfo,
      appearance,
      info: composeCharacterInfo(basicInfo, appearance),
      updatedAt: Number(item?.updatedAt || Date.now())
    };
  }) : [];
  if (!items.length) items.push(emptyCharacterProfile());
  const selectedId = items.some(item => item.id === String(value?.selectedId || ""))
    ? String(value.selectedId)
    : items[0].id;
  return { version: 2, selectedId, items };
}

function loadCharacterProfiles(profileId) {
  const file = characterProfilesPath(profileId);
  if (!fs.existsSync(file)) return normalizeCharacterProfiles(null);
  try { return normalizeCharacterProfiles(readJsonWithBackupSync(fs, file, value => Array.isArray(value?.items)).value); }
  catch { return normalizeCharacterProfiles(null); }
}

function writeCharacterProfiles(profileId, profiles) {
  const file = characterProfilesPath(profileId);
  atomicWriteJsonSync(fs, file, normalizeCharacterProfiles(profiles), { pretty: true });
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("base64url");
}

function derivePasswordVerifier(hostIdentity, password) {
  return sha256Base64Url(`FYMP/1\0${String(hostIdentity).trim().toLocaleLowerCase()}\0${password}`);
}

function derivePasswordVerifierV2(hostIdentity, password) {
  const salt = `FYMP/2\0${String(hostIdentity).trim().toLocaleLowerCase()}`;
  return crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url");
}

function parseInviteWork(value, origin = DEFAULT_ORIGIN) {
  let url;
  const raw = String(value || "").trim();
  try { url = new URL(raw, origin); }
  catch { throw new Error("请输入房主的邀请链接"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("邀请链接必须是 http 或 https 地址");
  const match = url.pathname.match(/^\/(?:zh\/)?explore\/installed\/([^/?#]+)\/?$/i);
  if (!match) throw new Error("邀请链接格式无效");
  return { id: match[1], suffix: url.pathname, sourceUrl: platformUrlForOrigin(origin, url).href };
}

let domainStatusCache = null;
let domainStatusCacheAt = 0;
let domainDiscoveryInFlight = null;
let defaultProxyState = { mode: "system", route: null, error: null };

async function configureSystemProxy(targetSession, label = "platform") {
  await targetSession.setProxy({ mode: "system" });
  const route = await targetSession.resolveProxy("https://acquant.xyz/zh/signin");
  return { label, mode: "system", route: String(route || "DIRECT"), error: null };
}

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch { return null; }
}

// Platform pages sometimes return absolute links whose host points at another
// Aiero node. Account storage is isolated by the node selected at login, so
// keep only the path/query/hash and always rebuild platform URLs on that node.
function platformUrlForOrigin(origin, value = "/") {
  const normalized = normalizeOrigin(origin);
  if (!normalized) throw new Error("当前登录节点无效");
  const candidate = new URL(String(value || "/"), normalized);
  return new URL(`${candidate.pathname}${candidate.search}${candidate.hash}`, normalized);
}

function accountSignature(value = {}) {
  return JSON.stringify({
    username: value.username ?? null,
    email: value.email ?? null,
    points: value.points ?? null,
    level: value.level ?? null,
    accountId: value.accountId ?? null
  });
}

function platformPointBalance(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(typeof value === "string" ? value.replace(/,/g, "").trim() : value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function resolvedModelPointUsage(reported, beforeValue, afterValue) {
  const direct = reported && typeof reported === "object" && [reported.input, reported.output, reported.total].some(value => platformPointBalance(value) != null)
    ? {
        input: platformPointBalance(reported.input),
        output: platformPointBalance(reported.output),
        total: platformPointBalance(reported.total),
        source: String(reported.source || "model-response")
      }
    : normalizeModelPoints(reported);
  const before = platformPointBalance(beforeValue);
  const after = platformPointBalance(afterValue);
  const balanceDelta = before != null && after != null ? Math.max(0, before - after) : null;
  const total = direct?.total ?? balanceDelta;
  return {
    input: direct?.input ?? null,
    output: direct?.output ?? null,
    total,
    source: direct?.total != null ? (direct.source || "model-response") : (balanceDelta != null ? "balance-delta" : "platform-unavailable")
  };
}

async function mapConcurrent(items, limit, worker) {
  const results = Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function currentDomainCandidates(selectedOrigin = null) {
  const cachedItems = Array.isArray(domainStatusCache?.domains) ? domainStatusCache.domains : [];
  const byOrigin = new Map();
  for (const item of cachedItems) {
    byOrigin.set(item.origin, { ...item });
    if (item.finalOrigin && item.finalOrigin !== item.origin && !byOrigin.has(item.finalOrigin)) {
      byOrigin.set(item.finalOrigin, { ...item, origin: item.finalOrigin });
    }
  }
  const origins = [...new Set([
    ...OFFICIAL_FALLBACK_ORIGINS,
    ...cachedItems.map(item => item.origin),
    selectedOrigin
  ].map(normalizeOrigin).filter(origin => origin && origin !== DEFAULT_ORIGIN))];
  return {
    directoryUrl: DOMAIN_DIRECTORY_URLS[0],
    directoryUrls: [...DOMAIN_DIRECTORY_URLS],
    directoryError: domainStatusCache?.directoryError || null,
    cachedAt: domainStatusCacheAt || null,
    probing: true,
    domains: origins.map(origin => byOrigin.get(origin) || {
      origin,
      finalOrigin: origin,
      online: null,
      statusCode: null,
      latency: null,
      source: "fallback"
    })
  };
}

async function discoverDomainStatuses(force = false) {
  if (!force && domainStatusCache && Date.now() - domainStatusCacheAt < 60_000) return domainStatusCache;
  if (domainDiscoveryInFlight) return domainDiscoveryInFlight;
  const running = refreshDomainStatuses();
  domainDiscoveryInFlight = running;
  try { return await running; }
  finally { if (domainDiscoveryInFlight === running) domainDiscoveryInFlight = null; }
}

async function refreshDomainStatuses() {
  const directorySources = await Promise.all(DOMAIN_DIRECTORY_URLS.map(async url => {
    try {
      const response = await net.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(4_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (!mergePublishedOrigins([html]).length) throw new Error("没有找到 SITES 列表");
      return { url, ok: true, html };
    } catch (error) {
      return { url, ok: false, error: error?.message || String(error) };
    }
  }));
  let origins = mergePublishedOrigins(directorySources.filter(item => item.ok).map(item => item.html));
  if (directorySources.some(item => !item.ok)) origins = [...new Set([...origins, ...OFFICIAL_FALLBACK_ORIGINS])];
  for (const origin of origins) TRUSTED_PLATFORM_ORIGINS.add(origin);
  origins = origins.filter(origin => origin !== DEFAULT_ORIGIN);
  const directoryWarnings = directorySources.filter(item => !item.ok).map(item => `${item.url}: ${item.error}`);
  const directoryError = origins.length ? null : directoryWarnings.join("；") || "官方域名发布页没有返回节点";
  if (!origins.length) origins = [...OFFICIAL_FALLBACK_ORIGINS];
  const statuses = await mapConcurrent(origins, 12, async origin => {
    const startedAt = Date.now();
    try {
      const response = await net.fetch(`${origin}/zh/chats`, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(5_000) });
      const finalOrigin = normalizeOrigin(response.url) || origin;
      if (!TRUSTED_PLATFORM_ORIGINS.has(finalOrigin)) throw new Error(`节点重定向到了未受信任的域名：${finalOrigin}`);
      void response.body?.cancel().catch(() => {});
      return {
        origin,
        online: response.ok,
        statusCode: response.status,
        latency: Date.now() - startedAt,
        finalOrigin,
        source: "official-directory"
      };
    } catch (error) {
      return { origin, online: false, statusCode: null, latency: null, error: error?.message || String(error), source: "official-directory" };
    }
  });
  domainStatusCache = {
    directoryUrl: DOMAIN_DIRECTORY_URLS[0],
    directoryUrls: [...DOMAIN_DIRECTORY_URLS],
    directorySources: directorySources.map(({ html, ...item }) => item),
    directoryWarnings,
    directoryError,
    domains: statuses
  };
  domainStatusCacheAt = Date.now();
  return domainStatusCache;
}

function makePacket(type, roomId, from, seq, payload) {
  return { v: 1, id: crypto.randomUUID(), roomId, type, from, seq, ts: Date.now(), payload };
}

function encodePacket(packet) {
  return WIRE_PREFIX + Buffer.from(JSON.stringify(packet), "utf8").toString("base64url");
}

function decodeWirePacket(content) {
  const start = String(content || "").indexOf(WIRE_PREFIX);
  if (start < 0) return null;
  const wire = String(content).slice(start + WIRE_PREFIX.length).trim().split(/\s/)[0] || "";
  if (!wire || wire.length > 64 * 1024 || !/^[A-Za-z0-9_-]+$/.test(wire)) return null;
  try {
    const packet = JSON.parse(Buffer.from(wire, "base64url").toString("utf8"));
    return packet?.v === 1
      && typeof packet.id === "string" && packet.id.length > 0 && packet.id.length <= 100
      && typeof packet.type === "string" && packet.type.length > 0 && packet.type.length <= 80
      ? packet
      : null;
  } catch { return null; }
}

class AccountBackend {
  constructor(window, profileId, releaseSecurity, updateService) {
    this.window = window;
    this.profileId = profileId;
    this.releaseSecurity = releaseSecurity;
    this.updateService = updateService;
    this.appVersion = app.getVersion();
    this.sessionLogs = [];
    this.sessionLogSequence = 0;
    this.sessionLogFile = sessionLogPath(profileId);
    const sessionLogDirectory = path.dirname(this.sessionLogFile);
    fs.mkdirSync(sessionLogDirectory, { recursive: true });
    this.sessionLogPruneResult = pruneSessionLogDirectory(fs, sessionLogDirectory, {
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      maxFiles: 100,
      maxTotalBytes: 100 * 1024 * 1024
    });
    fs.rmSync(this.sessionLogFile, { force: true });
    fs.writeFileSync(this.sessionLogFile, "", { encoding: "utf8", mode: 0o600 });
    this.partition = `persist:fengyue-link-${profileId}`;
    this.platformSession = session.fromPartition(this.partition);
    this.proxyState = { mode: "system", route: null, error: null };
    this.networkReady = configureSystemProxy(this.platformSession, this.partition)
      .then(result => {
        this.proxyState = result;
        this.appendSessionLog("network", { event: "system-proxy-resolved", ...result });
        return result;
      })
      .catch(error => {
        this.proxyState = { mode: "system", route: null, error: error?.message || String(error) };
        this.appendSessionLog("network", { event: "system-proxy-resolution-failed", ...this.proxyState });
        return this.proxyState;
      });
    const rememberedOrigin = loadSelectedOrigin(profileId);
    this.origin = rememberedOrigin || DEFAULT_ORIGIN;
    this.domainSelected = Boolean(rememberedOrigin);
    this.originLocked = false;
    this.anchorNavigationArmed = false;
    this.mode = "booting";
    this.loggedIn = false;
    this.work = null;
    this.surfaceBounds = { x: 340, y: 72, width: 1060, height: 760 };
    this.surfaceAttached = false;
    this.activeSurface = null;
    this.settingsVisible = false;
    this.settingsSurface = null;
    this.settingsSurfaceReady = null;
    this.settingsSurfaceAttached = false;
    this.seenPackets = new Set();
    this.destroying = false;
    this.diagnosticExportBusy = false;
    this.diagnosticGlobalShortcutRegistered = false;
    this.loginInProgress = false;
    this.loginController = null;
    this.loginProgress = null;
    this.loginDetectionPaused = false;
    this.authSessionRevision = 0;
    this.authFailureStreak = 0;
    this.authFailureSince = 0;
    this.authFailureLastAt = 0;
    this.oauthWindow = null;
    this.oauthChildren = new Set();
    this.oauthPollBusy = false;
    this.loginPageWarmOrigin = null;
    this.loginPageWarmPromise = null;
    this.loginPageWarmReady = false;
    this.loginPageWarmController = null;
    this.accountRefreshPromise = null;
    this.account = { username: null, email: null, points: null, level: null, accountId: null, updatedAt: null };
    this.autoModelJobs = new Map();
    this.autoModelQueues = new Map();
    this.migrationResumeTimer = null;
    this.migrationResumeInFlight = null;
    this.migrationResumeAttempt = 0;
    this.onlineWorldCardFile = onlineWorldCardLibraryPath(this.profileId);
    this.onlineWorldCards = loadGameCardLibrary(this.onlineWorldCardFile, null);
    this.onlineWorldCardInstallDirectory = onlineWorldCardInstallDirectory();
    const installedCards = scanGameCardDirectory(this.onlineWorldCardInstallDirectory);
    this.onlineWorldCardSources = installedCards.sources;
    this.onlineWorldCardScanErrors = installedCards.errors;
    for (const [libraryId, card] of installedCards.cards) {
      const current = this.onlineWorldCards.get(libraryId);
      const currentVersion = Number(current?.version || 0);
      const nextVersion = Number(card.version || 0);
      const currentExportedAt = Date.parse(String(current?.exportedAt || "")) || 0;
      const nextExportedAt = Date.parse(String(card.exportedAt || "")) || 0;
      if (!current || nextVersion > currentVersion
        || (nextVersion === currentVersion && nextExportedAt > currentExportedAt)) {
        this.onlineWorldCards.set(libraryId, card);
      }
    }
    if (installedCards.cards.size) saveGameCardLibrary(this.onlineWorldCardFile, this.onlineWorldCards);
    this.onlineWorldService = new OnlineWorldService({
      requestConsole: (pathname, options) => this.platformChatApi(pathname, options),
      requestGo: (pathname, options) => this.platformGoApi(pathname, options),
      requestModel: (request, options) => this.onlineWorldModelRequest(request, options),
      runModelTask: (label, execute, options = {}) => this.withAutoModel(this.onlineWorldService?.work?.id, label, execute, { scope: "online-world", ...options }),
      onClose: () => this.cancelAutoModels("online-world"),
      getAccount: () => this.account,
      getIdentity: () => loadOrCreateOnlineWorldIdentity(this.profileId, this.account.accountId),
      getOrigin: () => this.origin,
      readPlatformTime: () => this.platformServerTime(),
      cacheFile: onlineWorldCachePath(this.profileId),
      onDiagnostic: detail => this.appendSessionLog("online-world", detail),
      onChange: worldState => {
        if (!this.destroying && this.window && !this.window.isDestroyed()) this.window.webContents.send("online-world:state", worldState);
      }
    });
    this.saveAnchors = loadSaveAnchors(profileId);
    this.prefixAdapters = loadPrefixAdapters();
    this.prefixAdapterBusy = false;
    this.prefixAdapterOperation = null;
    this.pluginSettings = loadPluginSettings(profileId);
    this.pluginPipelineBusy = false;
    this.pluginLastRuns = [];
    this.workSettings = { loading: false, saving: false, error: null, global: null, memoryCount: null, appId: null };
    this.perspectiveViews = {};
    try { this.perspectiveViews = readJsonWithBackupSync(fs, path.join(app.getPath("userData"), `perspective-views-${safeProfileId(profileId)}.json`), value => value && typeof value === "object" && !Array.isArray(value)).value || {}; } catch {}
    this.characterProfiles = loadCharacterProfiles(profileId);
    this.conversation = { items: [], activeId: null, activeName: null, sessionKey: null, anchorRole: null, anchored: false, updatedAt: null };
    this.conversationBusy = false;
    this.conversationOperation = null;
    this.introReady = false;
    this.introCssKey = null;
    this.gameCssKey = null;
    this.gamePrivacyCssKey = null;
    this.gamePrivacyCssPromise = Promise.resolve(null);
    this.gameFrameBusy = false;
    this.gameFrameEncodeBusy = false;
    this.gameFramePublishPending = false;
    this.gameFramePublishTimer = null;
    this.gameFrameLastSentAt = 0;
    this.gameFrameHash = null;
    this.gameFrameCrop = null;
    this.gamePresentationFrame = null;
    this.gamePresentationFrameAt = 0;
    this.gameAutoFollow = true;
    this.gameSurfaceReady = false;
    this.effectJudgeContextAvailable = false;
    // Present the real platform page in a full-size native WebContentsView.
    // A real message-stream ancestor becomes the in-page stage, so Chromium
    // owns painting, scrolling and hit testing without crop offsets or clones.
    this.liveGameSurface = true;
    this.liveToolCardRevision = 0;
    this.uiTheme = "dark";
    this.gameSurfacePresentationLocks = 0;
    this.backgroundDataRefreshTimer = null;
    this.platformModels = { items: [], selected: null, hostSelected: null, loading: false, changing: false, error: null, updatedAt: null, config: null };
    this.messageOperationBusy = false;
    this.room = null;
    this.seq = 0;
    this.pendingChallenges = new Map();
    this.incomingTransfers = new Map();
    this.roomPollBusy = false;
    this.roomPollNotBefore = 0;
    this.roomPollIdleCount = 0;
    this.roomChatSendBusy = false;
    this.roundBusy = false;
    this.surface = this.createPlatformSurface();
    this.introSurface = this.createPlatformSurface();
    this.setIntroAudioMuted(true);
    this.gameSurface = this.createPlatformWindow();
    if (this.liveGameSurface) {
      this.window.contentView.addChildView(this.gameSurface);
      this.gameSurface.setBounds(this.backgroundWindowBounds());
    }
    // A blank hidden WebContents does not yet accept Page document-start
    // commands. setPlatformConversationId installs the observer after the first
    // work document is ready and before its mandatory state-refresh reload.
    this.gameNetworkCaptureReady = Promise.resolve(false);
    this.anchor = this.createAnchorWindow();
    this.registerDiagnosticGlobalShortcut();
    for (const webContents of [this.window.webContents, this.surface.webContents, this.introSurface.webContents, this.gameSurface.webContents, this.anchor.webContents]) {
      this.bindDiagnosticExportShortcut(webContents);
    }
    this.bindSurfaceNavigation();
    this.statusTimer = setInterval(() => this.runBackgroundTask("login-state", () => this.refreshLoginState()), 5000);
    this.accountTimer = setInterval(() => this.runBackgroundTask("account", () => this.refreshAccount()), 20000);
    this.heartbeatTimer = setInterval(() => this.runBackgroundTask("heartbeat", () => this.keepSessionAlive()), 30000);
    this.roomTimer = setInterval(() => this.runBackgroundTask("room-protocol", () => this.pollRoomProtocol()), 1000);
    this.gameFrameTimer = this.liveGameSurface ? null : setInterval(() => this.runBackgroundTask("game-frame", () => this.captureGameFrame()), 200);
    this.gameWakeBusy = false;
    this.gameWakeTimer = setInterval(() => this.runBackgroundTask("game-surface", () => this.keepGameSurfaceAwake()), 2500);
    this.introWakeBusy = false;
    this.introWakeTimer = setInterval(() => this.runBackgroundTask("intro-surface", () => this.keepIntroSurfaceAwake()), 2500);
    this.appendSessionLog("lifecycle", { event: "instance-started", profileId, pid: process.pid, staleLogs: this.sessionLogPruneResult });
  }

  runBackgroundTask(task, operation) {
    void Promise.resolve().then(operation).catch(error => {
      this.appendSessionLog("background-task", { task, error: error?.message || String(error) });
    });
  }

  state(extra = {}) {
    const isAdmin = this.isAdminAccount();
    const prefixAdapter = this.currentPrefixAdapter();
    return {
      profileId: this.profileId,
      mode: this.mode,
      loggedIn: this.loggedIn,
      loginInProgress: this.loginInProgress,
      loginProgress: this.loginProgress,
      loginCancellable: Boolean((this.loginController && !this.loginController.signal.aborted) || this.oauthWindow),
      origin: this.origin,
      domainSelected: this.domainSelected,
      originLocked: this.originLocked,
      settingsVisible: this.settingsVisible,
      uiTheme: this.uiTheme,
      work: this.work,
      conversation: {
        items: this.conversation.items.map(item => ({ id: item.id, name: item.name, active: item.active })),
        activeId: this.conversation.activeId,
        activeName: this.conversation.activeName,
        sessionKey: this.conversation.sessionKey,
        anchored: this.conversation.anchored,
        persistent: true,
        source: this.conversation.source || "none",
        updatedAt: this.conversation.updatedAt
      },
      conversationBusy: this.conversationBusy,
      conversationOperation: this.conversationOperation,
      prefixAdapter: this.work ? {
        appId: this.currentWorkAppId(),
        needsUpdate: Boolean(this.prefixAdapters?.adapters?.[this.currentWorkAppId()]) && !prefixAdapter,
        status: this.prefixAdapterBusy ? "adapting" : this.prefixAdapterOperation?.error ? "error" : prefixAdapter ? "ready" : "missing",
        stage: this.prefixAdapterOperation?.stage || null,
        current: Number(this.prefixAdapterOperation?.current || 0),
        total: Number(this.prefixAdapterOperation?.total || 0),
        error: this.prefixAdapterOperation?.error || null,
        generatedAt: prefixAdapter?.generatedAt || null,
        sampleCount: Number(prefixAdapter?.sampleCount || 0),
        detectedStatusBar: prefixAdapter ? Boolean(prefixAdapter.detectedStatusBar) : null,
        warnings: Array.isArray(prefixAdapter?.warnings) ? prefixAdapter.warnings.slice(0, 5) : []
      } : null,
      workSettings: this.room?.role === "guest" ? { ...(this.room.workSettings || {}), readOnly: true } : this.workSettings,
      plugins: {
        busy: Boolean(this.pluginPipelineBusy || this.pluginSettingsBusy || this.perspectiveProgress),
        perspectiveProgress: this.perspectiveProgress || null,
        definitions: [
          {
            id: EFFECT_JUDGE_PLUGIN_ID,
            name: "效果判定",
            category: "conversation",
            phase: PLUGIN_PHASES.INPUT,
            enabled: Boolean((this.room?.role === "guest" ? this.room.plugins : this.pluginSettings)?.plugins?.[EFFECT_JUDGE_PLUGIN_ID]?.enabled),
            contextAvailable: Boolean(this.room?.round?.lastResult?.output || this.effectJudgeContextAvailable),
            settings: { ...((this.room?.role === "guest" ? this.room.plugins : this.pluginSettings)?.plugins?.[EFFECT_JUDGE_PLUGIN_ID]?.settings || this.pluginSettings.plugins[EFFECT_JUDGE_PLUGIN_ID].settings) }
          },
          {
            id: PERSPECTIVE_PLUGIN_ID,
            name: "独立视角",
            category: "conversation",
            phase: PLUGIN_PHASES.OUTPUT,
            ...((this.room?.role === "guest" ? this.room.plugins : this.pluginSettings)?.plugins?.[PERSPECTIVE_PLUGIN_ID] || {})
          },
          {
            id: "multiplayer-prefix-adapter",
            name: "联机前置词适配",
            category: "auxiliary",
            phase: PLUGIN_PHASES.AUXILIARY,
            enabled: Boolean(prefixAdapter)
          }
        ],
        currentRuns: Array.isArray(this.room?.round?.pluginRuns) ? this.room.round.pluginRuns : [],
        lastRuns: Array.isArray(this.room?.round?.lastResult?.pluginRuns)
          ? this.room.round.lastResult.pluginRuns
          : this.pluginLastRuns
      },
      anchorAlive: Boolean(this.anchor && !this.anchor.isDestroyed()),
      credentialStorageAvailable: safeStorage.isEncryptionAvailable(),
      characterProfiles: {
        selectedId: this.characterProfiles.selectedId,
        items: this.characterProfiles.items.map(item => ({ ...item }))
      },
      models: {
        items: this.platformModels.items.map(item => ({
          provider: item.provider,
          model: item.model,
          label: item.label,
          providerLabel: item.providerLabel || item.provider,
          family: item.family || "other",
          priceCoefficient: item.priceCoefficient ?? null,
          successRate: item.successRate ?? null,
          averageLatency: item.averageLatency ?? null
        })),
        selected: this.platformModels.selected ? { ...this.platformModels.selected } : null,
        hostSelected: this.room?.model ? { ...this.room.model } : this.platformModels.hostSelected ? { ...this.platformModels.hostSelected } : null,
        loading: Boolean(this.platformModels.loading),
        changing: Boolean(this.platformModels.changing),
        error: this.platformModels.error || null,
        updatedAt: this.platformModels.updatedAt
      },
      modelOperations: [...this.autoModelJobs.values()].map(job => ({ ...job.state })),
      backgroundPages: {
        gameAlive: Boolean(this.gameSurface?.webContents && !this.gameSurface.webContents.isDestroyed()),
        gameReady: Boolean(this.gameSurfaceReady),
        gamePresentationAllowed: this.gameFrameModeVisible(),
        liveGameView: Boolean(this.liveGameSurface),
        introAlive: Boolean(this.introSurface?.webContents && !this.introSurface.webContents.isDestroyed()),
        introReady: Boolean(this.introReady)
      },
      network: { ...this.proxyState },
      releaseSecurity: this.releaseSecurity.state(),
      appUpdate: this.updateService?.state?.() || {
        status: "development",
        message: "开发模式不运行安装包更新",
        currentVersion: this.appVersion,
        latestVersion: null,
        percent: null,
        officialReleasePage: OFFICIAL_RELEASE_PAGE
      },
      messageOperationBusy: this.messageOperationBusy,
      sessionLogCount: isAdmin ? this.sessionLogs.length : 0,
      isAdmin,
      account: {
        username: this.account.username,
        points: this.account.points,
        level: this.account.level,
        accountId: this.account.accountId,
        updatedAt: this.account.updatedAt
      },
      onlineWorld: this.onlineWorldService.summary(),
      room: this.room ? {
        id: this.room.id,
        role: this.room.role,
        status: this.room.status,
        appVersion: this.appVersion,
        peerVersion: this.room.peerVersion || null,
        versionMismatch: this.room.versionMismatch ? { ...this.room.versionMismatch } : null,
        hostUsername: this.room.hostUsername,
        work: this.room.work,
        inviteUrl: this.room.inviteUrl || null,
        save: this.room.save ? {
          key: this.room.save.key,
          conversationId: this.room.save.conversationId || null,
          name: this.room.save.name || "新会话"
        } : null,
        historySync: this.room.historySync ? {
          status: this.room.historySync.status,
          current: this.room.historySync.current || 0,
          total: this.room.historySync.total || 0,
          error: this.room.historySync.error || null
        } : null,
        createdAt: this.room.createdAt,
        memberCount: this.room.memberCount,
        members: Array.isArray(this.room.members) ? this.room.members.map(member => ({
          id: String(member.id || ""),
          platformName: String(member.platformName || ""),
          displayName: String(member.displayName || member.platformName || "未命名玩家"),
          basicInfo: String(member.basicInfo ?? member.info ?? ""),
          appearance: String(member.appearance || ""),
          info: String(member.info || ""),
          historyStatus: this.room.role === "host" && String(member.id) !== String(this.account.accountId)
            ? this.room.memberHistory?.[String(member.id)] || "preparing"
            : this.room.historySync?.status || "ready"
        })) : [],
        round: this.room.round ? {
          number: this.room.round.number,
          status: this.room.round.status,
          readyCount: Object.keys(this.room.round.submissions || {}).length,
          totalCount: this.room.members?.length || 1,
          readyNames: Object.values(this.room.round.submissions || {}).map(item => String(item.displayName || "未命名玩家")),
          resultAckCount: Object.values(this.room.round.resultAcks || {}).filter(item => item?.status === "ready").length,
          resultAckTotal: Array.isArray(this.room.round.pendingGuestIds) ? this.room.round.pendingGuestIds.length : 0,
          error: this.room.round.error || null,
          pipeline: this.room.round.pipeline ? { ...this.room.round.pipeline } : null,
          pluginRuns: Array.isArray(this.room.round.pluginRuns) ? this.room.round.pluginRuns : [],
          lastResult: this.room.round.lastResult ? {
            round: this.room.round.lastResult.round,
            model: this.room.round.lastResult.model,
            points: this.room.round.lastResult.points,
            completedAt: this.room.round.lastResult.completedAt,
            output: this.room.round.lastResult.output,
            perspectiveSplit: Boolean(this.room.round.lastResult.perspectiveSplit),
            deleted: Boolean(this.room.round.lastResult.deleted)
          } : null
        } : null,
        model: this.room.model ? { ...this.room.model } : null,
        promptSync: this.room.promptSync ? {
          status: this.room.promptSync.status || "idle",
          updatedAt: this.room.promptSync.updatedAt || null,
          memberCount: this.room.promptSync.memberCount || 0,
          error: this.room.promptSync.error || null
        } : null,
        messageOperation: this.room.messageOperation ? {
          id: this.room.messageOperation.id,
          action: this.room.messageOperation.action,
          status: this.room.messageOperation.status,
          ackCount: Object.values(this.room.messageOperation.acks || {}).filter(item => item?.status === "ready").length,
          ackTotal: Array.isArray(this.room.messageOperation.pendingGuestIds) ? this.room.messageOperation.pendingGuestIds.length : 0,
          error: this.room.messageOperation.error || null
        } : null,
        chat: this.room.chat ? {
          revision: Number(this.room.chat.revision || 0),
          messages: this.roomChatVisibleMessages(),
          pending: this.room.chat.pending ? {
            clientMessageId: String(this.room.chat.pending.clientMessageId || ""),
            text: String(this.room.chat.pending.text || ""),
            clientSentAt: Number(this.room.chat.pending.clientSentAt || 0),
            clientSentAtIso: String(this.room.chat.pending.clientSentAtIso || ""),
            attempts: Number(this.room.chat.pending.attempts || 0),
            status: String(this.room.chat.pending.status || "sending")
          } : null,
          syncStatus: String(this.room.chat.syncStatus || "ready"),
          error: this.room.chat.error || null
        } : null,
        error: this.room.error || null
      } : null,
      ...extra
    };
  }

  createPlatformSurface() {
    const view = new WebContentsView({ webPreferences: {
      partition: this.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }});
    view.setBackgroundColor("#10151d");
    // Detached WebContentsViews otherwise start with a zero-sized viewport.  The
    // platform renders its conversation sidebar responsively, so give every
    // background surface a real desktop-sized layout even while it is hidden.
    view.setBounds(this.surfaceBounds);
    view.webContents.on("did-finish-load", () => { void this.applyPlatformTheme(view.webContents).catch(() => {}); });
    return view;
  }

  settingsSurfaceBounds() {
    const [windowWidth, windowHeight] = this.window.getContentSize();
    const width = Math.max(320, Math.min(390, windowWidth - 36));
    const top = 62;
    return {
      x: Math.max(18, windowWidth - width - 18),
      y: top,
      width,
      height: Math.max(260, windowHeight - top - 20)
    };
  }

  async ensureSettingsSurface() {
    if (this.settingsSurface?.webContents && !this.settingsSurface.webContents.isDestroyed()) return this.settingsSurface;
    if (this.settingsSurfaceReady) return this.settingsSurfaceReady;
    this.settingsSurfaceReady = (async () => {
      const view = new WebContentsView({ webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }});
      view.setBackgroundColor(this.uiTheme === "light" ? "#f3e4d2" : "#17222c");
      view.setBounds(this.settingsSurfaceBounds());
      guardDesktopNavigation(view.webContents);
      this.bindDiagnosticExportShortcut(view.webContents);
      await view.webContents.loadFile(path.join(__dirname, "desktop", "index.html"), { query: { settingsOverlay: "1" } });
      this.settingsSurface = view;
      return view;
    })().finally(() => { this.settingsSurfaceReady = null; });
    return this.settingsSurfaceReady;
  }

  keepSettingsSurfaceOnTop() {
    const view = this.settingsSurface;
    if (!this.settingsVisible || !view?.webContents || view.webContents.isDestroyed() || this.window.isDestroyed()) return false;
    this.window.contentView.addChildView(view);
    this.settingsSurfaceAttached = true;
    view.setBounds(this.settingsSurfaceBounds());
    return true;
  }

  createPlatformWindow() {
    if (!this.liveGameSurface) {
      const hiddenWindow = new BrowserWindow({
        show: false,
        frame: false,
        skipTaskbar: true,
        focusable: false,
        opacity: 0,
        x: -32000,
        y: -32000,
        width: Math.max(100, this.surfaceBounds.width),
        height: Math.max(100, this.surfaceBounds.height),
        backgroundColor: "#10151d",
        webPreferences: {
          partition: this.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          offscreen: true
        }
      });
      hiddenWindow.setSkipTaskbar(true);
      hiddenWindow.webContents.setFrameRate(30);
      hiddenWindow.webContents.on("paint", (_event, _dirtyRect, image) => {
        if (this.destroying || !image || image.isEmpty()) return;
        this.gamePresentationFrame = image;
        this.gamePresentationFrameAt = Date.now();
        this.queueGamePresentationFrame();
      });
      hiddenWindow.webContents.startPainting();
      hiddenWindow.on("close", event => {
        if (!this.destroying) event.preventDefault();
      });
      hiddenWindow.webContents.on("did-finish-load", () => {
        if (this.destroying) return;
        void this.applyPlatformTheme(hiddenWindow.webContents).catch(() => {});
        this.keepGameSurfaceResident();
        void this.applyGameIsolation(false);
      });
      hiddenWindow.webContents.on("did-start-navigation", () => {
        this.gameSurfaceReady = false;
        this.gamePresentationFrame = null;
        this.gamePresentationFrameAt = 0;
        this.gameFrameHash = null;
        this.gameFrameCrop = null;
        this.gameFramePublishPending = false;
        if (!this.window.isDestroyed()) this.window.webContents.send("backend:game-frame", { reset: true });
      });
      return hiddenWindow;
    }
    const liveView = new WebContentsView({ webPreferences: {
      partition: this.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }});
    liveView.setBackgroundColor("#10151d");
    liveView.webContents.on("did-finish-load", () => {
      if (this.destroying) return;
      void this.applyPlatformTheme(liveView.webContents).catch(() => {});
      this.keepGameSurfaceResident();
      void this.applyGameIsolation(false);
    });
    liveView.webContents.on("did-start-navigation", () => {
      this.gameSurfaceReady = false;
      this.gamePresentationFrame = null;
      this.gamePresentationFrameAt = 0;
      this.gameFrameHash = null;
      this.gameFrameCrop = null;
      this.gameFramePublishPending = false;
      if (!this.window.isDestroyed()) this.window.webContents.send("backend:game-frame", { reset: true });
    });
    return liveView;
  }

  ensureGameOffscreenPainting() {
    if (this.liveGameSurface) return true;
    const webContents = this.gameSurface?.webContents;
    if (!webContents || webContents.isDestroyed()) return false;
    try {
      if (!webContents.isPainting()) webContents.startPainting();
      return true;
    } catch (error) {
      this.appendSessionLog("game-surface", {
        event: "offscreen-paint-start-failed",
        error: error?.message || String(error)
      });
      return false;
    }
  }

  presentationFrameForCrop(crop) {
    const source = this.gamePresentationFrame;
    if (!source || source.isEmpty()) return null;
    const size = source.getSize();
    const viewportWidth = Math.max(1, Number(crop.viewportWidth) || this.surfaceBounds.width);
    const viewportHeight = Math.max(1, Number(crop.viewportHeight) || this.surfaceBounds.height);
    const scaleX = size.width / viewportWidth;
    const scaleY = size.height / viewportHeight;
    const x = Math.max(0, Math.min(size.width - 1, Math.floor(crop.x * scaleX)));
    const y = Math.max(0, Math.min(size.height - 1, Math.floor(crop.y * scaleY)));
    const width = Math.max(1, Math.min(size.width - x, Math.ceil(crop.width * scaleX)));
    const height = Math.max(1, Math.min(size.height - y, Math.ceil(crop.height * scaleY)));
    let image = source.crop({ x, y, width, height });
    if (image.isEmpty()) return null;
    if (image.getSize().width !== crop.width || image.getSize().height !== crop.height) {
      image = image.resize({ width: crop.width, height: crop.height, quality: "best" });
    }
    return image.isEmpty() ? null : image;
  }

  backgroundWindowBounds() {
    return {
      x: -32000,
      y: -32000,
      width: Math.max(100, this.surfaceBounds.width),
      height: Math.max(100, this.surfaceBounds.height)
    };
  }

  keepGameSurfaceResident() {
    this.setIntroAudioMuted(this.activeSurface !== this.introSurface);
    const surface = this.gameSurface;
    if (!surface?.webContents || surface.webContents.isDestroyed()) return false;
    if (!this.liveGameSurface) {
      if (surface.isDestroyed()) return false;
      const expected = this.backgroundWindowBounds();
      const current = surface.getBounds();
      if (
        current.x !== expected.x || current.y !== expected.y ||
        current.width !== expected.width || current.height !== expected.height
      ) surface.setBounds(expected, false);
      this.ensureGameOffscreenPainting();
      return true;
    }
    const expected = this.gameSurfaceShouldPresent() ? this.surfaceBounds : this.backgroundWindowBounds();
    if (this.gameSurfaceShouldPresent() && this.activeSurface) {
      try { this.window.contentView.removeChildView(this.activeSurface); } catch {}
      this.activeSurface = null;
      this.surfaceAttached = false;
    }
    const current = surface.getBounds();
    if (
      current.x !== expected.x || current.y !== expected.y ||
      current.width !== expected.width || current.height !== expected.height
    ) surface.setBounds(expected);
    this.keepSettingsSurfaceOnTop();
    return true;
  }

  scheduleBackgroundDataRefresh(delayMs = 250) {
    if (this.backgroundDataRefreshTimer) clearTimeout(this.backgroundDataRefreshTimer);
    this.backgroundDataRefreshTimer = setTimeout(async () => {
      this.backgroundDataRefreshTimer = null;
      if (this.destroying || !this.loggedIn || !this.work) return;
      if (this.conversationBusy) {
        this.scheduleBackgroundDataRefresh(500);
        return;
      }
      try {
        await this.refreshConversations({
          bindHost: !this.room || this.room.role === "host",
          keepSessionKey: Boolean(this.conversation.sessionKey)
        });
        if (!this.platformModels.items.length) await this.preparePlatformModels(3);
        this.emit({ backgroundDataRefreshed: true });
      } catch (error) {
        this.appendSessionLog("work-surfaces", {
          event: "background-data-refresh-failed",
          error: error?.message || String(error)
        });
      }
    }, Math.max(0, Number(delayMs) || 0));
  }

  async loadSurfaceUrl(surface, url, label = "平台页面", timeoutMs = 20000) {
    await this.networkReady;
    const webContents = surface?.webContents || surface;
    if (!webContents || webContents.isDestroyed()) throw new Error(`${label}已经关闭`);
    if (webContents === this.gameSurface?.webContents && Object.keys(this.perspectiveViews || {}).length) await this.installPerspectiveResponseFilter();
    const boundedTimeout = Number(timeoutMs);
    if (!Number.isFinite(boundedTimeout) || boundedTimeout <= 0) {
      await webContents.loadURL(url);
      await this.applyPlatformTheme(webContents);
      return true;
    }
    let timer = null;
    try {
      await Promise.race([
        webContents.loadURL(url),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { webContents.stop(); } catch {}
            reject(new Error(`${label}加载超时`));
          }, boundedTimeout);
        })
      ]);
      await this.applyPlatformTheme(webContents);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async installGameNetworkCapture() {
    const webContents = this.gameSurface?.webContents;
    if (!webContents || webContents.isDestroyed()) return false;
    try {
      this.appendSessionLog("game-network", { event: "early-capture-install-started", pageUrl: webContents.getURL() });
      if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
      this.appendSessionLog("game-network", { event: "debugger-attached", pageUrl: webContents.getURL() });
      const installCommand = webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          if (window.__fympEarlyNetwork?.installed) return;
          const state = window.__fympEarlyNetwork = {
            installed:true,
            conversationId:null,
            captures:[],
            records:[]
          };
          const validId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
          const record = value => {
            state.records.push({time:new Date().toISOString(),...value});
            if (state.records.length > 80) state.records.splice(0,state.records.length - 80);
          };
          const inspect = (value, source, url = '') => {
            const text = String(value || '');
            const patterns = [
              /["']conversation_id["']\\s*:\\s*["']([0-9a-f-]{36})["']/i,
              /["']conversationId["']\\s*:\\s*["']([0-9a-f-]{36})["']/i,
              /conversation_id(?:=|%3D|%22%3A%22)([0-9a-f-]{36})/i
            ];
            const conversationId = patterns.map(pattern => text.match(pattern)?.[1]).find(validId) || null;
            if (conversationId && !state.conversationId) {
              state.conversationId = conversationId;
              state.captures.push({source,url,conversationId,time:new Date().toISOString()});
            }
            return conversationId;
          };
          const nativeFetch = window.fetch;
          window.fetch = function(...args) {
            const url = String(typeof args[0] === 'string' ? args[0] : args[0]?.url || '');
            const body = args[1]?.body || (typeof args[0] === 'object' ? args[0]?.body : '');
            inspect(body,'early-fetch-request',url);
            record({source:'fetch-request',url});
            return nativeFetch.apply(this,args).then(response => {
              record({source:'fetch-response',url:response.url || url,status:response.status});
              try {
                const clone = response.clone();
                void (async () => {
                  try {
                    if (!clone.body) {
                      inspect(await clone.text(),'early-fetch-body',response.url || url);
                      return;
                    }
                    const reader = clone.body.getReader();
                    const decoder = new TextDecoder();
                    let buffered = '';
                    while (buffered.length < 262144 && !state.conversationId) {
                      const next = await reader.read();
                      if (next.done) break;
                      buffered += decoder.decode(next.value,{stream:true});
                      inspect(buffered,'early-fetch-stream',response.url || url);
                    }
                    try { await reader.cancel(); } catch {}
                  } catch (error) {
                    record({source:'fetch-inspect-error',url,error:String(error?.message || error)});
                  }
                })();
              } catch {}
              return response;
            });
          };
          const nativeOpen = XMLHttpRequest.prototype.open;
          const nativeSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method,url,...rest) {
            this.__fympEarlyUrl = String(url || '');
            return nativeOpen.call(this,method,url,...rest);
          };
          XMLHttpRequest.prototype.send = function(body) {
            inspect(body,'early-xhr-request',this.__fympEarlyUrl);
            record({source:'xhr-request',url:this.__fympEarlyUrl});
            const scan = () => {
              try { inspect(this.responseText,'early-xhr-stream',this.responseURL || this.__fympEarlyUrl); } catch {}
            };
            this.addEventListener('progress',scan);
            this.addEventListener('readystatechange',scan);
            return nativeSend.call(this,body);
          };
        })();`
      });
      await Promise.race([
        installCommand,
        new Promise((_, reject) => setTimeout(() => reject(new Error("安装响应流监听器超时")), 2500))
      ]);
      this.appendSessionLog("game-network", { event: "early-capture-installed" });
      return true;
    } catch (error) {
      this.appendSessionLog("game-network", { event: "early-capture-install-failed", error: error?.message || String(error) });
      try { if (webContents.debugger.isAttached()) webContents.debugger.detach(); }
      catch {}
      return false;
    }
  }

  newRound(number = 1, lastResult = null) {
    return {
      number,
      status: "collecting",
      submissions: {},
      lastResult,
      error: null,
      inputAcks: {},
      resultAcks: {},
      pendingGuestIds: [],
      pipeline: null,
      pluginRuns: [],
      modelInput: ""
    };
  }

  anchorAccountStore() {
    const accountId = String(this.account.accountId || "").trim();
    const existingStores = Object.values(this.saveAnchors.accounts || {});
    if (!accountId && existingStores.length === 1) return existingStores[0];
    const accountKey = accountId || String(this.profileId);
    if (!this.saveAnchors.accounts[accountKey]) this.saveAnchors.accounts[accountKey] = { hosts: {}, sessions: {} };
    return this.saveAnchors.accounts[accountKey];
  }

  readAnchorAccountStore() {
    const accountId = String(this.account.accountId || "").trim();
    if (accountId && this.saveAnchors.accounts[accountId]) return this.saveAnchors.accounts[accountId];
    const stores = Object.values(this.saveAnchors.accounts || {});
    if (!accountId && stores.length === 1) return stores[0];
    return this.saveAnchors.accounts[String(this.profileId)] || { hosts: {}, sessions: {} };
  }

  persistSaveAnchor({ sessionKey, conversationId = null, name = "新会话", role = "guest", workSuffix = this.work?.suffix } = {}) {
    if (!sessionKey || !workSuffix) return;
    const store = this.anchorAccountStore();
    store.sessions[sessionKey] = {
      ...(store.sessions[sessionKey] || {}),
      sessionKey,
      workSuffix,
      conversationId: conversationId || null,
      name: String(name || "新会话"),
      role,
      updatedAt: Date.now()
    };
    if (role === "host" && conversationId) {
      store.hosts[workSuffix] ||= {};
      store.hosts[workSuffix][conversationId] = sessionKey;
    }
    writeSaveAnchors(this.profileId, this.saveAnchors);
  }

  storedSession(sessionKey) {
    return sessionKey ? this.readAnchorAccountStore().sessions[sessionKey] || null : null;
  }

  hostSessionKey(conversationId) {
    if (!this.work?.suffix || !conversationId) return null;
    const store = this.readAnchorAccountStore();
    const direct = store.hosts[this.work.suffix]?.[conversationId];
    if (direct) return direct;
    let workId = null;
    try { workId = parseInviteWork(this.work.suffix, this.origin).id; } catch {}
    const match = Object.values(store.sessions || {})
      .filter(session => session?.role === "host" && String(session.conversationId || "") === String(conversationId))
      .filter(session => {
        if (session.workSuffix === this.work.suffix) return true;
        if (!workId) return false;
        try { return parseInviteWork(session.workSuffix, this.origin).id === workId; } catch { return false; }
      })
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0];
    return match?.sessionKey || null;
  }

  localHostConversationItems() {
    if (!this.work?.suffix) return [];
    let workId = null;
    try { workId = parseInviteWork(this.work.suffix, this.origin).id; } catch {}
    const sessions = Object.values(this.readAnchorAccountStore().sessions || {})
      .filter(session => {
        if (session?.role !== "host" || !session?.conversationId) return false;
        if (session.workSuffix === this.work.suffix) return true;
        if (!workId) return false;
        try { return parseInviteWork(session.workSuffix, this.origin).id === workId; } catch { return false; }
      })
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
    const unique = new Map();
    for (const session of sessions) {
      const id = String(session.conversationId || "").trim();
      if (id && !unique.has(id)) unique.set(id, {
        id,
        name: String(session.name || "本机会话"),
        active: false,
        source: "local-anchor"
      });
    }
    return [...unique.values()];
  }

  async ensureGameSurfaceMounted({ timeoutMs = 15000 } = {}) {
    if (!this.work?.url) return { mounted: false, reason: "no-work" };
    const gameUrl = this.workGameUrl();
    this.keepGameSurfaceResident();
    if (!this.isSameWorkPage(this.gameSurface.webContents.getURL(), gameUrl)) {
      await this.loadSurfaceUrl(this.gameSurface, gameUrl, "作品对话页面", Math.max(timeoutMs, 12000));
    }
    const webContents = this.gameSurface.webContents;
    // Hidden BrowserWindows can finish navigation before Chromium has produced
    // the first compositor frame.  The platform hydrates its conversation
    // sidebar after that frame; capturePage keeps the hidden page awake without
    // ever showing the platform window to the user.
    this.ensureGameOffscreenPainting();
    const wake = () => {
      try { webContents.invalidate(); } catch {}
      return Promise.resolve(this.gamePresentationFrame);
    };
    await wake();
    const wakeTimer = setInterval(() => void wake(), 250);
    let mounted;
    try {
      mounted = await webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
      const normalize = value => String(value || '').replace(/[\\s\\u00a0\\u200b]+/g,'');
      const isNewConversation = value => /^(新对话|新建对话|创建新对话|新的对话|NewChat|NewConversation)$/i.test(normalize(value));
      const snapshot = () => {
        const hasInput = Boolean(document.querySelector('#ai-chat-input'));
        const conversationCount = document.querySelectorAll('[id^="checkbox-list-label-"]').length;
        const hasNewButton = [...document.querySelectorAll('button,[role="button"]')]
          .some(button => isNewConversation(button.textContent) || isNewConversation(button.getAttribute('aria-label')) || isNewConversation(button.getAttribute('title')));
        return {
          mounted:document.readyState === 'complete' && Boolean(hasInput || conversationCount || hasNewButton),
          hasInput,
          hasNewButton,
          conversationCount,
          readyState:document.readyState,
          bodyLength:(document.body?.innerText || '').length
        };
      };
      const deadline = Date.now() + ${JSON.stringify(Math.max(1000, Number(timeoutMs) || 15000))};
      while (Date.now() < deadline) {
        const current = snapshot();
        if (current.mounted) {
          clearInterval(window.__fympKeepGameMounted);
          window.__fympKeepGameMounted = setInterval(() => {
            document.querySelector('.chat-container')?.getBoundingClientRect();
          }, 1000);
          return current;
        }
        await sleep(100);
      }
      return snapshot();
    })()`, true).catch(error => ({ mounted: false, error: error?.message || String(error) }));
    } finally {
      clearInterval(wakeTimer);
    }
    this.appendSessionLog("game-surface", {
      event: mounted?.mounted ? "background-page-mounted" : "background-page-mount-timeout",
      ...mounted,
      pageUrl: this.gameSurface.webContents.getURL()
    });
    if (mounted?.mounted) {
      const becameReady = !this.gameSurfaceReady;
      this.gameSurfaceReady = true;
      if (becameReady) this.scheduleBackgroundDataRefresh();
    }
    return mounted;
  }

  async readConversationList({ mountTimeoutMs = 15000 } = {}) {
    if (!this.work?.url) return { items: [], activeId: null, activeName: null, hasNewButton: false, hasChat: false };
    const appId = parseInviteWork(this.work.suffix, this.origin).id;
    const localItems = this.localHostConversationItems();
    // The REST list does not depend on the conversation DOM.  Begin it before
    // page loading/hydration so a slow renderer cannot hold the list hostage.
    const apiPayloadPromise = this.platformChatApi(
      `/installed-apps/${encodeURIComponent(appId)}/conversations?limit=500`,
      { timeout: localItems.length ? 1800 : 4500 }
    ).then(payload => ({ payload, error: null }))
      .catch(error => ({ payload: null, error: error?.message || String(error) }));
    this.keepGameSurfaceResident();
    const gameUrl = this.workGameUrl();
    if (!this.isSameWorkPage(this.gameSurface.webContents.getURL(), gameUrl)) await this.gameSurface.webContents.loadURL(gameUrl);
    await this.ensureGameSurfaceMounted({ timeoutMs: mountTimeoutMs });
    const domPromise = this.gameSurface.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
      const normalize = value => String(value || '').replace(/[\\s\\u00a0\\u200b]+/g,'');
      const isNewConversation = value => /^(新对话|新建对话|创建新对话|新的对话|NewChat|NewConversation)$/i.test(normalize(value));
      const snapshot = () => {
        const labels = [...document.querySelectorAll('[id^="checkbox-list-label-"]')];
        const newButton = [...document.querySelectorAll('button,[role="button"]')].find(button => isNewConversation(button.textContent) || isNewConversation(button.getAttribute('aria-label')) || isNewConversation(button.getAttribute('title')));
        const items = labels.map(label => {
          const row = label.closest('[role="presentation"]') || label.parentElement;
          const rawId = (label?.id || '').replace(/^checkbox-list-label-/, '');
          return { id: rawId || '', name: (label?.textContent || '').trim() || '未命名会话', active: row?.getAttribute('data-active') === 'true' };
        });
        const active = items.find(item => item.active) || null;
        let storedActiveId = null;
        try {
          const map = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
          const stored = map?.[${JSON.stringify(appId)}];
          storedActiveId = typeof stored === 'string' ? stored : stored?.conversationId || stored?.conversation_id || stored?.id || null;
        } catch {}
        return { items, activeId: active?.id || storedActiveId || null, activeName: active?.name || null, hasNewButton: Boolean(newButton), hasChat: Boolean(document.querySelector('.chat-container')) };
      };
      // The REST endpoint supplies the full save list.  DOM inspection is only
      // needed for the selected row and therefore must never hold refresh for
      // tens of seconds while the client UI hydrates.
      for (let attempt = 0; attempt < 14; attempt += 1) {
        const current = snapshot();
        if (current.items.length) return current;
        await sleep(100);
      }
      return snapshot();
    })()`, true).catch(error => ({ items: [], activeId: null, activeName: null, hasNewButton: false, hasChat: false, error: error?.message || String(error) }));
    const apiPromise = apiPayloadPromise
      .then(result => {
        if (result.error) throw new Error(result.error);
        const payload = result.payload;
        const candidates = [
          payload?.data?.data,
          payload?.data?.data?.data,
          payload?.data?.data?.conversations,
          payload?.data?.data?.items,
          payload?.data?.data?.list,
          payload?.data?.conversations,
          payload?.data?.items,
          payload?.data?.list,
          payload?.data,
          payload?.conversations,
          payload?.items,
          payload?.list,
          payload?.result?.data,
          payload?.result?.conversations,
          payload?.result?.items,
          payload?.result?.list,
          payload
        ];
        const discoveredArrays = [];
        const queue = [{ value: payload, depth: 0 }];
        const visited = new Set();
        while (queue.length && visited.size < 120) {
          const { value, depth } = queue.shift();
          if (!value || typeof value !== "object" || visited.has(value)) continue;
          visited.add(value);
          if (Array.isArray(value)) {
            discoveredArrays.push(value);
            continue;
          }
          if (depth < 5) for (const child of Object.values(value)) queue.push({ value: child, depth: depth + 1 });
        }
        const arrays = [...candidates.filter(Array.isArray), ...discoveredArrays];
        const records = arrays.sort((left, right) => {
          const score = values => values.reduce((total, record) => total + (record && typeof record === "object" && (record.id || record.conversation_id || record.conversationId || record.uuid) ? 1 : 0), 0);
          return score(right) - score(left) || right.length - left.length;
        })[0] || [];
        const items = records.map(record => ({
          id: String(record?.id ?? record?.conversation_id ?? record?.conversationId ?? record?.uuid ?? "").trim(),
          name: String(record?.name ?? record?.title ?? record?.conversation_name ?? record?.conversationName ?? "未命名会话").trim() || "未命名会话",
          active: Boolean(record?.active ?? record?.is_active ?? record?.isActive ?? record?.selected ?? record?.current)
        })).filter(item => item.id);
        const activeId = String(
          payload?.active_conversation_id ?? payload?.activeConversationId ??
          payload?.data?.active_conversation_id ?? payload?.data?.activeConversationId ??
          items.find(item => item.active)?.id ?? ""
        ).trim() || null;
        return {
          items,
          activeId,
          totalCount: Number(payload?.total_count ?? payload?.totalCount ?? payload?.data?.total_count ?? payload?.data?.totalCount ?? items.length) || 0,
          payloadKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
          dataKeys: payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? Object.keys(payload.data).slice(0, 20) : []
        };
      })
      .catch(error => ({ items: [], activeId: null, error: error?.message || String(error) }));
    const [dom, api] = await Promise.all([domPromise, apiPromise]);
    const apiItems = api.items || [];
    // The durable host anchors are immediately available after an app restart.
    // They are a UUID-based fallback, not a name-based guess; live API/DOM data
    // overwrites their labels as soon as the platform finishes hydrating.
    const merged = new Map(localItems.map(item => [item.id, item]));
    for (const item of dom.items || []) {
      if (!item.id) continue;
      merged.set(item.id, { ...(merged.get(item.id) || {}), ...item });
    }
    for (const item of apiItems) merged.set(item.id, { ...(merged.get(item.id) || {}), ...item });
    let items = [...merged.values()];
    const pending = (dom.items || []).find(item => !item.id);
    if (pending) items = [pending, ...items];
    const activeId = dom.activeId || api.activeId || null;
    const activeItem = items.find(item => item.active || (activeId && item.id === activeId)) || null;
    items = items.map(item => ({ ...item, active: item === activeItem || Boolean(activeId && item.id === activeId) }));
    const result = {
      items,
      activeId: activeId || activeItem?.id || null,
      activeName: activeItem?.name || dom.activeName || null,
      hasNewButton: dom.hasNewButton,
      hasChat: dom.hasChat,
      apiTotalCount: api.totalCount || 0,
      apiError: api.error || null,
      source: !api.error ? "platform-api" : (dom.items || []).length ? "page-dom" : localItems.length ? "local-anchor" : "empty"
    };
    this.appendSessionLog("conversation-list", {
      event: "read-completed",
      appId,
      itemCount: result.items.length,
      activeId: result.activeId,
      source: result.source,
      domItemCount: (dom.items || []).length,
      domError: dom.error || null,
      apiItemCount: apiItems.length,
      localAnchorItemCount: localItems.length,
      apiError: api.error || null,
      apiPayloadKeys: api.payloadKeys || [],
      apiDataKeys: api.dataKeys || [],
      apiTotalCount: api.totalCount || 0
    });
    return result;
  }

  async refreshConversations({ bindHost = false, keepSessionKey = false, mountTimeoutMs = 15000 } = {}) {
    let snapshot = await this.readConversationList({ mountTimeoutMs });
    const isIncomplete = current => (
      current.apiTotalCount > current.items.length ||
      Boolean(current.apiError) ||
      current.source === "local-anchor" ||
      (!current.items.length && !current.hasNewButton && current.source === "empty")
    );
    for (let attempt = 2; attempt <= 5 && isIncomplete(snapshot); attempt += 1) {
      this.appendSessionLog("conversation-list", {
        event: "incomplete-list-retry",
        attempt,
        itemCount: snapshot.items.length,
        apiTotalCount: snapshot.apiTotalCount,
        source: snapshot.source,
        apiError: snapshot.apiError || null,
        hasNewButton: Boolean(snapshot.hasNewButton)
      });
      await new Promise(resolve => setTimeout(resolve, Math.min(1600, attempt * 300)));
      snapshot = await this.readConversationList({ mountTimeoutMs });
    }
    const previous = this.conversation;
    const previousStillExists = previous.activeId && snapshot.items.some(item => item.id === previous.activeId);
    const activeId = snapshot.activeId || (previousStillExists ? previous.activeId : null);
    const activeItem = snapshot.items.find(item => item.id === activeId) || null;
    const preservePending = keepSessionKey && !activeId && !previous.activeId && Boolean(previous.activeName);
    const activeName = snapshot.activeName || activeItem?.name || (preservePending ? previous.activeName : null);
    let items = snapshot.items.map(item => ({ ...item, active: Boolean(activeId && item.id === activeId) }));
    if (preservePending) items = [{ id: "", name: activeName, active: true }, ...items.filter(item => item.id)];
    const hasSelection = Boolean(activeName || activeId);
    let sessionKey = keepSessionKey && (!bindHost || previous.anchorRole === "host") ? previous.sessionKey : null;
    const sameSelectionKey = activeId === previous.activeId && previous.anchorRole === "host" ? previous.sessionKey : null;
    if (bindHost && hasSelection) sessionKey = this.hostSessionKey(activeId) || sessionKey || sameSelectionKey || crypto.randomUUID();
    if (!hasSelection) sessionKey = null;
    this.conversation = {
      items,
      activeId,
      activeName,
      sessionKey,
      anchorRole: sessionKey ? (bindHost ? "host" : keepSessionKey ? previous.anchorRole : null) : null,
      anchored: Boolean(sessionKey),
      hasChat: snapshot.hasChat,
      source: snapshot.source || "empty",
      updatedAt: Date.now()
    };
    if (bindHost && sessionKey) this.persistSaveAnchor({ sessionKey, conversationId: activeId, name: activeName, role: "host" });
    return this.conversation;
  }

  async refreshConversationsFromUser() {
    if (!this.work) throw new Error("请先选择作品");
    if (this.conversationBusy) throw new Error("会话操作正在进行");
    this.conversationBusy = true;
    this.conversationOperation = "refresh";
    this.emit();
    try {
      const result = await this.refreshConversations({
        bindHost: !this.room || this.room.role === "host",
        keepSessionKey: Boolean(this.conversation.sessionKey)
      });
      this.emit({ conversationsRefreshed: true });
      return result;
    } finally {
      this.conversationBusy = false;
      this.conversationOperation = null;
      this.emit();
    }
  }

  async clearGameIsolation() {
    // The live-view experiment keeps its privacy rules in a separate CSS key.
    // Editing dialogs are React portals outside .chat-container, so both keys
    // must be removed before using the platform's native Edit/Save workflow.
    await this.gamePrivacyCssPromise.catch(() => null);
    if (this.gamePrivacyCssKey) {
      await this.gameSurface.webContents.removeInsertedCSS(this.gamePrivacyCssKey).catch(() => {});
      this.gamePrivacyCssKey = null;
    }
    if (this.gameCssKey) {
      await this.gameSurface.webContents.removeInsertedCSS(this.gameCssKey).catch(() => {});
      this.gameCssKey = null;
    }
    await this.gameSurface.webContents.executeJavaScript(`(() => {
      window.__fympGameObserver?.disconnect?.();
      if (window.__fympGameRefreshTimer) clearTimeout(window.__fympGameRefreshTimer);
      delete window.__fympGameObserver;
      delete window.__fympGameRefreshTimer;
      delete window.__fympRefreshGameIsolation;
      if (document.documentElement.dataset.fySurface === 'game') delete document.documentElement.dataset.fySurface;
      delete document.documentElement.dataset.fympMessageStageState;
      for (const attribute of ['data-fymp-stage-path','data-fymp-stage-sibling','data-fymp-message-stage','data-fymp-message-path','data-fymp-message-sibling','data-fy-game-path','data-fy-game-sibling','data-fy-game-message','data-fy-game-presentation-shell']) {
        document.querySelectorAll('[' + attribute + ']').forEach(element => element.removeAttribute(attribute));
      }
      return true;
    })()`, true).catch(() => false);
  }

  async setPlatformConversationId(conversationId) {
    if (!this.work?.url) throw new Error("尚未选择作品");
    const id = String(conversationId || "");
    const appId = parseInviteWork(this.work.suffix, this.origin).id;
    const gameUrl = this.workGameUrl();
    this.keepGameSurfaceResident();
    this.appendSessionLog("conversation-state", { event: "game-page-load-started", appId, conversationId: id || null, gameUrl });
    // A newly created WebContentsView starts at about:blank. executeJavaScript on
    // that not-yet-committed document can wait forever, so load the work before
    // touching the old isolation markers.
    if (!this.isSameWorkPage(this.gameSurface.webContents.getURL(), gameUrl)) {
      await this.loadSurfaceUrl(this.gameSurface, gameUrl, "作品对话页面");
    }
    this.appendSessionLog("conversation-state", { event: "game-page-loaded", appId, conversationId: id || null, pageUrl: this.gameSurface.webContents.getURL() });
    // Chromium can reject document-start commands while a brand-new hidden
    // WebContents is still about:blank. Once the first work document exists,
    // retry before the mandatory reload below so the platform bundle is always
    // evaluated after the stream observer.
    if (!(await this.gameNetworkCaptureReady.catch(() => false))) {
      this.gameNetworkCaptureReady = this.installGameNetworkCapture();
      await this.gameNetworkCaptureReady.catch(() => false);
    }
    await this.clearGameIsolation();
    const written = await this.gameSurface.webContents.executeJavaScript(`(() => {
      const appId = ${JSON.stringify(appId)};
      const conversationId = ${JSON.stringify(id)};
      let map = {};
      try {
        const parsed = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
      } catch {}
      map[appId] = conversationId;
      localStorage.setItem('conversationIdInfo', JSON.stringify(map));
      return map[appId] === conversationId;
    })()`, true).catch(() => false);
    if (!written) throw new Error("无法写入平台当前会话状态");
    this.appendSessionLog("conversation-state", { event: "conversation-state-written", appId, conversationId: id || null });

    // useLocalStorageState does not receive a storage event from its own document.
    // Reloading is the platform-equivalent way to make every React chat state read
    // the selected conversation (or the intentionally blank new conversation).
    await this.loadSurfaceUrl(this.gameSurface, gameUrl, "作品对话页面");
    this.keepGameSurfaceResident();
    const verified = await this.gameSurface.webContents.executeJavaScript(`(() => {
      try {
        const map = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
        return String(map?.[${JSON.stringify(appId)}] || '') === ${JSON.stringify(id)};
      } catch { return false; }
    })()`, true).catch(() => false);
    if (!verified) throw new Error("平台没有保留所选会话状态");
    this.appendSessionLog("conversation-state", { event: "conversation-state-ready", appId, conversationId: id || null, pageUrl: this.gameSurface.webContents.getURL() });
    return true;
  }

  async activateConversation(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) throw new Error("请选择有效的平台会话");
    const known = this.conversation.items.find(item => item.id === id) || null;
    await this.setPlatformConversationId(id);
    const conversation = await this.refreshConversations({
      bindHost: !this.room || this.room.role === "host",
      keepSessionKey: false
    });
    if (conversation.activeId !== id) {
      const activeName = known?.name || conversation.items.find(item => item.id === id)?.name || "未命名会话";
      const bindHost = !this.room || this.room.role === "host";
      const sessionKey = bindHost
        ? this.hostSessionKey(id) || conversation.sessionKey || crypto.randomUUID()
        : conversation.sessionKey;
      this.conversation = {
        ...conversation,
        items: conversation.items.map(item => ({ ...item, active: item.id === id })),
        activeId: id,
        activeName,
        sessionKey,
        anchorRole: sessionKey ? (bindHost ? "host" : conversation.anchorRole) : null,
        anchored: Boolean(sessionKey),
        source: "platform-local-state",
        updatedAt: Date.now()
      };
      if (bindHost && sessionKey) this.persistSaveAnchor({ sessionKey, conversationId: id, name: activeName, role: "host" });
    }
    return this.conversation;
  }

  async createBlankPlatformConversation() {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        this.appendSessionLog("conversation-create", { event: "blank-state-attempt-started", attempt, workSuffix: this.work?.suffix || null });
        await this.setPlatformConversationId("");
        this.appendSessionLog("conversation-create", { event: "blank-state-created", attempt, workSuffix: this.work?.suffix || null });
        return { created: true, id: "", name: "新的对话", source: "platform-local-state" };
      } catch (error) {
        lastError = error;
        this.appendSessionLog("conversation-create", {
          event: "blank-state-attempt-failed",
          attempt,
          workSuffix: this.work?.suffix || null,
          pageUrl: this.gameSurface?.webContents?.getURL?.() || null,
          error: error?.message || String(error)
        });
        if (attempt < 3) {
          const gameUrl = this.workGameUrl();
          if (gameUrl) await this.loadSurfaceUrl(this.gameSurface, gameUrl, "作品对话页面", 12000).catch(() => {});
          await new Promise(resolve => setTimeout(resolve, attempt * 500));
        }
      }
    }
    return { created: false, reason: "state-reset-failed", detail: lastError?.message || String(lastError || "平台当前会话状态重置失败") };
  }

  async selectConversation(conversationId) {
    if (!this.loggedIn || !this.work) throw new Error("请先登录并选择作品");
    if (this.room) throw new Error("房间开启期间不能切换会话");
    if (this.conversationBusy) throw new Error("会话操作正在进行");
    const reopenGameSurface = ["loading-game", "game", "game-empty"].includes(this.mode);
    this.conversationBusy = true;
    this.conversationOperation = "select";
    if (reopenGameSurface) {
      this.mode = "loading-game";
      this.gameAutoFollow = true;
      this.detachSurface();
    }
    this.emit();
    try {
      const conversation = await this.activateConversation(conversationId);
      const ready = await this.applyGameIsolation(reopenGameSurface);
      if (reopenGameSurface) {
        if (ready) await this.showCapturedGameSurface({ conversationSelected: true });
        else {
          this.mode = "game-empty";
          this.emit({ conversationSelected: true, conversationEmpty: true });
        }
      } else {
        this.emit({ conversationSelected: true });
      }
      return conversation;
    } finally {
      this.conversationBusy = false;
      this.conversationOperation = null;
      this.emit();
    }
  }

  adoptPendingConversation(created, sessionKey, role, fallbackName = "新的对话") {
    const name = String(created?.name || fallbackName || "新的对话");
    const id = String(created?.id || "");
    this.conversation = {
      ...this.conversation,
      items: [{ id, name, active: true }, ...this.conversation.items.filter(item => item.id && item.id !== id).map(item => ({ ...item, active: false }))],
      activeId: id || null,
      activeName: name,
      sessionKey,
      anchorRole: role,
      anchored: true,
      hasChat: false,
      source: "platform-local-state",
      updatedAt: Date.now()
    };
    this.persistSaveAnchor({ sessionKey, conversationId: id || null, name, role });
    return this.conversation;
  }

  async manageConversation(action, conversationId, name) {
    if (!this.loggedIn || !this.work) throw new Error("请先登录并选择作品");
    if (this.room) throw new Error("请先退出房间再删除或重命名会话");
    if (this.conversationBusy || this.prefixAdapterBusy) throw new Error("会话操作正在进行");
    const id = String(conversationId || "");
    if (!id || !this.conversation.items.some(item => item.id === id)) throw new Error("请先选择已保存的平台会话");
    const appId = this.currentWorkAppId();
    const originalMode = this.mode;
    this.conversationBusy = true;
    this.conversationOperation = action;
    this.emit();
    try {
      await this.suspendGameSurfacePresentation();
      const result = await mutatePlatformConversation(this.platformChatApi.bind(this), { appId, id, action, name });
      updateConversationAnchors(this.anchorAccountStore(), appId, id, action === "delete" ? null : result.name, suffix => {
        try { return parseInviteWork(suffix, this.origin).id; } catch { return null; }
      });
      writeSaveAnchors(this.profileId, this.saveAnchors);
      const wasActive = this.conversation.activeId === id;
      this.conversation.items = result.items.map(item => ({ ...item, active: item.id === this.conversation.activeId }));
      if (action === "delete") {
        let targets = [];
        try { targets = readJsonWithBackupSync(fs, this.perspectiveTargetsPath(), Array.isArray).value || []; } catch {}
        atomicWriteJsonSync(fs, this.perspectiveTargetsPath(), targets.filter(item => item.appId !== appId || item.conversationId !== id));
        delete this.perspectiveViews[`${appId}:${id}`];
        atomicWriteJsonSync(fs, path.join(app.getPath("userData"), `perspective-views-${safeProfileId(this.profileId)}.json`), this.perspectiveViews);
        if (wasActive) {
          this.conversation = { ...this.conversation, activeId: null, activeName: null, sessionKey: null, anchorRole: null, anchored: false, hasChat: false };
          this.gamePresentationFrame = null;
          this.window.webContents.send("backend:game-frame", { reset: true });
          this.mode = "game-empty";
          const created = await this.createBlankPlatformConversation();
          if (!created?.created) throw new Error("平台会话已删除，但空白会话未能载入，请重新选择作品");
          this.adoptPendingConversation(created, crypto.randomUUID(), "host");
        }
      } else if (wasActive) {
        this.conversation.activeName = result.name;
      }
      // Reload the platform too: stale React rows must not restore an old name
      // or a deleted UUID on the next list refresh.
      if (!(action === "delete" && wasActive)) await this.gameSurface.webContents.loadURL(this.workGameUrl());
      if (["game", "loading-game", "game-empty"].includes(originalMode) && !(action === "delete" && wasActive)) {
        await this.applyGameIsolation(true);
      }
      this.conversation.updatedAt = Date.now();
      this.conversation.source = "platform-api";
      return this.conversation;
    } finally {
      this.conversationBusy = false;
      this.conversationOperation = null;
      this.resumeGameSurfacePresentation();
      this.emit();
    }
  }

  async createNewConversation() {
    if (!this.loggedIn || !this.work) throw new Error("请先登录并选择作品");
    if (this.room) throw new Error("房间开启期间不能新建会话");
    if (this.conversationBusy) throw new Error("会话操作正在进行");
    this.conversationBusy = true;
    this.conversationOperation = "new";
    this.emit();
    try {
      const created = await this.createBlankPlatformConversation();
      if (!created?.created) {
        throw new Error(`无法建立新会话：${created?.detail || "平台当前会话状态重置失败"}`);
      }
      const sessionKey = crypto.randomUUID();
      this.adoptPendingConversation(created, sessionKey, "host");
      if (this.room?.role === "host") {
        this.room.save = { key: sessionKey, conversationId: null, name: this.conversation.activeName || "新的对话" };
        this.room.round = this.newRound(1);
        for (const member of this.room.members) {
          if (String(member.id) !== String(this.account.accountId)) this.room.memberHistory[String(member.id)] = "preparing";
        }
        await this.broadcastRoomPacket("conversation-anchor", {
          saveKey: sessionKey,
          saveName: this.room.save.name
        });
        this.appendSessionLog("guest-anchor", { event: "host-created-room-conversation", sessionKey, name: this.room.save.name });
      }
      this.mode = "game-empty";
      this.detachSurface();
      this.emit({ conversationCreated: true });
      return this.conversation;
    } finally {
      this.conversationBusy = false;
      this.conversationOperation = null;
      this.emit();
    }
  }

  createAnchorWindow() {
    const anchor = new BrowserWindow({ show: false, webPreferences: {
      partition: this.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }});
    anchor.setSkipTaskbar(true);
    anchor.webContents.on("unresponsive", () => {
      if (!anchor.isDestroyed()) void anchor.reload();
    });
    anchor.on("closed", () => {
      if (this.anchor !== anchor) return;
      this.anchor = null;
      if (!this.destroying) {
        this.anchor = this.createAnchorWindow();
        if (this.domainSelected && this.anchorNavigationArmed) void this.anchor.loadURL(`${this.origin}/zh/chats`);
      }
    });
    return anchor;
  }

  async ensureAnchor() {
    if (!this.anchor || this.anchor.isDestroyed()) this.anchor = this.createAnchorWindow();
    if (this.domainSelected && this.anchorNavigationArmed && !this.anchor.webContents.getURL() && !this.anchor.webContents.isLoading()) {
      await this.anchor.loadURL(`${this.origin}/zh/chats`);
    }
    return this.anchor;
  }

  isAdminAccount() {
    return String(this.account?.email || "").trim().toLocaleLowerCase() === ADMIN_EMAIL;
  }

  assertAdminAccount() {
    this.assertToolLoggedIn();
    if (!this.isAdminAccount()) throw new Error("此功能仅管理员账号可用");
  }

  appendSessionLog(category, detail = {}) {
    // Closing deletes the entire session log by design. Late completions from a
    // pending network/debugger promise must not recreate that file afterwards.
    if (this.destroying) return null;
    const entry = {
      seq: ++this.sessionLogSequence,
      time: new Date().toISOString(),
      profileId: this.profileId,
      role: this.room?.role || null,
      roomId: this.room?.id || null,
      category: String(category || "event"),
      detail: sanitizeLogDetail(detail)
    };
    this.sessionLogs.push(entry);
    if (this.sessionLogs.length > 2000) this.sessionLogs.splice(0, this.sessionLogs.length - 2000);
    let serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
      entry.detail = { truncated: true, reason: "单条日志超过 64 KiB" };
      serialized = JSON.stringify(entry);
    }
    try { fs.appendFileSync(this.sessionLogFile, `${serialized}\n`, "utf8"); }
    catch {}
    if (this.isAdminAccount() && !this.window.isDestroyed()) this.window.webContents.send("backend:log", entry);
    return entry;
  }

  getSessionLogs() {
    this.assertAdminAccount();
    return [...this.sessionLogs];
  }

  bindDiagnosticExportShortcut(webContents) {
    if (!webContents || webContents.isDestroyed?.() || webContents.__fengyueDiagnosticShortcutBound) return;
    webContents.__fengyueDiagnosticShortcutBound = true;
    webContents.on("before-input-event", (event, input) => {
      const pressed = input?.type === "keyDown" && Boolean(input.control) && Boolean(input.shift)
        && (String(input.code || "") === "Digit8" || String(input.key || "") === "8" || String(input.key || "") === "*");
      if (!pressed || input.isAutoRepeat) return;
      event.preventDefault();
      this.triggerDiagnosticExport("webcontents");
    });
  }

  registerDiagnosticGlobalShortcut() {
    const accelerator = "CommandOrControl+Shift+8";
    try {
      const registered = globalShortcut.register(accelerator, () => this.triggerDiagnosticExport("global"));
      this.diagnosticGlobalShortcutRegistered = Boolean(registered);
      this.appendSessionLog("diagnostic-shortcut", {
        event: registered ? "global-registered" : "global-register-failed",
        accelerator
      });
      return registered;
    } catch (error) {
      this.appendSessionLog("diagnostic-shortcut", {
        event: "global-register-error",
        accelerator,
        error: error?.message || String(error)
      });
      return false;
    }
  }

  unregisterDiagnosticGlobalShortcut() {
    if (!this.diagnosticGlobalShortcutRegistered) return;
    try { globalShortcut.unregister("CommandOrControl+Shift+8"); } catch {}
    this.diagnosticGlobalShortcutRegistered = false;
  }

  triggerDiagnosticExport(source = "unknown") {
    if (this.destroying || this.diagnosticExportBusy) return;
    this.diagnosticExportBusy = true;
    this.runBackgroundTask("export-diagnostic-log", async () => {
      try {
        const file = this.exportDiagnosticLogToDesktop();
        if (this.window && !this.window.isDestroyed()) {
          await dialog.showMessageBox(this.window, {
            type: "info",
            title: "日志已保存",
            message: "诊断日志已保存到桌面",
            detail: file,
            buttons: ["确定"],
            defaultId: 0,
            noLink: true
          });
        }
        this.appendSessionLog("diagnostic-export", { event: "completed", source, file });
      } finally {
        this.diagnosticExportBusy = false;
      }
    });
  }

  exportDiagnosticLogToDesktop() {
    this.appendSessionLog("diagnostic-export", { event: "requested", shortcut: "Ctrl+Shift+8" });
    const directory = path.dirname(this.sessionLogFile);
    const prefix = `${safeProfileId(this.profileId)}-`;
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".jsonl"))
      .map(entry => path.join(directory, entry.name))
      .sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "");
    const target = path.join(app.getPath("desktop"), `风月联机日志-${stamp}.txt`);
    const header = [
      "风月联机工具诊断日志",
      `导出时间: ${new Date().toISOString()}`,
      `配置实例: ${this.profileId}`,
      `账号: ${this.account?.username || "未登录"}`,
      `在线世界: ${this.onlineWorldService?.work?.id || "未打开"}`,
      "每行均为一条按时间记录的 JSON 行为或诊断事件。",
      ""
    ].join("\n");
    const body = files.map(file => fs.readFileSync(file, "utf8").trim()).filter(Boolean).join("\n");
    atomicWriteFileSync(fs, target, `${header}${body}${body ? "\n" : ""}`, { encoding: "utf8", mode: 0o600 });
    return target;
  }

  rememberSeenPacket(value) {
    const key = String(value || "");
    if (!key) return;
    this.seenPackets.delete(key);
    this.seenPackets.add(key);
    while (this.seenPackets.size > 10000) this.seenPackets.delete(this.seenPackets.values().next().value);
  }

  emit(extra = {}) {
    this.keepGameSurfaceResident();
    this.keepSettingsSurfaceOnTop();
    if (this.window.isDestroyed()) return;
    const next = this.state(extra);
    this.window.webContents.send("backend:state", next);
    if (this.settingsSurface?.webContents && !this.settingsSurface.webContents.isDestroyed()) {
      this.settingsSurface.webContents.send("backend:state", next);
    }
  }

  attachSurface(view = this.surface) {
    if (this.liveGameSurface && this.gameSurface?.webContents && !this.gameSurface.webContents.isDestroyed()) {
      this.gameSurface.setBounds(this.backgroundWindowBounds());
    }
    if (this.activeSurface && this.activeSurface !== view) this.window.contentView.removeChildView(this.activeSurface);
    if (this.activeSurface !== view) this.window.contentView.addChildView(view);
    this.activeSurface = view;
    this.surfaceAttached = true;
    view.setBounds(this.surfaceBounds);
    this.setIntroAudioMuted(view !== this.introSurface);
    this.keepSettingsSurfaceOnTop();
  }

  detachSurface() {
    if (!this.surfaceAttached || !this.activeSurface) return;
    this.window.contentView.removeChildView(this.activeSurface);
    this.activeSurface = null;
    this.surfaceAttached = false;
    this.setIntroAudioMuted(true);
    this.keepGameSurfaceResident();
    this.keepSettingsSurfaceOnTop();
  }

  setIntroAudioMuted(muted) {
    const webContents = this.introSurface?.webContents;
    if (!webContents || webContents.isDestroyed()) return false;
    try {
      webContents.setAudioMuted(Boolean(muted));
      return true;
    } catch {
      return false;
    }
  }

  closePlatformView(view) {
    if (!view) return;
    try { this.window.contentView.removeChildView(view); } catch {}
    try {
      if (view.webContents && !view.webContents.isDestroyed()) {
        view.webContents.stop?.();
        view.webContents.close();
      }
    } catch {}
    try {
      if (typeof view.destroy === "function" && !view.isDestroyed?.()) view.destroy();
    } catch {}
  }

  setBounds(bounds) {
    const nextBounds = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(100, Math.round(Number(bounds.width) || 100)),
      height: Math.max(100, Math.round(Number(bounds.height) || 100))
    };
    if (
      this.surfaceBounds.x === nextBounds.x && this.surfaceBounds.y === nextBounds.y &&
      this.surfaceBounds.width === nextBounds.width && this.surfaceBounds.height === nextBounds.height
    ) return false;
    this.surfaceBounds = nextBounds;
    for (const view of [this.surface, this.introSurface]) {
      if (view && !view.webContents.isDestroyed()) view.setBounds(this.surfaceBounds);
    }
    this.keepGameSurfaceResident();
    this.keepSettingsSurfaceOnTop();
    return true;
  }

  beginGuestOutputWait(round) {
    if (this.room?.role !== "guest") return;
    this.room.pendingOutputRound = Math.max(this.room.pendingOutputRound || 0, Number(round) || 0);
    this.guestPresentationEpoch = (this.guestPresentationEpoch || 0) + 1;
    this.gamePresentationFrame = null;
    if (!this.window.isDestroyed()) this.window.webContents.send("backend:game-frame", { reset: true });
    this.keepGameSurfaceResident();
  }

  guestOutputPending() {
    if (this.room?.role !== "guest") return false;
    return Number(this.room.pendingOutputRound || 0) > Number(this.room.verifiedOutputRound || 0)
      || ["processing-input", "generating", "processing-output"].includes(this.room.round?.status);
  }

  gameFrameModeVisible() {
    return !this.perspectivePresentationBlocked && !this.guestOutputPending()
      && ["loading-game", "game", "game-empty"].includes(this.mode);
  }

  gameSurfaceShouldPresent() {
    return this.gameFrameModeVisible() && this.gameSurfacePresentationLocks === 0;
  }

  async setSettingsVisible(value) {
    this.settingsVisible = Boolean(value);
    if (this.settingsVisible) {
      await this.ensureSettingsSurface();
      if (this.settingsVisible) this.keepSettingsSurfaceOnTop();
    } else if (this.settingsSurfaceAttached && this.settingsSurface) {
      try { this.window.contentView.removeChildView(this.settingsSurface); } catch {}
      this.settingsSurfaceAttached = false;
    }
    this.keepGameSurfaceResident();
    this.emit({ settingsVisibilityChanged: true });
    return this.settingsVisible;
  }

  async publishLiveGameSnapshot() {
    if (!this.gameFrameModeVisible()) return false;
    const epoch = this.guestPresentationEpoch;
    const webContents = this.gameSurface?.webContents;
    if (!this.liveGameSurface || !webContents || webContents.isDestroyed() || webContents.isLoadingMainFrame() || this.window.isDestroyed()) return false;
    try {
      const image = await webContents.capturePage();
      if (!this.gameFrameModeVisible() || epoch !== this.guestPresentationEpoch) return false;
      if (!image || image.isEmpty()) return false;
      const size = image.getSize();
      this.window.webContents.send("backend:game-frame", {
        bytes: image.toJPEG(92),
        mimeType: "image/jpeg",
        width: size.width,
        height: size.height,
        capturedAt: Date.now(),
        frozen: true
      });
      return true;
    } catch (error) {
      this.appendSessionLog("game-surface", { event: "live-fallback-frame-failed", error: error?.message || String(error) });
      return false;
    }
  }

  async suspendGameSurfacePresentation() {
    if (this.gameSurfacePresentationLocks === 0) await this.publishLiveGameSnapshot();
    this.gameSurfacePresentationLocks += 1;
    this.keepGameSurfaceResident();
  }

  resumeGameSurfacePresentation() {
    this.gameSurfacePresentationLocks = Math.max(0, this.gameSurfacePresentationLocks - 1);
    this.keepGameSurfaceResident();
  }

  queueGamePresentationFrame(force = false) {
    if (this.destroying || !this.gameFrameModeVisible() || !this.gameFrameCrop || !this.gamePresentationFrame) return false;
    if (this.gameFrameEncodeBusy) {
      this.gameFramePublishPending = true;
      return true;
    }
    const frameInterval = 1000 / 30;
    const remaining = Math.max(0, frameInterval - (Date.now() - this.gameFrameLastSentAt));
    if (force || remaining <= 0) {
      if (this.gameFramePublishTimer) {
        clearTimeout(this.gameFramePublishTimer);
        this.gameFramePublishTimer = null;
      }
      void this.publishGamePresentationFrame();
      return true;
    }
    if (!this.gameFramePublishTimer) {
      this.gameFramePublishTimer = setTimeout(() => {
        this.gameFramePublishTimer = null;
        void this.publishGamePresentationFrame();
      }, Math.ceil(remaining));
    }
    return true;
  }

  async publishGamePresentationFrame() {
    if (
      this.gameFrameEncodeBusy || this.destroying || !this.gameFrameModeVisible() ||
      !this.gameFrameCrop || !this.gamePresentationFrame || this.window.isDestroyed()
    ) return false;
    this.gameFrameEncodeBusy = true;
    try {
      const image = this.presentationFrameForCrop(this.gameFrameCrop);
      if (!image || image.isEmpty()) return false;
      // Binary JPEG avoids the base64 expansion and repeated <img src> layout
      // work of the old 5 FPS screenshot path. Quality 92 keeps small Chinese
      // text crisp while remaining cheap enough for an event-driven 30 FPS UI.
      const bytes = image.toJPEG(92);
      if (!bytes?.length) return false;
      this.gameFrameLastSentAt = Date.now();
      this.window.webContents.send("backend:game-frame", {
        bytes,
        mimeType: "image/jpeg",
        width: this.gameFrameCrop.width,
        height: this.gameFrameCrop.height,
        capturedAt: this.gameFrameLastSentAt
      });
      return true;
    } catch (error) {
      this.appendSessionLog("game-surface", {
        event: "browser-frame-stream-failed",
        error: error?.message || String(error)
      });
      return false;
    } finally {
      this.gameFrameEncodeBusy = false;
      if (this.gameFramePublishPending) {
        this.gameFramePublishPending = false;
        this.queueGamePresentationFrame();
      }
    }
  }

  async captureGameFrame(force = false) {
    if (this.liveGameSurface) {
      this.keepGameSurfaceResident();
      return Boolean(this.gameSurface?.webContents && !this.gameSurface.webContents.isDestroyed());
    }
    if (this.gameFrameBusy || this.destroying || this.gameSurface?.isDestroyed?.()) return false;
    if (!force && !["game", "guest-waiting"].includes(this.mode)) return false;
    const webContents = this.gameSurface?.webContents;
    if (!webContents || webContents.isDestroyed() || webContents.isLoadingMainFrame()) return false;
    this.gameFrameBusy = true;
    try {
      const crop = await webContents.executeJavaScript(`(() => {
        const chat = document.querySelector('.chat-container');
        if (!chat) return null;
        if (${JSON.stringify(this.gameAutoFollow)}) chat.scrollTop = chat.scrollHeight;
        const rect = chat.getBoundingClientRect();
        const left = Math.max(0, Math.floor(rect.left));
        const top = Math.max(0, Math.floor(rect.top));
        const right = Math.min(window.innerWidth, Math.ceil(rect.right));
        const bottom = Math.min(window.innerHeight, Math.ceil(rect.bottom));
        if (right <= left || bottom <= top) return null;
        return {
          x:left,y:top,width:right-left,height:bottom-top,
          viewportWidth:window.innerWidth,
          viewportHeight:window.innerHeight,
          questionCount:chat.querySelectorAll('#customized-question-content').length,
          answerCount:chat.querySelectorAll('#ai-chat-answer').length,
          scrollTop:chat.scrollTop,
          scrollHeight:chat.scrollHeight,
          clientHeight:chat.clientHeight,
          atBottom:chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 4
        };
      })()`, true).catch(() => null);
      if (!crop || crop.width < 2 || crop.height < 2 || (!crop.questionCount && !crop.answerCount)) return false;
      const firstFrame = !this.gameFrameCrop;
      this.gameFrameCrop = {
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
        viewportWidth: crop.viewportWidth,
        viewportHeight: crop.viewportHeight
      };
      this.ensureGameOffscreenPainting();
      try { webContents.invalidate(); } catch {}
      if (firstFrame || force) this.queueGamePresentationFrame(Boolean(force));
      if (firstFrame) {
        this.appendSessionLog("game-surface", {
          event: "browser-frame-stream-started",
          width: crop.width,
          height: crop.height,
          targetFps: 30,
          encoding: "jpeg-binary",
          questionCount: crop.questionCount,
          answerCount: crop.answerCount,
          pageUrl: webContents.getURL()
        });
      }
      return true;
    } catch (error) {
      if (force) this.appendSessionLog("game-surface", { event: "browser-frame-capture-failed", error: error?.message || String(error) });
      return false;
    } finally {
      this.gameFrameBusy = false;
    }
  }

  async keepGameSurfaceAwake() {
    const webContents = this.gameSurface?.webContents;
    this.keepGameSurfaceResident();
    if (
      this.destroying || this.gameWakeBusy || this.gameFrameBusy || !this.work ||
      !webContents || webContents.isDestroyed() || webContents.isLoadingMainFrame()
    ) return false;
    this.gameWakeBusy = true;
    try {
      const gameUrl = this.workGameUrl();
      if (gameUrl && !this.isSameWorkPage(webContents.getURL(), gameUrl)) {
        await this.loadSurfaceUrl(this.gameSurface, gameUrl, "常驻对话页面", 15000);
        await this.applyGamePrivacyCss();
      }
      this.ensureGameOffscreenPainting();
      try { webContents.invalidate(); } catch {}
      const ready = await webContents.executeJavaScript(`(() => Boolean(
        document.querySelector('#ai-chat-input,[id^="checkbox-list-label-"]') ||
        [...document.querySelectorAll('button,[role="button"]')].some(element => /新.*对话|New.*(?:Chat|Conversation)/i.test(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || ''))
      ))()`, true).catch(() => false);
      if (ready && !this.gameSurfaceReady) {
        this.gameSurfaceReady = true;
        await this.applyGamePrivacyCss();
        this.appendSessionLog("work-surfaces", {
          event: "resident-game-became-ready",
          pageUrl: webContents.getURL()
        });
        this.scheduleBackgroundDataRefresh();
      }
      return this.liveGameSurface ? true : Boolean(webContents.isPainting() || this.gamePresentationFrame);
    } catch {
      return false;
    } finally {
      this.gameWakeBusy = false;
    }
  }

  async keepIntroSurfaceAwake() {
    const webContents = this.introSurface?.webContents;
    if (
      this.destroying || this.introWakeBusy || !this.work ||
      !webContents || webContents.isDestroyed() || webContents.isLoadingMainFrame()
    ) return false;
    this.introWakeBusy = true;
    try {
      const introUrl = this.workIntroUrl();
      if (introUrl && !this.isSameWorkPage(webContents.getURL(), introUrl)) {
        await this.loadSurfaceUrl(this.introSurface, introUrl, "常驻介绍页面", 15000);
        this.introReady = Boolean(await this.applyIntroIsolation());
      }
      const image = await webContents.capturePage(
        { x: 0, y: 0, width: 2, height: 2 },
        { stayHidden: true, stayAwake: true }
      );
      return Boolean(image && !image.isEmpty());
    } catch {
      return false;
    } finally {
      this.introWakeBusy = false;
    }
  }

  async showCapturedGameSurface(extra = {}) {
    this.detachSurface();
    this.mode = "game";
    if (this.liveGameSurface) {
      await this.applyGameIsolation(true);
      this.keepGameSurfaceResident();
      this.emit({ ...extra, liveGameViewShown: true });
      return true;
    }
    this.emit(extra);
    return this.captureGameFrame(true);
  }

  async scrollGame(deltaY) {
    if (!["loading-game", "game", "game-empty", "guest-waiting", "guest-syncing"].includes(this.mode)) return { scrolled: false, reason: "not-visible" };
    const amount = Math.max(-2400, Math.min(2400, Number(deltaY) || 0));
    if (!amount) return { scrolled: false, reason: "empty-delta" };
    // A manual upward gesture disables live auto-follow. It is enabled again
    // only when the user scrolls back to the platform conversation's bottom.
    this.gameAutoFollow = false;
    const result = await this.gameSurface.webContents.executeJavaScript(`(() => {
      const chat = document.querySelector('.chat-container');
      if (!chat) return {scrolled:false,reason:'missing-chat'};
      const before = chat.scrollTop;
      chat.scrollTop = Math.max(0,Math.min(chat.scrollHeight-chat.clientHeight,before + ${JSON.stringify(amount)}));
      const atBottom = chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 4;
      return {
        scrolled:Math.abs(chat.scrollTop-before) > 0.5,
        scrollTop:chat.scrollTop,
        scrollHeight:chat.scrollHeight,
        clientHeight:chat.clientHeight,
        atBottom
      };
    })()`, true).catch(() => ({ scrolled: false, reason: "page-error" }));
    this.gameAutoFollow = Boolean(result?.atBottom);
    await this.captureGameFrame(true);
    return result;
  }

  gameInputPoint(payload = {}) {
    const crop = this.gameFrameCrop;
    if (!crop) return null;
    const localX = Number(payload.x);
    const localY = Number(payload.y);
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) return null;
    return {
      x: crop.x + Math.max(0, Math.min(crop.width - 1, localX)),
      y: crop.y + Math.max(0, Math.min(crop.height - 1, localY))
    };
  }

  async dispatchGamePointer(payload = {}) {
    if (this.mode !== "game") return { dispatched: false, reason: "not-visible" };
    const point = this.gameInputPoint(payload);
    if (!point) return { dispatched: false, reason: "missing-frame" };
    const kind = String(payload.type || "move");
    if (!["move", "down", "up"].includes(kind)) return { dispatched: false, reason: "invalid-type" };
    const button = ["left", "right", "middle"].includes(payload.button) ? payload.button : "left";
    const webContents = this.gameSurface.webContents;
    const cdpType = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" }[kind];
    try {
      if (webContents.debugger.isAttached()) {
        await webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: cdpType,
          x: point.x,
          y: point.y,
          button: kind === "move" ? "none" : button,
          buttons: Math.max(0, Number(payload.buttons) || 0),
          clickCount: kind === "move" ? 0 : Math.max(1, Number(payload.clickCount) || 1)
        });
      } else {
        webContents.focus();
        webContents.sendInputEvent({
          type: { move: "mouseMove", down: "mouseDown", up: "mouseUp" }[kind],
          x: Math.round(point.x),
          y: Math.round(point.y),
          button,
          clickCount: Math.max(1, Number(payload.clickCount) || 1)
        });
      }
    } catch (error) {
      this.appendSessionLog("game-input", { event: "pointer-dispatch-failed", kind, error: error?.message || String(error) });
      return { dispatched: false, reason: "dispatch-failed" };
    }
    if (kind !== "move") this.gameAutoFollow = false;
    if (kind === "up") {
      setTimeout(() => void this.captureGameFrame(true), 50);
      setTimeout(() => void this.captureGameFrame(true), 220);
    }
    return { dispatched: true };
  }

  async dispatchGameKey(payload = {}) {
    if (this.mode !== "game") return { dispatched: false, reason: "not-visible" };
    const webContents = this.gameSurface.webContents;
    const text = typeof payload.text === "string" ? payload.text : "";
    const key = String(payload.key || "");
    try {
      if (webContents.debugger.isAttached()) {
        if (text) {
          await webContents.debugger.sendCommand("Input.insertText", { text });
        } else if (key) {
          const modifiers = (payload.altKey ? 1 : 0) | (payload.ctrlKey ? 2 : 0) | (payload.metaKey ? 4 : 0) | (payload.shiftKey ? 8 : 0);
          const event = { key, code: String(payload.code || key), modifiers };
          await webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
          await webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...event });
        }
      } else if (text) {
        webContents.insertText(text);
      } else if (key) {
        webContents.sendInputEvent({ type: "keyDown", keyCode: key });
        webContents.sendInputEvent({ type: "keyUp", keyCode: key });
      }
    } catch (error) {
      this.appendSessionLog("game-input", { event: "key-dispatch-failed", key, error: error?.message || String(error) });
      return { dispatched: false, reason: "dispatch-failed" };
    }
    setTimeout(() => void this.captureGameFrame(true), 80);
    return { dispatched: true };
  }

  bindSurfaceNavigation() {
    this.surface.webContents.on("will-navigate", (event, url) => {
      if (this.mode === "selector" && this.isWorkUrl(url)) {
        event.preventDefault();
        void this.acceptWork(url);
      } else if (this.mode === "selector" && isHttpUrl(url)) {
        const rebased = platformUrlForOrigin(this.origin, url).href;
        if (rebased !== url) {
          event.preventDefault();
          void this.surface.webContents.loadURL(rebased);
        }
      } else if (this.mode === "login" && isHttpUrl(url)) {
        const rebased = platformUrlForOrigin(this.origin, url).href;
        if (rebased !== url) {
          event.preventDefault();
          void this.surface.webContents.loadURL(rebased);
        }
      } else if (!isHttpUrl(url)) event.preventDefault();
    });
    this.surface.webContents.setWindowOpenHandler(({ url }) => {
      if (this.mode === "selector" && this.isWorkUrl(url)) void this.acceptWork(url);
      else if (isHttpUrl(url) && this.mode === "selector") void this.surface.webContents.loadURL(platformUrlForOrigin(this.origin, url).href);
      else if (isHttpUrl(url) && this.mode === "login") void this.surface.webContents.loadURL(platformUrlForOrigin(this.origin, url).href);
      else if (isHttpUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  }

  isWorkUrl(value) {
    try { return WORK_PATH.test(platformUrlForOrigin(this.origin, value).pathname); } catch { return false; }
  }

  workGameUrl() {
    if (!this.work?.url) return null;
    const url = platformUrlForOrigin(this.origin, this.work.url);
    const appId = parseInviteWork(url.href, this.origin).id;
    url.pathname = `/zh/explore/installed/${encodeURIComponent(appId)}`;
    url.searchParams.delete("preview");
    return url.href;
  }

  workIntroUrl() {
    if (!this.work?.url) return null;
    const url = platformUrlForOrigin(this.origin, this.work.url);
    const appId = parseInviteWork(url.href, this.origin).id;
    url.pathname = `/zh/explore/installed/${encodeURIComponent(appId)}`;
    url.searchParams.set("preview", "1");
    return url.href;
  }

  isSameWorkPage(value, expectedValue = this.workGameUrl()) {
    if (!expectedValue) return false;
    if (!this.work?.url) return false;
    try {
      const current = new URL(value);
      const expected = new URL(expectedValue);
      return current.origin === expected.origin && current.pathname === expected.pathname && current.search === expected.search;
    } catch { return false; }
  }

  async bootstrap() {
    this.mode = "login";
    this.detachSurface();
    this.emit();
    void this.updateService.start();
    const releaseState = await this.releaseSecurity.initialize();
    this.appendSessionLog("release-security", {
      event: releaseState.verified ? "startup-verification-complete" : "startup-verification-blocked",
      version: releaseState.currentVersion,
      latestVersion: releaseState.latestVersion,
      source: releaseState.source,
      verifiedFileCount: releaseState.verifiedFileCount || 0,
      code: releaseState.errorCode || null
    });
    this.emit();
    if (this.domainSelected) void this.prepareLoginPage();
  }

  async verifyOfficialRelease() {
    try {
      const result = await this.releaseSecurity.ensureVerified();
      this.appendSessionLog("release-security", {
        event: "verified",
        version: result.currentVersion,
        latestVersion: result.latestVersion,
        source: result.source
      });
      this.emit({ releaseSecurityVerified: true });
      return result;
    } catch (error) {
      this.appendSessionLog("release-security", {
        event: "blocked",
        code: error?.code || "verification-failed",
        error: error?.message || String(error)
      });
      this.emit({ releaseSecurityError: error?.message || "版本号对照未通过" });
      throw new Error(error?.message || "版本号对照未通过");
    }
  }

  async allowDetectedAuthenticatedSession() {
    const releaseState = await this.releaseSecurity.initialize();
    return Boolean(releaseState.verified);
  }

  async prepareLoginPage() {
    if (!this.domainSelected || this.loginInProgress) return false;
    const origin = this.origin;
    if (this.loginPageWarmOrigin === origin && this.loginPageWarmPromise) return this.loginPageWarmPromise;
    this.loginPageWarmOrigin = origin;
    this.loginPageWarmReady = false;
    this.loginPageWarmController?.abort();
    const controller = new AbortController();
    this.loginPageWarmController = controller;
    const timer = setTimeout(() => controller.abort(), 12000);
    const task = (async () => {
      const anchor = await this.ensureAnchor();
      try {
        const current = new URL(anchor.webContents.getURL());
        if (current.origin === origin && /\/(?:zh\/)?signin\/?$/i.test(current.pathname) && !anchor.webContents.isLoading()) return true;
      } catch {}
      try {
        await this.loadLoginPage(anchor, origin, controller.signal);
        this.loginPageWarmReady = this.origin === origin;
        return this.origin === origin;
      } catch (error) {
        this.appendSessionLog("login", { event: "page-warm-failed", origin, error: error?.message || String(error) });
        return false;
      }
    })().finally(() => {
      clearTimeout(timer);
      if (this.loginPageWarmController === controller) this.loginPageWarmController = null;
    });
    this.loginPageWarmPromise = task;
    return task;
  }

  async loadLoginPage(anchor, origin, signal) {
    await waitForLoginTask(this.networkReady, signal);
    assertLoginActive(signal);
    const contents = anchor.webContents;
    const url = platformUrlForOrigin(origin, "/zh/signin").href;
    let ready;
    const domReady = new Promise(resolve => {
      ready = () => {
        try { if (new URL(contents.getURL()).origin === origin) resolve(true); } catch {}
      };
      contents.on("dom-ready", ready);
    });
    try {
      await waitForLoginTask(Promise.race([domReady, contents.loadURL(url)]), signal);
      assertLoginActive(signal);
    } finally {
      if (!contents.isDestroyed()) contents.removeListener("dom-ready", ready);
    }
  }

  stopLoginPage(anchor = this.anchor) {
    if (!anchor || this.anchor === anchor) {
      this.anchorNavigationArmed = false;
      this.loginPageWarmController?.abort();
      this.loginPageWarmController = null;
      this.loginPageWarmOrigin = null;
      this.loginPageWarmPromise = null;
      this.loginPageWarmReady = false;
      this.anchor = null;
    }
    if (anchor && !anchor.isDestroyed()) anchor.destroy();
  }

  cancelLogin() {
    const controller = this.loginController;
    if (!controller && this.oauthWindow) {
      this.authSessionRevision += 1;
      this.loginDetectionPaused = true;
      this.closeOAuthWindows();
      this.loginInProgress = false;
      this.loginProgress = null;
      this.mode = "login";
      this.emit();
      return true;
    }
    if (!controller || controller.signal.aborted) return false;
    this.authSessionRevision += 1;
    this.loginDetectionPaused = true;
    controller.abort(loginError("LOGIN_CANCELLED", "登录已取消"));
    this.stopLoginPage();
    this.loginProgress = { phase: "cancelled" };
    this.appendSessionLog("login", { event: "cancelled" });
    this.emit();
    return true;
  }

  async setOrigin(value) {
    if (this.originLocked || this.loggedIn || this.loginInProgress || this.room) throw new Error("本次工具会话的登录域名已经锁定");
    const origin = normalizePublishedOrigin(value);
    if (!origin || !TRUSTED_PLATFORM_ORIGINS.has(origin)) throw new Error("请输入两个官方发布页列出的风月域名");
    const item = currentDomainCandidates(this.origin).domains.find(domain => domain.origin === origin || domain.finalOrigin === origin);
    if (!item) throw new Error("输入的域名不在当前官方节点目录中");
    this.origin = item.finalOrigin || item.origin;
    this.domainSelected = true;
    this.authSessionRevision += 1;
    this.anchorNavigationArmed = false;
    this.work = null;
    saveSelectedOrigin(this.profileId, this.origin);
    this.mode = "login";
    this.detachSurface();
    this.emit({ domainSelected: true });
    void this.prepareLoginPage();
    return this.state();
  }

  async logout({ emit = true } = {}) {
    if (this.conversationBusy) throw new Error("请等待会话操作完成后再登出");
    if (this.room) throw new Error("请先退出或关闭当前房间，再登出账号");
    if (this.loginInProgress) throw new Error("登录流程进行中，请稍后再试");
    this.cancelAutoModels();
    const previousOrigin = this.origin;
    this.onlineWorldService.close();
    this.authSessionRevision += 1;
    this.clearAuthenticationFailures("explicit-logout");
    this.closeOAuthWindows();
    this.loggedIn = false;
    this.originLocked = false;
    this.anchorNavigationArmed = false;
    this.work = null;
    this.mode = "login";
    this.account = { username: null, email: null, points: null, level: null, accountId: null, updatedAt: Date.now() };
    this.conversation = { items: [], activeId: null, activeName: null, sessionKey: null, anchorRole: null, anchored: false, hasChat: false, updatedAt: null };
    this.platformModels = { items: [], selected: null, hostSelected: null, loading: false, changing: false, error: null, updatedAt: null, config: null };
    this.pluginLastRuns = [];
    this.effectJudgeContextAvailable = false;
    this.introReady = false;
    this.gameSurfaceReady = false;
    this.detachSurface();
    const webContents = [this.anchor?.webContents, this.surface?.webContents, this.introSurface?.webContents, this.gameSurface?.webContents]
      .filter(item => item && !item.isDestroyed());
    await Promise.allSettled(webContents.map(item => item.loadURL("about:blank")));
    this.loginPageWarmOrigin = null;
    this.loginPageWarmPromise = null;
    const platformSession = this.anchor?.webContents?.session;
    if (platformSession) {
      await platformSession.clearStorageData({
        origin: previousOrigin,
        storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"]
      }).catch(() => {});
      await platformSession.clearAuthCache().catch(() => {});
    }
    if (emit) {
      this.emit({ loggedOut: true });
      void this.prepareLoginPage();
    }
    return this.state();
  }

  async switchOrigin(value) {
    if (this.room) throw new Error("请先退出或关闭当前房间，再切换节点");
    if (this.loginInProgress) throw new Error("登录流程进行中，请稍后再试");
    const origin = normalizeOrigin(value);
    if (!origin) throw new Error("请选择有效的风月域名");
    const item = currentDomainCandidates(this.origin).domains.find(domain => domain.origin === origin || domain.finalOrigin === origin);
    if (!item) throw new Error("所选域名不在当前域名目录中");
    const nextOrigin = item.finalOrigin || item.origin;
    if (nextOrigin === this.origin) return this.state();
    if (this.loggedIn || this.originLocked) await this.logout({ emit: false });
    this.origin = nextOrigin;
    this.domainSelected = true;
    this.authSessionRevision += 1;
    this.originLocked = false;
    this.anchorNavigationArmed = false;
    this.work = null;
    saveSelectedOrigin(this.profileId, this.origin);
    this.mode = "login";
    this.detachSurface();
    this.emit({ originSwitched: true });
    void this.prepareLoginPage();
    return this.state();
  }

  async evaluateLogin() {
    if (!this.domainSelected) return false;
    const anchor = await this.ensureAnchor();
    try {
      return await anchor.webContents.executeJavaScript(`(() => {
        const pathname = location.pathname.toLowerCase();
        if (/\\/signin|\\/login/.test(pathname)) return false;
        const text = document.body?.innerText || "";
        const guest = /\\bGuest\\b/.test(text) || /游客/.test(text);
        const loginButton = [...document.querySelectorAll("button,a")].some(el => /^(登录|注册)$/.test((el.textContent || "").trim()));
        const account = /积分[:：]?\\s*\\d+/.test(text) || /[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/.test(text);
        const authenticatedUi = [...document.querySelectorAll('a,button')].some(el => /退出登录|登出|个人中心|我的账户/.test((el.textContent || '').trim()));
        const chatUi = pathname.includes('/chats') && Boolean(document.querySelector('textarea,[contenteditable="true"],.chat-container'));
        return !guest && !loginButton && (account || authenticatedUi || chatUi);
      })()`, true);
    } catch { return false; }
  }

  clearAuthenticationFailures(source = "authenticated") {
    if (this.authFailureStreak) {
      this.appendSessionLog("login-state", {
        event: "authentication-recovered",
        source,
        previousStreak: this.authFailureStreak,
        elapsedMs: this.authFailureSince ? Date.now() - this.authFailureSince : 0
      });
    }
    this.authFailureStreak = 0;
    this.authFailureSince = 0;
    this.authFailureLastAt = 0;
  }

  confirmAuthenticationFailure(source, reason = "unauthenticated") {
    const now = Date.now();
    if (!this.authFailureSince) this.authFailureSince = now;
    if (!this.authFailureLastAt || now - this.authFailureLastAt >= 2500) {
      this.authFailureStreak += 1;
      this.authFailureLastAt = now;
    }
    const elapsedMs = now - this.authFailureSince;
    const confirmed = this.authFailureStreak >= 3 && elapsedMs >= 9000;
    this.appendSessionLog("login-state", {
      event: confirmed ? "authentication-loss-confirmed" : "authentication-loss-deferred",
      source,
      reason,
      streak: this.authFailureStreak,
      elapsedMs
    });
    return confirmed;
  }

  async readAccountSnapshot({ includeDetails = true, webContents = null, allowSubresourceLoading = false } = {}) {
    if (!this.domainSelected) return null;
    const target = webContents || (await this.ensureAnchor()).webContents;
    if (!target || target.isDestroyed() || (!allowSubresourceLoading && target.isLoading())) return null;
    try {
      const executor = allowSubresourceLoading ? target.mainFrame : target;
      return await executor.executeJavaScript(`(async () => {
        const includeDetails = ${JSON.stringify(Boolean(includeDetails))};
        const token = localStorage.getItem('console_token') || '';
        // Current Aiero nodes authenticate the web page with an HttpOnly
        // cookie and remove the legacy localStorage console_token after login.
        // Keep the old bearer token as an optional compatibility header, but
        // never require it before probing the cookie session.
        // Legacy builds returned authenticated:null, reason:'missing-token'
        // here; that result is intentionally no longer used as a gate.
        const headers = { 'X-Language': 'zh-Hans', Accept: 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const unwrap = value => value && value.code === 100000 ? value.data : (value?.data ?? value);
        const request = url => fetch(url, { credentials:'include', cache:'no-store', headers, signal:AbortSignal.timeout(5000) });
        const profileResponse = await request('/go/api/account/profile');
        if (profileResponse.status === 401 || profileResponse.status === 403) return { authenticated:false, reason:'profile-rejected' };
        if (!profileResponse.ok) return null;
        const profilePayload = await profileResponse.json().catch(() => null);
        if (!profilePayload || typeof profilePayload !== 'object') return null;
        if (profilePayload.code != null && ![0,100000].includes(Number(profilePayload.code))) return null;
        const profile = unwrap(profilePayload) || {};
        const accountId = profile.id ?? profile.account_id ?? profile.accountId ?? null;
        const accountIdText = accountId == null ? '' : String(accountId).trim();
        const trialAccount = profile.is_trial_account === true || profile.isTrialAccount === true;
        let point = {};
        let personalProfile = {};
        if (includeDetails && accountIdText) {
          const readOptional = async url => {
            try {
              const response = await request(url);
              return response.ok ? (unwrap(await response.json()) || {}) : {};
            } catch { return {}; }
          };
          [point, personalProfile] = await Promise.all([
            readOptional('/go/api/account/point?target=' + encodeURIComponent(accountId)),
            readOptional('/console/api/account/' + encodeURIComponent(accountId) + '/personal-profile')
          ]);
        }
        const username = profile.username ?? profile.user_name ?? profile.account_name ?? profile.name ?? profile.nickname ?? profile.email ?? null;
        const email = profile.email ?? profile.mail ?? profile.account_email ?? profile.accountEmail ?? (/^[^@\\s]+@[^@\\s]+$/.test(String(username || "")) ? username : null);
        const guestName = /^(guest|游客)$/i.test(String(username || '').trim());
        // The unauthenticated profile endpoint can return a Guest/trial
        // profile with HTTP 200. Treat it as logged out rather than as a real
        // account session.
        if (trialAccount || guestName || !accountIdText) {
          return { authenticated:false, reason: trialAccount || guestName ? 'guest-account' : 'missing-account-id' };
        }
        const rawPoints = point.points ?? point.point ?? point.balance ?? profile.points ?? null;
        const personal = personalProfile?.personal_profile ?? personalProfile?.profile ?? personalProfile;
        const rawLevel = personal?.level_info?.current_level ?? personal?.current_level ?? profile?.level_info?.current_level ?? profile?.current_level ?? profile?.level ?? null;
        return {
          authenticated:true,
          accountId: accountIdText,
          username: username == null ? null : String(username),
          email: email == null ? null : String(email).trim().toLocaleLowerCase(),
          points: rawPoints == null ? null : String(rawPoints),
          level: rawLevel == null || !Number.isFinite(Number(rawLevel)) ? null : Number(rawLevel)
        };
      })()`, true);
    } catch { return null; }
  }

  async refreshAccount(force = false) {
    if (!this.domainSelected || this.loginInProgress || this.loginDetectionPaused) return;
    if (this.accountRefreshPromise) return this.accountRefreshPromise;
    const authSessionRevision = this.authSessionRevision;
    this.accountRefreshPromise = (async () => {
      const snapshot = await this.readAccountSnapshot();
      if (!snapshot || authSessionRevision !== this.authSessionRevision || this.loginInProgress || this.loginDetectionPaused) return;
      const previous = accountSignature(this.account);
      const previousLoggedIn = this.loggedIn;
      if (snapshot.authenticated == null) return;
      if (!snapshot.authenticated) {
        if (this.loggedIn && !this.loginInProgress) {
          if (!this.confirmAuthenticationFailure("account-refresh", snapshot.reason)) return;
          if (this.work || this.room || this.onlineWorldService?.work) {
            this.appendSessionLog("login-state", {
              event: "authentication-loss-held-during-active-session",
              source: "account-refresh",
              work: Boolean(this.work),
              room: Boolean(this.room)
            });
            return;
          }
          this.loggedIn = false;
          this.mode = "login";
          this.detachSurface();
        } else if (this.loggedIn) {
          return;
        }
        const nextAccount = { username: null, email: null, points: null, level: null, accountId: null };
        const changed = previous !== accountSignature(nextAccount);
        this.account = { ...nextAccount, updatedAt: changed ? Date.now() : this.account.updatedAt };
      } else {
        if (!await this.allowDetectedAuthenticatedSession()) return;
        if (authSessionRevision !== this.authSessionRevision || this.loginInProgress || this.loginDetectionPaused) return;
        this.clearAuthenticationFailures("account-refresh");
        this.loggedIn = true;
        this.originLocked = true;
        const nextAccount = {
          username: snapshot.username,
          email: snapshot.email,
          points: snapshot.points,
          level: snapshot.level,
          accountId: snapshot.accountId
        };
        const changed = previous !== accountSignature(nextAccount);
        this.account = { ...nextAccount, updatedAt: changed ? Date.now() : this.account.updatedAt };
        if (this.room?.role === "host" && snapshot.username) this.room.hostUsername = snapshot.username;
        if (["login", "logged-out", "oauth-login"].includes(this.mode) && !this.loginInProgress) {
          this.mode = "lobby";
          this.detachSurface();
        }
      }
      if (force || previousLoggedIn !== this.loggedIn || previous !== accountSignature(this.account)) this.emit();
    })().finally(() => { this.accountRefreshPromise = null; });
    return this.accountRefreshPromise;
  }

  async refreshLoginState(force = false) {
    if (!this.domainSelected || this.loginInProgress || this.loginDetectionPaused || this.accountRefreshPromise) return;
    const authSessionRevision = this.authSessionRevision;
    const anchor = await this.ensureAnchor();
    if (anchor.webContents.isLoading()) return;
    const snapshot = await this.readAccountSnapshot({ includeDetails: false });
    if (authSessionRevision !== this.authSessionRevision || this.loginInProgress || this.loginDetectionPaused) return;
    if (!snapshot) return;
    if (snapshot.authenticated == null) return;
    let next = this.loggedIn;
    if (snapshot.authenticated) {
      if (!await this.allowDetectedAuthenticatedSession()) return;
      if (authSessionRevision !== this.authSessionRevision || this.loginInProgress || this.loginDetectionPaused) return;
      this.clearAuthenticationFailures("status-refresh");
      next = true;
    } else if (!this.loggedIn) {
      next = false;
    } else if (!this.loginInProgress && this.confirmAuthenticationFailure("status-refresh", snapshot.reason)) {
      if (this.work || this.room || this.onlineWorldService?.work) {
        this.appendSessionLog("login-state", {
          event: "authentication-loss-held-during-active-session",
          source: "status-refresh",
          work: Boolean(this.work),
          room: Boolean(this.room)
        });
        return;
      }
      next = false;
    }
    const previousAccount = accountSignature(this.account);
    if (snapshot?.authenticated) {
      const nextAccount = {
        username: snapshot.username,
        email: snapshot.email,
        points: snapshot.points ?? this.account.points,
        level: snapshot.level ?? this.account.level,
        accountId: snapshot.accountId
      };
      const changed = previousAccount !== accountSignature(nextAccount);
      this.account = { ...nextAccount, updatedAt: changed ? Date.now() : this.account.updatedAt };
      if (this.room?.role === "host" && snapshot.username) this.room.hostUsername = snapshot.username;
    } else if (!next && !snapshot.authenticated) {
      const nextAccount = { username: null, email: null, points: null, level: null, accountId: null };
      const changed = previousAccount !== accountSignature(nextAccount);
      this.account = { ...nextAccount, updatedAt: changed ? Date.now() : this.account.updatedAt };
    }
    if (!force && next === this.loggedIn) {
      if (previousAccount !== accountSignature(this.account)) this.emit();
      return;
    }
    const previous = this.loggedIn;
    this.loggedIn = next;
    if (next) this.originLocked = true;
    if (next && ["login", "logged-out"].includes(this.mode)) {
      this.mode = "lobby";
      this.detachSurface();
    } else if (!next && previous && !this.loginInProgress) {
      this.mode = "login";
      this.detachSurface();
    }
    this.emit();
  }

  async showLogin() {
    this.mode = "login";
    this.detachSurface();
    this.emit();
  }

  async login({ account, password, remember, autoLogin = false }) {
    return this.loginWithFailover({ account, password, remember, autoLogin, preferSelected: true });
  }

  async loginAtOrigin({ account, password, remember, autoLogin }, signal) {
    const startedAt = Date.now();
    this.authSessionRevision += 1;
    this.clearAuthenticationFailures("login-started");
    this.anchorNavigationArmed = false;
    this.loginPageWarmController?.abort();
    const anchor = await waitForLoginTask(this.ensureAnchor(), signal);
    assertLoginActive(signal);
    const origin = this.origin;
    const cancelPage = () => this.stopLoginPage(anchor);
    signal.addEventListener("abort", cancelPage, { once: true });
    this.mode = "login";
    this.emit();
    this.appendSessionLog("login", { event: "started", origin: this.origin });
    try {
      let reuseLoginPage = false;
      try {
        const current = new URL(anchor.webContents.getURL());
        reuseLoginPage = current.origin === origin && /\/(?:zh\/)?signin\/?$/i.test(current.pathname)
          && (!anchor.webContents.isLoadingMainFrame() || (this.loginPageWarmOrigin === origin && this.loginPageWarmReady));
      } catch {}
      if (!reuseLoginPage) await this.loadLoginPage(anchor, origin, signal);
      assertLoginActive(signal);
      this.appendSessionLog("login", { event: "page-ready", elapsedMs: Date.now() - startedAt, reused: reuseLoginPage });
      const fillLoginForm = () => anchor.webContents.mainFrame.executeJavaScript(`(async () => {
        if (location.origin !== ${JSON.stringify(origin)}) return { ok:false, message:"登录页节点发生变化" };
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const roots = () => {
          const found = [document];
          for (let index = 0; index < found.length && index < 100; index += 1) {
            const root = found[index];
            for (const element of root.querySelectorAll?.('*') || []) if (element.shadowRoot) found.push(element.shadowRoot);
            for (const frame of root.querySelectorAll?.('iframe') || []) {
              try { if (frame.contentDocument) found.push(frame.contentDocument); } catch {}
            }
          }
          return found;
        };
        const visible = element => {
          const style = element.ownerDocument.defaultView.getComputedStyle(element);
          return !element.disabled && !element.readOnly && element.type !== 'hidden'
            && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const first = (selector, scopes = roots()) => scopes.flatMap(root => [...(root.querySelectorAll?.(selector) || [])]).find(visible) || null;
        const hydrated = element => {
          const nextPage = element.ownerDocument.querySelector('script[src*="/_next/"],script#__NEXT_DATA__');
          return !nextPage || Object.keys(element).some(key => key.startsWith('__reactProps$') || key.startsWith('__reactFiber$'));
        };
        let accountElement = null;
        let password = null;
        while (!accountElement || !password) {
          password = first('#password,input[name="password"],input[autocomplete="current-password"],input[type="password"],input[placeholder*="密码"]');
          const scopes = password?.closest('form') ? [password.closest('form')] : roots();
          accountElement = first('#email,input[name="email"],input[name="username"],input[autocomplete="email"],input[autocomplete="username"],input[type="email"],input[placeholder*="邮箱"],input[placeholder*="用户名"],input[placeholder*="账号"],input[placeholder*="email" i],input[placeholder*="user" i]', scopes)
            || (password?.closest('form') ? first('input[type="text"],input:not([type]),input[type="tel"]', scopes) : null);
          if (accountElement && password && (!hydrated(accountElement) || !hydrated(password))) {
            accountElement = null;
            password = null;
          }
          if (!accountElement || !password) await sleep(150);
        }
        const setValue = (element,value) => {
          const Input = element?.ownerDocument?.defaultView?.HTMLInputElement || HTMLInputElement;
          const descriptor = Object.getOwnPropertyDescriptor(Input.prototype,"value");
          descriptor?.set?.call(element,value);
          element.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value}));
          element.dispatchEvent(new Event("change",{bubbles:true}));
        };
        setValue(accountElement, ${JSON.stringify(account)});
        setValue(password, ${JSON.stringify(password)});
        await sleep(150);
        if (!accountElement.isConnected || !password.isConnected || accountElement.value !== ${JSON.stringify(account)} || password.value !== ${JSON.stringify(password)}) {
          return { ok:false, message:"登录表单仍在初始化" };
        }
        const form = password.closest('form') || accountElement.closest('form');
        if (accountElement.validity?.typeMismatch && /用户名|账号|username/i.test(accountElement.placeholder || '')) accountElement.type = 'text';
        const submit = (form ? [...form.querySelectorAll('button[type="submit"],input[type="submit"]')].find(button => button.getClientRects().length > 0) : null)
          || roots().flatMap(root => [...(root.querySelectorAll?.('button') || [])]).find(button => button.getClientRects().length > 0 && /^(登录|立即登录|登錄|Sign in|Log in)$/i.test((button.textContent || '').trim()));
        if (!submit) return { ok:false, message:"找不到平台登录按钮" };
        for (let attempt = 0; attempt < 20 && (submit.disabled || submit.getAttribute('aria-disabled') === 'true'); attempt += 1) await sleep(50);
        if (submit.disabled || submit.getAttribute('aria-disabled') === 'true') return { ok:false, message:"登录按钮暂不可用，请检查输入内容" };
        submit.click();
        return { ok:true };
      })()`, true);
      let result;
      do {
        result = await waitForLoginTask(fillLoginForm(), signal);
        if (result?.message === "登录表单仍在初始化") await pauseLogin(150, signal);
      } while (result?.message === "登录表单仍在初始化");
      assertLoginActive(signal);
      if (!result?.ok) {
        this.appendSessionLog("login", { event: "form-not-found", elapsedMs: Date.now() - startedAt, origin: this.origin, diagnostic: result?.diagnostic || null });
        throw new Error(result?.message || "登录提交失败");
      }
      this.appendSessionLog("login", { event: "submitted", elapsedMs: Date.now() - startedAt });
      this.loginProgress = { ...this.loginProgress, phase: "verifying", origin };
      this.emit();
      let authenticatedSnapshot = null;
      while (!authenticatedSnapshot) {
        assertLoginActive(signal);
        const pageStatus = await waitForLoginTask(anchor.webContents.mainFrame.executeJavaScript(`(() => {
          const token = localStorage.getItem('console_token') || '';
          const visible = element => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
          };
          const errors = [...document.querySelectorAll('[role="alert"],.MuiAlert-message,[class*="error" i],[class*="invalid" i]')]
            .filter(visible)
            .map(element => (element.textContent || '').replace(/\\s+/g, ' ').trim())
            .filter(text => text && text.length <= 240 && /错误|失败|无效|不存在|密码|频繁|验证|error|invalid|failed/i.test(text));
          return { hasToken:Boolean(token), error:errors[0] || null };
        })()`, true).catch(() => ({ hasToken: false, error: null })), signal);
        if (pageStatus?.error && !pageStatus?.hasToken) throw platformLoginError(pageStatus.error);
        const snapshot = await waitForLoginTask(this.readAccountSnapshot({ includeDetails: false, webContents: anchor.webContents, allowSubresourceLoading: true }), signal);
        assertLoginActive(signal);
        if (snapshot?.authenticated) {
          authenticatedSnapshot = snapshot;
          break;
        }
        await pauseLogin(250, signal);
      }
      assertLoginActive(signal);
      this.loggedIn = true;
      this.loginDetectionPaused = false;
      this.anchorNavigationArmed = true;
      this.clearAuthenticationFailures("login-succeeded");
      this.originLocked = true;
      this.mode = "lobby";
      this.account = {
        username: authenticatedSnapshot.username,
        email: authenticatedSnapshot.email,
        points: this.account.points,
        level: this.account.level,
        accountId: authenticatedSnapshot.accountId,
        updatedAt: Date.now()
      };
      saveSelectedOrigin(this.profileId, this.origin);
      if (remember) saveCredentials(this.profileId, { account, password, autoLogin });
      else clearCredentials(this.profileId);
      this.appendSessionLog("login", { event: "authenticated", elapsedMs: Date.now() - startedAt, origin: this.origin });
      this.emit({ loginSucceeded: true });
      const completeAccountRefresh = () => void this.refreshAccount(true).catch(() => {});
      if (!anchor.webContents.getURL().includes("/zh/chats")) {
        void anchor.loadURL(platformUrlForOrigin(this.origin, "/zh/chats").href).then(completeAccountRefresh).catch(completeAccountRefresh);
      } else {
        completeAccountRefresh();
      }
      return true;
    } catch (error) {
      this.appendSessionLog("login", { event: "failed", elapsedMs: Date.now() - startedAt, origin: this.origin, error: error?.message || String(error) });
      throw error;
    } finally {
      signal.removeEventListener("abort", cancelPage);
      if (!this.loggedIn) this.stopLoginPage(anchor);
    }
  }

  async loginWithFailover({ account, password, remember = true, autoLogin = true, preferSelected = false }) {
    if (this.loggedIn) return true;
    if (this.loginController || this.loginInProgress) throw new Error("登录流程已经在进行中");
    account = String(account || "").trim();
    password = String(password || "");
    if (!account || !password) throw new Error("请输入账号和密码");
    if (account.length > 320 || password.length > 1024) throw new Error("账号或密码长度超过安全上限");
    const controller = new AbortController();
    this.loginController = controller;
    this.loginInProgress = true;
    this.loginDetectionPaused = true;
    this.authSessionRevision += 1;
    this.loginProgress = { phase: "preparing" };
    this.emit();
    const preferredOrigin = preferSelected && this.domainSelected ? this.origin : "";
    void discoverDomainStatuses(false).catch(() => {});
    try {
      await waitForLoginTask(this.verifyOfficialRelease(), controller.signal);
      return await runLoginFailover({
        signal: controller.signal,
        getCandidates: async round => {
          const directory = round ? await discoverDomainStatuses(true) : currentDomainCandidates(this.origin);
          return orderLoginCandidates(directory?.domains, { includeUnmeasured: true, preferredOrigin: round ? "" : preferredOrigin })
            .filter(candidate => TRUSTED_PLATFORM_ORIGINS.has(candidate.origin));
        },
        refreshCandidates: () => orderLoginCandidates(currentDomainCandidates(this.origin)?.domains, { includeUnmeasured: true })
          .filter(candidate => TRUSTED_PLATFORM_ORIGINS.has(candidate.origin)),
        attempt: async (candidate, signal) => {
          assertLoginActive(signal);
          this.origin = candidate.origin;
          this.domainSelected = true;
          this.emit();
          return this.loginAtOrigin({ account, password, remember: Boolean(remember || autoLogin), autoLogin }, signal);
        },
        onProgress: progress => {
          this.loginProgress = { phase: progress.phase, origin: progress.origin || "", attempt: progress.attempt, round: progress.round };
          this.appendSessionLog("login", { event: progress.phase, ...progress });
          this.emit();
        }
      });
    } catch (error) {
      if (controller.signal.aborted) return { cancelled: true };
      throw error;
    } finally {
      if (this.loginController === controller) {
        this.loginController = null;
        this.loginInProgress = false;
        this.loginProgress = null;
        this.emit();
        if (this.loggedIn) void this.refreshAccount(true).catch(() => {});
      }
    }
  }

  closeOAuthWindows() {
    if (this.oauthPollTimer) clearInterval(this.oauthPollTimer);
    this.oauthPollTimer = null;
    for (const child of this.oauthChildren) if (!child.isDestroyed()) child.destroy();
    this.oauthChildren.clear();
    if (this.oauthWindow && !this.oauthWindow.isDestroyed()) this.oauthWindow.destroy();
    this.oauthWindow = null;
  }

  async oauthLogin(provider) {
    if (this.loginController) throw new Error("请先取消当前登录");
    this.loginDetectionPaused = false;
    provider = String(provider || "").toLowerCase();
    if (!new Set(["google", "telegram"]).has(provider)) throw new Error("不支持的第三方登录方式");
    if (!this.domainSelected) throw new Error("请先从域名列表选择一个可用节点");
    await this.verifyOfficialRelease();
    this.authSessionRevision += 1;
    this.anchorNavigationArmed = true;
    if (this.oauthWindow && !this.oauthWindow.isDestroyed()) {
      this.oauthWindow.show();
      this.oauthWindow.focus();
      return true;
    }

    this.mode = "oauth-login";
    this.loginInProgress = true;
    this.emit({ oauthProvider: provider });
    const oauth = new BrowserWindow({
      width: 520,
      height: 720,
      minWidth: 420,
      minHeight: 560,
      show: false,
      parent: this.window,
      title: provider === "google" ? "Google 登录" : "Telegram 登录",
      autoHideMenuBar: true,
      backgroundColor: "#ffffff",
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    this.oauthWindow = oauth;
    this.emit();
    oauth.setMenuBarVisibility(false);
    const chromeUserAgent = oauth.webContents.getUserAgent().replace(/\sElectron\/[^\s]+/i, "");
    oauth.webContents.setUserAgent(chromeUserAgent);
    oauth.webContents.setWindowOpenHandler(() => ({
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 520,
        height: 720,
        parent: this.window,
        autoHideMenuBar: true,
        webPreferences: {
          partition: this.partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false
        }
      }
    }));
    oauth.webContents.on("did-create-window", child => {
      this.oauthChildren.add(child);
      child.setMenuBarVisibility(false);
      oauth.hide();
      child.on("closed", () => {
        this.oauthChildren.delete(child);
        if (!this.loggedIn && oauth && !oauth.isDestroyed()) oauth.show();
      });
    });
    oauth.on("closed", () => {
      if (this.oauthWindow === oauth) this.oauthWindow = null;
      if (!this.loggedIn && !this.destroying) {
        this.loginInProgress = false;
        this.mode = "login";
        this.emit();
      }
    });

    const cancelled = () => this.oauthWindow !== oauth || oauth.isDestroyed() || this.loginDetectionPaused;
    try {
      await oauth.loadURL(platformUrlForOrigin(this.origin, "/zh/signin").href);
    } catch (error) {
      if (cancelled()) return { cancelled: true };
      throw error;
    }
    if (cancelled()) return { cancelled: true };
    if (!this.loggedIn) {
      await oauth.webContents.executeJavaScript(`localStorage.removeItem('console_token')`, true).catch(() => {});
    }
    const pattern = provider === "google" ? "Google" : "Telegram|电报|TG";
    const iconMarker = provider === "google" ? "googleIcon" : "telegramIcon";
    let clicked = false;
    for (let attempt = 0; attempt < 80 && !clicked; attempt += 1) {
      if (cancelled()) return { cancelled: true };
      clicked = await oauth.webContents.executeJavaScript(`(() => {
        const pattern = new RegExp(${JSON.stringify(pattern)}, 'i');
        const iconMarker = ${JSON.stringify(iconMarker)};
        const button = [...document.querySelectorAll('button,[role="button"]')].find(element => {
          const label = (element.textContent || element.getAttribute('aria-label') || '').trim();
          return pattern.test(label) || Boolean(element.querySelector('[class*="' + iconMarker + '"]'));
        });
        if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
        button.click();
        return true;
      })()`, true).catch(() => false);
      if (!clicked) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (cancelled()) return { cancelled: true };
    if (!clicked) {
      this.closeOAuthWindows();
      this.loginInProgress = false;
      this.mode = "login";
      this.emit();
      throw new Error(`平台暂未提供可用的 ${provider === "google" ? "Google" : "Telegram"} 登录按钮`);
    }

    if (!oauth.isDestroyed()) oauth.show();
    this.oauthPollTimer = setInterval(async () => {
      if (this.oauthPollBusy) return;
      this.oauthPollBusy = true;
      try {
        const snapshot = await this.readAccountSnapshot({ includeDetails: false, webContents: oauth.webContents });
        if (!snapshot?.authenticated || this.oauthWindow !== oauth || this.loginDetectionPaused) return;
        this.loggedIn = true;
        this.clearAuthenticationFailures("oauth-succeeded");
        this.originLocked = true;
        this.account = { username: snapshot.username, email: snapshot.email, points: this.account.points, level: this.account.level, accountId: snapshot.accountId, updatedAt: Date.now() };
        this.loginInProgress = false;
        this.mode = "lobby";
        this.closeOAuthWindows();
        const anchor = await this.ensureAnchor();
        if (!anchor.webContents.getURL().includes("/zh/chats")) await anchor.loadURL(platformUrlForOrigin(this.origin, "/zh/chats").href);
        saveSelectedOrigin(this.profileId, this.origin);
        void this.refreshAccount(true).catch(() => {});
        this.emit({ loginSucceeded: true, oauthProvider: provider });
      } finally {
        this.oauthPollBusy = false;
      }
    }, 1000);
    return true;
  }

  assertMultiplayerLevel() {
    const level = Number(this.account.level);
    if (this.account.level == null || !Number.isFinite(level)) throw new Error("正在获取账号等级，请稍后再使用联机功能");
    if (level < 2) throw new Error(`当前账号为 ${level} 级；联机功能需要账号达到 2 级`);
  }

  async createRoom({ password, displayName, basicInfo, appearance, info }) {
    if (this.conversationBusy) throw new Error("请等待会话操作完成后再创建房间");
    password = String(password || "");
    const selectedProfile = this.selectedCharacterProfile();
    displayName = String(displayName || selectedProfile?.displayName || "").trim() || this.account.username || this.profileId;
    basicInfo = String(basicInfo ?? selectedProfile?.basicInfo ?? info ?? "").trim();
    appearance = String(appearance ?? selectedProfile?.appearance ?? "").trim();
    info = composeCharacterInfo(basicInfo, appearance);
    if (!this.loggedIn) throw new Error("请先登录账号");
    this.assertMultiplayerLevel();
    if (!this.account.username || !this.account.accountId) throw new Error("正在获取平台用户名，请等待账号信息刷新后重试");
    if (!this.work) throw new Error("创建房间前必须先选择作品");
    if (password.length < 8) throw new Error("房间密码至少需要 8 个字符");
    if (password.length > 128) throw new Error("房间密码不能超过 128 个字符");
    if (displayName.length > 80 || basicInfo.length > 20000 || appearance.length > 10000) throw new Error("角色设定内容超过安全上限");
    if (this.room) throw new Error("当前已有房间，请先退出当前房间");
    if (!this.conversation.activeName) throw new Error("请先从会话列表选择会话，或点击“新建会话”建立新会话");
    if (!this.platformModels.items.length) await this.refreshPlatformModels({ ensureValid: true });
    const saveKey = this.conversation.sessionKey || this.hostSessionKey(this.conversation.activeId) || crypto.randomUUID();
    this.conversation.sessionKey = saveKey;
    this.conversation.anchorRole = "host";
    this.conversation.anchored = true;
    this.persistSaveAnchor({
      sessionKey: saveKey,
      conversationId: this.conversation.activeId,
      name: this.conversation.activeName,
      role: "host"
    });
    const roomId = crypto.randomBytes(4).toString("hex").toUpperCase();
    const invite = await this.createSimpleInviteWork(roomId);
    const verifier = derivePasswordVerifier(this.account.accountId, password);
    const hostProfile = {
      id: this.account.accountId || this.profileId,
      platformName: this.account.username || this.profileId,
      displayName,
      basicInfo,
      appearance,
      info
    };
    this.room = {
      id: roomId,
      role: "host",
      status: "waiting",
      appVersion: this.appVersion,
      peerVersion: null,
      hostUsername: this.account.username || "正在获取平台用户名",
      work: { title: this.work.title, suffix: this.work.suffix },
      inviteAppId: invite.appId,
      inviteUrl: invite.suffix,
      save: {
        key: saveKey,
        conversationId: this.conversation.activeId,
        name: this.conversation.activeName || "新会话"
      },
      historySync: { status: "ready", current: 0, total: 0, error: null },
      memberHistory: {},
      createdAt: Date.now(),
      memberCount: 1,
      rosterRevision: 1,
      removedMemberIds: new Set(),
      passwordVerifier: verifier,
      passwordVerifierV2: derivePasswordVerifierV2(this.account.accountId, password),
      members: [hostProfile],
      memberChatIds: {},
      model: this.modelPublicValue(this.platformModels.selected),
      plugins: this.publicPluginSettings(),
      promptSync: { status: "pending", updatedAt: null, memberCount: 0, error: null },
      chat: { revision: 0, messages: [], pending: null, pendingBroadcasts: [], syncStatus: "ready", error: null, lastBroadcastAt: 0, broadcastAttempts: 0, lastRecoveryRequestAt: 0, recoveryRequestAttempts: 0 },
      messageOperation: null,
      round: this.newRound(1)
    };
    this.roomPollNotBefore = 0;
    this.roomPollIdleCount = 0;
    this.mode = "lobby";
    this.detachSurface();
    this.emit({ roomCreated: true });
    return this.state().room;
  }

  async createSimpleInviteWork(roomId) {
    const generatedName = crypto.randomBytes(6).toString("base64url").slice(0, 8);
    const payload = await this.platformChatApi("/apps", {
      method: "POST",
      body: {
        name: generatedName,
        description: "",
        icon: "",
        icon_background: "",
        mode: "chat",
        type: 2
      }
    });
    const data = payload?.data ?? payload;
    const created = data?.app ?? data?.apps ?? data;
    const appId = String(created?.id ?? created?.app_id ?? data?.id ?? data?.app_id ?? "").trim();
    if (!appId) throw new Error("房间链接生成失败：平台没有返回作品编号");
    const suffix = `/zh/explore/installed/${encodeURIComponent(appId)}`;

    // 平台的“预览”按钮只打开上述 installed 路由。这里读取一次详情，确保
    // 私人作品已经可以通过链接访问，同时保持整个风月页面处于后台。
    let verified = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const detail = await this.platformChatApi(`/installed-apps/${encodeURIComponent(appId)}`);
        const appDetail = detail?.data?.app ?? detail?.app ?? detail?.data?.apps ?? detail?.apps;
        if (String(appDetail?.id || appId) === appId) {
          verified = true;
          break;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (!verified) throw new Error(`私人邀请作品已创建（房间 ${roomId}），但预览链接暂时无法读取，请稍后重试创建房间`);
    return { appId, suffix };
  }

  async platformRequest(pathname, options = {}) {
    await this.networkReady;
    const origin = this.origin;
    const revision = this.authSessionRevision;
    const retryAt = this.platformRateLimits?.get(origin) || 0;
    if (retryAt > Date.now()) {
      throw platformRequestError("PLATFORM_RATE_LIMIT", "平台请求频繁，正在等待恢复", { status: 429, retryAfterMs: retryAt - Date.now() });
    }
    let token = "";
    let tokenTimer;
    try {
      const contents = this.anchor?.webContents;
      if (contents && !contents.isDestroyed() && new URL(contents.getURL()).origin === origin) {
        token = await Promise.race([
          contents.mainFrame.executeJavaScript("localStorage.getItem('console_token') || ''").catch(() => ""),
          new Promise(resolve => { tokenTimer = setTimeout(() => resolve(""), 500); })
        ]);
      }
    } catch {} finally { clearTimeout(tokenTimer); }
    if (origin !== this.origin || revision !== this.authSessionRevision) throw platformRequestError("PLATFORM_CANCELLED", "账号会话已切换");
    const startedAt = Date.now();
    try {
      const result = await requestPlatformJson({
        ...options, origin, pathname, token: typeof token === "string" ? token : "",
        fetch: (url, request) => this.platformSession.fetch(url, request),
        onRetry: detail => this.appendSessionLog("platform-network", { event: "read-retry", origin, path: pathname.split("?")[0], ...detail })
      });
      if (origin !== this.origin || revision !== this.authSessionRevision) throw platformRequestError("PLATFORM_CANCELLED", "账号会话已切换");
      this.lastPlatformSuccessAt = Date.now();
      return result;
    } catch (error) {
      if (error?.status === 429) {
        this.platformRateLimits ||= new Map();
        this.platformRateLimits.set(origin, Date.now() + error.retryAfterMs);
      }
      this.appendSessionLog("platform-network", {
        event: "request-failed", origin, path: pathname.split("?")[0], method: options.method || "GET",
        code: error?.code || null, status: error?.status || null, elapsedMs: Date.now() - startedAt,
        error: error?.message || String(error)
      });
      throw error;
    }
  }

  async platformChatApi(pathname, options = {}) {
    return (await this.platformRequest(`/console/api${pathname}`, options)).payload;
  }

  async platformServerTime() {
    const { serverTime } = await this.platformRequest("/go/api/account/profile", { timeout: 5000, attempts: 1 });
    if (!Number.isFinite(serverTime)) throw platformRequestError("PLATFORM_TIME", "平台响应缺少服务器时间");
    return serverTime;
  }

  async platformGoApi(pathname, options = {}) {
    return (await this.platformRequest(`/go/api${pathname}`, options)).payload;
  }

  async listOnlineWorldCards() {
    const entries = [...this.onlineWorldCards.entries()];
    const accountId = String(this.account.accountId || "");
    const cards = entries.map(([libraryId, card]) => ({
      ...summarizeGameCard(card, libraryId),
      isCurrentUserAuthor: Boolean(accountId && card?.companion?.authorAccountId === accountId),
      installedFromFolder: Boolean(this.onlineWorldCardSources?.has(libraryId))
    }));
    return {
      cards,
      activeCardId: this.onlineWorldService?.card?.cardId || null,
      activeLibraryId: this.onlineWorldService?.card ? gameCardLibraryKey(this.onlineWorldService.card) : null
    };
  }

  onlineWorldCard(cardId, workId = null) {
    const requested = String(cardId || "");
    const composite = requested && workId ? `${requested}::${String(workId)}` : requested;
    let card = this.onlineWorldCards.get(composite);
    if (!card && requested) {
      // Accept the old cardId-only IPC payload while it is unambiguous.
      const matches = [...this.onlineWorldCards.values()].filter(item => item.cardId === requested);
      if (matches.length === 1) card = matches[0];
    }
    if (!card && !requested) card = this.onlineWorldCards.values().next().value;
    if (!card) throw new Error("这张游戏卡尚未导入");
    return card;
  }

  async openOnlineWorldCard(options = {}) {
    const card = this.onlineWorldCard(options.libraryId || options.cardId, options.libraryId ? null : options.workId);
    let state;
    try {
      state = await this.onlineWorldService.open({
        card,
        displayName: options.displayName,
        orientation: options.orientation
      });
    } finally {
      const refreshedCard = this.onlineWorldService.card;
      const matchesOpenedCard = refreshedCard?.cardId === card.cardId
        && refreshedCard?.gameId === card.gameId
        && refreshedCard?.companion?.workId === card.companion.workId
        && refreshedCard?.companion?.authorAccountId === card.companion.authorAccountId;
      if (matchesOpenedCard) this.persistRefreshedOnlineWorldCard(card, refreshedCard);
    }
    const activeCard = this.onlineWorldService.card || card;
    if (this.onlineWorldService.migrationDraft && this.onlineWorldService.isAuthority()
      && this.account.accountId === this.onlineWorldService.work?.authorAccountId) {
      this.scheduleOnlineWorldMigrationResume(activeCard);
    }
    return state;
  }

  persistRefreshedOnlineWorldCard(previousCard, nextCard) {
    const previous = validateGameCard(previousCard);
    const refreshed = validateGameCard(nextCard);
    const sameCard = previous.cardId === refreshed.cardId
      && previous.gameId === refreshed.gameId
      && previous.companion.authorAccountId === refreshed.companion.authorAccountId
      && previous.companion.origin === refreshed.companion.origin;
    if (!sameCard || Number(refreshed.version || 0) < Number(previous.version || 0)) {
      throw new Error("伴生作品返回的游戏卡身份与当前游戏卡不一致");
    }
    if (previous.packageSha256 === refreshed.packageSha256) return false;
    const previousKey = gameCardLibraryKey(previous);
    const nextKey = gameCardLibraryKey(refreshed);
    const sources = new Set(this.onlineWorldCardSources?.get(previousKey) || []);
    Map.prototype.delete.call(this.onlineWorldCards, previousKey);
    this.onlineWorldCards.set(nextKey, refreshed);
    saveGameCardLibrary(this.onlineWorldCardFile, this.onlineWorldCards);
    for (const file of sources) {
      try {
        atomicWriteFileSync(fs, file, `${JSON.stringify(refreshed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        this.appendSessionLog("online-world", {
          event: "game-card-source-refresh-failed",
          status: "degraded",
          file,
          error: error?.message || String(error)
        });
      }
    }
    if (previousKey !== nextKey) this.onlineWorldCardSources?.delete(previousKey);
    if (sources.size) this.onlineWorldCardSources?.set(nextKey, sources);
    const persisted = loadGameCardLibrary(this.onlineWorldCardFile, null);
    if (persisted.get(nextKey)?.packageSha256 !== refreshed.packageSha256) throw new Error("最新游戏卡程序保存后回读失败");
    this.onlineWorldCards = persisted;
    this.appendSessionLog("online-world", {
      event: "game-card-program-refreshed",
      workId: refreshed.companion.workId,
      previousProgramDigest: previous.program.digest,
      programDigest: refreshed.program.digest,
      sourceFiles: sources.size
    });
    return true;
  }

  scheduleOnlineWorldMigrationResume(sourceCard) {
    if (this.migrationResumeTimer || this.migrationResumeInFlight || !this.onlineWorldService?.migrationDraft) return;
    const delay = this.migrationResumeAttempt === 0
      ? 0
      : Math.min(60000, 2000 * (2 ** Math.min(5, this.migrationResumeAttempt - 1)));
    this.migrationResumeTimer = setTimeout(() => {
      this.migrationResumeTimer = null;
      if (this.destroying || !this.onlineWorldService?.migrationDraft) return;
      const sourceWorkId = String(this.onlineWorldService.migrationDraft.sourceWorkId || sourceCard?.companion?.workId || "");
      this.appendSessionLog("online-world", {
        event: "migration-resume-started",
        attempt: this.migrationResumeAttempt + 1,
        workId: sourceWorkId,
        targetWorkId: this.onlineWorldService.migrationDraft.newWorkId
      });
      const running = this.migrateOnlineWorldCard();
      this.migrationResumeInFlight = running;
      running.then(result => {
        const pending = result?.state?.migration || result;
        if (pending?.requiresPublish || this.onlineWorldService?.migrationDraft) {
          this.migrationResumeAttempt += 1;
          this.appendSessionLog("online-world", {
            event: "migration-resume-pending",
            status: "degraded",
            attempt: this.migrationResumeAttempt,
            workId: sourceWorkId,
            targetWorkId: pending?.workId || this.onlineWorldService?.migrationDraft?.newWorkId || "",
            error: pending?.importError || "平台尚未完成搬迁写入"
          });
        } else {
          this.migrationResumeAttempt = 0;
          this.appendSessionLog("online-world", {
            event: "migration-resume-complete",
            workId: sourceWorkId,
            targetWorkId: result?.workId || result?.state?.work?.id || ""
          });
        }
      }).catch(error => {
        this.migrationResumeAttempt += 1;
        this.appendSessionLog("online-world", {
          event: "migration-resume-failed",
          status: "degraded",
          attempt: this.migrationResumeAttempt,
          error: error?.message || String(error),
          workId: sourceWorkId
        });
      }).finally(() => {
        if (this.migrationResumeInFlight === running) this.migrationResumeInFlight = null;
        if (this.onlineWorldService?.migrationDraft) this.scheduleOnlineWorldMigrationResume(sourceCard);
      });
    }, delay);
    this.migrationResumeTimer.unref?.();
  }

  async importOnlineWorldCard() {
    const selected = await dialog.showOpenDialog(this.window, {
      title: "导入在线游戏世界游戏卡",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "风月在线游戏卡", extensions: ["json"] }]
    });
    if (selected.canceled || !selected.filePaths.length) return { canceled: true, ...await this.listOnlineWorldCards() };
    return this.importOnlineWorldCardFiles(selected.filePaths);
  }

  async importOnlineWorldCardFiles(files) {
    if (!Array.isArray(files) || !files.length) throw new Error("请选择要导入的游戏卡文件");
    if (files.length > 32) throw new Error("一次最多导入 32 张游戏卡");
    const loaded = files.map(file => readGameCardFile(file));
    const imported = new Map();
    for (const { file, card } of loaded) {
      const libraryId = gameCardLibraryKey(card);
      this.onlineWorldCards.set(libraryId, card);
      imported.set(libraryId, summarizeGameCard(card, libraryId));
      const relativeInstallPath = path.relative(path.resolve(this.onlineWorldCardInstallDirectory), file);
      if (relativeInstallPath && !path.isAbsolute(relativeInstallPath)
        && !relativeInstallPath.startsWith(`..${path.sep}`) && path.dirname(relativeInstallPath) === ".") {
        if (!this.onlineWorldCardSources.has(libraryId)) this.onlineWorldCardSources.set(libraryId, new Set());
        this.onlineWorldCardSources.get(libraryId).add(file);
      }
    }
    saveGameCardLibrary(this.onlineWorldCardFile, this.onlineWorldCards);
    const persisted = loadGameCardLibrary(this.onlineWorldCardFile, null);
    for (const libraryId of imported.keys()) {
      if (!Map.prototype.has.call(persisted, libraryId)) throw new Error("游戏卡保存后回读失败");
    }
    this.onlineWorldCards = persisted;
    const importedCards = [...imported.values()];
    return { canceled: false, imported: importedCards[0], importedCards, ...await this.listOnlineWorldCards() };
  }

  async removeOnlineWorldCard(libraryId) {
    const requested = String(libraryId || "");
    if (!requested) throw new Error("请选择要移除的游戏卡");
    const card = this.onlineWorldCard(requested);
    const key = gameCardLibraryKey(card);
    if (this.onlineWorldService?.card && gameCardLibraryKey(this.onlineWorldService.card) === key) {
      await this.onlineWorldService.forgetOpenedCard();
    }
    const installedFiles = this.onlineWorldCardSources?.get(key);
    if (installedFiles?.size) removeGameCardDirectoryFiles(this.onlineWorldCardInstallDirectory, installedFiles);
    this.onlineWorldCardSources?.delete(key);
    if (!Map.prototype.delete.call(this.onlineWorldCards, key)) throw new Error("游戏卡已经不在本机游戏库中");
    saveGameCardLibrary(this.onlineWorldCardFile, this.onlineWorldCards);
    const persisted = loadGameCardLibrary(this.onlineWorldCardFile, null);
    if (Map.prototype.has.call(persisted, key)) throw new Error("游戏卡移除后回读失败");
    this.onlineWorldCards = persisted;
    return { removed: summarizeGameCard(card, key), ...await this.listOnlineWorldCards() };
  }

  async exportOnlineWorldCard(libraryId) {
    if (!libraryId) throw new Error("请从作者标识中选择要导出的游戏卡");
    const current = this.onlineWorldCard(libraryId);
    const card = await this.onlineWorldService.exportGameCard(current);
    const previousLibraryId = gameCardLibraryKey(current);
    this.onlineWorldCards.delete(previousLibraryId);
    this.onlineWorldCards.set(gameCardLibraryKey(card), card);
    saveGameCardLibrary(this.onlineWorldCardFile, this.onlineWorldCards);
    const safeName = String(card.title || "online-world").replace(/[<>:\"/\\|?*\x00-\x1f]/g, "-").slice(0, 60) || "online-world";
    const selected = await dialog.showSaveDialog(this.window, {
      title: "导出完整游戏卡",
      defaultPath: `${safeName}-${card.version}.fyow-card.json`,
      filters: [{ name: "风月在线游戏卡", extensions: ["json"] }]
    });
    if (selected.canceled || !selected.filePath) return { canceled: true, card: summarizeGameCard(card) };
    atomicWriteFileSync(fs, selected.filePath, `${JSON.stringify(card, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { canceled: false, filePath: selected.filePath, card: summarizeGameCard(card) };
  }

  async followOnlineWorldMigration(options = {}) {
    const current = this.onlineWorldService?.card;
    const migration = this.onlineWorldService?.pendingMigration;
    if (!current || !migration?.workId || migration.requiresPublish
      || migration.workId === this.onlineWorldService?.work?.id) return this.onlineWorldService.state();
    return this.followOnlineWorldMigrationChain(current, migration, options);
  }

  async followOnlineWorldMigrationChain(current, initialMigration, options = {}) {
    const sourceCard = current;
    const retiredWorkIds = new Set();
    const visited = new Set([String(current.companion?.workId || "")]);
    let migration = initialMigration;
    let card = current;
    let next = null;
    let chainCompleted = false;
    try {
      for (let hop = 0; hop < 16; hop += 1) {
        const targetWorkId = String(migration?.workId || "");
        if (!targetWorkId) throw new Error("迁移指针缺少目标作品编号");
        if (visited.has(targetWorkId)) throw new Error("迁移指针形成循环");
        visited.add(targetWorkId);
        if (migration.sourceWorkId) retiredWorkIds.add(String(migration.sourceWorkId));
        const reboundCard = rebindGameCard(card, targetWorkId, this.origin);
        const targetLibraryId = gameCardLibraryKey(reboundCard);
        const storedTargetCard = this.onlineWorldCards.get(targetLibraryId);
        card = reboundCard;
        if (storedTargetCard) {
          try {
            const validatedTargetCard = validateGameCard(storedTargetCard);
            const sameBinding = validatedTargetCard.cardId === reboundCard.cardId
              && validatedTargetCard.gameId === reboundCard.gameId
              && validatedTargetCard.companion.workId === targetWorkId
              && validatedTargetCard.companion.authorAccountId === reboundCard.companion.authorAccountId
              && validatedTargetCard.companion.origin === reboundCard.companion.origin;
            if (sameBinding && Number(validatedTargetCard.version || 0) >= Number(reboundCard.version || 0)) {
              card = validatedTargetCard;
            }
          } catch {}
        }
        next = await this.onlineWorldService.open({
          card,
          displayName: options.displayName,
          orientation: options.orientation,
          migrationProof: migration
        });
        const onward = next?.migration;
        if (onward?.workId && String(onward.workId) !== String(next?.work?.id || "")) {
          if (onward.requiresPublish) {
            chainCompleted = true;
            break;
          }
          migration = onward;
          continue;
        }
        if (!next?.initialized) throw new Error("迁移目标尚未完成服务器校验");
        chainCompleted = true;
        break;
      }
      if (!chainCompleted) throw new Error("迁移链超过最大跳转次数");
    } catch (error) {
      // Keep the old card as the durable entry point. Re-opening it restores
      // the signed tombstone state so a transient target failure is retryable.
      await this.onlineWorldService.open({
        card: sourceCard,
        displayName: options.displayName,
        orientation: options.orientation
      }).catch(() => null);
      throw error;
    }
    const migratedCard = this.onlineWorldService.card || card;
    this.persistRefreshedOnlineWorldCard(sourceCard, migratedCard);
    for (const workId of retiredWorkIds) this.onlineWorldService.clearCacheForWork(workId);
    return next;
  }

  async migrateOnlineWorldCard() {
    const result = await this.onlineWorldService.exportMigrationDraft();
    if (result?.redirectPublished && this.onlineWorldService.card && result.workId) {
      const current = this.onlineWorldService.card;
      const next = await this.followOnlineWorldMigrationChain(current, result, {
        displayName: this.account.username || "服主",
        orientation: "any"
      });
      return { ...result, state: next };
    }
    return result;
  }

  cancelAutoModels(scope = null) {
    for (const job of this.autoModelJobs?.values() || []) if (!scope || job.scope === scope) job.controller.abort();
    return { canceled: true };
  }

  recordAutomaticModelUsage(signal, result) {
    const job = [...this.autoModelJobs.values()].find(item => item.controller.signal === signal);
    if (!job) return;
    job.state.lastPoints = result?.points?.total ?? null;
    if (result?.points?.total != null) job.state.points = Number(job.state.points || 0) + Number(result.points.total);
    this.emit();
  }

  async configureAutomaticModel(appId, target, { conversationId = null, signal } = {}) {
    const scopes = [null, ...(conversationId ? [conversationId] : [])];
    for (const scope of scopes) {
      assertActive(signal);
      const query = `/apps/config?app_id=${encodeURIComponent(appId)}${scope ? `&conversation_id=${encodeURIComponent(scope)}` : ""}`;
      const current = this.normalizeModelPayload(await this.platformGoApi(query, { timeout: 15000 }));
      assertActive(signal);
      const nextModel = { ...(current.model || {}), provider: target.provider, name: target.model };
      if (Object.hasOwn(nextModel, "model")) nextModel.model = target.model;
      const params = { ...(nextModel.completion_params || {}) };
      for (const [key, range] of Object.entries(target.parameterRanges || {})) {
        if (range.supported === false) delete params[key];
        else if (Number.isFinite(Number(params[key]))) {
          if (Number.isFinite(range.min)) params[key] = Math.max(range.min, Number(params[key]));
          if (Number.isFinite(range.max)) params[key] = Math.min(range.max, Number(params[key]));
        }
      }
      nextModel.completion_params = params;
      await this.platformGoApi("/apps/config", {
        method: "POST", body: { app_id: appId, ...(scope ? { conversation_id: scope } : {}), model: nextModel }, timeout: 15000
      });
      assertActive(signal);
      const saved = this.normalizeModelPayload(await this.platformGoApi(query, { timeout: 15000 }));
      if (saved?.model?.provider !== target.provider || (saved?.model?.name || saved?.model?.model) !== target.model) throw new Error("平台尚未保存自动选择的模型");
      if (!scope && this.currentWorkAppId() === appId && this.platformModels) {
        this.platformModels.selected = this.modelPublicValue({ ...target, priceCoefficient: target.price, averageLatency: target.latency });
        this.platformModels.config = saved;
        if (this.room?.role === "host") this.room.model = this.platformModels.selected;
        this.emit();
      }
    }
  }

  async withAutoModel(appId, label, execute, { scope = "platform", conversationId = null, reload = null, maxAttempts = null } = {}) {
    this.assertToolLoggedIn();
    if (!appId) throw new Error("尚未选择模型请求的作品");
    const controller = new AbortController();
    const jobId = crypto.randomUUID();
    const authRevision = this.authSessionRevision;
    const room = this.room;
    const work = scope === "online-world" ? this.onlineWorldService?.work : this.work;
    const job = { controller, scope, state: { id: jobId, label, stage: "queued", attempt: 0, points: null } };
    this.autoModelJobs.set(jobId, job);
    this.emit();
    const checkContext = () => {
      if (this.destroying || !this.loggedIn || this.authSessionRevision !== authRevision
        || (scope === "online-world" ? this.onlineWorldService?.work !== work || this.onlineWorldService?.status === "closed"
          : this.work !== work || this.room !== room)) controller.abort();
    };
    const watcher = setInterval(checkContext, 250);
    const previous = this.autoModelQueues.get(appId) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => runAutoModel({
      signal: controller.signal,
      loadModels: async () => normalizeCatalog(await this.platformGoApi("/workspaces/model-list", { timeout: 15000 })),
      onState: progress => {
        checkContext();
        job.state = { ...job.state, ...progress };
        this.appendSessionLog("auto-model", { label, ...progress });
        this.emit();
      },
      maxAttempts,
      execute: async context => {
        checkContext();
        assertActive(context.signal);
        await this.configureAutomaticModel(appId, context.model, { conversationId, signal: context.signal });
        assertActive(context.signal);
        if (reload) await reload(context);
        assertActive(context.signal);
        const result = await execute(context);
        checkContext();
        assertActive(context.signal);
        return result;
      }
    }));
    const settled = run.catch(() => {});
    this.autoModelQueues.set(appId, settled);
    try { return await run; }
    finally {
      clearInterval(watcher);
      this.autoModelJobs.delete(jobId);
      if (this.autoModelQueues.get(appId) === settled) this.autoModelQueues.delete(appId);
      if (!this.destroying) this.emit();
    }
  }

  async onlineWorldModelRequest(request = {}, { signal } = {}) {
    this.assertToolLoggedIn();
    const workId = this.onlineWorldService?.work?.id;
    if (!workId) throw new Error("在线世界尚未绑定伴生作品");
    const task = String(request.task || "");
    const allowedTasks = new Set(["player.profile-context", "general.generate", "general.dialogue", "general.captive-dialogue", "general.memory.update", "general.letter", "general.appearance-edit"]);
    if (!allowedTasks.has(task)) throw new Error(`在线世界模型任务未登记：${task || "unknown"}`);
    const taskMarker = `[[FYOW:TASK:${task}:v1]]`;
    const keyword = String(request.keyword || taskMarker).slice(0, 200);
    if (!keyword.startsWith(taskMarker)) throw new Error("在线世界模型任务关键词与调用类型不一致");
    const structuredInput = JSON.stringify({ schema: "fyow.model-request/1", input: request.input || {} });
    if (structuredInput.length > 60000) throw new Error("在线世界模型输入超过 60000 字符限制");
    const query = `${keyword}\n${structuredInput}`;
    await this.refreshOnlineWorldPoints(task, "before");
    const pointsBefore = this.account.points;
    let anchor = null;
    let token = "";
    let tokenError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        anchor = await this.ensureAnchor();
        if (anchor.webContents.isLoading()) await Promise.race([
          new Promise(resolve => anchor.webContents.once("did-finish-load", resolve)),
          new Promise((_, reject) => setTimeout(() => reject(new Error("后台账号页面载入超时")), 12000))
        ]);
        token = String(await anchor.webContents.executeJavaScript("localStorage.getItem('console_token') || ''", true) || "");
        break;
      } catch (error) {
        tokenError = error;
        await new Promise(resolve => setTimeout(resolve, attempt * 250));
      }
    }
    if (!anchor) throw new Error(`读取账号会话失败：${tokenError?.message || "登录状态尚未就绪"}`);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    assertActive(signal);
    signal?.addEventListener("abort", cancel, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), 180000);
    let platformRequestStarted = false;
    this.appendSessionLog("online-world-model", { event: "request-started", task, newConversation: true });
    try {
      platformRequestStarted = true;
      const requestHeaders = { "Content-Type": "application/json", "X-Language": "zh-Hans" };
      if (token) requestHeaders.Authorization = `Bearer ${token}`;
      const response = await anchor.webContents.session.fetch(new URL("/go/api/apps/chat-messages", this.origin).href, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: requestHeaders,
        body: JSON.stringify(createModelRequestPayload({ workId, query }))
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        const error = new Error(failure?.message || failure?.msg || `模型请求失败：${response.status}`);
        if ([401, 402, 403].includes(response.status)) error.retryable = false;
        throw error;
      }
      if (/json/i.test(String(response.headers.get("content-type") || ""))) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure?.message || failure?.msg || "模型接口返回了业务错误");
      }
      const result = await consumeModelEventStream(response.body);
      if (!String(result.conversationId || "").trim()) throw new Error("平台完成模型输出后没有返回新会话编号");
      await this.refreshOnlineWorldPoints(task, "after");
      const points = resolvedModelPointUsage(result.points || result.usage, pointsBefore, this.account.points);
      this.recordAutomaticModelUsage(signal, { points });
      this.appendSessionLog("online-world-model", { event: "request-completed", task, conversationId: result.conversationId || null, messageId: result.messageId || null, finishEvent: result.finishEvent, answerCharacters: result.answer.length, points: points.total, remainingPoints: this.account.points });
      return { ...result, points, remainingPoints: this.account.points };
    } catch (error) {
      const normalized = signal?.aborted ? abortError() : error?.name === "AbortError" ? new Error("模型请求超过 180 秒") : error;
      if (platformRequestStarted) {
        await this.refreshOnlineWorldPoints(task, "after");
        normalized.modelUsage = {
          points: resolvedModelPointUsage(error?.points || error?.usage, pointsBefore, this.account.points),
          remainingPoints: this.account.points
        };
        this.recordAutomaticModelUsage(signal, normalized.modelUsage);
      }
      this.appendSessionLog("online-world-model", { event: "request-failed", task, error: normalized?.message || String(normalized), points: normalized.modelUsage?.points?.total ?? null, remainingPoints: normalized.modelUsage?.remainingPoints ?? null });
      throw normalized;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", cancel);
    }
  }

  async refreshOnlineWorldPoints(task, phase) {
    return this.refreshAccount(true).catch(error => {
      this.appendSessionLog("online-world-model", { event: `points-refresh-${phase}-failed`, task, error: error?.message || String(error) });
      return null;
    });
  }

  selectedCharacterProfile() {
    return this.characterProfiles.items.find(item => item.id === this.characterProfiles.selectedId) || this.characterProfiles.items[0];
  }

  assertToolLoggedIn() {
    if (!this.loggedIn) throw new Error("请先在主页面登录风月账号");
  }

  saveCharacterProfile(value = {}) {
    this.assertToolLoggedIn();
    if (this.room) throw new Error("房间开启期间不能修改或切换角色设定");
    const id = String(value.id || "").trim() || crypto.randomUUID();
    const label = String(value.label || value.displayName || "未命名设定").trim() || "未命名设定";
    const displayName = String(value.displayName || "").trim();
    if (!displayName) throw new Error("请填写游戏内姓名");
    const basicInfo = String(value.basicInfo ?? value.info ?? "");
    const appearance = String(value.appearance ?? "");
    if (label.length > 80 || displayName.length > 80 || basicInfo.length > 20000 || appearance.length > 10000) throw new Error("角色设定内容超过安全上限");
    const profile = {
      id,
      label,
      displayName,
      basicInfo,
      appearance,
      info: composeCharacterInfo(basicInfo, appearance),
      updatedAt: Date.now()
    };
    const index = this.characterProfiles.items.findIndex(item => item.id === id);
    if (index >= 0) this.characterProfiles.items[index] = profile;
    else this.characterProfiles.items.push(profile);
    this.characterProfiles.selectedId = id;
    writeCharacterProfiles(this.profileId, this.characterProfiles);
    this.emit({ characterProfileSaved: true });
    return this.state().characterProfiles;
  }

  createCharacterProfile() {
    this.assertToolLoggedIn();
    if (this.room) throw new Error("房间开启期间不能修改或切换角色设定");
    if (this.characterProfiles.items.length >= 50) throw new Error("角色设定最多保存 50 个");
    const profile = emptyCharacterProfile();
    profile.label = `新设定 ${this.characterProfiles.items.length + 1}`;
    this.characterProfiles.items.push(profile);
    this.characterProfiles.selectedId = profile.id;
    writeCharacterProfiles(this.profileId, this.characterProfiles);
    this.emit({ characterProfileCreated: true });
    return this.state().characterProfiles;
  }

  selectCharacterProfile(profileId) {
    this.assertToolLoggedIn();
    if (this.room) throw new Error("房间开启期间不能切换角色设定");
    const id = String(profileId || "");
    if (!this.characterProfiles.items.some(item => item.id === id)) throw new Error("找不到这个角色设定");
    this.characterProfiles.selectedId = id;
    writeCharacterProfiles(this.profileId, this.characterProfiles);
    this.emit({ characterProfileSelected: true });
    return this.state().characterProfiles;
  }

  deleteCharacterProfile(profileId) {
    this.assertToolLoggedIn();
    if (this.room) throw new Error("房间开启期间不能修改角色设定");
    const id = String(profileId || "");
    if (this.characterProfiles.items.length <= 1) throw new Error("至少需要保留一个角色设定");
    const next = this.characterProfiles.items.filter(item => item.id !== id);
    if (next.length === this.characterProfiles.items.length) throw new Error("找不到这个角色设定");
    this.characterProfiles.items = next;
    if (this.characterProfiles.selectedId === id) this.characterProfiles.selectedId = next[0].id;
    writeCharacterProfiles(this.profileId, this.characterProfiles);
    this.emit({ characterProfileDeleted: true });
    return this.state().characterProfiles;
  }

  normalizeModelPayload(payload) {
    return payload?.data?.data ?? payload?.data ?? payload?.result ?? payload ?? {};
  }

  currentWorkAppId() {
    if (!this.work?.suffix) return null;
    try { return parseInviteWork(this.work.suffix, this.origin).id; }
    catch { return null; }
  }

  currentPrefixAdapter() {
    const appId = this.currentWorkAppId();
    const stored = appId ? this.prefixAdapters?.adapters?.[appId] : null;
    const normalized = normalizePrefixAdapter(stored);
    return normalized ? { ...stored, ...normalized } : null;
  }

  publicPluginSettings() {
    return normalizePluginSettings(this.pluginSettings);
  }

  async updatePluginSettings(pluginId, payload = {}) {
    this.assertToolLoggedIn();
    if (![EFFECT_JUDGE_PLUGIN_ID, PERSPECTIVE_PLUGIN_ID].includes(pluginId)) throw new Error("找不到这个插件");
    if (this.pluginPipelineBusy || this.pluginSettingsBusy || this.perspectiveProgress || this.roundBusy || this.workSettings.saving) throw new Error("插件处理栈或设置正在更新，暂时不能修改设置");
    if (pluginId === PERSPECTIVE_PLUGIN_ID && (this.conversationBusy || this.prefixAdapterBusy)) throw new Error("请等待会话操作或联机适配完成后再修改独立视角");
    if (this.room?.role === "guest") throw new Error("联机房间中的插件由房主统一配置");
    if (this.room?.round?.status && this.room.round.status !== "collecting") throw new Error("当前回合正在处理，暂时不能修改插件");
    if (Object.keys(this.room?.round?.submissions || {}).length) throw new Error("本轮已有成员确认输入，请在下一轮开始前修改插件");
    this.pluginSettingsBusy = true;
    if (pluginId === PERSPECTIVE_PLUGIN_ID) this.conversationBusy = true;
    this.emit();
    try {
    const current = this.pluginSettings.plugins[pluginId];
    const normalize = pluginId === PERSPECTIVE_PLUGIN_ID ? normalizePerspectiveSettings : normalizeEffectJudgeSettings;
    const settings = normalize({ ...current.settings, ...(payload.settings || payload) });
    const nextSettings = normalizePluginSettings({
      version: 2,
      plugins: {
        ...this.pluginSettings.plugins,
        [pluginId]: {
          enabled: payload.enabled == null ? current.enabled : Boolean(payload.enabled),
          settings
        }
      }
    });
    // Save the setting only after the independently owned session block has
    // been written and read back. A failed cleanup must not look disabled.
    const prefixSync = pluginId === PERSPECTIVE_PLUGIN_ID ? await this.syncPerspectivePrefix(nextSettings.plugins[pluginId]) : null;
    this.pluginSettings = nextSettings;
    writePluginSettings(this.profileId, this.pluginSettings);
    this.appendSessionLog("plugin-settings", {
      event: "updated",
      pluginId,
      enabled: this.pluginSettings.plugins[pluginId].enabled,
      settings
    });
    if (this.room?.role === "host" && this.room.status === "waiting") {
      this.room.plugins = this.publicPluginSettings();
      await this.broadcastRoomPacket("plugin-settings-sync", { plugins: this.room.plugins }, true);
    }
    this.emit({ pluginSettingsUpdated: true });
    return { ...this.state().plugins, prefixSync };
    } finally {
      if (pluginId === PERSPECTIVE_PLUGIN_ID) this.conversationBusy = false;
      this.pluginSettingsBusy = false;
      this.emit();
    }
  }

  perspectiveTargetsPath() {
    return path.join(app.getPath("userData"), `perspective-prefix-targets-${safeProfileId(this.profileId)}.json`);
  }

  rememberPerspectiveTarget(appId, conversationId) {
    let targets = [];
    try { targets = readJsonWithBackupSync(fs, this.perspectiveTargetsPath(), Array.isArray).value || []; } catch {}
    if (!targets.some(item => item.appId === appId && item.conversationId === conversationId && item.origin === this.origin)) {
      targets.push({ appId, conversationId, origin: this.origin });
      atomicWriteJsonSync(fs, this.perspectiveTargetsPath(), targets);
    }
  }

  async syncPerspectivePrefix(definition) {
    if (this.room?.role === "guest") throw new Error("只有房主可以写入独立视角前置词");
    const appId = this.currentWorkAppId();
    let conversationId = String(this.room?.save?.conversationId || this.conversation.activeId || "").trim();
    let prepared = null;
    if (definition.enabled && !appId) return { status: "deferred" };
    if (definition.enabled && !conversationId) {
      prepared = await this.ensureHostConversationForPromptConfig({ allowLobby: true });
      conversationId = String(prepared.conversationId || "").trim();
      if (!conversationId) throw new Error("无法建立独立视角所需的平台会话，前置词尚未写入");
    }
    let targets = [];
    try { targets = readJsonWithBackupSync(fs, this.perspectiveTargetsPath(), Array.isArray).value || []; } catch {}
    if (!Array.isArray(targets)) targets = [];
    // Mirrors share platform records; use the currently authenticated origin.
    const selected = definition.enabled ? [] : targets;
    if (appId && conversationId && !selected.some(t => t.appId === appId && t.conversationId === conversationId)) selected.push({ appId, conversationId });
    let currentExpected = null;
    try {
    for (const target of selected) {
      const config = await this.readPlatformConversationConfig(target.appId, target.conversationId);
      const fields = resolveConversationPromptFields(config);
      const next = upsertPerspectivePrefix(fields.prefixPrompt, definition.enabled, definition.settings);
      if (target.appId === appId && target.conversationId === conversationId) currentExpected = { path: fields.prefixPath, text: next };
      if (definition.enabled) this.rememberPerspectiveTarget(target.appId, target.conversationId);
      if (next === fields.prefixPrompt && (!definition.enabled || config.is_global === false)) continue;
      const patch = {};
      let node = patch;
      fields.prefixPath.slice(0, -1).forEach(key => { node = node[key] = {}; });
      node[fields.prefixPath.at(-1)] = next;
      await this.platformGoApi("/apps/config", { method: "POST", body: { app_id: target.appId, conversation_id: target.conversationId, is_global: false, ...patch } });
      const verified = await this.readPlatformConversationConfig(target.appId, target.conversationId);
      if (getPathValue(verified, fields.prefixPath) !== next || (definition.enabled && verified.is_global === true)) throw new Error("平台未保存独立视角前置词，请重试");
    }
    } finally {
      if (prepared?.created) await this.removeHostPromptBootstrapTurn(appId, conversationId, prepared.marker);
    }
    if (prepared?.created && currentExpected) {
      const verified = await this.readPlatformConversationConfig(appId, conversationId);
      if (getPathValue(verified, currentExpected.path) !== currentExpected.text || verified.is_global === true) throw new Error("清理初始化消息后平台未保留独立视角前置词，请重试");
    }
    if (!definition.enabled) atomicWriteJsonSync(fs, this.perspectiveTargetsPath(), []);
    if (appId && conversationId && this.workGameUrl()) {
      await this.loadSurfaceUrl(this.gameSurface, this.workGameUrl(), "作品对话页面", 20000);
      await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
    }
    this.appendSessionLog("perspective-prefix", { event: definition.enabled ? "enabled-and-verified" : "disabled-and-verified", appId, conversationId: conversationId || null, targetCount: selected.length });
    return { status: "saved", conversationId: conversationId || null };
  }

  async runPerspectivePlugin(output, activeRound) {
    activeRound.perspectiveSplit = true;
    activeRound.perspectiveOutputs = Object.create(null);
    const members = this.room.members.map(member => ({ ...member }));
    this.perspectiveProgress = { attempt: 1, maxAttempts: null };
    this.emit({ perspectiveAttemptStarted: true });
    try {
      const generated = await this.runPlatformAutomationModel(
        PERSPECTIVE_APP_ID, buildPerspectiveRequest(output, members), "独立视角",
        { timeoutMs: PERSPECTIVE_ATTEMPT_TIMEOUT_MS, validate: result => parsePerspectiveResponse(result.output, { members }) }
      );
      const parsed = parsePerspectiveResponse(generated.output, { members });
      activeRound.perspectiveOutputs = parsed.outputs;
      return { value: parsed.outputs[String(this.account.accountId)] || WITHHELD_OUTPUT, run: {
        model: generated.model, points: generated.points, pointsIncomplete: generated.pointsIncomplete,
        attemptCount: generated.attemptCount, maxAttempts: null, attempts: generated.attempts,
        memberCount: members.length, segmentCount: parsed.payload.segments.length
      } };
    } catch (error) {
      error.pluginRun = { ...(error.pluginRun || {}), withheld: true };
      throw error;
    } finally {
      this.perspectiveProgress = null;
      this.emit({ perspectiveAttemptsFinished: true });
    }
  }

  async preparePerspectiveRetryModels() {
    const appId = PERSPECTIVE_APP_ID;
    const [listPayload, configPayload] = await Promise.all([
      this.platformGoApi("/workspaces/model-list", { timeout: 15000 }),
      this.platformGoApi(`/apps/config?app_id=${encodeURIComponent(appId)}`, { timeout: 15000 })
    ]);
    const plan = buildPerspectiveRetryModelPlan(listPayload, configPayload);
    if (!plan.originalModel) throw new Error("无法读取独立视角作品当前模型配置");
    if (!plan.candidates.length) throw new Error("平台当前模型列表中没有可用于独立视角重试的不同型号");
    this.appendSessionLog("perspective-retry", {
      event: "model-plan-ready",
      original: plan.originalKey || null,
      candidates: plan.candidates.map(item => ({ provider: item.provider, model: item.model }))
    });
    return plan;
  }

  async applyPerspectiveRetryModel(target, baseModel, attempt) {
    const appId = PERSPECTIVE_APP_ID;
    const nextModel = { ...baseModel, provider: target.provider, name: target.model };
    if (Object.prototype.hasOwnProperty.call(nextModel, "model")) nextModel.model = target.model;
    await this.platformGoApi("/apps/config", {
      method: "POST",
      body: { app_id: appId, model: nextModel },
      timeout: 15000
    });
    const verified = this.normalizeModelPayload(await this.platformGoApi(`/apps/config?app_id=${encodeURIComponent(appId)}`, { timeout: 15000 }));
    const savedKey = perspectiveRetryModelKey({ provider: verified?.model?.provider, model: verified?.model?.name || verified?.model?.model });
    if (savedKey !== target.key) throw new Error(`平台未保存独立视角第 ${attempt} 次尝试的重试模型`);
    this.appendSessionLog("perspective-retry", {
      event: "model-saved",
      attempt,
      model: { provider: target.provider, model: target.model }
    });
    return target;
  }

  async readAuthoritativeRoundOutput(input) {
    const appId = this.currentWorkAppId();
    const conversationId = this.room?.save?.conversationId || this.conversation.activeId;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const payload = await this.platformChatApi(`/installed-apps/${encodeURIComponent(appId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=8&page=1&paging_query_sort=desc`);
      const latest = this.platformMessageRecords(payload).find(record => String(record.query || "") === input && typeof record.answer === "string" && record.answer.trim());
      if (latest) return latest.answer;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error("无法读取本轮平台原文，为避免视角错配暂不公开；请检查会话记录后重试");
  }

  async rememberPerspectiveView(source, output) {
    const key = `${this.currentWorkAppId()}:${this.room?.save?.conversationId || this.conversation.activeId}`;
    this.perspectiveViews[key] ||= {};
    this.perspectiveViews[key][outputFingerprint(source)] = output;
    atomicWriteJsonSync(fs, path.join(app.getPath("userData"), `perspective-views-${safeProfileId(this.profileId)}.json`), this.perspectiveViews);
    await this.installPerspectiveResponseFilter();
  }

  async installPerspectiveResponseFilter() {
    const wc = this.gameSurface?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    if (!this.perspectiveResponseListener) {
      this.perspectiveResponseListener = (_event, method, params) => {
        if (method !== "Fetch.requestPaused") return;
        void (async () => {
          let completed = false;
          try {
            const url = new URL(params.request.url);
            const appId = url.pathname.match(/\/installed-apps\/([^/]+)\/messages/)?.[1];
            const conversationId = url.searchParams.get("conversation_id");
            const views = this.perspectiveViews[`${appId}:${conversationId}`];
            if (params.request.method === "GET" && params.responseStatusCode === 200 && views && this.room?.role !== "guest") {
              const body = await wc.debugger.sendCommand("Fetch.getResponseBody", { requestId: params.requestId });
              const payload = JSON.parse(body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body);
              let changed = false;
              const visit = value => {
                if (!value || typeof value !== "object") return;
                if (typeof value.answer === "string") {
                  const projected = views[outputFingerprint(value.answer)];
                  if (typeof projected === "string") { value.answer = projected; changed = true; }
                }
                for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
              };
              visit(payload);
              if (changed) {
                await wc.debugger.sendCommand("Fetch.fulfillRequest", {
                  requestId: params.requestId, responseCode: 200,
                  responseHeaders: (params.responseHeaders || []).filter(h => !/^(content-length|content-encoding|transfer-encoding)$/i.test(h.name)),
                  body: Buffer.from(JSON.stringify(payload)).toString("base64")
                });
                completed = true;
              }
            }
          } catch (error) {
            // Do not deliver an unfiltered history when projection fails.
            await wc.debugger.sendCommand("Fetch.failRequest", { requestId: params.requestId, errorReason: "Failed" }).catch(() => {});
            completed = true;
            this.appendSessionLog("perspective-view", { error: error?.message || String(error) });
          } finally {
            if (!completed) await wc.debugger.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
          }
        })();
      };
      wc.debugger.on("message", this.perspectiveResponseListener);
    }
    await wc.debugger.sendCommand("Fetch.enable", { patterns: [{ urlPattern: "*/installed-apps/*/messages*", requestStage: "Response" }] });
  }

  async readRecentConversationOutputs(limit) {
    const count = Math.max(0, Math.min(20, Number(limit) || 0));
    if (!count) return [];
    const appId = this.currentWorkAppId();
    const conversationId = String(this.room?.save?.conversationId || this.conversation.activeId || "").trim();
    if (!appId || !conversationId) return [];
    const payload = await this.platformChatApi(
      `/installed-apps/${encodeURIComponent(appId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=${Math.max(12, count * 2)}&page=1&paging_query_sort=desc`,
      { timeout: 15000 }
    );
    return this.platformMessageRecords(payload)
      .map(record => String(record?.answer || "").trim())
      .filter(Boolean)
      .slice(0, count)
      .reverse();
  }

  async runEffectJudgePlugin(playerInputs, activeRound) {
    const definition = this.pluginSettings.plugins[EFFECT_JUDGE_PLUGIN_ID];
    const settings = normalizeEffectJudgeSettings(definition.settings);
    const players = playerInputs.map((player, index) => ({
      playerKey: `P${index + 1}`,
      displayName: String(player.设定名 || `玩家${index + 1}`),
      text: String(player.输入内容 || "")
    }));
    const previousOutputs = await this.readRecentConversationOutputs(settings.previousOutputs);
    if (!previousOutputs.length) {
      const run = {
        name: "效果判定",
        appId: EFFECT_JUDGE_APP_ID,
        settings,
        skipped: true,
        skipReason: "no-history",
        points: { input: 0, output: 0, total: 0 },
        members: []
      };
      this.appendSessionLog("plugin-pipeline", {
        event: "effect-judge-skipped",
        round: activeRound.number,
        reason: run.skipReason
      });
      return { value: playerInputs, run };
    }
    const request = buildEffectJudgeRequest({ settings, previousOutputs, players });
    this.appendSessionLog("plugin-pipeline", {
      event: "effect-judge-request",
      round: activeRound.number,
      settings,
      previousOutputCount: previousOutputs.length,
      players
    });
    const generated = await this.runPlatformAutomationModel(EFFECT_JUDGE_APP_ID, request, "效果判定插件", {
      validate: result => parseEffectJudgeResponse(result.output, { settings, players })
    });
    this.appendSessionLog("plugin-pipeline", {
      event: "effect-judge-response-read",
      round: activeRound.number,
      model: String(generated?.model || ""),
      points: generated?.points || null,
      outputSource: String(generated?.outputSource || "unknown"),
      outputLength: String(generated?.output || "").length,
      content: String(generated?.output || "")
    });
    let parsed;
    try {
      parsed = parseEffectJudgeResponse(generated?.output, { settings, players });
    } catch (error) {
      error.pluginRun = {
        name: "效果判定",
        appId: EFFECT_JUDGE_APP_ID,
        settings,
        model: String(generated?.model || ""),
        points: generated?.points || { input: 0, output: 0, total: 0 },
        members: []
      };
      throw error;
    }
    const members = parsed.players.map(player => {
      const faces = mapEffectDegreesToFaces(player.degrees, settings.dieFaces);
      const roll = crypto.randomInt(1, settings.dieFaces + 1);
      const selected = faces.find(face => face.face === roll);
      return {
        playerKey: player.playerKey,
        displayName: player.displayName || players.find(item => item.playerKey === player.playerKey)?.displayName || player.playerKey,
        roll,
        selected,
        faces
      };
    });
    const transformed = applyEffectJudgeSelections(playerInputs, members);
    const run = {
      name: "效果判定",
      appId: EFFECT_JUDGE_APP_ID,
      settings,
      model: String(generated?.model || ""),
      points: generated?.points || { input: 0, output: 0, total: 0 },
      members
    };
    this.appendSessionLog("plugin-pipeline", {
      event: "effect-judge-completed",
      round: activeRound.number,
      run
    });
    return { value: transformed, run };
  }

  async runConversationPluginStack(phase, value, activeRound, { forcePluginIds = [] } = {}) {
    const effect = this.pluginSettings.plugins[EFFECT_JUDGE_PLUGIN_ID];
    const perspective = this.pluginSettings.plugins[PERSPECTIVE_PLUGIN_ID];
    const forced = new Set(forcePluginIds.map(String));
    const plugins = phase === PLUGIN_PHASES.INPUT ? [{
      id: EFFECT_JUDGE_PLUGIN_ID,
      name: "效果判定",
      phase: PLUGIN_PHASES.INPUT,
      order: effect.order,
      enabled: effect.enabled,
      run: ({ value: inputs }) => this.runEffectJudgePlugin(inputs, activeRound)
    }] : [{
      id: PERSPECTIVE_PLUGIN_ID,
      name: "独立视角",
      phase: PLUGIN_PHASES.OUTPUT,
      order: perspective.order,
      enabled: perspective.enabled || forced.has(PERSPECTIVE_PLUGIN_ID),
      run: ({ value: output }) => this.runPerspectivePlugin(output, activeRound)
    }];
    this.pluginPipelineBusy = true;
    activeRound.pipeline = { phase, status: "running", startedAt: Date.now(), completedAt: null };
    this.emit({ pluginPipelineUpdated: true });
    try {
      const result = await runPluginStack({
        phase,
        value,
        context: { round: activeRound.number },
        plugins,
        onRun: (_run, runs) => {
          const otherPhaseRuns = (activeRound.pluginRuns || []).filter(item => item.phase !== phase);
          activeRound.pluginRuns = [...otherPhaseRuns, ...runs];
          this.emit({ pluginPipelineUpdated: true });
        }
      });
      const otherPhaseRuns = (activeRound.pluginRuns || []).filter(item => item.phase !== phase);
      activeRound.pluginRuns = [...otherPhaseRuns, ...result.runs];
      activeRound.pipeline = { ...activeRound.pipeline, status: "completed", completedAt: Date.now() };
      this.pluginLastRuns = activeRound.pluginRuns;
      return result.value;
    } finally {
      this.pluginPipelineBusy = false;
      this.emit({ pluginPipelineUpdated: true });
    }
  }

  async readLastConversationAnswer(appId, conversation, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const payload = await this.platformChatApi(
          `/installed-apps/${encodeURIComponent(appId)}/messages?conversation_id=${encodeURIComponent(conversation.id)}&limit=12&page=1&paging_query_sort=desc`,
          { timeout: 12000 }
        );
        const records = this.platformMessageRecords(payload);
        const record = records.find(item => typeof item?.answer === "string" && item.answer.trim()) || null;
        return record ? {
          conversation_id: String(conversation.id),
          conversation_name: String(conversation.name || "未命名会话"),
          last_ai_reply: String(record.answer)
        } : null;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, attempt * 350));
      }
    }
    throw new Error(`读取会话“${conversation.name || conversation.id}”最后一段 AI 回复失败：${lastError?.message || String(lastError)}`);
  }

  async collectPrefixAdapterSamples(appId) {
    const conversation = await this.refreshConversations({
      bindHost: !this.room || this.room.role === "host",
      keepSessionKey: Boolean(this.conversation.sessionKey),
      mountTimeoutMs: 3000
    });
    const items = (conversation.items || []).filter(item => item?.id);
    if (!items.length) throw new Error("当前作品没有可供分析的已有会话");
    const samples = [];
    let excludedCount = 0;
    let scannedCount = 0;
    for (let offset = 0; offset < items.length && samples.length < PREFIX_ADAPTER_MAX_SAMPLES; offset += PREFIX_ADAPTER_MAX_SAMPLES) {
      const batch = items.slice(offset, offset + PREFIX_ADAPTER_MAX_SAMPLES);
      const results = await Promise.all(batch.map(item => this.readLastConversationAnswer(appId, item)));
      scannedCount += batch.length;
      for (const sample of results) {
        if (!sample) continue;
        if (isExcludedPrefixAdapterSample(sample.last_ai_reply)) {
          excludedCount += 1;
          this.appendSessionLog("prefix-adapter", {
            event: "sample-excluded",
            conversationId: sample.conversation_id,
            conversationName: sample.conversation_name,
            reason: "google-generative-policy-marker"
          });
          continue;
        }
        if (samples.length < PREFIX_ADAPTER_MAX_SAMPLES) samples.push(sample);
      }
      this.prefixAdapterOperation = {
        ...(this.prefixAdapterOperation || {}),
        stage: "collecting",
        current: scannedCount,
        total: items.length,
        error: null
      };
      this.emit({ prefixAdapterCollecting: true });
    }
    this.appendSessionLog("prefix-adapter", {
      event: "samples-selected",
      appId,
      selectedCount: samples.length,
      excludedCount,
      scannedCount,
      maximum: PREFIX_ADAPTER_MAX_SAMPLES
    });
    if (!samples.length) {
      const detail = excludedCount
        ? "已有回复均包含 Google Generative AI 使用政策标记，已从适配样本中排除"
        : "已有会话中没有可供分析的 AI 回复；请先在该作品中完成至少一轮对话";
      throw new Error(detail);
    }
    return samples;
  }

  async runPlatformAutomationModel(appId, modelInput, label = "平台插件", { timeoutMs = 180000, validate = null } = {}) {
    const totalPoints = { input: 0, output: 0, total: 0 };
    let pointsIncomplete = false;
    const attempts = [];
    let attemptCount = 0;
    let model = "";
    try {
      return await this.withAutoModel(appId, label, async ({ signal, attempt }) => {
        attemptCount = attempt;
        let result;
        let failure;
        try {
          result = await this.runPlatformAutomationAttempt(appId, modelInput, label, { timeoutMs: timeoutMs || 180000, signal });
          model = result.model || model;
          if (validate) await validate(result);
        } catch (error) { failure = error; }
        const observed = result?.points || failure?.modelUsage?.points;
        for (const field of ["input", "output", "total"]) {
          if (observed?.[field] == null) pointsIncomplete = true;
          else totalPoints[field] += Number(observed[field]) || 0;
        }
        attempts.push({ attempt, status: failure ? "error" : "completed", error: failure?.message || null });
        if (attempts.length > 30) attempts.shift();
        this.recordAutomaticModelUsage(signal, { points: observed });
        this.appendSessionLog("auto-model-usage", { label, attempt, points: observed || null, model });
        if (failure) throw failure;
        return { ...result, points: totalPoints, pointsIncomplete, attemptCount, attempts };
      });
    } catch (error) {
      error.pluginRun = { model, points: totalPoints, pointsIncomplete, attemptCount, attempts, maxAttempts: null };
      throw error;
    }
  }

  async runPlatformAutomationAttempt(appId, modelInput, label = "平台插件", { timeoutMs = 180000, signal } = {}) {
    assertActive(signal);
    const automationWindow = new BrowserWindow({
      show: false,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      x: -32000,
      y: -32000,
      width: 1080,
      height: 760,
      backgroundColor: "#10151d",
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    const adapterUrl = `${this.origin}/zh/explore/installed/${appId}`;
    const cancel = () => { if (!automationWindow.isDestroyed()) automationWindow.destroy(); };
    signal?.addEventListener("abort", cancel, { once: true });
    const perform = async () => {
      await this.loadSurfaceUrl(automationWindow, adapterUrl, label, 25000);
      const reset = await automationWindow.webContents.executeJavaScript(`(async () => {
        try {
          const appId = ${JSON.stringify(appId)};
          const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
          const normalize = value => String(value || '').replace(/[\\s\\u00a0\\u200b]+/g, '');
          const isNewConversation = value => /^(新对话|新建对话|创建新对话|新的对话|NewChat|NewConversation)$/i.test(normalize(value));
          const map = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
          const previous = typeof map?.[appId] === 'string'
            ? map[appId]
            : map?.[appId]?.conversationId || map?.[appId]?.conversation_id || map?.[appId]?.id || '';
          const newButton = [...document.querySelectorAll('button,[role="button"]')]
            .find(button => isNewConversation(button.textContent) || isNewConversation(button.getAttribute('aria-label')) || isNewConversation(button.getAttribute('title')));
          if (newButton) {
            HTMLElement.prototype.click.call(newButton);
            await sleep(250);
          }
          map[appId] = '';
          localStorage.setItem('conversationIdInfo', JSON.stringify(map));
          return { reset: map[appId] === '', previousConversationId: String(previous || ''), clickedNewButton: Boolean(newButton) };
        } catch (error) { return { reset:false, error:error?.message || String(error) }; }
      })()`, true);
      if (!reset?.reset) throw new Error(`无法为${label}建立新会话：${reset?.error || "平台会话状态重置失败"}`);
      await this.loadSurfaceUrl(automationWindow, adapterUrl, label, 25000);
      const cleanState = await automationWindow.webContents.executeJavaScript(`(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const appId = ${JSON.stringify(appId)};
        const readConversationId = () => {
          try {
            const map = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
            const value = map?.[appId];
            return typeof value === 'string' ? value : value?.conversationId || value?.conversation_id || value?.id || '';
          } catch { return ''; }
        };
        for (let attempt = 0; attempt < 160 && !document.querySelector('#ai-chat-input'); attempt += 1) await sleep(125);
        const questionCount = document.querySelectorAll('#customized-question-content').length;
        const answerCount = document.querySelectorAll('#ai-chat-answer').length;
        const conversationId = String(readConversationId() || '');
        return {
          ready: Boolean(document.querySelector('#ai-chat-input')) && !conversationId && questionCount === 0 && answerCount === 0,
          conversationId,
          questionCount,
          answerCount,
          hasInput: Boolean(document.querySelector('#ai-chat-input'))
        };
      })()`, true);
      if (!cleanState?.ready) {
        throw new Error(`${label}的新会话不是纯净状态（会话=${cleanState?.conversationId || "空"}，输入=${cleanState?.questionCount || 0}，回复=${cleanState?.answerCount || 0}）`);
      }
      this.appendSessionLog("platform-plugin", {
        event: "clean-conversation-ready",
        appId,
        label,
        previousConversationId: reset.previousConversationId || null,
        clickedNewButton: Boolean(reset.clickedNewButton)
      });
      const generated = await automationWindow.webContents.executeJavaScript(`(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const modelInput = ${JSON.stringify(modelInput)};
        for (let attempt = 0; attempt < 160 && !document.querySelector('#ai-chat-input'); attempt += 1) await sleep(125);
        const input = document.querySelector('#ai-chat-input');
        const send = document.querySelector('#ai-send-button');
        if (!input || !send) throw new Error('适配器作品没有出现平台输入栈');
        const beforeAnswers = document.querySelectorAll('#ai-chat-answer').length;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, modelInput);
        input.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:null }));
        input.dispatchEvent(new Event('change', { bubbles:true }));
        await sleep(220);
        if (input.value !== modelInput) throw new Error('会话样本没有完整写入适配器输入框');
        const readySend = document.querySelector('#ai-send-button');
        if (!readySend || readySend.disabled || readySend.getAttribute('aria-disabled') === 'true') throw new Error('适配器发送按钮尚未就绪');
        HTMLElement.prototype.click.call(readySend);
        let answer = null;
        for (let attempt = 0; attempt < 1800; attempt += 1) {
          const answers = [...document.querySelectorAll('#ai-chat-answer')];
          const candidate = answers.at(-1) || null;
          const model = candidate?.querySelector('#customized-answer-content-model-name')?.textContent?.trim() || '';
          const inputPoints = candidate?.querySelector('#customized-answer-content-model-input-points')?.textContent?.trim() || '';
          const outputPoints = candidate?.querySelector('#customized-answer-content-model-output-points')?.textContent?.trim() || '';
          if (answers.length > beforeAnswers && candidate && model && inputPoints && outputPoints) { answer = candidate; break; }
          await sleep(250);
        }
        if (!answer) throw new Error('等待适配器模型输出完成超时');
        const modelText = answer.querySelector('#customized-answer-content-model-name')?.textContent?.trim() || '';
        const inputPointsText = answer.querySelector('#customized-answer-content-model-input-points')?.textContent?.trim() || '';
        const outputPointsText = answer.querySelector('#customized-answer-content-model-output-points')?.textContent?.trim() || '';
        const renderedAnswer = answer.cloneNode(true);
        renderedAnswer.querySelectorAll('button,#customized-answer-content-model-name,#customized-answer-content-model-input-points,#customized-answer-content-model-output-points').forEach(item => item.remove());
        const renderedOutput = String(renderedAnswer.textContent || '');
        const edit = answer.querySelector('#customized-edit-button');
        if (!edit) throw new Error('无法读取适配器的原始格式建议');
        HTMLElement.prototype.click.call(edit);
        const visible = element => {
          if (!element || !element.isConnected) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        let editor = null;
        let dialog = null;
        let editorOutput = '';
        let previousEditorOutput = '';
        let stableReads = 0;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          dialog = [...document.querySelectorAll('[role="dialog"]')]
            .filter(item => item.getAttribute('data-state') !== 'closed' && visible(item))
            .find(item => item.querySelector('textarea')) || null;
          editor = dialog?.querySelector('textarea') || null;
          const currentOutput = String(editor?.value || '');
          stableReads = currentOutput && currentOutput === previousEditorOutput ? stableReads + 1 : 0;
          previousEditorOutput = currentOutput;
          if (editor && currentOutput && stableReads >= 2) { editorOutput = currentOutput; break; }
          await sleep(50);
        }
        if (!editorOutput && editor) editorOutput = String(editor.value || '');
        const cancel = [...(dialog || document).querySelectorAll('button')].find(button => /^(取消|Cancel)$/i.test((button.textContent || '').trim()));
        if (cancel) HTMLElement.prototype.click.call(cancel);
        const output = editorOutput.trim() ? editorOutput : renderedOutput;
        if (!output.trim()) throw new Error('适配器作品已生成回复，但编辑框和已渲染回复均为空');
        const parsePoints = value => Number((String(value || '').match(/[\\d,]+/)?.[0] || '0').replaceAll(',', '')) || 0;
        const readConversationId = () => {
          try {
            const map = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
            const value = map?.[${JSON.stringify(appId)}];
            return typeof value === 'string' ? value : value?.conversationId || value?.conversation_id || value?.id || '';
          } catch { return ''; }
        };
        let conversationId = String(readConversationId() || '');
        for (let attempt = 0; attempt < 120 && !conversationId; attempt += 1) {
          await sleep(50);
          conversationId = String(readConversationId() || '');
        }
        if (!conversationId) throw new Error('适配器输出完成，但平台没有建立新的会话');
        return {
          output,
          outputSource: editorOutput.trim() ? 'editor' : 'rendered',
          conversationId,
          model: modelText.replace(/^模型\\s*/, '').trim(),
          points: {
            input: parsePoints(inputPointsText),
            output: parsePoints(outputPointsText),
            total: parsePoints(inputPointsText) + parsePoints(outputPointsText)
          }
        };
      })()`, true);
      if (generated.conversationId === reset.previousConversationId) throw new Error(`${label}未建立新的独立会话`);
      return generated;
    };
    let timer = null;
    try {
      if (!(timeoutMs > 0)) return await perform();
      return await Promise.race([
        perform(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}后台请求超时`)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (!automationWindow.isDestroyed()) automationWindow.destroy();
    }
  }

  async runPrefixAdapterModel(modelInput) {
    return this.runPlatformAutomationModel(PREFIX_ADAPTER_APP_ID, modelInput, "联机前置词适配器", { validate: result => parsePrefixAdapterSuggestion(result.output) });
  }

  async adaptCurrentWorkPrefix() {
    if (this.conversationBusy) throw new Error("请等待会话操作完成后再适配");
    this.assertToolLoggedIn();
    if (!this.work?.suffix) throw new Error("请先选择需要适配的作品");
    if (this.room) throw new Error("请在创建或加入房间之前完成联机前置词适配");
    if (this.prefixAdapterBusy) throw new Error("联机前置词适配正在进行");
    const appId = this.currentWorkAppId();
    if (!appId) throw new Error("无法识别当前作品编号");
    if (appId === PREFIX_ADAPTER_APP_ID) throw new Error("不能对联机前置词适配器作品自身进行适配");
    this.prefixAdapterBusy = true;
    this.prefixAdapterOperation = { stage: "collecting", current: 0, total: 0, error: null };
    this.emit({ prefixAdapterStarted: true });
    try {
      const samples = await this.collectPrefixAdapterSamples(appId);
      const request = formatPrefixAdapterRequest({
        title: String(this.work.title || "未命名作品"),
        suffix: String(this.work.suffix || "")
      }, samples);
      this.prefixAdapterOperation = { stage: "generating", current: samples.length, total: samples.length, error: null };
      this.emit({ prefixAdapterGenerating: true });
      this.appendSessionLog("prefix-adapter", {
        event: "request-sent",
        appId,
        sampleCount: samples.length,
        content: request
      });
      const generated = await this.runPrefixAdapterModel(request);
      this.appendSessionLog("prefix-adapter", {
        event: "response-received",
        appId,
        model: String(generated?.model || ""),
        conversationId: String(generated?.conversationId || "") || null,
        points: generated?.points || null,
        content: String(generated?.output || "")
      });
      const parsed = parsePrefixAdapterSuggestion(generated?.output);
      const record = {
        schema: PREFIX_ADAPTER_SCHEMA,
        appId,
        title: String(this.work.title || "未命名作品"),
        fragment: parsed.fragment,
        rosterRule: parsed.rosterRule,
        statusRule: parsed.statusRule,
        detectedStatusBar: parsed.detectedStatusBar,
        warnings: parsed.warnings,
        generatedAt: Date.now(),
        sampleCount: samples.length,
        sourceConversationIds: samples.map(sample => sample.conversation_id),
        adapterConversationId: String(generated?.conversationId || ""),
        model: String(generated?.model || ""),
        points: generated?.points || { input: 0, output: 0, total: 0 }
      };
      const latest = loadPrefixAdapters();
      latest.adapters[appId] = record;
      writePrefixAdapters(latest);
      this.prefixAdapters = latest;
      this.prefixAdapterOperation = { stage: "ready", current: samples.length, total: samples.length, error: null };
      this.appendSessionLog("prefix-adapter", { event: "saved", ...record, fragment: `[${record.fragment.length} characters]`, rosterRule: `[${record.rosterRule.length} characters]`, statusRule: `[${record.statusRule.length} characters]` });
      this.emit({ prefixAdapterReady: true });
      return {
        appId,
        generatedAt: record.generatedAt,
        sampleCount: record.sampleCount,
        detectedStatusBar: record.detectedStatusBar,
        warnings: record.warnings,
        model: record.model,
        points: record.points
      };
    } catch (error) {
      this.prefixAdapterOperation = {
        ...(this.prefixAdapterOperation || {}),
        stage: "error",
        error: error?.message || String(error)
      };
      this.appendSessionLog("prefix-adapter", { event: "failed", appId, error: this.prefixAdapterOperation.error });
      this.emit({ prefixAdapterError: this.prefixAdapterOperation.error });
      throw error;
    } finally {
      this.prefixAdapterBusy = false;
      this.emit();
    }
  }

  async readPlatformConversationConfig(appId, conversationId) {
    const query = new URLSearchParams({ app_id: String(appId), conversation_id: String(conversationId) });
    const payload = await this.platformGoApi(`/apps/config?${query.toString()}`, { timeout: 15000 });
    const config = this.normalizeModelPayload(payload);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("平台没有返回可读取的会话配置");
    return config;
  }

  platformMessageRecords(payload) {
    const arrays = [];
    const queue = [{ value: payload, depth: 0 }];
    const visited = new Set();
    while (queue.length && visited.size < 160) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object" || visited.has(value)) continue;
      visited.add(value);
      if (Array.isArray(value)) {
        arrays.push(value);
        continue;
      }
      if (depth < 6) for (const child of Object.values(value)) queue.push({ value: child, depth: depth + 1 });
    }
    const score = records => records.reduce((total, record) => total + (
      record && typeof record === "object" && (record.id || record.message_id) &&
      (Object.prototype.hasOwnProperty.call(record, "query") || Object.prototype.hasOwnProperty.call(record, "answer")) ? 1 : 0
    ), 0);
    return arrays.sort((left, right) => score(right) - score(left) || right.length - left.length)[0] || [];
  }

  async ensureHostConversationForPromptConfig({ allowLobby = false } = {}) {
    if ((!this.room && !allowLobby) || (this.room && this.room.role !== "host")) throw new Error("只有房主可以准备多人会话配置");
    const existingId = String(this.room?.save?.conversationId || this.conversation.activeId || "").trim();
    if (existingId) return { conversationId: existingId, created: false, marker: null };
    if (!this.work?.suffix) throw new Error("房主尚未选择游玩作品");

    const appId = parseInviteWork(this.work.suffix, this.origin).id;
    const gameUrl = this.workGameUrl();
    const marker = `【多人会话配置初始化:${crypto.randomUUID()}】`;
    const knownIds = new Set((this.conversation.items || []).map(item => String(item?.id || "")).filter(Boolean));
    this.keepGameSurfaceResident();
    await this.gameNetworkCaptureReady.catch(() => false);
    if (!this.isSameWorkPage(this.gameSurface.webContents.getURL(), gameUrl)) {
      await this.loadSurfaceUrl(this.gameSurface, gameUrl, "作品对话页面", 20000);
    }
    await this.clearGameIsolation();
    this.appendSessionLog("multiplayer-prompt", { event: "conversation-bootstrap-started", appId });

    let outcome;
    try {
      outcome = await this.gameSurface.webContents.executeJavaScript(`(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const marker = ${JSON.stringify(marker)};
        const installedAppId = ${JSON.stringify(appId)};
        const validId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
        const readConversationId = (allowEarly = true) => {
          try {
            const map = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
            const stored = map?.[installedAppId];
            const value = typeof stored === 'string' ? stored : stored?.conversationId || stored?.conversation_id || stored?.id || null;
            if (validId(value)) return String(value);
          } catch {}
          const early = allowEarly ? window.__fympEarlyNetwork?.conversationId : null;
          return validId(early) ? String(early) : null;
        };
        const stopSelector = 'div.absolute.bottom-2.right-2 > div[role="presentation"].bg-black.cursor-pointer';
        const findStop = () => [...document.querySelectorAll(stopSelector)].find(element =>
          !element.id && element.querySelector('svg') && !element.querySelector('input,textarea')
        ) || null;
        for (let attempt = 0; attempt < 120 && !document.querySelector('#ai-chat-input'); attempt += 1) await sleep(100);
        const input = document.querySelector('#ai-chat-input');
        const send = document.querySelector('#ai-send-button');
        if (!input || !send) throw new Error('常驻作品页没有出现平台输入栈');
        if (findStop()) throw new Error('作品页已有模型输出正在进行，无法安全初始化会话配置');
        const beforeAnswers = document.querySelectorAll('#ai-chat-answer').length;
        const beforeQuestions = document.querySelectorAll('#customized-question-content').length;
        const selectedConversationId = readConversationId(false);
        if (selectedConversationId) return { conversationId: selectedConversationId, reused: true };
        if (beforeAnswers || beforeQuestions) throw new Error('作品页已有内容但无法确认会话编号，请刷新会话后重试');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, marker);
        input.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:marker }));
        input.dispatchEvent(new Event('change', { bubbles:true }));
        await sleep(160);
        if (input.value !== marker) throw new Error('平台输入框没有保留会话初始化标记');
        const readySend = document.querySelector('#ai-send-button');
        if (!readySend || readySend.disabled || readySend.getAttribute('aria-disabled') === 'true') throw new Error('平台发送按钮尚未就绪');
        HTMLElement.prototype.click.call(readySend);

        let stopClicked = false;
        let answerCreated = false;
        let questionCreated = false;
        const sendDeadline = Date.now() + 8000;
        while (Date.now() < sendDeadline) {
          questionCreated = document.querySelectorAll('#customized-question-content').length > beforeQuestions;
          answerCreated = document.querySelectorAll('#ai-chat-answer').length > beforeAnswers;
          const stop = findStop();
          if (stop) {
            HTMLElement.prototype.click.call(stop);
            stopClicked = true;
            break;
          }
          if (answerCreated && readConversationId()) break;
          await sleep(5);
        }
        if (!stopClicked && !answerCreated && !questionCreated) throw new Error('平台发送按钮没有建立初始化消息');
        if (stopClicked) {
          let settled = false;
          for (let attempt = 0; attempt < 500; attempt += 1) {
            const remaining = findStop();
            if (!remaining && document.querySelector('#ai-send-button')) { settled = true; break; }
            if (remaining && [120, 300].includes(attempt)) HTMLElement.prototype.click.call(remaining);
            await sleep(10);
          }
          if (!settled) throw new Error('平台初始化输出没有正常终止');
        }
        let conversationId = readConversationId();
        const idDeadline = Date.now() + 6000;
        while (!conversationId && Date.now() < idDeadline) {
          conversationId = readConversationId();
          await sleep(40);
        }
        return {
          marker,
          conversationId,
          stopClicked,
          answerCreated: document.querySelectorAll('#ai-chat-answer').length > beforeAnswers,
          questionCreated: document.querySelectorAll('#customized-question-content').length > beforeQuestions
        };
      })()`, true);
    } catch (error) {
      this.appendSessionLog("multiplayer-prompt", { event: "conversation-bootstrap-page-failed", appId, error: error?.message || String(error) });
      throw error;
    }

    let refreshed = null;
    let conversationId = String(outcome?.conversationId || "").trim();
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      refreshed = await this.refreshConversations({ bindHost: true, keepSessionKey: true }).catch(() => null);
      if (!conversationId) {
        conversationId = String(refreshed?.activeId || (refreshed?.items || []).find(item => item.id && !knownIds.has(String(item.id)))?.id || "").trim();
      }
      if (conversationId) break;
      await new Promise(resolve => setTimeout(resolve, attempt * 180));
    }
    if (!conversationId) throw new Error("平台已终止初始化输出，但没有返回新会话编号");

    if (String(refreshed?.activeId || "") !== conversationId) await this.setPlatformConversationId(conversationId);
    const sessionKey = this.room?.save?.key || this.conversation.sessionKey || crypto.randomUUID();
    const activeName = refreshed?.items?.find(item => String(item.id) === conversationId)?.name || this.conversation.activeName || "新的对话";
    this.conversation = {
      ...this.conversation,
      items: [
        { id: conversationId, name: activeName, active: true },
        ...(this.conversation.items || []).filter(item => item.id && String(item.id) !== conversationId).map(item => ({ ...item, active: false }))
      ],
      activeId: conversationId,
      activeName,
      sessionKey,
      anchorRole: "host",
      anchored: true,
      hasChat: true,
      source: "platform-bootstrap",
      updatedAt: Date.now()
    };
    if (this.room) this.room.save = { ...(this.room.save || {}), key: sessionKey, conversationId, name: activeName };
    this.persistSaveAnchor({ sessionKey, conversationId, name: activeName, role: "host" });
    this.appendSessionLog("multiplayer-prompt", {
      event: "conversation-bootstrap-ready",
      appId,
      conversationId,
      stopped: Boolean(outcome?.stopClicked)
    });
    return { conversationId, created: !outcome?.reused, marker: outcome?.reused ? null : marker };
  }

  async removeHostPromptBootstrapTurn(appId, conversationId, marker) {
    if (!marker) return false;
    let messageId = null;
    let foundMarker = false;
    let matchedBySingleRecordFallback = false;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const payload = await this.platformChatApi(
        `/installed-apps/${encodeURIComponent(appId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=12&page=1&paging_query_sort=desc`,
        { timeout: 5000 }
      );
      const records = this.platformMessageRecords(payload);
      const candidates = records.filter(item => String(item?.id || item?.message_id || "").trim() && typeof item?.query === "string");
      // User-side regex scripts may transform the marker before persistence.
      // This is a freshly created, previously empty conversation, so its sole
      // persisted question is still unambiguously the bootstrap turn.
      const exact = candidates.find(item => String(item.query || "") === marker) || null;
      const record = exact || (candidates.length === 1 ? candidates[0] : null);
      if (record) {
        foundMarker = true;
        matchedBySingleRecordFallback = !exact;
        messageId = String(record.id || record.message_id || "").trim();
        if (messageId) break;
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 120));
    }
    if (!foundMarker) {
      this.appendSessionLog("multiplayer-prompt", { event: "conversation-bootstrap-already-clean", appId, conversationId });
      return false;
    }
    if (!messageId) throw new Error("平台初始化记录缺少可删除的消息编号");
    await this.platformChatApi(
      `/installed-apps/${encodeURIComponent(appId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE", timeout: 10000 }
    );
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const payload = await this.platformChatApi(
        `/installed-apps/${encodeURIComponent(appId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=12&page=1&paging_query_sort=desc`,
        { timeout: 5000 }
      );
      const remains = this.platformMessageRecords(payload).some(item =>
        String(item?.id || item?.message_id || "") === messageId || String(item?.query || "") === marker
      );
      if (!remains) {
        this.appendSessionLog("multiplayer-prompt", {
          event: "conversation-bootstrap-removed",
          appId,
          conversationId,
          messageId,
          matchedBySingleRecordFallback
        });
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 120));
    }
    throw new Error("平台没有删除多人会话初始化记录");
  }

  async syncHostMultiplayerConversationConfig(maxAttempts = 4) {
    if (!this.room || this.room.role !== "host") throw new Error("只有房主可以写入多人会话配置");
    if (!this.work?.suffix) throw new Error("房主尚未选择游玩作品");

    const preparedConversation = await this.ensureHostConversationForPromptConfig();
    const conversationId = preparedConversation.conversationId;

    const appId = parseInviteWork(this.work.suffix, this.origin).id;
    const members = Array.isArray(this.room.members) ? this.room.members : [];
    const prefixAdapter = this.currentPrefixAdapter();
    this.room.promptSync = { status: "syncing", updatedAt: null, memberCount: members.length, error: null };
    this.emit({ multiplayerPromptSyncing: true });

    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, Number(maxAttempts) || 1); attempt += 1) {
      try {
        const currentConfig = await this.readPlatformConversationConfig(appId, conversationId);
        const fields = resolveConversationPromptFields(currentConfig);
        const nextMainPrompt = upsertMultiplayerProfiles(fields.mainPrompt, members);
        const perspective = this.pluginSettings.plugins[PERSPECTIVE_PLUGIN_ID];
        const composePrefix = source => upsertPerspectivePrefix(upsertMultiplayerPrefix(
          upsertPerspectivePrefix(source, false), members, prefixAdapter
        ), perspective.enabled, perspective.settings);
        const nextPrefixPrompt = composePrefix(fields.prefixPrompt);
        if (perspective.enabled) this.rememberPerspectiveTarget(appId, conversationId);
        const changed = nextMainPrompt !== fields.mainPrompt || nextPrefixPrompt !== fields.prefixPrompt || currentConfig.is_global !== false;

        if (changed) {
          const patch = buildConversationPromptPatch(fields, nextMainPrompt, nextPrefixPrompt);
          await this.platformGoApi("/apps/config", {
            method: "POST",
            body: { app_id: appId, conversation_id: conversationId, is_global: false, ...patch },
            timeout: 15000
          });
        }

        const verifiedConfig = await this.readPlatformConversationConfig(appId, conversationId);
        const verifiedFields = resolveConversationPromptFields(verifiedConfig);
        const verifiedMainPrompt = getPathValue(verifiedConfig, verifiedFields.mainPath);
        const verifiedPrefixPrompt = getPathValue(verifiedConfig, verifiedFields.prefixPath);
        const mainVerified = upsertMultiplayerProfiles(verifiedMainPrompt, members) === verifiedMainPrompt;
        const prefixVerified = composePrefix(verifiedPrefixPrompt) === verifiedPrefixPrompt;
        const sessionVerified = !Object.prototype.hasOwnProperty.call(verifiedConfig, "is_global") || verifiedConfig.is_global === false;
        if (!mainVerified || !prefixVerified || !sessionVerified) throw new Error("平台未保存完整的多人会话配置");

        if (preparedConversation.created) {
          await this.removeHostPromptBootstrapTurn(appId, conversationId, preparedConversation.marker);
          const afterCleanupConfig = await this.readPlatformConversationConfig(appId, conversationId);
          const afterCleanupFields = resolveConversationPromptFields(afterCleanupConfig);
          const cleanupMain = getPathValue(afterCleanupConfig, afterCleanupFields.mainPath);
          const cleanupPrefix = getPathValue(afterCleanupConfig, afterCleanupFields.prefixPath);
          if (upsertMultiplayerProfiles(cleanupMain, members) !== cleanupMain || composePrefix(cleanupPrefix) !== cleanupPrefix) {
            throw new Error("删除初始化记录后平台没有保留多人会话配置");
          }
        }

        this.room.promptSync = { status: "ready", updatedAt: Date.now(), memberCount: members.length, error: null };
        this.appendSessionLog("multiplayer-prompt", {
          event: changed ? "conversation-config-saved" : "conversation-config-current",
          appId,
          conversationId,
          memberCount: members.length,
          memberNames: members.map(member => String(member.displayName || member.platformName || "未命名玩家")),
          prefixAdapter: prefixAdapter ? { schema: prefixAdapter.schema, generatedAt: prefixAdapter.generatedAt, sampleCount: prefixAdapter.sampleCount } : null,
          mainField: verifiedFields.mainPath.join("."),
          prefixField: verifiedFields.prefixPath.join("."),
          attempt
        });

        // The platform keeps a copy of the active configuration in the work
        // document. Reload only after an actual update so the very next model
        // request observes the newly saved session prompt and prefix.
        if ((changed || preparedConversation.created) && this.workGameUrl()) {
          await this.loadSurfaceUrl(this.gameSurface, this.workGameUrl(), "作品对话页面", 20000);
          await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
          await this.refreshConversations({ bindHost: true, keepSessionKey: true });
          await this.applyGameIsolation(false);
        }
        this.emit({ multiplayerPromptReady: true });
        return { changed, appId, conversationId, memberCount: members.length };
      } catch (error) {
        lastError = error;
        this.appendSessionLog("multiplayer-prompt", {
          event: "conversation-config-retry",
          appId,
          conversationId,
          attempt,
          maxAttempts,
          error: error?.message || String(error)
        });
        if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }

    const message = lastError?.message || String(lastError || "未知错误");
    this.room.promptSync = { status: "error", updatedAt: Date.now(), memberCount: members.length, error: message };
    this.emit({ multiplayerPromptError: message });
    throw new Error(`多人会话配置写入失败：${message}`);
  }

  modelFamily(value = {}) {
    const text = `${value.provider || value.provider_name || ""} ${value.model || value.model_id || ""} ${value.label || value.model_label || ""}`.toLowerCase();
    if (/gemini|google/.test(text)) return "gemini";
    if (/claude|anthropic/.test(text)) return "claude";
    if (/deepseek/.test(text)) return "deepseek";
    if (/openai|chatgpt|(^|[^a-z])gpt|(^|[^a-z])o[134](?:[^a-z]|$)/.test(text)) return "gpt";
    if (/grok|xai/.test(text)) return "grok";
    if (/kimi|moonshot/.test(text)) return "kimi";
    if (/qwen|tongyi|通义|千问/.test(text)) return "qwen";
    return "other";
  }

  modelPublicValue(item) {
    if (!item) return null;
    return {
      provider: String(item.provider || ""),
      model: String(item.model || ""),
      label: String(item.label || item.model || "未知模型"),
      providerLabel: String(item.providerLabel || item.provider || ""),
      family: String(item.family || this.modelFamily(item)),
      priceCoefficient: item.priceCoefficient ?? null,
      successRate: item.successRate ?? null,
      averageLatency: item.averageLatency ?? null
    };
  }

  async refreshPlatformModels({ ensureValid = false, broadcast = false } = {}) {
    if (!this.loggedIn || !this.work?.suffix) return this.platformModels;
    this.platformModels.loading = true;
    this.platformModels.error = null;
    this.emit();
    try {
      const appId = parseInviteWork(this.work.suffix, this.origin).id;
      const [listPayload, configPayload] = await Promise.all([
        this.platformGoApi("/workspaces/model-list", { timeout: 15000 }),
        this.platformGoApi(`/apps/config?app_id=${encodeURIComponent(appId)}`, { timeout: 15000 })
      ]);
      const listData = this.normalizeModelPayload(listPayload);
      const config = this.normalizeModelPayload(configPayload);
      const providers = Array.isArray(listData?.providers) ? listData.providers : [];
      const providerLabels = new Map(providers.map(provider => [
        String(provider?.provider_name ?? provider?.provider ?? provider?.name ?? ""),
        String(provider?.label?.zh_Hans ?? provider?.label?.zh_CN ?? provider?.label ?? provider?.provider_name ?? provider?.provider ?? "")
      ]));
      const records = Array.isArray(listData?.models) ? listData.models : Array.isArray(listData) ? listData : [];
      const unique = new Map();
      for (const record of records) {
        const provider = String(record?.provider_name ?? record?.provider ?? "").trim();
        const model = String(record?.model_id ?? record?.model ?? record?.name ?? "").trim();
        if (!provider || !model) continue;
        const key = `${provider}\0${model}`;
        if (unique.has(key)) continue;
        const rawLabel = record?.model_label ?? record?.label ?? model;
        const label = typeof rawLabel === "object"
          ? String(rawLabel.zh_Hans ?? rawLabel.zh_CN ?? rawLabel.en_US ?? Object.values(rawLabel)[0] ?? model)
          : String(rawLabel || model);
        const successValue = modelMetric(record?.success_rate ?? record?.successRate, { percent: true });
        const latencyValue = modelMetric(record?.average_latency ?? record?.averageLatency);
        const rawPrice = record?.model_price ?? record?.modelPrice ?? null;
        const priceCoefficient = rawPrice == null || String(rawPrice).trim() === "" ? null : String(rawPrice).trim();
        unique.set(key, {
          provider,
          model,
          label,
          providerLabel: providerLabels.get(provider) || provider,
          family: this.modelFamily({ provider, model, label }),
          priceCoefficient,
          successRate: successValue,
          averageLatency: latencyValue,
          raw: record
        });
      }
      const items = [...unique.values()];
      const selectedProvider = String(config?.model?.provider || "");
      const selectedModel = String(config?.model?.name || config?.model?.model || "");
      let selected = items.find(item => item.provider === selectedProvider && item.model === selectedModel) || null;
      this.platformModels = {
        ...this.platformModels,
        items,
        selected: selected ? this.modelPublicValue(selected) : selectedProvider && selectedModel ? {
          provider: selectedProvider,
          model: selectedModel,
          label: selectedModel,
          providerLabel: selectedProvider
        } : null,
        loading: false,
        error: null,
        updatedAt: Date.now(),
        config
      };
      if (ensureValid && this.room?.role === "guest") {
        await this.enforceGuestPlatformModel();
      } else if (ensureValid && items.length && !selected) {
        selected = items[0];
        await this.setPlatformModel({ provider: selected.provider, model: selected.model }, { broadcast: false, internal: true });
      }
      if (broadcast && this.room?.role === "host" && this.platformModels.selected) {
        this.room.model = this.modelPublicValue(this.platformModels.selected);
        await this.broadcastRoomPacket("model-sync", { model: this.room.model });
      }
      this.emit({ modelsRefreshed: true });
      return this.platformModels;
    } catch (error) {
      this.platformModels.loading = false;
      this.platformModels.error = error?.message || String(error);
      this.platformModels.updatedAt = Date.now();
      this.appendSessionLog("model", { event: "list-read-failed", error: this.platformModels.error });
      this.emit({ modelError: this.platformModels.error });
      return this.platformModels;
    }
  }

  async preparePlatformModels(maxAttempts = 4) {
    let result = this.platformModels;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      result = await this.refreshPlatformModels({ ensureValid: false });
      if (result.items?.length) return result;
      this.appendSessionLog("model", {
        event: "background-list-retry",
        attempt,
        maxAttempts,
        error: result.error || null
      });
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
    return result;
  }

  async setPlatformModel(value = {}, { broadcast = true, internal = false } = {}) {
    if (!internal && this.autoModelJobs?.size) throw new Error("模型请求进行中，请先取消或等待完成");
    if (!this.loggedIn || !this.work?.suffix) throw new Error("请先登录并选择作品");
    if (!internal && this.room?.role === "guest") throw new Error("只有房主可以更改房间展示的模型");
    if (!internal && this.room?.round && ["processing-input", "generating", "processing-output", "syncing"].includes(this.room.round.status)) throw new Error("本轮处理、生成或同步期间不能更换模型");
    const provider = String(value.provider || "");
    const model = String(value.model || "");
    const found = this.platformModels.items.find(item => item.provider === provider && item.model === model);
    if (!found) throw new Error("所选模型已不在平台当前模型列表中");
    if (this.platformModels.selected?.provider === provider && this.platformModels.selected?.model === model) return this.platformModels.selected;
    this.platformModels.changing = true;
    this.platformModels.error = null;
    this.emit();
    try {
      const appId = parseInviteWork(this.work.suffix, this.origin).id;
      const currentConfig = this.platformModels.config || {};
      const nextModel = {
        ...(currentConfig.model || {}),
        provider,
        name: model,
        completion_params: {
          ...(currentConfig.model?.completion_params || {}),
          temperature: .7
        }
      };
      await this.platformGoApi("/apps/config", {
        method: "POST",
        body: { app_id: appId, model: nextModel },
        timeout: 15000
      });
      this.platformModels.config = { ...currentConfig, app_id: appId, model: nextModel };
      this.platformModels.selected = this.modelPublicValue(found);
      this.platformModels.updatedAt = Date.now();
      if (this.room?.role === "host") this.room.model = this.modelPublicValue(found);
      this.appendSessionLog("model", { event: internal ? "invalid-model-auto-replaced" : "host-model-changed", model: this.platformModels.selected });
      this.emit({ modelSaved: true });
      // Saving through the same API is immediate. Reload the permanent hidden
      // document so its next send also uses the new model, then restore the
      // conversation list without requiring the 对话界面 button.
      if (this.workGameUrl()) {
        await this.loadSurfaceUrl(this.gameSurface, this.workGameUrl(), "作品对话页面", 20000);
        await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
        await this.refreshConversations({
          bindHost: !this.room || this.room.role === "host",
          keepSessionKey: Boolean(this.conversation.sessionKey)
        });
        await this.applyGameIsolation(false);
      }
      if (broadcast && this.room?.role === "host") {
        await this.broadcastRoomPacket("model-sync", { model: this.room.model });
      }
      this.emit({ modelChanged: true });
      return this.platformModels.selected;
    } catch (error) {
      this.platformModels.error = error?.message || String(error);
      throw error;
    } finally {
      this.platformModels.changing = false;
      this.emit();
    }
  }

  async enforceGuestPlatformModel() {
    if (this.room?.role !== "guest") return this.platformModels.selected;
    if (this.guestModelEnforcement) return this.guestModelEnforcement;
    const task = this.applyGuestPlatformModel();
    this.guestModelEnforcement = task;
    try { return await task; }
    finally { if (this.guestModelEnforcement === task) this.guestModelEnforcement = null; }
  }

  async applyGuestPlatformModel() {
    const room = this.room;
    const appId = parseInviteWork(this.work.suffix, this.origin).id;
    const activeId = this.conversation.activeId || null;
    const sessionKey = this.conversation.sessionKey;
    const conversationId = /^[0-9a-f-]{36}$/i.test(activeId || "") ? activeId : null;
    const target = selectGuestModel(this.platformModels.items);
    const assertTarget = () => {
      if (!this.loggedIn || this.room !== room || this.room?.role !== "guest"
        || parseInviteWork(this.work.suffix, this.origin).id !== appId
        || (this.conversation.activeId || null) !== activeId || this.conversation.sessionKey !== sessionKey) {
        throw new Error("访客房间或会话已变化，已取消模型切换");
      }
    };
    this.platformModels.changing = true;
    this.emit();
    try {
      // Blank conversations inherit the app model; saved ones can override it.
      // Only patch models, leaving prompts, memory and global flags unchanged.
      const scopes = [null, ...(conversationId ? [conversationId] : [])];
      for (const scope of scopes) {
        assertTarget();
        const read = async () => scope
          ? this.readPlatformConversationConfig(appId, scope)
          : this.normalizeModelPayload(await this.platformGoApi(`/apps/config?app_id=${encodeURIComponent(appId)}`, { timeout: 15000 }));
        let config = await read();
        assertTarget();
        if (!matchesConfiguredModel(config, target)) {
          const nextModel = { ...(config?.model || {}), provider: target.provider, name: target.model };
          if (Object.prototype.hasOwnProperty.call(nextModel, "model")) nextModel.model = target.model;
          // A failed response can still mean the server accepted the write.
          // Keep a pending reload until a retry verifies the persisted config.
          this.guestModelReloadPending = true;
          await this.platformGoApi("/apps/config", {
            method: "POST",
            body: { app_id: appId, ...(scope ? { conversation_id: scope } : {}), model: nextModel },
            timeout: 15000
          });
          config = await read();
          assertTarget();
          if (!matchesConfiguredModel(config, target)) throw new Error(`平台未保存访客${scope ? "会话" : "作品"}的实测模型`);
        }
        if (!scope) this.platformModels.config = config;
      }
      if (this.guestModelReloadPending && this.workGameUrl()) {
        assertTarget();
        await this.loadSurfaceUrl(this.gameSurface, this.workGameUrl(), "作品对话页面", 20000);
        await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
        assertTarget();
        await this.applyGameIsolation(false);
        this.guestModelReloadPending = false;
      }
      assertTarget();
      this.platformModels.selected = this.modelPublicValue(target);
      this.platformModels.updatedAt = Date.now();
      this.platformModels.error = null;
      this.appendSessionLog("model", { event: "guest-tested-model-verified", model: this.platformModels.selected, conversationId });
      return this.platformModels.selected;
    } finally {
      this.platformModels.changing = false;
      this.emit();
    }
  }

  async ensureValidPlatformModelWithRetries(maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const models = await this.refreshPlatformModels({ ensureValid: true });
      const selected = models.selected;
      let valid = !models.error && selected && models.items.some(item => item.provider === selected.provider && item.model === selected.model);
      if (valid && this.room?.role === "guest") {
        try {
          const target = selectGuestModel(models.items);
          valid = selected.provider === target.provider && selected.model === target.model;
        } catch { valid = false; }
      }
      if (valid) return selected;
      lastError = new Error(models.error || "平台没有返回可用模型");
      this.appendSessionLog("model", { event: "valid-model-retry", attempt, maxAttempts, error: lastError.message });
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, attempt * 700));
    }
    throw new Error(`无法确认访客实测模型，已停止发送：${lastError?.message || "未知错误"}`);
  }

  async listPrivateChats() {
    const payload = await this.platformChatApi("/chats?page=1&limit=500");
    return Array.isArray(payload?.chats) ? payload.chats : Array.isArray(payload?.data?.chats) ? payload.data.chats : [];
  }

  async sendRoomPacket(chatId, packet) {
    const wire = encodePacket(packet);
    this.appendSessionLog("protocol-send", { phase: "sending", chatId: String(chatId), packet, wire });
    try {
      const result = await this.platformChatApi("/chats/messages", { method: "POST", body: { chat_id: chatId, content: wire } });
      if (result?.result && result.result !== "success") throw new Error(result.error || "平台拒绝了联机认证消息");
      this.appendSessionLog("protocol-send", { phase: "sent", chatId: String(chatId), packetId: packet.id, type: packet.type, platformResult: result || null });
    } catch (error) {
      this.appendSessionLog("protocol-send-error", { chatId: String(chatId), packet, wire, error: error?.message || String(error) });
      throw error;
    }
  }

  async sendRoomPacketWithRetries(chatId, packet, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, Number(maxAttempts) || 1); attempt += 1) {
      try {
        await this.sendRoomPacket(chatId, packet);
        return true;
      } catch (error) {
        lastError = error;
        this.appendSessionLog("protocol-send-retry", {
          packetId: packet.id,
          type: packet.type,
          chatId: String(chatId),
          attempt,
          maxAttempts,
          error: error?.message || String(error)
        });
        if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, attempt * 450));
      }
    }
    throw lastError || new Error("联机消息发送失败");
  }

  async sendLargeRoomPacket(chatId, type, roomId, payload) {
    const limits = this.largePacketLimits();
    const transferId = crypto.randomUUID();
    const json = JSON.stringify(payload);
    const uncompressedBytes = Buffer.byteLength(json, "utf8");
    if (uncompressedBytes > limits.maxUncompressedBytes) throw new Error("联机数据超过 8 MiB 安全上限");
    const compressed = zlib.gzipSync(Buffer.from(json, "utf8")).toString("base64url");
    const chunkSize = limits.chunkSize;
    const total = Math.ceil(compressed.length / chunkSize) || 1;
    if (total > limits.maxChunks) throw new Error("压缩后的联机数据超过 256 个分片安全上限");
    this.appendSessionLog("protocol-large-send", {
      phase: "splitting", chatId: String(chatId), transferId, type, roomId, total, compressedLength: compressed.length, payload
    });
    for (let index = 0; index < total; index += 1) {
      const data = compressed.slice(index * chunkSize, (index + 1) * chunkSize);
      await this.sendRoomPacket(chatId, makePacket("chunk", roomId, this.account.accountId || this.profileId, ++this.seq, {
        transferId, kind: type, index, total, data
      }));
    }
    this.appendSessionLog("protocol-large-send", { phase: "sent", chatId: String(chatId), transferId, type, roomId, total });
    return transferId;
  }

  async handleChunkPacket(packet, chatId) {
    const limits = this.largePacketLimits();
    const chunk = packet.payload || {};
    const total = Number(chunk.total);
    const index = Number(chunk.index);
    if (typeof chunk.transferId !== "string" || chunk.transferId.length < 1 || chunk.transferId.length > 100
      || typeof chunk.kind !== "string" || chunk.kind.length < 1 || chunk.kind.length > 80
      || !Number.isInteger(total) || total < 1 || total > limits.maxChunks
      || !Number.isInteger(index) || index < 0 || index >= total
      || typeof chunk.data !== "string" || chunk.data.length > limits.chunkSize || !/^[A-Za-z0-9_-]*$/.test(chunk.data)) {
      this.appendSessionLog("protocol-chunk-error", { chatId: String(chatId), error: "分片字段无效", packet });
      return;
    }
    const key = `${chatId}:${chunk.transferId}`;
    if (!this.incomingTransfers.has(key) && this.incomingTransfers.size >= limits.maxConcurrentTransfers) {
      const oldest = [...this.incomingTransfers.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0]?.[0];
      if (oldest) this.incomingTransfers.delete(oldest);
    }
    const transfer = this.incomingTransfers.get(key) || { kind: chunk.kind, total, parts: Array(total), encodedLength: 0, from: packet.from, roomId: packet.roomId, createdAt: Date.now() };
    if (transfer.kind !== chunk.kind || transfer.total !== total || transfer.from !== packet.from || transfer.roomId !== packet.roomId) {
      this.appendSessionLog("protocol-chunk-error", { chatId: String(chatId), transferId: chunk.transferId, error: "同一传输的分片元数据不一致", packet });
      return;
    }
    if (typeof transfer.parts[index] !== "string") transfer.encodedLength += chunk.data.length;
    if (transfer.encodedLength > limits.maxEncodedBytes) {
      this.incomingTransfers.delete(key);
      this.appendSessionLog("protocol-chunk-error", { chatId: String(chatId), transferId: chunk.transferId, error: "分片传输超过压缩数据安全上限" });
      return;
    }
    transfer.parts[index] = chunk.data;
    this.incomingTransfers.set(key, transfer);
    this.appendSessionLog("protocol-chunk-received", {
      chatId: String(chatId), transferId: chunk.transferId, kind: chunk.kind, index, total,
      receivedIndices: transfer.parts.map((part, partIndex) => typeof part === "string" ? partIndex : null).filter(partIndex => partIndex !== null)
    });
    for (const [transferKey, item] of this.incomingTransfers) {
      if (Date.now() - item.createdAt > 5 * 60 * 1000) this.incomingTransfers.delete(transferKey);
    }
    if (transfer.parts.filter(part => typeof part === "string").length !== total) return;
    this.incomingTransfers.delete(key);
    try {
      const payload = JSON.parse(zlib.gunzipSync(Buffer.from(transfer.parts.join(""), "base64url"), {
        maxOutputLength: limits.maxUncompressedBytes
      }).toString("utf8"));
      this.appendSessionLog("protocol-large-received", { chatId: String(chatId), transferId: chunk.transferId, type: transfer.kind, total, payload });
      await this.handleRoomPacket({ ...packet, id: chunk.transferId, type: transfer.kind, payload }, chatId);
    } catch (error) {
      this.appendSessionLog("protocol-chunk-error", { chatId: String(chatId), transferId: chunk.transferId, kind: transfer.kind, error: error?.message || String(error) });
      throw error;
    }
  }

  largePacketLimits() {
    return {
      chunkSize: 7000,
      maxChunks: 256,
      maxEncodedBytes: 7000 * 256,
      maxUncompressedBytes: 8 * 1024 * 1024,
      maxConcurrentTransfers: 32
    };
  }

  async resolveInviteAuthor(inviteUrl) {
    const invite = parseInviteWork(inviteUrl, this.origin);
    const payload = await this.platformChatApi(`/installed-apps/${encodeURIComponent(invite.id)}`);
    const data = payload?.data ?? payload;
    const appDetail = data?.app ?? data?.apps ?? data;
    const accountId = String(appDetail?.created_by_account_id ?? data?.author?.id ?? "").trim();
    const username = String(appDetail?.created_by_account_name ?? data?.author?.name ?? "").trim();
    if (!accountId) throw new Error("无法从邀请链接识别房主账号，请确认链接有效");
    return {
      accountId,
      username,
      appId: String(appDetail?.id || invite.id),
      inviteUrl: invite.suffix
    };
  }

  async ensurePrivateChat(accountId, username) {
    const findChat = chats => chats.find(item => String(item?.other_account?.id || "") === String(accountId))
      || (username ? chats.find(item => String(item?.other_account?.name || "").trim().toLocaleLowerCase() === String(username).toLocaleLowerCase()) : null);
    let chat = findChat(await this.listPrivateChats());
    if (chat?.id) return chat;
    try {
      const payload = await this.platformChatApi("/chats", { method: "POST", body: { receive_id: accountId } });
      const data = payload?.data ?? payload;
      chat = data?.chat ?? data?.data?.chat ?? (data?.id ? data : null);
      if (chat?.id) return chat;
    } catch (error) {
      // 另一窗口可能恰好已创建会话；下面重新读取列表后再决定是否报错。
      chat = findChat(await this.listPrivateChats());
      if (!chat?.id) throw error;
      return chat;
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
      chat = findChat(await this.listPrivateChats());
      if (chat?.id) return chat;
    }
    throw new Error("已找到房主账号，但平台没有建立私人聊天会话");
  }

  async joinRoom({ inviteUrl, password, displayName, basicInfo, appearance, info }) {
    if (this.conversationBusy) throw new Error("请等待会话操作完成后再加入房间");
    password = String(password || "");
    const selectedProfile = this.selectedCharacterProfile();
    displayName = String(displayName || selectedProfile?.displayName || "").trim() || this.account.username || this.profileId;
    basicInfo = String(basicInfo ?? selectedProfile?.basicInfo ?? info ?? "").trim();
    appearance = String(appearance ?? selectedProfile?.appearance ?? "").trim();
    info = composeCharacterInfo(basicInfo, appearance);
    if (!this.loggedIn) throw new Error("请先登录账号");
    this.assertMultiplayerLevel();
    if (!this.account.username || !this.account.accountId) throw new Error("正在获取当前账号信息，请稍后重试");
    if (!String(inviteUrl || "").trim() || !password) throw new Error("请输入房主邀请链接和房间密码");
    if (password.length > 128) throw new Error("房间密码不能超过 128 个字符");
    if (displayName.length > 80 || basicInfo.length > 20000 || appearance.length > 10000) throw new Error("角色设定内容超过安全上限");
    if (this.room) throw new Error("当前已有房间，请先退出后再加入");

    const host = await this.resolveInviteAuthor(inviteUrl);
    if (host.accountId === String(this.account.accountId || "")) throw new Error("不能通过自己的私人作品链接加入房间");
    const chat = await this.ensurePrivateChat(host.accountId, host.username);
    const hostUsername = String(chat?.other_account?.name || host.username || "").trim();
    if (!hostUsername) throw new Error("私人聊天已经建立，但平台没有返回房主用户名，暂时无法完成密码认证");

    const profile = {
      id: this.account.accountId || this.profileId,
      platformName: this.account.username || this.profileId,
      displayName,
      basicInfo,
      appearance,
      info
    };
    this.room = {
      id: "PENDING",
      role: "guest",
      status: "joining",
      appVersion: this.appVersion,
      peerVersion: null,
      hostUsername,
      work: { title: "等待房主同步作品", suffix: "" },
      inviteAppId: host.appId,
      inviteUrl: host.inviteUrl,
      createdAt: Date.now(),
      memberCount: 1,
      rosterRevision: 0,
      passwordVerifier: derivePasswordVerifier(host.accountId, password),
      passwordVerifierV2: derivePasswordVerifierV2(host.accountId, password),
      hostChatId: String(chat.id),
      hostAccountId: host.accountId,
      profile,
      members: [profile],
      save: null,
      historySync: { status: "preparing", current: 0, total: 0, error: null },
      model: null,
      plugins: normalizePluginSettings(),
      chat: { revision: 0, messages: [], pending: null, pendingBroadcasts: [], syncStatus: "ready", error: null, lastBroadcastAt: 0, broadcastAttempts: 0, lastRecoveryRequestAt: 0, recoveryRequestAttempts: 0 },
      messageOperation: null,
      round: this.newRound(1)
    };
    this.roomPollNotBefore = 0;
    this.roomPollIdleCount = 0;
    const hello = makePacket("hello", "pending", profile.id, ++this.seq, {
      profile,
      inviteAppId: host.appId,
      appVersion: this.appVersion,
      authSchemes: ["scrypt-v2", "sha256-v1"]
    });
    try {
      await this.sendRoomPacket(this.room.hostChatId, hello);
    } catch (error) {
      this.room = null;
      throw error;
    }
    this.mode = "lobby";
    this.detachSurface();
    this.emit({ joinRequested: true });
    return this.waitForAutomaticJoin(this.room.createdAt);
  }

  async waitForAutomaticJoin(createdAt) {
    const deadline = Date.now() + 65000;
    while (Date.now() < deadline) {
      if (!this.room || this.room.role !== "guest" || this.room.createdAt !== createdAt) throw new Error("加入已取消");
      if (this.room.status === "waiting") return this.state().room;
      if (this.room.status === "join-error") throw new Error(this.room.error || "加入房间失败");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (this.room?.role === "guest" && this.room.createdAt === createdAt) {
      this.room.status = "join-error";
      this.room.error = "加入超时。请确认房主工具仍在运行，然后退出并重试。";
      this.emit({ joinError: this.room.error });
    }
    throw new Error(this.room?.error || "加入房间超时");
  }

  clearRoomSession(extra = { roomLeft: true }) {
    this.cancelAutoModels("platform");
    this.room = null;
    this.roomPollNotBefore = 0;
    this.roomPollIdleCount = 0;
    this.pendingChallenges.clear();
    this.mode = this.loggedIn ? "lobby" : "login";
    this.detachSurface();
    this.emit(extra);
  }

  async leaveRoom() {
    const room = this.room;
    if (!room) return { left: false, role: null, notifiedGuests: 0 };
    if (room.role === "host") {
      const hostId = String(this.account.accountId || this.profileId);
      const guestMembers = (room.members || []).filter(member => String(member.id) !== hostId);
      const recipients = guestMembers.map(member => ({
        memberId: String(member.id),
        chatId: String(room.memberChatIds?.[String(member.id)] || "")
      }));
      const missing = recipients.filter(recipient => !recipient.chatId);
      if (missing.length) {
        this.appendSessionLog("room-close", { event: "missing-member-chat", memberIds: missing.map(item => item.memberId) });
        throw new Error("无法取得所有访客的通知通道，房间暂未解散，请重试");
      }
      const closureId = crypto.randomUUID();
      const results = await Promise.allSettled(recipients.map(recipient => this.sendRoomPacketWithRetries(
        recipient.chatId,
        makePacket("room-closed", room.id, hostId, ++this.seq, {
          closureId,
          message: "房主已解散房间，你已退出当前房间",
          closedAt: Date.now()
        }),
        3
      )));
      const failed = results.flatMap((result, index) => result.status === "rejected" ? [recipients[index].memberId] : []);
      if (failed.length) {
        this.appendSessionLog("room-close", { event: "notice-failed", roomId: room.id, memberIds: failed });
        throw new Error("解散通知未能发送给所有访客，房间暂未解散，请重试");
      }
      this.appendSessionLog("room-close", { event: "notified", roomId: room.id, memberIds: recipients.map(item => item.memberId), closureId });
      this.clearRoomSession({ roomLeft: true, roomDissolved: { roomId: room.id, notifiedGuests: recipients.length } });
      return { left: true, role: "host", notifiedGuests: recipients.length };
    }
    this.clearRoomSession({ roomLeft: true });
    return { left: true, role: room.role, notifiedGuests: 0 };
  }

  async removeRoomMember(memberId) {
    if (!this.room || this.room.role !== "host") throw new Error("只有房主可以移出成员");
    const id = String(memberId || "");
    const hostId = String(this.account.accountId || this.profileId);
    if (!id || id === hostId) throw new Error("不能将房主移出房间");
    const member = this.room.members.find(item => String(item.id) === id);
    if (!member) throw new Error("该成员已经不在房间中");
    const round = this.room.round;
    if (this.roundBusy || round?.status !== "collecting" || Object.keys(round?.submissions || {}).length || this.messageOperationBusy || this.room.promptSync?.status === "syncing") {
      throw new Error("本轮进行中，暂时不能移出成员");
    }

    const chatId = String(this.room.memberChatIds?.[id] || "");
    this.room.removedMemberIds ||= new Set();
    this.room.removedMemberIds.add(id);
    this.room.members = this.room.members.filter(item => String(item.id) !== id);
    this.room.memberCount = this.room.members.length;
    this.room.rosterRevision = Number(this.room.rosterRevision || 0) + 1;
    delete this.room.memberChatIds?.[id];
    delete this.room.memberHistory?.[id];
    this.pendingChallenges.delete(id);
    if (round) {
      delete round.submissions?.[id];
      delete round.inputAcks?.[id];
      delete round.resultAcks?.[id];
      if (Array.isArray(round.pendingGuestIds)) round.pendingGuestIds = round.pendingGuestIds.filter(value => String(value) !== id);
    }
    if (this.room.messageOperation) {
      delete this.room.messageOperation.acks?.[id];
      if (Array.isArray(this.room.messageOperation.pendingGuestIds)) {
        this.room.messageOperation.pendingGuestIds = this.room.messageOperation.pendingGuestIds.filter(value => String(value) !== id);
      }
    }
    this.room.promptSync = { status: "pending", updatedAt: null, memberCount: this.room.members.length, error: null };

    const removedEvent = {
      id: crypto.randomUUID(),
      memberId: id,
      displayName: String(member.displayName || member.platformName || "成员"),
      revision: this.room.rosterRevision,
      at: Date.now()
    };
    if (chatId) {
      const packet = makePacket("member-removed", this.room.id, hostId, ++this.seq, {
        ...removedEvent,
        message: "你已被房主移出房间"
      });
      await this.sendRoomPacketWithRetries(chatId, packet, 3).catch(error => {
        this.appendSessionLog("room-member", { event: "removed-notice-failed", memberId: id, chatId, error: error?.message || String(error) });
      });
    }
    await this.broadcastRoomPacket("members-sync", {
      revision: this.room.rosterRevision,
      members: this.room.members,
      event: { ...removedEvent, kind: "removed" }
    });
    this.appendSessionLog("room-member", { event: "removed", member, revision: this.room.rosterRevision });
    this.emit({ memberRemoved: removedEvent });

    let promptUpdated = false;
    try {
      await this.syncHostMultiplayerConversationConfig(4);
      promptUpdated = true;
    } catch (error) {
      this.appendSessionLog("room-member", { event: "removed-prompt-sync-failed", memberId: id, error: error?.message || String(error) });
    }
    this.emit({ memberRemoved: removedEvent, memberPromptUpdated: promptUpdated });
    return { removed: true, memberId: id, promptUpdated };
  }

  async broadcastRoomPacket(type, payload, large = false) {
    if (!this.room || this.room.role !== "host") return;
    if (["round-result", "message-operation"].includes(type) && payload?.perspectiveSplit) {
      const recipients = Object.entries(this.room.memberChatIds || {});
      const results = await Promise.allSettled(recipients.map(([memberId, chatId]) =>
        this.sendLargeRoomPacket(String(chatId), type, this.room.id, personalizeResult(payload, memberId))));
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      return;
    }
    const chatIds = [...new Set(Object.values(this.room.memberChatIds || {}).map(String).filter(Boolean))];
    const results = await Promise.allSettled(chatIds.map(chatId => large
      ? this.sendLargeRoomPacket(chatId, type, this.room.id, payload)
      : this.sendRoomPacket(chatId, makePacket(type, this.room.id, this.account.accountId || this.profileId, ++this.seq, payload))));
    const failed = results.find(result => result.status === "rejected");
    if (failed && large) throw failed.reason;
  }

  normalizeRoomChatText(value) {
    const text = String(value || "").replace(/\r\n/g, "\n").trim();
    if (!text) throw new Error("请输入聊天内容");
    if (text.length > 1000) throw new Error("单条房间聊天不能超过 1000 个字符");
    return text;
  }

  normalizeRoomChatTimestamp(unixMs, isoValue) {
    const numeric = Number(unixMs);
    const isoTimestamp = Date.parse(String(isoValue || ""));
    const timestamp = Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : isoTimestamp;
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8_640_000_000_000_000) {
      throw new Error("房间聊天发送时间无效");
    }
    return { sentAt: timestamp, sentAtIso: new Date(timestamp).toISOString() };
  }

  compareRoomChatMessages(left, right) {
    return Number(left?.sentAt || 0) - Number(right?.sentAt || 0)
      || String(left?.sentAtIso || "").localeCompare(String(right?.sentAtIso || ""))
      || String(left?.id || "").localeCompare(String(right?.id || ""));
  }

  trimRoomChatHistory(chat = this.room?.chat) {
    if (!chat || !Array.isArray(chat.messages) || chat.messages.length <= 1000) return;
    const pending = new Set((chat.pendingBroadcasts || []).map(String));
    let removeCount = chat.messages.length - 1000;
    chat.messages = chat.messages.filter(message => {
      if (removeCount > 0 && !pending.has(String(message?.id || ""))) {
        removeCount -= 1;
        return false;
      }
      return true;
    });
  }

  roomChatVisibleMessages() {
    const chat = this.room?.chat || { messages: [], pending: null };
    const messages = [...(chat.messages || [])];
    const pending = chat.pending;
    const senderId = String(this.room?.profile?.id || this.account?.accountId || this.profileId || "");
    const stableClientId = String(pending?.clientMessageId || "");
    const hasCanonicalMessage = stableClientId && messages.some(message =>
      String(message.senderId || "") === senderId && String(message.clientMessageId || "") === stableClientId
    );
    if (this.room?.role === "guest" && pending && stableClientId && !hasCanonicalMessage) {
      messages.push({
        id: `local:${stableClientId}`,
        clientMessageId: stableClientId,
        revision: 0,
        sentAt: Number(pending.clientSentAt || 0),
        sentAtIso: String(pending.clientSentAtIso || ""),
        senderId,
        displayName: String(this.room.profile?.displayName || this.account?.username || "未命名玩家"),
        text: String(pending.text || ""),
        optimistic: true,
        deliveryStatus: String(pending.status || "sending")
      });
    }
    return messages
      .sort((left, right) => this.compareRoomChatMessages(left, right))
      .map(message => ({
        id: String(message.id || ""),
        clientMessageId: String(message.clientMessageId || ""),
        revision: Number(message.revision || 0),
        sentAt: Number(message.sentAt || 0),
        sentAtIso: String(message.sentAtIso || ""),
        senderId: String(message.senderId || ""),
        displayName: String(message.displayName || "未命名玩家"),
        text: String(message.text || ""),
        optimistic: Boolean(message.optimistic),
        deliveryStatus: String(message.deliveryStatus || "confirmed")
      }));
  }

  roomChatPayload() {
    const chat = this.room?.chat || { revision: 0, messages: [] };
    return {
      revision: Number(chat.revision || 0),
      messages: [...(chat.messages || [])]
        .sort((left, right) => this.compareRoomChatMessages(left, right))
        .slice(-1000)
        .map(message => ({
          id: String(message.id || ""),
          clientMessageId: String(message.clientMessageId || ""),
          revision: Number(message.revision || 0),
          sentAt: Number(message.sentAt || 0),
          sentAtIso: String(message.sentAtIso || ""),
          senderId: String(message.senderId || ""),
          displayName: String(message.displayName || "未命名玩家"),
          text: String(message.text || "")
        }))
    };
  }

  roomChatMessagePayload(message) {
    return {
      id: String(message?.id || ""),
      clientMessageId: String(message?.clientMessageId || ""),
      revision: Number(message?.revision || 0),
      sentAt: Number(message?.sentAt || 0),
      sentAtIso: String(message?.sentAtIso || ""),
      senderId: String(message?.senderId || ""),
      displayName: String(message?.displayName || "未命名玩家"),
      text: String(message?.text || "")
    };
  }

  parseRoomChatMessage(value) {
    const message = this.roomChatMessagePayload(value);
    message.displayName = message.displayName.trim() || "未命名玩家";
    message.text = message.text.replace(/\r\n/g, "\n").trim();
    try {
      const timestamp = this.normalizeRoomChatTimestamp(message.sentAt, message.sentAtIso);
      message.sentAt = timestamp.sentAt;
      message.sentAtIso = timestamp.sentAtIso;
    } catch {
      return null;
    }
    if (
      !message.id || !message.clientMessageId || !Number.isInteger(message.revision) || message.revision < 1 ||
      !message.senderId || !message.text || message.text.length > 1000
    ) return null;
    return message;
  }

  queueRoomChatBroadcast(message) {
    if (!this.room || this.room.role !== "host" || !message?.id) return;
    const chat = this.room.chat;
    chat.pendingBroadcasts ||= [];
    if (!chat.pendingBroadcasts.includes(String(message.id))) chat.pendingBroadcasts.push(String(message.id));
  }

  async broadcastRoomChatAppend(message) {
    if (!this.room || this.room.role !== "host") return false;
    const chatIds = [...new Set(Object.values(this.room.memberChatIds || {}).map(String).filter(Boolean))];
    const payload = { revision: Number(message.revision || 0), message: this.roomChatMessagePayload(message) };
    const results = await Promise.allSettled(chatIds.map(chatId => this.sendRoomPacket(chatId, makePacket(
      "room-chat-append",
      this.room.id,
      this.account.accountId || this.profileId,
      ++this.seq,
      payload
    ))));
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    return true;
  }

  async broadcastPendingRoomChatMessages() {
    if (!this.room || this.room.role !== "host") return false;
    const chat = this.room.chat;
    chat.pendingBroadcasts ||= [];
    if (this.roomChatBroadcastBusy) return false;
    this.roomChatBroadcastBusy = true;
    try {
      while (chat.pendingBroadcasts.length) {
        const messageId = String(chat.pendingBroadcasts[0]);
        const message = chat.messages.find(item => String(item.id) === messageId);
        if (!message) {
          chat.pendingBroadcasts.shift();
          continue;
        }
        chat.syncStatus = "syncing";
        chat.lastBroadcastAt = Date.now();
        this.emit({ roomChatSyncing: true });
        try {
          await this.broadcastRoomChatAppend(message);
          chat.pendingBroadcasts.shift();
          this.trimRoomChatHistory(chat);
          chat.error = null;
          chat.broadcastAttempts = 0;
          this.appendSessionLog("room-chat", { event: "append-broadcast", revision: message.revision, message });
        } catch (error) {
          chat.syncStatus = "retrying";
          chat.error = error?.message || String(error);
          chat.broadcastAttempts = Number(chat.broadcastAttempts || 0) + 1;
          this.appendSessionLog("room-chat", {
            event: "append-broadcast-failed",
            revision: message.revision,
            messageId,
            attempt: chat.broadcastAttempts,
            error: chat.error
          });
          this.emit({ roomChatRetrying: true });
          return false;
        }
      }
      chat.syncStatus = "ready";
      chat.error = null;
      this.emit({ roomChatUpdated: true });
      return true;
    } finally {
      this.roomChatBroadcastBusy = false;
    }
  }

  async requestRoomChatSnapshot(reason = "revision-gap") {
    if (!this.room || this.room.role !== "guest" || this.room.status !== "waiting") return false;
    const chat = this.room.chat;
    const now = Date.now();
    if (now - Number(chat.lastRecoveryRequestAt || 0) < 4000) return false;
    if (Number(chat.recoveryRequestAttempts || 0) >= 6) {
      chat.syncStatus = "error";
      chat.error = "房间聊天恢复失败，已自动重试 6 次";
      this.emit({ roomChatError: chat.error });
      return false;
    }
    chat.syncStatus = "recovering";
    chat.recoveryRequestAttempts = Number(chat.recoveryRequestAttempts || 0) + 1;
    chat.lastRecoveryRequestAt = now;
    chat.error = null;
    this.emit({ roomChatRecovering: true });
    try {
      await this.sendRoomPacket(this.room.hostChatId, makePacket("room-chat-sync-request", this.room.id, this.room.profile.id, ++this.seq, {
        revision: Number(chat.revision || 0),
        reason: String(reason || "revision-gap")
      }));
      this.appendSessionLog("room-chat", { event: "snapshot-requested", revision: chat.revision, attempt: chat.recoveryRequestAttempts, reason });
      return true;
    } catch (error) {
      chat.error = error?.message || String(error);
      this.appendSessionLog("room-chat", { event: "snapshot-request-failed", revision: chat.revision, attempt: chat.recoveryRequestAttempts, error: chat.error });
      this.emit({ roomChatRetrying: true });
      return false;
    }
  }

  async acceptRoomChatSubmission({ senderId, clientMessageId, text, clientSentAt, clientSentAtIso, receivedAt, chatId = null }) {
    if (!this.room || this.room.role !== "host" || this.room.status !== "waiting") throw new Error("房间聊天仅在已建立的房间内可用");
    const member = this.room.members.find(item => String(item.id) === String(senderId));
    if (!member) throw new Error("房间聊天发送者不在成员名单中");
    const expectedChatId = this.room.memberChatIds?.[String(senderId)];
    if (String(senderId) !== String(this.account.accountId) && (!expectedChatId || String(expectedChatId) !== String(chatId))) {
      throw new Error("房间聊天来源与已认证成员不一致");
    }
    const normalizedText = this.normalizeRoomChatText(text);
    const stableClientId = String(clientMessageId || "").trim();
    if (!stableClientId || stableClientId.length > 100) throw new Error("房间聊天消息编号无效");
    this.room.chat ||= { revision: 0, messages: [], pending: null, pendingBroadcasts: [], syncStatus: "ready", error: null, lastBroadcastAt: 0, broadcastAttempts: 0, lastRecoveryRequestAt: 0, recoveryRequestAttempts: 0 };
    const duplicate = this.room.chat.messages.find(message =>
      String(message.senderId) === String(senderId) && String(message.clientMessageId) === stableClientId
    );
    if (duplicate) {
      this.queueRoomChatBroadcast(duplicate);
      await this.broadcastPendingRoomChatMessages();
      return duplicate;
    }
    if ((this.room.chat.pendingBroadcasts || []).length >= 200) throw new Error("房间聊天待同步队列已满，请等待网络恢复");

    const rawReceivedAt = Number(receivedAt);
    const fallbackReceivedAt = Number.isFinite(rawReceivedAt) && rawReceivedAt > 0 ? rawReceivedAt : Date.now();
    const timestamp = this.normalizeRoomChatTimestamp(clientSentAt || fallbackReceivedAt, clientSentAtIso);
    const message = {
      id: crypto.randomUUID(),
      clientMessageId: stableClientId,
      revision: Number(this.room.chat.revision || 0) + 1,
      sentAt: timestamp.sentAt,
      sentAtIso: timestamp.sentAtIso,
      senderId: String(senderId),
      displayName: String(member.displayName || member.platformName || "未命名玩家"),
      text: normalizedText
    };
    this.room.chat.messages.push(message);
    this.room.chat.messages.sort((left, right) => this.compareRoomChatMessages(left, right));
    this.trimRoomChatHistory(this.room.chat);
    this.room.chat.revision = message.revision;
    this.room.chat.error = null;
    this.appendSessionLog("room-chat", { event: "host-accepted", revision: this.room.chat.revision, message });
    this.emit({ roomChatUpdated: true });
    this.queueRoomChatBroadcast(message);
    await this.broadcastPendingRoomChatMessages();
    return message;
  }

  async sendPendingRoomChat() {
    if (this.roomChatSendBusy || !this.room || this.room.role !== "guest" || !this.room.chat?.pending) return false;
    const pending = this.room.chat.pending;
    if (Number(pending.attempts || 0) >= 6) {
      pending.status = "error";
      this.room.chat.error = "房间聊天发送失败，已自动重试 6 次";
      this.emit({ roomChatError: this.room.chat.error });
      return false;
    }
    this.roomChatSendBusy = true;
    pending.attempts = Number(pending.attempts || 0) + 1;
    pending.status = pending.attempts > 1 ? "retrying" : "sending";
    pending.lastSentAt = Date.now();
    this.emit({ roomChatSending: true });
    try {
      await this.sendRoomPacket(this.room.hostChatId, makePacket("room-chat-submit", this.room.id, this.room.profile.id, ++this.seq, {
        clientMessageId: pending.clientMessageId,
        text: pending.text,
        clientSentAt: pending.clientSentAt,
        clientSentAtIso: pending.clientSentAtIso
      }));
      this.appendSessionLog("room-chat", { event: "guest-submitted", clientMessageId: pending.clientMessageId, clientSentAt: pending.clientSentAt, clientSentAtIso: pending.clientSentAtIso, attempt: pending.attempts });
      return true;
    } catch (error) {
      pending.status = "retrying";
      this.room.chat.error = error?.message || String(error);
      this.appendSessionLog("room-chat", { event: "guest-submit-failed", clientMessageId: pending.clientMessageId, attempt: pending.attempts, error: this.room.chat.error });
      this.emit({ roomChatRetrying: true });
      return false;
    } finally {
      this.roomChatSendBusy = false;
      this.emit();
    }
  }

  async sendRoomChat(value) {
    if (!this.room || this.room.status !== "waiting") throw new Error("请先创建或加入房间");
    const text = this.normalizeRoomChatText(value);
    const clientMessageId = crypto.randomUUID();
    const clientSentAt = Date.now();
    const clientSentAtIso = new Date(clientSentAt).toISOString();
    if (this.room.role === "host") {
      return this.acceptRoomChatSubmission({
        senderId: this.account.accountId || this.profileId,
        clientMessageId,
        text,
        clientSentAt,
        clientSentAtIso,
        receivedAt: Date.now()
      });
    }
    this.room.chat ||= { revision: 0, messages: [], pending: null, pendingBroadcasts: [], syncStatus: "ready", error: null, lastBroadcastAt: 0, broadcastAttempts: 0, lastRecoveryRequestAt: 0, recoveryRequestAttempts: 0 };
    if (this.room.chat.pending && this.room.chat.pending.status !== "error") throw new Error("上一条聊天仍在等待房主确认");
    this.room.chat.pending = { clientMessageId, text, clientSentAt, clientSentAtIso, attempts: 0, lastSentAt: 0, status: "sending" };
    this.room.chat.error = null;
    await this.sendPendingRoomChat();
    return { clientMessageId, pending: true };
  }

  async submitRoundInput(value) {
    if (this.pluginSettingsBusy || this.workSettings.saving) throw new Error("设置正在保存，请稍后确认输入");
    const text = String(value || "").trim();
    if (!this.room || this.room.status !== "waiting") throw new Error("尚未加入可游玩的房间");
    if (this.room.role === "guest" && this.room.historySync?.status !== "ready") throw new Error("访客会话锚点仍在准备，请等待房主确认");
    if (!text) throw new Error("请输入文本");
    if (text.length > 100000) throw new Error("单轮输入不能超过 100000 个字符");
    if (!this.room.round || this.room.round.status === "completed") {
      const previous = this.room.round?.lastResult || null;
      this.room.round = this.newRound((this.room.round?.number || 0) + 1, previous);
    }
    if (this.room.round.status === "error") throw new Error(this.room.round.error || "上一轮有成员同步失败，不能开始下一轮");
    if (this.room.round.status !== "collecting") throw new Error("房主正在生成本轮结果，请等待模型完成");
    const profile = this.room.role === "host" ? this.room.members.find(member => String(member.id) === String(this.account.accountId)) : this.room.profile;
    if (!profile?.id || !profile?.displayName) throw new Error("本局玩家设定尚未准备完成");
    const submission = { displayName: String(profile.displayName), text, submittedAt: Date.now() };
    this.room.round.submissions[String(profile.id)] = submission;
    this.room.round.error = null;
    this.emit({ roundSubmitted: true });

    if (this.room.role === "guest") {
      const payload = {
        round: this.room.round.number,
        displayName: submission.displayName,
        text: submission.text
      };
      if (submission.text.length > 3000) await this.sendLargeRoomPacket(this.room.hostChatId, "turn-submit", this.room.id, payload);
      else await this.sendRoomPacket(this.room.hostChatId, makePacket("turn-submit", this.room.id, profile.id, ++this.seq, payload));
      return this.state().room.round;
    }
    await this.broadcastRoundState();
    void this.maybeRunHostRound();
    return this.state().room.round;
  }

  async broadcastRoundState() {
    if (!this.room?.round || this.room.role !== "host") return;
    const readyNames = Object.values(this.room.round.submissions).map(item => item.displayName);
    await this.broadcastRoomPacket("turn-state", {
      round: this.room.round.number,
      status: this.room.round.status,
      pipeline: this.room.round.pipeline || null,
      readyNames,
      totalCount: this.room.members.length
    });
    this.emit();
  }

  async advanceHostRoundAfterResultAcks() {
    if (!this.room || this.room.role !== "host" || this.room.round?.status !== "syncing") return false;
    const activeRound = this.room.round;
    const pendingGuestIds = Array.isArray(activeRound.pendingGuestIds) ? activeRound.pendingGuestIds.map(String) : [];
    const allReady = pendingGuestIds.every(memberId => activeRound.resultAcks?.[memberId]?.status === "ready");
    if (!allReady) return false;
    const result = activeRound.lastResult;
    this.room.round = this.newRound(activeRound.number + 1, result);
    this.appendSessionLog("round-flow", {
      event: "all-guests-synchronized",
      completedRound: activeRound.number,
      nextRound: this.room.round.number,
      acknowledgements: activeRound.resultAcks
    });
    await this.broadcastRoundState();
    this.emit({ roundCompleted: true });
    return true;
  }

  async maybeRunHostRound() {
    if (this.roundBusy || this.pluginSettingsBusy || this.workSettings.saving || !this.room || this.room.role !== "host" || this.room.round?.status !== "collecting") return;
    const submissions = this.room.round.submissions || {};
    if (!this.room.members.every(member => submissions[String(member.id)])) return;
    this.roundBusy = true;
    this.gameAutoFollow = true;
    const activeRound = this.room.round;
    this.perspectivePresentationBlocked = Boolean(this.pluginSettings.plugins[PERSPECTIVE_PLUGIN_ID].enabled);
    if (this.perspectivePresentationBlocked) this.detachSurface();
    try {
      this.room.gameStarted = true;
      activeRound.status = "processing-input";
      this.mode = "loading-game";
      await this.broadcastRoundState();
      await this.syncHostMultiplayerConversationConfig(4);
      const originalPlayerInputs = this.room.members.map(member => ({
        设定名: String(member.displayName || member.platformName || "未命名玩家"),
        输入内容: String(submissions[String(member.id)]?.text || "")
      }));
      const playerInputs = await this.runConversationPluginStack(PLUGIN_PHASES.INPUT, originalPlayerInputs, activeRound);
      activeRound.status = "generating";
      await this.broadcastRoundState();
      const modelInput = formatMultiplayerTurnInput(playerInputs);
      activeRound.modelInput = modelInput;
      this.appendSessionLog("round-flow", {
        event: "host-model-input",
        round: activeRound.number,
        input: modelInput,
        originalPlayerInputs,
        playerInputs,
        pluginRuns: activeRound.pluginRuns
      });
      // Guests must create the matching question/blank answer while the host is
      // generating, not after the host output has already completed.
      await this.broadcastRoomPacket("round-input", {
        round: activeRound.number,
        input: modelInput,
        pluginRuns: activeRound.pluginRuns,
        sentAt: Date.now()
      }, true);
      this.appendSessionLog("round-flow", { event: "host-input-broadcast", round: activeRound.number, input: modelInput });
      // Sending and showing the live page must run concurrently.  Waiting for
      // sendModelInputAndCapture first used to hide both the submitted row and
      // the entire streaming response until generation had already finished.
      const generation = this.sendModelInputAndCapture(modelInput);
      const splitEnabled = this.pluginSettings.plugins[PERSPECTIVE_PLUGIN_ID].enabled;
      if (splitEnabled) this.detachSurface();
      const liveSurface = (splitEnabled ? Promise.resolve(false) : this.openLiveHostConversation()).catch(error => {
        this.appendSessionLog("game-surface", { event: "host-live-open-failed", round: activeRound.number, error: error?.message || String(error) });
        return false;
      });
      const generated = await generation;
      await liveSurface;
      if (splitEnabled) generated.output = await this.readAuthoritativeRoundOutput(modelInput);
      activeRound.status = "processing-output";
      await this.broadcastRoundState();
      const processedOutput = await this.runConversationPluginStack(PLUGIN_PHASES.OUTPUT, generated.output, activeRound);
      const result = {
        round: activeRound.number,
        input: modelInput,
        output: activeRound.perspectiveSplit ? activeRound.perspectiveOutputs?.[String(this.account.accountId)] || WITHHELD_OUTPUT : processedOutput,
        perspectiveSplit: Boolean(activeRound.perspectiveSplit),
        perspectiveOutputs: activeRound.perspectiveOutputs,
        model: generated.model,
        points: generated.points,
        pluginRuns: activeRound.pluginRuns,
        completedAt: Date.now()
      };
      if (result.perspectiveSplit) {
        await this.rememberPerspectiveView(generated.output, result.output);
        await this.loadSurfaceUrl(this.gameSurface, this.workGameUrl(), "独立视角对话", 20000);
        await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
      }
      this.perspectivePresentationBlocked = false;
      this.appendSessionLog("round-flow", { event: "host-model-output", round: activeRound.number, result });
      activeRound.status = "syncing";
      activeRound.lastResult = result;
      activeRound.pendingGuestIds = this.room.members
        .filter(member => String(member.id) !== String(this.account.accountId))
        .map(member => String(member.id));
      activeRound.resultAcks = {};
      await this.refreshConversations({ keepSessionKey: true });
      if (this.room.save?.key) {
        this.room.save.conversationId = this.conversation.activeId;
        this.room.save.name = this.conversation.activeName || this.room.save.name;
        this.persistSaveAnchor({ sessionKey: this.room.save.key, conversationId: this.conversation.activeId, name: this.room.save.name, role: "host" });
      }
      await this.broadcastRoomPacket("round-result", result, true);
      const gameReady = await this.applyGameIsolation(true);
      if (gameReady) await this.injectConversationPluginCards(result);
      this.mode = gameReady ? "game" : "game-empty";
      if (gameReady) await this.showCapturedGameSurface();
      else this.detachSurface();
      this.appendSessionLog("round-flow", {
        event: "host-result-broadcast",
        round: activeRound.number,
        pendingGuestIds: activeRound.pendingGuestIds,
        result
      });
      if (!(await this.advanceHostRoundAfterResultAcks())) this.emit({ roundWaitingForGuests: true });
    } catch (error) {
      activeRound.error = error?.message || String(error);
      if (this.room?.round !== activeRound) return;
      activeRound.status = "collecting";
      activeRound.submissions = {};
      await this.broadcastRoomPacket("turn-state", {
        round: activeRound.number,
        status: "collecting",
        readyNames: [],
        totalCount: this.room.members.length,
        error: activeRound.error
      });
      this.emit({ roundError: activeRound.error });
    } finally {
      this.roundBusy = false;
    }
  }

  async openLiveHostConversation() {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && this.room?.role === "host" && this.room.round?.status === "generating") {
      const ready = await this.applyGameIsolation(true);
      if (ready) {
        await this.injectConversationPluginCards({
          round: this.room.round.number,
          input: this.room.round.modelInput,
          runs: this.room.round.pluginRuns
        });
        await this.showCapturedGameSurface({ hostStreamingVisible: true });
        this.appendSessionLog("game-surface", { event: "host-live-opened", round: this.room.round.number });
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return false;
  }

  async sendModelInputAndCapture(modelInput) {
    const appId = this.currentWorkAppId();
    return this.withAutoModel(appId, "联机回合", ({ signal }) => this.sendModelInputAttempt(modelInput, signal), {
      conversationId: this.room?.save?.conversationId || this.conversation.activeId,
      reload: async () => {
        await this.loadSurfaceUrl(this.gameSurface, this.workGameUrl(), "自动模型切换", 20000);
        await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
        await this.applyGameIsolation(false);
      }
    });
  }

  async sendModelInputAttempt(modelInput, signal) {
    if (!this.work?.url) throw new Error("房主尚未载入游玩作品");
    const gameUrl = this.workGameUrl();
    if (!this.isSameWorkPage(this.gameSurface.webContents.getURL(), gameUrl)) await this.gameSurface.webContents.loadURL(gameUrl);
    // Keep an already-isolated conversation attached. DOM automation can use
    // hidden platform controls directly, while the user sees the submitted row
    // and streaming answer without a full-page flash or a detach/reattach gap.
    const cancel = () => { if (!this.gameSurface.webContents.isDestroyed()) this.gameSurface.webContents.reload(); };
    assertActive(signal);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
    const result = await this.gameSurface.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
      for (let attempt = 0; attempt < 80 && !document.querySelector('#ai-chat-input'); attempt += 1) await sleep(250);
      const input = document.querySelector('#ai-chat-input');
      const send = document.querySelector('#ai-send-button');
      if (!input || !send) throw new Error('找不到平台作品输入栈');
      const beforeAnswers = document.querySelectorAll('#ai-chat-answer').length;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      setter?.call(input, ${JSON.stringify(modelInput)});
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(modelInput)}}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
      await sleep(120);
      send.click();
      let answer = null;
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const answers = [...document.querySelectorAll('#ai-chat-answer')];
        const candidate = answers.at(-1);
        const model = candidate?.querySelector('#customized-answer-content-model-name')?.textContent?.trim() || '';
        const inputPoints = candidate?.querySelector('#customized-answer-content-model-input-points')?.textContent?.trim() || '';
        const outputPoints = candidate?.querySelector('#customized-answer-content-model-output-points')?.textContent?.trim() || '';
        if (answers.length > beforeAnswers && candidate && model && inputPoints && outputPoints) { answer = candidate; break; }
        await sleep(250);
      }
      if (!answer) throw new Error('等待平台模型输出完成超时');
      const modelText = answer.querySelector('#customized-answer-content-model-name')?.textContent?.trim() || '';
      const inputPointsText = answer.querySelector('#customized-answer-content-model-input-points')?.textContent?.trim() || '';
      const outputPointsText = answer.querySelector('#customized-answer-content-model-output-points')?.textContent?.trim() || '';
      const edit = answer.querySelector('#customized-edit-button');
      if (!edit) throw new Error('找不到平台 AI 回复编辑按钮');
      edit.click();
      let editor = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        editor = [...document.querySelectorAll('[role="dialog"] textarea,textarea')].filter(item => item !== input && (item.getAttribute('placeholder') === '请输入' || item.className.includes('h-[65vh]')) && item.closest('[role="dialog"]')?.getAttribute('data-state') !== 'closed').at(-1) || null;
        if (editor) break;
        await sleep(100);
      }
      if (!editor) throw new Error('无法读取平台 AI 原始输出');
      const output = editor.value;
      const dialog = editor.closest('[role="dialog"]') || editor.parentElement?.parentElement?.parentElement;
      const cancel = [...(dialog || document).querySelectorAll('button')].find(button => /^(取消|Cancel)$/i.test((button.textContent || '').trim()));
      cancel?.click();
      const parsePoints = value => Number((value.match(/[\\d,]+/)?.[0] || '0').replaceAll(',','')) || 0;
      return {
        output,
        model:modelText.replace(/^模型\\s*/,'').trim(),
        points:{input:parsePoints(inputPointsText),output:parsePoints(outputPointsText),total:parsePoints(inputPointsText)+parsePoints(outputPointsText)}
      };
    })()`, true);
    if (!result?.output) throw new Error("平台模型已结束，但没有取得输出内容");
    return result;
    } finally { signal?.removeEventListener("abort", cancel); }
  }

  async performLatestPlatformMessageOperation(action, value = "") {
    if (action !== "refresh") return this.performLatestPlatformMessageAttempt(action, value);
    return this.withAutoModel(this.currentWorkAppId(), "重新生成回复", async ({ signal }) => {
      const cancel = () => { if (!this.gameSurface.webContents.isDestroyed()) this.gameSurface.webContents.reload(); };
      assertActive(signal);
      signal.addEventListener("abort", cancel, { once: true });
      try { return await this.performLatestPlatformMessageAttempt(action, value); }
      finally { signal.removeEventListener("abort", cancel); }
    }, {
      conversationId: this.room?.save?.conversationId || this.conversation.activeId,
      reload: async () => {
        await this.loadSurfaceUrl(this.gameSurface, this.workGameUrl(), "自动模型切换", 20000);
        await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
      }
    });
  }

  async performLatestPlatformMessageAttempt(action, value = "") {
    if (!this.work?.url) throw new Error("尚未载入作品对话页面");
    const operation = String(action || "");
    if (!["refresh", "edit", "delete"].includes(operation)) throw new Error("不支持的记录操作");
    const expectedOutput = String(value ?? "");
    await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
    await this.suspendGameSurfacePresentation();
    try {
      await this.clearGameIsolation();
      const result = await this.gameSurface.webContents.executeJavaScript(`(async () => {
      const operation = ${JSON.stringify(operation)};
      const expectedOutput = ${JSON.stringify(expectedOutput)};
      const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
      const visible = element => {
        if (!element || !element.isConnected) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const isOpenDialog = element => element && element.getAttribute('data-state') !== 'closed' && visible(element);
      const answers = [...document.querySelectorAll('#ai-chat-answer')];
      const answer = answers.at(-1) || null;
      if (!answer) throw new Error('当前会话没有可操作的 AI 回复');
      const messageRowFor = target => target?.closest('.relative.flex.items-start.justify-between.gap-3.py-3.px-3') || target?.parentElement || null;
      const findMessageButton = (target, selector) => target?.querySelector(selector) || messageRowFor(target)?.querySelector(selector) || null;
      const parsePoints = text => Number((String(text || '').match(/[\\d,]+/)?.[0] || '0').replaceAll(',','')) || 0;
      const readMeta = target => {
        const modelText = target?.querySelector('#customized-answer-content-model-name')?.textContent?.trim() || '';
        const inputText = target?.querySelector('#customized-answer-content-model-input-points')?.textContent?.trim() || '';
        const outputText = target?.querySelector('#customized-answer-content-model-output-points')?.textContent?.trim() || '';
        return {
          model:modelText.replace(/^模型\\s*/,'').trim(),
          points:{input:parsePoints(inputText),output:parsePoints(outputText),total:parsePoints(inputText)+parsePoints(outputText)}
        };
      };
      const openEditor = async target => {
        const edit = findMessageButton(target, '#customized-edit-button');
        if (!edit) throw new Error('找不到平台回复编辑按钮');
        HTMLElement.prototype.click.call(edit);
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(isOpenDialog).filter(item => item.querySelector('textarea')).at(-1) || null;
          const editor = dialog ? [...dialog.querySelectorAll('textarea')].find(item => item.getAttribute('placeholder') === '请输入' || item.className.includes('h-[65vh]')) || dialog.querySelector('textarea') : null;
          if (dialog && editor) return {dialog,editor};
          await sleep(50);
        }
        throw new Error('无法打开平台回复编辑框');
      };
      const closeEditor = async dialog => {
        const cancel = [...dialog.querySelectorAll('button')].find(button => /^(取消|Cancel)$/i.test((button.textContent || '').trim()));
        if (cancel) HTMLElement.prototype.click.call(cancel);
        await sleep(80);
      };
      const readOutput = async target => {
        const {dialog,editor} = await openEditor(target);
        const output = String(editor.value || '');
        await closeEditor(dialog);
        return output;
      };
      const writeOutput = async target => {
        const {dialog,editor} = await openEditor(target);
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
        const write = () => {
          const previous = String(editor.value || '');
          editor.focus();
          setter?.call(editor,expectedOutput);
          try { editor._valueTracker?.setValue(previous); } catch {}
          editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null}));
          editor.dispatchEvent(new Event('change',{bubbles:true}));
        };
        let stable = false;
        for (let attempt = 0; attempt < 4 && !stable; attempt += 1) {
          write();
          await sleep(180 + attempt * 100);
          stable = editor.value === expectedOutput;
        }
        if (!stable) {
          try {
            editor.focus();
            editor.select();
            document.execCommand('insertText',false,expectedOutput);
            await sleep(300);
            stable = editor.value === expectedOutput;
          } catch {}
        }
        if (!stable) throw new Error('平台编辑框没有完整写入同步内容');
        const save = [...dialog.querySelectorAll('button')].find(button => /^(保存|Save)$/i.test((button.textContent || '').trim()) && !button.disabled);
        if (!save) throw new Error('找不到平台保存回复按钮');
        HTMLElement.prototype.click.call(save);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (!dialog.isConnected || !isOpenDialog(dialog)) return true;
          await sleep(50);
        }
        throw new Error('平台保存回复超时');
      };

      if (operation === 'edit') {
        await writeOutput(answer);
        return {operation,output:expectedOutput,...readMeta(answer)};
      }
      if (operation === 'delete') {
        const button = findMessageButton(answer, '#customized-delete-button');
        if (!button) throw new Error('找不到平台回复删除按钮');
        HTMLElement.prototype.click.call(button);
        let confirmed = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(isOpenDialog).at(-1) || null;
          const confirm = dialog ? [...dialog.querySelectorAll('button')].find(item => /^(确认|确定|删除|Confirm|Delete)$/i.test((item.textContent || '').trim()) && !item.disabled) : null;
          if (confirm) {
            HTMLElement.prototype.click.call(confirm);
            confirmed = true;
            break;
          }
          await sleep(30);
        }
        if (!confirmed) throw new Error('找不到平台删除确认按钮');
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (document.querySelectorAll('#ai-chat-answer').length < answers.length) return {operation,deleted:true};
          await sleep(50);
        }
        throw new Error('平台删除回复超时');
      }

      const reload = findMessageButton(answer, '#customized-reload-button');
      if (!reload) throw new Error('只有最近一条 AI 回复可以刷新');
      const beforeText = String(answer.innerText || '');
      HTMLElement.prototype.click.call(reload);
      // Some accounts show the platform's points/refresh-card chooser. Always
      // choose the ordinary points route so the tool mirrors a normal refresh.
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const chooser = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper]')].filter(isOpenDialog).at(-1) || null;
        const pointsButton = [...(chooser || document).querySelectorAll('button')].filter(visible).find(item => {
          const text = (item.textContent || '').trim();
          return /(积分|point)/i.test(text) && !/(刷新卡|refresh\\s*card)/i.test(text) && !item.disabled;
        });
        if (pointsButton) {
          HTMLElement.prototype.click.call(pointsButton);
          break;
        }
        const current = [...document.querySelectorAll('#ai-chat-answer')].at(-1);
        if (!document.querySelector('#ai-send-button') || String(current?.innerText || '') !== beforeText) break;
        await sleep(40);
      }
      let started = false;
      let refreshed = null;
      for (let attempt = 0; attempt < 2400; attempt += 1) {
        const current = [...document.querySelectorAll('#ai-chat-answer')].at(-1) || null;
        const currentText = String(current?.innerText || '');
        if (!document.querySelector('#ai-send-button') || currentText !== beforeText) started = true;
        const meta = readMeta(current);
        if (started && document.querySelector('#ai-send-button') && findMessageButton(current, '#customized-edit-button') && meta.model) {
          refreshed = current;
          break;
        }
        await sleep(125);
      }
      if (!refreshed) throw new Error('等待平台刷新回复完成超时');
      const output = await readOutput(refreshed);
      return {operation,output,...readMeta(refreshed)};
      })()`, true);
      if (operation === "edit") {
        const normalize = text => String(text ?? "").replace(/\r\n/g, "\n").trimEnd();
        let verified = false;
        let lastPlatformOutput = "";
        for (let attempt = 0; attempt < 8 && !verified; attempt += 1) {
          const outputs = await this.readRecentConversationOutputs(1).catch(() => []);
          lastPlatformOutput = String(outputs[0] || "");
          verified = normalize(lastPlatformOutput) === normalize(expectedOutput);
          if (!verified) await new Promise(resolve => setTimeout(resolve, 350));
        }
        if (!verified) throw new Error(`平台没有保存工具文本框中的完整回复（期望 ${expectedOutput.length} 字，平台返回 ${lastPlatformOutput.length} 字）`);
      }
      return result;
    } finally {
      await this.applyGameIsolation(false).catch(() => false);
      this.resumeGameSurfacePresentation();
      await this.captureGameFrame(true).catch(() => false);
    }
  }

  async syncGuestMessageOperation(payload, { maxAttempts = 4 } = {}) {
    const action = String(payload?.action || "");
    const value = String(payload?.output ?? "");
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this.appendSessionLog("message-operation", { event: "guest-attempt-started", operationId: payload?.operationId, action, attempt, maxAttempts });
        const result = await this.performLatestPlatformMessageOperation(action === "refresh" ? "edit" : action, value);
        this.appendSessionLog("message-operation", { event: "guest-attempt-succeeded", operationId: payload?.operationId, action, attempt, result });
        return result;
      } catch (error) {
        lastError = error;
        this.appendSessionLog("message-operation", { event: "guest-attempt-failed", operationId: payload?.operationId, action, attempt, maxAttempts, error: error?.message || String(error) });
        if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, [700, 1400, 2800][Math.min(attempt - 1, 2)]));
      }
    }
    throw new Error(`记录操作已重试 ${maxAttempts} 次仍未成功：${lastError?.message || String(lastError || "未知错误")}`);
  }

  async runHostMessageOperation(action, value = "") {
    if (!this.room || this.room.role !== "host") throw new Error("只有房主可以操作联机记录");
    if (this.messageOperationBusy) throw new Error("上一项记录操作仍在进行");
    if (this.room.round?.status !== "collecting" || Object.keys(this.room.round?.submissions || {}).length) throw new Error("请在新一轮尚无人确认输入时操作上一轮记录");
    if (!this.room.round?.lastResult || this.room.round.lastResult.deleted) throw new Error("当前没有可操作的上一轮回复");
    if (action === "edit" && !String(value || "").trim()) throw new Error("编辑后的回复不能为空");
    if (action === "edit" && this.room.round.lastResult.perspectiveSplit) throw new Error("独立视角记录保留完整原文用于剧情推进；请使用刷新重新整理，避免用单人文本覆盖全体原文");
    const operationRoom = this.room;
    this.messageOperationBusy = true;
    const protectPerspective = this.pluginSettings.plugins[PERSPECTIVE_PLUGIN_ID].enabled || operationRoom.round.lastResult.perspectiveSplit;
    if (protectPerspective) { this.perspectivePresentationBlocked = true; this.detachSurface(); }
    const operationId = crypto.randomUUID();
    operationRoom.messageOperation = {
      id: operationId,
      action,
      status: "running",
      pendingGuestIds: operationRoom.members.filter(member => String(member.id) !== String(this.account.accountId)).map(member => String(member.id)),
      acks: {},
      error: null
    };
    this.appendSessionLog("message-operation", { event: "host-started", operationId, action });
    this.emit();
    try {
      const previousResult = operationRoom.round.lastResult;
      const platformResult = await this.performLatestPlatformMessageOperation(action, value);
      if (this.room !== operationRoom) throw new Error("刷新期间房间已经退出，已停止同步旧房间");
      const payload = {
        operationId,
        action,
        round: Number(previousResult.round),
        output: action === "delete" ? "" : String(platformResult.output || value || ""),
        model: platformResult.model || previousResult.model || "",
        points: platformResult.points || previousResult.points || { input: 0, output: 0, total: 0 },
        completedAt: Date.now()
      };
      if (action !== "delete") {
        const source = payload.output;
        const operationRound = {
          number: payload.round,
          pluginRuns: (Array.isArray(previousResult.pluginRuns) ? previousResult.pluginRuns : [])
            .filter(run => run?.phase !== PLUGIN_PHASES.OUTPUT)
        };
        const processedOutput = await this.runConversationPluginStack(
          PLUGIN_PHASES.OUTPUT,
          source,
          operationRound,
          { forcePluginIds: previousResult.perspectiveSplit ? [PERSPECTIVE_PLUGIN_ID] : [] }
        );
        payload.pluginRuns = operationRound.pluginRuns;
        payload.perspectiveSplit = Boolean(operationRound.perspectiveSplit);
        payload.perspectiveOutputs = operationRound.perspectiveOutputs;
        payload.output = operationRound.perspectiveSplit
          ? operationRound.perspectiveOutputs?.[String(this.account.accountId)] || WITHHELD_OUTPUT
          : processedOutput;
        if (operationRound.perspectiveSplit) {
          await this.rememberPerspectiveView(source, payload.output);
          await this.loadSurfaceUrl(this.gameSurface, this.workGameUrl(), "独立视角对话", 20000);
          await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
        }
      }
      if (action === "delete") operationRoom.round.lastResult = { ...operationRoom.round.lastResult, deleted: true, output: "" };
      else operationRoom.round.lastResult = { ...operationRoom.round.lastResult, ...payload };
      this.perspectivePresentationBlocked = false;
      this.keepGameSurfaceResident();
      operationRoom.messageOperation.status = operationRoom.messageOperation.pendingGuestIds.length ? "syncing" : "completed";
      await this.broadcastRoomPacket("message-operation", payload, true);
      if (this.room !== operationRoom) throw new Error("同步期间房间已经退出，已停止更新旧房间");
      if (!operationRoom.messageOperation.pendingGuestIds.length) operationRoom.messageOperation.status = "completed";
      this.appendSessionLog("message-operation", { event: "host-broadcast", payload, pendingGuestIds: operationRoom.messageOperation.pendingGuestIds });
      this.emit({ messageOperationSent: true });
      return payload;
    } catch (error) {
      operationRoom.messageOperation.status = "error";
      operationRoom.messageOperation.error = error?.message || String(error);
      this.appendSessionLog("message-operation", { event: "host-failed", operationId, action, error: operationRoom.messageOperation.error });
      this.emit({ messageOperationError: operationRoom.messageOperation.error });
      throw error;
    } finally {
      this.perspectivePresentationBlocked = false;
      if (this.room === operationRoom) this.keepGameSurfaceResident();
      this.messageOperationBusy = false;
      this.emit();
    }
  }

  async prepareGuestRoundInput(payload, { retryAttempt = 1 } = {}) {
    if (!this.work?.url) throw new Error("成员端尚未载入游玩作品");
    const round = Number(payload?.round);
    const expectedInput = String(payload?.input || "");
    if (!Number.isInteger(round) || !expectedInput.trim()) throw new Error("房主同步的本轮输入无效");
    const gameUrl = this.workGameUrl();
    const appId = parseInviteWork(this.work.suffix, this.origin).id;
    const expectedConversationId = [this.room?.save?.conversationId, this.conversation.activeId]
      .map(value => String(value || ""))
      .find(value => /^[0-9a-f-]{36}$/i.test(value)) || null;
    const knownConversationIds = [...new Set([
      ...(this.conversation.items || []).map(item => String(item?.id || "")),
      String(this.conversation.activeId || ""),
      String(this.room?.save?.conversationId || "")
    ].filter(value => /^[0-9a-f-]{36}$/i.test(value)))];
    await this.gameNetworkCaptureReady.catch(() => false);
    if (!this.isSameWorkPage(this.gameSurface.webContents.getURL(), gameUrl)) {
      await this.loadSurfaceUrl(this.gameSurface, gameUrl, "作品对话页面");
    }
    await this.clearGameIsolation();
    const syncKey = `${this.room?.id || "room"}:${round}`;
    this.appendSessionLog("guest-input-prep", { event: "started", round, retryAttempt, syncKey, input: expectedInput });
    let outcome;
    try {
      await this.gameSurface.webContents.executeJavaScript(`(${installGuestOutputGuard.toString()})(${JSON.stringify({ syncKey, appId, input: expectedInput, conversationId: expectedConversationId })})`, true);
      outcome = await this.gameSurface.webContents.executeJavaScript(`(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
        const expectedInput = ${JSON.stringify(expectedInput)};
        const installedAppId = ${JSON.stringify(appId)};
        const expectedConversationId = ${JSON.stringify(expectedConversationId)};
        const knownConversationIds = new Set(${JSON.stringify(knownConversationIds)});
        const syncKey = ${JSON.stringify(syncKey)};
        window.__fympRoundSyncStates ||= Object.create(null);
        const roundState = window.__fympRoundSyncStates[syncKey] ||= {
          sent:false,stopped:false,saved:false,beforeAnswers:null,beforeQuestions:null,answerNode:null
        };
        window.__fympInputPrepTrace = [];
        const mark = (stage,detail={}) => window.__fympInputPrepTrace.push({time:new Date().toISOString(),stage,...detail});
        mark('early-network-status',{
          installed:Boolean(window.__fympEarlyNetwork?.installed),
          recordCount:Array.isArray(window.__fympEarlyNetwork?.records) ? window.__fympEarlyNetwork.records.length : 0
        });
        const validId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
        const readConversationId = () => {
          if (validId(roundState.conversationId)) return String(roundState.conversationId);
          try {
            const map = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
            const stored = map?.[installedAppId];
            const value = typeof stored === 'string' ? stored : stored?.conversationId || stored?.conversation_id || stored?.id || null;
            return validId(value) ? String(value) : null;
          } catch { return null; }
        };
        roundState.captureSources ||= [];
        let earlyCaptureCount = Number(roundState.earlyCaptureCount || 0);
        const readEarlyConversationId = () => {
          const early = window.__fympEarlyNetwork;
          const captures = Array.isArray(early?.captures) ? early.captures : [];
          while (earlyCaptureCount < captures.length) {
            const item = captures[earlyCaptureCount++];
            roundState.captureSources.push(item);
            mark('conversation-id-captured',{source:item.source,url:item.url || '',conversationId:item.conversationId});
          }
          roundState.earlyCaptureCount = earlyCaptureCount;
          return validId(early?.conversationId) ? String(early.conversationId) : null;
        };
        const captureText = (value,source,url='') => {
          const text = String(value || '');
          const patterns = [
            /["']conversation_id["']\\s*:\\s*["']([0-9a-f-]{36})["']/i,
            /["']conversationId["']\\s*:\\s*["']([0-9a-f-]{36})["']/i,
            /conversation_id(?:=|%3D|%22%3A%22)([0-9a-f-]{36})/i
          ];
          const candidate = patterns.map(pattern => text.match(pattern)?.[1]).find(value => validId(value) && String(value) !== installedAppId) || null;
          if (candidate && !validId(roundState.conversationId)) {
            roundState.conversationId = String(candidate);
            roundState.captureSources.push({source,url,conversationId:String(candidate),time:new Date().toISOString()});
            mark('conversation-id-captured',{source,url,conversationId:String(candidate)});
          }
          return candidate;
        };
        window.__fympRestoreInputPrepCapture?.();
        const nativeFetch = window.fetch;
        const probeServerConversationId = async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(),700);
          try {
            const token = localStorage.getItem('console_token') || '';
            const headers = { 'X-Language':'zh-Hans' };
            if (token) headers.Authorization = 'Bearer ' + token;
            const response = await nativeFetch('/console/api/installed-apps/' + encodeURIComponent(installedAppId) + '/conversations?limit=500', {
              method:'GET',credentials:'include',cache:'no-store',signal:controller.signal,
              headers
            });
            if (!response.ok) return null;
            const payload = await response.json().catch(() => ({}));
            const arrays = [];
            const queue = [{value:payload,depth:0}];
            const visited = new Set();
            while (queue.length && visited.size < 120) {
              const {value,depth} = queue.shift();
              if (!value || typeof value !== 'object' || visited.has(value)) continue;
              visited.add(value);
              if (Array.isArray(value)) { arrays.push(value); continue; }
              if (depth < 5) for (const child of Object.values(value)) queue.push({value:child,depth:depth+1});
            }
            const score = values => values.reduce((total,record) => total + (record && typeof record === 'object' && (record.id || record.conversation_id || record.conversationId || record.uuid) ? 1 : 0),0);
            const records = arrays.sort((left,right) => score(right)-score(left) || right.length-left.length)[0] || [];
            const ids = records.map(record => String(record?.id ?? record?.conversation_id ?? record?.conversationId ?? record?.uuid ?? '')).filter(validId);
            const candidate = validId(expectedConversationId) && ids.includes(expectedConversationId)
              ? expectedConversationId
              : ids.find(id => !knownConversationIds.has(id)) || null;
            if (candidate) {
              roundState.conversationId = candidate;
              const source = {source:'platform-conversation-list-before-stop',conversationId:candidate,time:new Date().toISOString()};
              roundState.captureSources.push(source);
              mark('conversation-confirmed-on-platform',source);
            }
            return candidate;
          } catch (error) {
            mark('conversation-probe-failed',{message:error?.message || String(error)});
            return null;
          } finally {
            clearTimeout(timeout);
          }
        };
        const nativeXhrOpen = XMLHttpRequest.prototype.open;
        const nativeXhrSend = XMLHttpRequest.prototype.send;
        window.fetch = function(...args) {
          const requestUrl = String(typeof args[0] === 'string' ? args[0] : args[0]?.url || '');
          const requestBody = args[1]?.body || (typeof args[0] === 'object' ? args[0]?.body : '');
          captureText(requestBody,'fetch-request',requestUrl);
          return nativeFetch.apply(this,args).then(response => {
            if (requestUrl.includes(installedAppId)) {
              try {
                const clone = response.clone();
                void clone.text().then(text => captureText(text,'fetch-response',response.url || requestUrl)).catch(() => {});
              } catch {}
            }
            return response;
          });
        };
        XMLHttpRequest.prototype.open = function(method,url,...rest) {
          this.__fympInputPrepUrl = String(url || '');
          return nativeXhrOpen.call(this,method,url,...rest);
        };
        XMLHttpRequest.prototype.send = function(body) {
          captureText(body,'xhr-request',this.__fympInputPrepUrl || '');
          const inspect = () => {
            try { captureText(this.responseText,'xhr-response',this.responseURL || this.__fympInputPrepUrl || ''); } catch {}
          };
          this.addEventListener('progress',inspect);
          this.addEventListener('readystatechange',inspect);
          return nativeXhrSend.call(this,body);
        };
        window.__fympRestoreInputPrepCapture = () => {
          if (window.fetch !== nativeFetch) window.fetch = nativeFetch;
          if (XMLHttpRequest.prototype.open !== nativeXhrOpen) XMLHttpRequest.prototype.open = nativeXhrOpen;
          if (XMLHttpRequest.prototype.send !== nativeXhrSend) XMLHttpRequest.prototype.send = nativeXhrSend;
          delete window.__fympRestoreInputPrepCapture;
        };
        const stopSelector = 'div.absolute.bottom-2.right-2 > div[role="presentation"].bg-black.cursor-pointer';
        const findStop = () => [...document.querySelectorAll(stopSelector)].find(element =>
          !element.id && element.querySelector('svg') && !element.querySelector('input,textarea')
        ) || null;
        for (let attempt = 0; attempt < 100 && !document.querySelector('#ai-chat-input'); attempt += 1) await sleep(150);
        const input = document.querySelector('#ai-chat-input');
        if (!input) throw new Error('成员端常驻作品页没有出现平台输入栈');
        const currentAnswers = document.querySelectorAll('#ai-chat-answer').length;
        const currentQuestions = document.querySelectorAll('#customized-question-content').length;
        if (!Number.isInteger(roundState.beforeAnswers)) roundState.beforeAnswers = currentAnswers;
        if (!Number.isInteger(roundState.beforeQuestions)) roundState.beforeQuestions = currentQuestions;
        if (!roundState.beforeLastAnswer) roundState.beforeLastAnswer = [...document.querySelectorAll('#ai-chat-answer')][roundState.beforeAnswers - 1] || null;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
        let answer = roundState.answerNode?.isConnected ? roundState.answerNode : null;
        let stop = findStop();
        if (!roundState.sent) {
          if (stop) throw new Error('成员端已有其他输出正在进行，无法安全建立本轮空回复');
          setter?.call(input,expectedInput);
          input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:expectedInput}));
          input.dispatchEvent(new Event('change',{bubbles:true}));
          // Let React commit the controlled textarea state before invoking the
          // same button path used by a normal platform click.
          await sleep(180);
          if (input.value !== expectedInput) throw new Error('成员端没有正确写入房主输入');
          const send = document.querySelector('#ai-send-button');
          if (!send) throw new Error('成员端发送按钮尚未就绪');
          if (send.disabled || send.getAttribute('aria-disabled') === 'true') throw new Error('成员端发送按钮仍处于禁用状态');
          send.click();
          roundState.sent = true;
          roundState.sentAt = Date.now();
          mark('send-clicked');
        } else {
          mark('send-reused');
        }
        for (let attempt = 0; attempt < 800 && !stop && !roundState.stopped; attempt += 1) {
          stop = findStop();
          const answers = [...document.querySelectorAll('#ai-chat-answer')];
          const candidate = answers.at(-1) || null;
          if (candidate && answers.length > roundState.beforeAnswers && candidate !== roundState.beforeLastAnswer) {
            answer = candidate;
            roundState.answerNode = candidate;
          }
          const questionCreated = document.querySelectorAll('#customized-question-content').length > roundState.beforeQuestions;
          if (!stop && answer && questionCreated && document.querySelector('#ai-send-button')) {
            mark('model-completed-before-stop-control',{answerCount:answers.length});
            break;
          }
          if (!stop && !answer && attempt === 300) {
            const retrySend = document.querySelector('#ai-send-button');
            if (!questionCreated && retrySend && input.value === expectedInput && !window.__fympGuestOutputGuard?.states[syncKey]?.requestSeen) {
              retrySend.click();
              mark('send-click-retried');
            }
          }
          if (!stop && !roundState.stopped) await sleep(5);
        }
        const questionCreatedAfterSend = document.querySelectorAll('#customized-question-content').length > roundState.beforeQuestions;
        if (!stop && !answer && !questionCreatedAfterSend && !roundState.stopped) {
          if (window.__fympGuestOutputGuard?.states[syncKey]?.requestSeen) throw new Error('本轮访客请求已发出，正在等待平台确认，不会重复生成');
          roundState.sent = false;
          mark('send-produced-no-platform-message',{
            inputLength:String(input.value || '').length,
            sendPresent:Boolean(document.querySelector('#ai-send-button')),
            questionCount:document.querySelectorAll('#customized-question-content').length,
            answerCount:document.querySelectorAll('#ai-chat-answer').length
          });
          throw new Error('访客端发送按钮没有产生平台消息，已恢复输入并准备安全重试');
        }
        const generation = window.__fympGuestOutputGuard?.states[syncKey];
        if (!generation) throw new Error('访客任务监听未安装，不能仅按按钮状态认定停止');
        // Never click the native stop button before its task id arrives. That
        // button hides itself immediately even when no server stop was sent.
        const generationDeadline = Date.now() + 45000;
        while (!generation.ready && !generation.error && Date.now() < generationDeadline) await sleep(25);
        if (!generation.ready) {
          const finalStop = generation.taskId && findStop();
          if (finalStop) HTMLElement.prototype.click.call(finalStop);
          throw new Error(generation.error || '等待访客生成任务终止超时；本轮不会重复发送');
        }
        roundState.messageId = generation.messageId || roundState.messageId;
        roundState.conversationId = generation.conversationId || roundState.conversationId;
        mark('server-generation-ended',{taskId:generation.taskId || null,messageId:generation.messageId || null,stopAcknowledged:generation.stopAcknowledged,stopAttempts:generation.stopAttempts || 0,outputCharacters:generation.outputCharacters});
        if (!roundState.stopped && (stop = findStop())) {
          // The server stream has ended. Clear any remaining frontend busy
          // state before locating the editable placeholder.
          mark('stop-control-found-immediately');
          for (let burst = 1; burst <= 5; burst += 1) {
            const currentStop = findStop();
            if (!currentStop) break;
            HTMLElement.prototype.click.call(currentStop);
            mark('stop-clicked',{burst});
            await sleep(burst * 18);
          }
          let settled = false;
          for (let attempt = 0; attempt < 800; attempt += 1) {
            const remaining = findStop();
            if (!remaining && document.querySelector('#ai-send-button')) { settled = true; break; }
            if (remaining && [20,60,120,240,480,720].includes(attempt)) {
              HTMLElement.prototype.click.call(remaining);
              mark('stop-click-repeated',{attempt});
            }
            await sleep(10);
          }
          if (!settled) throw new Error('成员端终止输出超时');
          let stableChecks = 0;
          for (let confirmation = 1; confirmation <= 4; confirmation += 1) {
            await sleep(120);
            const lateStop = findStop();
            if (lateStop) {
              HTMLElement.prototype.click.call(lateStop);
              mark('late-stop-clicked',{confirmation});
              stableChecks = 0;
            } else if (document.querySelector('#ai-send-button')) {
              stableChecks += 1;
            }
          }
          if (stableChecks < 2) throw new Error('成员端终止状态没有稳定下来');
          roundState.stopped = true;
          roundState.terminationMode = 'stop-control';
          mark('stop-settled-stable');
        } else if (!roundState.stopped) {
          // An exceptionally fast model may finish before Chromium exposes the
          // stop control.  Keep its answer only as the editable placeholder;
          // round-result will still overwrite it with the host authority.
          if (answer && questionCreatedAfterSend && document.querySelector('#ai-send-button')) {
            roundState.stopped = true;
            roundState.terminationMode = 'completed-before-stop';
            mark('completed-answer-adopted-as-placeholder');
          } else {
            throw new Error('平台没有出现可终止控件，且生成状态尚未稳定');
          }
        }
        let serverConversationId = readConversationId() || readEarlyConversationId();
        const postStopDeadline = Date.now() + 5000;
        while (Date.now() < postStopDeadline && !serverConversationId) {
          serverConversationId = readEarlyConversationId() || readConversationId();
          if (!serverConversationId) serverConversationId = await probeServerConversationId();
          if (!serverConversationId) await sleep(120);
        }
        if (!serverConversationId) {
          mark('early-network-diagnostics',{
            installed:Boolean(window.__fympEarlyNetwork?.installed),
            records:Array.isArray(window.__fympEarlyNetwork?.records) ? window.__fympEarlyNetwork.records.slice(-16) : []
          });
          throw new Error('成员端已经停止生成，但平台没有返回会话编号；不会重复发送本轮输入');
        }
        roundState.conversationId = serverConversationId;
        if (!answer) {
          for (let attempt = 0; attempt < 300; attempt += 1) {
            const answers = [...document.querySelectorAll('#ai-chat-answer')];
            const candidate = answers.at(-1) || null;
            if (candidate && answers.length > roundState.beforeAnswers && candidate !== roundState.beforeLastAnswer) {
              answer = candidate;
              roundState.answerNode = candidate;
              break;
            }
            await sleep(20);
          }
        }
        if (!answer) throw new Error('终止后没有形成可编辑的空回复');
        let conversationId = serverConversationId || readConversationId();
        if (conversationId) {
          try {
            const map = JSON.parse(localStorage.getItem('conversationIdInfo') || '{}');
            map[installedAppId] = conversationId;
            localStorage.setItem('conversationIdInfo',JSON.stringify(map));
          } catch {}
        }
        window.__fympRestoreInputPrepCapture?.();
        mark('input-preparation-completed',{conversationId,captureSources:roundState.captureSources});
        return {sent:true,stopped:true,terminationMode:generation.stopAcknowledged ? 'server-stop-confirmed' : 'server-completed',messageId:roundState.messageId || null,conversationId,captureSources:roundState.captureSources,trace:window.__fympInputPrepTrace};
      })()`, true);
    } catch (error) {
      const trace = await this.gameSurface.webContents.executeJavaScript(`window.__fympInputPrepTrace || []`, true).catch(() => []);
      await this.gameSurface.webContents.executeJavaScript(`window.__fympRestoreInputPrepCapture?.()`, true).catch(() => {});
      this.appendSessionLog("guest-input-prep", { event: "page-operation-failed", round, retryAttempt, error: error?.message || String(error), trace });
      throw error;
    }
    if (!outcome?.sent || !outcome?.stopped) throw new Error("成员端没有完成发送与终止流程");
    const conversationId = String(outcome.conversationId || "").trim() || null;
    if (!conversationId) throw new Error("成员端虽然终止了输出，但平台没有返回新会话编号，已拒绝伪报成功");
    const normalize = value => String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
    let platformInputVerified = false;
    let verificationError = null;
    for (let attempt = 1; attempt <= 8 && !platformInputVerified; attempt += 1) {
      try {
        const payload = await this.platformChatApi(`/installed-apps/${encodeURIComponent(appId)}/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=8&page=1&paging_query_sort=desc`, { timeout: 3000 });
        const arrays = [];
        const queue = [{ value: payload, depth: 0 }];
        const visited = new Set();
        while (queue.length && visited.size < 100) {
          const { value, depth } = queue.shift();
          if (!value || typeof value !== "object" || visited.has(value)) continue;
          visited.add(value);
          if (Array.isArray(value)) { arrays.push(value); continue; }
          if (depth < 5) for (const child of Object.values(value)) queue.push({ value: child, depth: depth + 1 });
        }
        platformInputVerified = arrays.some(records => records.some(message => (!outcome.messageId || message.id === outcome.messageId) && normalize(message?.query) === normalize(expectedInput)));
        this.appendSessionLog("guest-input-prep", { event: "platform-record-verification", round, retryAttempt, attempt, conversationId, verified: platformInputVerified });
      } catch (error) {
        verificationError = error;
        this.appendSessionLog("guest-input-prep", { event: "platform-record-verification", round, retryAttempt, attempt, conversationId, verified: false, error: error?.message || String(error) });
      }
      if (!platformInputVerified && attempt < 8) await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (!platformInputVerified) {
      throw new Error(`平台已分配会话，但没有保存房主输入内容${verificationError ? `：${verificationError.message || String(verificationError)}` : ""}`);
    }
    if (conversationId && this.room?.save?.key) {
      const activeName = this.room.save.name || this.conversation.activeName || "新的对话";
      this.conversation = {
        ...this.conversation,
        items: [{ id: conversationId, name: activeName, active: true }, ...(this.conversation.items || []).filter(item => item.id && item.id !== conversationId).map(item => ({ ...item, active: false }))],
        activeId: conversationId,
        activeName,
        sessionKey: this.room.save.key,
        anchorRole: "guest",
        anchored: true,
        hasChat: true,
        source: "guest-input-stop",
        updatedAt: Date.now()
      };
      this.room.save.conversationId = conversationId;
      this.persistSaveAnchor({ sessionKey: this.room.save.key, conversationId, name: activeName, role: "guest" });
    }
    this.appendSessionLog("guest-input-prep", { event: "completed", round, retryAttempt, outcome, conversationId });
    this.guestPreparedTurns ||= new Map();
    this.guestPreparedTurns.set(syncKey, { conversationId, messageId: outcome.messageId || null, input: expectedInput });
    return { ...outcome, conversationId };
  }

  async prepareGuestRoundInputWithRetries(payload) {
    // Recheck before sending, not between retries reusing an already sent round.
    if (this.room?.role === "guest") await this.ensureValidPlatformModelWithRetries(3);
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await this.prepareGuestRoundInput(payload, { retryAttempt: attempt });
      } catch (error) {
        lastError = error;
        if (attempt >= 4) break;
        const delayMs = [300, 700, 1400][attempt - 1];
        this.appendSessionLog("guest-input-prep", { event: "retrying", round: Number(payload?.round), attempt: attempt + 1, delayMs, error: error?.message || String(error) });
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    throw new Error(`成员端准备空回复失败，已重试 4 次：${lastError?.message || String(lastError || "未知错误")}`);
  }

  // Retained only as a diagnostic reference for the pre-live-view prototype.
  // The active result path below is intentionally edit-only and never sends a
  // second platform turn after round-input has prepared the blank answer.
  async syncGuestRoundResult(result, { retryAttempt = 1 } = {}) {
    if (!this.work?.url) throw new Error("成员端尚未载入游玩作品");
    if (typeof result?.input !== "string" || !result.input.trim()) throw new Error("房主同步数据缺少输入内容");
    if (typeof result?.output !== "string" || !result.output.trim()) throw new Error("房主同步数据缺少输出内容");
    const appId = parseInviteWork(this.work.suffix, this.origin).id;
    const gameUrl = this.workGameUrl();
    const syncKey = `${this.room?.id || "room"}:${Number(result.round)}`;
    const preparedTurn = this.guestPreparedTurns?.get(syncKey);
    const validConversationId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
    const preparedConversationId = [preparedTurn?.conversationId, this.room?.save?.conversationId, this.conversation.activeId]
      .map(value => String(value || "").trim())
      .find(validConversationId) || null;
    if (!preparedConversationId) throw new Error("房主结果已到达，但访客端没有可编辑的本轮会话锚点");

    const normalize = value => String(value ?? "").replace(/\r\n?/g, "\n").trimEnd();
    const readRecords = payload => {
      const arrays = [];
      const queue = [{ value: payload, depth: 0 }];
      const visited = new Set();
      while (queue.length && visited.size < 120) {
        const { value, depth } = queue.shift();
        if (!value || typeof value !== "object" || visited.has(value)) continue;
        visited.add(value);
        if (Array.isArray(value)) {
          arrays.push(value);
          continue;
        }
        if (depth < 5) for (const child of Object.values(value)) queue.push({ value: child, depth: depth + 1 });
      }
      return arrays.sort((left, right) => {
        const score = records => records.reduce((total, record) => total + (typeof record?.query === "string" ? 1 : 0), 0);
        return score(right) - score(left) || right.length - left.length;
      })[0] || [];
    };

    // round-result may only edit the record created by round-input. Confirm the
    // exact host input on the platform before touching any AI answer node.
    let preparedRecordFound = false;
    let preparationDetail = "平台尚未返回 round-input 建立的访客记录";
    for (let attempt = 1; attempt <= 8 && !preparedRecordFound; attempt += 1) {
      try {
        const payload = await this.platformChatApi(`/installed-apps/${encodeURIComponent(appId)}/messages?conversation_id=${encodeURIComponent(preparedConversationId)}&limit=12&page=1&paging_query_sort=desc`, { timeout: 4000 });
        const records = readRecords(payload);
        preparedRecordFound = records.some(message => (!preparedTurn?.messageId || message.id === preparedTurn.messageId) && normalize(message?.query) === normalize(result.input));
        if (!preparedRecordFound && records.length) preparationDetail = "当前访客会话中找不到房主发送的本轮输入";
        this.appendSessionLog("guest-sync", { event: "prepared-input-verification", round: result.round, retryAttempt, attempt, conversationId: preparedConversationId, verified: preparedRecordFound });
      } catch (error) {
        preparationDetail = `读取访客本轮输入失败：${error?.message || String(error)}`;
        this.appendSessionLog("guest-sync", { event: "prepared-input-verification", round: result.round, retryAttempt, attempt, conversationId: preparedConversationId, verified: false, error: error?.message || String(error) });
      }
      if (!preparedRecordFound && attempt < 8) await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (!preparedRecordFound) throw new Error(`${preparationDetail}；为避免重复消息，round-result 不会再次发送输入`);

    // Discard queued frontend stream updates before opening the editor. Only the
    // verified stopped request's existing conversation is reloaded, never sent.
    await this.setPlatformConversationId(preparedConversationId);
    await this.clearGameIsolation();
    this.appendSessionLog("guest-sync", { event: "edit-only-started", round: result.round, retryAttempt, syncKey, conversationId: preparedConversationId, output: result.output });
    let editOutcome;
    try {
      editOutcome = await this.gameSurface.webContents.executeJavaScript(`(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
        const expectedInput = ${JSON.stringify(result.input)};
        // HTML textarea values normalize CRLF/CR to LF. Compare the same value
        // the native editor can retain rather than reporting two missing bytes.
        const expectedOutput = ${JSON.stringify(result.output.replace(/\r\n?/g, "\n"))};
        const preparedConversationId = ${JSON.stringify(preparedConversationId)};
        const syncKey = ${JSON.stringify(syncKey)};
        window.__fympRoundSyncStates ||= Object.create(null);
        const roundState = window.__fympRoundSyncStates[syncKey] ||= {
          sent:true,stopped:true,saved:false,beforeAnswers:null,beforeQuestions:null,answerNode:null
        };
        window.__fympSyncTrace = [];
        const mark = (stage,detail={}) => window.__fympSyncTrace.push({time:new Date().toISOString(),stage,...detail});
        const isOpenDialog = dialog => {
          if (!dialog || dialog.getAttribute('data-state') === 'closed' || dialog.getAttribute('aria-hidden') === 'true') return false;
          const style = getComputedStyle(dialog);
          const rect = dialog.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        for (let attempt = 0; attempt < 100 && !document.querySelector('#ai-chat-input'); attempt += 1) await sleep(100);
        if (!document.querySelector('#ai-chat-input')) throw new Error('成员端常驻作品页没有出现平台输入栈');
        const answers = [...document.querySelectorAll('#ai-chat-answer')];
        const preparedIndex = Number.isInteger(roundState.beforeAnswers) ? roundState.beforeAnswers : -1;
        let answer = roundState.answerNode?.isConnected ? roundState.answerNode : null;
        if (!answer && preparedIndex >= 0 && answers[preparedIndex]) answer = answers[preparedIndex];
        if (!answer) answer = answers.at(-1) || null;
        if (!answer?.querySelector('#customized-edit-button')) throw new Error('找不到 round-input 留下的可编辑空回复');
        roundState.sent = true;
        roundState.stopped = true;
        roundState.answerNode = answer;
        roundState.conversationId = preparedConversationId;
        roundState.expectedInput = expectedInput;
        mark('prepared-answer-located',{preparedIndex,answerCount:answers.length,recoveredAfterReload:preparedIndex < 0});
        if (roundState.saved) {
          mark('saved-edit-reused');
          return {saved:true,reused:true,conversationId:preparedConversationId,trace:window.__fympSyncTrace};
        }

        let dialog = [...document.querySelectorAll('[role="dialog"]')].filter(isOpenDialog).find(item => item.querySelector('textarea')) || null;
        let editor = dialog?.querySelector('textarea') || null;
        if (!editor) {
          HTMLElement.prototype.click.call(answer.querySelector('#customized-edit-button'));
          for (let attempt = 0; attempt < 160; attempt += 1) {
            dialog = [...document.querySelectorAll('[role="dialog"]')].filter(isOpenDialog).find(item => item.querySelector('textarea')) || null;
            editor = dialog?.querySelector('textarea') || null;
            if (editor) break;
            await sleep(40);
          }
        }
        if (!dialog || !editor) throw new Error('成员端无法打开本轮空回复的编辑框');
        mark('edit-dialog-opened');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
        const write = () => {
          const previous = String(editor.value || '');
          editor.focus();
          setter?.call(editor,expectedOutput);
          try { editor._valueTracker?.setValue(previous); } catch {}
          editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null}));
          editor.dispatchEvent(new Event('change',{bubbles:true}));
        };
        let stable = false;
        for (let attempt = 0; attempt < 5 && !stable; attempt += 1) {
          write();
          await sleep(180 + attempt * 100);
          if (editor.value === expectedOutput) {
            await sleep(140);
            stable = editor.value === expectedOutput;
          }
        }
        if (!stable) {
          try {
            editor.focus();
            editor.select();
            document.execCommand('insertText',false,expectedOutput);
            await sleep(300);
            stable = editor.value === expectedOutput;
          } catch {}
        }
        if (!stable) throw new Error('成员端编辑框没有完整写入房主输出（期望 ' + expectedOutput.length + ' 字，实际 ' + String(editor.value || '').length + ' 字）');
        mark('host-output-filled');
        let save = null;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          save = [...dialog.querySelectorAll('button')].find(button => /^(保存|Save)$/i.test((button.textContent || '').trim()) && !button.disabled) || null;
          if (save) break;
          await sleep(25);
        }
        if (!save) throw new Error('成员端找不到保存回复按钮');
        HTMLElement.prototype.click.call(save);
        mark('save-clicked');
        for (let attempt = 0; attempt < 240; attempt += 1) {
          if (!dialog.isConnected || !isOpenDialog(dialog)) {
            roundState.saved = true;
            mark('save-completed');
            return {saved:true,conversationId:preparedConversationId,trace:window.__fympSyncTrace};
          }
          await sleep(50);
        }
        throw new Error('成员端保存房主输出超时');
      })()`, true);
    } catch (error) {
      const trace = await this.gameSurface.webContents.executeJavaScript(`window.__fympSyncTrace || []`, true).catch(() => []);
      this.appendSessionLog("guest-sync-error", { event: "edit-only-failed", round: result.round, retryAttempt, conversationId: preparedConversationId, error: error?.message || String(error), trace });
      throw error;
    }
    if (!editOutcome?.saved) throw new Error("成员端没有通过编辑功能保存房主输出");
    this.appendSessionLog("guest-sync", { event: "edit-only-completed", round: result.round, retryAttempt, conversationId: preparedConversationId, outcome: editOutcome });

    let verified = false;
    let verificationDetail = "平台尚未返回同步记录";
    for (let attempt = 1; attempt <= 12 && !verified; attempt += 1) {
      try {
        const payload = await this.platformChatApi(`/installed-apps/${encodeURIComponent(appId)}/messages?conversation_id=${encodeURIComponent(preparedConversationId)}&limit=20&page=1&paging_query_sort=desc`);
        const records = readRecords(payload);
        const matched = records.find(message => (!preparedTurn?.messageId || message.id === preparedTurn.messageId) && normalize(message?.query) === normalize(result.input));
        verified = Boolean(matched && normalize(matched.answer) === normalize(result.output));
        verificationDetail = matched ? "平台保存的访客输出与房主输出不一致" : "平台保存的访客输入与房主输入不一致";
        this.appendSessionLog("guest-sync", { event: "server-verification", round: result.round, attempt, conversationId: preparedConversationId, verified, verificationDetail });
      } catch (error) {
        verificationDetail = `读取平台同步记录失败：${error?.message || String(error)}`;
        this.appendSessionLog("guest-sync", { event: "server-verification", round: result.round, attempt, conversationId: preparedConversationId, verified: false, verificationDetail });
      }
      if (!verified && attempt < 12) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!verified) throw new Error(`${verificationDetail}；本轮不会标记为同步完成`);

    const refreshed = await this.refreshConversations({ keepSessionKey: true });
    const activeName = (refreshed.items || []).find(item => String(item.id) === preparedConversationId)?.name || this.room?.save?.name || refreshed.activeName || "新的对话";
    const sessionKey = refreshed.sessionKey || this.room?.save?.key || this.conversation.sessionKey;
    this.conversation = {
      ...refreshed,
      items: [
        { id: preparedConversationId, name: activeName, active: true },
        ...(refreshed.items || []).filter(item => String(item.id) !== preparedConversationId).map(item => ({ ...item, active: false }))
      ],
      activeId: preparedConversationId,
      activeName,
      sessionKey,
      anchorRole: "guest",
      anchored: Boolean(sessionKey),
      hasChat: true,
      source: "guest-edit-sync",
      updatedAt: Date.now()
    };
    if (this.room?.save?.key) {
      this.persistSaveAnchor({ sessionKey: this.room.save.key, conversationId: preparedConversationId, name: activeName, role: "guest" });
      this.room.save.conversationId = preparedConversationId;
      this.room.save.name = activeName;
    }
    const gameReady = await this.applyGameIsolation(true);
    this.appendSessionLog("guest-sync", { event: "completed", round: result.round, conversationId: preparedConversationId, gameReady });
    return { conversation: this.conversation, gameReady };
  }

  async syncGuestRoundResultWithRetries(result, { maxAttempts = 4 } = {}) {
    let lastError = null;
    const attempts = Math.max(1, Number(maxAttempts) || 1);
    await this.suspendGameSurfacePresentation();
    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        this.appendSessionLog("guest-sync-retry", {
          event: "attempt-started",
          round: result?.round,
          attempt,
          maxAttempts: attempts
        });
        this.emit({ roundSyncAttempt: { attempt, maxAttempts: attempts } });
        try {
          const synced = await this.syncGuestRoundResult(result, { retryAttempt: attempt });
          this.appendSessionLog("guest-sync-retry", {
            event: "attempt-succeeded",
            round: result?.round,
            attempt,
            maxAttempts: attempts,
            conversationId: synced?.conversation?.activeId || null
          });
          return synced;
        } catch (error) {
          lastError = error;
          this.appendSessionLog("guest-sync-retry", {
            event: "attempt-failed",
            round: result?.round,
            attempt,
            maxAttempts: attempts,
            error: error?.message || String(error)
          });
          if (attempt >= attempts) break;
          const outputMismatch = /输出.*不一致|没有保存房主输出|编辑.*失败|编辑框没有完整写入|保存.*超时/.test(error?.message || "");
          if (outputMismatch) {
            const syncKey = `${this.room?.id || "room"}:${Number(result?.round)}`;
            await this.gameSurface.webContents.executeJavaScript(`(() => {
              const state = window.__fympRoundSyncStates?.[${JSON.stringify(syncKey)}];
              if (!state) return false;
              state.saved = false;
              return true;
            })()`, true).catch(() => false);
            this.appendSessionLog("guest-sync-retry", { event: "edit-state-reset", round: result?.round, attempt });
          }
          await this.clearGameIsolation().catch(() => {});
          const backoffMs = [900, 1800, 3200][Math.min(attempt - 1, 2)];
          this.emit({ roundSyncRetrying: { attempt: attempt + 1, maxAttempts: attempts, delayMs: backoffMs, error: error?.message || String(error) } });
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
      throw new Error(`访客同步已重试 ${attempts} 次仍未成功：${lastError?.message || String(lastError || "未知错误")}`);
    } finally {
      await this.applyGameIsolation(false).catch(() => false);
      this.resumeGameSurfacePresentation();
    }
  }

  async prepareGuestSaveAnchor(sessionKey, name) {
    if (!sessionKey || !this.work?.url) throw new Error("房主没有提供有效的会话锚点");
    this.appendSessionLog("guest-anchor", { event: "guest-anchor-prepare-started", sessionKey, workSuffix: this.work.suffix });
    this.keepGameSurfaceResident();
    // The capture hook was installed while the permanent game window was still
    // blank. Await only its installation here; it does not create a conversation
    // and therefore remains safe during anchor preparation.
    await this.gameNetworkCaptureReady.catch(() => false);
    const stored = this.storedSession(sessionKey);
    let sameWork = stored?.workSuffix === this.work.suffix;
    if (!sameWork && stored?.workSuffix) {
      try {
        sameWork = parseInviteWork(stored.workSuffix, this.origin).id === parseInviteWork(this.work.suffix, this.origin).id;
      } catch {}
    }
    if (sameWork && stored?.conversationId) {
      try {
        // The locally persisted UUID is the anchor. Do not wait for the
        // platform's full conversation list while a guest is joining.
        await this.setPlatformConversationId(stored.conversationId);
        const activeName = stored.name || name || "房主会话";
        this.conversation = {
          ...this.conversation,
          items: [{ id: stored.conversationId, name: activeName, active: true }],
          activeId: stored.conversationId,
          activeName,
          sessionKey,
          anchorRole: "guest",
          anchored: true,
          hasChat: true,
          source: "local-anchor",
          updatedAt: Date.now()
        };
        this.persistSaveAnchor({ sessionKey, conversationId: stored.conversationId, name: activeName, role: "guest" });
        if (this.room?.save) {
          this.room.save.conversationId = stored.conversationId;
          this.room.save.name = activeName;
        }
        this.appendSessionLog("guest-anchor", { event: "stored-conversation-reused", sessionKey, conversationId: stored.conversationId });
        return { resumed: true, conversationId: stored.conversationId };
      } catch (error) {
        this.appendSessionLog("guest-anchor", {
          event: "stored-conversation-restore-failed",
          sessionKey,
          conversationId: stored.conversationId,
          error: error?.message || String(error)
        });
      }
    }

    const created = await this.createBlankPlatformConversation();
    if (!created?.created) throw new Error(`访客端无法建立新会话：${created?.detail || "平台当前会话状态重置失败"}`);
    this.adoptPendingConversation(created, sessionKey, "guest", name || "房主会话");
    this.appendSessionLog("guest-anchor", { event: "new-conversation-pending", sessionKey, name: this.conversation.activeName });
    if (this.room?.save) {
      this.room.save.conversationId = this.conversation.activeId;
      this.room.save.name = this.conversation.activeName || name || this.room.save.name;
    }
    return { resumed: false, conversationId: null };
  }

  async announceGuestAnchor(prepared = {}) {
    if (!this.room || this.room.role !== "guest" || !this.room.save?.key) throw new Error("访客会话锚点尚未准备完成");
    this.room.historySync = {
      status: "announcing",
      current: 0,
      total: 0,
      error: null,
      requestAttempt: 1,
      lastRequestAt: Date.now(),
      resumed: Boolean(prepared.resumed)
    };
    try {
      await this.sendRoomPacket(this.room.hostChatId, makePacket("anchor-ready", this.room.id, this.room.profile.id, ++this.seq, {
        saveKey: this.room.save.key,
        conversationId: this.conversation.activeId || null,
        resumed: Boolean(prepared.resumed)
      }));
    } catch (error) {
      // Keep the state as "announcing". pollRoomProtocol will retry this same
      // stable anchor instead of creating another guest conversation.
      this.appendSessionLog("guest-anchor", {
        event: "guest-anchor-initial-send-failed",
        sessionKey: this.room.save.key,
        error: error?.message || String(error)
      });
      this.emit({ protocolError: `会话锚点发送失败，后台将自动重试：${error?.message || String(error)}` });
      return false;
    }
    this.appendSessionLog("guest-anchor", {
      event: "guest-anchor-announced",
      sessionKey: this.room.save.key,
      conversationId: this.conversation.activeId || null,
      resumed: Boolean(prepared.resumed)
    });
    this.emit({ guestAnchorAnnounced: true });
    return true;
  }

  async pollRoomProtocol() {
    if (this.roomPollBusy || !this.loggedIn || !this.room) return;
    const polledRoom = this.room;
    if (Date.now() < Number(this.roomPollNotBefore || 0)) return;
    if (polledRoom.role === "guest" && polledRoom.status === "joining" && Date.now() - polledRoom.createdAt > 60000) {
      polledRoom.status = "join-error";
      polledRoom.error = "等待房主认证超时。请确认房主工具仍在运行，然后退出房间并重试。";
      this.emit({ joinError: polledRoom.error });
      return;
    }
    if (
      polledRoom.role === "guest" &&
      polledRoom.status === "waiting" &&
      polledRoom.historySync?.status === "announcing" &&
      Date.now() - Number(polledRoom.historySync.lastRequestAt || 0) > 10000
    ) {
      const requestAttempt = Number(polledRoom.historySync.requestAttempt || 1);
      if (requestAttempt >= 6) {
        polledRoom.historySync.status = "error";
        polledRoom.historySync.error = "房主未确认会话锚点，已自动重试 6 次";
        polledRoom.error = polledRoom.historySync.error;
        this.appendSessionLog("guest-anchor", { event: "guest-anchor-announce-exhausted", attempts: requestAttempt });
        this.emit({ historySyncError: polledRoom.historySync.error });
        return;
      }
      polledRoom.historySync.requestAttempt = requestAttempt + 1;
      polledRoom.historySync.lastRequestAt = Date.now();
      this.appendSessionLog("guest-anchor", { event: "guest-anchor-announce-retry", attempt: requestAttempt + 1 });
      try {
        await this.sendRoomPacket(polledRoom.hostChatId, makePacket("anchor-ready", polledRoom.id, polledRoom.profile.id, ++this.seq, {
          saveKey: polledRoom.save.key,
          conversationId: this.conversation.activeId || null,
          resumed: Boolean(polledRoom.historySync.resumed)
        }));
        this.emit({ historySyncRetrying: true });
      } catch (error) {
        this.appendSessionLog("guest-anchor", { event: "guest-anchor-announce-send-failed", attempt: requestAttempt + 1, error: error?.message || String(error) });
        this.emit({ protocolError: `会话锚点重试发送失败：${error?.message || String(error)}` });
      }
    }
    if (
      polledRoom.role === "guest" &&
      polledRoom.status === "waiting" &&
      polledRoom.chat?.pending &&
      polledRoom.chat.pending.status !== "error" &&
      Date.now() - Number(polledRoom.chat.pending.lastSentAt || 0) > 5000
    ) {
      await this.sendPendingRoomChat();
      if (this.room !== polledRoom) return;
    }
    if (
      polledRoom.role === "host" &&
      polledRoom.chat?.syncStatus === "retrying" &&
      Date.now() - Number(polledRoom.chat.lastBroadcastAt || 0) > 5000
    ) {
      await this.broadcastPendingRoomChatMessages();
      if (this.room !== polledRoom) return;
    }
    if (
      polledRoom.role === "guest" &&
      polledRoom.status === "waiting" &&
      polledRoom.chat?.syncStatus === "recovering" &&
      Date.now() - Number(polledRoom.chat.lastRecoveryRequestAt || 0) > 5000
    ) {
      await this.requestRoomChatSnapshot("revision-gap-retry");
      if (this.room !== polledRoom) return;
    }
    this.roomPollBusy = true;
    let pollHadActivity = false;
    let pollFailed = false;
    try {
      const chats = await this.listPrivateChats();
      if (this.room !== polledRoom) return;
      let targets;
      if (polledRoom.role === "guest") {
        targets = chats.filter(chat => String(chat.id) === String(polledRoom.hostChatId));
      } else {
        const protocolChats = chats.filter(chat => String(
          chat?.preview_content || chat?.last_message?.content || chat?.last_message || chat?.latest_message?.content || ""
        ).includes(WIRE_PREFIX));
        targets = protocolChats.length ? protocolChats.slice(0, 50) : chats.slice(0, 16);
      }
      const envelopes = [];
      const platformTime = (message, packet) => {
        const raw = message?.created_at ?? message?.createdAt ?? message?.timestamp ?? null;
        const numeric = Number(raw);
        if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
        const parsed = Date.parse(String(raw || ""));
        return Number.isFinite(parsed) ? parsed : Number(packet?.ts || Date.now());
      };
      for (const chat of targets) {
        if (!chat?.id) continue;
        const payload = await this.platformChatApi(`/chats/messages?chat_id=${encodeURIComponent(chat.id)}&page=1&limit=500`);
        if (this.room !== polledRoom) return;
        const messages = Array.isArray(payload?.messages) ? payload.messages : Array.isArray(payload?.data?.messages) ? payload.data.messages : [];
        for (const message of messages) {
          const raw = String(message?.content || "");
          const packet = decodeWirePacket(raw);
          if (!packet || this.seenPackets.has(packet.id)) continue;
          envelopes.push({ chat, message, raw, packet, receivedAt: platformTime(message, packet) });
        }
      }
      envelopes.sort((left, right) => left.receivedAt - right.receivedAt || Number(left.packet.seq || 0) - Number(right.packet.seq || 0) || String(left.packet.id).localeCompare(String(right.packet.id)));
      pollHadActivity = envelopes.length > 0;
      for (const { chat, message, raw, packet, receivedAt } of envelopes) {
          const packetTime = Number(packet.ts || 0);
          if (packetTime && packetTime < polledRoom.createdAt - 5000) {
            this.rememberSeenPacket(packet.id);
            continue;
          }
          if (String(packet.from) === String(this.account.accountId)) {
            this.rememberSeenPacket(packet.id);
            this.appendSessionLog("protocol-echo", { chatId: String(chat.id), messageId: message?.id || null, raw, packet });
            continue;
          }
          this.appendSessionLog("protocol-receive", {
            chatId: String(chat.id), messageId: message?.id || null, messageCreatedAt: message?.created_at || message?.createdAt || null, raw, packet
          });
          try {
            await this.handleRoomPacket(packet, String(chat.id), { receivedAt, chat });
            this.rememberSeenPacket(packet.id);
            this.appendSessionLog("protocol-handled", { chatId: String(chat.id), packetId: packet.id, type: packet.type });
          } catch (error) {
            const detail = error?.message || String(error);
            if (this.room?.role === "guest" && ["join-accept", "conversation-anchor"].includes(packet.type)) {
              this.room.historySync ||= { status: "error", current: 0, total: 0, error: null };
              this.room.historySync.status = "error";
              this.room.historySync.error = detail;
            }
            this.appendSessionLog("protocol-handle-error", { chatId: String(chat.id), packet, error: detail });
            this.emit({ protocolError: detail });
            throw error;
          }
      }
    } catch (error) {
      pollFailed = true;
      this.appendSessionLog("protocol-poll-error", { error: error?.message || String(error) });
    }
    finally {
      this.roomPollBusy = false;
      this.roomPollIdleCount = pollHadActivity ? 0 : Math.min(10, Number(this.roomPollIdleCount || 0) + 1);
      const delay = pollFailed ? 2000 : this.roomPollIdleCount < 4 ? 750 : Math.min(2500, 1000 + (this.roomPollIdleCount - 3) * 500);
      this.roomPollNotBefore = Date.now() + delay;
    }
  }

  async handleRoomPacket(packet, chatId, context = {}) {
    if (!this.room) return;
    const packetTime = Number(packet.ts || 0);
    if (packetTime && packetTime < this.room.createdAt - 5000) return;
    this.appendSessionLog("protocol-dispatch", { chatId: String(chatId), packet });
    if (packet.type === "chunk") return this.handleChunkPacket(packet, chatId);
    if (packet.type === "hello" && this.room.role === "host" && this.room.status === "waiting") {
      const profile = packet.payload?.profile;
      const remoteAccountId = String(context.chat?.other_account?.id || "").trim();
      if (!remoteAccountId || remoteAccountId !== String(packet.from)) return;
      if (!profile?.id || !profile?.displayName || String(profile.id) !== String(packet.from)) return;
      if (String(profile.displayName).length > 80 || String(profile.platformName || "").length > 200
        || String(profile.basicInfo || "").length > 20000 || String(profile.appearance || "").length > 10000
        || String(profile.info || "").length > 32000) return;
      const guestVersion = String(packet.payload?.appVersion || "").trim();
      if (guestVersion !== this.appVersion) {
        await this.sendRoomPacket(chatId, makePacket("error", this.room.id, this.account.accountId || this.profileId, ++this.seq, {
          code: "VERSION_MISMATCH",
          message: `联机版本不一致：房主为 v${this.appVersion}，访客为 ${guestVersion ? `v${guestVersion}` : "旧版或未知版本"}。请在访客端更新风月联机工具后重试。`,
          hostVersion: this.appVersion,
          guestVersion: guestVersion || null,
          officialReleasePage: OFFICIAL_RELEASE_PAGE
        }));
        this.appendSessionLog("room-version", { event: "guest-rejected", hostVersion: this.appVersion, guestVersion: guestVersion || null, memberId: String(packet.from) });
        return;
      }
      if (this.room.removedMemberIds?.has(String(profile.id))) {
        await this.sendRoomPacket(chatId, makePacket("error", this.room.id, this.account.accountId || this.profileId, ++this.seq, { code: "REMOVED_FROM_ROOM", message: "你已被房主移出房间" }));
        return;
      }
      if (this.room.gameStarted) {
        await this.sendRoomPacket(chatId, makePacket("error", this.room.id, this.account.accountId || this.profileId, ++this.seq, { code: "GAME_STARTED", message: "房主已经开始游玩，本局不再接纳新成员" }));
        return;
      }
      if (String(packet.payload?.inviteAppId || "") !== String(this.room.inviteAppId || "")) {
        await this.sendRoomPacket(chatId, makePacket("error", this.room.id, this.account.accountId || this.profileId, ++this.seq, { code: "INVITE_EXPIRED", message: "该私人作品链接不属于房主当前房间，请向房主获取最新邀请链接" }));
        return;
      }
      for (const [memberId, pending] of this.pendingChallenges) {
        if (Date.now() - Number(pending.createdAt || 0) > 2 * 60 * 1000) this.pendingChallenges.delete(memberId);
      }
      if (!this.pendingChallenges.has(String(packet.from)) && this.pendingChallenges.size >= 200) return;
      const challenge = crypto.randomUUID();
      const authScheme = Array.isArray(packet.payload?.authSchemes)
        && packet.payload.authSchemes.includes("scrypt-v2")
        && this.room.passwordVerifierV2
        ? "scrypt-v2"
        : "sha256-v1";
      this.pendingChallenges.set(String(packet.from), { challenge, profile, chatId, authScheme, appVersion: guestVersion, createdAt: Date.now() });
      await this.sendRoomPacket(chatId, makePacket("challenge", this.room.id, this.account.accountId || this.profileId, ++this.seq, {
        challenge,
        authScheme,
        appVersion: this.appVersion
      }));
      return;
    }
    if (packet.type === "challenge" && this.room.role === "guest") {
      const challenge = packet.payload?.challenge;
      if (!challenge || !this.room.passwordVerifier || String(packet.from) !== String(this.room.hostAccountId) || String(chatId) !== String(this.room.hostChatId)) return;
      const hostVersion = String(packet.payload?.appVersion || "").trim();
      if (hostVersion !== this.appVersion) {
        this.room.status = "join-error";
        this.room.peerVersion = hostVersion || null;
        this.room.versionMismatch = { hostVersion: hostVersion || null, guestVersion: this.appVersion, updateRequired: true };
        this.room.error = `联机版本不一致：房主为 ${hostVersion ? `v${hostVersion}` : "旧版或未知版本"}，当前访客端为 v${this.appVersion}。请更新访客端风月联机工具至最新官方版本后重试。`;
        this.emit({ joinError: this.room.error, versionMismatch: this.room.versionMismatch });
        return;
      }
      const authScheme = packet.payload?.authScheme === "scrypt-v2" ? "scrypt-v2" : "sha256-v1";
      const verifier = authScheme === "scrypt-v2" ? this.room.passwordVerifierV2 : this.room.passwordVerifier;
      if (!verifier) return;
      const profileJson = JSON.stringify(this.room.profile);
      const proof = sha256Base64Url(`${verifier}\0${packet.roomId}\0${challenge}\0${profileJson}`);
      this.room.id = packet.roomId;
      this.room.peerVersion = hostVersion;
      await this.sendRoomPacket(chatId, makePacket("join-proof", packet.roomId, this.room.profile.id, ++this.seq, {
        challenge,
        profile: this.room.profile,
        proof,
        authScheme,
        appVersion: this.appVersion
      }));
      this.emit();
      return;
    }
    if (packet.type === "join-proof" && this.room.role === "host") {
      const pending = this.pendingChallenges.get(String(packet.from));
      const profile = packet.payload?.profile;
      if (!pending || Date.now() - Number(pending.createdAt || 0) > 2 * 60 * 1000 || !profile
        || String(profile.id) !== String(packet.from) || JSON.stringify(profile) !== JSON.stringify(pending.profile)
        || String(pending.chatId) !== String(chatId) || packet.roomId !== this.room.id || packet.payload?.challenge !== pending.challenge) return;
      if (pending.appVersion !== this.appVersion || String(packet.payload?.appVersion || "") !== this.appVersion) {
        await this.sendRoomPacket(chatId, makePacket("error", this.room.id, this.account.accountId || this.profileId, ++this.seq, {
          code: "VERSION_MISMATCH",
          message: `联机版本不一致。请在访客端更新风月联机工具至 v${this.appVersion} 后重试。`,
          hostVersion: this.appVersion,
          guestVersion: String(packet.payload?.appVersion || "") || null,
          officialReleasePage: OFFICIAL_RELEASE_PAGE
        }));
        this.pendingChallenges.delete(String(packet.from));
        return;
      }
      const verifier = pending.authScheme === "scrypt-v2" ? this.room.passwordVerifierV2 : this.room.passwordVerifier;
      const expected = sha256Base64Url(`${verifier}\0${this.room.id}\0${pending.challenge}\0${JSON.stringify(profile)}`);
      if (packet.payload?.proof !== expected) {
        await this.sendRoomPacket(chatId, makePacket("error", this.room.id, this.account.accountId || this.profileId, ++this.seq, { code: "AUTH_FAILED", message: "房间密码错误" }));
        this.pendingChallenges.delete(String(packet.from));
        return;
      }
      const duplicateName = this.room.members.find(member => String(member.id) !== String(profile.id) && String(member.displayName || "").trim().toLocaleLowerCase() === String(profile.displayName || "").trim().toLocaleLowerCase());
      if (duplicateName) {
        await this.sendRoomPacket(chatId, makePacket("error", this.room.id, this.account.accountId || this.profileId, ++this.seq, { code: "DISPLAY_NAME_CONFLICT", message: `设定名“${profile.displayName}”已被房间成员使用，请修改设定名后重新加入` }));
        this.pendingChallenges.delete(String(packet.from));
        return;
      }
      const wasExisting = this.room.members.some(member => String(member.id) === String(profile.id));
      const existingMemberChatIds = [...new Set(Object.values(this.room.memberChatIds || {}).map(String).filter(Boolean))];
      this.room.members = [...this.room.members.filter(member => String(member.id) !== String(profile.id)), profile];
      this.room.memberCount = this.room.members.length;
      if (!wasExisting) this.room.rosterRevision = Number(this.room.rosterRevision || 0) + 1;
      this.room.promptSync = { status: "pending", updatedAt: null, memberCount: this.room.members.length, error: null };
      this.room.memberChatIds[String(profile.id)] = String(chatId);
      this.pendingChallenges.delete(String(packet.from));
      await this.sendRoomPacket(chatId, makePacket("join-accept", this.room.id, this.account.accountId || this.profileId, ++this.seq, {
        workSuffix: this.room.work.suffix,
        workTitle: this.room.work.title,
        members: this.room.members,
        rosterRevision: Number(this.room.rosterRevision || 0),
        appVersion: this.appVersion,
        saveKey: this.room.save?.key,
        saveName: this.room.save?.name || "新会话",
        model: this.room.model || this.modelPublicValue(this.platformModels.selected),
        plugins: this.room.plugins || this.publicPluginSettings()
      }));
      await this.sendLargeRoomPacket(chatId, "work-settings-sync", this.room.id, { workSettings: this.workSettings });
      const memberChats = [...new Set(Object.values(this.room.memberChatIds))];
      await Promise.allSettled(memberChats.map(memberChatId => this.sendRoomPacket(memberChatId, makePacket(
        "members-sync",
        this.room.id,
        this.account.accountId || this.profileId,
        ++this.seq,
        { revision: Number(this.room.rosterRevision || 0), members: this.room.members }
      ))));
      if (!wasExisting) {
        const joinedEvent = {
          id: crypto.randomUUID(),
          member: {
            id: String(profile.id),
            platformName: String(profile.platformName || ""),
            displayName: String(profile.displayName || profile.platformName || "新成员")
          },
          revision: Number(this.room.rosterRevision || 0),
          at: Date.now()
        };
        await Promise.allSettled(existingMemberChatIds.map(memberChatId => this.sendRoomPacketWithRetries(
          memberChatId,
          makePacket("member-joined", this.room.id, this.account.accountId || this.profileId, ++this.seq, joinedEvent),
          3
        )));
        this.emit({ memberJoined: joinedEvent.member });
      }
      await this.sendLargeRoomPacket(chatId, "room-chat-sync", this.room.id, this.roomChatPayload()).catch(error => {
        this.appendSessionLog("room-chat", { event: "join-full-list-send-failed", memberId: String(profile.id), chatId: String(chatId), error: error?.message || String(error) });
      });
      this.emit();
      return;
    }
    if (packet.type === "join-accept" && this.room.role === "guest") {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      const hostVersion = String(packet.payload?.appVersion || "").trim();
      if (hostVersion !== this.appVersion) {
        this.room.status = "join-error";
        this.room.peerVersion = hostVersion || null;
        this.room.versionMismatch = { hostVersion: hostVersion || null, guestVersion: this.appVersion, updateRequired: true };
        this.room.error = `联机版本不一致：房主为 ${hostVersion ? `v${hostVersion}` : "旧版或未知版本"}，当前访客端为 v${this.appVersion}。请更新访客端风月联机工具至最新官方版本后重试。`;
        this.emit({ joinError: this.room.error, versionMismatch: this.room.versionMismatch });
        return;
      }
      this.room.id = packet.roomId;
      this.room.status = "waiting";
      this.room.error = null;
      this.room.peerVersion = hostVersion;
      this.room.work = { title: packet.payload?.workTitle || "已加入房间", suffix: packet.payload?.workSuffix || "" };
      this.room.save = { key: String(packet.payload?.saveKey || ""), conversationId: null, name: packet.payload?.saveName || "房主会话" };
      this.room.model = packet.payload?.model ? this.modelPublicValue(packet.payload.model) : null;
      this.room.plugins = normalizePluginSettings(packet.payload?.plugins);
      this.platformModels.hostSelected = this.room.model;
      this.room.historySync = { status: "preparing", current: 0, total: 0, error: null };
      this.room.members = Array.isArray(packet.payload?.members) ? packet.payload.members : this.room.members;
      this.room.memberCount = this.room.members.length;
      this.room.rosterRevision = Number(packet.payload?.rosterRevision || this.room.rosterRevision || 0);
      if (this.isWorkUrl(this.room.work.suffix)) {
        this.conversation = { items: [], activeId: null, activeName: null, sessionKey: null, anchorRole: null, anchored: false, hasChat: false, updatedAt: null };
        this.work = {
          url: platformUrlForOrigin(this.origin, this.room.work.suffix).href,
          suffix: this.room.work.suffix,
          title: this.room.work.title
        };
      }
      // Introduction and game are separate, persistent WebContentsViews. Start
      // the intro in parallel, but never let it gate the game conversation.
      void this.prepareGuestIntroSurface().catch(error => {
        this.appendSessionLog("guest-anchor", { event: "guest-intro-background-failed", error: error?.message || String(error) });
      });
      const prepared = await this.prepareGuestSaveAnchor(this.room.save.key, this.room.save.name);
      await this.ensureValidPlatformModelWithRetries(3);
      await this.announceGuestAnchor(prepared);
      this.emit({ joinAccepted: true });
      return;
    }
    if (packet.type === "room-chat-submit" && this.room.role === "host" && packet.roomId === this.room.id && this.room.status === "waiting") {
      await this.acceptRoomChatSubmission({
        senderId: packet.from,
        clientMessageId: packet.payload?.clientMessageId,
        text: packet.payload?.text,
        clientSentAt: packet.payload?.clientSentAt,
        clientSentAtIso: packet.payload?.clientSentAtIso,
        receivedAt: Number(context.receivedAt || Date.now()),
        chatId
      });
      return;
    }
    if (packet.type === "room-chat-sync-request" && this.room.role === "host" && packet.roomId === this.room.id && this.room.status === "waiting") {
      const member = this.room.members.find(item => String(item.id) === String(packet.from));
      const expectedChatId = this.room.memberChatIds?.[String(packet.from)];
      if (!member || !expectedChatId || String(expectedChatId) !== String(chatId)) return;
      try {
        await this.sendLargeRoomPacket(chatId, "room-chat-sync", this.room.id, this.roomChatPayload());
        this.appendSessionLog("room-chat", {
          event: "recovery-snapshot-sent",
          memberId: String(packet.from),
          requestedRevision: Number(packet.payload?.revision || 0),
          revision: Number(this.room.chat?.revision || 0),
          messageCount: Number(this.room.chat?.messages?.length || 0)
        });
      } catch (error) {
        this.appendSessionLog("room-chat", { event: "recovery-snapshot-send-failed", memberId: String(packet.from), error: error?.message || String(error) });
      }
      return;
    }
    if (packet.type === "room-chat-append" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      this.room.chat ||= { revision: 0, messages: [], pending: null, pendingBroadcasts: [], syncStatus: "ready", error: null, lastBroadcastAt: 0, broadcastAttempts: 0, lastRecoveryRequestAt: 0, recoveryRequestAttempts: 0 };
      const chat = this.room.chat;
      const revision = Number(packet.payload?.revision);
      const message = this.parseRoomChatMessage(packet.payload?.message);
      if (!Number.isInteger(revision) || revision < 1 || !message) return;
      const known = chat.messages.find(item => String(item.id) === message.id || (
        String(item.senderId) === message.senderId && String(item.clientMessageId) === message.clientMessageId
      ));
      if (known) {
        if (chat.pending && message.senderId === String(this.room.profile.id) && message.clientMessageId === String(chat.pending.clientMessageId)) chat.pending = null;
        if (revision <= Number(chat.revision || 0)) {
          chat.syncStatus = "ready";
          chat.error = null;
          this.emit({ roomChatUpdated: true });
          return;
        }
      }
      const expectedRevision = Number(chat.revision || 0) + 1;
      if (known || revision !== expectedRevision || message.revision !== revision) {
        this.appendSessionLog("room-chat", {
          event: "append-gap-detected",
          currentRevision: Number(chat.revision || 0),
          incomingRevision: revision,
          messageRevision: message.revision
        });
        await this.requestRoomChatSnapshot("revision-gap");
        return;
      }
      chat.messages.push(message);
      chat.messages.sort((left, right) => this.compareRoomChatMessages(left, right));
      this.trimRoomChatHistory(chat);
      chat.revision = revision;
      chat.syncStatus = "ready";
      chat.error = null;
      chat.recoveryRequestAttempts = 0;
      chat.lastRecoveryRequestAt = 0;
      if (chat.pending && message.senderId === String(this.room.profile.id) && message.clientMessageId === String(chat.pending.clientMessageId)) chat.pending = null;
      this.appendSessionLog("room-chat", { event: "guest-append-received", revision, message });
      this.emit({ roomChatUpdated: true });
      return;
    }
    if (packet.type === "room-chat-sync" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      const revision = Number(packet.payload?.revision);
      const incoming = Array.isArray(packet.payload?.messages) ? packet.payload.messages : null;
      if (!Number.isInteger(revision) || revision < 0 || !incoming) return;
      this.room.chat ||= { revision: 0, messages: [], pending: null, pendingBroadcasts: [], syncStatus: "ready", error: null, lastBroadcastAt: 0, broadcastAttempts: 0, lastRecoveryRequestAt: 0, recoveryRequestAttempts: 0 };
      if (revision < Number(this.room.chat.revision || 0)) return;
      const unique = new Map();
      for (const value of incoming) {
        const message = this.parseRoomChatMessage(value);
        if (message) unique.set(message.id, message);
      }
      const messages = [...unique.values()].sort((left, right) => this.compareRoomChatMessages(left, right)).slice(-1000);
      this.room.chat.messages = messages;
      this.room.chat.revision = revision;
      this.room.chat.syncStatus = "ready";
      this.room.chat.error = null;
      this.room.chat.recoveryRequestAttempts = 0;
      this.room.chat.lastRecoveryRequestAt = 0;
      if (this.room.chat.pending && messages.some(message =>
        message.senderId === String(this.room.profile.id) && message.clientMessageId === String(this.room.chat.pending.clientMessageId)
      )) this.room.chat.pending = null;
      this.appendSessionLog("room-chat", { event: "guest-full-list-received", revision, messageCount: messages.length });
      this.emit({ roomChatUpdated: true });
      return;
    }
    if (packet.type === "model-sync" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId) || !packet.payload?.model) return;
      this.room.model = this.modelPublicValue(packet.payload.model);
      this.platformModels.hostSelected = this.room.model;
      this.appendSessionLog("model", { event: "host-model-received", model: this.room.model });
      this.emit({ hostModelChanged: true });
      return;
    }
    if (packet.type === "work-settings-sync" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      this.room.workSettings = packet.payload?.workSettings || null;
      this.emit({ workSettingsUpdated: true });
      return;
    }
    if (packet.type === "plugin-settings-sync" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      this.room.plugins = normalizePluginSettings(packet.payload?.plugins);
      this.appendSessionLog("plugin-settings", { event: "host-settings-received", plugins: this.room.plugins });
      this.emit({ pluginSettingsUpdated: true });
      return;
    }
    if (packet.type === "message-operation" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      const payload = packet.payload || {};
      const operationId = String(payload.operationId || "");
      const action = String(payload.action || "");
      if (!operationId || !["refresh", "edit", "delete"].includes(action)) return;
      this.room.messageOperation = { id: operationId, action, status: "syncing", pendingGuestIds: [], acks: {}, error: null };
      this.mode = "guest-syncing";
      this.emit({ messageOperationSyncing: true });
      try {
        await this.syncGuestMessageOperation(payload, { maxAttempts: 4 });
        const previous = this.room.round?.lastResult || {};
        if (this.room.round) this.room.round.lastResult = action === "delete"
          ? { ...previous, round: Number(payload.round || previous.round || 0), output: "", deleted: true, completedAt: Number(payload.completedAt || Date.now()) }
          : { ...previous, round: Number(payload.round || previous.round || 0), output: String(payload.output || ""), model: payload.model || previous.model || "", points: payload.points || previous.points, pluginRuns: payload.pluginRuns || previous.pluginRuns, perspectiveSplit: Boolean(payload.perspectiveSplit), deleted: false, completedAt: Number(payload.completedAt || Date.now()) };
        this.room.messageOperation.status = "completed";
        this.mode = "game";
        await this.applyGameIsolation(false);
        if (this.room.round?.lastResult) await this.injectConversationPluginCards(this.room.round.lastResult);
        await this.captureGameFrame(true);
        await this.sendRoomPacket(this.room.hostChatId, makePacket("message-operation-ack", this.room.id, this.room.profile.id, ++this.seq, {
          operationId,
          action,
          status: "ready",
          completedAt: Date.now()
        }));
        this.emit({ messageOperationCompleted: true });
      } catch (error) {
        const message = error?.message || String(error);
        this.room.messageOperation.status = "error";
        this.room.messageOperation.error = message;
        this.mode = "game";
        await this.sendRoomPacket(this.room.hostChatId, makePacket("message-operation-ack", this.room.id, this.room.profile.id, ++this.seq, {
          operationId,
          action,
          status: "error",
          message,
          completedAt: Date.now()
        })).catch(() => {});
        this.emit({ messageOperationError: message });
      }
      return;
    }
    if (packet.type === "message-operation-ack" && this.room.role === "host" && packet.roomId === this.room.id) {
      const operation = this.room.messageOperation;
      const member = this.room.members.find(item => String(item.id) === String(packet.from));
      const expectedChatId = this.room.memberChatIds?.[String(packet.from)];
      if (!operation || !member || !expectedChatId || String(expectedChatId) !== String(chatId) || String(packet.payload?.operationId || "") !== String(operation.id)) return;
      operation.acks[String(member.id)] = {
        status: packet.payload?.status === "ready" ? "ready" : "error",
        message: packet.payload?.message || null,
        completedAt: Number(packet.payload?.completedAt || Date.now())
      };
      const failures = Object.values(operation.acks).filter(item => item?.status === "error");
      const allReady = operation.pendingGuestIds.every(memberId => operation.acks[String(memberId)]?.status === "ready");
      operation.status = failures.length ? "error" : allReady ? "completed" : "syncing";
      operation.error = failures[0]?.message || null;
      this.appendSessionLog("message-operation", { event: "host-ack", operationId: operation.id, memberId: String(member.id), acknowledgement: operation.acks[String(member.id)] });
      this.emit(operation.status === "completed" ? { messageOperationCompleted: true } : operation.status === "error" ? { messageOperationError: operation.error } : {});
      return;
    }
    if (packet.type === "member-joined" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      const member = packet.payload?.member;
      if (!member?.id || String(member.id) === String(this.room.profile?.id)) return;
      this.emit({ memberJoined: {
        id: String(member.id),
        platformName: String(member.platformName || ""),
        displayName: String(member.displayName || member.platformName || "新成员")
      } });
      return;
    }
    if (packet.type === "member-removed" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId) || String(chatId) !== String(this.room.hostChatId)
        || String(packet.payload?.memberId || "") !== String(this.room.profile?.id || "")) return;
      const message = String(packet.payload?.message || "你已被房主移出房间");
      this.appendSessionLog("room-member", { event: "removed-by-host", roomId: this.room.id, message });
      this.clearRoomSession({ removedFromRoom: { message } });
      return;
    }
    if (packet.type === "room-closed" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId) || String(chatId) !== String(this.room.hostChatId)) return;
      const closedRoomId = this.room.id;
      const message = String(packet.payload?.message || "房主已解散房间，你已退出当前房间");
      this.appendSessionLog("room-close", { event: "closed-by-host", roomId: closedRoomId, message });
      this.clearRoomSession({ roomClosed: { message, roomId: closedRoomId, closedAt: Number(packet.payload?.closedAt || Date.now()) } });
      return;
    }
    if (packet.type === "members-sync" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId) || !Array.isArray(packet.payload?.members)) return;
      const revision = Number(packet.payload?.revision || 0);
      if (revision && revision < Number(this.room.rosterRevision || 0)) return;
      this.room.members = packet.payload.members;
      this.room.memberCount = this.room.members.length;
      if (revision) this.room.rosterRevision = revision;
      this.emit();
      return;
    }
    if (packet.type === "conversation-anchor" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      const saveKey = String(packet.payload?.saveKey || "");
      if (!saveKey) return;
      this.room.save = { key: saveKey, conversationId: null, name: packet.payload?.saveName || "房主会话" };
      this.room.round = this.newRound(1, this.room.round?.lastResult || null);
      this.room.historySync = { status: "preparing", current: 0, total: 0, error: null };
      this.mode = "game-empty";
      this.detachSurface();
      this.emit({ guestAnchorPreparing: true });
      const prepared = await this.prepareGuestSaveAnchor(this.room.save.key, this.room.save.name);
      await this.ensureValidPlatformModelWithRetries(3);
      await this.announceGuestAnchor(prepared);
      return;
    }
    if (packet.type === "anchor-ready" && this.room.role === "host" && packet.roomId === this.room.id) {
      const member = this.room.members.find(item => String(item.id) === String(packet.from));
      const expectedChatId = this.room.memberChatIds?.[String(packet.from)];
      if (!member || !expectedChatId || String(expectedChatId) !== String(chatId) || String(packet.payload?.saveKey || "") !== String(this.room.save?.key || "")) return;
      this.room.memberHistory[String(member.id)] = "ready";
      this.appendSessionLog("guest-anchor", {
        event: "host-confirmed-guest-anchor",
        memberId: String(member.id),
        sessionKey: this.room.save.key,
        guestConversationId: packet.payload?.conversationId || null,
        resumed: Boolean(packet.payload?.resumed)
      });
      await this.sendRoomPacket(chatId, makePacket("anchor-ready", this.room.id, this.account.accountId || this.profileId, ++this.seq, {
        saveKey: this.room.save.key,
        ack: true
      }));
      this.emit();
      return;
    }
    if (packet.type === "anchor-ready" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId) || !packet.payload?.ack || String(packet.payload?.saveKey || "") !== String(this.room.save?.key || "")) return;
      this.room.historySync.status = "ready";
      this.room.historySync.error = null;
      this.room.error = null;
      this.appendSessionLog("guest-anchor", { event: "guest-anchor-confirmed", sessionKey: this.room.save.key, conversationId: this.conversation.activeId || null });
      this.emit({ historySyncCompleted: true, guestAnchorReady: true });
      return;
    }
    if (packet.type === "turn-submit" && this.room.role === "host" && packet.roomId === this.room.id && this.room.status === "waiting") {
      const member = this.room.members.find(item => String(item.id) === String(packet.from));
      const expectedChatId = this.room.memberChatIds?.[String(packet.from)];
      const round = Number(packet.payload?.round);
      const text = String(packet.payload?.text || "").trim();
      if (!member || !expectedChatId || String(expectedChatId) !== String(chatId) || this.room.memberHistory?.[String(member.id)] !== "ready" || !text || round !== this.room.round?.number || this.room.round.status !== "collecting") return;
      this.room.round.submissions[String(member.id)] = {
        displayName: String(member.displayName || member.platformName || "未命名玩家"),
        text,
        submittedAt: Number(packet.ts || Date.now())
      };
      await this.broadcastRoundState();
      void this.maybeRunHostRound();
      return;
    }
    if (packet.type === "turn-state" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      const roundNumber = Number(packet.payload?.round);
      if (!Number.isInteger(roundNumber) || roundNumber < (this.room.round?.number || 1)) return;
      const wasAwaitingHost = this.room.round?.status === "syncing";
      if (!this.room.round || roundNumber > this.room.round.number) this.room.round = this.newRound(roundNumber, this.room.round?.lastResult || null);
      const readyNames = Array.isArray(packet.payload?.readyNames) ? packet.payload.readyNames.map(String) : [];
      this.room.round.submissions = Object.fromEntries(readyNames.map((displayName, index) => [`ready-${index}`, { displayName, text: "", submittedAt: packet.ts }]));
      this.room.round.status = String(packet.payload?.status || "collecting");
      this.room.round.error = packet.payload?.error || null;
      this.room.round.pipeline = packet.payload?.pipeline && typeof packet.payload.pipeline === "object" ? packet.payload.pipeline : this.room.round.pipeline;
      if (["processing-input", "generating", "processing-output"].includes(this.room.round.status)) {
        this.beginGuestOutputWait(roundNumber);
        this.mode = "guest-waiting";
        this.detachSurface();
        await this.captureGameFrame(true);
      }
      this.emit(this.room.round.error
        ? { roundError: this.room.round.error }
        : wasAwaitingHost && this.room.round.status === "collecting" ? { roundCompleted: true } : {});
      return;
    }
    if (packet.type === "round-input" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      const round = Number(packet.payload?.round);
      const input = String(packet.payload?.input || "");
      if (!Number.isInteger(round) || !input.trim() || round < (this.room.round?.number || 1)) return;
      if (!this.room.round || round > this.room.round.number) this.room.round = this.newRound(round, this.room.round?.lastResult || null);
      this.room.round.status = "generating";
      this.beginGuestOutputWait(round);
      this.room.round.pluginRuns = Array.isArray(packet.payload?.pluginRuns) ? packet.payload.pluginRuns : [];
      this.room.round.modelInput = input;
      this.gameAutoFollow = true;
      this.mode = "guest-waiting";
      this.detachSurface();
      this.emit({ guestInputPreparing: true });
      try {
        const prepared = await this.prepareGuestRoundInputWithRetries({ round, input });
        await this.applyGameIsolation(true);
        await this.injectConversationPluginCards({ round, input, runs: this.room.round.pluginRuns });
        await this.captureGameFrame(true);
        await this.sendRoomPacket(this.room.hostChatId, makePacket("round-input-ack", this.room.id, this.room.profile.id, ++this.seq, {
          round,
          status: "ready",
          conversationId: prepared.conversationId || null,
          completedAt: Date.now()
        }));
        this.emit({ guestInputPrepared: true });
      } catch (error) {
        const message = error?.message || String(error);
        this.room.round.error = message;
        this.appendSessionLog("round-flow", { event: "guest-input-preparation-failed", round, input, error: message });
        await this.sendRoomPacket(this.room.hostChatId, makePacket("round-input-ack", this.room.id, this.room.profile.id, ++this.seq, {
          round,
          status: "error",
          message,
          completedAt: Date.now()
        })).catch(() => {});
        this.emit({ guestInputPreparationError: message });
      }
      return;
    }
    if (packet.type === "round-input-ack" && this.room.role === "host" && packet.roomId === this.room.id) {
      const member = this.room.members.find(item => String(item.id) === String(packet.from));
      const expectedChatId = this.room.memberChatIds?.[String(packet.from)];
      const round = Number(packet.payload?.round);
      if (!member || !expectedChatId || String(expectedChatId) !== String(chatId) || round !== this.room.round?.number) return;
      this.room.round.inputAcks ||= {};
      this.room.round.inputAcks[String(member.id)] = {
        status: packet.payload?.status === "ready" ? "ready" : "error",
        conversationId: packet.payload?.conversationId || null,
        message: packet.payload?.message || null,
        completedAt: Number(packet.payload?.completedAt || Date.now())
      };
      this.appendSessionLog("round-flow", { event: "host-received-input-preparation", round, memberId: String(member.id), acknowledgement: this.room.round.inputAcks[String(member.id)] });
      this.emit({ guestInputAcknowledged: true });
      return;
    }
    if (packet.type === "round-result" && this.room.role === "guest" && packet.roomId === this.room.id) {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      const result = packet.payload;
      if (!result || !Number.isInteger(Number(result.round)) || typeof result.input !== "string" || typeof result.output !== "string") return;
      if (Number(result.round) < (this.room.round?.number || 1)) return;
      this.room.round.status = "syncing";
      this.beginGuestOutputWait(result.round);
      this.mode = "guest-syncing";
      this.detachSurface();
      this.emit({ roundSyncing: true });
      try {
        const synced = await this.syncGuestRoundResultWithRetries(result);
        if (synced?.gameReady) await this.injectConversationPluginCards(result);
        this.room.verifiedOutputRound = Number(result.round);
        this.gamePresentationFrame = null;
        if (!this.window.isDestroyed()) this.window.webContents.send("backend:game-frame", { reset: true });
        this.room.round = this.newRound(Number(result.round) + 1, result);
        this.room.round.status = "syncing";
        this.mode = synced?.gameReady ? "game" : "game-empty";
        if (synced?.gameReady) await this.showCapturedGameSurface();
        else this.detachSurface();
        const acknowledgement = {
          round: Number(result.round),
          status: "ready",
          conversationId: synced?.conversation?.activeId || null,
          gameReady: Boolean(synced?.gameReady),
          completedAt: Date.now()
        };
        this.appendSessionLog("round-flow", { event: "guest-result-ready", acknowledgement, result });
        await this.sendRoomPacket(this.room.hostChatId, makePacket("round-result-ack", this.room.id, this.room.profile.id, ++this.seq, acknowledgement));
        this.emit({ roundSyncLocalCompleted: true });
      } catch (error) {
        this.room.round.status = "error";
        this.room.round.error = `成员端记录同步失败：${error?.message || String(error)}`;
        const acknowledgement = {
          round: Number(result.round),
          status: "error",
          message: this.room.round.error,
          completedAt: Date.now()
        };
        this.appendSessionLog("round-flow", { event: "guest-result-failed", acknowledgement, result });
        try {
          await this.sendRoomPacket(this.room.hostChatId, makePacket("round-result-ack", this.room.id, this.room.profile.id, ++this.seq, acknowledgement));
        } catch (ackError) {
          this.appendSessionLog("round-flow", { event: "guest-error-ack-failed", acknowledgement, error: ackError?.message || String(ackError) });
        }
        this.emit({ roundError: this.room.round.error });
      }
      return;
    }
    if (packet.type === "round-result-ack" && this.room.role === "host" && packet.roomId === this.room.id) {
      const member = this.room.members.find(item => String(item.id) === String(packet.from));
      const expectedChatId = this.room.memberChatIds?.[String(packet.from)];
      const roundNumber = Number(packet.payload?.round);
      if (!member || !expectedChatId || String(expectedChatId) !== String(chatId)) return;
      if (!this.room.round || roundNumber !== this.room.round.number || this.room.round.status !== "syncing") return;
      const status = packet.payload?.status === "ready" ? "ready" : "error";
      const acknowledgement = {
        status,
        memberId: String(member.id),
        displayName: String(member.displayName || member.platformName || "未命名玩家"),
        conversationId: packet.payload?.conversationId || null,
        gameReady: Boolean(packet.payload?.gameReady),
        message: packet.payload?.message || null,
        receivedAt: Date.now()
      };
      this.room.round.resultAcks[String(member.id)] = acknowledgement;
      this.appendSessionLog("round-flow", { event: "host-received-result-ack", round: roundNumber, acknowledgement });
      if (status === "error") {
        this.room.round.status = "error";
        this.room.round.error = `${acknowledgement.displayName} 同步失败：${acknowledgement.message || "访客端未完成记录同步"}`;
        await this.broadcastRoomPacket("turn-state", {
          round: this.room.round.number,
          status: "error",
          readyNames: [],
          totalCount: this.room.members.length,
          error: this.room.round.error
        });
        this.emit({ roundError: this.room.round.error });
        return;
      }
      if (!(await this.advanceHostRoundAfterResultAcks())) this.emit({ roundWaitingForGuests: true });
      return;
    }
    if (packet.type === "error" && this.room.role === "guest") {
      if (String(packet.from) !== String(this.room.hostAccountId)) return;
      this.room.status = "join-error";
      this.room.error = packet.payload?.message || "加入房间失败";
      if (packet.payload?.code === "VERSION_MISMATCH") {
        this.room.peerVersion = String(packet.payload?.hostVersion || "") || null;
        this.room.versionMismatch = {
          hostVersion: this.room.peerVersion,
          guestVersion: this.appVersion,
          updateRequired: true,
          officialReleasePage: OFFICIAL_RELEASE_PAGE
        };
      }
      this.emit({ joinError: this.room.error, versionMismatch: this.room.versionMismatch || null });
    }
  }

  async keepSessionAlive() {
    if (!this.domainSelected || !this.anchorNavigationArmed || this.loginInProgress || this.loginDetectionPaused) return;
    if (this.sessionHeartbeatPromise) return this.sessionHeartbeatPromise;
    if (Date.now() - (this.lastPlatformSuccessAt || 0) < 25000) return;
    this.sessionHeartbeatPromise = this.platformGoApi("/account/profile", { timeout: 5000, attempts: 1 })
      .catch(error => this.appendSessionLog("platform-network", { event: "heartbeat-deferred", code: error?.code || null, error: error?.message || String(error) }))
      .finally(() => { this.sessionHeartbeatPromise = null; });
    return this.sessionHeartbeatPromise;
  }

  async chooseWork() {
    if (this.conversationBusy) throw new Error("请等待会话操作完成后再选择作品");
    if (!this.loggedIn) throw new Error("请先登录账号");
    if (this.room) throw new Error("房间开启期间不能更换作品；退出或关闭房间后会恢复选择功能");
    this.mode = "selector";
    this.detachSurface();
    this.attachSurface();
    this.emit();
    try {
      await this.loadSurfaceUrl(
        this.surface,
        platformUrlForOrigin(this.origin, "/zh/explore/apps?ranking=daily_rank&display=extended").href,
        "作品选择页",
        0
      );
    } catch (error) {
      this.mode = "lobby";
      this.detachSurface();
      this.emit({ workLoadError: `${error?.message || String(error)}；可在设置中切换节点后重试` });
      throw error;
    }
  }

  async applyPlatformTheme(webContents) {
    if (!webContents || webContents.isDestroyed() || !/^https?:/.test(webContents.getURL())) return;
    const theme = this.uiTheme === "light" ? "light" : "dark";
    await webContents.executeJavaScript(`(() => {
      const theme = ${JSON.stringify(theme)};
      const previous = localStorage.getItem('theme');
      localStorage.setItem('theme', theme);
      // next-themes uses this exact key and listens for storage events.
      window.dispatchEvent(new StorageEvent('storage', {key:'theme',oldValue:previous,newValue:theme,storageArea:localStorage,url:location.href}));
      document.documentElement.classList.remove('light','dark');
      document.documentElement.classList.add(theme);
      document.documentElement.style.colorScheme = theme;
      document.documentElement.dataset.fympToolTheme = theme;
      document.querySelectorAll('[data-fymp-conversation-tool],[data-fymp-prototype-tool]').forEach(host => host.dataset.fympToolTheme = theme);
    })()`, true);
  }

  async refreshWorkSettings() {
    this.assertToolLoggedIn();
    if (this.room?.role === "guest") return { ...(this.room.workSettings || {}), readOnly: true };
    const appId = this.currentWorkAppId();
    if (!appId) throw new Error("请先选择作品");
    this.workSettings = { ...this.workSettings, appId, loading: true, error: null };
    this.emit();
    try {
      const config = this.normalizeModelPayload(await this.platformGoApi(`/apps/config?app_id=${encodeURIComponent(appId)}`));
      if (appId !== this.currentWorkAppId()) return this.workSettings;
      const global = publicGlobalConfig(config);
      this.workSettings = { appId, global, memoryCount: Number(config.sent_message_count ?? 6), globalEnabled: Boolean(config.is_global), characters: countConfigCharacters(global), updatedAt: Date.now(), loading: false, saving: this.workSettings.saving, error: null };
      if (this.room?.role === "host") {
        this.room.workSettings = { ...this.workSettings, saving: false };
        await this.broadcastRoomPacket("work-settings-sync", { workSettings: this.room.workSettings }, true);
      }
      return this.workSettings;
    } catch (error) {
      this.workSettings.error = error?.message || String(error);
      throw error;
    } finally { this.workSettings.loading = false; this.emit(); }
  }

  async updateWorkSettings(payload = {}) {
    this.assertToolLoggedIn();
    if (this.room?.role === "guest") throw new Error("只有房主可以修改作品设置");
    if (this.roundBusy || this.pluginPipelineBusy || this.pluginSettingsBusy || this.messageOperationBusy || this.workSettings.saving || this.workSettings.loading
      || (this.room?.round?.status && this.room.round.status !== "collecting") || Object.keys(this.room?.round?.submissions || {}).length) throw new Error("请在本轮尚无人确认输入时修改作品设置");
    const appId = this.currentWorkAppId();
    if (!appId || payload.appId !== appId) throw new Error("作品已变化，请刷新设置后重试");
    this.workSettings.saving = true;
    this.emit();
    try {
      const current = this.normalizeModelPayload(await this.platformGoApi(`/apps/config?app_id=${encodeURIComponent(appId)}`));
      const patch = {};
      if (payload.memoryCount != null) {
        if (!Number.isSafeInteger(payload.memoryCount) || payload.memoryCount < 0) throw new Error("记忆消息数量必须是非负整数");
        patch.sent_message_count = payload.memoryCount;
      }
      if (payload.global) Object.assign(patch, changedGlobalFields(publicGlobalConfig(current), payload.expectedGlobal, payload.global));
      if (Object.keys(patch).length) {
        // Omit conversation_id and is_global: update the global record without
        // switching the active multiplayer conversation away from its config.
        await this.platformGoApi("/apps/config", { method: "POST", body: { app_id: appId, ...patch } });
        const verified = this.normalizeModelPayload(await this.platformGoApi(`/apps/config?app_id=${encodeURIComponent(appId)}`));
        if (Object.keys(patch).some(key => JSON.stringify(verified[key]) !== JSON.stringify(patch[key]))) throw new Error("平台未完整保存配置，请刷新确认");
        const memoryConversationId = this.room?.save?.conversationId || this.conversation.activeId;
        if (patch.sent_message_count != null && memoryConversationId) {
          const conversationId = memoryConversationId;
          await this.platformGoApi("/apps/config", { method: "POST", body: { app_id: appId, conversation_id: conversationId, sent_message_count: patch.sent_message_count } });
          const sessionConfig = await this.readPlatformConversationConfig(appId, conversationId);
          if (sessionConfig.sent_message_count !== patch.sent_message_count) throw new Error("全局记忆已保存，但当前会话记忆未生效，请重试");
        }
        if (this.workGameUrl()) await this.loadSurfaceUrl(this.gameSurface, this.workGameUrl(), "作品对话页面", 20000);
      }
      return await this.refreshWorkSettings();
    } finally { this.workSettings.saving = false; this.emit(); }
  }

  async setUiTheme(value) {
    const theme = value === "light" ? "light" : "dark";
    this.uiTheme = theme;
    this.window?.setBackgroundColor(theme === "light" ? "#f7f1e7" : "#101820");
    this.settingsSurface?.setBackgroundColor(theme === "light" ? "#f3e4d2" : "#17222c");
    const surfaces = [this.anchor, this.surface, this.introSurface, this.gameSurface];
    const results = await Promise.allSettled(surfaces.map(surface => this.applyPlatformTheme(surface?.webContents)));
    if (results.some(result => result.status === "rejected")) this.appendSessionLog("theme", { event: "platform-theme-sync-failed" });
    const webContents = this.gameSurface?.webContents;
    if (webContents && !webContents.isDestroyed()) {
      await webContents.executeJavaScript(`(() => {
        const theme = ${JSON.stringify(theme)};
        document.documentElement.dataset.fympToolTheme = theme;
        document.querySelectorAll('[data-fymp-conversation-tool],[data-fymp-prototype-tool]').forEach(host => {
          host.dataset.fympToolTheme = theme;
        });
        return theme;
      })()`, true).catch(() => theme);
    }
    this.emit({ uiThemeChanged: true });
    return theme;
  }

  async acceptWork(value) {
    if (!this.isWorkUrl(value)) return;
    if (this.room) {
      this.mode = "lobby";
      this.detachSurface();
      this.emit({ workSelectionBlocked: true });
      return;
    }
    const url = platformUrlForOrigin(this.origin, value);
    const appId = parseInviteWork(url.href, this.origin).id;
    url.pathname = `/zh/explore/installed/${encodeURIComponent(appId)}`;
    this.work = { url: url.href, suffix: `${url.pathname}${url.search}`, title: "已选择作品" };
    this.workSettings = { loading: false, saving: false, error: null, global: null, memoryCount: null, appId };
    this.prefixAdapters = loadPrefixAdapters();
    this.prefixAdapterOperation = null;
    this.conversation = { items: [], activeId: null, activeName: null, sessionKey: null, anchorRole: null, anchored: false, hasChat: false, updatedAt: null };
    this.introReady = false;
    this.mode = "loading-intro";
    this.conversationBusy = true;
    this.conversationOperation = "load";
    this.detachSurface();
    this.emit({ workSelectionStarted: true });
    let loadError = null;
    try {
      await this.prepareWorkSurfaces();
    } catch (error) {
      loadError = error?.message || String(error);
    } finally {
      if (this.conversationOperation === "load") {
        this.conversationBusy = false;
        this.conversationOperation = null;
      }
    }
    if (loadError) {
      this.mode = "lobby";
      this.detachSurface();
      this.emit({ workLoadError: loadError });
      return;
    }
    try {
      const title = await this.introSurface.webContents.executeJavaScript(`document.querySelector("h1")?.textContent?.trim() || document.title.replace(/\\s*-\\s*(Powered by )?AI风月.*/, "")`, true);
      if (title) this.work.title = title;
    } catch {}
    if (this.mode === "loading-intro") {
      if (this.introReady) {
        this.mode = "intro";
        this.attachSurface(this.introSurface);
      } else {
        this.mode = "intro-empty";
        this.detachSurface();
      }
    }
    this.emit({ workSelected: true });
    void this.refreshWorkSettings().catch(() => {});
  }

  async prepareWorkSurfaces() {
    if (!this.work?.url) throw new Error("尚未选择作品");
    this.introSurface.setBounds(this.surfaceBounds);
    this.keepGameSurfaceResident();
    const introUrl = this.workIntroUrl();
    const gameUrl = this.workGameUrl();
    await this.clearGameIsolation();
    // This request is independent from both work documents.  Start it before
    // either page can delay on first paint.
    const modelTask = this.preparePlatformModels(1);
    const gameLoadTask = this.loadSurfaceUrl(this.gameSurface, gameUrl, "常驻对话页面", 20000);
    // Model discovery uses the authenticated account tab and must not wait for
    // the platform conversation React tree.  Start it immediately while both
    // independent work tabs finish their own hydration.
    const introTask = (async () => {
      try {
        await this.loadSurfaceUrl(this.introSurface, introUrl, "常驻介绍页面", 15000);
        await this.keepIntroSurfaceAwake();
        this.introReady = Boolean(await this.applyIntroIsolation());
      } catch (error) {
        this.introReady = false;
        this.appendSessionLog("work-surfaces", { event: "intro-load-failed", error: error?.message || String(error) });
      }
      if (this.mode === "loading-intro") {
        this.mode = this.introReady ? "intro" : "intro-empty";
        if (this.introReady) this.attachSurface(this.introSurface);
        else this.detachSurface();
        this.emit({ workVisualReady: true });
      }
      return this.introReady;
    })();
    const mountedTask = (async () => {
      await gameLoadTask;
      this.keepGameSurfaceResident();
      return this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
    })();
    const conversationTask = (async () => {
      await mountedTask;
      const created = await this.createBlankPlatformConversation();
      if (!created?.created) {
        throw new Error(`无法建立默认新会话：${created?.detail || "平台当前会话状态重置失败"}`);
      }
      // Read the existing save list after clearing the platform's active
      // conversation, then place the pending blank conversation back on top.
      // Existing conversations remain available for an explicit user switch.
      await this.refreshConversations({
        bindHost: false,
        keepSessionKey: false,
        mountTimeoutMs: 3000
      });
      const sessionKey = crypto.randomUUID();
      const conversation = this.adoptPendingConversation(created, sessionKey, "host");
      this.appendSessionLog("conversation-create", {
        event: "work-opened-with-blank-conversation",
        sessionKey,
        workSuffix: this.work?.suffix || null,
        existingConversationCount: conversation.items.filter(item => item.id).length
      });
      return conversation;
    })().then(result => {
      if (this.conversationOperation === "load") {
        this.conversationBusy = false;
        this.conversationOperation = null;
      }
      this.emit({ conversationsRefreshed: true, conversationCreated: true });
      return result;
    });
    const [introReady, mounted, , modelState] = await Promise.all([introTask, mountedTask, conversationTask, modelTask]);
    this.introReady = Boolean(introReady);
    if (!mounted?.mounted) {
      this.appendSessionLog("work-surfaces", {
        event: "resident-game-still-hydrating",
        pageUrl: this.gameSurface.webContents.getURL(),
        conversationCount: this.conversation.items.length,
        modelCount: this.platformModels.items.length
      });
      this.scheduleBackgroundDataRefresh(750);
    }
    const selectedModelIsValid = modelState?.selected && modelState.items.some(item => (
      item.provider === modelState.selected.provider && item.model === modelState.selected.model
    ));
    if (!selectedModelIsValid && modelState?.items?.length) {
      const fallback = modelState.items[0];
      await this.setPlatformModel({ provider: fallback.provider, model: fallback.model }, { broadcast: false, internal: true });
    } else if (!modelState?.items?.length) {
      this.scheduleBackgroundDataRefresh(750);
    }
    await this.applyGameIsolation(false);
    this.keepGameSurfaceResident();
    this.appendSessionLog("work-surfaces", {
      event: "background-tabs-ready",
      introUrl: this.introSurface.webContents.getURL(),
      gameUrl: this.gameSurface.webContents.getURL(),
      liveGameViewVisible: Boolean(this.liveGameSurface && this.gameSurfaceShouldPresent()),
      introReady: this.introReady,
      conversationCount: this.conversation.items.length,
      modelCount: this.platformModels.items.length
    });
  }

  async prepareGuestIntroSurface() {
    if (!this.work?.url) return false;
    this.introSurface.setBounds(this.surfaceBounds);
    try {
      await this.loadSurfaceUrl(this.introSurface, this.workIntroUrl(), "作品介绍页面", 15000);
      const ready = await this.applyIntroIsolation();
      this.introReady = Boolean(ready);
      this.appendSessionLog("guest-anchor", { event: "guest-intro-background-ready", ready: this.introReady });
      this.emit({ guestIntroPrepared: this.introReady });
      return this.introReady;
    } catch (error) {
      this.introReady = false;
      this.appendSessionLog("guest-anchor", { event: "guest-intro-background-failed", error: error?.message || String(error) });
      return false;
    }
  }

  async applyIntroIsolation() {
    const found = await this.introSurface.webContents.executeJavaScript(`(async () => {
      document.documentElement.dataset.fySurface = "intro";
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const frames = [...document.querySelectorAll("iframe")].filter(frame => {
          const src = frame.getAttribute("src") || "";
          const sandbox = frame.getAttribute("sandbox") || "";
          const rect = frame.getBoundingClientRect();
          const isIntroduction = /allow-scripts/.test(sandbox) && /allow-forms/.test(sandbox) && /allow-pointer-lock/.test(sandbox);
          const isVisibleCandidate = !/google|doubleclick|recaptcha|tawk|ads/i.test(src) && rect.width > 240 && rect.height > 160;
          return isIntroduction || isVisibleCandidate;
        });
        const chosen = frames.sort((a,b) => {
          const aExact = /allow-pointer-lock/.test(a.getAttribute("sandbox") || "") ? 1 : 0;
          const bExact = /allow-pointer-lock/.test(b.getAttribute("sandbox") || "") ? 1 : 0;
          return bExact - aExact || (b.clientWidth*b.clientHeight) - (a.clientWidth*a.clientHeight);
        })[0];
        if (chosen) {
          document.querySelectorAll("iframe[data-fy-intro]").forEach(frame => frame.removeAttribute("data-fy-intro"));
          document.querySelectorAll('[data-fy-intro-path]').forEach(element => element.removeAttribute('data-fy-intro-path'));
          document.querySelectorAll('[data-fy-intro-sibling]').forEach(element => element.removeAttribute('data-fy-intro-sibling'));
          chosen.dataset.fyIntro = "true";
          let current = chosen;
          while (current && current !== document.documentElement) {
            current.dataset.fyIntroPath = 'true';
            const parent = current.parentElement;
            if (parent) [...parent.children].filter(element => element !== current).forEach(element => { element.dataset.fyIntroSibling = 'true'; });
            current = current.parentElement;
          }
          return true;
        }
        await new Promise(resolve => setTimeout(resolve,250));
      }
      return false;
    })()`, true).catch(() => false);
    if (this.introCssKey) {
      await this.introSurface.webContents.removeInsertedCSS(this.introCssKey).catch(() => {});
      this.introCssKey = null;
    }
    if (!found) {
      this.setIntroAudioMuted(true);
      return false;
    }
    this.introCssKey = await this.introSurface.webContents.insertCSS(`
      html,body{background:#10151d!important;overflow:hidden!important}
      html[data-fy-surface="intro"] [data-fy-intro-sibling]{display:none!important}
      html[data-fy-surface="intro"] body[data-fy-intro-path] > :not([data-fy-intro-path]),
      html[data-fy-surface="intro"] [data-fy-intro-path]:not(iframe) > :not([data-fy-intro-path]){display:none!important}
      html[data-fy-surface="intro"] [data-fy-intro-path]{visibility:visible!important;opacity:1!important;overflow:visible!important}
      html[data-fy-surface="intro"] iframe[data-fy-intro="true"]{visibility:visible!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;border:0!important;z-index:2147483647!important}
    `);
    this.setIntroAudioMuted(this.activeSurface !== this.introSurface);
    return found;
  }

  async applyGamePrivacyCss() {
    const webContents = this.gameSurface?.webContents;
    if (!webContents || webContents.isDestroyed()) return null;
    const install = async () => {
      if (this.gamePrivacyCssKey) {
        await webContents.removeInsertedCSS(this.gamePrivacyCssKey).catch(() => {});
        this.gamePrivacyCssKey = null;
      }
      this.gamePrivacyCssKey = await webContents.insertCSS(`
        ${this.liveGameSurface ? `
        html[data-fy-surface="game"],
        html[data-fy-surface="game"] body {
          width: 100% !important;
          height: 100% !important;
          overflow: hidden !important;
          background: #10151d !important;
        }
        html[data-fy-surface="game"][data-fymp-message-stage-state="empty"] body > * {
          visibility: hidden !important;
          pointer-events: none !important;
        }
        html[data-fy-surface="game"] [data-fymp-stage-path] {
          transform: none !important;
          translate: none !important;
          scale: none !important;
          rotate: none !important;
          perspective: none !important;
          transform-style: flat !important;
          will-change: auto !important;
          filter: none !important;
          backdrop-filter: none !important;
          contain: none !important;
          clip-path: none !important;
          mask: none !important;
          overflow: visible !important;
          visibility: visible !important;
          opacity: 1 !important;
        }
        html[data-fy-surface="game"] [data-fymp-stage-path]:not(body):not([data-fymp-message-stage]) {
          display: contents !important;
        }
        html[data-fy-surface="game"] [data-fymp-stage-sibling] {
          visibility: hidden !important;
          pointer-events: none !important;
          user-select: none !important;
        }
        html[data-fy-surface="game"] [data-fymp-message-sibling] {
          display: none !important;
        }
        html[data-fy-surface="game"] [data-fymp-message-stage] {
          position: fixed !important;
          inset-block: 0 !important;
          inset-inline-start: 50% !important;
          inset-inline-end: auto !important;
          z-index: 2147483646 !important;
          display: block !important;
          width: 100% !important;
          min-width: 0 !important;
          height: 100vh !important;
          min-height: 0 !important;
          max-height: none !important;
          margin: 0 !important;
          padding-block-start: 16px !important;
          padding-block-end: 18px !important;
          box-sizing: border-box !important;
          overflow-x: hidden !important;
          overflow-y: auto !important;
          overscroll-behavior: contain !important;
          scrollbar-gutter: stable !important;
          transform: translateX(-50%) !important;
          translate: none !important;
          scale: none !important;
          rotate: none !important;
          filter: none !important;
          contain: none !important;
          visibility: visible !important;
          opacity: 1 !important;
          pointer-events: auto !important;
          user-select: text !important;
          touch-action: pan-y !important;
          isolation: isolate !important;
          background: #10151d !important;
        }
        ` : ""}
        .chat-container .MuiStack-root.css-1ajg1ui,
        .chat-container .MuiStack-root.css-1ajg1ui button {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
          user-select: none !important;
        }
      `).catch(() => null);
      return this.gamePrivacyCssKey;
    };
    this.gamePrivacyCssPromise = this.gamePrivacyCssPromise.catch(() => null).then(install);
    return this.gamePrivacyCssPromise;
  }

  async applyGameIsolation(waitForChat = true) {
    // Reset only the observer and structural markers here. Keeping the current
    // CSS installed prevents the native view from flashing the platform shell
    // while React hydrates or switches conversations.
    await this.gameSurface.webContents.executeJavaScript(`(() => {
      window.__fympGameObserver?.disconnect?.();
      if (window.__fympGameRefreshTimer) clearTimeout(window.__fympGameRefreshTimer);
      delete window.__fympGameObserver;
      delete window.__fympGameRefreshTimer;
      document.documentElement.dataset.fySurface = 'game';
      document.documentElement.dataset.fympMessageStageState = 'empty';
      document.querySelectorAll('[data-fymp-stage-path]').forEach(element => element.removeAttribute('data-fymp-stage-path'));
      document.querySelectorAll('[data-fymp-stage-sibling]').forEach(element => element.removeAttribute('data-fymp-stage-sibling'));
      document.querySelectorAll('[data-fymp-message-stage]').forEach(element => element.removeAttribute('data-fymp-message-stage'));
      document.querySelectorAll('[data-fymp-message-path]').forEach(element => element.removeAttribute('data-fymp-message-path'));
      document.querySelectorAll('[data-fymp-message-sibling]').forEach(element => element.removeAttribute('data-fymp-message-sibling'));
      return true;
    })()`, true).catch(() => false);
    await this.applyGamePrivacyCss();
    const found = await this.gameSurface.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
      const messageRow = (node,chat) => {
        const exact = node?.closest?.('.relative.flex.items-start.justify-between.gap-3.py-3.px-3');
        if (exact && chat.contains(exact)) return exact;
        let current = node;
        while (current?.parentElement && current.parentElement !== chat) {
          const parent = current.parentElement;
          const peerMessages = parent.querySelectorAll(':scope > * #customized-question-content,:scope > * #ai-chat-answer').length;
          if (peerMessages > 1) return current;
          current = parent;
        }
        return current || node;
      };
      const lowestCommonAncestor = nodes => {
        let current = nodes[0] || null;
        while (current && !nodes.every(node => current.contains(node))) current = current.parentElement;
        return current;
      };
      const findMessageStage = chat => {
        const anchors = [...chat.querySelectorAll('#customized-question-content,#ai-chat-answer')];
        const rows = [...new Set(anchors.map(node => messageRow(node,chat)).filter(Boolean))];
        const toolCards = [...chat.querySelectorAll('[data-fymp-prototype-tool],[data-fymp-tool-phase],[data-fymp-tool-state]')];
        const targets = [...new Set([...rows,...toolCards])];
        if (!anchors.length || !targets.length) return {anchors,rows,targets,stage:null};
        let stage = lowestCommonAncestor(targets);
        if (stage && targets.length === 1 && stage === targets[0]) stage = stage.parentElement;
        if (!stage || !chat.contains(stage)) stage = chat;
        return {anchors,rows,targets,stage};
      };
      const clearMarkers = () => {
        for (const attribute of ['data-fymp-stage-path','data-fymp-stage-sibling','data-fymp-message-stage','data-fymp-message-path','data-fymp-message-sibling']) {
          document.querySelectorAll('[' + attribute + ']').forEach(element => element.removeAttribute(attribute));
        }
      };
      const markStagePath = stage => {
        document.documentElement.dataset.fySurface = 'game';
        document.documentElement.dataset.fympMessageStageState = 'ready';
        let current = stage;
        while (current && current !== document.documentElement) {
          current.setAttribute('data-fymp-stage-path','true');
          const parent = current.parentElement;
          if (parent) {
            for (const sibling of parent.children) {
              if (sibling !== current) sibling.setAttribute('data-fymp-stage-sibling','true');
            }
          }
          current = parent;
        }
      };
      const markMessageBranches = (stage,targets) => {
        const keep = new Set([stage]);
        const leaves = new Set(targets);
        for (const target of targets) {
          let current = target;
          while (current && stage.contains(current)) {
            keep.add(current);
            if (current === stage) break;
            current = current.parentElement;
          }
        }
        stage.setAttribute('data-fymp-message-stage','true');
        for (const element of keep) {
          element.setAttribute('data-fymp-message-path','true');
          if (leaves.has(element)) continue;
          for (const child of element.children) {
            if (!keep.has(child)) child.setAttribute('data-fymp-message-sibling','true');
          }
        }
      };
      const snapshot = () => {
        clearMarkers();
        const chat = document.querySelector('.chat-container');
        if (!chat) {
          document.documentElement.dataset.fySurface = 'game';
          document.documentElement.dataset.fympMessageStageState = 'empty';
          return {found:false,count:0,questionCount:0,answerCount:0,stage:null};
        }
        const located = findMessageStage(chat);
        const questionCount = located.anchors.filter(node => node.id === 'customized-question-content').length;
        const answerCount = located.anchors.filter(node => node.id === 'ai-chat-answer').length;
        if (!located.stage) {
          document.documentElement.dataset.fySurface = 'game';
          document.documentElement.dataset.fympMessageStageState = 'empty';
          return {found:false,count:questionCount + answerCount,questionCount,answerCount,stage:null};
        }
        const stage = located.stage;
        markStagePath(stage);
        markMessageBranches(stage,located.targets);
        if (!stage.__fympInteractionReady) {
          stage.__fympInteractionReady = true;
          stage.addEventListener('wheel', () => { window.__fympLiveAutoFollow = false; }, {passive:true});
          stage.addEventListener('scroll', () => {
            if (stage.scrollHeight - stage.clientHeight - stage.scrollTop <= 4) window.__fympLiveAutoFollow = true;
          }, {passive:true});
        }
        const rect = stage.getBoundingClientRect();
        const style = getComputedStyle(stage);
        return {
          found:Boolean(questionCount || answerCount),
          count:questionCount + answerCount,
          questionCount,
          answerCount,
          stage:{
            tag:stage.tagName,
            id:String(stage.id || '').slice(0,80),
            className:String(stage.className || '').slice(0,200),
            rowCount:located.rows.length,
            targetCount:located.targets.length,
            rect:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)},
            maxWidth:style.maxWidth
          }
        };
      };
      const attempts = ${waitForChat ? 80 : 1};
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const state = snapshot();
        if (state.found) {
          window.__fympGameObserver?.disconnect?.();
          if (window.__fympGameRefreshTimer) clearTimeout(window.__fympGameRefreshTimer);
          window.__fympRefreshGameIsolation = snapshot;
          window.__fympGameObserver = new MutationObserver(() => {
            if (window.__fympGameRefreshTimer) return;
            window.__fympGameRefreshTimer = setTimeout(() => {
              window.__fympGameRefreshTimer = null;
              window.__fympRestoreToolCards?.();
              snapshot();
              const current = document.querySelector('[data-fymp-message-stage]');
              if (current && window.__fympLiveAutoFollow !== false) current.scrollTop = current.scrollHeight;
            }, 0);
          });
          const liveStage = document.querySelector('[data-fymp-message-stage]');
          if (liveStage) {
            window.__fympLiveAutoFollow = true;
            window.__fympGameObserver.observe(document.body, {childList:true,subtree:true,characterData:true});
          }
          return state;
        }
        await sleep(125);
      }
      return snapshot();
    })()`, true).catch(() => ({ found:false,count:0,questionCount:0,answerCount:0 }));
    this.effectJudgeContextAvailable = Boolean(found?.answerCount);
    // Preserve the platform's real message layout and scrollbar, but remove the
    // native per-message action stack from both the screenshot and hit testing.
    // Refresh/Edit/Delete are exposed by the desktop tool and synchronized.
    if (this.liveGameSurface && found?.found) {
      this.keepGameSurfaceResident();
    }
    this.appendSessionLog("game-surface", {
      event: found?.found ? "capture-target-ready" : "capture-target-empty",
      ...found,
      pageUrl: this.gameSurface.webContents.getURL()
    });
    // The platform hydrates historical messages after its shell has mounted.
    // If an earlier probe showed the empty placeholder, promote the intended
    // game surface as soon as a later observer sees real message nodes.
    if (found?.found && this.mode === "game-empty") {
      this.mode = "game";
      this.emit({ conversationBecameReady: true });
    }
    if (found?.found) await this.captureGameFrame(true);
    return Boolean(found?.found);
  }

  async injectPrototypeToolCard() {
    this.assertToolLoggedIn();
    if (!this.work?.url) throw new Error("请先选择作品并打开对话界面");
    await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
    await this.applyGameIsolation(true);
    const toolId = `live-tool-${++this.liveToolCardRevision}`;
    const markup = `<style>
      :host{--canvas:#101820;--surface:#1e2c37;--control:#263744;--text:#edf5f3;--muted:#9cafaa;--accent:#49b69e;--accent-soft:#21473f;display:block;color:var(--text);font:14px/1.5 Inter,"Noto Sans SC",system-ui,sans-serif}
      :host([data-fymp-tool-theme="light"]){--canvas:#f7f1e7;--surface:#f3e4d2;--control:#ead5bd;--text:#4b382b;--muted:#806b5a;--accent:#d88952;--accent-soft:#f4d8bd}
      *{box-sizing:border-box;border:0;background-image:none;box-shadow:none}.card{margin:12px 8px 16px;border-radius:16px;background:var(--surface);padding:16px}
      .head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.head b{font-size:15px}.badge{border-radius:999px;background:var(--accent-soft);color:var(--accent);padding:3px 8px;font-size:11px}
      .copy{margin:0 0 12px;color:var(--muted);font-size:12px}.choices{display:grid;gap:8px}.choice,.roll{width:100%;border-radius:10px;background:var(--control);color:var(--text);padding:10px 12px;text-align:left;cursor:pointer}.choice:hover,.choice[data-selected="true"]{background:var(--accent-soft);box-shadow:inset 0 0 0 2px var(--accent);color:var(--text)}.roll{margin-top:10px;text-align:center;color:var(--accent)}.result{min-height:21px;margin-top:10px;color:var(--accent);font-size:12px}
    </style>
    <section class="card" role="group" aria-label="联机工具实验卡片">
      <div class="head"><b>路线判定</b><span class="badge">发送模型前</span></div>
      <p class="copy">演示位置：用户输入之后、模型回复之前。结果将保存为结构化工具状态。</p>
      <div class="choices">
        <button class="choice" type="button" data-choice="观察四周">观察四周，寻找安全路线</button>
        <button class="choice" type="button" data-choice="直接前进">直接前进，抢占先机</button>
        <button class="choice" type="button" data-choice="与同伴商议">先与同伴商议</button>
      </div>
      <button class="roll" type="button">掷一次 D20</button>
      <div class="result" aria-live="polite">请选择行动，或测试本地骰子。</div>
    </section>`;
    const result = await this.gameSurface.webContents.executeJavaScript(`(() => {
      const chat = document.querySelector('.chat-container');
      if (!chat) return {inserted:false,reason:'missing-chat'};
      window.__fympToolCards?.clear?.();
      document.querySelectorAll('[data-fymp-prototype-tool]').forEach(node => node.remove());
      const questions = [...chat.querySelectorAll('#customized-question-content')];
      const answers = [...chat.querySelectorAll('#ai-chat-answer')];
      const question = questions.at(-1);
      if (!question) return {inserted:false,reason:'missing-question'};
      const messageRow = node => node?.closest('.relative.flex.items-start.justify-between.gap-3.py-3.px-3') || node?.parentElement || node;
      const questionRow = messageRow(question);
      const answerRow = messageRow(answers.at(-1));
      if (!questionRow?.parentElement) return {inserted:false,reason:'missing-anchor'};
      const host = document.createElement('div');
      host.dataset.fympPrototypeTool = ${JSON.stringify(toolId)};
      host.dataset.fympToolTheme = ${JSON.stringify(this.uiTheme)};
      host.dataset.fympToolPhase = 'before-model';
      host.dataset.fympToolState = JSON.stringify({status:'pending',phase:'before-model'});
      host.setAttribute('role','region');
      host.setAttribute('aria-label','风月联机工具实验组件');
      const shadow = host.attachShadow({mode:'closed'});
      shadow.innerHTML = ${JSON.stringify(markup)};
      const resultNode = shadow.querySelector('.result');
      const recordResult = payload => {
        const state = {status:'resolved',phase:'before-model',resolvedAt:Date.now(),...payload};
        host.dataset.fympToolState = JSON.stringify(state);
        window.__fympToolResults ||= {};
        window.__fympToolResults[${JSON.stringify(toolId)}] = state;
        document.dispatchEvent(new CustomEvent('fymp:tool-resolved',{detail:{toolId:${JSON.stringify(toolId)},...state}}));
        return state;
      };
      for (const button of shadow.querySelectorAll('.choice')) {
        button.addEventListener('click', event => {
          event.stopPropagation();
          for (const peer of shadow.querySelectorAll('.choice')) peer.dataset.selected = String(peer === button);
          recordResult({kind:'choice',value:button.dataset.choice});
          resultNode.textContent = '已选择：' + button.dataset.choice + '（已记录 before-model 结果）';
        });
      }
      shadow.querySelector('.roll').addEventListener('click', event => {
        event.stopPropagation();
        const values = new Uint32Array(1);
        const value = (crypto.getRandomValues(values)[0] % 20) + 1;
        recordResult({kind:'d20',value});
        resultNode.textContent = 'D20 结果：' + value + '（已记录 before-model 结果）';
      });
      host.addEventListener('click', event => event.stopPropagation());
      const placeHost = () => {
        const currentChat = document.querySelector('.chat-container');
        if (!currentChat) return false;
        const currentQuestion = [...currentChat.querySelectorAll('#customized-question-content')].at(-1);
        const currentQuestionRow = messageRow(currentQuestion);
        const currentAnswerRow = messageRow([...currentChat.querySelectorAll('#ai-chat-answer')].at(-1));
        if (!currentQuestionRow?.parentElement) return false;
        if (
          currentAnswerRow?.parentElement === currentQuestionRow.parentElement &&
          (currentQuestionRow.compareDocumentPosition(currentAnswerRow) & Node.DOCUMENT_POSITION_FOLLOWING)
        ) {
          currentQuestionRow.parentElement.insertBefore(host,currentAnswerRow);
        } else {
          currentQuestionRow.parentElement.insertBefore(host,currentQuestionRow.nextSibling);
        }
        return true;
      };
      window.__fympToolCards ||= new Map();
      window.__fympToolCards.set(${JSON.stringify(toolId)},{host,phase:'before-model',placeHost});
      window.__fympRestoreToolCards = () => {
        for (const entry of window.__fympToolCards.values()) if (!entry.host.isConnected) entry.placeHost();
        return window.__fympPlaceConversationToolCards?.() || 0;
      };
      if (!placeHost()) return {inserted:false,reason:'placement-failed'};
      host.scrollIntoView({behavior:'smooth',block:'nearest'});
      return {inserted:true,toolId:${JSON.stringify(toolId)},phase:'before-model',questionCount:questions.length,answerCount:answers.length};
    })()`, true);
    if (!result?.inserted) throw new Error(`工具卡片没有插入消息流：${result?.reason || "未知原因"}`);
    this.appendSessionLog("live-game-view", { event: "prototype-tool-inserted", ...result });
    this.emit({ prototypeToolInserted: result });
    return result;
  }

  async injectConversationPluginCards({ round, input, runs, pluginRuns } = {}) {
    const roundNumber = Number(round || 0);
    const expectedInput = String(input || "");
    const cards = (Array.isArray(runs) ? runs : Array.isArray(pluginRuns) ? pluginRuns : [])
      .filter(run => [PLUGIN_PHASES.INPUT, PLUGIN_PHASES.OUTPUT].includes(run?.phase) && run?.status !== "running" && !run?.skipped)
      .sort((left, right) => Number(left?.order || 0) - Number(right?.order || 0) || String(left?.pluginId || "").localeCompare(String(right?.pluginId || "")));
    if (!roundNumber || !expectedInput.trim() || !cards.length) return { inserted: 0, skipped: true };
    await this.ensureGameSurfaceMounted({ timeoutMs: 15000 });
    const result = await this.gameSurface.webContents.executeJavaScript(`(async () => {
      const round = ${JSON.stringify(roundNumber)};
      const expectedInput = ${JSON.stringify(expectedInput)};
      const cards = ${JSON.stringify(cards)};
      const toolTheme = ${JSON.stringify(this.uiTheme)};
      let diagnosticStage = 'initializing';
      try {
      const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
      const normalize = value => String(value || '').replace(/\\r\\n/g,'\\n').replace(/[\\u200b-\\u200d\\ufeff]/g,'').trim();
      const compact = value => normalize(value).replace(/\\s+/g,'');
      const messageRow = (node,chat) => {
        const exact = node?.closest?.('.relative.flex.items-start.justify-between.gap-3.py-3.px-3');
        if (exact && chat?.contains(exact)) return exact;
        let current = node;
        while (current?.parentElement && current.parentElement !== chat) {
          const parent = current.parentElement;
          const peerMessages = parent.querySelectorAll(':scope > * #customized-question-content,:scope > * #ai-chat-answer').length;
          if (peerMessages > 1) return current;
          current = parent;
        }
        return current || node;
      };
      let lastAnchorMatch = 'none';
      const findQuestionRow = (input,allowLatest) => {
        diagnosticStage = 'finding-input-anchor';
        const chat = document.querySelector('.chat-container');
        const questions = [...(chat?.querySelectorAll('#customized-question-content') || [])];
        const reversed = questions.slice().reverse();
        const wanted = normalize(input);
        const wantedCompact = compact(input);
        let anchor = reversed.find(node => normalize(node.innerText || node.textContent) === wanted);
        if (anchor) lastAnchorMatch = 'exact';
        if (!anchor) {
          anchor = reversed.find(node => compact(node.innerText || node.textContent) === wantedCompact);
          if (anchor) lastAnchorMatch = 'whitespace-normalized';
        }
        if (!anchor && wantedCompact.length >= 24) {
          anchor = reversed.find(node => {
            const candidate = compact(node.innerText || node.textContent);
            return Boolean(candidate) && (candidate.includes(wantedCompact) || wantedCompact.includes(candidate));
          });
          if (anchor) lastAnchorMatch = 'contained';
        }
        if (!anchor && allowLatest) {
          anchor = reversed[0];
          if (anchor) lastAnchorMatch = 'latest-question';
        }
        if (!anchor) lastAnchorMatch = 'none';
        return messageRow(anchor,chat);
      };
      const text = (tag,className,value) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        node.textContent = String(value ?? '');
        return node;
      };
      const cardStyle = [
        ':host{--surface:#1e2c37;--control:#263744;--text:#edf5f3;--muted:#9cafaa;--accent:#49b69e;--accent-soft:#21473f;--danger:#d46e79;--danger-soft:#493039;--warning:#c79c58;display:block;color:var(--text);font:14px/1.5 Inter,"Noto Sans SC",system-ui,sans-serif}',
        ':host([data-fymp-tool-theme="light"]){--surface:#f3e4d2;--control:#ead5bd;--text:#4b382b;--muted:#806b5a;--accent:#d88952;--accent-soft:#f4d8bd;--danger:#a94f5a;--danger-soft:#f1d9dc;--warning:#9a6b38}',
        '*{box-sizing:border-box;border:0;background-image:none;box-shadow:none}',
        'article{display:grid;gap:12px;margin:10px 8px 14px;border-radius:15px;background:var(--surface);padding:14px}',
        'header{display:flex;align-items:center;justify-content:space-between;gap:12px}header span{display:grid}header small{color:var(--muted);font-size:10px}header b{font-size:15px}.badge{border-radius:999px;background:var(--accent-soft);color:var(--accent);padding:3px 8px;font-size:10px}',
        '.error{margin:0;background:var(--danger-soft);box-shadow:inset 4px 0 0 var(--danger);padding:9px;color:var(--danger)}.member{display:grid;gap:8px;border-radius:11px;background:var(--control);padding:10px}.member>b{font-size:13px}',
        '.hit{display:grid;gap:5px;border-radius:10px;background:var(--accent-soft);box-shadow:inset 0 0 0 2px var(--accent);padding:10px}.hit strong{color:var(--accent);font-size:18px}.hit span{color:var(--text)}',
        'details{padding-top:7px}summary{cursor:pointer;color:var(--muted);font-size:11px;user-select:none}ol{display:grid;gap:4px;margin:8px 0 0;padding:0;list-style:none}li{display:grid;grid-template-columns:24px minmax(0,1fr);gap:7px;border-radius:7px;padding:5px 6px;color:var(--muted);font-size:10px}li.selected{background:var(--accent-soft);color:var(--text)}li i{display:grid;width:22px;height:22px;place-items:center;border-radius:6px;background:var(--surface);font-style:normal}li.selected i{background:var(--accent);color:var(--surface)}',
        'footer{justify-self:end;padding-top:7px;color:var(--warning);font-size:10px}.generic{margin:0;color:var(--text)}'
      ].join('');
      const createHost = run => {
        diagnosticStage = 'creating-card';
        const key = round + ':' + String(run.runId || run.pluginId || 'plugin');
        const host = document.createElement('div');
        host.dataset.fympConversationTool = key;
        host.dataset.fympToolPhase = run.phase;
        host.dataset.fympToolState = String(run.status || 'completed');
        host.dataset.fympToolOrder = String(Number(run.order || 0));
        host.dataset.fympToolTheme = toolTheme;
        host.setAttribute('role','region');
        host.setAttribute('aria-label',String(run.name || run.pluginId || '输入处理插件') + '结果');
        const shadow = host.attachShadow({mode:'closed'});
        const style = document.createElement('style');
        style.textContent = cardStyle;
        const article = document.createElement('article');
        const header = document.createElement('header');
        const title = document.createElement('span');
        title.append(text('small','','第 ' + round + ' 轮 · ' + (run.phase === 'output' ? '输出处理栈' : '输入处理栈')),text('b','',run.name || run.pluginId || '处理插件'));
        const badge = text('em','badge',run.status === 'error' ? (run.withheld ? '暂不公开' : '已降级发送') : '处理完成');
        header.append(title,badge);article.append(header);
        if (run.status === 'error') {
          article.append(text('p','error','插件返回错误：' + (run.error || '未知错误') + (run.withheld ? '。原文暂不公开。' : '。原始输入已继续发送。')));
        } else if (run.pluginId === ${JSON.stringify(PERSPECTIVE_PLUGIN_ID)}) {
          article.append(text('p','generic','已整理 ' + run.memberCount + ' 名玩家的独立视角；当前只显示你的正文、个人状态和公共信息。'));
        } else if (run.pluginId === ${JSON.stringify(EFFECT_JUDGE_PLUGIN_ID)}) {
          for (const member of run.members || []) {
            const memberNode = document.createElement('section');memberNode.className = 'member';
            memberNode.append(text('b','',member.displayName || member.playerKey || '玩家'));
            const hit = document.createElement('div');hit.className = 'hit';
            hit.append(text('strong','','D' + (run.settings?.dieFaces || '?') + ' · ' + (member.roll ?? '?')),text('span','',member.selected ? '【' + member.selected.degree + '】' + member.selected.outcome : '没有可用结果'));
            memberNode.append(hit);
            const details = document.createElement('details');
            details.append(text('summary','','查看全部骰面结果'));
            const faces = document.createElement('ol');
            for (const face of member.faces || []) {
              const item = document.createElement('li');
              if (Number(face.face) === Number(member.roll)) item.className = 'selected';
              item.append(text('i','',face.face),text('span','','【' + face.degree + '】' + face.outcome));
              faces.append(item);
            }
            details.append(faces);memberNode.append(details);article.append(memberNode);
          }
        } else {
          article.append(text('p','generic','该输入处理插件已完成，本轮将使用处理后的玩家输入。'));
        }
        if (run.pluginId === ${JSON.stringify(PERSPECTIVE_PLUGIN_ID)} && run.attemptCount) article.append(text('p','generic','本次尝试 ' + run.attemptCount + '/' + run.maxAttempts + ' 次。'));
        article.append(text('footer','',(run.pointsIncomplete ? '已读取 ' : '消耗 ') + (run.points?.total ?? 0) + ' 积分' + (run.pointsIncomplete ? '，部分尝试的消耗未能读取' : '')));
        shadow.append(style,article);
        return {key,host,round,input:expectedInput,phase:run.phase,order:Number(run.order || 0),pluginId:String(run.pluginId || '')};
      };
      diagnosticStage = 'registering-cards';
      if (!(window.__fympConversationToolCards instanceof Map)) window.__fympConversationToolCards = new Map();
      for (const run of cards) {
        const key = round + ':' + String(run.runId || run.pluginId || 'plugin');
        const previous = window.__fympConversationToolCards.get(key);
        previous?.host?.remove?.();
        window.__fympConversationToolCards.set(key,createHost(run));
      }
      window.__fympPlaceConversationToolCards = (allowLatest = true) => {
        diagnosticStage = 'placing-cards';
        const groups = new Map();
        for (const entry of window.__fympConversationToolCards.values()) {
          const key = entry.round + ':' + entry.input + ':' + entry.phase;
          if (!groups.has(key)) groups.set(key,[]);
          groups.get(key).push(entry);
        }
        let placed = 0;
        for (const entries of groups.values()) {
          entries.sort((left,right) => left.order - right.order || left.pluginId.localeCompare(right.pluginId));
          const isCurrentGroup = Number(entries[0].round) === round && entries[0].input === expectedInput;
          const questionRow = findQuestionRow(entries[0].input,allowLatest && isCurrentGroup);
          if (!questionRow?.parentElement) continue;
          let anchorRow = questionRow;
          if (entries[0].phase === 'output') {
            let sibling = questionRow.nextElementSibling;
            anchorRow = questionRow.querySelector('#ai-chat-answer') ? questionRow : null;
            while (!anchorRow && sibling) {
              if (sibling.querySelector('#customized-question-content')) break;
              if (sibling.matches('#ai-chat-answer') || sibling.querySelector('#ai-chat-answer')) anchorRow = sibling;
              sibling = sibling.nextElementSibling;
            }
            if (!anchorRow) continue;
          }
          const parent = anchorRow.parentElement;
          let cursor = anchorRow;
          for (const entry of entries) {
            if (cursor.nextSibling !== entry.host) parent.insertBefore(entry.host,cursor.nextSibling);
            cursor = entry.host;
            placed += 1;
          }
        }
        return placed;
      };
      window.__fympRestoreToolCards = () => {
        for (const entry of window.__fympToolCards?.values?.() || []) if (!entry.host.isConnected) entry.placeHost();
        return window.__fympPlaceConversationToolCards?.() || 0;
      };
      let placed = 0;
      for (let attempt = 0; attempt < 160 && !placed; attempt += 1) {
        placed = window.__fympPlaceConversationToolCards(attempt >= 24);
        if (!placed) await sleep(75);
      }
      diagnosticStage = 'refreshing-isolation';
      window.__fympRefreshGameIsolation?.();
      return {inserted:placed,round,cardCount:cards.length,anchorMatch:lastAnchorMatch};
      } catch (error) {
        return {
          inserted: 0,
          round,
          cardCount: cards.length,
          stage: diagnosticStage,
          error: String(error?.stack || error?.message || error)
        };
      }
    })()`, true).catch(error => ({ inserted: 0, error: error?.message || String(error) }));
    this.appendSessionLog("plugin-card", {
      event: result?.inserted ? "cards-inserted" : result?.error ? "cards-script-error" : "cards-missing-anchor",
      ...result
    });
    return result;
  }

  async showIntro() {
    if (!this.work) throw new Error("尚未选择作品");
    this.mode = "loading-intro";
    this.detachSurface();
    const introUrl = this.workIntroUrl();
    if (!this.isSameWorkPage(this.introSurface.webContents.getURL(), introUrl)) await this.introSurface.webContents.loadURL(introUrl);
    this.introReady = await this.applyIntroIsolation();
    if (!this.introReady) {
      this.mode = "intro-empty";
      this.detachSurface();
      this.emit({ introUnavailable: true });
      return this.state();
    }
    this.mode = "intro";
    this.attachSurface(this.introSurface);
    this.emit();
  }

  async showGame() {
    if (!this.work) throw new Error("尚未选择作品");
    if (this.guestOutputPending()) {
      this.mode = this.room.round?.status === "syncing" ? "guest-syncing" : "guest-waiting";
      this.detachSurface();
      this.emit();
      await this.captureGameFrame(true);
      return this.state();
    }
    this.mode = "loading-game";
    this.gameAutoFollow = true;
    this.detachSurface();
    const gameUrl = this.workGameUrl();
    if (!this.isSameWorkPage(this.gameSurface.webContents.getURL(), gameUrl)) await this.gameSurface.webContents.loadURL(gameUrl);
    const ready = await this.applyGameIsolation(true);
    if (!ready) {
      this.mode = "game-empty";
      this.emit({ conversationEmpty: true });
      return this.state();
    }
    if (this.room?.round?.lastResult) await this.injectConversationPluginCards(this.room.round.lastResult);
    await this.showCapturedGameSurface();
  }

  hidePlatform() {
    this.mode = this.loggedIn ? "lobby" : "logged-out";
    this.detachSurface();
    this.emit();
  }

  destroy() {
    if (this.destroying) return;
    this.destroying = true;
    this.cancelLogin();
    this.loginPageWarmController?.abort();
    this.unregisterDiagnosticGlobalShortcut();
    this.cancelAutoModels();
    this.onlineWorldService.close();
    clearInterval(this.statusTimer);
    clearInterval(this.accountTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.roomTimer);
    clearInterval(this.gameFrameTimer);
    clearInterval(this.gameWakeTimer);
    clearInterval(this.introWakeTimer);
    if (this.gameFramePublishTimer) clearTimeout(this.gameFramePublishTimer);
    this.gameFramePublishTimer = null;
    this.gameFramePublishPending = false;
    if (this.backgroundDataRefreshTimer) clearTimeout(this.backgroundDataRefreshTimer);
    this.closeOAuthWindows();
    this.detachSurface();
    this.setIntroAudioMuted(true);
    for (const view of [this.surface, this.introSurface, this.settingsSurface]) this.closePlatformView(view);
    if (this.gameSurface?.webContents && !this.gameSurface.webContents.isDestroyed()) {
      this.gamePresentationFrame = null;
      if (this.liveGameSurface) {
        this.closePlatformView(this.gameSurface);
      } else {
        try { this.gameSurface.webContents.stopPainting(); } catch {}
        try { this.gameSurface.webContents.close(); } catch {}
        try { if (!this.gameSurface.isDestroyed()) this.gameSurface.destroy(); } catch {}
      }
    }
    if (this.anchor && !this.anchor.isDestroyed()) this.anchor.destroy();
  }
}

let mainWindow;
let backend;
let releaseSecurity;
let updateService;
let profileInstanceLock = null;
let shuttingDown = false;
const DESKTOP_PAGE_PATH = path.resolve(__dirname, "desktop", "index.html");

function closeAllApplicationWindows() {
  updateService?.shutdown();
  backend?.destroy();
  stopSpawnedInstanceProcesses();
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) window.destroy();
    } catch {}
  }
}

function isTrustedDesktopUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "file:" && path.resolve(fileURLToPath(url)) === DESKTOP_PAGE_PATH;
  } catch { return false; }
}

function guardDesktopNavigation(webContents) {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event, url) => {
    if (!isTrustedDesktopUrl(url)) event.preventDefault();
  });
}

function isTrustedDesktopSender(event) {
  const sender = event?.sender;
  if (!sender || sender.isDestroyed()) return false;
  const knownSender = sender === mainWindow?.webContents || sender === backend?.settingsSurface?.webContents;
  return knownSender && isTrustedDesktopUrl(sender.getURL());
}

function handleLocalIpc(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedDesktopSender(event)) throw new Error(`拒绝来自非本地工具页面的 IPC 调用：${channel}`);
    return listener(event, ...args);
  });
}

function createWindow(profileId = safeProfileId(argument("profile", "default"))) {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 660,
    title: `${APPLICATION_NAME} · ${profileId}`,
    backgroundColor: "#0d1219", autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow.on("page-title-updated", event => event.preventDefault());
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  guardDesktopNavigation(mainWindow.webContents);
  mainWindow.loadFile(DESKTOP_PAGE_PATH);
  releaseSecurity = new ReleaseSecurityGate({
    net,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    executablePath: process.execPath,
    userDataPath: app.getPath("userData"),
    onStateChange: () => {
      if (backend && !backend.destroying && mainWindow && !mainWindow.isDestroyed()) backend.emit({ releaseSecurityChanged: true });
    }
  });
  updateService = new OfficialUpdateService({
    updater: autoUpdater,
    releaseSecurity,
    feedOptions: { provider: "github", owner: "pumpcatkin", repo: "fengyue-link" },
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    installDirectory: process.platform === "win32" ? path.dirname(process.execPath) : null,
    // The player has explicitly chosen "update and restart". Install as soon as
    // the downloaded installer passes the signed release-manifest checks.
    canInstallNow: () => true,
    onStateChange: () => {
      if (backend && !backend.destroying && mainWindow && !mainWindow.isDestroyed()) backend.emit({ appUpdateChanged: true });
    }
  });
  backend = new AccountBackend(mainWindow, profileId, releaseSecurity, updateService);
  backend.appendSessionLog("network", { event: "default-system-proxy", ...defaultProxyState });
  mainWindow.webContents.once("did-finish-load", () => void backend.bootstrap());
  mainWindow.on("closed", () => {
    updateService?.shutdown();
    backend?.destroy();
  });
}

handleLocalIpc("backend:get-state", () => backend.state());
// HTML z-index cannot rise above native WebContentsViews. A window-modal
// dialog stays above game, introduction and settings views alike.
handleLocalIpc("backend:confirm-action", async (_event, options = {}) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question", title: String(options.title || "确认操作"),
    message: String(options.message || "是否继续？"),
    buttons: ["取消", String(options.acceptText || "继续")],
    defaultId: 0, cancelId: 0, noLink: true
  });
  return result.response === 1;
});
handleLocalIpc("app:get-version", () => app.getVersion());
handleLocalIpc("app:get-release-channel", () => RELEASE_CHANNEL);
handleLocalIpc("app:open-official-release-page", () => shell.openExternal(OFFICIAL_RELEASE_PAGE));
handleLocalIpc("app:check-for-updates", () => updateService.checkNow());
handleLocalIpc("app:request-update", () => updateService.requestUpdate());
handleLocalIpc("app:get-author-info", () => publicAuthorInfo());
handleLocalIpc("app:open-author-link", (_event, key) => shell.openExternal(configuredAuthorUrl(key)));
handleLocalIpc("app:quit", () => app.quit());
handleLocalIpc("backend:get-logs", () => backend.getSessionLogs());
handleLocalIpc("backend:list-domain-candidates", () => currentDomainCandidates(backend.domainSelected ? backend.origin : null));
handleLocalIpc("backend:list-domains", (_event, force) => discoverDomainStatuses(Boolean(force)));
handleLocalIpc("backend:set-origin", (_event, origin) => backend.setOrigin(origin));
handleLocalIpc("backend:switch-origin", (_event, origin) => backend.switchOrigin(origin));
handleLocalIpc("backend:logout", () => backend.logout());
handleLocalIpc("backend:login", (_event, credentials) => backend.login(credentials || {}));
handleLocalIpc("backend:auto-login", (_event, credentials) => backend.loginWithFailover(credentials || {}));
handleLocalIpc("backend:cancel-login", () => backend.cancelLogin());
handleLocalIpc("backend:oauth-login", (_event, provider) => backend.oauthLogin(provider));
handleLocalIpc("backend:create-room", (_event, settings) => backend.createRoom(settings || {}));
handleLocalIpc("backend:join-room", (_event, settings) => backend.joinRoom(settings || {}));
handleLocalIpc("backend:remove-room-member", (_event, memberId) => backend.removeRoomMember(memberId));
handleLocalIpc("backend:leave-room", () => backend.leaveRoom());
handleLocalIpc("backend:send-room-chat", (_event, value) => backend.sendRoomChat(value));
handleLocalIpc("backend:submit-round", (_event, value) => backend.submitRoundInput(value));
handleLocalIpc("backend:copy-text", (_event, value) => { clipboard.writeText(String(value || "")); return true; });
handleLocalIpc("credentials:load", () => loadCredentials(backend.profileId));
handleLocalIpc("credentials:clear", () => { clearCredentials(backend.profileId); return true; });
handleLocalIpc("backend:set-bounds", (_event, bounds) => backend.setBounds(bounds));
handleLocalIpc("backend:set-theme", (_event, theme) => backend.setUiTheme(theme));
handleLocalIpc("backend:set-settings-visible", (_event, visible) => backend.setSettingsVisible(visible));
handleLocalIpc("backend:show-login", () => backend.showLogin());
handleLocalIpc("backend:choose-work", () => backend.chooseWork());
handleLocalIpc("backend:refresh-conversations", () => backend.refreshConversationsFromUser());
handleLocalIpc("backend:select-conversation", (_event, conversationId) => backend.selectConversation(conversationId));
handleLocalIpc("backend:new-conversation", () => backend.createNewConversation());
handleLocalIpc("backend:rename-conversation", (_event, id, name) => backend.manageConversation("rename", id, name));
handleLocalIpc("backend:delete-conversation", (_event, id) => backend.manageConversation("delete", id));
handleLocalIpc("backend:adapt-work-prefix", () => backend.adaptCurrentWorkPrefix());
handleLocalIpc("backend:update-plugin-settings", (_event, pluginId, settings) => backend.updatePluginSettings(pluginId, settings || {}));
handleLocalIpc("backend:refresh-work-settings", () => backend.refreshWorkSettings());
handleLocalIpc("backend:update-work-settings", (_event, settings) => backend.updateWorkSettings(settings || {}));
handleLocalIpc("backend:refresh-models", () => backend.refreshPlatformModels());
handleLocalIpc("backend:cancel-model-requests", () => backend.cancelAutoModels());
handleLocalIpc("backend:set-model", (_event, model) => backend.setPlatformModel(model || {}));
handleLocalIpc("backend:message-operation", (_event, action, value) => backend.runHostMessageOperation(action, value));
handleLocalIpc("backend:inject-prototype-tool-card", () => backend.injectPrototypeToolCard());
handleLocalIpc("profiles:create", () => backend.createCharacterProfile());
handleLocalIpc("profiles:save", (_event, profile) => backend.saveCharacterProfile(profile || {}));
handleLocalIpc("profiles:select", (_event, profileId) => backend.selectCharacterProfile(profileId));
handleLocalIpc("profiles:delete", (_event, profileId) => backend.deleteCharacterProfile(profileId));
handleLocalIpc("backend:show-intro", () => backend.showIntro());
handleLocalIpc("backend:show-game", () => backend.showGame());
handleLocalIpc("backend:scroll-game", (_event, deltaY) => backend.scrollGame(deltaY));
handleLocalIpc("backend:game-pointer", (_event, payload) => backend.dispatchGamePointer(payload));
handleLocalIpc("backend:game-key", (_event, payload) => backend.dispatchGameKey(payload));
handleLocalIpc("backend:hide-platform", () => backend.hidePlatform());
handleLocalIpc("online-world:get-state", () => backend.onlineWorldService.state());
handleLocalIpc("online-world:list-cards", () => backend.listOnlineWorldCards());
handleLocalIpc("online-world:import-card", () => backend.importOnlineWorldCard());
handleLocalIpc("online-world:import-card-files", (_event, files) => backend.importOnlineWorldCardFiles(files));
handleLocalIpc("online-world:remove-card", (_event, libraryId) => backend.removeOnlineWorldCard(libraryId));
handleLocalIpc("online-world:export-card", (_event, cardId) => backend.exportOnlineWorldCard(cardId));
handleLocalIpc("online-world:open", (_event, options) => backend.openOnlineWorldCard(options || {}));
handleLocalIpc("online-world:follow-migration", (_event, options) => backend.followOnlineWorldMigration(options || {}));
handleLocalIpc("online-world:close", () => backend.onlineWorldService.pause());
handleLocalIpc("online-world:initialize", () => backend.onlineWorldService.initialize());
handleLocalIpc("online-world:sync", (_event, full) => backend.onlineWorldService.sync(Boolean(full)));
handleLocalIpc("online-world:submit-intent", (_event, intent) => backend.onlineWorldService.submitIntent(intent || {}));
handleLocalIpc("online-world:send-direct", (_event, message) => backend.onlineWorldService.sendDirect(message?.toAccountId, message?.type, message?.payload));
handleLocalIpc("online-world:migrate", () => backend.migrateOnlineWorldCard());
handleLocalIpc("online-world:administer", (_event, command) => backend.onlineWorldService.administer(command || {}));
handleLocalIpc("online-world:update-preferences", (_event, preferences) => backend.onlineWorldService.updateLocalPreferences(preferences || {}));
handleLocalIpc("backend:new-instance", (_event, requested) => {
  backend.assertAdminAccount();
  return new Promise((resolve, reject) => {
    const id = safeProfileId(requested || `debug-${Date.now().toString(36)}`);
    const launch = instanceLaunchSpec(id);
    const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore", cwd: launch.cwd });
    spawnedInstanceProcesses.add(child);
    const forget = () => spawnedInstanceProcesses.delete(child);
    child.once("error", error => { forget(); reject(error); });
    child.once("exit", forget);
    child.once("spawn", () => { child.unref(); resolve(id); });
  });
});

app.whenReady().then(async () => {
  if (process.platform === "win32") app.setAppUserModelId(APPLICATION_ID);
  try {
    defaultProxyState = await configureSystemProxy(session.defaultSession, "default-session");
  } catch (error) {
    defaultProxyState = { mode: "system", route: null, error: error?.message || String(error) };
  }
  const profileId = safeProfileId(argument("profile", "default"));
  profileInstanceLock = acquireProfileInstanceLock(profileId);
  if (!profileInstanceLock.acquired) {
    await dialog.showMessageBox({
      type: "info",
      title: `${APPLICATION_NAME}已在运行`,
      message: `账号实例“${profileId}”已经打开`,
      detail: "请使用已经打开的窗口。同一账号实例同时运行会争用登录状态；如需多账号，请从管理员实例功能创建不同名称的实例。",
      buttons: ["知道了"],
      defaultId: 0
    });
    app.quit();
    return;
  }
  createWindow(profileId);
});
app.on("before-quit", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  closeAllApplicationWindows();
});
app.on("will-quit", () => {
  stopSpawnedInstanceProcesses();
  releaseProfileInstanceLock(profileInstanceLock);
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
