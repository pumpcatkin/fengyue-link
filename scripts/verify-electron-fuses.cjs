const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
const { FuseState } = require("@electron/fuses/dist/constants");

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || null;
}

const projectRoot = path.resolve(__dirname, "..");
const executable = path.resolve(argument("executable") || path.join(projectRoot, "release", "win-unpacked", "风月联机工具.exe"));

(async () => {
  assert.ok(fs.existsSync(executable), `找不到待检查的安装版主程序：${executable}`);
  const fuses = await getCurrentFuseWire(executable);
  const enabled = key => fuses[FuseV1Options[key]] === FuseState.ENABLE;
  const disabled = key => fuses[FuseV1Options[key]] === FuseState.DISABLE;

  assert.ok(enabled("EnableEmbeddedAsarIntegrityValidation"), "未启用 app.asar 的嵌入式完整性校验熔丝");
  assert.ok(enabled("OnlyLoadAppFromAsar"), "未启用仅从 app.asar 加载的熔丝");
  assert.ok(disabled("RunAsNode"), "RunAsNode 熔丝必须禁用");
  assert.ok(disabled("EnableNodeOptionsEnvironmentVariable"), "NODE_OPTIONS 熔丝必须禁用");
  assert.ok(disabled("EnableNodeCliInspectArguments"), "Node 调试参数熔丝必须禁用");
  process.stdout.write(`Electron 运行时完整性熔丝验证通过：${executable}\n`);
})().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
