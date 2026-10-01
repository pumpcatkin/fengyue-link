# 1.7.3 平台接口迁移与备用通路

核查日期：2026-10-01。范围：当前 Electron 桌面程序使用的平台能力；不是平台全部未使用的业务接口。

## 结论与实现

此前访客失败发生在页面锚点：旧 `#ai-chat-answer` 和基于样式类的按钮定位已不匹配新版页面。会话、消息读取接口仍可正常读取已建立的空回复。新版改为服务端编号驱动，记录操作不点击网站按钮、不打开编辑弹窗、不写网站 textarea。

- 房主生成、刷新、访客占位请求、会话初始化均由 Electron 会话网络层发送并读取 SSE。取得 `task_id` 后直接请求停止，访客只有在明确自然完成或服务器确认停止后才进入写回。
- 访客写回和消息编辑使用 `PATCH /console/api/installed-apps/{appId}/messages/{messageId}`，请求体为 `{answer}`，随后回读同一个消息编号及完整正文。
- 删除使用同一路径的 DELETE，轮询至已钉住的消息编号消失；重复操作保持原编号，防止第二次重试删除上一条记录。
- 每轮访客状态在发请求前保存，并合并同轮并发调用。未知传输故障保留已发送状态，只回查，不再次生成。已有相同输入的旧回合不当作本轮占位。
- 辅助插件、在线世界、编辑器保持每次新建会话的约定；只有明确的联机会话模式传 `conversation_id`、刷新编号和时间。
- 原生网页继续用于作品内容渲染。展示定位兼容当前 `#customized-answer` 与旧 `#ai-chat-answer`，按钮隐藏改用动作区域的语义 ID，移除旧哈希样式类。生成期间由工具状态反馈进度，完成并处理视角之后加载服务端记录。平台网页专属发送事件不再参与网络请求；工具自身输入/输出插件继续执行。

## 接口及备用状态

| 能力 | 当前服务端通路 | 备用状态 |
| --- | --- | --- |
| 普通生成 / 刷新 / 访客占位 / 会话初始化 | POST `/go/api/apps/chat-messages` | 仅主路由返回 404/405 时改走 POST `/console/api/installed-apps/{appId}/chat-messages`；同一请求体 |
| 终止生成 | POST `/go/api/apps/chat-stop`，`{task_id}` | POST `/console/api/installed-apps/{appId}/chat-messages/{taskId}/stop`；确认响应业务码，不以按钮消失作为成功 |
| 消息列表 | GET `/console/api/installed-apps/{appId}/messages` | 发现独立详情通路；它只适用于已知编号和创建时间的单条记录，不能替代完整列表发现 |
| 已知消息详情 / 编辑后回读 | 由消息列表按 ID 匹配 | POST `/go/api/apps/message`，`{message_id,message_created_at}`；列表路由 404/405 时启用。该响应的输入字段为 `origin_query` |
| 编辑回复 / 访客写回 | PATCH `/console/api/installed-apps/{appId}/messages/{messageId}` | 当前网页代码只确认这一条写路由。响应丢失时用读取通路确认结果，不猜写地址 |
| 删除回复 | DELETE 同上 | 只确认一条写路由。备用详情不返回匹配记录时不等价于删除成功 |
| 会话列表 / 重命名 / 删除 | GET `.../conversations`；POST `.../conversations/{id}/name`；DELETE `.../conversations/{id}` | 既有非 DOM 通路继续使用；没有确认另一组同义写接口 |
| 新建空白界面 / 选择会话 | 本地会话选择状态；首次模型请求建立实际服务端会话 | 平台当前选择属于本地存储，不虚构“空白会话创建”接口；初始化真实会话已改为 API |
| 模型列表 / 会话配置 | GET `/go/api/workspaces/model-list`；GET/POST `/go/api/apps/config` | 既有直连通路保留；写后回读，不猜备用写路由 |
| 作品详情 | GET `/console/api/installed-apps/{appId}` | 在线世界已有 GET `/go/api/apps/{appId}` 的详情读取回退，保留原权限与字段判断 |
| 作品创建 / 模型配置导入导出 | `/console/api/apps`；`/console/api/apps/{appId}/model-config` 及 `/export` | 既有直连 API；未确认同义备用写路由 |
| 私信建聊 / 消息传输 | `/console/api/chats`、`/console/api/chats/messages` | 既有直连和分片确认机制继续使用；未确认同义备用接口 |
| 评论 / 回复 / 世界账本 | `/console/api/comments/{appId}/1` 及既有分支/删除通路 | 既有直连、分页、回读与限流处理继续使用；不切换到未确认的路由 |
| 登录 / 账号资料 / 积分 | 既有登录流程、`/go/api/account/profile` 与持久会话 Cookie | 登录及节点切换保留现有策略；令牌只在主进程请求头中使用，不写入报告 |
| 附件上传等其余既有服务端功能 | 沿用现有服务封装 | 本轮未发现对应的独立备用端点，不改变请求语义 |

主/备用通路基于当前平台发布的 JavaScript API 封装；不是公开、承诺稳定的版本化接口。404/405 之外，网络中断、鉴权失败、限流和网关故障不触发第二次生成。HTTP 200 的明确业务拒绝仍支持自动选模；无完成标志的半截流不算成功。

当前前端还包含 `/go/api/apps/chat-variable-refresh`（变量刷新）和 `/go/api/apps/chat-regex-replaces`（正则配置读取）。它们并非编辑回复的替代接口，本次没有把它们当作备用写路由。

## 作品编辑器兼容修复

- 新作品保存后的 `promptSort` 回读按数值语义比较：缺失、`null`、空字符串、数字 `0` 与字符串 `"0"` 等价；非零排序值缺失仍会阻止保存。保存体同时兼容平台导出的 `pre_prompt_sort` 和 `prompt_sort`。
- 编辑器导入新增格式分流，支持 `fyow.game-card/1`、`fyow.game-card-editor/1`、`fyow.game-card-editor-projects/1` 和无 `schema` 的平台作品配置。编辑器项目及平台配置导入后生成新的本地草稿，清除旧作品编号、作者、来源、发布校验和验收状态。
- 平台配置包含 `FYOW-PROGRAM/1` 时恢复 HTML 与 `gameId`；缺少程序信封时载入开发样例并标记待实现。`fyow.game-card/2`、整库备份和未知格式会返回对应的可操作提示，不再统一显示“游戏卡格式版本不受支持”。
- 普通玩家游戏库继续严格只接受完整、摘要有效的 `fyow.game-card/1`，编辑器项目或平台配置不会被当作可运行卡。

## 验证证据

- 2026-09-30 对原失败访客账号进行只读核查：会话列表 HTTP 200、消息列表 HTTP 200、Go 消息详情 HTTP 200。两个消息通路的编号和正文一致，原记录的答复仍为空。未对该记录发送 PATCH、DELETE 或模型生成。报告：`output/platform-api-readback-1.7.3.json`。
- `tests/platform-message-apis.test.ts` 覆盖双生成/停止路由、明确拒绝与未知结果、空流停止、长 HTML、精确编号验证、重复删除、并发准备和 API 回读故障恢复。
- `npm run verify:platform-api` 使用真实 Electron session 和本地 HTTP/SSE 服务验证准备→停止→写回→新版页面展示→编辑→刷新→删除全链路，并验证旧展示 ID 兼容；报告：`release-cache/platform-api-validation/result.json`。
- `npm run verify:perspective` 验证直连生成后的独立视角处理、备用生成路由、取消及插件关闭情形。
- `npm run verify:sandbox` 验证桌面生产 preload 与界面。全量测试及 TypeScript/Vite 构建作为打包前门槛。
- 全量 Vitest：51 个测试文件、835 项测试全部通过；TypeScript 检查和 Vite 构建通过。
- 签名打包后再次从 `win-unpacked/resources/app.asar` 运行平台 API 和独立视角 QA，结果全部通过；签名发布清单、安装版本地门禁和 Electron 熔断配置验证通过。
- 安装包 SHA-256：`94bb681ee7bfa0ac41f0ac277f493b44ee5db2d133cbed9d16e835de284c1488`；主程序 SHA-256：`d2b4ef5945386d80908a1c50c9487b0915cd4fed84c31b1130a3a1d6a083feba`；`app.asar` SHA-256：`35573d21951649042cc11dec8babe4953af7829fba2d0b89baf61e5354f944b6`。

## 交付

版本：1.7.3。正式身份保持 `cc.aiero.fengyue.link` 与原 NSIS GUID。正式安装包为 `release/platform-api-1.7.3/fengyue-link-1.7.3-setup.exe`，目录版为 `release/platform-api-1.7.3/win-unpacked`。桌面和开始菜单快捷方式均已指向目录版主程序，回读的 FileVersion 为 `1.7.3`、ProductVersion 为 `1.7.3.0`。目录版启动并正常退出的冒烟验证通过。GitHub 正式发布使用 `v1.7.3` 标签和六项签名资产；线上验签完成后再清理上一版 Release。
