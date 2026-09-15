"use strict";

const canvas = document.querySelector("#map");
const context = canvas.getContext("2d");
const viewport = document.querySelector("#map-viewport");
const tagCatalog = typeof ACG_CHARACTER_TAGS === "undefined" ? [] : ACG_CHARACTER_TAGS;
const ZOOM_LEVELS = [.25, .375, .5, .75, 1, 1.25, 1.5, 2, 3];
const DEFAULT_VISIBLE_CELLS = 12;
const TRAINING_COST_GROWTH = 1.15;
const MAX_TRAINING_LEVEL = 100;
const HOST_PROTOCOL = "fyow-host/1";
let payload = null;
let selected = null;
let zoom = 1;
let mapCssSize = 2048;
let mapCentered = false;
let panState = null;
let suppressMapClick = false;
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
const seenModelUsageIds = new Set();
let modelUsageInitialized = false;

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
    const control = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    if (control && !control.disabled) {
      control.disabled = true;
      control.classList.add("host-pending");
    }
    pendingHostRequests.set(requestId, { key, control });
    if (key) pendingHostKeys.set(key, requestId);
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
  if (pending.key && pendingHostKeys.get(pending.key) === id) pendingHostKeys.delete(pending.key);
  if (pending.control) {
    pending.control.disabled = false;
    pending.control.classList.remove("host-pending");
  }
  return pending;
}
function ownAccountId() { return String(payload?.account?.accountId || ""); }
function ownPlayer() { return payload?.world?.players?.[ownAccountId()] || null; }
function allGenerals() { return payload?.world?.generals || {}; }
function cellKey(x, y) { return `${x},${y}`; }
function dynamicCell(x, y) { return payload?.world?.cells?.[cellKey(x, y)] || { ownerAccountId: null, soldiers: 0, generalIds: [] }; }
function fact(x, y) { return payload?.mapFacts?.[y * 64 + x] || { x, y, population: 0, resourceGrade: "—", resourceRank: 0, garrisonCap: 0, neutralPower: 0 }; }
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
function trainingQuote(entity, levelsValue) {
  const base = Math.max(1, Number(entity?.basePower || entity?.power || 300));
  const current = Math.max(0, Math.min(MAX_TRAINING_LEVEL, Number(entity?.trainingLevel || 0)));
  const levels = Math.max(1, Math.min(10, MAX_TRAINING_LEVEL - current, Math.trunc(Number(levelsValue) || 1)));
  const baseCost = Math.max(50, Math.ceil(base * .2));
  let cost = 0;
  let durationMs = 0;
  for (let offset = 0; offset < levels; offset += 1) {
    cost += Math.ceil(baseCost * Math.pow(TRAINING_COST_GROWTH, current + offset));
    durationMs += 60000 * (1 + Math.floor((current + offset) / 10));
  }
  const nextPower = Math.floor(base * (1 + (current + levels) * .06) * Math.pow(1.25, Math.floor((current + levels) / 10)));
  return { current, levels, cost, durationMs: Math.min(3600000, durationMs), currentPower: trainingPower(entity), nextPower };
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

let audioContext = null;
const SOUND_LEVELS = [.6, .3, 0];
let soundLevelIndex = 0;
try { soundLevelIndex = Math.max(0, Math.min(SOUND_LEVELS.length - 1, Number(localStorage.getItem("fyow:sound-level") || 0))); } catch {}
function soundVolume() { return SOUND_LEVELS[soundLevelIndex]; }
function updateSoundToggle() {
  const button = document.querySelector("#sound-toggle");
  if (!button) return;
  const percent = Math.round(soundVolume() * 100);
  button.textContent = percent ? `音效 ${percent}%` : "音效 关";
  button.classList.toggle("muted", !percent);
}
function audioTone(frequency, duration, { delay = 0, endFrequency = frequency, gain = .04, type = "sine" } = {}) {
  const volume = soundVolume();
  if (!volume) return;
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  void audioContext.resume?.();
  const start = audioContext.currentTime + delay;
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(Math.max(40, frequency), start);
  if (endFrequency !== frequency) oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, endFrequency), start + duration);
  envelope.gain.setValueAtTime(.0001, start);
  envelope.gain.exponentialRampToValueAtTime(Math.max(.0002, gain * volume), start + Math.min(.018, duration / 3));
  envelope.gain.exponentialRampToValueAtTime(.0001, start + duration);
  oscillator.connect(envelope).connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + .02);
}
function playSound(kind = "click") {
  try {
    if (kind === "click") audioTone(390, .055, { endFrequency: 240, gain: .026, type: "triangle" });
    else if (kind === "notice") audioTone(520, .08, { endFrequency: 430, gain: .028, type: "triangle" });
    else if (kind === "success") { audioTone(520, .12, { gain: .032, type: "triangle" }); audioTone(720, .16, { delay: .08, gain: .038, type: "triangle" }); }
    else if (kind === "error") { audioTone(220, .15, { endFrequency: 145, gain: .045, type: "sawtooth" }); audioTone(165, .18, { delay: .07, endFrequency: 120, gain: .028, type: "square" }); }
    else if (kind === "complete") { audioTone(660, .18, { gain: .035, type: "sine" }); audioTone(990, .24, { delay: .1, gain: .035, type: "sine" }); }
    else if (kind === "victory") { audioTone(392, .13, { gain: .036, type: "triangle" }); audioTone(523, .15, { delay: .09, gain: .04, type: "triangle" }); audioTone(784, .28, { delay: .19, gain: .044, type: "triangle" }); }
    else if (kind === "defeat") { audioTone(330, .16, { endFrequency: 260, gain: .035, type: "triangle" }); audioTone(196, .3, { delay: .1, endFrequency: 130, gain: .04, type: "sawtooth" }); }
    else if (kind === "general") { audioTone(587, .16, { gain: .033, type: "sine" }); audioTone(740, .18, { delay: .1, gain: .038, type: "sine" }); audioTone(988, .34, { delay: .2, gain: .04, type: "sine" }); }
    else if (kind === "letter") { audioTone(880, .11, { gain: .03, type: "sine" }); audioTone(1175, .22, { delay: .09, gain: .034, type: "sine" }); }
    else if (kind === "dialogue") { audioTone(440, .09, { gain: .025, type: "triangle" }); audioTone(554, .14, { delay: .07, gain: .03, type: "triangle" }); }
  } catch {}
}
document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (button && !button.disabled && button.id !== "sound-toggle") playSound("click");
}, true);
document.querySelector("#sound-toggle").addEventListener("click", () => {
  soundLevelIndex = (soundLevelIndex + 1) % SOUND_LEVELS.length;
  try { localStorage.setItem("fyow:sound-level", String(soundLevelIndex)); } catch {}
  updateSoundToggle();
  if (soundVolume()) playSound("success");
});
updateSoundToggle();

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
function applyHostedState(next, background = false) {
  const previous = stateSoundSnapshot;
  const current = captureSoundState(next);
  payload = next;
  serverNow = Number(payload?.serverNow || Date.now());
  receivedAt = Date.now();
  stateSoundSnapshot = current;
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
    if ([...current.inbox].some(id => id && !previous.inbox.has(id))) playSound("letter");
    else if ([...current.generals].some(id => id && !previous.generals.has(id))) playSound("general");
    else if (current.territories > previous.territories) playSound("victory");
    else if (current.territories < previous.territories) playSound("defeat");
    else if ([...previous.jobs].some(id => id && !current.jobs.has(id))) playSound("complete");
  }
}

function ownerColor(owner, rank) {
  const neutral = ["#bacb91", "#aec486", "#a3bc7d", "#98b273", "#8da769"];
  const mine = ["#f4d27c", "#edc164", "#e7b253", "#dda148", "#d28e3d"];
  const rivals = ["#d9866b", "#cd705e", "#bf6054", "#af524b", "#9c4644"];
  const palette = !owner ? neutral : owner === ownAccountId() ? mine : rivals;
  if (!owner || owner === ownAccountId()) return palette[Math.min(4, Math.floor(Number(rank || 0) / 3))];
  let hash = 0;
  for (const char of owner) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[(Math.abs(hash) + Math.min(4, Math.floor(Number(rank || 0) / 3))) % palette.length];
}

function draw() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  const size = canvas.width / 64;
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) {
    const info = fact(x, y);
    const cell = dynamicCell(x, y);
    context.fillStyle = ownerColor(cell.ownerAccountId, info.resourceRank);
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
  const player = ownPlayer();
  if (player?.position) {
    const px = (player.position.x + .5) * size;
    const py = (player.position.y + .5) * size;
    context.fillStyle = "#fff8e5"; context.strokeStyle = "#993d33"; context.lineWidth = 4;
    context.beginPath(); context.moveTo(px, py - size * .34); context.lineTo(px + size * .28, py);
    context.lineTo(px, py + size * .34); context.lineTo(px - size * .28, py); context.closePath();
    context.fill(); context.stroke();
  }
}

function updateMapScale(preserveCenter = true) {
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
  const tile = mapCssSize / 64;
  viewport.scrollTo({
    left: canvas.offsetLeft + (position.x + .5) * tile - viewport.clientWidth / 2,
    top: canvas.offsetTop + (position.y + .5) * tile - viewport.clientHeight / 2,
    behavior
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
  document.querySelector("#player-name").textContent = player?.displayName || "尚未加入";
  document.querySelector("#gold").textContent = `${formatNumber(player?.gold)} 金币`;
  document.querySelector("#player-power").textContent = player ? formatNumber(trainingPower(player)) : "0";
  const cells = Object.values(payload?.world?.cells || {}).filter(cell => cell.ownerAccountId === ownAccountId());
  document.querySelector("#territories").textContent = formatNumber(cells.length);
  document.querySelector("#soldiers").textContent = formatNumber(cells.reduce((sum, cell) => sum + Number(cell.soldiers || 0), Number(player?.fieldArmySoldiers || 0)));
  document.querySelector("#position").textContent = player?.position ? `${player.position.x}, ${player.position.y}` : "—";
  renderMarchParty();
}

function powerTrainingTargets() {
  const player = ownPlayer();
  if (!player) return [];
  return [
    { value: `player:${ownAccountId()}`, type: "player", id: ownAccountId(), name: `${player.displayName}（自己）`, entity: player },
    ...Object.values(allGenerals())
      .filter(general => general.holderAccountId === ownAccountId() && general.status !== "deployed")
      .map(general => ({ value: `general:${general.id}`, type: "general", id: general.id, name: `${general.name}（将领）`, entity: general }))
  ];
}
function renderPowerTraining() {
  const select = document.querySelector("#training-target");
  const input = document.querySelector("#training-levels");
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
  select.disabled = !target;
  input.disabled = !target;
  button.disabled = !target;
  if (!target) { preview.textContent = "加入游戏后可以修炼自己与未部署将领"; document.querySelector("#training-level").textContent = "0 阶"; return; }
  const remaining = Math.max(0, MAX_TRAINING_LEVEL - Number(target.entity.trainingLevel || 0));
  input.max = String(Math.max(1, Math.min(10, remaining)));
  if (Number(input.value) > Number(input.max)) input.value = input.max;
  const quote = remaining > 0 ? trainingQuote(target.entity, input.value) : { current: MAX_TRAINING_LEVEL, currentPower: trainingPower(target.entity), nextPower: trainingPower(target.entity), cost: 0, durationMs: 0 };
  const active = Object.values(payload?.world?.jobs || {}).find(job => job.type === "power-training" && job.targetType === target.type && job.targetId === target.id);
  document.querySelector("#training-level").textContent = `${quote.current} 阶`;
  preview.textContent = active
    ? `修炼中：${quote.current} → ${active.toLevel} 阶，完成后战力 ${formatNumber(Math.floor(Number(active.basePower || target.entity.basePower || 300) * (1 + Number(active.toLevel) * .06) * Math.pow(1.25, Math.floor(Number(active.toLevel) / 10))))}`
    : `当前战力 ${formatNumber(quote.currentPower)} → ${formatNumber(quote.nextPower)}；消耗 ${formatNumber(quote.cost)} 金币；耗时 ${formatDuration(quote.durationMs)}。每 10 阶获得一次额外增幅。`;
  button.disabled = Boolean(active) || remaining < 1 || Number(ownPlayer()?.gold || 0) < quote.cost;
  button.textContent = active ? "正在修炼" : remaining < 1 ? "已经满阶" : "开始修炼";
}

function marchAvailable() {
  const player = ownPlayer();
  if (!player?.position) return 0;
  const origin = dynamicCell(player.position.x, player.position.y);
  return Number(player.fieldArmySoldiers || 0) + (origin.ownerAccountId === ownAccountId() ? Number(origin.soldiers || 0) : 0);
}
function renderMarchParty() {
  const available = marchAvailable();
  const requested = Math.max(0, Number(document.querySelector("#march-soldiers").value || 0));
  document.querySelector("#march-available").textContent = `${formatNumber(available)} 人`;
  document.querySelector("#march-cost-per-cell").textContent = `${10 + Math.ceil(requested / 100)} 金币`;
  document.querySelector("#march-soldiers").max = String(available);
}

function canInteract(general) {
  const player = ownPlayer();
  if (!player || general?.holderAccountId !== ownAccountId()) return false;
  if (player.carriedGeneralIds?.includes(general.id) || general.status === "captured") return true;
  return general.status === "deployed" && general.location?.x === player.position?.x && general.location?.y === player.position?.y;
}

function makeButton(text, action, className = "") {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = text; button.className = className;
  button.addEventListener("click", action);
  return button;
}
function generalCard(general, mode) {
  const node = document.createElement("div");
  node.className = "general-card";
  const line = document.createElement("div");
  const name = document.createElement("b"); name.textContent = general.name;
  const power = document.createElement("small"); power.textContent = `战力 ${formatNumber(trainingPower(general))} · ${Number(general.trainingLevel || 0)}阶`;
  line.append(name, power);
  const note = document.createElement("small");
  note.textContent = mode === "captive" ? `原主：${accountLabel(general.loyalToAccountId || general.capturedFromAccountId)}` : general.status === "waiting" ? `留置于 ${general.location?.x},${general.location?.y}` : "随行中";
  const buttons = document.createElement("div"); buttons.className = "buttons";
  buttons.append(makeButton("详情", () => openGeneral(general.id)));
  if (canInteract(general)) buttons.append(makeButton("交互", () => openDialogue(general.id), "primary"));
  if (mode === "carried" && general.status === "carried") buttons.append(makeButton("部署", () => sendIntent({ type: "deploy-general", generalId: general.id })));
  if (general.status === "waiting" && general.location?.x === ownPlayer()?.position?.x && general.location?.y === ownPlayer()?.position?.y) {
    buttons.append(makeButton("带在身边", () => sendIntent({ type: "take-general", generalId: general.id })));
  }
  node.append(line, note, buttons);
  return node;
}

function renderGenerals() {
  const generals = Object.values(allGenerals()).filter(general => general.holderAccountId === ownAccountId());
  const carried = generals.filter(general => ["carried", "waiting"].includes(general.status));
  const captives = generals.filter(general => general.status === "captured");
  const carriedNode = document.querySelector("#carried-generals");
  carriedNode.replaceChildren();
  carriedNode.classList.toggle("empty", !carried.length);
  if (!carried.length) carriedNode.textContent = "尚无随行将领";
  else carried.forEach(general => carriedNode.append(generalCard(general, "carried")));
  const captiveNode = document.querySelector("#captives");
  captiveNode.replaceChildren();
  captiveNode.classList.toggle("empty", !captives.length);
  document.querySelector("#captive-count").textContent = String(captives.length);
  if (!captives.length) captiveNode.textContent = "暂无俘虏";
  else captives.forEach(general => captiveNode.append(generalCard(general, "captive")));

  const march = document.querySelector("#march-generals");
  march.replaceChildren();
  const label = document.createElement("small"); label.textContent = "随行将领"; march.append(label);
  const selectable = carried.filter(general => general.status === "carried").slice(0, 2);
  if (!selectable.length) { const empty = document.createElement("span"); empty.textContent = "暂无可选将领"; march.append(empty); }
  else selectable.forEach(general => {
    const item = document.createElement("label");
    const input = document.createElement("input"); input.type = "checkbox"; input.value = general.id; input.checked = true;
    const text = document.createElement("span"); text.textContent = general.name;
    item.append(input, text); march.append(item);
  });
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
    const power = document.createElement("small"); power.textContent = `战力 ${formatNumber(general.power)}`;
    info.append(name, power);
    const buttons = document.createElement("span");
    buttons.append(makeButton("查看", () => openGeneral(general.id)));
    const player = ownPlayer();
    const here = player?.position?.x === selected?.x && player?.position?.y === selected?.y;
    if (here && general.holderAccountId === ownAccountId()) {
      buttons.append(makeButton("交互", () => openDialogue(general.id), "primary"));
      buttons.append(makeButton("召回", () => sendIntent({ type: "recall-general", generalId: general.id })));
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
  if (selected) {
    const info = fact(selected.x, selected.y);
    cell = dynamicCell(selected.x, selected.y);
    const owner = payload?.world?.players?.[cell.ownerAccountId];
    const occupiedPower = Number(cell.soldiers || 0) + (cell.generalIds || []).reduce((sum, id) => sum + Number(allGenerals()[id]?.power || 0), 0);
    values["#cell-coordinate"] = `坐标 ${selected.x}, ${selected.y}`;
    values["#cell-owner"] = cell.ownerAccountId ? (cell.ownerAccountId === ownAccountId() ? "我的领地" : owner?.displayName || "其他势力") : "未占领";
    values["#cell-population"] = formatNumber(info.population);
    values["#cell-resource"] = info.resourceGrade;
    values["#cell-garrison"] = `${formatNumber(cell.soldiers)} / ${formatNumber(info.garrisonCap)}`;
    values["#cell-power"] = formatNumber(cell.ownerAccountId ? occupiedPower : info.neutralPower);
  }
  for (const [selector, value] of Object.entries(values)) document.querySelector(selector).textContent = value;
  renderDeployed(cell);
  const player = ownPlayer();
  const mine = selected && cell?.ownerAccountId === ownAccountId();
  document.querySelector("#start-mining").disabled = !player || !mine;
  document.querySelector("#train").disabled = !player || !mine;
  document.querySelector("#march").disabled = !player || !selected;
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
    const finish = job.type === "mining" ? Number(job.lastSettledAt) + Number(job.cycleMs) : Number(job.finishAt);
    remaining.dataset.finish = String(finish); remaining.textContent = formatDuration(finish - hostTime());
    line.append(title, remaining); node.append(line);
    if (job.type === "mining") node.append(makeButton("停止挂机", () => sendIntent({ type: "stop-mining", jobId: job.id })));
    target.append(node);
  }
}

function renderInbox() {
  const inbox = payload?.directInbox || [];
  const target = document.querySelector("#direct-inbox");
  target.replaceChildren();
  target.classList.toggle("empty", !inbox.length);
  document.querySelector("#direct-count").textContent = String(inbox.length);
  if (!inbox.length) { target.textContent = "暂无来信"; return; }
  [...inbox].reverse().forEach(item => {
    const node = document.createElement("article"); node.className = "direct-message";
    const line = document.createElement("div");
    const sender = document.createElement("b"); sender.textContent = item.payload?.generalName ? `${item.payload.generalName} · 来自 ${accountLabel(item.fromAccountId)}` : `来自 ${accountLabel(item.fromAccountId)}`;
    const time = document.createElement("time"); time.textContent = new Date(item.createdAt || Date.now()).toLocaleString("zh-CN");
    const text = document.createElement("p"); text.textContent = item.payload?.text || "";
    line.append(sender, time); node.append(line, text); target.append(node);
  });
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
  document.querySelector("#owner-server-status").textContent = payload?.initialized ? "已开服 · 后台静默同步" : "尚未开服";
  document.querySelector("#owner-open-server").disabled = !owner || Boolean(payload?.initialized);
  document.querySelector("#owner-open-server").textContent = payload?.initialized ? "已经开服" : "开服";
  document.querySelector("#owner-migrate-server").disabled = !owner || !payload?.initialized;
  const entries = ownerPlayerEntries();
  fillOwnerPlayerSelect("#owner-reset-player", entries);
  fillOwnerPlayerSelect("#owner-ban-player", entries);
  document.querySelector("#owner-reset-player-button").disabled = !owner || !payload?.initialized || !entries.length;
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
  document.querySelector("#general-power").textContent = `${formatNumber(trainingPower(general))} / ${Number(general.trainingLevel || 0)} 阶`;
  document.querySelector("#general-holder").textContent = accountLabel(general.holderAccountId);
  document.querySelector("#general-appearance").textContent = redactAccountIds(general.appearanceSetting || "沿用旧档案，暂无独立外观分类。");
  document.querySelector("#general-core-setting").textContent = redactAccountIds(general.coreSetting || general.setting || "暂无核心设定");
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
    p.textContent = redactAccountIds(`[${item.year}年] ${item.speakerName || accountLabel(item.accountId)}：${item.userText || "交谈"}\n${general.name}：${item.reply || "—"}`);
    history.append(p);
  });
  document.querySelector("#general-interact").classList.toggle("hidden", !canInteract(general));
  document.querySelector("#general-modal").classList.remove("hidden");
}

function renderDialogue() {
  const general = allGenerals()[dialogueGeneralId];
  if (!general) return;
  document.querySelector("#dialogue-general").textContent = general.name;
  document.querySelector("#dialogue-mode").textContent = general.status === "captured" ? "俘虏交互" : "将领互动";
  const history = document.querySelector("#dialogue-history"); history.replaceChildren();
  const lines = general.interactionHistory || [];
  const outgoing = [...dialogueRequests.values()].filter(item => item.generalId === dialogueGeneralId);
  if (!lines.length && !outgoing.length) { const p = document.createElement("p"); p.textContent = "尚无对话记录。"; history.append(p); }
  lines.forEach(item => {
    const user = document.createElement("p"); user.className = "user"; user.textContent = redactAccountIds(`${item.speakerName || accountLabel(item.accountId)}：${item.userText || "交谈"}`);
    const reply = document.createElement("p"); reply.textContent = redactAccountIds(`${general.name}：${item.reply || "—"}`);
    history.append(user, reply);
  });
  outgoing.forEach(item => {
    const user = document.createElement("p"); user.className = "user";
    user.textContent = redactAccountIds(`${ownPlayer()?.displayName || "我"}：${item.topic}`);
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
  if (dialogueGeneralId === request.generalId && !input.value.trim()) input.value = request.topic;
  if (dialogueGeneralId === request.generalId) renderDialogue();
}
function finishDialogueResult(requestId, result) {
  if (!dialogueRequests.has(requestId)) return;
  if (result?.dialogue?.reply) dialogueRequests.delete(requestId);
  else failDialogueRequest(requestId, "请求结束，但没有返回将领回复");
}
function openDialogue(id) {
  const general = allGenerals()[id];
  if (!canInteract(general)) { showToast("当前所在位置不支持与这名将领交互"); return; }
  dialogueGeneralId = id;
  document.querySelector("#general-modal").classList.add("hidden");
  document.querySelector("#dialogue-modal").classList.remove("hidden");
  renderDialogue();
  document.querySelector("#dialogue-input").focus();
}

function renderAll() {
  renderClock(); renderPlayer(); renderModelUsage(); renderPowerTraining(); renderCell(); renderJobs(); renderGenerals(); renderInbox(); renderOwnerCommands(); draw();
  const player = ownPlayer();
  const banned = Boolean(payload?.world?.bans?.[ownAccountId()]?.banned);
  document.querySelector("#join-wizard").classList.toggle("hidden", !payload?.initialized || Boolean(player) || banned);
  if (payload?.initialized && !player && !banned) renderJoinWizard();
  if (generalDetailId && !document.querySelector("#general-modal").classList.contains("hidden")) {
    if (allGenerals()[generalDetailId]) openGeneral(generalDetailId); else document.querySelector("#general-modal").classList.add("hidden");
  }
  if (dialogueGeneralId && !document.querySelector("#dialogue-modal").classList.contains("hidden")) renderDialogue();
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
document.querySelector("#preferences-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!preferenceDraft.tags.size) { showToast("请至少添加一个性癖标签"); return; }
  host("preferences", { preferences: { orientation: preferenceDraft.orientation, characterTags: tagPayload(preferenceDraft.tags) } }, { expectResult: true, key: "preferences" });
});
for (const category of [...new Set(tagCatalog.map(item => item.category))]) {
  const option = document.createElement("option"); option.value = category; option.textContent = category;
  document.querySelector("#tag-category").append(option);
}
document.querySelector("#join-form").addEventListener("submit", event => event.preventDefault());

canvas.addEventListener("click", event => {
  if (suppressMapClick) { suppressMapClick = false; return; }
  const rect = canvas.getBoundingClientRect();
  selected = {
    x: Math.max(0, Math.min(63, Math.floor((event.clientX - rect.left) / rect.width * 64))),
    y: Math.max(0, Math.min(63, Math.floor((event.clientY - rect.top) / rect.height * 64)))
  };
  renderCell(); draw();
});
viewport.addEventListener("contextmenu", event => event.preventDefault());
viewport.addEventListener("pointerdown", event => {
  if (event.button !== 2) return;
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
window.addEventListener("resize", () => updateMapScale(true));

document.querySelector("#return-library").addEventListener("click", () => host("library"));
document.querySelector("#owner-command-toggle").addEventListener("click", () => document.querySelector("#owner-command-modal").classList.remove("hidden"));
document.querySelector("#close-owner-command").addEventListener("click", () => document.querySelector("#owner-command-modal").classList.add("hidden"));
document.querySelector("#owner-ban-player").addEventListener("change", renderOwnerCommands);
document.querySelector("#owner-open-server").addEventListener("click", () => host("admin", { command: { type: "open-server" } }, { expectResult: true, key: "admin:open-server" }));
document.querySelector("#owner-migrate-server").addEventListener("click", () => host("admin", { command: { type: "migrate-server" } }, { expectResult: true, key: "admin:migrate-server" }));
document.querySelector("#owner-reset-player-button").addEventListener("click", () => host("admin", { command: { type: "player-reset", targetAccountId: document.querySelector("#owner-reset-player").value } }, { expectResult: true, key: "admin:player-reset" }));
document.querySelector("#owner-ban-player-button").addEventListener("click", () => {
  const select = document.querySelector("#owner-ban-player");
  const option = select.selectedOptions[0];
  const type = option?.dataset.banned === "true" ? "player-unban" : "player-ban";
  host("admin", { command: { type, targetAccountId: select.value } }, { expectResult: true, key: `admin:${type}` });
});
document.querySelector("#banned-return-library").addEventListener("click", () => host("library"));
document.querySelector("#march-soldiers").addEventListener("input", renderMarchParty);
document.querySelector("#training-target").addEventListener("change", renderPowerTraining);
document.querySelector("#training-levels").addEventListener("input", renderPowerTraining);
document.querySelector("#start-power-training").addEventListener("click", () => {
  const [targetType, targetId] = document.querySelector("#training-target").value.split(":");
  sendIntent({ type: "power-train", targetType, targetId, levels: Number(document.querySelector("#training-levels").value) });
});
document.querySelector("#start-mining").addEventListener("click", () => { if (selected) sendIntent({ type: "start-mining", x: selected.x, y: selected.y, auto: true }); });
document.querySelector("#train").addEventListener("click", () => { if (selected) sendIntent({ type: "train", x: selected.x, y: selected.y, amount: Number(document.querySelector("#train-amount").value) }); });
document.querySelector("#march").addEventListener("click", () => {
  if (!selected) return;
  const generalIds = [...document.querySelectorAll("#march-generals input:checked")].map(input => input.value);
  sendIntent({ type: "march", to: selected, soldiers: Number(document.querySelector("#march-soldiers").value), generalIds, attack: document.querySelector("#march-attack").checked });
});
document.querySelector("#close-general").addEventListener("click", () => document.querySelector("#general-modal").classList.add("hidden"));
document.querySelector("#general-interact").addEventListener("click", () => openDialogue(generalDetailId));
document.querySelector("#close-dialogue").addEventListener("click", () => document.querySelector("#dialogue-modal").classList.add("hidden"));
document.querySelector("#dialogue-form").addEventListener("submit", event => {
  event.preventDefault();
  const input = document.querySelector("#dialogue-input");
  const topic = input.value.trim();
  if (!topic || !dialogueGeneralId) return;
  const requestId = sendIntent({ type: "talk-general", generalId: dialogueGeneralId, topic });
  if (!requestId) return;
  for (const [id, item] of dialogueRequests) {
    if (item.generalId === dialogueGeneralId && item.status === "failed" && item.topic === topic) dialogueRequests.delete(id);
  }
  dialogueRequests.set(requestId, { generalId: dialogueGeneralId, topic, status: "sending", error: "" });
  input.value = "";
  renderDialogue();
});
document.querySelectorAll(".overlay").forEach(overlay => overlay.addEventListener("click", event => {
  if (event.target !== overlay || overlay.id === "join-wizard") return;
  overlay.classList.add("hidden");
}));

function resultSound(result) {
  const effects = Array.isArray(result?.effects) ? result.effects : [];
  if (result?.joinPreview) return "general";
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
  const requestState = ["result", "error"].includes(event.data.type) ? finishHostRequest(event.data.requestId) : null;
  if (requestState === false) return;
  if (event.data.type === "state") {
    applyHostedState(event.data.state, true);
    if (ownPlayer()) joinSubmitting = false;
    renderAll();
  } else if (event.data.type === "error") {
    joinSubmitting = false;
    playSound("error");
    showToast(event.data.message || "行动失败");
    failDialogueRequest(event.data.requestId, event.data.message);
    if (!ownPlayer()) renderJoinWizard();
  } else if (event.data.type === "result") {
    finishDialogueResult(event.data.requestId, event.data.result);
    if (event.data.result?.cancelled) {
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
      renderAll();
    }
    if (event.data.result?.preferences) {
      document.querySelector("#preferences-modal").classList.add("hidden");
      playSound("success");
      showToast("性癖偏好已保存");
      return;
    }
    const dialogue = event.data.result?.dialogue;
    if (dialogue?.reply) {
      if (dialogue.command?.type === "surrender") showToast(`${allGenerals()[dialogueGeneralId]?.name || "将领"}已经决定降服`);
      else if (dialogue.commandError) showToast(`将领已经写好书信，但传送失败：${dialogue.commandError}`);
      else if (dialogue.command?.type === "send-letter") showToast("将领书信已通过评论唤醒与私信通道发送");
      renderDialogue();
    }
    playSound(resultSound(event.data.result));
    if (event.data.result?.deferredEffects?.length) showToast("领地变化已经生效，将领生成会在后台自动重试");
  }
});

setInterval(() => {
  renderClock();
  document.querySelectorAll("[data-finish]").forEach(node => { node.textContent = formatDuration(Number(node.dataset.finish) - hostTime()); });
}, 1000);
host("ready");
