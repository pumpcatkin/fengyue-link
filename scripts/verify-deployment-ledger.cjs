"use strict";

const fs = require("node:fs");
const assert = require("node:assert/strict");
const { OnlineWorldService } = require("../electron/online-world-service.cjs");
const { canonicalJson } = require("../electron/online-world-protocol.cjs");
const { applyIntent, settleWorld } = require("../electron/grid-world-game.cjs");

async function main() {
  const [file, accountId] = process.argv.slice(2);
  if (!file || !accountId) throw new Error("Usage: node scripts/verify-deployment-ledger.cjs LEDGER_JSON ACCOUNT_ID");
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  const originalRecords = canonicalJson(ledger.records);
  const failures = [];
  const makeReader = () => {
    const reader = new OnlineWorldService({
      getAccount: () => ({ accountId }), cacheFile: null, onChange: () => {},
      requestConsole: async () => { throw new Error("Offline verification prohibits network access"); },
      onDiagnostic: detail => { if (detail.event === "map-delta-rejected") failures.push(detail.mapDeltaId); }
    });
    reader.work = ledger.work;
    reader.readHistory = async () => ({ assembled: { records: ledger.records } });
    reader.probeMigrationReset = async () => null;
    reader.readWorldChatHistory = async () => ({ assembled: { records: [] } });
    reader.receiveDirectWakes = async () => [];
    reader.settleLocalClock = async () => {
      reader.world = settleWorld(reader.world, Date.now()).state;
      return [];
    };
    return reader;
  };
  let reader = makeReader();
  const summaries = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await reader.sync(true);
    const generals = Object.values(reader.world.generals).filter(general => general.holderAccountId === accountId);
    const rows = [];
    for (const general of generals) {
      const cell = general.location && reader.world.cells[`${general.location.x},${general.location.y}`];
      if (general.status === "deployed") {
        assert.equal(cell?.ownerAccountId, accountId, `${general.name}: wrong cell owner`);
        assert.ok(cell.generalIds.includes(general.id), `${general.name}: missing from cell`);
        const atGeneral = structuredClone(reader.world);
        atGeneral.players[accountId].position = structuredClone(general.location);
        atGeneral.privatePlayers[accountId] ||= {};
        atGeneral.privatePlayers[accountId].lastDialogueAtByGeneral = {};
        applyIntent(atGeneral, { type: "talk-general", generalId: general.id, topic: "location-check" }, { actorAccountId: accountId, now: Date.now() });
        const recalled = applyIntent(atGeneral, { type: "recall-general", generalId: general.id }, { actorAccountId: accountId, now: Date.now() });
        assert.equal(recalled.state.generals[general.id].status, "carried");
      }
      if (general.status === "carried") assert.ok(reader.world.players[accountId].carriedGeneralIds.includes(general.id));
      rows.push({ id: general.id, name: general.name, status: general.status, location: general.location,
        historyEntries: general.interactionHistory?.length || 0 });
    }
    summaries.push(rows);
    const next = makeReader();
    next.world = structuredClone(reader.world);
    next.localGeneralArchiveOrders = structuredClone(reader.localGeneralArchiveOrders);
    reader = next;
  }
  assert.deepEqual(summaries[0], summaries[1]);
  assert.deepEqual(summaries[1], summaries[2]);
  assert.equal(canonicalJson(ledger.records), originalRecords, "Signed ledger records must remain immutable");
  console.log(JSON.stringify({ verified: true, passes: summaries.length, generals: summaries[0], rejectedMapDeltaIds: [...new Set(failures)] }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
