# 官方版本与完整性验证

从 0.12.3 起，每个安装版本只在安装后的首次启动中后台自动连接唯一官方 GitHub 仓库一次，读取最新 Release，并验证发布清单的 Ed25519 数字签名以及本机 `风月联机工具.exe`、`resources/app.asar` 的 SHA-256。成功或失败结果都会按版本写入首次运行记录；同一版本后续启动只读取该记录，不再次联网，也不重新计算文件摘要。整条首次联网流程限制在 8 秒内，Release 元数据、清单和签名共享同一个截止时间；清单与签名并行下载，本机摘要采用异步流式计算，避免校验时冻结界面。

## 唯一发布身份

```text
仓库：pumpcatkin/fengyue-link
发布页：https://github.com/pumpcatkin/fengyue-link/releases/latest
应用 ID：cc.aiero.fengyue.link
公钥指纹：7f2c-4d81-1494-1585-e7ec-6af4-7587-d891-8eab-5425-a939-693e-5adf-3343-b073-dcec
```

程序启动时使用应用内品牌弹窗明确提示“本工具完全免费”，并展示唯一官方发布页。弹窗和登录界面不展示公钥、密钥正文或公钥指纹；登录页不显示验证状态，也不提供手动验证入口。只有首次运行验证失败、安装内容异常或当前版本过期时，才显示要求使用官方完整版本或更新版本的阻断弹窗。

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
```

第二条命令使用本地 Release 文件模拟 GitHub 响应，验证在线签名、离线缓存和篡改阻断三条完整路径，不会访问真实账号或平台。

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
- 安装版首次启动：在后台自动执行一次完整验证，联网部分整条流程最多等待 8 秒；界面不展示验证进度。
- 首次验证成功：写入当前版本的完成记录，登录随后可正常进行。
- 首次验证失败：写入当前版本的失败记录并停止登录，显示“使用官方完整版本”弹窗；同版本后续启动直接恢复该结果，不自动重试。
- 检测到更新：当前版本低于 GitHub 最新签名版本时停止登录，并在后台自动下载。下载后的安装包必须与 Ed25519 签名清单中的文件名、大小和 SHA-256 完全一致，验证成功后才允许静默安装；失败时只引导到唯一官方发布页。
- 未登记版本：本机版本高于或不同于 GitHub 最新签名版本时停止登录，并引导用户返回唯一官方发布页。
- 同版本后续启动：只读取首次运行记录，不联网、不重新计算本机文件摘要，也不显示成功提示。

## 安全边界

签名清单能够在首次运行时发现安装内容损坏、第三方重打包以及非官方发布文件，但应用内检查本身仍属于应用代码的一部分。按当前产品要求，同一版本完成首次验证后不再重新检查，因此首次运行以后发生的本地文件替换不会由该流程再次发现。正式公开发布前仍应为安装器和主程序配置受信任的 Windows Authenticode 代码签名证书，让 Windows 在每次程序启动前验证发布者；公钥指纹可在维护文档和独立长期渠道保留，应用弹窗不展示。

0.12.9 起，Windows NSIS 安装向导允许选择安装目录，并在该目录保留 `Uninstall 风月联机工具.exe`。退出时会统一关闭账号实例、OAuth 窗口、隐藏平台页面、介绍页面和对话页面；介绍页面未作为当前界面展示时始终静音。0.12.8 起安装包自带 Electron/Node.js 运行时，普通用户无需另装 Node.js。安装版使用 electron-builder 生成的 `latest.yml` 与 blockmap 检查更新，但自动安装仍额外受项目自己的 Ed25519 签名清单和 SHA-256 复核约束。首次验证直接下载 `releases/latest/download/` 下的签名资产，避开 GitHub REST API 的匿名共享限额；Electron 中通过 `original-fs` 读取 `app.asar` 物理归档，避免把 ASAR 虚拟目录误判为缺失。该版本也把应用版本写入联机握手，任一侧版本不同都不会进入密码认证和房间数据同步，访客端会显示更新要求。
