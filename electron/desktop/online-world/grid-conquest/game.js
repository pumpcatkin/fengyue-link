"use strict";

const canvas = document.querySelector("#map");
const context = canvas.getContext("2d");
const viewport = document.querySelector("#map-viewport");
const tagCatalog = typeof ACG_CHARACTER_TAGS === "undefined" ? [] : ACG_CHARACTER_TAGS;
const ZOOM_LEVELS = [.25, .375, .5, .75, 1, 1.25, 1.5, 2, 3];
const DEFAULT_VISIBLE_CELLS = 12;
const MAX_TRAINING_LEVEL = 100;
const HOST_PROTOCOL = "fyow-host/1";
let payload = null;
let selected = null;
let zoom = 1;
let mapCssSize = 2048;
let mapCentered = false;
let mapCenterFrame = null;
let panState = null;
let suppressMapClick = false;
let mapPointer = null;
let mapTaskOverlays = [];
let receivedAt = Date.now();
let serverNow = Date.now();
let toastTimer = null;
let generalDetailId = null;
let dialogueGeneralId = null;
let joinStep = 0;
let joinSubmitting = false;
const joinDraft = { profileId: "", orientation: "any", tags: new Map(), wish: "", preview: null };
const preferenceDraft = { orientation: "any", tags: new Map() };
const pendingHostRequests = new Map();
const pendingHostKeys = new Map();
const dialogueRequests = new Map();
const retryConfirmations = new Map();
const seenModelUsageIds = new Set();
let modelUsageInitialized = false;
let deployGeneralId = null;
let deployingGeneralId = null;
let deployingGeneralName = "";
let floatingFeedbackTimer = null;
let socialTab = "world";
let worldChatFingerprint = "";
const communicationUnread = { world: 0, generals: 0, letters: 0 };
const communicationSeen = { world: new Set(), generals: new Set(), letters: new Set() };
let communicationNotificationsInitialized = false;
let letterDetailItem = null;
let marchQuoteCache = null;
let marchQuoteTimer = null;
let marchQuoteFailureKey = "";
let marchConfirmationTarget = null;
let marchSubmitting = false;
let armyTransferDraft = 0;
let armyTransferContext = "";
let regionActionsCollapsed = false;
let armyTransferCollapsed = false;
let companionHoverTimer = null;
let draggedGeneralId = null;
let pendingGeneralAction = null;
let generalDiscoveryId = null;
let generalDiscoverySubmitting = false;
let activeBattleReportId = null;
let battleReportGeneralPickerOpen = false;
let battleDiscussionContext = null;
const worldChatDrafts = new Map();
const MATERIAL_NAMES = { white: "养气丹", green: "聚灵丹", blue: "凝元丹", purple: "紫府丹", gold: "金髓丹", "red-ascend": "赤曜丹", "red-reroll": "赤曜丹" };
const MATERIAL_PURPOSES = { "red-ascend": "升格效果", "red-reroll": "洗髓效果" };

function host(type, data = {}, options = {}) {
  const key = String(options.key || "");
  if (key && pendingHostKeys.has(key)) {
    showToast("这项操作正在处理中，请等待返回");
    playSound("notice");
    return null;
  }
  const requestId = options.expectResult ? crypto.randomUUID() : "";
  const message = { source: "fyow-grid-conquest", protocol: HOST_PROTOCOL, type, ...data };
  if (requestId) message.requestId = requestId;
  if (requestId) {
    const control = !options.silent && options.control instanceof HTMLButtonElement
      ? options.control
      : !options.silent && document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    if (control && !control.disabled) {
      control.disabled = true;
      control.classList.add("host-pending");
    }
    const pending = { key, control, controlText: control?.textContent || "", silent: Boolean(options.silent), timeoutId: null };
    pendingHostRequests.set(requestId, pending);
    if (key) pendingHostKeys.set(key, requestId);
    const timeoutMs = Number(options.timeoutMs || 0);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) pending.timeoutId = setTimeout(() => {
      const expired = finishHostRequest(requestId);
      if (!expired || expired.silent) return;
      showToast(String(options.timeoutMessage || "操作请求超时，请重试"));
      playSound("notice");
    }, timeoutMs);
  }
  parent.postMessage(message, "*");
  return requestId || true;
}

function finishHostRequest(requestId) {
  const id = String(requestId || "");
  if (!id) return null;
  const pending = pendingHostRequests.get(id);
  if (!pending) return false;
  pendingHostRequests.delete(id);
  if (pending.timeoutId) clearTimeout(pending.timeoutId);
  if (pending.key && pendingHostKeys.get(pending.key) === id) pendingHostKeys.delete(pending.key);
  if (pending.control) {
    pending.control.disabled = false;
    if (pending.controlText) pending.control.textContent = pending.controlText;
    pending.control.classList.remove("host-pending");
  }
  if (pending.key === "sync") renderConnectionNotice();
  return pending;
}
function ownAccountId() { return String(payload?.account?.accountId || payload?.account?.id || payload?.accountId || ""); }
function ownPlayer() {
  const players = payload?.world?.players || {};
  const id = ownAccountId();
  return players[id] || Object.values(players).find(player => String(player?.accountId || "") === id) || null;
}
function allGenerals() { return payload?.world?.generals || {}; }
function pendingGeneralDiscoveries() { return payload?.world?.privatePlayers?.[ownAccountId()]?.pendingGeneralDiscoveries || []; }
function battleReports() {
  return [...(payload?.world?.privatePlayers?.[ownAccountId()]?.battleReports || [])]
    .filter(item => item && item.id)
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
}
function battleReportById(id) { return battleReports().find(item => String(item.id) === String(id || "")) || null; }
function cellKey(x, y) { return `${x},${y}`; }
function dynamicCell(x, y) { return payload?.world?.cells?.[cellKey(x, y)] || { ownerAccountId: null, soldiers: 0, generalIds: [] }; }
function fact(x, y) { return payload?.mapFacts?.[y * 64 + x] || { x, y, population: 0, resourceGrade: "—", resourceRank: 0, garrisonCap: 0, neutralPower: 0 }; }
function occupationCount(cell) {
  const count = Number(cell?.occupationCount);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
function garrisonCapAt(x, y, cell = dynamicCell(x, y)) {
  const info = fact(x, y);
  const percent = Math.min(75, 20 + occupationCount(cell) * 5);
  return Math.floor(Number(info.population || 0) * percent / 100);
}
function formatNumber(value) { return Number(value || 0).toLocaleString("zh-CN"); }
function formatPointValue(value, fallback = "—") {
  if (value == null || value === "") return fallback;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number.toLocaleString("zh-CN", { maximumFractionDigits: 4 }) : String(value);
}
function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
}
function trainingPower(entity) {
  const base = Math.max(1, Number(entity?.basePower || entity?.power || 300));
  const level = Math.max(0, Math.min(MAX_TRAINING_LEVEL, Number(entity?.trainingLevel || 0)));
  return Math.floor(base * (1 + level * .06) * Math.pow(1.25, Math.floor(level / 10)));
}
function hostTime() { return serverNow + (Date.now() - receivedAt); }
function gameYear() { const now = hostTime(); return 1 + Math.floor(Math.max(0, now - Number(payload?.world?.startedAt || now)) / 86400000); }

function showToast(text) {
  const node = document.querySelector("#toast");
  node.textContent = String(text || "");
  node.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add("hidden"), 3000);
}

function showMapFeedback(text, anchor = document.querySelector("#march")) {
  const node = document.querySelector("#map-floating-feedback");
  const rect = anchor.getBoundingClientRect();
  node.textContent = text;
  node.style.left = `${Math.max(60, Math.min(window.innerWidth - 60, rect.left + rect.width / 2))}px`;
  node.style.top = `${Math.max(60, rect.top - 15)}px`;
  node.classList.add("hidden");
  void node.offsetWidth;
  node.classList.remove("hidden");
  clearTimeout(floatingFeedbackTimer);
  floatingFeedbackTimer = setTimeout(() => node.classList.add("hidden"), 1800);
}
function generalExperienceLabel(general) {
  const fallback = [100, 300, 800, 1800, 3600][Number(general?.cultivationCount || 0)] || 0;
  const required = Math.max(0, Math.trunc(Number(general?.experienceRequired ?? fallback) || 0));
  const raw = Number(general?.experience);
  const experience = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  return `${experience.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} / ${formatNumber(required)}`;
}
function battleReportMarker(report) {
  const target = report?.target || {};
  const time = new Date(Number(report?.createdAt || hostTime())).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
  });
  return report?.kind === "territory-loss"
    ? `【战报-${time} (${Number(target.x)},${Number(target.y)})领地失守】`
    : `【战报-${time} 对(${Number(target.x)},${Number(target.y)})发动的进攻】`;
}
function withoutBattleReportMarker(value, marker) {
  const text = String(value || "");
  if (!marker) return text.trim();
  return text.replace(marker, "").replace(/^\s+/, "").trim();
}
function clearInvalidBattleDiscussion() {
  const discussion = battleDiscussionContext;
  if (!discussion || battleReportById(discussion.reportId)) return;
  const input = document.querySelector("#dialogue-input");
  if (input) input.value = withoutBattleReportMarker(input.value, discussion.marker);
  battleDiscussionContext = null;
}

let audioContext = null;
let audioResumePromise = null;
let soundPersistTimer = null;
let soundPreviewTimer = null;
let soundAckTimer = null;
let soundPersistRevision = 0;
let pendingSoundRevision = 0;
let soundVolumeLevel = .6;
try {
  const storedVolume = localStorage.getItem("fyow:sound-volume");
  if (storedVolume != null) soundVolumeLevel = Math.max(0, Math.min(1, Number(storedVolume) || 0));
  else {
    const legacyLevels = [.6, .3, 0];
    soundVolumeLevel = legacyLevels[Math.max(0, Math.min(legacyLevels.length - 1, Number(localStorage.getItem("fyow:sound-level") || 0)))] ?? .6;
  }
} catch {}
function soundVolume() { return soundVolumeLevel; }
function persistSoundVolume() {
  clearTimeout(soundPersistTimer);
  const volume = soundVolumeLevel;
  const revision = ++soundPersistRevision;
  pendingSoundRevision = revision;
  soundPersistTimer = setTimeout(() => {
    host("sound", { volume, revision });
    clearTimeout(soundAckTimer);
    soundAckTimer = setTimeout(() => {
      if (pendingSoundRevision === revision) pendingSoundRevision = 0;
    }, 2000);
  }, 120);
}
function setSoundVolume(percent, { persist = true } = {}) {
  soundVolumeLevel = Math.max(0, Math.min(1, Math.round(Number(percent) / 5) * 5 / 100));
  if (persist) {
    try { localStorage.setItem("fyow:sound-volume", String(soundVolumeLevel)); } catch {}
    persistSoundVolume();
  }
  updateSoundControl();
}
function updateSoundControl() {
  const input = document.querySelector("#sound-volume");
  const label = document.querySelector("#sound-volume-label");
  const knob = document.querySelector("#sound-knob");
  if (!input || !label || !knob) return;
  const percent = Math.round(soundVolume() * 100);
  input.value = String(percent);
  knob.style.setProperty("--knob-angle", `${-135 + percent / 100 * 270}deg`);
  knob.setAttribute("aria-valuenow", String(percent));
  knob.setAttribute("aria-valuetext", percent ? `${percent}%` : "关闭");
  label.textContent = percent ? `音效 ${percent}%` : "音效 关";
  input.closest(".sound-control")?.classList.toggle("muted", !percent);
}
function ensureAudioReady() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !soundVolume()) return null;
  if (!audioContext || audioContext.state === "closed") audioContext = new AudioContextClass();
  if (audioContext.state !== "running" && !audioResumePromise) {
    const context = audioContext;
    audioResumePromise = Promise.resolve(context.resume?.())
      .catch(() => null)
      .finally(() => { audioResumePromise = null; });
  }
  return audioContext;
}
function audioTone(context, frequency, duration, { delay = 0, endFrequency = frequency, gain = .065, type = "sine" } = {}) {
  const volume = soundVolume();
  if (!volume || !context || context.state === "closed") return;
  const start = context.currentTime + delay;
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(Math.max(40, frequency), start);
  if (endFrequency !== frequency) oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, endFrequency), start + duration);
  envelope.gain.setValueAtTime(.0001, start);
  envelope.gain.exponentialRampToValueAtTime(Math.max(.0002, gain * volume), start + Math.min(.018, duration / 3));
  envelope.gain.exponentialRampToValueAtTime(.0001, start + duration);
  oscillator.connect(envelope).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + .02);
}
function playSound(kind = "click") {
  if (!soundVolume()) return;
  const context = ensureAudioReady();
  if (!context) return;
  if (kind === "click") audioTone(context, 430, .09, { endFrequency: 270, gain: .08, type: "triangle" });
  else if (kind === "notice") audioTone(context, 560, .09, { endFrequency: 450, gain: .07, type: "triangle" });
  else if (kind === "success") { audioTone(context, 520, .12, { gain: .07, type: "triangle" }); audioTone(context, 720, .16, { delay: .08, gain: .08, type: "triangle" }); }
  else if (kind === "error") { audioTone(context, 220, .15, { endFrequency: 145, gain: .085, type: "sawtooth" }); audioTone(context, 165, .18, { delay: .07, endFrequency: 120, gain: .06, type: "square" }); }
  else if (kind === "complete") { audioTone(context, 660, .18, { gain: .07, type: "sine" }); audioTone(context, 990, .24, { delay: .1, gain: .075, type: "sine" }); }
  else if (kind === "victory") { audioTone(context, 392, .13, { gain: .07, type: "triangle" }); audioTone(context, 523, .15, { delay: .09, gain: .08, type: "triangle" }); audioTone(context, 784, .28, { delay: .19, gain: .085, type: "triangle" }); }
  else if (kind === "defeat") { audioTone(context, 330, .16, { endFrequency: 260, gain: .07, type: "triangle" }); audioTone(context, 196, .3, { delay: .1, endFrequency: 130, gain: .08, type: "sawtooth" }); }
  else if (kind === "general") { audioTone(context, 587, .16, { gain: .07, type: "sine" }); audioTone(context, 740, .18, { delay: .1, gain: .075, type: "sine" }); audioTone(context, 988, .34, { delay: .2, gain: .08, type: "sine" }); }
  else if (kind === "letter") { audioTone(context, 880, .11, { gain: .065, type: "sine" }); audioTone(context, 1175, .22, { delay: .09, gain: .07, type: "sine" }); }
  else if (kind === "dialogue") { audioTone(context, 440, .09, { gain: .06, type: "triangle" }); audioTone(context, 554, .14, { delay: .07, gain: .065, type: "triangle" }); }
}
document.addEventListener("pointerdown", event => {
  const button = event.target.closest?.("button");
  if (button && !button.disabled && button !== soundKnob) playSound("click");
  else ensureAudioReady();
}, true);
document.addEventListener("click", event => {
  if (event.detail !== 0) return;
  const button = event.target.closest?.("button");
  if (button && !button.disabled && button !== soundKnob) playSound("click");
}, true);
let soundKnobDrag = null;
let suppressSoundKnobClick = false;
const soundKnob = document.querySelector("#sound-knob");
function soundPercentFromPointer(clientX, clientY) {
  const rect = soundKnob.getBoundingClientRect();
  const dx = Number(clientX) - (rect.left + rect.width / 2);
  const dy = Number(clientY) - (rect.top + rect.height / 2);
  if (Math.hypot(dx, dy) < 3) return Math.round(soundVolume() * 100);
  let angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
  angle = ((angle + 180) % 360 + 360) % 360 - 180;
  return Math.round((Math.max(-135, Math.min(135, angle)) + 135) / 270 * 100);
}
soundKnob.addEventListener("pointerdown", event => {
  soundKnobDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  soundKnob.setPointerCapture(event.pointerId);
  soundKnob.classList.add("dragging");
  event.preventDefault();
});
soundKnob.addEventListener("pointermove", event => {
  if (event.pointerId !== soundKnobDrag?.pointerId) return;
  if (Math.hypot(event.clientX - soundKnobDrag.x, event.clientY - soundKnobDrag.y) < 3) return;
  soundKnobDrag.moved = true;
  setSoundVolume(soundPercentFromPointer(event.clientX, event.clientY));
});
function finishSoundKnobDrag(event) {
  if (event.pointerId !== soundKnobDrag?.pointerId) return;
  const moved = soundKnobDrag.moved;
  if (soundKnob.hasPointerCapture(event.pointerId)) soundKnob.releasePointerCapture(event.pointerId);
  soundKnobDrag = null;
  soundKnob.classList.remove("dragging");
  suppressSoundKnobClick = moved;
  if (moved && soundVolume()) playSound("success");
  if (moved) setTimeout(() => { suppressSoundKnobClick = false; }, 0);
}
soundKnob.addEventListener("pointerup", finishSoundKnobDrag);
soundKnob.addEventListener("pointercancel", event => {
  if (event.pointerId !== soundKnobDrag?.pointerId) return;
  soundKnobDrag = null;
  soundKnob.classList.remove("dragging");
});
soundKnob.addEventListener("click", event => {
  if (suppressSoundKnobClick) { suppressSoundKnobClick = false; event.preventDefault(); return; }
  const current = Math.round(soundVolume() * 100);
  const next = current >= 100 ? 0 : Math.min(100, current + 10);
  if (!next) playSound("notice");
  setSoundVolume(next);
  if (next) playSound("notice");
});
soundKnob.addEventListener("wheel", event => {
  event.preventDefault();
  setSoundVolume(Math.round(soundVolume() * 100) + (event.deltaY < 0 ? 5 : -5));
  clearTimeout(soundPreviewTimer);
  soundPreviewTimer = setTimeout(() => { if (soundVolume()) playSound("notice"); }, 100);
}, { passive: false });
soundKnob.addEventListener("keydown", event => {
  const current = Math.round(soundVolume() * 100);
  let next = current;
  if (["ArrowUp", "ArrowRight"].includes(event.key)) next += 5;
  else if (["ArrowDown", "ArrowLeft"].includes(event.key)) next -= 5;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = 100;
  else return;
  setSoundVolume(next);
  if (soundVolume()) playSound("notice");
  event.preventDefault();
});
updateSoundControl();

let stateSoundSnapshot = null;
function captureSoundState(next) {
  const accountId = String(next?.account?.accountId || "");
  const world = next?.world || {};
  return {
    inbox: new Set((next?.directInbox || []).map(item => String(item.messageId || ""))),
    generals: new Set(Object.values(world.generals || {}).filter(general => general?.holderAccountId === accountId).map(general => String(general.id || ""))),
    jobs: new Set(Object.values(world.jobs || {}).filter(job => job?.accountId === accountId).map(job => String(job.id || ""))),
    territories: Object.values(world.cells || {}).filter(cell => cell?.ownerAccountId === accountId).length
  };
}

function communicationItemId(prefix, item, index = 0) {
  const explicit = item?.messageId || item?.id;
  if (explicit) return `${prefix}:${String(explicit)}`;
  const payloadText = item?.text || item?.reply || item?.summary || item?.payload?.text || "";
  return `${prefix}:${String(item?.createdAt || item?.timestamp || item?.year || "")}:${String(payloadText).slice(0, 80)}:${index}`;
}

function mergeDirectMessages(inbox, history) {
  const merged = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(history) ? history : []), ...(Array.isArray(inbox) ? inbox : [])]) {
    const key = String(item?.messageId || item?.id || `${item?.direction || ""}|${item?.createdAt || item?.timestamp || ""}|${item?.fromAccountId || ""}|${item?.toAccountId || ""}|${item?.payload?.text || item?.text || ""}`);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function communicationSnapshot(next) {
  const accountId = String(next?.account?.accountId || next?.account?.id || next?.accountId || "");
  const world = next?.world || {};
  const worldIds = (next?.worldChat || [])
    .filter(item => String(item?.accountId || "") !== accountId)
    .map((item, index) => communicationItemId("world", item, index));
  const inbox = Array.isArray(next?.directInbox) ? next.directInbox : [];
  const history = mergeDirectMessages(inbox, next?.directHistory);
  const incoming = inbox.filter(item => item?.direction !== "out");
  const receivedHistory = history.filter(item => item?.direction !== "out");
  const letterIds = [...incoming, ...receivedHistory].map((item, index) => communicationItemId("letter", item, index));
  const generalIds = [];
  for (const general of Object.values(world.generals || {})) {
    if (String(general?.holderAccountId || "") !== accountId) continue;
    for (const [index, interaction] of (general?.interactionHistory || []).entries()) {
      generalIds.push(communicationItemId(`general:${general.id}`, interaction, index));
    }
  }
  return {
    world: [...new Set(worldIds)],
    generals: [...new Set(generalIds)],
    letters: [...new Set(letterIds)]
  };
}

function communicationPanelVisible(tab) {
  const panel = document.querySelector("#social-sidebar");
  return Boolean(panel && !panel.inert && socialTab === tab);
}

function renderCommunicationBadges() {
  const total = Object.values(communicationUnread).reduce((sum, value) => sum + Number(value || 0), 0);
  const dock = document.querySelector("#social-unread-badge");
  if (dock) {
    dock.textContent = total > 99 ? "99+" : String(total);
    dock.classList.toggle("hidden", total < 1);
    dock.setAttribute("aria-label", total ? `${total} 条未读通讯` : "没有未读通讯");
  }
  for (const category of Object.keys(communicationUnread)) {
    const badge = document.querySelector(`[data-social-badge="${category}"]`);
    if (!badge) continue;
    const value = Number(communicationUnread[category] || 0);
    badge.textContent = value > 99 ? "99+" : String(value);
    badge.classList.toggle("hidden", value < 1);
    badge.setAttribute("aria-label", value ? `${value} 条未读消息` : "没有未读消息");
  }
  const directUnread = document.querySelector("#direct-unread");
  if (directUnread) {
    const value = Number(communicationUnread.letters || 0);
    directUnread.textContent = value > 99 ? "99+" : String(value);
    directUnread.classList.toggle("hidden", value < 1);
  }
}

function markCommunicationRead(category) {
  if (!Object.hasOwn(communicationUnread, category)) return;
  communicationUnread[category] = 0;
  renderCommunicationBadges();
}

function updateCommunicationNotifications(next, playNotificationSound = true) {
  const snapshot = communicationSnapshot(next);
  if (!communicationNotificationsInitialized) {
    for (const category of Object.keys(communicationSeen)) communicationSeen[category] = new Set(snapshot[category]);
    communicationNotificationsInitialized = true;
    renderCommunicationBadges();
    return;
  }
  let soundKind = "";
  const soundPriority = { notice: 1, dialogue: 2, letter: 3 };
  for (const category of Object.keys(communicationSeen)) {
    const fresh = snapshot[category].filter(id => !communicationSeen[category].has(id));
    for (const id of snapshot[category]) communicationSeen[category].add(id);
    if (communicationSeen[category].size > 500) communicationSeen[category] = new Set(snapshot[category].slice(-300));
    if (!fresh.length) continue;
    if (!communicationPanelVisible(category)) communicationUnread[category] += fresh.length;
    const categorySound = category === "letters" ? "letter" : category === "generals" ? "dialogue" : "notice";
    if (!soundKind || soundPriority[categorySound] > soundPriority[soundKind]) soundKind = categorySound;
  }
  renderCommunicationBadges();
  if (playNotificationSound && soundKind === "letter") playSound("letter");
  else if (playNotificationSound && soundKind) playSound(soundKind);
}

function applyHostedState(next, background = false) {
  const previous = stateSoundSnapshot;
  const current = captureSoundState(next);
  payload = next;
  clearInvalidBattleDiscussion();
  serverNow = Number(payload?.serverNow || Date.now());
  receivedAt = Date.now();
  const hostedVolume = Number(next?.uiPreferences?.soundVolume);
  if (Number.isFinite(hostedVolume) && !pendingSoundRevision && !soundKnobDrag && Math.abs(hostedVolume - soundVolumeLevel) > .001) {
    setSoundVolume(hostedVolume * 100, { persist: false });
  }
  stateSoundSnapshot = current;
  updateCommunicationNotifications(next, background && !pendingHostRequests.size);
  const usageEvents = Array.isArray(next?.modelUsageEvents) ? next.modelUsageEvents : [];
  if (!modelUsageInitialized) {
    usageEvents.forEach(item => seenModelUsageIds.add(String(item.id)));
    modelUsageInitialized = true;
  } else {
    const freshUsage = usageEvents.filter(item => !seenModelUsageIds.has(String(item.id)));
    freshUsage.forEach(item => seenModelUsageIds.add(String(item.id)));
    if (freshUsage.length) {
      const latest = freshUsage[freshUsage.length - 1];
      const consumed = formatPointValue(latest?.points?.total, "待平台结算");
      const remaining = formatPointValue(latest?.remainingPoints ?? next?.account?.points);
      showToast(`${latest.label || "模型请求"}消耗 ${consumed} 积分 · 剩余 ${remaining}`);
    }
  }
  if (background && previous && !pendingHostRequests.size) {
    if ([...current.generals].some(id => id && !previous.generals.has(id))) playSound("general");
    else if (current.territories > previous.territories) playSound("victory");
    else if (current.territories < previous.territories) playSound("defeat");
    else if ([...previous.jobs].some(id => id && !current.jobs.has(id))) playSound("complete");
  }
}

function tileColorHash(x, y, rank, owner = "") {
  let ownerHash = 0;
  for (const char of String(owner || "")) ownerHash = Math.imul(ownerHash ^ char.charCodeAt(0), 16777619);
  let hash = Math.imul(Math.trunc(Number(x) || 0) + 1, 374761393);
  hash = Math.imul(hash ^ Math.imul(Math.trunc(Number(y) || 0) + 1, 668265263), 1442695041);
  hash = Math.imul(hash ^ Math.imul(Math.trunc(Number(rank) || 0) + 1, 2246822519), 3266489917);
  hash = Math.imul(hash ^ ownerHash, 1274126177);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function ownerColor(owner, rank, layer, x = 0, y = 0) {
  // Coordinates provide a stable hand-painted texture; centralLayer is a
  // zero-based 0..3 depth axis so the core is darker and slightly red-brown.
  const palette = !owner
    ? { hue: 78, saturation: 38, lightness: 74 }
    : owner === ownAccountId()
      // A calm blue keeps owned land distinct from the green world palette on
      // the blue-yellow axis, which remains useful for common colour-vision deficiencies.
      ? { hue: 211, saturation: 46, lightness: 58 }
      : { hue: 12, saturation: 58, lightness: 68 };
  const safeRank = Math.max(0, Math.min(14, Math.trunc(Number(rank) || 0)));
  const hash = tileColorHash(x, y);
  const hueJitter = (((hash >>> 0) & 255) / 255 - .5) * 3.6;
  const saturationJitter = (((hash >>> 8) & 255) / 255 - .5) * 7;
  const lightnessJitter = (((hash >>> 16) & 255) / 255 - .5) * 5;
  const depth = Number.isFinite(Number(layer))
    ? Math.max(0, Math.min(3, Math.trunc(Number(layer))))
    : 0;
  const hue = palette.hue + hueJitter;
  const saturation = palette.saturation + saturationJitter + safeRank * .8;
  const lightness = palette.lightness + lightnessJitter + safeRank * .55 - depth * 7;
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  const q = l < .5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = offset => {
    let value = h + offset;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  const rgb = [channel(1 / 3), channel(0), channel(-1 / 3)].map(value => Math.round(value * 255));
  const centerMix = depth / 3;
  const shifts = [8, -4, -8];
  return `#${rgb.map((value, index) => Math.max(0, Math.min(255, Math.round(value + shifts[index] * centerMix))).toString(16).padStart(2, "0")).join("")}`;
}

function validMapPosition(point) {
  return Boolean(point && Number.isInteger(point.x) && point.x >= 0 && point.x < 64
    && Number.isInteger(point.y) && point.y >= 0 && point.y < 64);
}

function sameMapPoint(left, right) {
  return Boolean(left && right && left.x === right.x && left.y === right.y);
}
function validStoredMarchPath(value) {
  return Array.isArray(value) && value.every(validMapPosition)
    ? value.map(point => ({ x: point.x, y: point.y }))
    : null;
}
function storedMarchRoute(value, from, to) {
  const path = validStoredMarchPath(value);
  if (!path?.length || !sameMapPoint(path[path.length - 1], to)) return null;
  let previous = from;
  for (const point of path) {
    if (Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) !== 1) return null;
    previous = point;
  }
  return path;
}
function compareMarchFrontier(left, right) {
  return left.weightQuarters - right.weightQuarters || left.steps - right.steps || left.order - right.order;
}
function pushMarchFrontier(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareMarchFrontier(heap[parent], item) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = item;
}
function popMarchFrontier(heap) {
  if (!heap.length) return null;
  const first = heap[0];
  const last = heap.pop();
  if (!heap.length) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    let child = left;
    if (right < heap.length && compareMarchFrontier(heap[right], heap[left]) < 0) child = right;
    if (compareMarchFrontier(last, heap[child]) <= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}
function targetFirstDirections(current, to) {
  const dx = Math.sign(to.x - current.x);
  const dy = Math.sign(to.y - current.y);
  const directions = [];
  if (dx) directions.push([dx, 0]);
  if (dy) directions.push([0, dy]);
  if (dx) directions.push([-dx, 0]);
  if (dy) directions.push([0, -dy]);
  if (!dx) directions.push([1, 0], [-1, 0]);
  if (!dy) directions.push([0, 1], [0, -1]);
  const seen = new Set();
  return directions.filter(([stepX, stepY]) => {
    const key = `${stepX},${stepY}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function localMarchPath(from, to, attack = false) {
  if (!validMapPosition(from) || !validMapPosition(to)) return null;
  if (sameMapPoint(from, to)) return [];
  const accountId = ownAccountId();
  const originOwner = dynamicCell(from.x, from.y).ownerAccountId;
  if (originOwner && String(originOwner) !== accountId) {
    const retreat = validStoredMarchPath(ownPlayer()?.retreatPath);
    if (!retreat?.length || !sameMapPoint(retreat[0], from) || !sameMapPoint(retreat[retreat.length - 1], to)) return null;
    const path = retreat.slice(1);
    return path.every((point, index) => {
      const owner = dynamicCell(point.x, point.y).ownerAccountId;
      return !owner || String(owner) === accountId || (attack && index === path.length - 1 && sameMapPoint(point, to));
    }) ? path : null;
  }
  const targetOwner = dynamicCell(to.x, to.y).ownerAccountId;
  if (targetOwner && String(targetOwner) !== accountId && !attack) return null;
  const routeKey = point => `${point.x},${point.y}`;
  const startKey = routeKey(from);
  const targetKey = routeKey(to);
  const previous = new Map([[startKey, null]]);
  const best = new Map([[startKey, { weightQuarters: 0, steps: 0 }]]);
  const frontier = [];
  let order = 0;
  pushMarchFrontier(frontier, { ...from, key: startKey, weightQuarters: 0, steps: 0, order: order++ });
  while (frontier.length) {
    const current = popMarchFrontier(frontier);
    const known = best.get(current.key);
    if (!known || known.weightQuarters !== current.weightQuarters || known.steps !== current.steps) continue;
    if (sameMapPoint(current, to)) break;
    for (const [stepX, stepY] of targetFirstDirections(current, to)) {
      const next = { x: current.x + stepX, y: current.y + stepY };
      if (!validMapPosition(next)) continue;
      const nextKey = routeKey(next);
      const owner = dynamicCell(next.x, next.y).ownerAccountId;
      if (owner && String(owner) !== accountId && !(attack && nextKey === targetKey)) continue;
      const weightQuarters = current.weightQuarters + (String(owner || "") === accountId ? 1 : 4);
      const steps = current.steps + 1;
      const prior = best.get(nextKey);
      if (prior && (prior.weightQuarters < weightQuarters
        || (prior.weightQuarters === weightQuarters && prior.steps <= steps))) continue;
      best.set(nextKey, { weightQuarters, steps });
      previous.set(nextKey, routeKey(current));
      pushMarchFrontier(frontier, { ...next, key: nextKey, weightQuarters, steps, order: order++ });
    }
  }
  if (!previous.has(targetKey)) return null;
  const reversed = [];
  let currentKey = targetKey;
  while (currentKey !== startKey) {
    const [x, y] = currentKey.split(",").map(Number);
    reversed.push({ x, y });
    currentKey = previous.get(currentKey);
  }
  return reversed.reverse();
}
function localMarchRouteBreakdown(path) {
  const accountId = ownAccountId();
  const ownDistance = path.filter(point => String(dynamicCell(point.x, point.y).ownerAccountId || "") === accountId).length;
  const ordinaryDistance = path.length - ownDistance;
  const weightQuarters = ownDistance + ordinaryDistance * 4;
  return { ownDistance, ordinaryDistance, weightQuarters, weightedDistance: weightQuarters / 4 };
}
function marchMapRoute(from, to, options = {}) {
  if (!validMapPosition(from) || !validMapPosition(to) || sameMapPoint(from, to)) return null;
  const path = storedMarchRoute(options.path, from, to) || localMarchPath(from, to, Boolean(options.attack));
  if (!path) return null;
  const breakdown = localMarchRouteBreakdown(path);
  const points = [{ x: from.x + .5, y: from.y + .5 }, ...path.map(point => ({ x: point.x + .5, y: point.y + .5 }))];
  return { from, to, path, points, distance: path.length, ...breakdown, durationMs: breakdown.weightQuarters * 15000 / 4 };
}
function marchDraftValue() {
  return Math.max(0, Math.trunc(Number(ownPlayer()?.fieldArmySoldiers) || 0));
}
function marchTarget() { return marchConfirmationTarget || selected; }
function neutralUnderfootAt(target = marchTarget()) {
  const player = ownPlayer();
  return Boolean(player?.position && target && player.position.x === target.x && player.position.y === target.y
    && !dynamicCell(target.x, target.y).ownerAccountId);
}
function attackUnderfootAt(target = marchTarget()) {
  const player = ownPlayer();
  return Boolean(player?.position && target && sameMapPoint(player.position, target)
    && dynamicCell(target.x, target.y).ownerAccountId !== ownAccountId());
}
function hostileMarchTargetAt(target = marchTarget()) {
  const owner = target && dynamicCell(target.x, target.y).ownerAccountId;
  return Boolean(owner && String(owner) !== ownAccountId());
}
function selectedMarchQuote(route, target = marchTarget()) {
  if (marchQuoteCache?.requestKey === marchQuoteKey(target)) return { cost: marchQuoteCache.cost, durationMs: marchQuoteCache.durationMs };
  const soldiers = marchDraftValue();
  const generalCount = new Set((ownPlayer()?.carriedGeneralIds || []).map(String)).size;
  const modifiers = ownPlayer()?.marchModifiers || {};
  const baseCostPerCell = 1 + Math.ceil(soldiers / 10) + generalCount * 2;
  const baseCost = Math.ceil(Number(route.weightQuarters || route.distance * 4) * baseCostPerCell / 4);
  const cost = Math.max(1, Math.round(baseCost * Number(modifiers.costMultiplier ?? 1)));
  return { cost, durationMs: Math.max(1000, Math.round(route.durationMs * Number(modifiers.durationMultiplier ?? 1))) };
}
function selectedMarchIntent(target = marchTarget()) {
  const modalAttack = Boolean(marchConfirmationTarget && sameMapPoint(target, marchConfirmationTarget)
    && document.querySelector("#march-attack")?.checked);
  return {
    to: target, soldiers: marchDraftValue(),
    attack: attackUnderfootAt(target) || hostileMarchTargetAt(target) || modalAttack
  };
}
function marchQuoteKey(target = marchTarget()) { return JSON.stringify({ ...selectedMarchIntent(target), revision: payload?.world?.revision, from: ownPlayer()?.position }); }
function refreshMarchQuote() {
  clearTimeout(marchQuoteTimer);
  const target = marchTarget();
  const attackUnderfoot = attackUnderfootAt(target);
  if (!target || !ownPlayer()?.position || (sameMapPoint(target, ownPlayer().position) && !attackUnderfoot)) {
    if (marchConfirmationTarget) renderMarchConfirmation();
    return;
  }
  const intent = selectedMarchIntent(target);
  if (!attackUnderfoot && !marchMapRoute(ownPlayer().position, target, { attack: intent.attack })) return;
  marchQuoteTimer = setTimeout(() => {
    const requestKey = marchQuoteKey(target);
    if (marchQuoteCache?.requestKey === requestKey || marchQuoteFailureKey === requestKey) return;
    const pendingKey = `intent:quote-march:${requestKey}`;
    if (pendingHostKeys.has(pendingKey)) return;
    host("intent", { intent: { type: "quote-march", ...intent, requestKey } }, { expectResult: true, silent: true, key: pendingKey });
  }, 120);
}

function buildMapTaskOverlays() {
  const accountId = ownAccountId();
  if (!accountId || !ownPlayer()) return [];
  const jobs = Object.values(payload?.world?.jobs || {}).filter(job => job?.accountId === accountId);
  const overlays = [];
  for (const job of jobs) {
    if (job.type === "march") {
      const route = marchMapRoute(job.from, job.to, { path: job.path, attack: job.attack });
      if (route) overlays.push({ type: "march", job, ...route, preview: false });
    } else if (["mining", "training"].includes(job.type) && validMapPosition(job)) {
      // Non-overlapping corner badges leave the centre free for the player and generals.
      overlays.push({ type: job.type, job, x: job.x + (job.type === "mining" ? .045 : .575), y: job.y + .045, width: .38, height: .38 });
    }
  }
  for (const treasure of Object.values(payload?.world?.treasureSpawns || {})) {
    if (validMapPosition(treasure) && !payload?.world?.claimedTreasures?.[treasure.id]) {
      overlays.push({ type: "treasure", treasure, x: treasure.x + .08, y: treasure.y + .56, width: .35, height: .35 });
    }
  }
  if (!jobs.some(job => job.type === "march")) {
    const target = selected;
    const intent = selectedMarchIntent(target);
    const requestKey = marchQuoteKey(target);
    const quotedPath = marchQuoteCache?.requestKey === requestKey ? marchQuoteCache.path : null;
    const route = marchMapRoute(ownPlayer()?.position, target, { path: quotedPath, attack: intent.attack });
    if (route) overlays.unshift({ type: "march", ...route, ...selectedMarchQuote(route, target), preview: true });
  }
  return overlays;
}

function mapSegmentDistance(point, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const progress = lengthSquared ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - from.x - progress * dx, point.y - from.y - progress * dy);
}

function mapTaskAt(point, pixelsPerCell) {
  if (!point || !Number.isFinite(pixelsPerCell) || pixelsPerCell <= 0) return null;
  // Badge hit areas take precedence when an army crosses a working tile.
  const badge = mapTaskOverlays.find(item => item.type !== "march"
    && point.x >= item.x && point.x <= item.x + item.width && point.y >= item.y && point.y <= item.y + item.height);
  if (badge) return badge;
  const tolerance = Math.max(.18, Math.min(.45, 7 / pixelsPerCell));
  return mapTaskOverlays.find(item => item.type === "march"
    && item.points.slice(1).some((to, index) => mapSegmentDistance(point, item.points[index], to) <= tolerance)) || null;
}

function mapTaskDescription(item, now = hostTime()) {
  if (item.type === "treasure") return `天材地宝 · ${MATERIAL_NAMES[item.treasure.materialId] || "未知品质"}\n占领 (${item.treasure.x}, ${item.treasure.y}) 后获取`;
  if (item.type === "march" && item.preview) {
    return `行军路线预览\n起点 (${item.from.x}, ${item.from.y}) → 目标 (${item.to.x}, ${item.to.y})\n预计耗时：${formatDuration(item.durationMs)}\n点击「向这里行军」后出发`;
  }
  const job = item.job;
  const finish = Number(job.finishAt || (Number(job.lastSettledAt) + Number(job.cycleMs)));
  const remaining = finish > now ? formatDuration(finish - now) : "等待结算";
  if (job.type === "mining") {
    return `开采资源 · (${job.x}, ${job.y})\n本轮剩余：${remaining}\n本轮预计获得：${formatNumber(job.yieldPerCycle)} 金币`;
  }
  if (job.type === "training") {
    const cell = dynamicCell(job.x, job.y);
    const expected = Math.max(0, Math.min(Number(job.amount || 0), garrisonCapAt(job.x, job.y, cell) - Number(cell.soldiers || 0)));
    return `练兵 · (${job.x}, ${job.y})\n剩余：${remaining}\n预计新增：${formatNumber(expected)} 士兵${expected < Number(job.amount) ? `（计划 ${formatNumber(job.amount)} 人，受驻军上限限制）` : ""}`;
  }
  return `${job.attack ? "进攻行军" : "行军中"}\n起点 (${job.from.x}, ${job.from.y}) → 目标 (${job.to.x}, ${job.to.y})\n剩余：${remaining}\n随军：${formatNumber(job.soldiers)} 士兵 · ${(job.generalIds || []).length} 名将领`;
}

function mapCanvasPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  // The 4px canvas border is outside the drawing surface, including when zoomed.
  const scale = rect.width / canvas.offsetWidth;
  const left = rect.left + canvas.clientLeft * scale, top = rect.top + canvas.clientTop * scale;
  const width = canvas.clientWidth * scale, height = canvas.clientHeight * scale;
  if (width <= 0 || height <= 0 || clientX < left || clientY < top || clientX >= left + width || clientY >= top + height) return null;
  return { x: (clientX - left) / width * 64, y: (clientY - top) / height * 64, pixelsPerCell: width / 64 };
}

function hideMapTaskTooltip() {
  mapPointer = null;
  document.querySelector("#map-task-tooltip").classList.add("hidden");
}

function renderMapTaskTooltip() {
  const tooltip = document.querySelector("#map-task-tooltip");
  const point = mapPointer && !panState ? mapCanvasPoint(mapPointer.x, mapPointer.y) : null;
  const item = point && mapTaskAt(point, point.pixelsPerCell);
  if (!item) { tooltip.classList.add("hidden"); return; }
  tooltip.textContent = mapTaskDescription(item);
  if (item.type === "march" && !item.preview) {
    const cost = Number(item.job?.cost || item.job?.goldCost || 0);
    const line = document.createElement("span");
    line.className = "route-cost";
    line.textContent = `已支付：${formatNumber(cost)} 金币`;
    tooltip.append(line);
  }
  tooltip.classList.remove("hidden");
  const left = Math.max(8, Math.min(mapPointer.x + 14, window.innerWidth - tooltip.offsetWidth - 8));
  const top = mapPointer.y > tooltip.offsetHeight + 22 ? mapPointer.y - tooltip.offsetHeight - 14 : mapPointer.y + 18;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - tooltip.offsetHeight - 8))}px`;
}

function drawMapTasks(size) {
  mapTaskOverlays = buildMapTaskOverlays();
  context.save();
  context.lineJoin = "round";
  context.lineCap = "round";
  for (const item of mapTaskOverlays.filter(overlay => overlay.type === "march")) {
    const color = item.preview ? "#375d6c" : "#973c2d";
    context.beginPath();
    item.points.forEach((point, index) => {
      if (index) context.lineTo(point.x * size, point.y * size);
      else context.moveTo(point.x * size, point.y * size);
    });
    context.strokeStyle = "#fff5d9"; context.lineWidth = size * .12; context.stroke();
    context.setLineDash(item.preview ? [size * .18, size * .13] : []);
    context.strokeStyle = color; context.lineWidth = size * .065; context.stroke();
    context.setLineDash([]);
    const from = item.points[0], to = item.points.at(-1), previous = item.points.at(-2);
    context.fillStyle = "#fff5d9"; context.strokeStyle = color; context.lineWidth = size * .055;
    context.beginPath(); context.arc(from.x * size, from.y * size, size * .15, 0, Math.PI * 2); context.fill(); context.stroke();
    context.beginPath(); context.arc(to.x * size, to.y * size, size * .19, 0, Math.PI * 2); context.fill(); context.stroke();
    context.save();
    context.translate(to.x * size, to.y * size);
    context.rotate(Math.atan2(to.y - previous.y, to.x - previous.x));
    context.fillStyle = color;
    context.beginPath(); context.moveTo(size * .115, 0); context.lineTo(-size * .075, -size * .095);
    context.lineTo(-size * .075, size * .095); context.closePath(); context.fill();
    context.restore();
  }
  for (const item of mapTaskOverlays.filter(overlay => overlay.type !== "march")) {
    context.save();
    context.translate(item.x * size, item.y * size);
    context.scale(item.width * size / 24, item.height * size / 24);
    if (item.type === "treasure") {
      const palette = { white: "#f6f1df", green: "#8fc16b", blue: "#77b3d4", purple: "#ba84cb", gold: "#f3c352", "red-ascend": "#df6553", "red-reroll": "#df6553" };
      context.fillStyle = palette[item.treasure.materialId] || "#f6f1df";
      context.strokeStyle = "#4b3829"; context.lineWidth = 2;
      context.beginPath(); context.moveTo(12, 1); context.lineTo(22, 10); context.lineTo(12, 23); context.lineTo(2, 10); context.closePath(); context.fill(); context.stroke();
      context.strokeStyle = "#fff7dd"; context.lineWidth = 1;
      context.beginPath(); context.moveTo(5, 9); context.lineTo(12, 4); context.stroke();
      context.restore(); continue;
    }
    context.fillStyle = item.type === "mining" ? "#fff0be" : "#e8eef4";
    context.strokeStyle = "#4b3829"; context.lineWidth = 1.6;
    context.beginPath(); context.roundRect(0, 0, 24, 24, 4); context.fill(); context.stroke();
    if (item.type === "mining") {
      // Hand-drawn pickaxe: wood shaft and steel head, no font or image assets.
      context.strokeStyle = "#805126"; context.lineWidth = 3.2;
      context.beginPath(); context.moveTo(6, 19); context.lineTo(15, 6); context.stroke();
      context.fillStyle = "#68828a"; context.strokeStyle = "#354b53"; context.lineWidth = 1.2;
      context.beginPath(); context.moveTo(4, 6); context.quadraticCurveTo(13, 1, 21, 15);
      context.lineTo(15, 10); context.lineTo(11, 7); context.closePath(); context.fill(); context.stroke();
    } else {
      // Crossed swords distinguish recruiting from resource collection.
      context.strokeStyle = "#354b63"; context.lineWidth = 2.6;
      context.beginPath(); context.moveTo(7, 18); context.lineTo(18, 5); context.moveTo(6, 5); context.lineTo(18, 18); context.stroke();
      context.strokeStyle = "#bb8031"; context.lineWidth = 2.8;
      context.beginPath(); context.moveTo(4, 14); context.lineTo(10, 19); context.moveTo(14, 19); context.lineTo(20, 14); context.stroke();
    }
    context.restore();
  }
  context.restore();
  renderMapTaskTooltip();
}

function draw() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  const size = canvas.width / 64;
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) {
    const info = fact(x, y);
    const cell = dynamicCell(x, y);
    context.fillStyle = ownerColor(cell.ownerAccountId, info.resourceRank, Number(info.centralLayer) - 1, x, y);
    context.fillRect(x * size, y * size, size, size);
    if (cell.generalIds?.length) {
      context.fillStyle = "#fff1a6";
      context.fillRect(x * size + size * .33, y * size + size * .33, size * .34, size * .34);
    }
  }
  context.strokeStyle = "#536744";
  context.globalAlpha = .34;
  context.lineWidth = 2;
  for (let i = 0; i <= 64; i += 1) {
    context.beginPath(); context.moveTo(i * size, 0); context.lineTo(i * size, canvas.height); context.stroke();
    context.beginPath(); context.moveTo(0, i * size); context.lineTo(canvas.width, i * size); context.stroke();
  }
  context.globalAlpha = 1;
  if (selected) {
    context.fillStyle = "#fff3ad"; context.globalAlpha = .42;
    context.fillRect(selected.x * size + 2, selected.y * size + 2, size - 4, size - 4);
    context.globalAlpha = 1; context.strokeStyle = "#3d2c20"; context.lineWidth = 6;
    context.strokeRect(selected.x * size + 3, selected.y * size + 3, size - 6, size - 6);
  }
  drawMapTasks(size);
  const player = ownPlayer();
  if (player?.position) {
    const px = (player.position.x + .5) * size;
    const py = (player.position.y + .5) * size;
    context.fillStyle = "#fff8e5"; context.strokeStyle = "#993d33"; context.lineWidth = size * .08;
    context.beginPath(); context.moveTo(px, py - size * .25); context.lineTo(px + size * .20, py);
    context.lineTo(px, py + size * .25); context.lineTo(px - size * .20, py); context.closePath();
    context.fill(); context.stroke();
  }
}

function updateMapScale(preserveCenter = true) {
  hideMapTaskTooltip();
  const previous = mapCssSize || canvas.getBoundingClientRect().width || 2048;
  const centerX = (viewport.scrollLeft + viewport.clientWidth / 2 - canvas.offsetLeft) / previous;
  const centerY = (viewport.scrollTop + viewport.clientHeight / 2 - canvas.offsetTop) / previous;
  const visibleSpan = Math.max(300, viewport.clientWidth - 28);
  const next = visibleSpan / DEFAULT_VISIBLE_CELLS * 64 * zoom;
  mapCssSize = next;
  canvas.style.width = `${next}px`;
  canvas.style.height = `${next}px`;
  document.querySelector("#zoom-label").textContent = `${Number(zoom.toFixed(3))}×`;
  if (preserveCenter) requestAnimationFrame(() => viewport.scrollTo({
    left: canvas.offsetLeft + centerX * next - viewport.clientWidth / 2,
    top: canvas.offsetTop + centerY * next - viewport.clientHeight / 2
  }));
}
function setZoom(next) {
  const clamped = Math.max(ZOOM_LEVELS[0], Math.min(ZOOM_LEVELS.at(-1), next));
  if (clamped === zoom) return;
  zoom = clamped;
  updateMapScale(true);
}
function stepZoom(direction) {
  const nearest = ZOOM_LEVELS.reduce((best, value, index) => Math.abs(value - zoom) < Math.abs(ZOOM_LEVELS[best] - zoom) ? index : best, 0);
  setZoom(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, nearest + direction))]);
}
function centerMap(position, behavior = "smooth") {
  if (!position) return;
  if (mapCenterFrame != null) cancelAnimationFrame(mapCenterFrame);
  // Let pending panel-size changes finish before choosing the final map center.
  mapCenterFrame = requestAnimationFrame(() => {
    mapCenterFrame = null;
    const tile = mapCssSize / 64;
    viewport.scrollTo({
      left: canvas.offsetLeft + (position.x + .5) * tile - viewport.clientWidth / 2,
      top: canvas.offsetTop + (position.y + .5) * tile - viewport.clientHeight / 2,
      behavior
    });
  });
}

function renderClock() {
  const now = hostTime();
  document.querySelector("#clock").textContent = new Date(now).toLocaleTimeString("zh-CN", { hour12: false });
  document.querySelector("#year").textContent = `第 ${gameYear()} 年`;
  document.querySelector("#points-balance-value").textContent = formatPointValue(payload?.account?.points);
}

function renderModelUsage() {
  const events = Array.isArray(payload?.modelUsageEvents) ? payload.modelUsageEvents : [];
  document.querySelector("#points-remaining").textContent = `剩余 ${formatPointValue(payload?.account?.points)}`;
  const target = document.querySelector("#model-usage-log");
  target.replaceChildren();
  target.classList.toggle("empty", !events.length);
  if (!events.length) { target.textContent = "本次尚未调用模型"; return; }
  [...events].reverse().forEach(item => {
    const node = document.createElement("article");
    node.className = `model-usage-item${item.status === "failed" ? " failed" : ""}`;
    const title = document.createElement("b");
    title.textContent = `${item.label || "模型请求"}${Number(item.attempt || 1) > 1 ? ` · 第 ${item.attempt} 次` : ""}`;
    const total = document.createElement("strong");
    total.textContent = item?.points?.total == null ? "结算中" : `−${formatPointValue(item.points.total)} 积分`;
    const detail = document.createElement("small");
    const parts = [new Date(item.completedAt || Date.now()).toLocaleTimeString("zh-CN", { hour12: false })];
    if (item?.points?.input != null) parts.push(`输入 ${formatPointValue(item.points.input)}`);
    if (item?.points?.output != null) parts.push(`输出 ${formatPointValue(item.points.output)}`);
    parts.push(`剩余 ${formatPointValue(item.remainingPoints)}`);
    if (item.status === "failed") parts.push("本条请求失败");
    detail.textContent = parts.join(" · ");
    node.append(title, total, detail);
    target.append(node);
  });
}
function renderPlayer() {
  const player = ownPlayer();
  document.querySelector("#edit-preferences").disabled = !player;
  document.querySelector("#center-player").disabled = !player?.position;
  document.querySelector("#player-name").textContent = player?.displayName || "尚未加入";
  document.querySelector("#gold").textContent = `${formatNumber(player?.gold)} 金币`;
  document.querySelector("#player-power").textContent = player ? formatNumber(trainingPower(player)) : "0";
  const cells = Object.values(payload?.world?.cells || {}).filter(cell => cell.ownerAccountId === ownAccountId());
  const marchingSoldiers = Object.values(payload?.world?.jobs || {})
    .filter(job => job?.accountId === ownAccountId() && job.type === "march")
    .reduce((sum, job) => sum + Math.max(0, Math.trunc(Number(job.soldiers) || 0)), 0);
  document.querySelector("#territories").textContent = formatNumber(cells.length);
  document.querySelector("#soldiers").textContent = formatNumber(cells.reduce((sum, cell) => sum + Number(cell.soldiers || 0), Number(player?.fieldArmySoldiers || 0) + marchingSoldiers));
  document.querySelector("#position").textContent = player?.position ? `${player.position.x}, ${player.position.y}` : "—";
}

function powerTrainingTargets() {
  const player = ownPlayer();
  if (!player) return [];
  return [
    { value: `player:${ownAccountId()}`, type: "player", id: ownAccountId(), name: `${player.displayName}（自己）`, entity: player },
    ...Object.values(allGenerals())
      .filter(general => general.holderAccountId === ownAccountId() && general.status === "carried" && (player.carriedGeneralIds || []).includes(general.id))
      .map(general => ({ value: `general:${general.id}`, type: "general", id: general.id, name: `${general.name}（将领）`, entity: general }))
  ];
}
function renderPowerTraining() {
  const select = document.querySelector("#training-target");
  const preview = document.querySelector("#training-preview");
  const button = document.querySelector("#start-power-training");
  const previous = select.value;
  const targets = powerTrainingTargets();
  select.replaceChildren();
  for (const target of targets) {
    const option = document.createElement("option"); option.value = target.value; option.textContent = target.name; select.append(option);
  }
  if (targets.some(target => target.value === previous)) select.value = previous;
  const target = targets.find(item => item.value === select.value) || targets[0];
  const isGeneral = target?.type === "general";
  document.querySelector("#cultivation-material-field").classList.toggle("hidden", !isGeneral);
  renderMaterials();
  select.disabled = !target;
  button.disabled = !target;
  if (!target) { preview.textContent = ""; document.querySelector("#training-level").textContent = "0 / 5 次"; return; }
  const quote = target.entity.cultivationQuote;
  const count = Number(target.entity.cultivationCount || 0);
  document.querySelector("#training-level").textContent = `${count} / 5 次`;
  if (!quote || !quote.remaining) {
    preview.textContent = isGeneral ? `经验 ${generalExperienceLabel(target.entity)}` : "";
    button.disabled = true; button.textContent = count >= 5 ? "已完成修炼" : "暂不可用"; return;
  }
  const gold = document.querySelector("#cultivation-gold");
  gold.min = String(quote.goldMin); gold.max = String(quote.goldMax);
  const investmentContext = `${target.value}:${quote.attempt}`;
  if (gold.dataset.target !== investmentContext) gold.value = String(quote.goldMin);
  gold.dataset.target = investmentContext;
  const unlocked = quote.unlocked !== false && (Number(quote.gateHours || 0) === 0 || hostTime() >= Number(quote.unlockAt || 0));
  const cost = Number(gold.value);
  const validInvestment = String(gold.value).trim() !== "" && Number.isSafeInteger(cost) && cost >= quote.goldMin && cost <= quote.goldMax;
  const material = document.querySelector("#cultivation-material").value;
  const materialCount = isGeneral ? Number(ownPlayer()?.materials?.[material] || 0) : Number.POSITIVE_INFINITY;
  const experienceReady = !isGeneral || (quote.experienceReady === true
    && Number.isFinite(Number(quote.experience)) && Number(quote.experienceRequired) > 0
    && Number(quote.experience) >= Number(quote.experienceRequired));
  preview.textContent = isGeneral ? `经验 ${generalExperienceLabel({ ...target.entity, experience: quote.experience, experienceRequired: quote.experienceRequired })}` : "";
  button.disabled = !unlocked || !experienceReady || !validInvestment || quote.eligible === false || materialCount < 1 || Number(ownPlayer()?.gold || 0) < cost;
  button.textContent = !unlocked ? "尚未开放" : !experienceReady ? "经验不足" : !validInvestment ? "请输入有效金币" : quote.eligible === false ? "当前不可修炼" : materialCount < 1 ? "尚无材料" : "闭关一次";
}

function marchAvailable() {
  return Math.max(0, Math.trunc(Number(ownPlayer()?.fieldArmySoldiers) || 0));
}
function setArmyTransferConfirmation(active) {
  const confirm = document.querySelector("#army-transfer-confirm");
  const hint = document.querySelector("#army-transfer-confirm-hint");
  confirm.classList.toggle("awaiting-confirmation", active);
  hint.classList.toggle("hidden", !active);
}
function setArmyTransferDraft(value, { clamp = true, write = true } = {}) {
  const input = document.querySelector("#army-transfer-amount");
  if (!input) return;
  const minimum = Number(input.min || 0);
  const maximum = Number(input.max || 0);
  const raw = String(value ?? "").trim();
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed)) {
    armyTransferDraft = 0;
    if (write) input.value = "";
    input.removeAttribute("aria-invalid");
    document.querySelector("#army-transfer-confirm").disabled = true;
    setArmyTransferConfirmation(false);
    return;
  }
  const entered = Math.trunc(parsed);
  const inRange = entered >= minimum && entered <= maximum;
  armyTransferDraft = clamp ? Math.max(minimum, Math.min(maximum, entered)) : entered;
  if (write) input.value = String(armyTransferDraft);
  if (clamp || inRange) input.removeAttribute("aria-invalid");
  else input.setAttribute("aria-invalid", "true");
  const confirm = document.querySelector("#army-transfer-confirm");
  confirm.disabled = armyTransferDraft === 0 || input.disabled || (!clamp && !inRange);
  setArmyTransferConfirmation(!confirm.disabled);
}
function renderArmyTransferControls(player, cell, cap, enabled) {
  const input = document.querySelector("#army-transfer-amount");
  const transferPending = pendingHostKeys.has("intent:gather-march") || pendingHostKeys.has("intent:deploy-soldiers");
  const fieldArmy = Math.max(0, Math.trunc(Number(player?.fieldArmySoldiers) || 0));
  const garrison = Math.max(0, Math.trunc(Number(cell?.soldiers) || 0));
  const deployMaximum = enabled ? Math.min(fieldArmy, Math.max(0, Math.trunc(Number(cap) || 0) - garrison)) : 0;
  const gatherMaximum = enabled ? garrison : 0;
  const context = enabled ? `${player.position.x},${player.position.y}:${fieldArmy}:${garrison}:${cap}` : "";
  if (context !== armyTransferContext) {
    armyTransferContext = context;
    armyTransferDraft = 0;
  }
  input.min = String(-deployMaximum);
  input.max = String(gatherMaximum);
  input.disabled = transferPending || !enabled || (!deployMaximum && !gatherMaximum);
  document.querySelector("#army-transfer-range").textContent = `可部署 ${formatNumber(deployMaximum)} · 可征集 ${formatNumber(gatherMaximum)}`;
  document.querySelector("#army-transfer-deploy-max").disabled = transferPending || !enabled || deployMaximum < 1;
  document.querySelector("#army-transfer-gather-all").disabled = transferPending || !enabled || gatherMaximum < 1;
  document.querySelectorAll("[data-army-delta]").forEach(button => { button.disabled = input.disabled; });
  setArmyTransferDraft(armyTransferDraft);
}
function setMapCornerCollapsed(kind, collapsed) {
  const region = kind === "region";
  const shell = document.querySelector(region ? "#map-region-actions-shell" : "#map-army-transfer-shell");
  const panel = document.querySelector(region ? "#map-region-actions" : "#map-army-transfer");
  const toggle = document.querySelector(region ? "#map-region-actions-toggle" : "#map-army-transfer-toggle");
  const next = Boolean(collapsed);
  if (region) regionActionsCollapsed = next;
  else armyTransferCollapsed = next;
  shell.classList.toggle("is-collapsed", next);
  toggle.setAttribute("aria-expanded", String(!next));
  const action = next ? "展开" : "收起";
  const label = region ? "区域行动" : "驻军调度";
  toggle.setAttribute("aria-label", `${action}${label}`);
  toggle.title = `${action}${label}`;
  const inMarchModal = panel.parentElement?.id === "march-army-transfer-slot";
  if (!inMarchModal) {
    panel.inert = next;
    panel.setAttribute("aria-hidden", String(next || shell.classList.contains("hidden")));
  }
}
function placeArmyTransferPanel(inMarchModal) {
  const panel = document.querySelector("#map-army-transfer");
  const slot = document.querySelector("#march-army-transfer-slot");
  const shell = document.querySelector("#map-army-transfer-shell");
  if (inMarchModal) {
    if (panel.parentElement !== slot) slot.append(panel);
    slot.classList.remove("hidden");
    slot.setAttribute("aria-hidden", "false");
    shell.classList.add("hidden");
    return;
  }
  if (panel.parentElement !== shell) shell.prepend(panel);
  slot.classList.add("hidden");
  slot.setAttribute("aria-hidden", "true");
}
function renderMapArmyTransfer(player, activeMarch = false) {
  const panel = document.querySelector("#map-army-transfer");
  const shell = document.querySelector("#map-army-transfer-shell");
  const position = player?.position;
  const cell = position ? dynamicCell(position.x, position.y) : null;
  const visible = Boolean(position && cell?.ownerAccountId === ownAccountId() && !activeMarch);
  const inMarchModal = Boolean(visible && marchConfirmationTarget);
  placeArmyTransferPanel(inMarchModal);
  shell.classList.toggle("hidden", !visible || inMarchModal);
  panel.classList.toggle("hidden", !visible);
  panel.inert = !visible || marchSubmitting || (!inMarchModal && armyTransferCollapsed);
  panel.setAttribute("aria-hidden", String(!visible || (!inMarchModal && armyTransferCollapsed)));
  if (!visible) {
    armyTransferContext = "";
    armyTransferDraft = 0;
    renderArmyTransferControls(player, cell, 0, false);
    return;
  }
  const cap = garrisonCapAt(position.x, position.y, cell);
  const garrison = Math.max(0, Math.trunc(Number(cell?.soldiers) || 0));
  document.querySelector("#territory-army-count").textContent = `驻军 ${formatNumber(garrison)} / ${formatNumber(cap)} · 行军 ${formatNumber(player.fieldArmySoldiers)}`;
  renderArmyTransferControls(player, cell, cap, true);
}
function renderMarchConfirmation() {
  const modal = document.querySelector("#march-confirmation");
  if (!marchConfirmationTarget) return;
  const player = ownPlayer();
  if (!player?.position) { closeMarchConfirmation({ force: true }); return; }
  const activeJob = Object.values(payload?.world?.jobs || {}).find(job => job.accountId === ownAccountId() && job.type === "march");
  if (activeJob && !marchSubmitting) { closeMarchConfirmation({ force: true }); return; }
  renderMapArmyTransfer(player, false);
  const requested = marchAvailable();
  const carried = (player.carriedGeneralIds || []).map(id => allGenerals()[id]).filter(Boolean);
  const activeGenerals = carried.slice(0, 2);
  const power = requested + trainingPower(player) + activeGenerals.reduce((sum, general) => sum + Number(trainingPower(general) || general.power || 0), 0);
  document.querySelector("#march-party-count").textContent = `${formatNumber(requested)} 人`;
  document.querySelector("#march-party-power").textContent = formatNumber(power);
  const generalList = document.querySelector("#march-confirmation-generals");
  generalList.replaceChildren();
  generalList.classList.toggle("empty", !carried.length);
  if (!carried.length) generalList.textContent = "暂无随行将领";
  else carried.forEach((general, index) => {
    const node = document.createElement("span");
    node.classList.toggle("active", index < 2);
    node.textContent = general.name || "未命名将领";
    const status = document.createElement("small");
    status.textContent = index < 2 ? `生效 · ${formatNumber(trainingPower(general))} 战力` : "随行";
    status.textContent += ` · 经验 ${generalExperienceLabel(general)}`;
    node.append(status);
    generalList.append(node);
  });
  const target = marchConfirmationTarget;
  const attackUnderfoot = attackUnderfootAt(target);
  const attackForced = attackUnderfoot || hostileMarchTargetAt(target);
  const attackField = document.querySelector("#march-attack-field");
  const attackInput = document.querySelector("#march-attack");
  if (attackForced) attackInput.checked = true;
  attackField.classList.toggle("hidden", attackUnderfoot);
  attackInput.disabled = attackForced || marchSubmitting;
  const attackRequested = attackForced || Boolean(attackInput.checked);
  const requestKey = marchQuoteKey(target);
  const quotedPath = marchQuoteCache?.requestKey === requestKey ? marchQuoteCache.path : null;
  const route = marchMapRoute(player.position, target, { path: quotedPath, attack: attackRequested });
  document.querySelector("#march-confirmation-route").textContent = attackUnderfoot
    ? `当前位置 (${target.x}, ${target.y}) · 攻打此处`
    : route
      ? `(${player.position.x}, ${player.position.y}) → (${target.x}, ${target.y}) · ${route.distance} 格`
      : `(${player.position.x}, ${player.position.y}) → (${target.x}, ${target.y}) · 无法抵达`;
  const quoteFailed = marchQuoteFailureKey === requestKey;
  const transferPending = pendingHostKeys.has("intent:gather-march") || pendingHostKeys.has("intent:deploy-soldiers");
  const exactQuote = Boolean(marchQuoteCache?.requestKey === requestKey);
  const quote = exactQuote
    ? { cost: marchQuoteCache.cost, durationMs: marchQuoteCache.durationMs }
    : route ? selectedMarchQuote(route, target) : { cost: 0, durationMs: 0 };
  const cost = Math.max(0, Number(quote.cost || 0));
  const affordable = cost <= Number(player.gold || 0);
  document.querySelector("#march-party-duration").textContent = attackUnderfoot ? "立即结算" : formatDuration(quote.durationMs || route?.durationMs || 0);
  document.querySelector("#march-party-cost").textContent = exactQuote ? `${formatNumber(cost)} 金币` : "核算中…";
  document.querySelector("#march-party-cost-card").classList.toggle("unaffordable", exactQuote && !affordable);
  const note = document.querySelector("#march-confirmation-note");
  note.classList.remove("error");
  if (marchSubmitting) note.textContent = "正在处理行军，请勿重复操作。";
  else if (transferPending) note.textContent = "正在同步调兵结果，请稍候。";
  else if (!route && !attackUnderfoot) { note.textContent = "当前没有可通行的路线，请避开他人领地或选择攻打目标。"; note.classList.add("error"); }
  else if (requested < 1) note.textContent = `当前队伍没有士兵，将由 ${formatNumber(carried.length)} 名随行将领单独行军。`;
  else if (quoteFailed) { note.textContent = "行军耗时与金币核算未完成，请重新核算。"; note.classList.add("error"); }
  else if (!exactQuote) note.textContent = "正在核算行军耗时与金币消耗…";
  else if (!affordable) { note.textContent = `金币不足，还差 ${formatNumber(cost - Number(player.gold || 0))} 金币。`; note.classList.add("error"); }
  else note.textContent = `将携带全部 ${formatNumber(requested)} 名士兵与 ${formatNumber(carried.length)} 名随行将领。`;
  const submit = document.querySelector("#march-confirmation-submit");
  const retry = document.querySelector("#march-quote-retry");
  retry.classList.toggle("hidden", !quoteFailed);
  retry.disabled = marchSubmitting;
  document.querySelector("#march-confirmation-close").disabled = marchSubmitting;
  document.querySelector("#march-confirmation-cancel").disabled = marchSubmitting;
  modal.setAttribute("aria-busy", String(marchSubmitting));
  submit.disabled = marchSubmitting || transferPending || (!route && !attackUnderfoot) || !exactQuote || !affordable;
  submit.textContent = marchSubmitting ? "正在出征…" : attackForced ? "确认攻打" : "确认出征";
  modal.classList.remove("hidden");
  if ((route || attackUnderfoot) && !exactQuote && !marchSubmitting) refreshMarchQuote();
}
function openMarchConfirmation() {
  if (!selected || !ownPlayer()) return;
  marchConfirmationTarget = { x: selected.x, y: selected.y };
  marchSubmitting = false;
  marchQuoteCache = null;
  marchQuoteFailureKey = "";
  const attack = document.querySelector("#march-attack");
  attack.checked = attackUnderfootAt(marchConfirmationTarget) || hostileMarchTargetAt(marchConfirmationTarget);
  renderMarchConfirmation();
  refreshMarchQuote();
}
function closeMarchConfirmation({ force = false } = {}) {
  if (marchSubmitting && !force) return false;
  clearTimeout(marchQuoteTimer);
  marchConfirmationTarget = null;
  marchSubmitting = false;
  marchQuoteCache = null;
  marchQuoteFailureKey = "";
  const attack = document.querySelector("#march-attack");
  if (attack) { attack.checked = false; attack.disabled = false; }
  const activeMarch = Object.values(payload?.world?.jobs || {}).some(job => job.accountId === ownAccountId() && job.type === "march");
  renderMapArmyTransfer(ownPlayer(), activeMarch);
  document.querySelector("#zero-army-march-confirmation")?.classList.add("hidden");
  document.querySelector("#march-confirmation")?.classList.add("hidden");
  document.querySelector("#march-confirmation")?.removeAttribute("aria-busy");
  return true;
}
function dispatchMarch() {
  const submit = document.querySelector("#march-confirmation-submit");
  document.querySelector("#zero-army-march-confirmation").classList.add("hidden");
  renderMarchConfirmation();
  if (submit.disabled || !marchConfirmationTarget) return;
  const target = marchConfirmationTarget;
  const requestKey = marchQuoteKey(target);
  if (marchQuoteCache?.requestKey !== requestKey) {
    refreshMarchQuote();
    return;
  }
  marchSubmitting = true;
  renderMarchConfirmation();
  const expectedQuote = {
    revision: marchQuoteCache.revision,
    requestKey: marchQuoteCache.requestKey,
    path: marchQuoteCache.path,
    cost: marchQuoteCache.cost,
    durationMs: marchQuoteCache.durationMs
  };
  const requestId = sendIntent({ type: "march", ...selectedMarchIntent(target), expectedQuote });
  if (!requestId) { marchSubmitting = false; renderMarchConfirmation(); }
}
function requestMarchSubmission() {
  const submit = document.querySelector("#march-confirmation-submit");
  renderMarchConfirmation();
  if (submit.disabled || !marchConfirmationTarget) return;
  if (marchAvailable() < 1) {
    document.querySelector("#zero-army-march-confirmation").classList.remove("hidden");
    return;
  }
  dispatchMarch();
}

function canInteract(general) {
  const player = ownPlayer();
  if (!player || general?.holderAccountId !== ownAccountId()) return false;
  if (player.carriedGeneralIds?.includes(general.id) || general.status === "captured") return true;
  return general.status === "deployed" && general.location?.x === player.position?.x && general.location?.y === player.position?.y;
}

function canViewGeneralConversation(general) {
  return Boolean(general && general.holderAccountId === ownAccountId() && general.status !== "market");
}

function locateGeneral(general) {
  if (!general?.location || !Number.isInteger(Number(general.location.x)) || !Number.isInteger(Number(general.location.y))) return;
  selected = { x: Number(general.location.x), y: Number(general.location.y) };
  renderCell();
  draw();
  centerMap(selected);
}

function makeButton(text, action, className = "") {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = text; button.className = className;
  button.addEventListener("click", action);
  return button;
}

function companionElements() {
  return {
    section: document.querySelector(".area-companions"),
    list: document.querySelector("#carried-generals"),
    area: document.querySelector("#selected-area")
  };
}

function updateCompanionActiveSlots() {
  const { list } = companionElements();
  [...list.querySelectorAll(".general-card")].forEach((card, index) => card.classList.toggle("march-active", index < 2));
}

function updateCompanionListMetrics() {
  const { section, list } = companionElements();
  const cards = [...list.querySelectorAll(".general-card")];
  if (!cards.length) return;
  const gap = 7;
  const collapsedHeight = Math.ceil(cards[0].getBoundingClientRect().height);
  const desiredHeight = cards.reduce((total, card) => total + Math.ceil(card.getBoundingClientRect().height), 0) + gap * Math.max(0, cards.length - 1) + 14;
  const viewportLimit = Math.max(collapsedHeight, Math.floor(section.getBoundingClientRect().bottom - 8));
  list.style.setProperty("--companion-collapsed-height", `${collapsedHeight}px`);
  list.style.setProperty("--companion-expanded-height", `${Math.min(desiredHeight, viewportLimit)}px`);
}

function setCompanionsExpanded(expanded) {
  clearTimeout(companionHoverTimer);
  const { section, list, area } = companionElements();
  const canExpand = list.querySelectorAll(".general-card").length > 1;
  const open = Boolean(expanded && canExpand);
  section.classList.toggle("companions-expanded", open);
  area.classList.toggle("companions-expanded", open);
  if (open) updateCompanionListMetrics();
}

function finishCompanionDrag(commit = true) {
  if (!draggedGeneralId) return;
  const { section, list } = companionElements();
  const order = [...list.querySelectorAll(".general-card")].map(card => card.dataset.generalId).filter(Boolean);
  const current = (ownPlayer()?.carriedGeneralIds || []).map(String);
  list.querySelectorAll(".general-card").forEach(card => card.classList.remove("dragging"));
  section.classList.remove("sorting");
  draggedGeneralId = null;
  updateCompanionActiveSlots();
  if (commit && order.length === current.length && order.some((id, index) => id !== current[index])) {
    sendIntent({ type: "reorder-carried-generals", generalIds: order });
  }
}

function enableGeneralDrag(node) {
  node.draggable = true;
  node.addEventListener("dragstart", event => {
    draggedGeneralId = node.dataset.generalId;
    node.classList.add("dragging");
    companionElements().section.classList.add("sorting");
    setCompanionsExpanded(true);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedGeneralId);
  });
  node.addEventListener("dragend", () => finishCompanionDrag(true));
}

function generalCard(general, mode) {
  const node = document.createElement("div");
  node.className = "general-card";
  node.dataset.generalId = general.id;
  const deploying = mode === "carried" && String(general.id) === String(deployingGeneralId || "");
  node.classList.toggle("deploying", deploying);
  const line = document.createElement("div");
  const name = document.createElement("b"); name.textContent = general.name;
  const power = document.createElement("small"); power.textContent = `战力 ${formatNumber(trainingPower(general))} · 修炼 ${Number(general.cultivationCount || 0)}/5`;
  line.append(name, power);
  const note = document.createElement("small");
  note.textContent = mode === "captive" ? `原主：${accountLabel(general.loyalToAccountId || general.capturedFromAccountId)}` : general.status === "waiting" ? `留置于 ${general.location?.x},${general.location?.y}` : "随行中";
  const experience = document.createElement("small");
  experience.className = "general-experience";
  experience.textContent = `经验 ${generalExperienceLabel(general)}`;
  const buttons = document.createElement("div"); buttons.className = "buttons";
  buttons.append(makeButton("详情", () => openGeneral(general.id)));
  if (canInteract(general)) buttons.append(makeButton("交互", () => openDialogue(general.id), "primary"));
  if (mode === "carried" && general.status === "carried") buttons.append(makeButton("部署", () => confirmDeploy(general.id)));
  if (general.status === "waiting" && general.location?.x === ownPlayer()?.position?.x && general.location?.y === ownPlayer()?.position?.y) {
    buttons.append(makeButton("带在身边", () => sendIntent({ type: "take-general", generalId: general.id })));
  }
  if (mode === "captive" && general.status === "captured") {
    buttons.append(makeButton("处死", () => openExecutionAction(general.id), "danger"));
  }
  node.append(line, note, experience);
  if (general.talentSummary) {
    const talent = document.createElement("span"); talent.className = `talent-chip rarity-${general.talentSummary.rarity}`;
    talent.textContent = general.talentSummary.text || general.talentSummary.name;
    node.append(talent);
  }
  node.append(buttons);
  if (deploying) {
    const status = document.createElement("span");
    status.className = "general-deploying-status";
    const spinner = document.createElement("i"); spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("b"); text.textContent = "正在部署";
    status.append(spinner, text); node.append(status);
  }
  if (mode === "carried" && general.status === "carried" && !deploying) enableGeneralDrag(node);
  return node;
}

function marketListings() { return payload?.world?.marketListings || {}; }

function marketCooldownUntil(general) {
  return Math.max(0,
    Number(general?.marketRelistAvailableAt || 0),
    Number(general?.marketCooldownUntil || 0),
    Number(general?.marketCooldownUntilAt || 0)
  );
}

function marketCooldownText(general) {
  const remaining = marketCooldownUntil(general) - hostTime();
  return remaining > 0 ? `重新上架冷却 ${formatDuration(remaining)}` : "可上架";
}

function marketListedText(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "刚刚上架";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "刚刚上架";
  return `上架于 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

function marketSellCandidates() {
  const own = ownAccountId();
  const candidates = Object.values(allGenerals())
    .filter(general => String(general?.holderAccountId || "") === own && ["carried", "waiting"].includes(general?.status) && !general.marketListingId)
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "zh-CN"));
  return candidates;
}

function renderMarketSellChoices() {
  const select = document.querySelector("#market-sell-general");
  const submit = document.querySelector("#market-sell-submit");
  const hint = document.querySelector("#market-sell-hint");
  if (!select || !submit) return;
  const previous = select.value;
  select.replaceChildren();
  const candidates = marketSellCandidates();
  let available = 0;
  for (const general of candidates) {
    const option = document.createElement("option");
    const cooldown = marketCooldownUntil(general);
    option.value = String(general.id);
    option.textContent = `${general.name || "无名将领"} · 战力 ${formatNumber(trainingPower(general))} · 经验 ${generalExperienceLabel(general)} · ${marketCooldownText(general)}`;
    option.disabled = cooldown > hostTime();
    if (!option.disabled) available += 1;
    select.append(option);
  }
  if (!candidates.length) {
    const option = document.createElement("option");
    option.value = ""; option.textContent = "暂无可上架的自有将领"; option.disabled = true; option.selected = true; select.append(option);
  } else if (candidates.some(general => String(general.id) === previous && marketCooldownUntil(general) <= hostTime())) select.value = previous;
  else if (available) select.value = String(candidates.find(general => marketCooldownUntil(general) <= hostTime()).id);
  submit.disabled = available < 1;
  if (hint) hint.textContent = available ? "上架后将领会暂时离开随行列表；下架后可重新带在身边。" : candidates.length ? "所有候选将领都在下架后的 6 小时冷却中，请稍后再试。" : "只有自己拥有且未部署、未被俘的将领可以上架。";
}

function closeMarketSheets() {
  document.querySelector("#market-sell-sheet")?.classList.add("hidden");
  document.querySelector("#market-manage-sheet")?.classList.add("hidden");
  marketManageListingId = null;
}

function openMarketSell() {
  document.querySelector("#market-manage-sheet")?.classList.add("hidden");
  renderMarketSellChoices();
  document.querySelector("#market-sell-sheet")?.classList.remove("hidden");
  document.querySelector("#market-sell-general")?.focus();
}

function closeMarketSell() { document.querySelector("#market-sell-sheet")?.classList.add("hidden"); }

function submitMarketSell(event) {
  event.preventDefault();
  const generalId = document.querySelector("#market-sell-general")?.value || "";
  const price = Number(String(document.querySelector("#market-sell-price")?.value || "").replace(/,/g, "").trim());
  const sellerIntro = document.querySelector("#market-sell-note")?.value.trim().slice(0, 240) || "";
  const general = allGenerals()[generalId];
  if (!generalId || !general || marketCooldownUntil(general) > hostTime()) { showToast("这名将领仍在重新上架冷却中"); return; }
  if (!Number.isSafeInteger(price) || price < 1 || price > 1000000000) { showToast("售价必须是 1～1,000,000,000 的整数"); return; }
  if (!sendIntent({ type: "list-general", generalId, price, sellerIntro })) return;
  closeMarketSell();
}

let marketManageListingId = null;

function openMarketManage(listing) {
  if (!listing || String(listing.sellerAccountId) !== ownAccountId()) return;
  marketManageListingId = String(listing.listingId || "");
  document.querySelector("#market-sell-sheet")?.classList.add("hidden");
  document.querySelector("#market-manage-title").textContent = listing.general?.name || "名将";
  document.querySelector("#market-manage-text").textContent = "确认下架后，这名将领会回到你的随行列表；再次上架需要等待 6 小时。";
  document.querySelector("#market-manage-sheet")?.classList.remove("hidden");
}

function closeMarketManage() {
  marketManageListingId = null;
  document.querySelector("#market-manage-sheet")?.classList.add("hidden");
}

function confirmMarketDelist() {
  if (!marketManageListingId) return;
  const listingId = marketManageListingId;
  closeMarketManage();
  sendIntent({ type: "cancel-market-listing", listingId });
}

function marketHistoryText(general) {
  const masters = (general?.masterHistory || []).map(item => `${item.fromYear || "?"}年 · ${accountLabel(item.accountId)} · ${item.reason || "效忠"}`);
  const captives = (general?.captivityHistory || []).map(item => `${item.year || "?"}年 · 被${accountLabel(item.captorAccountId)}俘获`);
  const interactions = (general?.interactionHistory || []).slice(-24).map(item => `${item.year || "?"}年 · ${item.summary || item.userText || "互动记录"}`);
  return [...masters, ...captives, ...interactions].join("\n") || "暂无经历记录";
}

function renderMarket() {
  const listings = Object.values(marketListings());
  const count = document.querySelector("#market-count");
  if (count) count.textContent = String(listings.length);
  const total = document.querySelector("#market-total-label");
  if (total) total.textContent = `当前在售 ${formatNumber(listings.length)} 名`;
  if (!document.querySelector("#market-sell-sheet")?.classList.contains("hidden")) renderMarketSellChoices();
  const target = document.querySelector("#market-listings");
  if (!target || document.querySelector("#market-modal")?.classList.contains("hidden")) return;
  target.replaceChildren();
  if (!listings.length) {
    const empty = document.createElement("div"); empty.className = "market-empty";
    empty.textContent = "当前没有在售将领，成为第一个把名将带到市场的人吧。";
    target.append(empty); return;
  }
  for (const listing of listings.sort((left, right) => Number(right.price || 0) - Number(left.price || 0))) {
    const general = listing.general || {};
    const card = document.createElement("article"); card.className = "market-listing";
    const owned = String(listing.sellerAccountId) === ownAccountId();
    if (owned) {
      card.classList.add("market-owned");
      card.title = "点击管理这名在售将领";
      card.addEventListener("click", event => { if (!event.target.closest("button")) openMarketManage(listing); });
    }
    const header = document.createElement("header");
    const title = document.createElement("span");
    const name = document.createElement("b"); name.textContent = general.name || "无名将领";
    const seller = document.createElement("small"); seller.textContent = `卖家：${listing.sellerDisplayName || accountLabel(listing.sellerAccountId)}`;
    title.append(name, seller);
    const price = document.createElement("strong"); price.className = "market-price"; price.textContent = `${formatNumber(listing.price)} 金币`;
    header.append(title, price); card.append(header);
    const stats = document.createElement("dl");
    const rows = [["战力", formatNumber(trainingPower(general))], ["经验", generalExperienceLabel(general)], ["修炼", `${Number(general.cultivationCount || 0)} 次`], ["天赋", general.talentSummary?.text || general.talentSummary?.name || "—"]];
    for (const [label, value] of rows) { const block = document.createElement("div"); const dt = document.createElement("dt"); dt.textContent = label; const dd = document.createElement("dd"); dd.textContent = value; block.append(dt, dd); stats.append(block); }
    card.append(stats);
    const setting = document.createElement("div"); setting.className = "market-copy"; setting.textContent = `外观：${general.appearanceSetting || "—"}\n设定：${general.coreSetting || general.setting || "—"}`; card.append(setting);
    const sellerIntro = String(listing.sellerIntro || listing.sellerNote || listing.note || "").trim();
    if (sellerIntro) { const note = document.createElement("div"); note.className = "market-seller-note"; note.textContent = `卖家介绍：${sellerIntro}`; card.append(note); }
    const history = document.createElement("div"); history.className = "market-history"; history.textContent = `经历：\n${marketHistoryText(general)}`; card.append(history);
    const footer = document.createElement("footer");
    const status = document.createElement("small"); status.textContent = owned ? "我的在售 · 点击卡片管理" : marketListedText(listing.listedAt);
    footer.append(status);
    if (owned) footer.append(makeButton("下架", event => { event?.stopPropagation?.(); openMarketManage(listing); }));
    else footer.append(makeButton("购买", () => sendIntent({ type: "buy-market-general", listingId: listing.listingId }), "primary"));
    card.append(footer); target.append(card);
  }
}

function openMarket() {
  closeMarketSheets();
  document.querySelector("#market-modal").classList.remove("hidden");
  renderMarket();
}

function renderGenerals() {
  const generals = Object.values(allGenerals()).filter(general => general.holderAccountId === ownAccountId());
  const carriedById = new Map(generals.filter(general => ["carried", "waiting"].includes(general.status)).map(general => [String(general.id), general]));
  const carried = (ownPlayer()?.carriedGeneralIds || []).map(id => carriedById.get(String(id))).filter(Boolean);
  for (const general of carriedById.values()) if (!carried.includes(general)) carried.push(general);
  const captives = generals.filter(general => general.status === "captured");
  const carriedNode = document.querySelector("#carried-generals");
  carriedNode.replaceChildren();
  carriedNode.classList.toggle("empty", !carried.length);
  if (!carried.length) carriedNode.textContent = "尚无随行将领";
  else carried.forEach(general => carriedNode.append(generalCard(general, "carried")));
  updateCompanionActiveSlots();
  if (carried.length <= 1) setCompanionsExpanded(false);
  requestAnimationFrame(updateCompanionListMetrics);
  const captiveNode = document.querySelector("#captives");
  captiveNode.replaceChildren();
  captiveNode.classList.toggle("empty", !captives.length);
  document.querySelector("#captive-count").textContent = String(captives.length);
  if (!captives.length) captiveNode.textContent = "暂无俘虏";
  else captives.forEach(general => captiveNode.append(generalCard(general, "captive")));

}

function confirmDeploy(id) {
  const general = allGenerals()[id];
  if (!general) return;
  const player = ownPlayer();
  const cell = selected && dynamicCell(selected.x, selected.y);
  const owned = cell?.ownerAccountId === ownAccountId();
  const here = player?.position?.x === selected?.x && player?.position?.y === selected?.y;
  deployGeneralId = owned && here ? id : null;
  document.querySelector("#deploy-confirmation-text").textContent = !owned
    ? "目前区域尚未占领，请行军至已占领领土部署。"
    : !here ? "请先行军至选中的自有领土，再部署将领。" : `是否将${general.name}部署到此处？`;
  document.querySelector("#deploy-confirm").classList.toggle("hidden", !deployGeneralId);
  document.querySelector("#deploy-cancel").textContent = deployGeneralId ? "取消" : "知道了";
  document.querySelector("#deploy-confirmation").classList.remove("hidden");
}
function maxTrainingInput(remainingValue, yieldModifier = 0) {
  const remaining = Math.max(0, Math.trunc(Number(remainingValue) || 0));
  let low = 0;
  let high = Math.min(10000, remaining);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const output = Math.max(1, Math.round(middle * (1 + Number(yieldModifier || 0))));
    if (output <= remaining) low = middle;
    else high = middle - 1;
  }
  return low;
}
function trainingGoldCost(amountValue, cell, remainingValue) {
  const requested = Math.max(0, Math.trunc(Number(amountValue) || 0));
  const remaining = Math.max(0, Math.trunc(Number(remainingValue) || 0));
  const amount = requested >= remaining && remaining > 0
    ? maxTrainingInput(remaining, Number(cell?.trainingYieldModifier || 0))
    : requested;
  if (!amount) return 0;
  const multiplier = Number(cell?.trainingCostMultiplier);
  return Math.max(1, Math.round(amount * 2 * (Number.isFinite(multiplier) ? multiplier : 1)));
}
function renderTrainingCost(value = document.querySelector("#train-amount")?.value) {
  const cell = selected ? dynamicCell(selected.x, selected.y) : null;
  const remaining = selected ? Math.max(0, garrisonCapAt(selected.x, selected.y, cell) - Number(cell?.soldiers || 0)) : 0;
  document.querySelector("#train-cost").textContent = formatNumber(trainingGoldCost(value, cell, remaining));
}
function renderMaterials() {
  const inventory = ownPlayer()?.materials || {};
  const holder = document.querySelector("#material-inventory");
  const select = document.querySelector("#cultivation-material");
  const previous = select.value;
  holder.replaceChildren(); select.replaceChildren();
  for (const [id, label] of Object.entries(MATERIAL_NAMES)) {
    const count = Number(inventory[id] || 0);
    if (count <= 0) continue;
    const displayLabel = MATERIAL_PURPOSES[id] ? `${label}（${MATERIAL_PURPOSES[id]}）` : label;
    const chip = document.createElement("span"); chip.className = `material-chip rarity-${id}`; chip.textContent = `${displayLabel} × ${count}`; holder.append(chip);
    const option = document.createElement("option"); option.value = id; option.textContent = `${displayLabel} × ${count}`; select.append(option);
  }
  holder.classList.toggle("empty", !holder.children.length);
  if (!holder.children.length) holder.textContent = "暂无天材地宝";
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  if (!select.options.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "暂无天材地宝"; select.append(option); }
}

function renderDeployed(cell) {
  const target = document.querySelector("#deployed-generals");
  target.replaceChildren();
  const generals = (cell?.generalIds || []).map(id => allGenerals()[id]).filter(Boolean);
  target.classList.toggle("empty", !generals.length);
  if (!generals.length) { target.textContent = "此地没有部署将领"; return; }
  for (const general of generals) {
    const node = document.createElement("div"); node.className = "deployed-card";
    const info = document.createElement("span");
    const name = document.createElement("b"); name.textContent = general.name;
    const power = document.createElement("small"); power.className = "deployed-power";
    const basePower = Math.max(0, Math.trunc(Number(general.power ?? trainingPower(general)) || 0));
    const bonusPower = Math.max(0, Math.trunc(Number(general.defenseBonusPower) || Math.floor(basePower * Number(general.defenseBonusRate || 0))));
    power.append(`战力 ${formatNumber(basePower)}`);
    const bonus = document.createElement("strong"); bonus.className = "defense-bonus"; bonus.textContent = `+${formatNumber(bonusPower)}`;
    power.append(bonus);
    const experience = document.createElement("small"); experience.className = "general-experience"; experience.textContent = `经验 ${generalExperienceLabel(general)}`;
    info.append(name, power, experience);
    const buttons = document.createElement("span");
    buttons.append(makeButton("查看", () => openGeneral(general.id)));
    const player = ownPlayer();
    const here = player?.position?.x === selected?.x && player?.position?.y === selected?.y;
    if (here && general.holderAccountId === ownAccountId()) {
      buttons.append(makeButton("交互", () => openDialogue(general.id), "primary"));
      buttons.append(makeButton("召回", () => openGeneralAction({ type: "recall", generalId: general.id, generalName: general.name, location: general.location })));
    }
    node.append(info, buttons); target.append(node);
  }
}

function renderCell() {
  const values = {
    "#cell-coordinate": "请选择地图格子", "#cell-owner": "—", "#cell-population": "—",
    "#cell-resource": "—", "#cell-garrison": "—", "#cell-power": "—"
  };
  let cell = null;
  let info = null;
  if (selected) {
    info = fact(selected.x, selected.y);
    cell = dynamicCell(selected.x, selected.y);
    const owner = payload?.world?.players?.[cell.ownerAccountId];
    const occupiedPower = cell.defensivePower ?? (Number(cell.soldiers || 0) + (cell.generalIds || []).reduce((sum, id) => sum + Number(allGenerals()[id]?.power || 0), 0));
    values["#cell-coordinate"] = `坐标 ${selected.x}, ${selected.y}`;
    values["#cell-owner"] = cell.ownerAccountId ? (owner?.displayName || "其他势力") : "未占领";
    values["#cell-population"] = formatNumber(info.population);
    values["#cell-resource"] = info.resourceGrade;
    values["#cell-garrison"] = `${formatNumber(cell.soldiers)} / ${formatNumber(garrisonCapAt(selected.x, selected.y, cell))}`;
    values["#cell-power"] = formatNumber(cell.ownerAccountId ? occupiedPower : info.neutralPower);
  }
  for (const [selector, value] of Object.entries(values)) document.querySelector(selector).textContent = value;
  renderDeployed(cell);
  const player = ownPlayer();
  const mine = selected && cell?.ownerAccountId === ownAccountId();
  const atCurrent = Boolean(player?.position && selected && player.position.x === selected.x && player.position.y === selected.y);
  const neutralUnderfoot = atCurrent && !cell?.ownerAccountId;
  const ownJobs = Object.values(payload?.world?.jobs || {}).filter(job => job.accountId === ownAccountId());
  const activeTerritoryJob = Boolean(selected && ownJobs.some(job => job.x === selected.x && job.y === selected.y && ["mining", "training"].includes(job.type)));
  const activeMiningCount = ownJobs.filter(job => job.type === "mining").length;
  const activeMarch = ownJobs.some(job => job.type === "march");
  const marchJob = ownJobs.find(job => job.type === "march");
  const currentMarchArmy = marchJob ? Number(marchJob.soldiers || 0) : Number(player?.fieldArmySoldiers || 0);
  document.querySelector("#current-march-army").textContent = `行军队伍 ${formatNumber(currentMarchArmy)} 人`;
  renderMapArmyTransfer(player, activeMarch);
  const miningCooldownUntil = selected
    ? Number(payload?.world?.privatePlayers?.[ownAccountId()]?.miningCooldowns?.[cellKey(selected.x, selected.y)] || 0)
    : 0;
  const miningCoolingDown = miningCooldownUntil > hostTime();
  const actions = document.querySelector("#map-region-actions");
  const actionsShell = document.querySelector("#map-region-actions-shell");
  const actionsVisible = Boolean(player && selected);
  actionsShell.classList.toggle("hidden", !actionsVisible);
  actions.inert = !actionsVisible || regionActionsCollapsed;
  actions.setAttribute("aria-hidden", String(!actionsVisible || regionActionsCollapsed));
  document.querySelector("#territory-actions").classList.toggle("hidden", !player || !mine);
  document.querySelector("#map-actions-coordinate").textContent = selected ? `${selected.x}, ${selected.y}` : "—";
  const miningButton = document.querySelector("#start-mining");
  const miningCooldown = document.querySelector("#mining-cooldown");
  miningButton.disabled = !player || !mine || activeTerritoryJob || miningCoolingDown || activeMiningCount >= 3;
  miningButton.textContent = "开采资源";
  if (miningCoolingDown) {
    miningCooldown.dataset.cooldownUntil = String(miningCooldownUntil);
    miningCooldown.textContent = `冷却 ${formatDuration(miningCooldownUntil - hostTime())}`;
  } else {
    delete miningCooldown.dataset.cooldownUntil;
    miningCooldown.textContent = "";
  }
  const remainingGarrison = mine ? Math.max(0, garrisonCapAt(selected.x, selected.y, cell) - Number(cell?.soldiers || 0)) : 0;
  const trainAmount = document.querySelector("#train-amount");
  trainAmount.max = String(remainingGarrison);
  trainAmount.disabled = !player || !mine || remainingGarrison < 1 || activeTerritoryJob;
  trainAmount.value = String(Math.max(0, Math.min(remainingGarrison, Math.trunc(Number(trainAmount.value) || 0))));
  document.querySelector("#train-amount-value").value = trainAmount.value;
  document.querySelector("#train-amount-max").textContent = formatNumber(remainingGarrison);
  renderTrainingCost(trainAmount.value);
  document.querySelector("#train").disabled = trainAmount.disabled || Number(trainAmount.value) < 1 || trainingGoldCost(trainAmount.value, cell, remainingGarrison) > Number(player?.gold || 0);
  const attackUnderfoot = atCurrent && cell?.ownerAccountId !== ownAccountId();
  const hostileTarget = Boolean(selected && cell?.ownerAccountId && cell.ownerAccountId !== ownAccountId());
  const route = player && selected && !atCurrent
    ? marchMapRoute(player.position, selected, { attack: hostileTarget })
    : null;
  const inaccessible = Boolean(player && selected && !atCurrent && !route);
  document.querySelector("#march").textContent = attackUnderfoot ? "攻打此处" : inaccessible ? "无法抵达" : "向这里行军";
  document.querySelector("#march").disabled = !player || !selected || (atCurrent && !attackUnderfoot) || activeMarch || inaccessible;
  if (marchConfirmationTarget) renderMarchConfirmation();
}

function renderJobs() {
  const target = document.querySelector("#jobs");
  target.replaceChildren();
  const jobs = Object.values(payload?.world?.jobs || {}).filter(job => job.accountId === ownAccountId());
  target.classList.toggle("empty", !jobs.length);
  if (!jobs.length) { target.textContent = "暂无任务"; return; }
  for (const job of jobs) {
    const node = document.createElement("div"); node.className = "job";
    const line = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = job.type === "mining" ? `开采 ${job.x},${job.y}` : job.type === "training" ? `练兵 ${formatNumber(job.amount)} 人` : job.type === "power-training" ? `${job.targetName || "角色"}修炼 ${job.levels} 阶` : `行军至 ${job.to.x},${job.to.y}`;
    const remaining = document.createElement("small");
    const finish = Number(job.finishAt || (Number(job.lastSettledAt) + Number(job.cycleMs)));
    remaining.dataset.finish = String(finish); remaining.textContent = formatDuration(finish - hostTime());
    line.append(title, remaining); node.append(line);
    if (job.type === "mining") node.append(makeButton("取消开采", () => sendIntent({ type: "stop-mining", jobId: job.id })));
    if (job.type === "march") node.append(makeButton("取消行程", () => sendIntent({ type: "cancel-march", jobId: job.id }), "primary"));
    target.append(node);
  }
}

function letterTime(item) {
  const timestamp = Number(item?.createdAt || item?.timestamp || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString("zh-CN") : "刚刚";
}

function letterText(item) { return String(item?.payload?.text || item?.text || "").trim(); }

function letterHeading(item, direction) {
  const generalName = String(item?.payload?.generalName || "").trim();
  if (direction === "out") return generalName ? `${generalName} · 发给 ${accountLabel(item?.toAccountId)}` : `发给 ${accountLabel(item?.toAccountId)}`;
  return generalName ? `${generalName} · 来自 ${accountLabel(item?.fromAccountId)}` : `来自 ${accountLabel(item?.fromAccountId)}`;
}

function openLetterDetail(item, direction = "in") {
  letterDetailItem = { item, direction };
  const modal = document.querySelector("#letter-detail-modal");
  if (!modal) return;
  const generalName = String(item?.payload?.generalName || "书信").trim();
  const purpose = String(item?.payload?.target || item?.payload?.purpose || "").trim();
  document.querySelector("#letter-detail-kind").textContent = direction === "out" ? "发出的书信" : "收到的书信";
  document.querySelector("#letter-detail-title").textContent = purpose || generalName || "书信";
  document.querySelector("#letter-detail-meta").textContent = `${letterHeading(item, direction)} · ${letterTime(item)}`;
  const purposeNode = document.querySelector("#letter-detail-purpose");
  purposeNode.textContent = "";
  purposeNode.classList.add("hidden");
  document.querySelector("#letter-detail-text").textContent = letterText(item) || "（这封信没有正文）";
  modal.classList.remove("hidden");
}

function closeLetterDetail() {
  letterDetailItem = null;
  document.querySelector("#letter-detail-modal")?.classList.add("hidden");
}

function renderLetterColumn(target, items, direction, emptyText) {
  if (!target) return;
  target.replaceChildren();
  target.classList.toggle("empty", !items.length);
  if (!items.length) { target.textContent = emptyText; return; }
  [...items].reverse().forEach(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `direct-message letter-summary ${direction === "out" ? "outgoing" : "incoming"}`;
    button.title = "点击查看完整书信";
    const line = document.createElement("span"); line.className = "letter-summary-line";
    const sender = document.createElement("b");
    const from = direction === "out" ? (item?.payload?.generalName || ownPlayer()?.displayName || accountLabel(ownAccountId())) : (item?.payload?.generalName || accountLabel(item?.fromAccountId));
    const to = direction === "out" ? accountLabel(item?.toAccountId) : (item?.payload?.recipientName || accountLabel(ownAccountId()));
    sender.textContent = `${from || "某人"} 给 ${to || "某人"} 的信件`;
    const time = document.createElement("time"); time.textContent = letterTime(item);
    line.append(sender, time);
    // Keep the inbox strip intentionally compact; the full purpose and body
    // are shown only after the player opens the centered detail sheet.
    button.append(line);
    button.addEventListener("click", () => openLetterDetail(item, direction));
    target.append(button);
  });
}

function renderInbox() {
  const inbox = Array.isArray(payload?.directInbox) ? payload.directInbox : [];
  const history = mergeDirectMessages(inbox, payload?.directHistory);
  const received = history.filter(item => item?.direction !== "out");
  const sent = history.filter(item => item?.direction === "out");
  document.querySelector("#direct-count").textContent = String(history.length);
  document.querySelector("#direct-received-count").textContent = String(received.length);
  document.querySelector("#direct-sent-count").textContent = String(sent.length);
  renderLetterColumn(document.querySelector("#direct-inbox"), received, "in", "暂无收到的书信");
  renderLetterColumn(document.querySelector("#direct-outbox"), sent, "out", "暂无发出的书信");
}

function resizeGamePanels(change) {
  const center = {
    x: (viewport.scrollLeft + viewport.clientWidth / 2 - canvas.offsetLeft) / mapCssSize,
    y: (viewport.scrollTop + viewport.clientHeight / 2 - canvas.offsetTop) / mapCssSize
  };
  change();
  requestAnimationFrame(() => {
    updateMapScale(false);
    viewport.scrollTo({
      left: canvas.offsetLeft + center.x * mapCssSize - viewport.clientWidth / 2,
      top: canvas.offsetTop + center.y * mapCssSize - viewport.clientHeight / 2
    });
  });
}
function setSocialOpen(open) {
  const panel = document.querySelector("#social-sidebar");
  const toggle = document.querySelector("#toggle-social");
  if (!open && panel.contains(document.activeElement)) toggle.focus();
  resizeGamePanels(() => {
    document.querySelector(".layout").classList.toggle("social-collapsed", !open);
    panel.inert = !open;
    panel.setAttribute("aria-hidden", String(!open));
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "收起通讯" : "展开通讯");
    toggle.title = open ? "收起通讯" : "展开通讯";
  });
  if (open) markCommunicationRead(socialTab);
}
function switchSocialTab(tab) {
  if (!["world", "generals", "letters"].includes(tab)) tab = "world";
  socialTab = tab;
  document.querySelectorAll("[data-social-tab]").forEach(button => button.classList.toggle("active", button.dataset.socialTab === tab));
  for (const name of ["world", "generals", "letters"]) document.querySelector(`#social-${name}`).classList.toggle("hidden", name !== tab);
  markCommunicationRead(tab);
}
function renderWorldChat() {
  const messages = (payload?.worldChat || []).slice(-50);
  const fingerprint = JSON.stringify(messages);
  const target = document.querySelector("#world-chat-messages");
  if (fingerprint !== worldChatFingerprint) {
    const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 60;
    const previousTop = target.scrollTop;
    const hadMessages = Boolean(target.children.length);
    target.replaceChildren();
    for (const item of messages) {
      const article = document.createElement("article");
      article.className = `chat-message${item.accountId === ownAccountId() ? " self" : ""}`;
      const header = document.createElement("header");
      const name = document.createElement("b"); name.textContent = item.displayName || accountLabel(item.accountId);
      const time = document.createElement("time"); time.textContent = new Date(item.createdAt || item.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      const text = document.createElement("p"); text.textContent = item.text;
      header.append(name, time); article.append(header, text); target.append(article);
    }
    if (!messages.length) { const empty = document.createElement("p"); empty.className = "chat-note"; empty.textContent = "尚无世界消息，来打个招呼吧。"; target.append(empty); }
    target.scrollTop = !hadMessages || nearBottom ? target.scrollHeight : previousTop;
    worldChatFingerprint = fingerprint;
  }
  document.querySelector("#world-chat-send").disabled = pendingHostKeys.has("intent:world-chat");
  document.querySelector("#world-chat-send").setAttribute("aria-disabled", String(pendingHostKeys.has("intent:world-chat")));
  document.querySelector("#world-chat-send").setAttribute("aria-busy", String(pendingHostKeys.has("intent:world-chat")));
}
function renderConversations() {
  const list = document.querySelector("#general-conversations"); list.replaceChildren();
  const generals = Object.values(allGenerals()).filter(general => canViewGeneralConversation(general));
  list.classList.toggle("hidden", Boolean(dialogueGeneralId && !document.querySelector("#dialogue-modal").classList.contains("hidden")));
  for (const general of generals) {
    const button = makeButton(general.name, () => openDialogue(general.id));
    const hint = document.createElement("small");
    hint.textContent = general.status === "captured"
      ? "俘虏交互"
      : canInteract(general)
        ? `战力 ${formatNumber(general.power)} · 点击交谈`
        : general.location
          ? `部署于 ${general.location.x},${general.location.y} · 点击定位`
          : `战力 ${formatNumber(general.power)} · 仅查看记录`;
    hint.textContent += ` · 经验 ${generalExperienceLabel(general)}`;
    button.append(hint); list.append(button);
  }
  if (!generals.length) list.textContent = "还没有将领通讯记录。";
}

function ownerPlayerEntries() {
  const entries = new Map();
  for (const [accountId, player] of Object.entries(payload?.world?.players || {})) entries.set(accountId, {
    accountId,
    displayName: player.displayName || "未设置玩家名",
    accountName: player.accountName || "未设置昵称",
    banned: Boolean(payload?.world?.bans?.[accountId]?.banned)
  });
  for (const [accountId, ban] of Object.entries(payload?.world?.bans || {})) entries.set(accountId, {
    accountId,
    displayName: entries.get(accountId)?.displayName || ban.displayName || "未设置玩家名",
    accountName: entries.get(accountId)?.accountName || ban.accountName || "未设置昵称",
    banned: Boolean(ban.banned)
  });
  return [...entries.values()].sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
}

function fillOwnerPlayerSelect(selector, entries) {
  const select = document.querySelector(selector);
  const previous = select.value;
  select.replaceChildren();
  for (const item of entries) {
    const option = document.createElement("option");
    option.value = item.accountId;
    option.textContent = `${item.displayName} · 风月昵称 ${item.accountName}`;
    option.dataset.banned = item.banned ? "true" : "false";
    select.append(option);
  }
  if (entries.some(item => item.accountId === previous)) select.value = previous;
  select.disabled = !entries.length;
}

function renderOwnerCommands() {
  const owner = Boolean(payload?.isServerOwner);
  document.querySelector("#owner-command-toggle").classList.toggle("hidden", !owner);
  document.querySelector("#owner-account").textContent = owner
    ? `服主：${payload?.serverOwnerName || payload?.account?.username || "作品作者"}`
    : "";
  document.querySelector("#owner-server-status").textContent = payload?.initialized ? "已开服" : "尚未开服";
  document.querySelector("#owner-open-server").disabled = !owner || Boolean(payload?.control || payload?.initialized);
  document.querySelector("#owner-open-server").textContent = payload?.control || payload?.initialized ? "已经开服" : "开服";
  document.querySelector("#owner-migrate-server").disabled = !owner || !payload?.initialized;
  const entries = ownerPlayerEntries();
  fillOwnerPlayerSelect("#owner-reset-player", entries);
  fillOwnerPlayerSelect("#owner-ban-player", entries);
  fillOwnerPlayerSelect("#owner-simulate-player", entries);
  document.querySelector("#owner-reset-player-button").disabled = !owner || !payload?.initialized || !entries.length;
  const simulatePlayer = document.querySelector("#owner-simulate-player");
  const simulateGeneral = document.querySelector("#owner-simulate-general");
  const previousGeneral = simulateGeneral.value;
  const deployedGenerals = Object.values(allGenerals()).filter(general => general.status === "deployed" && general.holderAccountId === simulatePlayer.value);
  simulateGeneral.replaceChildren();
  for (const general of deployedGenerals) {
    const option = document.createElement("option");
    option.value = general.id;
    option.textContent = `${general.name} · ${general.location?.x},${general.location?.y} · 经验 ${generalExperienceLabel(general)}`;
    simulateGeneral.append(option);
  }
  if (deployedGenerals.some(general => general.id === previousGeneral)) simulateGeneral.value = previousGeneral;
  simulateGeneral.disabled = !owner || !deployedGenerals.length;
  document.querySelector("#owner-simulate-recall").disabled = !owner || !payload?.initialized || !deployedGenerals.length;
  const banSelect = document.querySelector("#owner-ban-player");
  const selectedEntry = entries.find(item => item.accountId === banSelect.value);
  const banButton = document.querySelector("#owner-ban-player-button");
  banButton.disabled = !owner || !payload?.initialized || !selectedEntry;
  banButton.textContent = selectedEntry?.banned ? "解除封禁" : "封禁玩家";
  banButton.classList.toggle("danger", !selectedEntry?.banned);
  const banList = document.querySelector("#owner-ban-list");
  const banned = entries.filter(item => item.banned);
  banList.replaceChildren();
  if (!banned.length) banList.textContent = "当前没有封禁账号";
  else for (const item of banned) {
    const chip = document.createElement("span");
    chip.textContent = `${item.displayName} · ${item.accountName}`;
    banList.append(chip);
  }
  const ownBan = payload?.world?.bans?.[ownAccountId()];
  document.querySelector("#banned-notice").classList.toggle("hidden", !ownBan?.banned || owner);
}

function accountLabel(accountId) {
  const id = String(accountId || "");
  return payload?.world?.players?.[id]?.displayName || payload?.world?.bans?.[id]?.displayName || "某位主公";
}
function redactAccountIds(text) {
  return String(text || "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => accountLabel(id));
}
function battleReportCandidates() {
  return Object.values(allGenerals()).filter(general => canInteract(general));
}
function battleReportTime(report) {
  return new Date(Number(report?.createdAt || hostTime())).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
}
function appendBattleReportStat(holder, label, value, className = "") {
  const item = document.createElement("span");
  if (className) item.className = className;
  const title = document.createElement("small"); title.textContent = label;
  const content = document.createElement("strong"); content.textContent = value;
  item.append(title, content); holder.append(item);
}
function renderBattleReportGeneralPicker(report) {
  const picker = document.querySelector("#battle-report-general-picker");
  const target = document.querySelector("#battle-report-generals");
  const candidates = battleReportCandidates();
  picker.classList.toggle("hidden", !battleReportGeneralPickerOpen);
  target.replaceChildren();
  if (!battleReportGeneralPickerOpen) return;
  if (!candidates.length) {
    const empty = document.createElement("p"); empty.textContent = "当前没有可交谈的将领。"; target.append(empty); return;
  }
  for (const general of candidates) {
    const button = makeButton(general.name, () => discussBattleReportWithGeneral(report.id, general.id));
    const detail = document.createElement("small");
    detail.textContent = `${general.status === "captured" ? "俘虏" : general.status === "deployed" ? "驻守" : "随行"} · 战力 ${formatNumber(general.power)} · 经验 ${generalExperienceLabel(general)}`;
    button.append(detail); target.append(button);
  }
}
function renderBattleReports() {
  const reports = battleReports();
  const launcher = document.querySelector("#battle-report-button");
  const modal = document.querySelector("#battle-report-modal");
  launcher.classList.toggle("hidden", !reports.length);
  document.querySelector("#battle-report-count").textContent = String(reports.length);
  const latest = reports[reports.length - 1];
  launcher.classList.toggle("victory", latest?.outcome === "victory");
  launcher.classList.toggle("defeat", latest?.outcome === "defeat");
  if (!reports.length) {
    activeBattleReportId = null;
    battleReportGeneralPickerOpen = false;
    modal.classList.add("hidden");
    return;
  }
  if (modal.classList.contains("hidden")) return;
  const report = battleReportById(activeBattleReportId);
  if (!report) {
    activeBattleReportId = null;
    battleReportGeneralPickerOpen = false;
    modal.classList.add("hidden");
    return;
  }
  const victory = report.outcome === "victory";
  const lostTerritory = report.kind === "territory-loss";
  const target = report.target || {};
  const reportIndex = reports.findIndex(item => String(item.id) === String(report.id));
  document.querySelector("#battle-report-index").textContent = `${reportIndex + 1} / ${reports.length}`;
  document.querySelector("#battle-report-prev").disabled = reportIndex <= 0;
  document.querySelector("#battle-report-next").disabled = reportIndex >= reports.length - 1;
  modal.querySelector(".battle-report-modal").classList.toggle("victory", victory);
  modal.querySelector(".battle-report-modal").classList.toggle("defeat", !victory);
  document.querySelector("#battle-report-kind").textContent = lostTerritory ? "失地战报" : victory ? "攻占成功" : "进攻失利";
  document.querySelector("#battle-report-title").textContent = lostTerritory ? "领地失守" : victory ? "我方获胜" : "我方战败";
  document.querySelector("#battle-report-meta").textContent = `${battleReportTime(report)} · 目标 (${Number(target.x)}, ${Number(target.y)})`;
  const stats = document.querySelector("#battle-report-stats"); stats.replaceChildren();
  appendBattleReportStat(stats, lostTerritory ? "攻方战力" : "我方战力", formatNumber(report.attackerPower));
  appendBattleReportStat(stats, lostTerritory ? "我方战力" : "守方战力", formatNumber(report.defenderPower));
  if (Number(report.ownSurvivors || 0) > 0) appendBattleReportStat(stats, "幸存士兵", `${formatNumber(report.ownSurvivors)} 人`);
  if (Number(report.soldiersGained || 0) > 0) appendBattleReportStat(stats, "获得士兵", `${formatNumber(report.soldiersGained)} 人`, "gained");
  if (Number(report.ownLosses || 0) > 0) appendBattleReportStat(stats, "我方牺牲", `${formatNumber(report.ownLosses)} 人`, "losses");
  const specials = document.querySelector("#battle-report-specials"); specials.replaceChildren();
  const addSpecial = (label, text, className) => {
    const item = document.createElement("article"); item.className = `battle-report-special ${className}`;
    const title = document.createElement("small"); title.textContent = label;
    const content = document.createElement("b"); content.textContent = text;
    item.append(title, content); specials.append(item);
  };
  if (lostTerritory) {
    const displayName = report.attackerDisplayName || report.attackerAccountName || report.attackerAccountId;
    const accountName = report.attackerAccountName && report.attackerAccountName !== displayName ? `（${report.attackerAccountName}）` : "";
    addSpecial("攻打方", `${displayName}${accountName}`, "attacker");
    const names = (report.capturedOwnGenerals || []).map(item => item.name).filter(Boolean);
    if (names.length) addSpecial("我方被俘将领", names.join("、"), "captive");
  }
  for (const treasure of report.treasures || []) {
    if (!MATERIAL_NAMES[treasure.materialId] || !(treasure.amount > 0)) continue;
    const purpose = MATERIAL_PURPOSES[treasure.materialId];
    addSpecial("获得天材地宝", `${MATERIAL_NAMES[treasure.materialId]}${purpose ? `（${purpose}）` : ""} × ${formatNumber(treasure.amount)}`, "treasure");
  }
  const captured = (report.capturedGenerals || []).map(item => String(item?.name || allGenerals()[item?.id]?.name || "").trim()).filter(Boolean);
  if (captured.length) {
    const item = document.createElement("article"); item.className = "battle-report-special captive";
    const title = document.createElement("small"); title.textContent = "俘虏将领";
    const content = document.createElement("b"); content.textContent = captured.join("、");
    item.append(title, content); specials.append(item);
  }
  const discoveredName = String(report.discoveredGeneralName || allGenerals()[report.discoveredGeneralId]?.name || "").trim();
  if (discoveredName || report.discoveryId) {
    const item = document.createElement("article"); item.className = "battle-report-special discovered";
    const title = document.createElement("small"); title.textContent = "发掘将领";
    const content = document.createElement("b"); content.textContent = discoveredName || "待提拔的拔尖兵士";
    item.append(title, content); specials.append(item);
  }
  specials.classList.toggle("hidden", !specials.children.length);
  const candidates = battleReportCandidates();
  const discuss = document.querySelector("#battle-report-discuss");
  discuss.disabled = !candidates.length;
  discuss.textContent = candidates.length ? (battleReportGeneralPickerOpen ? "收起将领列表" : "与将领讨论") : "暂无可讨论将领";
  renderBattleReportGeneralPicker(report);
}
function openBattleReport() {
  const reports = battleReports();
  if (!reports.length) return;
  document.querySelector("#battle-report-modal").classList.remove("hidden");
  selectBattleReport(reports[reports.length - 1].id);
}
function selectBattleReport(id) {
  const report = battleReportById(id);
  if (!report) return;
  activeBattleReportId = String(report.id);
  battleReportGeneralPickerOpen = false;
  renderBattleReports();
  centerMap(report.target);
}
function closeBattleReport() {
  battleReportGeneralPickerOpen = false;
  document.querySelector("#battle-report-modal").classList.add("hidden");
}
function dismissBattleReport() {
  const report = battleReportById(activeBattleReportId);
  if (!report) { closeBattleReport(); return; }
  const reportId = String(report.id);
  closeBattleReport();
  activeBattleReportId = null;
  sendIntent({ type: "dismiss-battle-report", reportId });
}
function discussBattleReportWithGeneral(reportId, generalId) {
  const report = battleReportById(reportId);
  const general = allGenerals()[generalId];
  if (!report || !canInteract(general)) { showToast("这份战报或将领已经不在可用范围内"); renderBattleReports(); return; }
  const marker = battleReportMarker(report);
  closeBattleReport();
  openDialogue(generalId);
  battleDiscussionContext = { reportId: String(report.id), generalId: String(general.id), marker };
  const input = document.querySelector("#dialogue-input");
  input.value = `${marker}\n`;
  input.focus();
}
function openGeneral(id) {
  generalDetailId = id;
  const general = allGenerals()[id];
  if (!general) return;
  document.querySelector("#general-status").textContent = general.status === "captured" ? "俘虏档案" : general.status === "deployed" ? "部署档案" : "随行档案";
  document.querySelector("#general-name").textContent = general.name;
  document.querySelector("#general-profile-name").textContent = general.name;
  document.querySelector("#general-gender").textContent = general.gender === "female" ? "女" : "男";
  document.querySelector("#general-height").textContent = `${Number(general.heightCm || (general.gender === "female" ? 166 : 178))} cm`;
  document.querySelector("#general-weight").textContent = `${Number(general.weightKg || (general.gender === "female" ? 55 : 72))} kg`;
  const measurements = general.measurements || {};
  document.querySelector("#general-measurements").textContent = `${Number(measurements.chestCm || 0)} / ${Number(measurements.waistCm || 0)} / ${Number(measurements.hipCm || 0)} cm`;
  document.querySelector("#general-power").textContent = `${formatNumber(trainingPower(general))} / 修炼 ${Number(general.cultivationCount || 0)} 次`;
  document.querySelector("#general-experience").textContent = generalExperienceLabel(general);
  document.querySelector("#general-holder").textContent = accountLabel(general.holderAccountId);
  document.querySelector("#general-appearance").textContent = redactAccountIds(general.appearanceSetting || "沿用旧档案，暂无独立外观分类。");
  document.querySelector("#general-core-setting").textContent = redactAccountIds(general.coreSetting || general.setting || "暂无核心设定");
  document.querySelector("#general-talent").textContent = general.talentSummary?.text || general.talentSummary?.name || "暂无天赋信息";
  document.querySelector("#general-talent").className = `rarity-${general.talentSummary?.rarity || "white"}`;
  const service = document.querySelector("#general-service-history"); service.replaceChildren();
  const records = [
    ...(general.masterHistory || []).map(item => `[${item.fromYear}年${item.toYear == null ? "至今" : "—" + item.toYear + "年"}] 主公：${accountLabel(item.accountId)}（${item.reason || "效忠"}）`),
    ...(general.captivityHistory || []).map(item => `[${item.year}年] 被 ${accountLabel(item.captorAccountId)} 俘虏；此前主公：${accountLabel(item.formerMasterAccountId)}`)
  ];
  if (!records.length) service.textContent = "暂无归属记录";
  else records.forEach(text => { const p = document.createElement("p"); p.textContent = text; service.append(p); });
  const history = document.querySelector("#general-history"); history.replaceChildren();
  const interactions = general.interactionHistory || [];
  if (!interactions.length) history.textContent = redactAccountIds(general.memoryText || "暂无互动记录");
  else interactions.forEach(item => {
    const p = document.createElement("p");
    p.textContent = redactAccountIds(`[${item.year}年] ${item.userText || "交谈"}\n${item.reply || "—"}${item.narration ? `\n${item.narration}` : ""}`);
    history.append(p);
  });
  document.querySelector("#general-interact").classList.toggle("hidden", !canInteract(general));
  document.querySelector("#general-modal").classList.remove("hidden");
}

function renderDialogue() {
  const general = allGenerals()[dialogueGeneralId];
  if (!general) return;
  const available = canInteract(general);
  document.querySelector("#dialogue-general").textContent = general.name;
  document.querySelector("#dialogue-mode").textContent = general.status === "captured" ? "俘虏交互" : available ? "将领互动" : "异地部署 · 仅查看";
  const history = document.querySelector("#dialogue-history"); history.replaceChildren();
  const lines = general.interactionHistory || [];
  const outgoing = [...dialogueRequests.values()].filter(item => item.generalId === dialogueGeneralId);
  const sendButton = document.querySelector("#dialogue-send");
  const input = document.querySelector("#dialogue-input");
  const waiting = outgoing.some(item => item.status === "sending");
  sendButton.disabled = waiting || !available;
  input.disabled = !available;
  input.placeholder = available ? "想和将领说什么？" : "抵达将领所在区域后可继续交谈";
  sendButton.setAttribute("aria-busy", String(waiting));
  if (!lines.length && !outgoing.length) { const p = document.createElement("p"); p.textContent = "尚无对话记录。"; history.append(p); }
  lines.forEach(item => {
    const user = document.createElement("p"); user.className = "user"; user.textContent = redactAccountIds(item.userText || "交谈");
    const reply = document.createElement("p"); reply.textContent = redactAccountIds(item.reply || "—");
    history.append(user, reply);
    if (item.narration) {
      const narration = document.createElement("p");
      narration.className = "dialogue-narration";
      narration.textContent = redactAccountIds(item.narration);
      history.append(narration);
    }
  });
  outgoing.forEach(item => {
    const user = document.createElement("p"); user.className = "user";
    user.textContent = redactAccountIds(item.topic);
    const status = document.createElement("p"); status.className = item.status === "failed" ? "dialogue-failed" : "dialogue-pending";
    status.textContent = item.status === "failed" ? `发送失败：${item.error || "请重试"}` : "正在等待将领回复……";
    history.append(user, status);
  });
  history.scrollTop = history.scrollHeight;
}
function failDialogueRequest(requestId, message) {
  const request = dialogueRequests.get(requestId);
  if (!request) return;
  request.status = "failed";
  request.error = String(message || "行动失败");
  const input = document.querySelector("#dialogue-input");
  if (dialogueGeneralId === request.generalId && !input.value.trim()) {
    const report = request.battleReportId && typeof battleReportById === "function" ? battleReportById(request.battleReportId) : null;
    if (report && typeof battleDiscussionContext !== "undefined") {
      battleDiscussionContext = { reportId: request.battleReportId, generalId: request.generalId, marker: request.battleReportMarker || battleReportMarker(report) };
      input.value = `${battleDiscussionContext.marker}\n${request.topic}`.trimEnd();
    } else input.value = request.topic;
  }
  if (dialogueGeneralId === request.generalId) renderDialogue();
}
function finishDialogueResult(requestId, result) {
  if (!dialogueRequests.has(requestId)) return;
  if (result?.dialogue?.reply) dialogueRequests.delete(requestId);
  else failDialogueRequest(requestId, "请求结束，但没有返回将领回复");
}

function closeGeneralAction() {
  pendingGeneralAction = null;
  document.querySelector("#general-action-modal").classList.add("hidden");
}

function openGeneralAction(action) {
  if (!action) return;
  pendingGeneralAction = { ...action };
  const kind = String(action.type || "");
  const title = document.querySelector("#general-action-title");
  const description = document.querySelector("#general-action-description");
  const confirm = document.querySelector("#general-action-confirm");
  const reject = document.querySelector("#general-action-reject");
  const guidanceField = document.querySelector("#general-action-guidance-field");
  guidanceField.classList.toggle("hidden", !(kind === "letter" && action.guidanceRequired));
  document.querySelector("#general-action-guidance").value = "";
  if (kind === "recall") {
    document.querySelector("#general-action-kind").textContent = "召回将领";
    title.textContent = `召回${action.generalName || "这名将领"}？`;
    description.textContent = `将从 ${action.location?.x ?? "—"},${action.location?.y ?? "—"} 撤下部署并回到随行将领。`;
    confirm.textContent = "确认召回";
    reject.textContent = "取消";
  } else if (kind === "execution") {
    document.querySelector("#general-action-kind").textContent = "俘虏处置";
    title.textContent = "是否允许写诀别信？";
    description.textContent = (action.generalName || "这名俘虏") + "即将被处死。可以先消耗少量积分生成一封诀别信，或直接处死。";
    confirm.textContent = "写诀别信并处死";
    reject.textContent = "直接处死";
  } else if (kind === "appearance") {
    document.querySelector("#general-action-kind").textContent = "外观变更";
    title.textContent = "允许将领改变外观吗？";
    description.textContent = (action.generalName || "这名将领") + "希望变更外观：" + (action.note || "未注明内容") + "\n同意后会消耗少量积分生成新的外观设定。";
    confirm.textContent = "同意并消耗积分";
    reject.textContent = "拒绝";
  } else {
    document.querySelector("#general-action-kind").textContent = action.kind === "surrender" ? "归顺书信" : "将领书信";
    title.textContent = "将领请求写信";
    description.textContent = (action.generalName || "这名将领") + "想给" + (action.recipientName || "前任主公") + "写一封信，为了" + (action.purpose || "说明近况") + "。\n同意会消耗少量积分生成信件。";
    confirm.textContent = "同意并消耗积分";
    reject.textContent = "拒绝";
  }
  document.querySelector("#general-action-modal").classList.remove("hidden");
}

function resolveGeneralAction(accepted) {
  const action = pendingGeneralAction;
  if (!action) return;
  if (!accepted) {
    if (action.type === "execution") sendIntent({ type: "execute-captive", generalId: action.generalId, allowFarewell: false });
    closeGeneralAction();
    return;
  }
  let intent;
  if (action.type === "recall") {
    intent = { type: "recall-general", generalId: action.generalId };
  } else if (action.type === "execution") {
    intent = { type: "execute-captive", generalId: action.generalId, allowFarewell: true, guidance: document.querySelector("#general-action-guidance").value.trim() };
  } else if (action.type === "appearance") {
    intent = { type: "edit-general-appearance", generalId: action.generalId, note: action.note };
  } else {
    intent = {
      type: "generate-general-letter", generalId: action.generalId,
      recipientKey: action.recipientKey, recipientAccountId: action.recipientAccountId,
      purpose: action.purpose, kind: action.kind,
      guidance: document.querySelector("#general-action-guidance").value.trim() || action.guidance || ""
    };
  }
  closeGeneralAction();
  sendIntent(intent);
}

function openExecutionAction(generalId) {
  const general = allGenerals()[generalId];
  if (!general) return;
  openGeneralAction({ type: "execution", generalId, generalName: general.name });
}
function renderGeneralDiscoveryPrompt() {
  const modal = document.querySelector("#general-discovery-confirmation");
  const candidate = pendingGeneralDiscoveries().find(item => String(item.id) === String(generalDiscoveryId)) || pendingGeneralDiscoveries()[0];
  if (!candidate) {
    generalDiscoveryId = null;
    generalDiscoverySubmitting = false;
    modal.classList.add("hidden");
    return;
  }
  generalDiscoveryId = String(candidate.id);
  const sourceText = candidate.sourceKind === "training"
    ? `练兵完成后，在 ${candidate.x},${candidate.y} 附近发现了一名拔尖兵士。`
    : `击败中立守军后，在 ${candidate.x},${candidate.y} 发现了一名拔尖兵士。`;
  document.querySelector("#general-discovery-text").textContent = `${sourceText} 是否要将其提拔为将领？确认后会消耗少量积分生成将领信息。`;
  const confirm = document.querySelector("#general-discovery-confirm");
  const decline = document.querySelector("#general-discovery-decline");
  confirm.disabled = generalDiscoverySubmitting;
  decline.disabled = generalDiscoverySubmitting;
  confirm.textContent = generalDiscoverySubmitting ? "正在生成…" : "提拔为将领";
  modal.classList.remove("hidden");
}
function openDialogue(id) {
  const general = allGenerals()[id];
  if (!canViewGeneralConversation(general)) { showToast("这名将领当前不在你的通讯名册中"); return; }
  if (!canInteract(general)) locateGeneral(general);
  if (typeof clearInvalidBattleDiscussion === "function") clearInvalidBattleDiscussion();
  if (typeof battleDiscussionContext !== "undefined" && battleDiscussionContext && String(battleDiscussionContext.generalId) !== String(id)) {
    const input = document.querySelector("#dialogue-input");
    input.value = withoutBattleReportMarker(input.value, battleDiscussionContext.marker);
    battleDiscussionContext = null;
  }
  dialogueGeneralId = id;
  setSocialOpen(true);
  switchSocialTab("generals");
  document.querySelector("#general-conversations").classList.add("hidden");
  document.querySelector("#general-modal").classList.add("hidden");
  document.querySelector("#dialogue-modal").classList.remove("hidden");
  renderDialogue();
  if (canInteract(general)) document.querySelector("#dialogue-input").focus();
}

function renderConnectionNotice() {
  const notice = document.querySelector("#connection-notice");
  const button = document.querySelector("#connection-retry");
  const retrying = pendingHostKeys.has("sync");
  notice.classList.toggle("hidden", !["degraded", "error"].includes(payload?.status) && !retrying);
  button.disabled = retrying;
  button.textContent = retrying ? "重试中" : "重试";
  button.setAttribute("aria-busy", String(retrying));
}
function renderAll() {
  renderClock(); renderPlayer(); renderModelUsage(); renderPowerTraining(); renderCell(); renderJobs(); renderGenerals(); renderInbox(); renderWorldChat(); renderConversations(); renderOwnerCommands(); renderMarket(); renderBattleReports(); draw();
  renderConnectionNotice();
  const player = ownPlayer();
  const banned = Boolean(payload?.world?.bans?.[ownAccountId()]?.banned);
  document.querySelector("#join-wizard").classList.toggle("hidden", !payload?.initialized || Boolean(player) || banned);
  if (payload?.initialized && !player && !banned) renderJoinWizard();
  if (payload?.initialized && player && !banned) renderGeneralDiscoveryPrompt();
  if (generalDetailId && !document.querySelector("#general-modal").classList.contains("hidden")) {
    if (allGenerals()[generalDetailId]) openGeneral(generalDetailId); else document.querySelector("#general-modal").classList.add("hidden");
  }
  if (dialogueGeneralId && !document.querySelector("#dialogue-modal").classList.contains("hidden")) {
    if (canViewGeneralConversation(allGenerals()[dialogueGeneralId])) renderDialogue();
    else {
      dialogueGeneralId = null;
      document.querySelector("#dialogue-modal").classList.add("hidden");
      document.querySelector("#dialogue-history").replaceChildren();
      renderConversations();
    }
  }
  updateMapScale(false);
  if (player?.position && !mapCentered) { mapCentered = true; requestAnimationFrame(() => centerMap(player.position, "auto")); }
}

function profileItems() { return payload?.characterProfiles?.items || []; }
function renderProfileOptions() {
  const target = document.querySelector("#profile-options");
  if (!joinDraft.profileId) joinDraft.profileId = payload?.characterProfiles?.selectedId || profileItems()[0]?.id || "";
  target.replaceChildren();
  profileItems().forEach(profile => {
    const label = document.createElement("label");
    const input = document.createElement("input"); input.type = "radio"; input.name = "profile"; input.value = profile.id; input.checked = profile.id === joinDraft.profileId;
    input.addEventListener("change", () => { joinDraft.profileId = profile.id; });
    const text = document.createElement("span");
    const title = document.createElement("b"); title.textContent = profile.label || profile.displayName || "未命名设定";
    const description = document.createElement("small"); description.textContent = [profile.displayName, profile.basicInfo, profile.appearance].filter(Boolean).join(" · ").slice(0, 140) || "本机角色设定";
    text.append(title, description); label.append(input, text); target.append(label);
  });
}
function parseTagEntry(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) return { tag: String(item.tag ?? item.name ?? item.label ?? "").trim(), note: String(item.note ?? item.annotation ?? "").trim() };
  const raw = String(item || "").trim();
  const divider = raw.indexOf("｜");
  return { tag: (divider < 0 ? raw : raw.slice(0, divider)).trim(), note: divider < 0 ? "" : raw.slice(divider + 1).trim() };
}
function mapTags(value) {
  const result = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const parsed = parseTagEntry(item);
    if (parsed.tag) result.set(parsed.tag.slice(0, 40), parsed.note.slice(0, 160));
  }
  return result;
}
function tagPayload(tags) {
  return [...tags.entries()].map(([tag, note]) => ({ tag, note }));
}
function renderTagEditor(target, tags, referenceTarget = null) {
  target.replaceChildren();
  if (!tags.size) { target.textContent = "尚未添加标签"; target.classList.add("empty"); }
  else {
    target.classList.remove("empty");
    for (const [tag, note] of tags.entries()) {
      const row = document.createElement("div"); row.className = "selected-tag-row";
      const title = document.createElement("b"); title.textContent = tag;
      const input = document.createElement("input"); input.type = "text"; input.maxLength = 160; input.placeholder = "给这个标签添加注释（可选）"; input.value = note;
      input.addEventListener("input", () => tags.set(tag, input.value.trim().slice(0, 160)));
      const remove = makeButton("移除", () => { tags.delete(tag); renderTagEditor(target, tags, referenceTarget); if (referenceTarget) renderReferenceTags(referenceTarget, tags); });
      row.append(title, input, remove); target.append(row);
    }
  }
  if (referenceTarget) renderReferenceTags(referenceTarget, tags, `#${target.id}`);
}
function renderReferenceTags(options, selectedTags, targetSelector = "#selected-tags") {
  const search = options.id === "preference-tag-options" ? "" : document.querySelector("#tag-search").value.trim().toLowerCase();
  const category = options.id === "preference-tag-options" ? "" : document.querySelector("#tag-category").value;
  options.replaceChildren();
  tagCatalog.filter(item => (!category || item.category === category) && (!search || item.name.toLowerCase().includes(search))).forEach(item => {
    const button = makeButton(item.name, () => {
      if (selectedTags.has(item.name)) selectedTags.delete(item.name); else selectedTags.set(item.name, "");
      renderTagEditor(document.querySelector(targetSelector), selectedTags, options);
    });
    button.classList.toggle("selected", selectedTags.has(item.name));
    button.title = item.category;
    options.append(button);
  });
}
function renderTagOptions() {
  const options = document.querySelector("#tag-options");
  renderTagEditor(document.querySelector("#selected-tags"), joinDraft.tags, options);
  document.querySelector("#tag-count").textContent = `已添加 ${joinDraft.tags.size} 个`;
}
function renderPreferenceTags() {
  const target = document.querySelector("#preference-tags");
  renderTagEditor(target, preferenceDraft.tags, document.querySelector("#preference-tag-options"));
  document.querySelectorAll('input[name="preference-orientation"]').forEach(input => { input.checked = input.value === preferenceDraft.orientation; });
}
function openPreferences() {
  preferenceDraft.orientation = payload?.localPreferences?.orientation || "any";
  preferenceDraft.tags = mapTags(payload?.localPreferences?.characterTags);
  renderPreferenceTags();
  setPreferencesSaveStatus("");
  document.querySelector("#preferences-modal").classList.remove("hidden");
}
function renderJoinWizard() {
  const questions = [
    ["第一问 · 1 / 4", "选择角色设定作为游戏角色？", "绑定后无法修改。"],
    ["第二问 · 2 / 4", "选择性取向", "这会影响游戏内发现的将领性别。"],
    ["第三问 · 3 / 4", "添加标签", "请填写自己的性癖。标签大全仅供参考；每次发掘将领时会从你的标签中抽取 1～3 个方向。"],
    ["第四问 · 4 / 4", "开疆扩土前，你会想要遇到一名怎样的良将？", "此题脱离词条，只保留性取向，并直接生成你的初始将领。"],
    ["初始将领 · 确认", "查看你的初始将领", "可以再次抽取，也可以自由编辑这份初始设定；点击确定进入游戏后便永久锁定。"]
  ];
  document.querySelector("#join-progress").textContent = questions[joinStep][0];
  document.querySelector("#join-title").textContent = questions[joinStep][1];
  document.querySelector("#join-hint").textContent = questions[joinStep][2];
  document.querySelectorAll(".join-step").forEach((node, index) => node.classList.toggle("hidden", index !== joinStep));
  document.querySelector("#join-prev").classList.toggle("hidden", joinStep === 0 || joinSubmitting);
  const next = document.querySelector("#join-next");
  next.textContent = joinSubmitting
    ? (joinStep === 4 ? "正在确认…" : "正在生成初始将领…")
    : joinStep === 3 ? "生成初始将领" : joinStep === 4 ? "确定并进入游戏" : "下一问";
  next.disabled = joinSubmitting;
  if (joinStep === 0) renderProfileOptions();
  if (joinStep === 2) {
    if (!joinDraft.tags.size) joinDraft.tags = mapTags(payload?.localPreferences?.characterTags);
    renderTagOptions();
  }
  if (joinStep === 4) renderInitialGeneralPreview();
}

function renderInitialGeneralPreview() {
  const preview = joinDraft.preview;
  if (!preview?.general) return;
  const root = document.querySelector(".join-general-preview");
  if (root.dataset.previewId === preview.previewId) return;
  const general = preview.general;
  root.dataset.previewId = preview.previewId;
  document.querySelector("#join-general-name").value = general.name || "";
  document.querySelector("#join-general-gender").textContent = general.gender === "male" ? "男" : "女";
  document.querySelector("#join-general-experience").textContent = generalExperienceLabel(general);
  document.querySelector("#join-general-height").value = general.heightCm ?? "";
  document.querySelector("#join-general-weight").value = general.weightKg ?? "";
  document.querySelector("#join-general-chest").value = general.measurements?.chestCm ?? "";
  document.querySelector("#join-general-waist").value = general.measurements?.waistCm ?? "";
  document.querySelector("#join-general-hip").value = general.measurements?.hipCm ?? "";
  document.querySelector("#join-general-appearance").value = general.appearanceSetting || "";
  document.querySelector("#join-general-core").value = general.coreSetting || "";
}

function syncInitialGeneralEdits() {
  if (!joinDraft.preview?.general) return null;
  const general = joinDraft.preview.general;
  joinDraft.preview.general = {
    ...general,
    name: document.querySelector("#join-general-name").value.trim(),
    heightCm: document.querySelector("#join-general-height").value,
    weightKg: document.querySelector("#join-general-weight").value,
    measurements: {
      chestCm: document.querySelector("#join-general-chest").value,
      waistCm: document.querySelector("#join-general-waist").value,
      hipCm: document.querySelector("#join-general-hip").value
    },
    appearanceSetting: document.querySelector("#join-general-appearance").value.trim(),
    coreSetting: document.querySelector("#join-general-core").value.trim()
  };
  return joinDraft.preview.general;
}
function validateJoinStep() {
  if (joinStep === 0 && !joinDraft.profileId) return "请选择一份角色设定";
  if (joinStep === 1) {
    joinDraft.orientation = document.querySelector('input[name="orientation"]:checked')?.value || "";
    if (!joinDraft.orientation) return "请选择性取向";
  }
  if (joinStep === 2 && joinDraft.tags.size < 1) return "请至少添加一个性癖标签";
  if (joinStep === 3) {
    const wish = document.querySelector("#initial-general-wish").value.trim();
    if (wish !== joinDraft.wish) joinDraft.preview = null;
    joinDraft.wish = wish;
    if (!joinDraft.wish) return "请描述你想遇到的初始良将";
  }
  if (joinStep === 4 && !joinDraft.preview?.previewId) return "请先生成初始将领";
  return "";
}

function sendIntent(intent) {
  return host("intent", { intent: { ...intent, idempotencyKey: crypto.randomUUID() } }, { expectResult: true, key: `intent:${intent.type}` });
}
function retryLabel(intent = {}) {
  if (["talk-general", "send-letter", "edit-general-appearance", "generate-general-letter", "execute-captive"].includes(String(intent.type || ""))) return "将领互动内容";
  if (["confirm-general-discovery", "grant-general"].includes(String(intent.type || ""))) return "将领提拔信息";
  if (String(intent.type || "").includes("join")) return "初始将领信息";
  return "本次内容";
}
function askModelRetry(errorData, intent) {
  if (!errorData?.retryable || !errorData?.retryIntent) return;
  const code = String(errorData.errorCode || "MODEL_REQUEST_001");
  const confirmationId = host("confirm", {
    confirmation: {
      title: "内容生成失败",
      message: `${retryLabel(intent)}生成失败（错误码 ${code}）。是否重试？本次重试会消耗积分。`,
      acceptText: "重试（消耗积分）"
    }
  }, { expectResult: true, key: `retry-confirm:${code}` });
  if (confirmationId) retryConfirmations.set(confirmationId, { intent: { ...intent }, code });
}
function dispatchRetriedIntent(intent = {}) {
  const next = { ...intent };
  delete next.idempotencyKey;
  const requestId = sendIntent(next);
  if (!requestId) return;
  if (next.type === "talk-general") {
    for (const [id, item] of dialogueRequests) {
      if (item.generalId === next.generalId && item.topic === next.topic && item.status === "failed") dialogueRequests.delete(id);
    }
    dialogueRequests.set(requestId, {
      generalId: next.generalId, topic: next.topic, status: "sending", error: "",
      battleReportId: next.battleReportId || "", battleReportMarker: next.battleReportMarker || ""
    });
    battleDiscussionContext = null;
    const input = document.querySelector("#dialogue-input");
    if (dialogueGeneralId === next.generalId) { input.value = ""; renderDialogue(); }
  } else if (next.type === "prepare-join") {
    joinSubmitting = true;
    renderJoinWizard();
  } else if (["generate-general-letter", "edit-general-appearance", "execute-captive"].includes(String(next.type || ""))) {
    showToast("正在重新生成，请稍候…");
  }
}
document.querySelector("#join-next").addEventListener("click", () => {
  const error = validateJoinStep();
  if (error) { showToast(error); return; }
  if (joinStep < 3) { joinStep += 1; renderJoinWizard(); return; }
  joinSubmitting = true; renderJoinWizard();
  if (joinStep === 3) {
    sendIntent({
      type: "prepare-join",
      characterProfileId: joinDraft.profileId,
      orientation: joinDraft.orientation,
      characterTags: tagPayload(joinDraft.tags),
      initialGeneralWish: joinDraft.wish
    });
    return;
  }
  sendIntent({
    type: "join",
    previewId: joinDraft.preview.previewId,
    initialGeneral: syncInitialGeneralEdits()
  });
});
document.querySelector("#join-prev").addEventListener("click", () => {
  if (joinStep === 4) syncInitialGeneralEdits();
  if (joinStep > 0) { joinStep -= 1; renderJoinWizard(); }
});
document.querySelector("#join-reroll").addEventListener("click", () => {
  if (joinSubmitting) return;
  joinSubmitting = true;
  renderJoinWizard();
  sendIntent({
    type: "prepare-join",
    characterProfileId: joinDraft.profileId,
    orientation: joinDraft.orientation,
    characterTags: tagPayload(joinDraft.tags),
    initialGeneralWish: joinDraft.wish
  });
});
document.querySelector("#tag-search").addEventListener("input", renderTagOptions);
document.querySelector("#tag-category").addEventListener("change", renderTagOptions);
document.querySelector("#add-custom-tag").addEventListener("click", () => {
  const input = document.querySelector("#custom-tag-input");
  const tag = input.value.trim().slice(0, 40);
  if (!tag) return;
  joinDraft.tags.set(tag, joinDraft.tags.get(tag) || ""); input.value = ""; renderTagOptions();
});
document.querySelector("#edit-preferences").addEventListener("click", openPreferences);
document.querySelector("#close-preferences").addEventListener("click", () => document.querySelector("#preferences-modal").classList.add("hidden"));
document.querySelectorAll('input[name="preference-orientation"]').forEach(input => input.addEventListener("change", () => { preferenceDraft.orientation = input.value; }));
document.querySelector("#add-preference-tag").addEventListener("click", () => {
  const input = document.querySelector("#preference-tag-input");
  const tag = input.value.trim().slice(0, 40);
  if (!tag) return;
  preferenceDraft.tags.set(tag, preferenceDraft.tags.get(tag) || ""); input.value = ""; renderPreferenceTags();
});
const preferencesForm = document.querySelector("#preferences-form");
const savePreferencesButton = document.querySelector("#save-preferences");
function setPreferencesSaveStatus(message, kind = "") {
  const status = document.querySelector("#preferences-save-status");
  status.textContent = String(message || "");
  status.classList.toggle("success", kind === "success");
  status.classList.toggle("error", kind === "error");
}
function savePreferences(event) {
  event?.preventDefault();
  if (pendingHostKeys.has("preferences")) {
    setPreferencesSaveStatus("正在保存，请稍候");
    showToast("性癖偏好正在保存，请等待返回");
    return;
  }
  if (!preferenceDraft.tags.size) {
    setPreferencesSaveStatus("请至少添加一个性癖标签", "error");
    showToast("请至少添加一个性癖标签");
    return;
  }
  setPreferencesSaveStatus("正在保存…");
  try {
    const requestId = host("preferences", { preferences: { orientation: preferenceDraft.orientation, characterTags: tagPayload(preferenceDraft.tags) } }, {
      expectResult: true,
      key: "preferences",
      control: savePreferencesButton,
      timeoutMs: 10000,
      timeoutMessage: "保存偏好请求超时，请重试"
    });
    if (requestId) {
      savePreferencesButton.textContent = "保存中…";
      setTimeout(() => {
        const modalOpen = !document.querySelector("#preferences-modal").classList.contains("hidden");
        const stillWaiting = document.querySelector("#preferences-save-status").textContent === "正在保存…";
        if (modalOpen && stillWaiting && !pendingHostKeys.has("preferences")) setPreferencesSaveStatus("保存超时，请重试", "error");
      }, 10050);
    }
    else setPreferencesSaveStatus("保存请求未发出，请重试", "error");
  } catch {
    setPreferencesSaveStatus("保存请求未发出，请重试", "error");
    showToast("性癖偏好保存失败，请重试");
    playSound("error");
  }
}
savePreferencesButton.addEventListener("click", savePreferences);
preferencesForm.addEventListener("submit", savePreferences);
for (const category of [...new Set(tagCatalog.map(item => item.category))]) {
  const option = document.createElement("option"); option.value = category; option.textContent = category;
  document.querySelector("#tag-category").append(option);
}
document.querySelector("#join-form").addEventListener("submit", event => event.preventDefault());

canvas.addEventListener("click", event => {
  if (suppressMapClick) { suppressMapClick = false; return; }
  const point = mapCanvasPoint(event.clientX, event.clientY);
  if (!point) return;
  selected = { x: Math.floor(point.x), y: Math.floor(point.y) };
  renderCell(); refreshMarchQuote(); draw();
});
canvas.addEventListener("pointermove", event => {
  if (panState || event.buttons) { hideMapTaskTooltip(); return; }
  mapPointer = { x: event.clientX, y: event.clientY };
  renderMapTaskTooltip();
});
canvas.addEventListener("pointerleave", hideMapTaskTooltip);
viewport.addEventListener("scroll", hideMapTaskTooltip, { passive: true });
window.addEventListener("blur", hideMapTaskTooltip);
viewport.addEventListener("contextmenu", event => event.preventDefault());
viewport.addEventListener("pointerdown", event => {
  if (event.button !== 2) return;
  hideMapTaskTooltip();
  panState = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
  suppressMapClick = false; viewport.classList.add("panning"); viewport.setPointerCapture(event.pointerId); event.preventDefault();
});
viewport.addEventListener("pointermove", event => {
  if (!panState) return;
  const dx = event.clientX - panState.x, dy = event.clientY - panState.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) suppressMapClick = true;
  viewport.scrollLeft = panState.left - dx; viewport.scrollTop = panState.top - dy;
});
function finishPan(event) { if (!panState) return; panState = null; viewport.classList.remove("panning"); try { viewport.releasePointerCapture(event.pointerId); } catch {} }
viewport.addEventListener("pointerup", finishPan);
viewport.addEventListener("pointercancel", finishPan);
viewport.addEventListener("wheel", event => { event.preventDefault(); stepZoom(event.deltaY < 0 ? 1 : -1); }, { passive: false });
window.addEventListener("resize", () => { updateMapScale(true); updateCompanionListMetrics(); });

document.querySelector("#return-library").addEventListener("click", () => host("library"));
document.querySelector("#toggle-social").addEventListener("click", event => setSocialOpen(event.currentTarget.getAttribute("aria-expanded") !== "true"));
document.querySelector("#map-region-actions-toggle").addEventListener("click", () => setMapCornerCollapsed("region", !regionActionsCollapsed));
document.querySelector("#map-army-transfer-toggle").addEventListener("click", () => setMapCornerCollapsed("army", !armyTransferCollapsed));
document.querySelector("#toggle-selected-area").addEventListener("click", event => {
  const toggle = event.currentTarget;
  resizeGamePanels(() => {
    const collapsed = document.querySelector(".map-workspace").classList.toggle("area-collapsed");
    document.querySelector("#area-content").inert = collapsed;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? "展开选中的区域" : "收起选中的区域");
    toggle.title = collapsed ? "展开选中的区域" : "收起选中的区域";
  });
});
const companionSection = document.querySelector(".area-companions");
const companionList = document.querySelector("#carried-generals");
companionSection.addEventListener("mouseenter", () => {
  clearTimeout(companionHoverTimer);
  companionHoverTimer = setTimeout(() => setCompanionsExpanded(true), 750);
});
companionSection.addEventListener("mouseleave", () => {
  clearTimeout(companionHoverTimer);
  if (!draggedGeneralId) setCompanionsExpanded(false);
});
companionSection.addEventListener("click", () => setCompanionsExpanded(true));
companionList.addEventListener("dragover", event => {
  if (!draggedGeneralId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const dragging = companionList.querySelector(`.general-card[data-general-id="${CSS.escape(draggedGeneralId)}"]`);
  const target = event.target.closest(".general-card");
  if (!dragging || !target || dragging === target || !companionList.contains(target)) return;
  const rect = target.getBoundingClientRect();
  companionList.insertBefore(dragging, event.clientY >= rect.top + rect.height / 2 ? target.nextSibling : target);
  updateCompanionActiveSlots();
});
companionList.addEventListener("drop", event => { event.preventDefault(); finishCompanionDrag(true); });
document.addEventListener("pointerdown", event => {
  if (!companionSection.contains(event.target)) setCompanionsExpanded(false);
});
document.querySelectorAll("[data-social-tab]").forEach(button => button.addEventListener("click", () => switchSocialTab(button.dataset.socialTab)));
function submitWorldChat(event) {
  event?.preventDefault();
  const input = document.querySelector("#world-chat-input");
  const text = input.value.trim();
  if (!text) return;
  if (!ownPlayer()) { showToast("请先加入在线游戏"); return; }
  const id = sendIntent({ type: "world-chat", text });
  if (id) { worldChatDrafts.set(id, text); input.value = ""; renderWorldChat(); }
}
document.querySelector("#world-chat-form").addEventListener("submit", submitWorldChat);
document.querySelector("#world-chat-send").addEventListener("click", event => {
  event.preventDefault();
  submitWorldChat();
});
document.querySelector("#world-chat-input").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); document.querySelector("#world-chat-form").requestSubmit(); }
});
document.querySelector("#deploy-cancel").addEventListener("click", () => document.querySelector("#deploy-confirmation").classList.add("hidden"));
document.querySelector("#deploy-confirm").addEventListener("click", () => {
  if (!deployGeneralId || deployingGeneralId) return;
  const generalId = deployGeneralId;
  const requestId = sendIntent({ type: "deploy-general", generalId });
  if (!requestId) return;
  deployingGeneralId = generalId;
  deployingGeneralName = String(allGenerals()[generalId]?.name || "将领");
  const confirm = document.querySelector("#deploy-confirm");
  const cancel = document.querySelector("#deploy-cancel");
  confirm.disabled = true; confirm.textContent = "正在部署";
  cancel.disabled = true;
  document.querySelector("#deploy-confirmation").setAttribute("aria-busy", "true");
  renderGenerals();
});
document.querySelector("#general-discovery-decline").addEventListener("click", () => {
  if (!generalDiscoveryId || generalDiscoverySubmitting) return;
  generalDiscoverySubmitting = true;
  renderGeneralDiscoveryPrompt();
  if (!sendIntent({ type: "decline-general-discovery", discoveryId: generalDiscoveryId })) {
    generalDiscoverySubmitting = false;
    renderGeneralDiscoveryPrompt();
  }
});
document.querySelector("#general-discovery-confirm").addEventListener("click", () => {
  if (!generalDiscoveryId || generalDiscoverySubmitting) return;
  generalDiscoverySubmitting = true;
  renderGeneralDiscoveryPrompt();
  if (!sendIntent({ type: "confirm-general-discovery", discoveryId: generalDiscoveryId })) {
    generalDiscoverySubmitting = false;
    renderGeneralDiscoveryPrompt();
  }
});
document.querySelector("#owner-command-toggle").addEventListener("click", () => document.querySelector("#owner-command-modal").classList.remove("hidden"));
document.querySelector("#close-owner-command").addEventListener("click", () => document.querySelector("#owner-command-modal").classList.add("hidden"));
document.querySelector("#owner-ban-player").addEventListener("change", renderOwnerCommands);
document.querySelector("#owner-simulate-player").addEventListener("change", renderOwnerCommands);
document.querySelector("#owner-open-server").addEventListener("click", () => host("admin", { command: { type: "open-server" } }, { expectResult: true, key: "admin:open-server" }));
document.querySelector("#owner-scatter-treasures").addEventListener("click", () => host("admin", { command: {
  type: "scatter-treasures",
  count: Number(document.querySelector("#treasure-count").value),
  redAscend: Number(document.querySelector("#treasure-red-ascend").value),
  redReroll: Number(document.querySelector("#treasure-red-reroll").value)
} }, { expectResult: true, key: "admin:scatter-treasures" }));
document.querySelector("#owner-migrate-server").addEventListener("click", () => host("admin", { command: { type: "migrate-server" } }, { expectResult: true, key: "admin:migrate-server" }));
document.querySelector("#owner-reset-player-button").addEventListener("click", () => host("admin", { command: { type: "player-reset", targetAccountId: document.querySelector("#owner-reset-player").value } }, { expectResult: true, key: "admin:player-reset" }));
document.querySelector("#owner-simulate-recall").addEventListener("click", () => host("admin", { command: {
  type: "simulate-player-intent",
  targetAccountId: document.querySelector("#owner-simulate-player").value,
  intent: { type: "recall-general", generalId: document.querySelector("#owner-simulate-general").value }
} }, { expectResult: true, key: "admin:simulate-player-intent" }));
document.querySelector("#owner-ban-player-button").addEventListener("click", () => {
  const select = document.querySelector("#owner-ban-player");
  const option = select.selectedOptions[0];
  const type = option?.dataset.banned === "true" ? "player-unban" : "player-ban";
  host("admin", { command: { type, targetAccountId: select.value } }, { expectResult: true, key: `admin:${type}` });
});
document.querySelector("#banned-return-library").addEventListener("click", () => host("library"));
document.querySelector("#march-attack").addEventListener("change", () => {
  marchQuoteCache = null;
  renderMarchConfirmation();
  refreshMarchQuote();
});
document.querySelector("#army-transfer-amount").addEventListener("input", event => setArmyTransferDraft(event.currentTarget.value, { clamp: false, write: false }));
document.querySelector("#army-transfer-amount").addEventListener("change", event => setArmyTransferDraft(event.currentTarget.value));
document.querySelector("#army-transfer-amount").addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  document.querySelector("#army-transfer-confirm").click();
});
document.querySelectorAll("[data-army-delta]").forEach(button => button.addEventListener("click", () => {
  setArmyTransferDraft(armyTransferDraft + Number(button.dataset.armyDelta || 0));
}));
document.querySelector("#army-transfer-deploy-max").addEventListener("click", () => {
  setArmyTransferDraft(Number(document.querySelector("#army-transfer-amount").min || 0));
});
document.querySelector("#army-transfer-gather-all").addEventListener("click", () => {
  setArmyTransferDraft(Number(document.querySelector("#army-transfer-amount").max || 0));
});
document.querySelector("#army-transfer-confirm").addEventListener("click", () => {
  const confirmButton = document.querySelector("#army-transfer-confirm");
  setArmyTransferDraft(document.querySelector("#army-transfer-amount").value);
  if (confirmButton.disabled) return;
  const amount = Math.abs(armyTransferDraft);
  if (!amount) return;
  const type = armyTransferDraft > 0 ? "gather-march" : "deploy-soldiers";
  if (sendIntent({ type, amount })) {
    setArmyTransferDraft(0);
    renderCell();
    if (marchConfirmationTarget) renderMarchConfirmation();
  }
});
document.querySelector("#training-target").addEventListener("change", renderPowerTraining);
document.querySelector("#cultivation-gold").addEventListener("input", renderPowerTraining);
document.querySelector("#cultivation-gold").addEventListener("change", renderPowerTraining);
document.querySelector("#cultivation-material").addEventListener("change", renderPowerTraining);
document.querySelector("#start-power-training").addEventListener("click", () => {
  renderPowerTraining();
  if (document.querySelector("#start-power-training").disabled) return;
  const [targetType, targetId] = document.querySelector("#training-target").value.split(":");
  if (targetType === "general") sendIntent({ type: "cultivate-general", generalId: targetId, goldInvestment: Number(document.querySelector("#cultivation-gold").value), materialId: document.querySelector("#cultivation-material").value });
  else sendIntent({ type: "cultivate-player", goldInvestment: Number(document.querySelector("#cultivation-gold").value) });
});
document.querySelector("#connection-retry").addEventListener("click", () => {
  if (pendingHostKeys.has("sync")) return;
  host("sync", {}, { expectResult: true, key: "sync", control: document.querySelector("#connection-retry"), timeoutMs: 120000 });
  renderConnectionNotice();
});
document.querySelector("#start-mining").addEventListener("click", () => { if (selected) sendIntent({ type: "start-mining", x: selected.x, y: selected.y, auto: false }); });
document.querySelector("#train-amount").addEventListener("input", event => {
  document.querySelector("#train-amount-value").value = event.currentTarget.value;
  renderTrainingCost(event.currentTarget.value);
  const cell = selected ? dynamicCell(selected.x, selected.y) : null;
  const remaining = selected ? Math.max(0, garrisonCapAt(selected.x, selected.y, cell) - Number(cell?.soldiers || 0)) : 0;
  document.querySelector("#train").disabled = event.currentTarget.disabled || Number(event.currentTarget.value) < 1
    || trainingGoldCost(event.currentTarget.value, cell, remaining) > Number(ownPlayer()?.gold || 0);
});
document.querySelector("#train").addEventListener("click", () => {
  if (!selected) return;
  const cell = dynamicCell(selected.x, selected.y);
  const remaining = Math.max(0, garrisonCapAt(selected.x, selected.y, cell) - Number(cell?.soldiers || 0));
  const value = Number(document.querySelector("#train-amount").value);
  sendIntent({ type: "train", x: selected.x, y: selected.y, amount: value, ...(value >= remaining ? { mode: "max" } : {}) });
});
document.querySelector("#march").addEventListener("click", () => {
  openMarchConfirmation();
});
document.querySelector("#march-confirmation-close").addEventListener("click", closeMarchConfirmation);
document.querySelector("#march-confirmation-cancel").addEventListener("click", closeMarchConfirmation);
document.querySelector("#march-quote-retry").addEventListener("click", () => {
  marchQuoteFailureKey = "";
  renderMarchConfirmation();
  refreshMarchQuote();
});
document.querySelector("#march-confirmation-submit").addEventListener("click", () => {
  requestMarchSubmission();
});
document.querySelector("#zero-army-march-cancel").addEventListener("click", () => document.querySelector("#zero-army-march-confirmation").classList.add("hidden"));
document.querySelector("#zero-army-march-confirm").addEventListener("click", dispatchMarch);
document.querySelector("#center-player").addEventListener("click", () => {
  const player = ownPlayer();
  if (player?.position) centerMap(player.position);
});
document.querySelector("#battle-report-button").addEventListener("click", openBattleReport);
document.querySelector("#battle-report-dismiss").addEventListener("click", dismissBattleReport);
document.querySelector("#battle-report-later").addEventListener("click", closeBattleReport);
document.querySelector("#battle-report-prev").addEventListener("click", () => {
  const reports = battleReports();
  const index = reports.findIndex(item => String(item.id) === String(activeBattleReportId));
  if (index > 0) selectBattleReport(reports[index - 1].id);
});
document.querySelector("#battle-report-next").addEventListener("click", () => {
  const reports = battleReports();
  const index = reports.findIndex(item => String(item.id) === String(activeBattleReportId));
  if (index >= 0 && index < reports.length - 1) selectBattleReport(reports[index + 1].id);
});
document.querySelector("#battle-report-discuss").addEventListener("click", () => {
  if (!battleReportById(activeBattleReportId)) return;
  battleReportGeneralPickerOpen = !battleReportGeneralPickerOpen;
  renderBattleReports();
});
document.querySelector("#close-general").addEventListener("click", () => document.querySelector("#general-modal").classList.add("hidden"));
document.querySelector("#market-open").addEventListener("click", openMarket);
document.querySelector("#market-close").addEventListener("click", () => { closeMarketSheets(); document.querySelector("#market-modal").classList.add("hidden"); });
document.querySelector("#market-sell-open").addEventListener("click", openMarketSell);
document.querySelector("#market-sell-close").addEventListener("click", closeMarketSell);
document.querySelector("#market-sell-cancel").addEventListener("click", closeMarketSell);
document.querySelector("#market-sell-form").addEventListener("submit", submitMarketSell);
document.querySelector("#market-sell-submit").addEventListener("click", submitMarketSell);
document.querySelector("#market-manage-close").addEventListener("click", closeMarketManage);
document.querySelector("#market-manage-cancel").addEventListener("click", closeMarketManage);
document.querySelector("#market-manage-confirm").addEventListener("click", confirmMarketDelist);
document.querySelector("#letter-detail-close").addEventListener("click", closeLetterDetail);
document.querySelector("#general-interact").addEventListener("click", () => openDialogue(generalDetailId));
document.querySelector("#close-general-action").addEventListener("click", closeGeneralAction);
document.querySelector("#general-action-reject").addEventListener("click", () => resolveGeneralAction(false));
document.querySelector("#general-action-confirm").addEventListener("click", () => resolveGeneralAction(true));
document.querySelector("#close-dialogue").addEventListener("click", () => { document.querySelector("#dialogue-modal").classList.add("hidden"); renderConversations(); });
document.querySelector("#dialogue-form").addEventListener("submit", event => { event.preventDefault(); sendDialogue(); });
function sendDialogue() {
  const input = document.querySelector("#dialogue-input");
  const rawText = input.value.trim();
  if (!rawText || !dialogueGeneralId) return;
  if (!canInteract(allGenerals()[dialogueGeneralId])) { showToast("抵达将领所在区域后才能发送消息"); return; }
  if (typeof clearInvalidBattleDiscussion === "function") clearInvalidBattleDiscussion();
  const discussion = typeof battleDiscussionContext !== "undefined" && battleDiscussionContext
    && String(battleDiscussionContext.generalId) === String(dialogueGeneralId)
    && typeof battleReportById === "function" && battleReportById(battleDiscussionContext.reportId) ? battleDiscussionContext : null;
  const topic = discussion ? withoutBattleReportMarker(rawText, discussion.marker) : rawText;
  if (!topic) { showToast("请在战报标记下补充想讨论的内容"); return; }
  const intent = { type: "talk-general", generalId: dialogueGeneralId, topic };
  if (discussion) intent.battleReportId = discussion.reportId;
  const requestId = sendIntent(intent);
  if (!requestId) return;
  for (const [id, item] of dialogueRequests) {
    if (item.generalId === dialogueGeneralId && item.status === "failed" && item.topic === topic) dialogueRequests.delete(id);
  }
  dialogueRequests.set(requestId, {
    generalId: dialogueGeneralId, topic, status: "sending", error: "",
    battleReportId: discussion?.reportId || "", battleReportMarker: discussion?.marker || ""
  });
  if (typeof battleDiscussionContext !== "undefined") battleDiscussionContext = null;
  input.value = "";
  renderDialogue();
}
document.querySelector("#dialogue-send").addEventListener("click", sendDialogue);
document.querySelector("#dialogue-input").addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendDialogue();
});
document.querySelectorAll(".overlay").forEach(overlay => overlay.addEventListener("click", event => {
  if (event.target !== overlay || overlay.id === "join-wizard" || overlay.id === "general-discovery-confirmation") return;
  if (overlay.id === "deploy-confirmation" && deployingGeneralId) return;
  if (overlay.id === "march-confirmation") { closeMarchConfirmation(); return; }
  if (overlay.id === "market-modal") closeMarketSheets();
  if (overlay.id === "letter-detail-modal") closeLetterDetail();
  if (overlay.id === "battle-report-modal") { closeBattleReport(); return; }
  overlay.classList.add("hidden");
}));

function resultSound(result) {
  const effects = Array.isArray(result?.effects) ? result.effects : [];
  if (result?.joinPreview) return "general";
  if (result?.pendingSync) return "notice";
  if (result?.deferredEffects?.length) return "notice";
  if (effects.some(effect => effect.type === "battle-lost")) return "defeat";
  if (effects.some(effect => effect.type === "battle-won")) return "victory";
  if (effects.some(effect => effect.type === "general-generation-request")) return "general";
  if (result?.dialogue?.reply) return "dialogue";
  if (result?.direct) return "letter";
  if (result?.duplicate || result?.cancelled) return "notice";
  return "success";
}

window.addEventListener("message", event => {
  if (event.source !== parent || event.data?.source !== "fengyue-host" || event.data?.protocol !== HOST_PROTOCOL) return;
  if (event.data.type === "sound") {
    const revision = Number(event.data.revision || 0);
    if (!Number.isSafeInteger(revision) || revision !== pendingSoundRevision) return;
    clearTimeout(soundAckTimer);
    pendingSoundRevision = 0;
    const volume = Number(event.data.volume);
    if (Number.isFinite(volume) && !soundKnobDrag) setSoundVolume(volume * 100, { persist: false });
    return;
  }
  const requestState = ["result", "error"].includes(event.data.type) ? finishHostRequest(event.data.requestId) : null;
  if (requestState === false) return;
  if (event.data.type === "state") {
    applyHostedState(event.data.state, true);
    if (ownPlayer()) joinSubmitting = false;
    renderAll();
  } else if (event.data.type === "error") {
    if (requestState?.key === "sync") renderConnectionNotice();
    if (requestState?.key?.startsWith("intent:quote-march:")) {
      const failedKey = requestState.key.slice("intent:quote-march:".length);
      if (failedKey === marchQuoteKey()) {
        marchQuoteFailureKey = failedKey;
        if (marchConfirmationTarget) renderMarchConfirmation();
      }
      return;
    }
    if (requestState?.silent) return;
    if (requestState?.key === "intent:march") {
      marchSubmitting = false;
      if (event.data.errorCode === "FYOW_MARCH_QUOTE_CHANGED") {
        marchQuoteCache = null;
        marchQuoteFailureKey = "";
      }
      renderMarchConfirmation();
    }
    if (requestState?.key === "intent:deploy-general") {
      deployingGeneralId = null;
      deployingGeneralName = "";
      const confirm = document.querySelector("#deploy-confirm");
      const cancel = document.querySelector("#deploy-cancel");
      confirm.disabled = false; confirm.textContent = "确认部署";
      cancel.disabled = false;
      document.querySelector("#deploy-confirmation").removeAttribute("aria-busy");
      renderGenerals();
    }
    if (requestState?.key === "intent:confirm-general-discovery" || requestState?.key === "intent:decline-general-discovery") {
      generalDiscoverySubmitting = false;
      renderGeneralDiscoveryPrompt();
    }
    if (requestState?.key === "intent:gather-march" || requestState?.key === "intent:deploy-soldiers") {
      renderCell();
      if (marchConfirmationTarget) renderMarchConfirmation();
    }
    if (requestState?.key === "preferences") setPreferencesSaveStatus("保存失败，请重试", "error");
    joinSubmitting = false;
    playSound("error");
    if (requestState?.key === "intent:march" && /金币不足/.test(event.data.message || "")) showMapFeedback("金币不足");
    else if (event.data.retryable && event.data.errorCode) showToast(`${retryLabel(event.data.retryIntent)}生成失败（错误码 ${event.data.errorCode}）`);
    else showToast(event.data.message || "行动失败");
    if (worldChatDrafts.has(event.data.requestId)) {
      const input = document.querySelector("#world-chat-input");
      if (!input.value) input.value = worldChatDrafts.get(event.data.requestId);
      worldChatDrafts.delete(event.data.requestId);
      renderWorldChat();
    }
    askModelRetry(event.data, event.data.retryIntent);
    failDialogueRequest(event.data.requestId, event.data.retryable && event.data.errorCode
      ? `错误码 ${event.data.errorCode}` : event.data.message);
    if (!ownPlayer()) renderJoinWizard();
  } else if (event.data.type === "result") {
    const retry = retryConfirmations.get(event.data.requestId);
    if (retry) {
      retryConfirmations.delete(event.data.requestId);
      if (event.data.result?.confirmed) dispatchRetriedIntent(retry.intent);
      return;
    }
    if (event.data.result?.marchQuote) {
      if (event.data.result.marchQuote.requestKey === marchQuoteKey()) {
        marchQuoteFailureKey = "";
        marchQuoteCache = event.data.result.marchQuote;
        if (marchConfirmationTarget) renderMarchConfirmation();
        draw();
      }
      return;
    }
    if (requestState?.silent) return;
    if (requestState?.key === "intent:confirm-general-discovery" || requestState?.key === "intent:decline-general-discovery") generalDiscoverySubmitting = false;
    worldChatDrafts.delete(event.data.requestId);
    finishDialogueResult(event.data.requestId, event.data.result);
    if (event.data.result?.cancelled && !event.data.result?.listingId) {
      joinSubmitting = false;
      playSound("notice");
      showToast("已取消操作");
      if (!ownPlayer()) renderJoinWizard();
      return;
    }
    if (event.data.result?.joinPreview) {
      joinDraft.preview = event.data.result.joinPreview;
      joinStep = 4;
      joinSubmitting = false;
      renderJoinWizard();
      playSound("general");
      showToast("初始将领已经生成，请查看、重抽或编辑后确认");
      return;
    }
    if (event.data.result?.state) {
      applyHostedState(event.data.result.state, false);
      joinSubmitting = false;
      if (requestState?.key === "intent:march") closeMarchConfirmation({ force: true });
      if (requestState?.key === "intent:deploy-general") {
        const deployedName = deployingGeneralName || allGenerals()[deployingGeneralId]?.name || "将领";
        deployingGeneralId = null;
        deployingGeneralName = "";
        deployGeneralId = null;
        const confirm = document.querySelector("#deploy-confirm");
        const cancel = document.querySelector("#deploy-cancel");
        confirm.disabled = false; confirm.textContent = "确认部署";
        cancel.disabled = false;
        document.querySelector("#deploy-confirmation").removeAttribute("aria-busy");
        document.querySelector("#deploy-confirmation").classList.add("hidden");
        showToast(event.data.result.pendingSync
          ? `${deployedName}的部署已保存在本机，正在同步`
          : `${deployedName}部署成功`);
      }
      renderAll();
    }
    if (event.data.result?.listed) {
      closeMarketSheets();
      playSound("success");
      showToast("将领已上架名将市场");
      return;
    }
    if (event.data.result?.cancelled && event.data.result?.listingId) {
      closeMarketSheets();
      playSound("notice");
      showToast("将领已下架，6 小时后可再次售卖");
      return;
    }
    if (event.data.result?.preferences) {
      setPreferencesSaveStatus("偏好已保存", "success");
      document.querySelector("#preferences-modal").classList.add("hidden");
      playSound("success");
      showToast("性癖偏好已保存");
      return;
    }
    const dialogue = event.data.result?.dialogue;
    if (dialogue?.reply) {
      if (dialogue.pendingAction) {
        const action = { ...dialogue.pendingAction, generalName: allGenerals()[dialogueGeneralId]?.name || "将领" };
        openGeneralAction(action);
      }
      if (dialogue.command?.type === "surrender") showToast(`${allGenerals()[dialogueGeneralId]?.name || "将领"}已经决定降服`);
      renderDialogue();
    }
    if (event.data.result?.letter?.text) showToast("书信已生成并发送");
    if (event.data.result?.farewell?.text) showToast("诀别信已发送，处置已完成");
    if (event.data.result?.appearanceSetting) showToast("外观设定已更新");
    if (event.data.result?.pendingSync && requestState?.key !== "intent:deploy-general") {
      showToast(event.data.result.pendingSyncMessage || "行动已保存在本机，正在同步");
    }
    playSound(resultSound(event.data.result));
    if (event.data.result?.deferredEffects?.length) showToast("领地已占领，新将领稍后到来");
  }
});

setInterval(() => {
  renderClock();
  const now = hostTime();
  document.querySelectorAll("[data-finish]").forEach(node => { node.textContent = formatDuration(Number(node.dataset.finish) - now); });
  const miningCooldown = document.querySelector("#mining-cooldown");
  const cooldownUntil = Number(miningCooldown?.dataset.cooldownUntil || 0);
  if (cooldownUntil > now) miningCooldown.textContent = `冷却 ${formatDuration(cooldownUntil - now)}`;
  else if (cooldownUntil) renderCell();
  renderMapTaskTooltip();
}, 1000);
host("ready");
