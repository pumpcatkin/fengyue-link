# 版本号对照与运行文件校验

当前安装版**每次启动**都会连接唯一官方 GitHub 发布页，验证发布清单的 Ed25519 数字签名，并重新计算 2 个关键运行时文件的 SHA-256：`风月联机工具.exe` 与 `resources/app.asar`。不保存可用于放行登录的本地成功或失败记录。整条流程最多等待 8 秒；清单与签名并行下载，两个文件摘要异步流式计算，避免校验时冻结界面。

## 唯一发布身份

```text
仓库：pumpcatkin/fengyue-link
发布页：https://github.com/pumpcatkin/fengyue-link/releases/latest
应用 ID：cc.aiero.fengyue.link
公钥指纹：7f2c-4d81-1494-1585-e7ec-6af4-7587-d891-8eab-5425-a939-693e-5adf-3343-b073-dcec
```

程序启动时的界面只显示“正在对照版本号”“版本号对照完成”或简短的版本号对照失败信息，不再向普通用户解释完整性校验、安全目的、发布渠道、公钥或密钥。登录页不提供手动验证入口。内部仍会在每次启动时完成签名清单、版本号和关键文件摘要校验；失败时停止登录。

## 发布文件

每个正式 GitHub Release 必须使用 `v{package.json.version}` 标签，并同时上传：

1. `fengyue-link-{version}-setup.exe`
2. `fengyue-link-{version}-setup.exe.blockmap`
3. `latest.yml`
4. `release-manifest.json`
5. `release-manifest.sig`
6. `SHA256SUMS.txt`

`release-manifest.json` 绑定产品名、应用 ID、版本、Release 标签、唯一发布页、安装包、主程序和 `app.asar` 的文件名、大小及 SHA-256。`release-manifest.sig` 是对清单原始字节的 Ed25519 签名；只要离线私钥没有泄露，单纯复制界面、仿冒仓库、替换下载地址或接管 GitHub 账号都不能生成有效签名。

## 维护者发布流程

签名私钥必须放在项目目录之外，不进入 Git、云盘同步目录、安装包或日志。首次建立发布身份时运行：

```powershell
npm run release:keygen -- --out=D:\独立的离线密钥目录
```

将生成的公钥写入 `electron/release-security.cjs` 后，私钥应移到离线介质并保留独立备份。当前程序固定的公钥不得在普通版本更新中更换；确需轮换时，应先由旧私钥签署密钥迁移声明，并在旧版本仍可验证时发布过渡版本。

构建安装包后生成签名清单：

```powershell
npm run pack:win
npm run release:manifest -- --key=D:\独立的离线密钥目录\fengyue-release-ed25519-private.pem
```

清单输出到 `release/github`。上传前执行本地复核：

```powershell
npm run release:verify -- --installer="D:\风月联机工具\release\fengyue-link-{version}-setup.exe"
npm run verify:release-gate
npm run verify:electron-fuses
```

第二条命令使用本地 Release 文件模拟 GitHub 响应，验证每次启动重新验签、2 个关键文件完整性校验和篡改阻断，不会访问真实账号或平台。第三条命令读取打包 EXE，确认 Electron 会在应用代码加载前校验 `app.asar`，且不会从目录回退或接受 Node 调试环境变量。

发布到 GitHub 后再执行真实 Electron 网络层复核：

```powershell
npm run verify:release-live -- --version={version}
```

该命令直接读取公开 Release 的 `releases/latest/download/` 签名资产，不占用 GitHub REST API 匿名请求额度。

只有在安装包、签名清单和签名均保持不变后才能创建 GitHub Release。重新打包会改变 `app.asar` 和安装包摘要，必须重新生成签名清单。

每次本地或正式版本更新还必须同步更新桌面 `风月联机工具.lnk`，使其指向本次最新可执行文件。交付前重新读取快捷方式的 `TargetPath`，确认目标存在，并核对目标文件的 `ProductVersion` 与 `package.json` 版本一致；仍指向旧安装目录、旧镜像或旧版本的快捷方式视为本次交付未完成。

## GitHub 同步策略

- 仓库正式公开前：只在本地构建和验证，不向 GitHub 上传源码、版本说明、安装包或测试 Release。
- 仓库正式公开后：每次发布只上传当前安装包、blockmap、`latest.yml`、`release-manifest.json`、`release-manifest.sig` 和 `SHA256SUMS.txt`，不要求为当前更新同步 README 或更新说明。
- 新 Release 上传并完成远端可下载性与签名复核后，删除上一版 GitHub Release 及其标签，使发布页只保留最新版本。新版本验证完成前不先删旧版，避免发布页出现空档。
- 正式版本更新记录从仓库公开后的第一个 Release 开始；公开前版本均按本地测试版本管理。

## 客户端验证规则

- 开发模式：显示开发状态，不阻断本地源码调试。
- 安装版每次启动：在后台自动执行完整验证，联网部分整条流程最多等待 8 秒；界面仅显示版本号对照状态。
- 启动验证范围：只校验 2 个关键运行时文件——`风月联机工具.exe` 与 `resources/app.asar`。`app.asar` 包含主进程、preload、界面及令牌处理代码；主 EXE 是加载这些代码的 Electron 宿主。
- 启动验证成功：当前启动期间允许登录；不会写入或读取本地放行记录。
- 启动验证失败：停止登录并显示简短的版本号对照失败信息；下次启动会重新联网验证，不沿用上次结果。
- 检测到更新：当前版本低于 GitHub 最新签名版本时停止登录，并在后台自动下载。下载后的安装包必须与 Ed25519 签名清单中的文件名、大小和 SHA-256 完全一致，验证成功后才允许静默安装；失败时只引导到唯一官方发布页。
- 未登记版本：本机版本高于或不同于 GitHub 最新签名版本时停止登录，并引导用户返回唯一官方发布页。
- 同版本后续启动：重新下载并验签官方清单，重新计算上述 2 个文件摘要；不沿用任何本地放行结果。

## 安全边界

签名清单能够让未被替换的官方主程序在每次启动时发现 `app.asar` 或主 EXE 与当前发布清单不一致。构建同时启用 Electron 的嵌入式 ASAR 完整性与“仅从 ASAR 加载”熔丝：Windows 的主 EXE 会在加载应用代码前核对 `app.asar`，篡改后直接终止。校验范围刻意限制为 2 个承载本工具令牌处理逻辑的文件，不覆盖 Electron 运行时的全部 DLL 与系统级注入。

这套应用内部校验不能约束“整个程序都被替换”的情况：重打包者可以发布另一个已经删掉校验逻辑的 EXE，或者制作外观相同的安装包。内置公钥能阻止对方伪造本项目的签名清单，却不能强迫一份已被替换的程序执行校验。因此，当前机制适合发现官方安装内容的损坏或局部篡改，不构成对任意来路安装包的外部信任根。要让用户在程序运行前识别发布者，需要为安装器和主程序配置受信任的 Windows Authenticode 代码签名证书，并长期保持同一发布者身份；社区只传播固定 GitHub 地址及独立公布的哈希/签名仍是必要的分发措施。当前构建产物尚未配置 Authenticode 签名。

0.12.9 起，Windows NSIS 安装向导允许选择安装目录，并在该目录保留 `Uninstall 风月联机工具.exe`。退出时会统一关闭账号实例、OAuth 窗口、隐藏平台页面、介绍页面和对话页面；介绍页面未作为当前界面展示时始终静音。0.12.8 起安装包自带 Electron/Node.js 运行时，普通用户无需另装 Node.js。安装版使用 electron-builder 生成的 `latest.yml` 与 blockmap 检查更新，但自动安装仍额外受项目自己的 Ed25519 签名清单和 SHA-256 复核约束。每次启动验证直接下载 `releases/latest/download/` 下的签名资产，避开 GitHub REST API 的匿名共享限额；Electron 中通过 `original-fs` 读取 `app.asar` 物理归档，避免把 ASAR 虚拟目录误判为缺失。该版本也把应用版本写入联机握手，任一侧版本不同都不会进入密码认证和房间数据同步，访客端会显示更新要求。
