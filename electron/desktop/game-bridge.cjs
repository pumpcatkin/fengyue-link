"use strict";
const FyowBridge = {
  minimumSaveInterval: 100,
  validRequestId(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "")); }
};
if (typeof module !== "undefined") module.exports = FyowBridge;
else globalThis.FyowBridge = FyowBridge;
