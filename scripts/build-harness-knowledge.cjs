"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { manifest } = require("../electron/harness-knowledge.cjs");
const root = path.join(__dirname, "..");
const records = manifest.map(([id, file, status]) => {
  const content = fs.readFileSync(path.join(root, file), "utf8");
  return { id, file, status, content, sha256: crypto.createHash("sha256").update(content).digest("hex") };
});
fs.mkdirSync(path.join(root, "electron/knowledge"), { recursive: true });
fs.writeFileSync(path.join(root, "electron/knowledge/index.json"), JSON.stringify(records));
console.log(`Bundled ${records.length} versioned knowledge sources`);
