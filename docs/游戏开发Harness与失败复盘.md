# 游戏开发 Harness 与失败复盘

适用范围：`test/online-game-editor-local-warning` 测试分支。正式发布分支不随此开发改动。

## 为什么重做

旧链路只让五个固定角色依次输出配置建议，中枢不接收程序源码或执行证据，还禁止修改程序。新建卡实际只有欢迎页。与此同时，大厅将任意 gameId 都交给《猎艳疆土》的地图、开服与评论账本引擎。提示词再完整也补不出缺失的游戏程序；摘要正确与游戏可玩是两个不同的条件。

当前不再执行固定角色流水线。旧 IPC 名称保留兼容，但直接进入 `runEditorHarness`。模型围绕目标选择工具、观察结果、修复失败，再决定下一步。

## 三层结构

1. **模型层**：平台实时目录选型，GPT 5.6+ → Claude Opus 4.6+ → GLM 5.3+。每轮每一类选择一个候选，最多三次尝试；不悄悄降级到不满足阈值的模型。独立评审排除实际代码编写模型，同型号换供应商不算第二模型。
2. **Harness 层**：虚拟项目文件、结构化工具调用、原子检查点、取消、预算、版本指纹和验证条件。开发模型收到真实工具输出及其他模型的评审结果，而不是只看到“任务完成”。
3. **执行层**：独立 Electron 沙箱窗口运行单文件 HTML，通过真实 DOM 操作采集断言、错误、存档和布局证据。模型程序不进入主进程，也没有任意 shell、网络、账号存储或本机文件读写权限。

默认每轮 24 次模型决策、15 分钟总时限；接口单次调用另有 180 秒超时。停止会取消活动模型调用，未完成候选保留在本地，不覆盖原卡。重新提交相同目标且原项目指纹未变化时，可从候选文件继续，但运行和评审证据必须重新获得。

## 工具契约

工具响应格式为 `{ "summary": "简短决策说明", "tool": "工具名", "args": {} }`。这里的 summary 是玩家可见的行动说明，不是隐藏推理过程。

| 工具 | 输入 | 输出/约束 |
| --- | --- | --- |
| read_file | path、offset、limit | 分段读取 `program.html`、`configuration.json`、`tests.json` |
| write_file | path、content | 只替换上述虚拟文件；身份、权限和账号字段不在配置白名单 |
| test_game | 空对象 | 浏览器执行结果、失败步骤、可见文本、布局与存档恢复证据 |
| review | question | 另一模型读取目标、源码、测试和执行证据，结果回到开发模型 |
| finish | 空对象 | 当前文件指纹必须同时匹配测试及批准记录，且有两个不同型号参与 |

任意文件变化都会使既有测试和评审失效。大厅名称仍为默认值或简介为空时，结束门槛不通过。修改已有疆土联机卡时禁止自动降级为独立单人玩法。

开发使用独立的“游戏开发 Harness”工具作品，其编号绑定到账号与节点，玩家不需要配置链接。它与游戏伴生作品分离，避免游戏世界书干扰开发请求，也避免模型切换改动玩家正在使用的游戏作品。新建本地草稿不创建游戏伴生作品；首次调用开发工具可能创建工具工作台作品，只有点击“保存并同步”才创建游戏伴生作品。

## 游戏运行时

### 独立玩法 `standalone/1`

程序明确声明：

```html
<meta name="fyow-runtime" content="standalone/1">
```

大厅验证卡片与伴生作品作者，解析最新程序后，直接载入该独立玩法，不再要求地图开服。独立模式是**单人、本地存档**；它不是通用多人服务器，也不开放疆土 intent、私信、管理或公共账本能力。

- iframe 仍只有 `allow-scripts`，不增加 `allow-same-origin`。
- `source=fyow-grid-conquest`、`protocol=fyow-host/1` 保留既有桥协议兼容。
- `ready` 后接收宿主 `state`，其中 `runtime=standalone/1`、`gameSave` 为存档或 null。
- `game-save` 携带 UUID requestId 与 JSON 对象 data；宿主用 `result/error` 确认。上限 60KB，至少间隔 100ms。
- 本地路径按节点、账号、伴生作品、gameId 的哈希隔离；原子写入并保留备份。
- 页面准备完毕之前禁用玩法操作；恢复时不应把空初始状态覆盖到现有存档。
- 返回游戏库仍有独立的右上角悬浮按钮，不依赖游戏内按钮。

### 原有疆土引擎

原联机玩法仍由原引擎处理，不迁移账本、不改变角色权限。非疆土 gameId 若未实现明确的独立运行时，会得到针对缺失程序的错误，而不是误开一个疆土世界。

本版自动浏览器场景工具针对独立玩法。疆土专用规则的代码修改仍需原有专项回归，Harness 不把独立玩法测试冒充为疆土完整测试。

## 验收与保存

每个场景至少两次玩家输入、两个明确的状态断言，并包含终局、重新开始、中途存档恢复、重开后恢复检查。自动检查 ready、有效存档写入、至少两次界面变化、脚本错误、桌面与手机横向溢出。测试禁止任意 eval，只允许选择器点击、文本输入、按键和文本断言。

这是一套有边界的回归验收，不是对任意游戏、任意路径的数学证明。模型生成的测试也可能漏掉需求，因此还要独立模型审查、人工复核及失败样例回归。

“保存草稿”只更新编辑项目，保留未完成内容，不再覆盖游戏库中的运行卡或其源 JSON；“保存并同步”对独立程序重新运行浏览器验收，通过后才写云端。云端导出回读继续验证配置和程序摘要，然后重建游戏卡。编辑后界面显示“待重新验收”，不沿用旧版通过状态。

只剩旧欢迎页的项目会标记“需实现玩法”，编辑器给出明确标记的开发样例，但不把样例当成原游戏发布。需要依据原有世界书和目标实现程序；没有被保存过的玩法代码不能靠换一个运行入口自动还原。

## 文件接口调查

已读取当前风月前端资源并区分两条路径：

| 路径 | 观察到的用途 | 本次结果 |
| --- | --- | --- |
| `/console/api/files/upload` | 前端通用附件函数，multipart `file`，预期 201 与文件 id | 登录节点实测返回 404，未证明可用 |
| `/go/api/file/upload?biz=chat_message_history` | 对话历史导入，返回文件 URL | 现有历史导入脚本使用；不是已验证的模型附件入口 |

模型请求支持构造 `files:[{type:"document",transfer_method:"local_file",upload_file_id:"..."}]`，但这只说明请求序列化支持该字段。上传成功、请求成功、模型确实读到附件是三项不同的验证。探针把随机标记只放在临时附件，不放在问题中，要求模型返回该标记；只有准确返回才记录 `consumedByModel=true`。目前上传 404，绝不声称模型已经读到文件。

默认 Harness 使用 `read_file` 的明文工具结果向模型传递项目内容，不依赖未证实的附件服务。`harness-attachments.cjs` 与探针保留用于平台恢复接口后的再次验证，不向玩家展示失效上传功能。

## 失败经验

以下内容同时进入模型每轮上下文与回归测试：

- 欢迎页和提示词不是游戏；必须有可执行的输入、状态变化、终局和重开。
- gameId 不等于通用引擎；新卡不要借用疆土专用开服链路。
- 包摘要、握手和自评分数不等于可玩；验证必须基于实际动作。
- 旧配置别名不能覆盖 canonical 提示词；空字段也不能凭空覆盖已有内容。
- opaque iframe 中不要调用 localStorage 或外部网络；存档经宿主桥。
- 真正双模型试验仍漏过了大厅默认名称和空简介，因此新增结束门槛，不能把模型批准当成充分条件。
- 附件接口 404 是实际能力缺口，不能用聊天历史上传冒充模型文件阅读。

## 验证命令与证据

```powershell
npm test
npm run build
.\node_modules\.bin\electron.cmd scripts/verify-game-harness.cjs
.\node_modules\.bin\electron.cmd scripts/verify-game-card-render.cjs --starter
.\node_modules\.bin\electron.cmd scripts/probe-harness-platform.cjs --attachments
.\node_modules\.bin\electron.cmd scripts/probe-harness-platform.cjs --live
```

live 探针使用内存解密的既有登录凭据与独立 QA 会话，不打印密码、Token 或 Cookie。它会消耗平台积分，并仅创建/修改自己的工具工作台和测试作品，不覆盖玩家旧卡。实际生成的项目、浏览器证据、云端保存及重新打开结果放在忽略的 `output/harness-platform/`。独立程序的故障注入验收记录在 `output/harness-qa/result.json`。

## 参考来源

本次直接读取的官方资料：

- Cursor《Best practices for coding with agents》：指令、工具与模型组成 harness；工具与模型需匹配，运行反馈驱动迭代。`https://cursor.com/blog/agent-best-practices`
- OpenAI Codex 官方仓库的工具路由和代理控制实现：明确的调用/结果契约、状态、控制与隔离。`https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/router.rs`，`https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/control.rs`

本项目借鉴其结构，不宣称复制了 Codex/Cursor 的完整能力。官方开发站点部分页面抓取返回 403，因此不将未读到的页面当作事实依据。
