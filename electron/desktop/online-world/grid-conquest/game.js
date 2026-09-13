"use strict";

const canvas = document.querySelector("#map");
const context = canvas.getContext("2d");
const viewport = document.querySelector("#map-viewport");
const tagCatalog = typeof ACG_CHARACTER_TAGS === "undefined" ? [] : ACG_CHARACTER_TAGS;
const ZOOM_LEVELS = [.25, .375, .5, .75, 1, 1.25, 1.5, 2, 3];
const DEFAULT_VISIBLE_CELLS = 12;
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
const joinDraft = { profileId: "", orientation: "any", tags: new Map(), wish: "" };
const preferenceDraft = { orientation: "any", tags: new Map() };

function host(type, data = {}) { parent.postMessage({ source: "fyow-grid-conquest", type, ...data }, "*"); }
function ownAccountId() { return String(payload?.account?.accountId || ""); }
function ownPlayer() { return payload?.world?.players?.[ownAccountId()] || null; }
function allGenerals() { return payload?.world?.generals || {}; }
function cellKey(x, y) { return `${x},${y}`; }
function dynamicCell(x, y) { return payload?.world?.cells?.[cellKey(x, y)] || { ownerAccountId: null, soldiers: 0, generalIds: [] }; }
function fact(x, y) { return payload?.mapFacts?.[y * 64 + x] || { x, y, population: 0, resourceGrade: "—", resourceRank: 0, garrisonCap: 0, neutralPower: 0 }; }
function formatNumber(value) { return Number(value || 0).toLocaleString("zh-CN"); }
function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
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
function clickSound() {
  try {
    audioContext ||= new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(420, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(240, audioContext.currentTime + .045);
    gain.gain.setValueAtTime(.035, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .06);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + .065);
  } catch {}
}
document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (button && !button.disabled) clickSound();
}, true);

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
}
function renderPlayer() {
  const player = ownPlayer();
  document.querySelector("#edit-preferences").disabled = !player;
  document.querySelector("#player-name").textContent = player?.displayName || "尚未加入";
  document.querySelector("#gold").textContent = `${formatNumber(player?.gold)} 金币`;
  const cells = Object.values(payload?.world?.cells || {}).filter(cell => cell.ownerAccountId === ownAccountId());
  document.querySelector("#territories").textContent = formatNumber(cells.length);
  document.querySelector("#soldiers").textContent = formatNumber(cells.reduce((sum, cell) => sum + Number(cell.soldiers || 0), Number(player?.fieldArmySoldiers || 0)));
  document.querySelector("#position").textContent = player?.position ? `${player.position.x}, ${player.position.y}` : "—";
  renderMarchParty();
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
  const power = document.createElement("small"); power.textContent = `战力 ${formatNumber(general.power)}`;
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
    title.textContent = job.type === "mining" ? `开采 ${job.x},${job.y}` : job.type === "training" ? `练兵 ${formatNumber(job.amount)} 人` : `行军至 ${job.to.x},${job.to.y}`;
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
  document.querySelector("#general-power").textContent = formatNumber(general.power);
  document.querySelector("#general-holder").textContent = accountLabel(general.holderAccountId);
  document.querySelector("#general-setting").textContent = redactAccountIds(general.setting || "暂无设定");
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
  if (!lines.length) { const p = document.createElement("p"); p.textContent = "尚无对话记录。"; history.append(p); }
  else lines.forEach(item => {
    const user = document.createElement("p"); user.className = "user"; user.textContent = redactAccountIds(`${item.speakerName || accountLabel(item.accountId)}：${item.userText || "交谈"}`);
    const reply = document.createElement("p"); reply.textContent = redactAccountIds(`${general.name}：${item.reply || "—"}`);
    history.append(user, reply);
  });
  history.scrollTop = history.scrollHeight;
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
  renderClock(); renderPlayer(); renderCell(); renderJobs(); renderGenerals(); renderInbox(); renderOwnerCommands(); draw();
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
    ["第四问 · 4 / 4", "开疆扩土前，你会想要遇到一名怎样的良将？", "此题脱离词条，只保留性取向，并直接生成你的初始将领。"]
  ];
  document.querySelector("#join-progress").textContent = questions[joinStep][0];
  document.querySelector("#join-title").textContent = questions[joinStep][1];
  document.querySelector("#join-hint").textContent = questions[joinStep][2];
  document.querySelectorAll(".join-step").forEach((node, index) => node.classList.toggle("hidden", index !== joinStep));
  document.querySelector("#join-prev").classList.toggle("hidden", joinStep === 0 || joinSubmitting);
  const next = document.querySelector("#join-next");
  next.textContent = joinSubmitting ? "正在生成初始将领…" : joinStep === 3 ? "踏入疆土" : "下一问";
  next.disabled = joinSubmitting;
  if (joinStep === 0) renderProfileOptions();
  if (joinStep === 2) {
    if (!joinDraft.tags.size) joinDraft.tags = mapTags(payload?.localPreferences?.characterTags);
    renderTagOptions();
  }
}
function validateJoinStep() {
  if (joinStep === 0 && !joinDraft.profileId) return "请选择一份角色设定";
  if (joinStep === 1) {
    joinDraft.orientation = document.querySelector('input[name="orientation"]:checked')?.value || "";
    if (!joinDraft.orientation) return "请选择性取向";
  }
  if (joinStep === 2 && joinDraft.tags.size < 1) return "请至少添加一个性癖标签";
  if (joinStep === 3) {
    joinDraft.wish = document.querySelector("#initial-general-wish").value.trim();
    if (!joinDraft.wish) return "请描述你想遇到的初始良将";
  }
  return "";
}

async function sendIntent(intent) {
  host("intent", { intent: { ...intent, idempotencyKey: crypto.randomUUID() } });
}
document.querySelector("#join-next").addEventListener("click", () => {
  const error = validateJoinStep();
  if (error) { showToast(error); return; }
  if (joinStep < 3) { joinStep += 1; renderJoinWizard(); return; }
  joinSubmitting = true; renderJoinWizard();
  sendIntent({
    type: "join",
    characterProfileId: joinDraft.profileId,
    orientation: joinDraft.orientation,
    characterTags: tagPayload(joinDraft.tags),
    initialGeneralWish: joinDraft.wish
  });
});
document.querySelector("#join-prev").addEventListener("click", () => { if (joinStep > 0) { joinStep -= 1; renderJoinWizard(); } });
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
  host("preferences", { preferences: { orientation: preferenceDraft.orientation, characterTags: tagPayload(preferenceDraft.tags) } });
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
document.querySelector("#owner-open-server").addEventListener("click", () => host("admin", { command: { type: "open-server" } }));
document.querySelector("#owner-migrate-server").addEventListener("click", () => host("admin", { command: { type: "migrate-server" } }));
document.querySelector("#owner-reset-player-button").addEventListener("click", () => host("admin", { command: { type: "player-reset", targetAccountId: document.querySelector("#owner-reset-player").value } }));
document.querySelector("#owner-ban-player-button").addEventListener("click", () => {
  const select = document.querySelector("#owner-ban-player");
  const option = select.selectedOptions[0];
  host("admin", { command: { type: option?.dataset.banned === "true" ? "player-unban" : "player-ban", targetAccountId: select.value } });
});
document.querySelector("#banned-return-library").addEventListener("click", () => host("library"));
document.querySelector("#march-soldiers").addEventListener("input", renderMarchParty);
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
  input.value = "";
  sendIntent({ type: "talk-general", generalId: dialogueGeneralId, topic });
});
document.querySelectorAll(".overlay").forEach(overlay => overlay.addEventListener("click", event => {
  if (event.target !== overlay || overlay.id === "join-wizard") return;
  overlay.classList.add("hidden");
}));

window.addEventListener("message", event => {
  if (event.data?.source !== "fengyue-host") return;
  if (event.data.type === "state") {
    payload = event.data.state;
    serverNow = Number(payload?.serverNow || Date.now());
    receivedAt = Date.now();
    joinSubmitting = false;
    renderAll();
  } else if (event.data.type === "error") {
    joinSubmitting = false;
    showToast(event.data.message || "行动失败");
    if (!ownPlayer()) renderJoinWizard();
  } else if (event.data.type === "result") {
    if (event.data.result?.preferences) {
      payload = event.data.result.state || payload;
      document.querySelector("#preferences-modal").classList.add("hidden");
      renderAll();
      showToast("性癖偏好已保存");
      return;
    }
    const dialogue = event.data.result?.dialogue;
    if (dialogue?.reply) {
      if (dialogue.command?.type === "surrender") showToast(`${allGenerals()[dialogueGeneralId]?.name || "将领"}已经决定降服`);
      else if (dialogue.command?.type === "send-letter") showToast("将领书信已通过评论唤醒与私信通道发送");
      renderDialogue();
    }
  }
});

setInterval(() => {
  renderClock();
  document.querySelectorAll("[data-finish]").forEach(node => { node.textContent = formatDuration(Number(node.dataset.finish) - hostTime()); });
}, 1000);
host("ready");
