"use strict";
const channel = require("../package.json").fengyueReleaseChannel || "official";
if (channel === "test") require("./create-test-runtime-proof.cjs");
else if (channel === "official") require("./create-runtime-proof.cjs");
else throw new Error(`Unknown release channel: ${channel}`);
