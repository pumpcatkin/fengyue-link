#!/usr/bin/env node

/* Exercise the production casualty function across representative and extreme inputs. */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { battleCasualties } = require("../electron/grid-world-game.cjs");

function sideResult(input) {
  const result = battleCasualties(
    input.attackerPower,
    input.defenderPower,
    input.attackerSoldiers,
    input.defenderSoldiers
  );
  const winner = result.attackerWon ? "进攻方" : "防守方";
  return {
    ...input,
    winner,
    attackerWon: result.attackerWon,
    winnerPower: result.attackerWon ? input.attackerPower : input.defenderPower,
    loserPower: result.attackerWon ? input.defenderPower : input.attackerPower,
    winnerSoldiers: result.attackerWon ? input.attackerSoldiers : input.defenderSoldiers,
    loserSoldiers: result.attackerWon ? input.defenderSoldiers : input.attackerSoldiers,
    winnerLosses: result.attackerWon ? result.attackerLosses : result.defenderLosses,
    loserLosses: result.attackerWon ? result.defenderLosses : result.attackerLosses,
    attackerLosses: result.attackerLosses,
    defenderLosses: result.defenderLosses,
    attackerSurvivors: result.attackerSurvivors,
    defenderSurvivors: result.defenderSurvivors
  };
}

const standardCases = [
  ["完全相等（平局由防守方胜）", 1000, 1000],
  ["极小优势", 1001, 1000],
  ["小幅优势", 1100, 1000],
  ["中等优势", 1500, 1000],
  ["两倍战力", 2000, 1000],
  ["五倍战力", 5000, 1000],
  ["十倍战力", 10000, 1000],
  ["极端千倍战力", 1000000, 1000]
].map(([label, attackerPower, defenderPower]) => sideResult({
  label,
  attackerPower,
  defenderPower,
  attackerSoldiers: 100000,
  defenderSoldiers: 100000
}));

const edgeCases = [
  sideResult({ label: "进攻方战败", attackerPower: 1000, defenderPower: 1500, attackerSoldiers: 100000, defenderSoldiers: 100000 }),
  sideResult({ label: "胜方仅有 25 名士兵", attackerPower: 5000, defenderPower: 1000, attackerSoldiers: 25, defenderSoldiers: 100000 }),
  sideResult({ label: "败方仅有 10 名士兵", attackerPower: 1000, defenderPower: 5000, attackerSoldiers: 10, defenderSoldiers: 100000 }),
  sideResult({ label: "双方零士兵、战力来自将领", attackerPower: 5000, defenderPower: 1000, attackerSoldiers: 0, defenderSoldiers: 0 }),
  sideResult({ label: "零值输入归一化", attackerPower: 0, defenderPower: 0, attackerSoldiers: 0, defenderSoldiers: 0 })
];

function verify(cases) {
  assert.equal(standardCases[0].attackerWon, false, "战力相同时应由防守方取胜");
  const advantageLosses = standardCases.slice(1).map((item) => item.winnerLosses);
  for (let index = 1; index < advantageLosses.length; index += 1) {
    assert.ok(advantageLosses[index] <= advantageLosses[index - 1], "战力优势扩大时胜方伤亡不应上升");
  }
  for (const item of cases) {
    assert.ok(item.winnerLosses >= 0 && item.loserLosses >= 0, `${item.label}: 伤亡不得为负数`);
    assert.ok(item.winnerLosses <= item.winnerSoldiers, `${item.label}: 胜方伤亡不得超过士兵数`);
    assert.ok(item.loserLosses <= item.loserSoldiers, `${item.label}: 败方伤亡不得超过士兵数`);
    assert.ok(item.winnerLosses <= Math.floor(item.winnerPower * 0.9), `${item.label}: 胜方伤亡不得超过胜方战力的 90%`);
    assert.ok(item.loserLosses <= Math.floor(Math.max(1, item.loserPower) * 0.8), `${item.label}: 败方伤亡不得超过败方战力的 80%`);
  }
}

function ratio(value, base) {
  if (base <= 0) return "0.00%";
  return `${(value / base * 100).toFixed(2)}%`;
}

function caseRows(cases) {
  return cases.map((item) => `| ${item.label} | ${item.attackerPower} | ${item.defenderPower} | ${item.winner} | ${item.winnerLosses} | ${ratio(item.winnerLosses, item.loserPower)} | ${item.loserLosses} | ${item.attackerSurvivors}/${item.defenderSurvivors} |`);
}

function buildReport() {
  const allCases = [...standardCases, ...edgeCases];
  verify(allCases);
  return [
    "# 猎艳疆土战斗伤亡模拟",
    "",
    "本报告由 `scripts/simulate-grid-casualties.cjs` 直接调用生产函数 `battleCasualties` 生成。模拟只检查士兵伤亡；将领战力会参与胜负与公式，但将领本身不伤亡。",
    "",
    "## 当前公式",
    "",
    "- 败方伤亡：`min(败方士兵数, floor(败方战力 * 0.8))`。",
    "- 胜方伤亡：`min(胜方士兵数, floor(0.9 * 败方战力^2 / 胜方战力), floor(胜方战力 * 0.9))`。",
    "- 进攻方战力必须严格大于防守方才算胜利；相等时防守方胜。",
    "",
    "## 标准战力差",
    "",
    "标准组固定双方各 100000 名士兵、败方战力 1000，用来避免士兵数量过早截断公式。",
    "",
    "| 情况 | 进攻战力 | 防守战力 | 胜方 | 胜方伤亡 | 胜方伤亡/败方战力 | 败方伤亡 | 进攻/防守幸存 |",
    "| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |",
    ...caseRows(standardCases),
    "",
    "## 极端与截断情况",
    "",
    "| 情况 | 进攻战力 | 防守战力 | 胜方 | 胜方伤亡 | 胜方伤亡/败方战力 | 败方伤亡 | 进攻/防守幸存 |",
    "| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |",
    ...caseRows(edgeCases),
    "",
    "## 判定",
    "",
    "- **符合战力差方向要求**：在败方战力固定时，胜方战力从接近持平增至千倍，胜方伤亡单调下降。",
    "- **符合伤亡封顶要求**：胜方伤亡同时受实际士兵数与胜方战力 90% 两个上限约束；败方伤亡受实际士兵数约束。",
    "- **将领不会被误扣**：士兵数为 0 时，即使双方仍有将领战力，士兵伤亡仍为 0。",
    "- **离散取整边界**：战力极端悬殊时，公式向下取整可能使胜方伤亡为 0；这是当前整数兵力模型的预期表现。",
    "",
    "## 复现",
    "",
    "```powershell",
    "node scripts/simulate-grid-casualties.cjs",
    "```",
    ""
  ].join("\n");
}

const report = buildReport();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ standardCases, edgeCases }, null, 2));
} else {
  const outputPath = path.resolve(__dirname, "..", "docs", "grid-casualty-simulation.md");
  fs.writeFileSync(outputPath, report, "utf8");
  console.log(`wrote ${path.relative(process.cwd(), outputPath)} (${standardCases.length + edgeCases.length} cases)`);
}
