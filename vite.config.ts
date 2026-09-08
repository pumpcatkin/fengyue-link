import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export const userscriptMetadata = `// ==UserScript==
// @name         风月联机工具
// @namespace    https://aiero.cc/fengyue-link
// @version      ${version}
// @description  以 AI 风月私信作为唯一传输层的多人回合联机工具
// @match        https://staging.aiero.cc/*
// @match        https://acepro.store/*
// @match        https://acquainte.xyz/*
// @match        https://acquant.xyz/*
// @match        https://affectional.xyz/*
// @match        https://aiwhatis.xyz/*
// @match        https://ai-xan.xyz/*
// @match        https://aquantancee.xyz/*
// @match        https://aquante.xyz/*
// @grant        GM_xmlhttpRequest
// @connect      aify.pages.dev
// @connect      *
// @run-at       document-idle
// ==/UserScript==`;

export default defineConfig({
  plugins: [{
    name: "userscript-metadata",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk" && item.fileName.endsWith(".user.js")) item.code = `${userscriptMetadata}\n${item.code}`;
      }
    }
  }],
  build: {
    lib: {
      entry: "src/main.ts",
      name: "FengyueLink",
      formats: ["iife"],
      fileName: () => "fengyue-link.user.js"
    },
    minify: false,
    sourcemap: true,
    rollupOptions: {}
  }
});
