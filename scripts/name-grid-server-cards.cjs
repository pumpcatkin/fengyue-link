"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateGameCard, cardDigest, GRID_CARD_ID } = require("../electron/online-world-card.cjs");
const { atomicWriteJsonSync } = require("../electron/runtime-utils.cjs");

// These are provisioned work identities, not directory or gallery positions.
const serverSlots = new Map([
  ["faeaacf3-8c3a-4338-b2a2-8b704633ebf1", 1],
  ["23864aac-f916-4214-b051-40ae82b962ca", 2],
  ["67588ef2-2d5d-4a7c-8935-08f8d1cde083", 3],
  ["26ac5c7e-b504-41f6-b956-047a422d846b", 4],
  ["6cc9974b-39d0-4cee-b041-20f4f78e5dc6", 5]
]);

function nameServerCard(value, exportedAt = new Date().toISOString()) {
  const slot = value?.cardId === GRID_CARD_ID ? serverSlots.get(value?.companion?.workId) : null;
  if (!slot) return value;
  const current = validateGameCard(value);
  const title = `猎艳疆土(${slot}服)`;
  if (current.title === title) return value;
  const renamed = { ...current, title, exportedAt };
  renamed.packageSha256 = cardDigest(renamed);
  return validateGameCard(renamed);
}

function updateFile(file, exportedAt) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  let changed = false;
  const rename = card => {
    const renamed = nameServerCard(card, exportedAt);
    if (renamed !== card) {
      changed = true;
      console.log(`${file}: ${renamed.title} -> ${renamed.companion.workId}`);
    }
    return renamed;
  };
  const next = value.schema === "fyow.game-card-library/1" && Array.isArray(value.cards)
    ? { ...value, cards: value.cards.map(rename) }
    : rename(value);
  if (changed) atomicWriteJsonSync(fs, file, next, { pretty: true });
}

if (require.main === module) {
  const exportedAt = new Date().toISOString();
  for (const requested of process.argv.slice(2)) {
    const target = path.resolve(requested);
    if (fs.statSync(target).isDirectory()) {
      for (const name of fs.readdirSync(target).filter(name => name.endsWith(".json"))) {
        updateFile(path.join(target, name), exportedAt);
      }
    } else updateFile(target, exportedAt);
  }
}

module.exports = { nameServerCard };
