"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  builtInGridProgram,
  createBundledGridCard,
  createExportedGameCard,
  cardDigest,
  rebindGameCard,
  validateGameCard
} = require("../electron/online-world-card.cjs");

const root = path.resolve(__dirname, "..", "game-cards");
const program = builtInGridProgram();
const template = createBundledGridCard();
const files = fs.readdirSync(root)
  .filter(name => name.toLowerCase().endsWith(".json"))
  .sort((left, right) => left.localeCompare(right, "zh-CN"));

for (const name of files) {
  const file = path.join(root, name);
  const current = validateGameCard(JSON.parse(fs.readFileSync(file, "utf8")));
  const rebound = rebindGameCard(template, current.companion.workId, current.companion.origin);
  const configuration = JSON.parse(JSON.stringify(current.companion.configuration));
  for (const alias of ["desc", "descr", "dsc", "intro", "description"]) delete configuration[alias];
  configuration.app = {
    ...configuration.app,
    id: current.companion.workId,
    name: current.companion.name,
    description: program.envelope
  };
  const namedCard = { ...rebound, title: current.title };
  namedCard.packageSha256 = cardDigest(namedCard);
  const refreshed = createExportedGameCard(namedCard, configuration);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
  process.stdout.write(`${name}\tversion=${refreshed.version}\twork=${refreshed.companion.workId}\tdigest=${refreshed.program.digest}\n`);
}
