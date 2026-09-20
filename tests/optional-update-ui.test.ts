import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../electron/desktop/index.html", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../electron/desktop/renderer.js", import.meta.url), "utf8");
const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");

describe("optional desktop updates", () => {
  it("keeps GitHub version status and its action available in settings", () => {
    expect(html).toContain('class="settings-group settings-update-group"');
    expect(html).toContain('id="settings-update-version"');
    expect(html).toContain('id="settings-update-status"');
    expect(html).toContain('id="settings-update-action" type="button">检查最新版本</button>');
    expect(renderer).toContain('document.querySelector("#settings-update-version")');
    expect(renderer).toContain('document.querySelector("#settings-update-status")');
    expect(renderer).toContain('document.querySelector("#settings-update-action")');
    expect(renderer).toContain("renderUpdateSettings(security,update)");
    expect(renderer).toContain('? "一键更新"');
  });

  it("routes checking separately from the player's explicit update request", () => {
    expect(preload).toContain('checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates")');
    expect(preload).toContain('requestAppUpdate: () => ipcRenderer.invoke("app:request-update")');
    expect(main).toContain('handleLocalIpc("app:check-for-updates", () => updateService.checkNow())');
    expect(main).toContain('handleLocalIpc("app:request-update", () => updateService.requestUpdate())');
    expect(renderer).toContain('const update=["available","ready"].includes(currentStatus)');
    expect(renderer).toContain("? await api.requestAppUpdate()");
    expect(renderer).toContain(": await api.checkForUpdates()");
  });

  it("lets the player dismiss an available update without quitting", () => {
    expect(renderer).toContain('officialNoticeAction.textContent=securityBlocked?"退出工具":available?"暂不更新"');
    expect(renderer).toContain('if(officialNoticeCard.dataset.mode==="blocked"){void api.quitApp();return}');
    expect(renderer).toContain("releaseNoticeDismissed=true");
    expect(renderer).toContain('officialNoticeOverlay.classList.add("hidden")');
  });
});
