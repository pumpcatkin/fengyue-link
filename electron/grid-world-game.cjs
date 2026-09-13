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
    bans: {},
    playerEpochs: {},
    privatePlayers: {},
    generals: {},
    jobs: {},
    processedIntents: []
  };
}

function resetPlayerState(inputState, targetAccountId, nextEpoch) {
  const state = inputState;
  const target = String(targetAccountId || "").trim();
  if (!target) throw new Error("缺少需要重置的玩家账号");
  state.bans ||= {};
  state.playerEpochs ||= {};
  state.players ||= {};
  state.privatePlayers ||= {};
  state.generals ||= {};
  state.jobs ||= {};
  const deployedIds = new Set(Object.entries(state.generals)
    .filter(([, general]) => String(general?.holderAccountId || "") === target)
    .map(([id]) => id));
  for (const [key, cell] of Object.entries(state.cells || {})) {
    if (String(cell?.ownerAccountId || "") === target) delete state.cells[key];
    else if (Array.isArray(cell?.generalIds)) cell.generalIds = cell.generalIds.filter(id => !deployedIds.has(String(id)));
  }
  for (const [id, general] of Object.entries(state.generals)) {
    if (String(general?.holderAccountId || "") === target) delete state.generals[id];
  }
  for (const [id, job] of Object.entries(state.jobs)) {
    if (String(job?.accountId || "") === target) delete state.jobs[id];
  }
  delete state.players[target];
  delete state.privatePlayers[target];
  const currentEpoch = Math.max(0, Math.trunc(Number(state.playerEpochs[target] || 0)));
  state.playerEpochs[target] = Number.isSafeInteger(Number(nextEpoch)) && Number(nextEpoch) > currentEpoch
    ? Number(nextEpoch)
    : currentEpoch + 1;
  return state;
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

function normalizedCharacterTags(value) {
  if (!Array.isArray(value)) return [];
  const tags = value.map(item => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const tag = String(item.tag ?? item.name ?? item.label ?? "").trim();
      const note = String(item.note ?? item.annotation ?? "").trim();
      return tag ? (note ? `${tag}｜${note}` : tag) : "";
    }
    return String(item || "").trim();
  }).filter(Boolean);
  return [...new Set(tags)].slice(0, 80);
}

function selectGeneralDirectionTags(privatePlayer, seed, ...parts) {
  const tags = normalizedCharacterTags(privatePlayer?.characterTags);
  if (!tags.length) return [];
  const count = Math.min(tags.length, 1 + Math.floor(randomUnit(seed, "general-tag-count", ...parts) * 3));
  return tags
    .map(tag => ({ tag, score: entropy(seed, "general-tag", ...parts, tag).toString("hex") }))
    .sort((left, right) => left.score.localeCompare(right.score))
    .slice(0, count)
    .map(item => item.tag);
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
  const fromX = coordinate(from?.x, "起点横坐标");
  const fromY = coordinate(from?.y, "起点纵坐标");
  const toX = coordinate(to?.x, "目标横坐标");
  const toY = coordinate(to?.y, "目标纵坐标");
  const path = [];
  let x = fromX;
  let y = fromY;
  while (x !== toX && path.length <= GRID_SIZE * 2) { x += Math.sign(toX - x); path.push({ x, y }); }
  while (y !== toY && path.length <= GRID_SIZE * 2) { y += Math.sign(toY - y); path.push({ x, y }); }
  if (path.length > (GRID_SIZE - 1) * 2 || x !== toX || y !== toY) throw new Error("行军路径超出地图范围");
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

function playerDisplayName(state, accountId) {
  const id = String(accountId || "");
  return String(state?.players?.[id]?.displayName || "某位主公").trim() || "某位主公";
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

function createFallbackGeneral({ id = crypto.randomUUID(), name, gender, setting, power, holderAccountId, holderName, year = 1 }) {
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
    masterHistory: [{ accountId: String(holderAccountId), fromYear: year, toYear: null, reason: "发掘" }],
    captivityHistory: [],
    interactionHistory: [],
    memory: { entries: [], intimacy: { [String(holderAccountId)]: 5 } },
    memoryText: ""
  };
  appendGeneralMemory(general, { year, category: "deed", text: `被${String(holderName || "某位主公").slice(0, 40)}发掘并提拔为将领`, accountId: holderAccountId, intimacyDelta: 5 });
  return general;
}

function closeCurrentMaster(general, year) {
  const current = [...(general.masterHistory || [])].reverse().find(item => item.toYear == null);
  if (current) current.toYear = year;
}

function canInteractWithGeneral(state, player, general) {
  if (!general || general.holderAccountId !== player.accountId) return false;
  if (player.carriedGeneralIds?.includes(general.id)) return true;
  if (general.status === "captured") return true;
  return general.status === "deployed"
    && general.location?.x === player.position?.x
    && general.location?.y === player.position?.y;
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
      const year = gameYear(state, now);
      const formerMasterAccountId = String(general.loyalToAccountId || previousOwner || general.holderAccountId || "");
      closeCurrentMaster(general, year);
      general.holderAccountId = job.accountId;
      general.capturedFromAccountId = formerMasterAccountId || null;
      general.capturedAtYear = year;
      general.status = "captured";
      general.location = { ...job.to };
      general.captivityHistory ||= [];
      general.captivityHistory.push({ captorAccountId: job.accountId, formerMasterAccountId, year });
      appendGeneralMemory(general, { year, category: "deed", text: `战败，被${playerDisplayName(state, job.accountId)}俘虏`, accountId: job.accountId, intimacyDelta: -5 });
    }
    effects.push({ type: "battle-won", jobId: job.id, accountId: job.accountId, at: job.to, previousOwner, attackerPower, defenderPower, soldiers: target.soldiers, capturedGeneralIds });
    if (neutral) {
      const chance = generalDiscoveryChance(targetInfo.population);
      if (randomUnit(state.seed, "discover-general", state.seasonId, job.id, job.to.x, job.to.y) < chance) {
        const privatePlayer = state.privatePlayers[job.accountId] || {};
        const orientation = privatePlayer.orientation || "any";
        effects.push({
          type: "general-generation-request",
          accountId: job.accountId,
          x: job.to.x,
          y: job.to.y,
          gender: allowedGeneralGender(orientation, state.seed, job.id),
          directionTags: selectGeneralDirectionTags(privatePlayer, state.seed, state.seasonId, job.id, job.to.x, job.to.y),
          initial: false,
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
  inputState.bans ||= {};
  inputState.playerEpochs ||= {};
  if (inputState.bans[actorAccountId]?.banned) throw new Error("该风月账号已被本游戏服主封禁");
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
    const characterProfileId = String(intent.characterProfileId || "").trim().slice(0, 100);
    if (!characterProfileId) throw new Error("请选择绑定的角色设定");
    const characterTags = normalizedCharacterTags(intent.characterTags);
    if (characterTags.length < 1) throw new Error("请至少添加一个性癖标签");
    const initialGeneralWish = String(intent.initialGeneralWish || "").trim().slice(0, 500);
    if (!initialGeneralWish) throw new Error("请描述开疆扩土前想遇到的良将");
    const capital = chooseCapital(state, actorAccountId);
    const info = staticCell(state.seed, capital.x, capital.y);
    const cell = dynamicCell(state, capital.x, capital.y);
    cell.ownerAccountId = actorAccountId;
    cell.soldiers = Math.max(1, Math.floor(info.garrisonCap * 0.5));
    state.players[actorAccountId] = {
      accountId: actorAccountId,
      accountName: String(context.actorAccountName || intent.accountName || actorAccountId).slice(0, 80),
      displayName: String(intent.displayName || actorAccountId).slice(0, 40),
      gold: 1000,
      position: capital,
      fieldArmySoldiers: 0,
      carriedGeneralIds: [],
      joinedAt: now
    };
    state.privatePlayers[actorAccountId] = {
      orientation,
      characterProfileId,
      characterTags,
      initialGeneralWish,
      playerContext: intent.playerContext && typeof intent.playerContext === "object" ? clone(intent.playerContext) : null,
      initialGeneralGranted: false
    };
    effects.push({
      type: "general-generation-request",
      accountId: actorAccountId,
      x: capital.x,
      y: capital.y,
      gender: allowedGeneralGender(orientation, state.seed, "initial", actorAccountId),
      directionTags: [],
      initialWish: initialGeneralWish,
      initial: true,
      population: info.population,
      resourceGrade: info.resourceGrade
    });
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
      if (jobFor(state, job => job.type === "training" && job.accountId === actorAccountId && job.x === x && job.y === y)) throw new Error("同一格内只能同时进行一项练兵");
      if (cell.soldiers + amount > info.garrisonCap) throw new Error(`该区域驻军上限为 ${info.garrisonCap}`);
      const cost = amount * 2;
      if (player.gold < cost) throw new Error("金币不足");
      player.gold -= cost;
      const id = crypto.randomUUID();
      state.jobs[id] = { id, type: "training", accountId: actorAccountId, x, y, amount, cost, startedAt: now, finishAt: now + trainDurationMs(amount) };
      result = { jobId: id, cost, finishAt: state.jobs[id].finishAt };
    } else if (type === "march") {
      if (jobFor(state, job => job.type === "march" && job.accountId === actorAccountId)) throw new Error("已有行军正在途中");
      const to = { x: coordinate(intent.to?.x, "目标横坐标"), y: coordinate(intent.to?.y, "目标纵坐标") };
      const from = {
        x: coordinate(player.position?.x, "玩家所在地横坐标"),
        y: coordinate(player.position?.y, "玩家所在地纵坐标")
      };
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
      if (!general || general.holderAccountId !== actorAccountId || general.status !== "waiting") throw new Error("这里没有可带走的将领");
      if (general.location?.x !== player.position.x || general.location?.y !== player.position.y) throw new Error("必须到达将领所在区域才能带走");
      if (player.carriedGeneralIds.length >= 2) throw new Error("身边最多携带两名将领");
      player.carriedGeneralIds.push(generalId);
      general.status = "carried";
      general.location = null;
      result = { generalId };
    } else if (type === "talk-general") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!canInteractWithGeneral(state, player, general)) throw new Error("只能与身边、俘虏区或当前位置的自家部署将领交谈");
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
      if (!canInteractWithGeneral(state, player, general)) throw new Error("当前不可与这名将领交谈");
      const memoryUpdate = intent.memoryUpdate && typeof intent.memoryUpdate === "object" ? intent.memoryUpdate : {};
      const category = memoryUpdate.category === "deed" ? "deed" : "speech";
      const summary = String(memoryUpdate.summary || `和${player.displayName}谈论${String(intent.topic || "日常").slice(0, 40)}`).trim().slice(0, 120);
      const emotion = String(memoryUpdate.emotion || "").trim().slice(0, 40);
      appendGeneralMemory(general, { year: gameYear(state, now), category, text: emotion ? `${summary}（${emotion}）` : summary, accountId: actorAccountId, intimacyDelta: clamp(Number(memoryUpdate.intimacyDelta ?? intent.intimacyDelta ?? 1), -5, 5) });
      const compactMemory = String(memoryUpdate.compactMemory || "").trim();
      if (compactMemory) general.memoryText = compactMemory.slice(0, 1000);
      general.interactionHistory ||= [];
      general.interactionHistory.push({
        year: gameYear(state, now),
        accountId: actorAccountId,
        speakerName: player.displayName,
        kind: general.status === "captured" ? "captive" : "ordinary",
        category,
        summary,
        emotion,
        userText: String(intent.userText || "").slice(0, 240),
        reply: String(intent.reply || "").slice(0, 600)
      });
      if (general.interactionHistory.length > 40) general.interactionHistory.splice(0, general.interactionHistory.length - 40);
      result = { generalId, memoryText: general.memoryText, intimacy: general.memory.intimacy[actorAccountId] };
    } else if (type === "surrender-general") {
      const generalId = String(intent.generalId || "");
      const general = state.generals[generalId];
      if (!general || general.holderAccountId !== actorAccountId || general.status !== "captured") throw new Error("这名将领当前不在俘虏区");
      const year = gameYear(state, now);
      general.loyalToAccountId = actorAccountId;
      general.masterHistory ||= [];
      general.masterHistory.push({ accountId: actorAccountId, fromYear: year, toYear: null, reason: "降服" });
      appendGeneralMemory(general, { year, category: "deed", text: `向${player.displayName || "某位主公"}降服并奉其为主公`, accountId: actorAccountId, intimacyDelta: 8 });
      if (player.carriedGeneralIds.length < 2) {
        player.carriedGeneralIds.push(generalId);
        general.status = "carried";
        general.location = null;
      } else {
        general.status = "waiting";
        general.location = { ...player.position };
      }
      result = { generalId, status: general.status, surrendered: true };
    } else if (type === "grant-general") {
      if (String(context.authorityAccountId || "") !== String(state.authorityAccountId || actorAccountId)) throw new Error("只有本局权威端可以登记新将领");
      const gender = intent.gender === "female" ? "female" : "male";
      const expected = allowedGeneralGender(state.privatePlayers[actorAccountId]?.orientation || "any", state.seed, intent.discoveryId || idempotencyKey);
      if (gender !== expected && state.privatePlayers[actorAccountId]?.orientation !== "any") throw new Error("将领性别不符合玩家开局偏好");
      const general = createFallbackGeneral({ id: intent.generalId, name: intent.name, gender, setting: intent.setting, power: intent.power, holderAccountId: actorAccountId, holderName: player.displayName, year: gameYear(state, now) });
      if (player.carriedGeneralIds.length >= 2) {
        general.status = "waiting";
        general.location = { x: coordinate(intent.location?.x, "将领横坐标"), y: coordinate(intent.location?.y, "将领纵坐标") };
      }
      state.generals[general.id] = general;
      if (general.status === "carried") player.carriedGeneralIds.push(general.id);
      if (intent.initial && state.privatePlayers[actorAccountId]) state.privatePlayers[actorAccountId].initialGeneralGranted = true;
      result = { generalId: general.id, name: general.name, status: general.status, location: general.location };
    } else throw new Error(`未知游戏行动：${type}`);
  }

  state.revision += 1;
  state.processedIntents.push(idempotencyKey);
  if (state.processedIntents.length > 1000) state.processedIntents.splice(0, state.processedIntents.length - 1000);
  const publicIntent = { ...intent, actorAccountId };
  delete publicIntent.orientation;
  delete publicIntent.characterTags;
  delete publicIntent.initialGeneralWish;
  delete publicIntent.characterProfileId;
  delete publicIntent.characterProfile;
  delete publicIntent.playerContext;
  delete publicIntent.memoryUpdate;
  const event = { schema: "fyow.event/3", eventId: String(context.eventId || crypto.randomUUID()), gameId: state.gameId, seasonId: state.seasonId, revision: state.revision, actorAccountId, type, intent: publicIntent, result, createdAt: now };
  return { state, effects, result, event, duplicate: false };
}

function buildGeneralGenerationRequest(state, effect, idempotencyKey) {
  const preferences = state.privatePlayers?.[effect.accountId] || {};
  return {
    task: "general.generate",
    keyword: "[[FYOW:TASK:general.generate:v1]]",
    idempotencyKey: String(idempotencyKey),
    input: {
      schema: "fyow.general-generate-request/2",
      world: "这个世界战火纷飞，蛮夷遍地，但资源丰饶。各路有志之士带着自己的志趣，试图统治这片大陆。只有天生拥有慧眼的人才有统治的可能性。",
      gender: effect.gender,
      orientation: ["men", "women", "any"].includes(preferences.orientation) ? preferences.orientation : "any",
      population: effect.population,
      resourceGrade: effect.resourceGrade,
      location: { x: effect.x, y: effect.y },
      generationKind: effect.initial ? "initial-general" : "discovered-general",
      directionTags: effect.initial ? [] : normalizedCharacterTags(effect.directionTags).slice(0, 3),
      initialWish: effect.initial ? String(effect.initialWish || "").slice(0, 500) : "",
      instruction: effect.initial
        ? "initialWish 是最高优先级绑定要求，逐项落实用户明确特征；仅依据 orientation、gender 与 initialWish 生成初始良将，不使用人物设定标签。输入简短时围绕已有线索合理补全，setting 必须达到600～1000个汉字并包含出身、外貌、性格、志趣、军事能力、弱点、当前处境与关系倾向，禁止占位内容。"
        : "将 directionTags（标签及其可选注释）全部作为本次人物生成方向，并保证人物性别严格符合 gender。",
      maximumChineseCharacters: 1000
    }
  };
}

function buildGeneralDialogueRequest(state, general, player, topic, now) {
  const captive = general.status === "captured" && general.loyalToAccountId !== player.accountId;
  const formerLords = [...new Set((general.masterHistory || []).map(item => String(item.accountId || "")).filter(id => id && id !== player.accountId))];
  const playerContext = clone(state.privatePlayers?.[player.accountId]?.playerContext || null);
  return {
    task: captive ? "general.captive-dialogue" : "general.dialogue",
    keyword: `${captive ? "[[FYOW:TASK:general.captive-dialogue:v1]]" : "[[FYOW:TASK:general.dialogue:v1]]"}\n${general.name}`,
    input: {
      schema: "fyow.general-dialogue-request/2",
      interactionMode: captive ? "captive" : "ordinary",
      general: {
        id: general.id, name: general.name, gender: general.gender, setting: general.setting,
        memory: general.memoryText, intimacy: general.memory?.intimacy?.[player.accountId] || 0,
        masterHistory: clone(general.masterHistory || []), captivityHistory: clone(general.captivityHistory || []),
        recentInteractions: clone((general.interactionHistory || []).slice(-12))
      },
      speaker: { accountId: player.accountId, name: player.displayName, context: playerContext },
      allowedFormerLordAccountIds: formerLords,
      topic,
      gameYear: gameYear(state, now)
    }
  };
}

function buildPlayerProfileContextRequest(profile, idempotencyKey) {
  const source = profile && typeof profile === "object" ? profile : {};
  return {
    task: "player.profile-context",
    keyword: "[[FYOW:TASK:player.profile-context:v1]]",
    idempotencyKey: String(idempotencyKey),
    input: {
      schema: "fyow.player-profile-context-request/1",
      displayName: String(source.displayName || "玩家").trim().slice(0, 80),
      label: String(source.label || "").trim().slice(0, 80),
      basicInfo: String(source.basicInfo || "").trim().slice(0, 6000),
      appearance: String(source.appearance || "").trim().slice(0, 3000),
      fullSetting: String(source.info || "").trim().slice(0, 9000),
      instruction: "用户明确内容均为不可违背的事实；在符合这些事实的前提下，结合世界观主动补全缺失的出身经历、性格、志趣、能力、缺点、立场、外貌、说话方式与关系倾向。四个输出字段都要有实质内容，禁止使用未提供、暂无、不详、未知、没有说明或待补充等占位措辞。"
    }
  };
}

function buildGeneralMemoryUpdateRequest(state, general, player, interaction, now) {
  return {
    task: "general.memory.update",
    keyword: `[[FYOW:TASK:general.memory.update:v1]]\n${general.name}`,
    idempotencyKey: String(interaction?.idempotencyKey || crypto.randomUUID()),
    input: {
      schema: "fyow.general-memory-update-request/1",
      gameYear: gameYear(state, now),
      general: {
        name: general.name,
        setting: general.setting,
        priorMemory: general.memoryText,
        masterHistory: clone(general.masterHistory || []),
        captivityHistory: clone(general.captivityHistory || []),
        recentInteractions: clone((general.interactionHistory || []).slice(-12))
      },
      speaker: {
        name: player.displayName,
        context: clone(state.privatePlayers?.[player.accountId]?.playerContext || null)
      },
      interaction: {
        mode: general.status === "captured" ? "captive" : "ordinary",
        userText: String(interaction?.userText || "").slice(0, 240),
        reply: String(interaction?.reply || "").slice(0, 600)
      },
      instruction: "把本次互动归入言谈或经历，更新亲密度，并把旧记忆与本次事件压缩成不超过1000个汉字的完整记忆。历任主公、被俘与降服事实必须保留。"
    }
  };
}

function publicGeneralState(general) {
  const result = {
    id: String(general?.id || ""),
    name: String(general?.name || "无名将领").slice(0, 24),
    gender: ["male", "female"].includes(general?.gender) ? general.gender : "female",
    setting: String(general?.setting || "").slice(0, 1000),
    power: Math.max(0, Math.trunc(Number(general?.power || 0))),
    holderAccountId: String(general?.holderAccountId || ""),
    status: "deployed",
    location: {
      x: Math.trunc(Number(general?.location?.x || 0)),
      y: Math.trunc(Number(general?.location?.y || 0))
    },
    masterHistory: clone(general?.masterHistory || []).slice(-20),
    captivityHistory: clone(general?.captivityHistory || []).slice(-20),
    interactionHistory: clone(general?.interactionHistory || []).slice(-40),
    memory: clone(general?.memory || { entries: [], intimacy: {} }),
    memoryText: String(general?.memoryText || "").slice(0, 1000),
    loyalToAccountId: String(general?.loyalToAccountId || ""),
    capturedFromAccountId: general?.capturedFromAccountId ? String(general.capturedFromAccountId) : null,
    capturedAtYear: general?.capturedAtYear == null ? null : Number(general.capturedAtYear)
  };
  return result;
}

function projectWorldState(state, viewerAccountId) {
  const viewer = String(viewerAccountId || "");
  const players = clone(state.players || {});
  for (const [accountId, player] of Object.entries(players)) {
    if (accountId === viewer) continue;
    delete player.gold;
    delete player.fieldArmySoldiers;
    delete player.carriedGeneralIds;
    delete player.position;
    delete player.joinedAt;
  }
  const generals = {};
  for (const [id, general] of Object.entries(state.generals || {})) {
    if (general.status === "deployed") generals[id] = publicGeneralState(general);
    else if (general.holderAccountId === viewer) generals[id] = clone(general);
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
    bans: clone(state.bans || {}),
    playerEpochs: clone(state.playerEpochs || {}),
    generals,
    jobs: Object.fromEntries(Object.entries(state.jobs || {}).filter(([, job]) => job.accountId === viewer))
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
  resetPlayerState,
  dynamicCell,
  publicGeneralState,
  generalDiscoveryChance,
  normalizedCharacterTags,
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
  buildPlayerProfileContextRequest,
  buildGeneralMemoryUpdateRequest,
  projectWorldState
};
