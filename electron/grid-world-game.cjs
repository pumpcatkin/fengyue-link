const crypto = require("node:crypto");

const GRID_GAME_ID = "cc.aiero.fyow.grid-conquest";
const GRID_SIZE = 64;
const RESOURCE_GRADES = Object.freeze(["D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+", "S-", "S", "S+"]);
const ORIENTATIONS = new Set(["men", "women", "any"]);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DIALOGUE_COOLDOWN_MS = 15 * 1000;

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`${name}必须是 ${minimum} 到 ${maximum} 的整数`);
  return number;
}

function coordinate(value, name) {
  return integer(value, name, 0, GRID_SIZE - 1);
}

function keyOf(x, y) { return `${x},${y}`; }

function entropy(seed, ...parts) {
  return crypto.createHash("sha256").update([seed, ...parts].join("\0")).digest();
}

function randomUnit(seed, ...parts) {
  return entropy(seed, ...parts).readUInt32BE(0) / 0x100000000;
}

function staticCell(seed, xValue, yValue) {
  const x = coordinate(xValue, "横坐标");
  const y = coordinate(yValue, "纵坐标");
  const bytes = entropy(String(seed), "cell", x, y);
  const population = 100 + (bytes.readUInt32BE(0) % 9901);
  const roll = bytes.readUInt16BE(4) / 0x10000;
  const rank = clamp(Math.floor(Math.pow(roll, 1.7) * RESOURCE_GRADES.length), 0, RESOURCE_GRADES.length - 1);
  return {
    x, y, population,
    resourceGrade: RESOURCE_GRADES[rank],
    resourceRank: rank,
    garrisonCap: Math.floor(population * 0.2),
    neutralPower: Math.floor(population * 0.2)
  };
}

function dynamicCell(state, x, y) {
  const key = keyOf(x, y);
  return state.cells[key] || (state.cells[key] = { ownerAccountId: null, soldiers: 0, generalIds: [] });
}

function createWorld({ seed = crypto.randomBytes(16).toString("hex"), seasonId = crypto.randomUUID(), startedAt = Date.now(), authorityAccountId = null } = {}) {
  return {
    schema: "fyow.grid-state/1",
    gameId: GRID_GAME_ID,
    seasonId: String(seasonId),
    seed: String(seed),
    width: GRID_SIZE,
    height: GRID_SIZE,
    startedAt: Number(startedAt),
    authorityAccountId: authorityAccountId ? String(authorityAccountId) : null,
    revision: 0,
    cells: {},
    players: {},
    privatePlayers: {},
    generals: {},
    jobs: {},
    processedIntents: []
  };
}

function chooseCapital(state, accountId) {
  const start = entropy(state.seed, "capital", accountId).readUInt16BE(0) % (GRID_SIZE * GRID_SIZE);
  for (let offset = 0; offset < GRID_SIZE * GRID_SIZE; offset += 1) {
    const index = (start + offset * 97) % (GRID_SIZE * GRID_SIZE);
    const x = index % GRID_SIZE;
    const y = Math.floor(index / GRID_SIZE);
    if (!dynamicCell(state, x, y).ownerAccountId) return { x, y };
  }
  throw new Error("地图已经没有可用出生地");
}

function allowedGeneralGender(orientation, seed, ...parts) {
  if (orientation === "men") return "male";
  if (orientation === "women") return "female";
  return randomUnit(seed, "general-gender", ...parts) < 0.5 ? "male" : "female";
}

function generalDiscoveryChance(population) {
  return 0.02 + ((clamp(Number(population), 100, 10000) - 100) / 9900) * 0.23;
}

function resourceCycleMs(cell) {
  return Math.round(MINUTE + (cell.resourceRank / (RESOURCE_GRADES.length - 1)) * (HOUR - MINUTE));
}

function resourceYield(cell) {
  return Math.max(1, Math.floor(cell.population * (cell.resourceRank + 2) / 180));
}

function trainDurationMs(amount) {
  return clamp(MINUTE + Math.ceil(Number(amount) / 5) * 1000, MINUTE, HOUR);
}

function marchDurationMs(distance) {
  return clamp(Number(distance) * MINUTE, MINUTE, HOUR);
}

function marchCost(distance, soldiers) {
  return Math.max(10, Number(distance) * (10 + Math.ceil(Number(soldiers) / 100)));
}

function generalPower(general) {
  return Number(general?.power || 0);
}

function regionPower(state, x, y) {
  const cell = dynamicCell(state, x, y);
  return Number(cell.soldiers || 0) + (cell.generalIds || []).reduce((total, id) => total + generalPower(state.generals[id]), 0);
}

function pathBetween(from, to) {
  const path = [];
  let x = from.x;
  let y = from.y;
  while (x !== to.x) { x += Math.sign(to.x - x); path.push({ x, y }); }
  while (y !== to.y) { y += Math.sign(to.y - y); path.push({ x, y }); }
  return path;
}

function returnArmy(state, player, job, soldiers) {
  const amount = Math.max(0, Number(soldiers || 0));
  const origin = dynamicCell(state, job.from.x, job.from.y);
  if (origin.ownerAccountId !== job.accountId) {
    player.fieldArmySoldiers = Number(player.fieldArmySoldiers || 0) + amount;
    return;
  }
  const capacity = staticCell(state.seed, job.from.x, job.from.y).garrisonCap;
  const accepted = Math.max(0, Math.min(amount, capacity - Number(origin.soldiers || 0)));
  origin.soldiers += accepted;
  player.fieldArmySoldiers = Number(player.fieldArmySoldiers || 0) + amount - accepted;
}

function gameYear(state, timestamp) {
  return 1 + Math.floor(Math.max(0, Number(timestamp) - Number(state.startedAt)) / (24 * HOUR));
}

function formatGeneralMemory(general) {
  const entries = Array.isArray(general?.memory?.entries) ? general.memory.entries : [];
  const recent = entries.slice(-30);
  const speech = recent.filter(entry => entry.category === "speech").map(entry => `[${entry.year}年]${entry.text}`).join("");
  const deeds = recent.filter(entry => entry.category !== "speech").map(entry => `[${entry.year}年]${entry.text}`).join("");
  return `言谈：${speech || "暂无"}\n经历：${deeds || "暂无"}`;
}

function appendGeneralMemory(general, { year, category, text, accountId, intimacyDelta = 0 }) {
  general.memory ||= { entries: [], intimacy: {} };
  general.memory.entries ||= [];
  general.memory.intimacy ||= {};
  general.memory.entries.push({ year: integer(year, "年份", 1), category: category === "deed" ? "deed" : "speech", text: String(text).slice(0, 120) });
  if (general.memory.entries.length > 30) general.memory.entries.splice(0, general.memory.entries.length - 30);
  if (accountId) general.memory.intimacy[accountId] = clamp(Number(general.memory.intimacy[accountId] || 0) + Number(intimacyDelta || 0), -100, 100);
  general.memoryText = formatGeneralMemory(general).slice(0, 1000);
}

function createFallbackGeneral({ id = crypto.randomUUID(), name, gender, setting, power, holderAccountId, year = 1 }) {
  const general = {
    id: String(id),
    name: String(name || (gender === "female" ? "无名女将" : "无名将领")).slice(0, 24),
    gender: gender === "female" ? "female" : "male",
    setting: String(setting || "此人出身乱世，善于整军与守土，等待慧眼之主发现其才干。").slice(0, 1000),
    power: integer(power ?? 300, "将领战力", 1, 100000),
    holderAccountId: String(holderAccountId),
    loyalToAccountId: String(holderAccountId),
    status: "carried",
    location: null,
    memory: { entries: [], intimacy: { [String(holderAccountId)]: 5 } },
    memoryText: ""
  };
  appendGeneralMemory(general, { year, category: "deed", text: `被${holderAccountId}发掘并提拔为将领`, accountId: holderAccountId, intimacyDelta: 5 });
  return general;
}

function settleWorld(inputState, nowValue = Date.now()) {
  const state = clone(inputState);
  const now = Number(nowValue);
  if (!Number.isFinite(now) || now < state.startedAt) throw new Error("宿主时间无效");
  const effects = [];
  for (const [jobId, job] of Object.entries(state.jobs)) {
    if (job.type === "mining") {
      const cell = dynamicCell(state, job.x, job.y);
      const player = state.players[job.accountId];
      if (!player || cell.ownerAccountId !== job.accountId) {
        delete state.jobs[jobId];
        effects.push({ type: "mining-stopped", reason: "territory-lost", jobId, accountId: job.accountId, x: job.x, y: job.y });
        continue;
      }
      const cycles = Math.min(1440, Math.floor((now - Number(job.lastSettledAt)) / Number(job.cycleMs)));
      if (cycles > 0) {
        const amount = cycles * Number(job.yieldPerCycle);
        player.gold += amount;
        job.lastSettledAt += cycles * job.cycleMs;
        effects.push({ type: "mining-complete", jobId, accountId: job.accountId, cycles, gold: amount });
        if (!job.auto) delete state.jobs[jobId];
      }
      continue;
    }
    if (now < Number(job.finishAt)) continue;
    if (job.type === "training") {
      const cell = dynamicCell(state, job.x, job.y);
      if (cell.ownerAccountId !== job.accountId || !state.players[job.accountId]) {
        effects.push({ type: "training-cancelled", reason: "territory-lost", jobId, accountId: job.accountId, x: job.x, y: job.y, soldiers: 0 });
        delete state.jobs[jobId];
        continue;
      }
      const info = staticCell(state.seed, job.x, job.y);
      const accepted = Math.max(0, Math.min(job.amount, info.garrisonCap - Number(cell.soldiers || 0)));
      cell.soldiers += accepted;
      effects.push({ type: "training-complete", jobId, accountId: job.accountId, x: job.x, y: job.y, soldiers: accepted });
      delete state.jobs[jobId];
      continue;
    }
    if (job.type === "march") {
      resolveMarch(state, job, effects, now);
      delete state.jobs[jobId];
    }
  }
  return { state, effects, now };
}

function resolveMarch(state, job, effects, now) {
  const player = state.players[job.accountId];
  if (!player) return;
  const origin = dynamicCell(state, job.from.x, job.from.y);
  const path = pathBetween(job.from, job.to);
  const blocked = path.find(point => {
    const owner = dynamicCell(state, point.x, point.y).ownerAccountId;
    return owner && owner !== job.accountId;
  });
  const isTargetBlock = blocked && blocked.x === job.to.x && blocked.y === job.to.y;
  if (blocked && (!job.attack || !isTargetBlock)) {
    returnArmy(state, player, job, job.soldiers);
    player.position = { ...job.from };
    effects.push({ type: "march-blocked", jobId: job.id, accountId: job.accountId, at: blocked, returnedTo: job.from });
    return;
  }
  const targetInfo = staticCell(state.seed, job.to.x, job.to.y);
  const target = dynamicCell(state, job.to.x, job.to.y);
  const enemy = target.ownerAccountId && target.ownerAccountId !== job.accountId;
  const neutral = !target.ownerAccountId;
  if ((enemy || neutral) && job.attack) {
    const defenderPower = enemy ? regionPower(state, job.to.x, job.to.y) : targetInfo.neutralPower;
    const attackerGeneralPower = job.generalIds.reduce((sum, id) => sum + generalPower(state.generals[id]), 0);
    const attackerPower = job.soldiers + attackerGeneralPower;
    if (attackerPower <= defenderPower) {
      const survivors = Math.max(0, Math.floor(job.soldiers * attackerPower / Math.max(1, defenderPower) * 0.35));
      returnArmy(state, player, job, survivors);
      player.position = { ...job.from };
      effects.push({ type: "battle-lost", jobId: job.id, accountId: job.accountId, at: job.to, attackerPower, defenderPower, survivors });
      return;
    }
    const previousOwner = target.ownerAccountId;
    const capturedGeneralIds = [...(target.generalIds || [])];
    const losses = Math.min(job.soldiers, Math.floor(defenderPower * 0.45));
    const survivors = Math.max(1, job.soldiers - losses);
    target.ownerAccountId = job.accountId;
    target.soldiers = Math.min(targetInfo.garrisonCap, survivors);
    target.generalIds = [];
    player.position = { ...job.to };
    player.fieldArmySoldiers = Math.max(0, survivors - target.soldiers);
    for (const generalId of capturedGeneralIds) {
      const general = state.generals[generalId];
      if (!general) continue;
      general.holderAccountId = job.accountId;
      general.capturedFromAccountId = previousOwner || general.loyalToAccountId || null;
      general.capturedAtYear = gameYear(state, now);
      if (!player.carriedGeneralIds.includes(generalId) && player.carriedGeneralIds.length < 2) {
        player.carriedGeneralIds.push(generalId);
        general.status = "carried";
        general.location = null;
      } else {
        general.status = "captured";
        general.location = { ...job.to };
      }
      appendGeneralMemory(general, { year: gameYear(state, now), category: "deed", text: `战败，被${job.accountId}俘虏`, accountId: job.accountId, intimacyDelta: -5 });
    }
    effects.push({ type: "battle-won", jobId: job.id, accountId: job.accountId, at: job.to, previousOwner, attackerPower, defenderPower, soldiers: target.soldiers, capturedGeneralIds });
    if (neutral) {
      const chance = generalDiscoveryChance(targetInfo.population);
      if (randomUnit(state.seed, "discover-general", state.seasonId, job.id, job.to.x, job.to.y) < chance) {
        const orientation = state.privatePlayers[job.accountId]?.orientation || "any";
        effects.push({
          type: "general-generation-request",
          accountId: job.accountId,
          x: job.to.x,
          y: job.to.y,
          gender: allowedGeneralGender(orientation, state.seed, job.id),
          population: targetInfo.population,
          resourceGrade: targetInfo.resourceGrade
        });
      }
    }
    return;
  }
  player.position = { ...job.to };
  if (target.ownerAccountId === job.accountId) {
    const accepted = Math.min(job.soldiers, targetInfo.garrisonCap - target.soldiers);
    target.soldiers += Math.max(0, accepted);
    player.fieldArmySoldiers = job.soldiers - Math.max(0, accepted);
  } else {
    player.fieldArmySoldiers = job.soldiers;
  }
  effects.push({ type: "march-arrived", jobId: job.id, accountId: job.accountId, at: job.to, fieldArmySoldiers: player.fieldArmySoldiers });
}

function ensurePlayer(state, accountId) {
  const player = state.players[accountId];
  if (!player) throw new Error("玩家尚未加入本赛季");
  return player;
}

function jobFor(state, predicate) {
  return Object.values(state.jobs).find(predicate);
}

function applyIntent(inputState, rawIntent, context = {}) {
  const now = Number(context.now ?? Date.now());
  const actorAccountId = String(context.actorAccountId || rawIntent?.actorAccountId || "").trim();
  if (!actorAccountId) throw new Error("缺少玩家账号");
  const intent = clone(rawIntent || {});
  const type = String(intent.type || "");
  const idempotencyKey = String(intent.idempotencyKey || context.eventId || crypto.randomUUID()).slice(0, 100);
  if (inputState.processedIntents.includes(idempotencyKey)) return { state: clone(inputState), duplicate: true, effects: [], event: null };
  const settled = settleWorld(inputState, now);
  const state = settled.state;
  const effects = [...settled.effects];
  let result = {};

  if (type === "join") {
    if (state.players[actorAccountId]) throw new Error("玩家已经加入本赛季");
    const orientation = ORIENTATIONS.has(intent.orientation) ? intent.orientation : null;
    if (!orientation) throw new Error("请选择将领性别偏好");
    const capital = chooseCapital(state, actorAccountId);
    const info = staticCell(state.seed, capital.x, capital.y);
    const cell = dynamicCell(state, capital.x, capital.y);
    cell.ownerAccountId = actorAccountId;
    cell.soldiers = Math.max(1, Math.floor(info.garrisonCap * 0.5));
    state.players[actorAccountId] = { accountId: actorAccountId, displayName: String(intent.displayName || actorAccountId).slice(0, 40), gold: 1000, position: capital, fieldArmySoldiers: 0, carriedGeneralIds: [], joinedAt: now };
    state.privatePlayers[actorAccountId] = { orientation };
    result = { capital, gold: 1000, soldiers: cell.soldiers };
  } else {
    const player = ensurePlayer(state, actorAccountId);
    if (type === "start-mining") {
      const x = coordinate(intent.x, "横坐标");
      const y = coordinate(intent.y, "纵坐标");
      const cell = dynamicCell(state, x, y);
      if (cell.ownerAccountId !== actorAccountId) throw new Error("只能开采自己占领的区域");
      if (jobFor(state, job => job.type === "mining" && job.accountId === actorAccountId && job.x === x && job.y === y)) throw new Error("该区域已经在开采");
      const info = staticCell(state.seed, x, y);
      const id = crypto.randomUUID();
      state.jobs[id] = { id, type: "mining", accountId: actorAccountId, x, y, auto: intent.auto !== false, startedAt: now, lastSettledAt: now, cycleMs: resourceCycleMs(info), yieldPerCycle: resourceYield(info) };
      result = { jobId: id, cycleMs: state.jobs[id].cycleMs, yieldPerCycle: state.jobs[id].yieldPerCycle, auto: state.jobs[id].auto };
    } else if (type === "stop-mining") {
      const id = String(intent.jobId || "");
      const job = state.jobs[id];
      if (!job || job.type !== "mining" || job.accountId !== actorAccountId) throw new Error("找不到这项开采任务");
      delete state.jobs[id];
      result = { jobId: id, stopped: true };
    } else if (type === "train") {
      const x = coordinate(intent.x, "横坐标");
      const y = coordinate(intent.y, "纵坐标");
      const amount = integer(intent.amount, "练兵数量", 1, 10000);
      const cell = dynamicCell(state, x, y);
      const info = staticCell(state.seed, x, y);
      if (cell.ownerAccountId !== actorAccountId) throw new Error("只能在自己占领的区域练兵");
      const queued = Object.values(state.jobs).filter(job => job.type === "training" && job.x === x && job.y === y).reduce((sum, job) => sum + job.amount, 0);
      if (cell.soldiers + queued + amount > info.garrisonCap) throw new Error(`该区域驻军上限为 ${info.garrisonCap}`);
      const cost = amount * 2;
      if (player.gold < cost) throw new Error("金币不足");
      player.gold -= cost;
      const id = crypto.randomUUID();
      state.jobs[id] = { id, type: "training", accountId: actorAccountId, x, y, amount, cost, startedAt: now, finishAt: now + trainDurationMs(amount) };
      result = { jobId: id, cost, finishAt: state.jobs[id].finishAt };
    } else if (type === "march") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("已有行军正在途中");
      const to = { x: coordinate(intent.to?.x, "目标横坐标"), y: coordinate(intent.to?.y, "目标纵坐标") };
      const from = { ...player.position };
      const path = pathBetween(from, to);
      if (!path.length) throw new Error("目标位置与当前位置相同");
      const origin = dynamicCell(state, from.x, from.y);
      const requested = integer(intent.soldiers ?? 0, "携带士兵", 0, 1000000);
      const available = Number(player.fieldArmySoldiers || 0) + (origin.ownerAccountId === actorAccountId ? Number(origin.soldiers || 0) : 0);
      if (requested > available) throw new Error("当前可携带士兵不足");
      const cost = marchCost(path.length, requested);
      if (player.gold < cost) throw new Error("金币不足");
      const fromField = Math.min(requested, Number(player.fieldArmySoldiers || 0));
      player.fieldArmySoldiers -= fromField;
      const fromGarrison = requested - fromField;
      if (fromGarrison) origin.soldiers -= fromGarrison;
      player.gold -= cost;
      const generalIds = Array.isArray(intent.generalIds) ? [...new Set(intent.generalIds.map(String))] : [...player.carriedGeneralIds];
      if (generalIds.length > 2 || generalIds.some(id => !player.carriedGeneralIds.includes(id))) throw new Error("行军最多携带两名身边将领");
      const id = crypto.randomUUID();
      state.jobs[id] = { id, type: "march", accountId: actorAccountId, from, to, soldiers: requested, generalIds, attack: Boolean(intent.attack), cost, startedAt: now, finishAt: now + marchDurationMs(path.length) };
      result = { jobId: id, cost, distance: path.length, finishAt: state.jobs[id].finishAt };
    } else if (type === "deploy-general") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("行军途中不能部署将领");
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      const { x, y } = player.position;
      const cell = dynamicCell(state, x, y);
      if (!general || general.holderAccountId !== actorAccountId || !player.carriedGeneralIds.includes(generalId)) throw new Error("将领不在身边");
      if (cell.ownerAccountId !== actorAccountId) throw new Error("只能在自己的区域部署将领");
      if (cell.generalIds.length >= 2) throw new Error("每个区域最多部署两名将领");
      player.carriedGeneralIds = player.carriedGeneralIds.filter(id => id !== generalId);
      cell.generalIds.push(generalId);
      general.status = "deployed";
      general.location = { x, y };
      result = { generalId, x, y, publishGeneralArchive: true };
    } else if (type === "recall-general") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("行军途中不能召回将领");
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      const { x, y } = player.position;
      const cell = dynamicCell(state, x, y);
      if (!general || general.holderAccountId !== actorAccountId || !cell.generalIds.includes(generalId)) throw new Error("该区域没有这名将领");
      if (player.carriedGeneralIds.length >= 2) throw new Error("身边最多携带两名将领");
      cell.generalIds = cell.generalIds.filter(id => id !== generalId);
      player.carriedGeneralIds.push(generalId);
      general.status = "carried";
      general.location = null;
      result = { generalId, removeGeneralWorldBook: false };
    } else if (type === "take-general") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("行军途中不能带走留置将领");
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!general || general.holderAccountId !== actorAccountId || !["captured", "waiting"].includes(general.status)) throw new Error("这里没有可带走的将领");
      if (general.location?.x !== player.position.x || general.location?.y !== player.position.y) throw new Error("必须到达将领所在区域才能带走");
      if (player.carriedGeneralIds.length >= 2) throw new Error("身边最多携带两名将领");
      player.carriedGeneralIds.push(generalId);
      general.status = "carried";
      general.location = null;
      result = { generalId };
    } else if (type === "talk-general") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!general || !player.carriedGeneralIds.includes(generalId) || general.status === "deployed") throw new Error("只有带在身边且未部署的将领可以交谈");
      const topic = String(intent.topic || "").trim().slice(0, 120);
      if (!topic) throw new Error("请输入谈话内容");
      const privatePlayer = state.privatePlayers[actorAccountId] ||= { orientation: "any" };
      privatePlayer.lastDialogueAtByGeneral ||= {};
      const lastDialogueAt = Number(privatePlayer.lastDialogueAtByGeneral[generalId] || 0);
      if (lastDialogueAt && now - lastDialogueAt < DIALOGUE_COOLDOWN_MS) throw new Error("将领对话请求过于频繁，请稍后再试");
      privatePlayer.lastDialogueAtByGeneral[generalId] = now;
      result = { generalId, topic, modelRequest: buildGeneralDialogueRequest(state, general, player, topic, now) };
    } else if (type === "record-general-dialogue") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!general || !player.carriedGeneralIds.includes(generalId)) throw new Error("将领不在身边");
      appendGeneralMemory(general, { year: gameYear(state, now), category: "speech", text: `和${player.displayName}谈论${String(intent.topic || "日常").slice(0, 40)}`, accountId: actorAccountId, intimacyDelta: clamp(Number(intent.intimacyDelta || 1), -5, 5) });
      result = { generalId, memoryText: general.memoryText, intimacy: general.memory.intimacy[actorAccountId] };
    } else if (type === "grant-general") {
      if (String(context.authorityAccountId || "") !== String(state.authorityAccountId || actorAccountId)) throw new Error("只有本局权威端可以登记新将领");
      const gender = intent.gender === "female" ? "female" : "male";
      const expected = allowedGeneralGender(state.privatePlayers[actorAccountId]?.orientation || "any", state.seed, intent.discoveryId || idempotencyKey);
      if (gender !== expected && state.privatePlayers[actorAccountId]?.orientation !== "any") throw new Error("将领性别不符合玩家开局偏好");
      const general = createFallbackGeneral({ id: intent.generalId, name: intent.name, gender, setting: intent.setting, power: intent.power, holderAccountId: actorAccountId, year: gameYear(state, now) });
      if (player.carriedGeneralIds.length >= 2) {
        general.status = "waiting";
        general.location = { x: coordinate(intent.location?.x, "将领横坐标"), y: coordinate(intent.location?.y, "将领纵坐标") };
      }
      state.generals[general.id] = general;
      if (general.status === "carried") player.carriedGeneralIds.push(general.id);
      result = { generalId: general.id, name: general.name, status: general.status, location: general.location };
    } else throw new Error(`未知游戏行动：${type}`);
  }

  state.revision += 1;
  state.processedIntents.push(idempotencyKey);
  if (state.processedIntents.length > 1000) state.processedIntents.splice(0, state.processedIntents.length - 1000);
  const publicIntent = { ...intent, actorAccountId };
  delete publicIntent.orientation;
  const event = { schema: "fyow.event/3", eventId: String(context.eventId || crypto.randomUUID()), gameId: state.gameId, seasonId: state.seasonId, revision: state.revision, actorAccountId, type, intent: publicIntent, result, createdAt: now };
  return { state, effects, result, event, duplicate: false };
}

function buildGeneralGenerationRequest(state, effect, idempotencyKey) {
  return {
    task: "general.generate",
    keyword: "[[FYOW:TASK:general.generate:v1]]",
    idempotencyKey: String(idempotencyKey),
    input: {
      schema: "fyow.general-generate-request/1",
      world: "这个世界战火纷飞，蛮夷遍地，但资源丰饶。各路有志之士带着自己的志趣，试图统治这片大陆。只有天生拥有慧眼的人才有统治的可能性。",
      gender: effect.gender,
      population: effect.population,
      resourceGrade: effect.resourceGrade,
      location: { x: effect.x, y: effect.y },
      maximumChineseCharacters: 1000
    }
  };
}

function buildGeneralDialogueRequest(state, general, player, topic, now) {
  return {
    task: "general.dialogue",
    keyword: `[[FYOW:TASK:general.dialogue:v1]]\n${general.name}`,
    input: {
      schema: "fyow.general-dialogue-request/1",
      general: { name: general.name, gender: general.gender, setting: general.setting, memory: general.memoryText, intimacy: general.memory?.intimacy?.[player.accountId] || 0 },
      speaker: { accountId: player.accountId, name: player.displayName },
      topic,
      gameYear: gameYear(state, now)
    }
  };
}

function projectWorldState(state, viewerAccountId) {
  const viewer = String(viewerAccountId || "");
  const players = clone(state.players || {});
  for (const [accountId, player] of Object.entries(players)) {
    if (accountId === viewer) continue;
    delete player.gold;
    delete player.fieldArmySoldiers;
    delete player.carriedGeneralIds;
  }
  const generals = {};
  for (const [id, general] of Object.entries(state.generals || {})) {
    if (general.status === "deployed" || general.holderAccountId === viewer) generals[id] = clone(general);
  }
  return {
    schema: state.schema,
    gameId: state.gameId,
    seasonId: state.seasonId,
    seed: state.seed,
    width: state.width,
    height: state.height,
    startedAt: state.startedAt,
    revision: state.revision,
    cells: clone(state.cells),
    players,
    generals,
    jobs: Object.fromEntries(Object.entries(state.jobs || {}).filter(([, job]) => job.accountId === viewer)),
    processedIntents: clone(state.processedIntents || [])
  };
}

module.exports = {
  GRID_GAME_ID,
  GRID_SIZE,
  RESOURCE_GRADES,
  MINUTE,
  HOUR,
  DIALOGUE_COOLDOWN_MS,
  keyOf,
  staticCell,
  createWorld,
  dynamicCell,
  generalDiscoveryChance,
  resourceCycleMs,
  resourceYield,
  trainDurationMs,
  marchDurationMs,
  marchCost,
  regionPower,
  gameYear,
  formatGeneralMemory,
  appendGeneralMemory,
  createFallbackGeneral,
  settleWorld,
  applyIntent,
  buildGeneralGenerationRequest,
  buildGeneralDialogueRequest,
  projectWorldState
};
