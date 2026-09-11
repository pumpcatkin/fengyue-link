# “在线游戏世界”准备方案与实测记录

> 状态：已完成创作页保存、用户范围世界书、模型请求、双账号评论/回复/私信的真实链路测试；尚未在主界面加入入口，也没有发布测试作品。
>
> 最近实测：2026-09-12（Asia/Shanghai）
>
> 通讯测试作品：`4ac2ab60-67ff-459d-ae9a-6274f1802195`
>
> 创作测试作品：`3c18ed97-f452-457a-9d66-5922f4fbc3d7`，名称 `FYOW 在线游戏世界接口联调`，保持未发布

## 1. 本轮结论

“在线游戏世界”适合做成“工具内的受控游戏运行时 + 风月作品提供程序和数据通道”，不再采用本地导入 `.fycard` 的方案。

建议冻结以下职责边界：

1. 伴生作品的“详细介绍”保存惰性编码的游戏程序包及清单，服主修改作品即可发布新程序版本。
2. 工具下载原始详细介绍、提取程序、校验清单和作者签名，然后在隔离 `WebContents` 中运行。
3. 公开世界状态、操作事件和快照放在该作品的评论区。
4. 私人状态以密文形式锚定到评论账本，由本局权威端验证并签名；本地副本只作缓存。
5. 一对一消息使用风月私信，所有消息都绑定 `workId + seasonId + gameId`。如果要求物理上所有数据都处在同一作品下，则改用评论区密文回复，不能同时依赖平台私信。
6. 游戏前端只提交“意图”，不提交“执行后的结果”；状态归约、合法性检查、平台通讯和模型调用全部由工具宿主完成。

评论区适合增量、回合制、农场/攻城、随机文字冒险等低频游戏，不适合动作游戏或秒级 PvP。既有五次公开读取样本为 `1561 / 913 / 5630 / 892 / 896 ms`，中位数 `913 ms`，长尾达到 `5.630 s`。

## 2. 作品中的程序分发

### 2.1 为什么不能直接保存可执行标签

创作页明确拦截 `<script>`、`<iframe>`、`<object>` 等潜在可执行标签。测试程序因此采用不会在风月网页中执行的惰性载荷：

```html
<section data-fyow-program-manifest="fyow.program/1">
  <pre data-fyow-program="base64url">BASE64URL_PROGRAM_PACKAGE</pre>
</section>
```

工具读取的是接口返回的原始详细介绍，不从渲染后的 DOM 复制代码。详细介绍只充当分发载体；解码后的代码由工具自己的运行时执行。

### 2.2 程序信封

第一版建议采用单个 Base64URL 文本信封，超过详细介绍容量后再引入分片：

```json
{
  "schema": "fyow.program/1",
  "gameId": "com.example.grid-world",
  "version": "1.0.0",
  "minRuntime": "0.14.0",
  "entry": "index.html",
  "compression": "gzip",
  "payloadEncoding": "base64url",
  "payloadSha256": "SHA256",
  "permissions": ["public-ledger", "private-state", "direct-message", "model"],
  "limits": { "decodedBytes": 8388608, "files": 256, "singleFileBytes": 2097152, "modelRequestsPerTurn": 1 },
  "authorKeyId": "AUTHOR_KEY_ID",
  "signature": "ED25519_SIGNATURE",
  "payload": "BASE64URL_GZIP_TAR"
}
```

宿主处理顺序固定为：读取原文 → 限制字符数 → 提取唯一信封 → Base64URL 解码 → 限制压缩前后大小和文件数 → SHA-256 → Ed25519 作者签名 → 兼容性/权限检查 → 写入按哈希命名的只读缓存 → 启动沙箱。

运行环境使用 `sandbox: true`、`contextIsolation: true`、无 Node 集成、无 Cookie/Token、无任意网络、严格 CSP。游戏代码只获得窄 SDK；动态代码执行、外链、弹窗、下载、剪贴板和通用 Electron IPC 默认关闭。

### 2.3 更新与回滚

- 安装记录绑定 `workId + authorAccountId + authorPublicKey`，避免另一个作品冒充同名游戏。
- 每次启动读取清单头；版本或哈希变化时下载新载荷。
- 新版本先在临时沙箱完成自检，再切换活动版本。
- 至少保留上一个已验证哈希，更新启动失败时允许回滚。
- 存档迁移函数必须声明 `from/to` 版本，迁移前保留旧快照。
- 详细介绍中必须只有一个活动信封；旧版本通过清单的 `rollback` 字段引用，避免解析歧义。

隐藏实现细节只能增加修改门槛。程序既然下载到玩家设备，熟练用户最终仍可提取；可靠性必须来自“客户端不拥有权威结果”，不能依赖不开源或混淆。

## 3. 当前平台接口

平台页面目前使用 `/console/api` 和 `/go/api`。请求应由登录后的隐藏账号页发起，Cookie 和 Bearer 登录态只留在工具主进程管理的会话分区内，游戏程序永远看不到凭据。

### 3.1 创作、配置与详细介绍

创作页当前保存完整作品配置的真实接口是：

```text
POST /console/api/apps/{workId}/model-config
GET  /console/api/apps/{workId}/model-config/export
GET  /go/api/apps/config?app_id={workId}[&conversation_id={conversationId}]
```

`model-config/export` 使用缩写字段：

| 页面字段 | 保存体字段 | 导出字段 |
|---|---|---|
| 作品名称 | `app.name` | `name` |
| 详细介绍 | `app.description` | `desc` |
| 前置词 | `pre_text` | `pretxt` |
| 提示词 | `pre_prompt` | `prpt` |
| 后置词 | `post_text` | `posttxt` |
| 世界书 | `world_book` | `world_book` |

创作测试已保存并从导出接口回读确认名称、详细介绍、前置词、提示词、后置词以及一个世界书条目：

```json
{
  "group": "",
  "match_type": 2,
  "key": "_or_[[FYOW:TASK:probe:v1]]",
  "key_region": 2,
  "value_type": 0,
  "value": "这是用户输入触发的联调世界书。固定返回：{\"worldBook\":\"matched\",\"version\":1}",
  "value_configs": [],
  "value_region": 1,
  "sort": 0,
  "depth": 0,
  "probability": 100,
  "enable": true
}
```

`key_region: 2` 对应触发范围“用户”。保存前必须确认 `key_region` 非零，否则平台返回“世界书参数不能为空”。创作页点击“保存”后还会打开更新日志对话框，点击“确认”才会真正提交。

普通玩家读取已发布作品详情继续使用：

```text
GET /console/api/installed-apps/{workId}
```

测试作品没有发布，因此本轮只证明详细介绍已被保存并能由作者导出接口原样读回；“第二账号从已发布作品详情下载同一程序信封”应作为发布前最后一个验收项。

### 3.2 评论与回复

```text
GET    /console/api/comments/{workId}/1?page={page}&limit={limit}&order={order}&filter_type={filter}
POST   /console/api/comments/{workId}/1
DELETE /console/api/comments/{workId}/1/{commentId}
GET    /console/api/comments/branches/{commentId}
POST   /console/api/comments/{workId}/1/{commentId}/like
DELETE /console/api/comments/{workId}/1/{commentId}/like
GET    /console/api/comments/{workId}/1/check
```

当前普通评论的 `biz_type` 为 `1`，不是旧探针曾使用的 `0`：

```json
{ "is_anonymous": false, "biz_type": 1, "content": "COMMENT_BODY" }
```

回复根评论：

```json
{
  "is_anonymous": false,
  "biz_type": 1,
  "parent_id": "ROOT_COMMENT_ID",
  "to_account_id": "ROOT_AUTHOR_ACCOUNT_ID",
  "content": "REPLY_BODY"
}
```

直接回复根评论时不发送 `to_comment_id`；回复分支中的某一条回复时才发送目标回复 ID。普通文本评论不发送 `score`，评分评论才使用 `biz_type: 2` 和评分值。

评论公开可读，写入需要正常登录账号；游客/试用登录曾返回 `400 guest_limit`。评论中的私人内容必须加密。

### 3.3 风月私信

```text
GET  /console/api/chats?page=1&limit={limit}
POST /console/api/chats                       { "receive_id": "ACCOUNT_ID" }
GET  /console/api/chats/messages?chat_id={chatId}&page=1&limit={limit}
POST /console/api/chats/messages              { "chat_id": "CHAT_ID", "content": "BODY" }
```

游戏程序不直接看到平台 `chatId`。宿主把逻辑收件人映射到平台账号和私信会话，并对消息做大小、类型、频率和游戏/赛季绑定检查。

### 3.4 模型请求

创作调试页当前发送到：

```text
POST /console/api/apps/{workId}/chat-messages
```

已安装作品的对话接口仍需由宿主兼容：

```text
POST /go/api/apps/chat-messages
GET  /console/api/installed-apps/{workId}/conversations?limit={limit}
GET  /console/api/installed-apps/{workId}/messages?conversation_id={conversationId}&limit={limit}
POST /console/api/installed-apps/{workId}/chat-messages/{taskId}/stop
```

统一请求语义：

```json
{
  "app_id": "WORK_ID",
  "inputs": {},
  "conversation_id": "CONVERSATION_UUID_OR_EMPTY",
  "query": "[[FYOW:TASK:story.next:v1]]\n{\"schema\":\"fyow.model-request/1\",\"input\":{}}",
  "response_mode": "streaming",
  "files": []
}
```

SSE 解析器至少处理 `message`、`agent_message`、`message_end`、`message_replace`、`workflow_started`、`workflow_finished`、`text_chunk`、`text_replace`、`thinking`、`error`，并保存 `task_id`、`message_id`、`conversation_id` 和积分元数据。

## 4. 单张作品内的数据模型

### 4.1 公开数据：评论区事件账本

地图归属、已部署将领、公开战力、军队、建筑、战斗结果、回合号和公开资源都必须由评论事件导出，不以任一玩家的本地存档为准。

```text
§FYOW2§EVENT§BASE64URL(GZIP(CANONICAL_JSON))
```

```json
{
  "schema": "fyow.event/2",
  "gameId": "com.example.grid-world",
  "workId": "WORK_ID",
  "seasonId": "SEASON_ID",
  "eventId": "UUID",
  "actorAccountId": "PLATFORM_ACCOUNT_ID",
  "deviceKeyId": "DEVICE_KEY_ID",
  "seq": 42,
  "revision": 381,
  "prevHash": "SHA256_PREVIOUS_EVENT",
  "type": "deploy-general",
  "intent": {},
  "result": {},
  "stateHash": "SHA256_RESULTING_PUBLIC_STATE",
  "createdAt": 1789140000000,
  "signature": "ED25519_SIGNATURE"
}
```

客户端提交的是 `intent`，例如“请求在 x=4,y=7 部署将领 A 和 200 士兵”。本局权威端读取当前状态、验证所有权/资源/冷却时间后产生 `result`、新 `revision` 和签名。其他客户端只接受能接续 `prevHash` 且通过验证的权威事件。

每 50–200 个事件追加一次签名快照；快照分片包含相同 `snapshotId`、片号、总片数、整包哈希和前一权威事件哈希。快照只加速读取，事件链仍是审计依据。评论被删除、折叠或分页遗漏时，客户端显示“账本不连续”并停止提交影响世界的操作。

### 4.2 私人数据：密文保管箱 + 公开承诺

未部署将领设定、训练队列、未公开行动等不能只存在本地，否则玩家可任意改写。推荐流程：

1. 玩家提交私人操作意图给本局权威端。
2. 权威端验证资源、时间和规则，生成新的私人状态。
3. 私人状态使用随机数据密钥做 XChaCha20-Poly1305/AES-256-GCM 加密；数据密钥分别加密给玩家设备公钥和权威端公钥。
4. 密文分片追加到该作品评论区，公开事件只记录密文哈希、版本、玩家账号、`prevPrivateHash` 和权威签名。
5. 玩家换设备时用恢复密钥或已绑定设备迁移，不以平台 Token 作为加密密钥。
6. 部署到地图时公开必要字段，并校验它们与此前权威签名的私人状态/承诺一致。

这让其他玩家看不到私人正文，同时让该玩家不能把一份未经权威确认的本地状态带入公开世界。服主/权威端会看到需要验证的私人数据；如果还要求对服主隐藏，同时又要求服主验证任意复杂规则，就需要零知识证明或额外可信服务，第一版不承担这一目标。

训练队列至少在开始时公开承诺：

```text
commit = SHA256(seasonId || accountId || actionCanonicalJson || randomSalt)
```

完成时公开动作与盐，验证开始时间、消耗和结果。承诺只能证明“后来公开的内容没有临时更换”，合法性仍需开始时由权威端验证并签名。

### 4.3 一对一通讯数据

风月私信适合俘虏通知、将领书信、秘密外交和定向任务：

```text
§FYOW2§DM§BASE64URL(SEALED_JSON)
```

```json
{
  "schema": "fyow.direct/2",
  "gameId": "com.example.grid-world",
  "workId": "WORK_ID",
  "seasonId": "SEASON_ID",
  "messageId": "UUID",
  "fromAccountId": "ACCOUNT_A",
  "toAccountId": "ACCOUNT_B",
  "type": "captured-general-letter",
  "createdAt": 1789140000000,
  "payload": {},
  "signature": "ED25519_SIGNATURE"
}
```

平台私信物理上属于账号聊天系统，不属于作品评论树。用 `workId/seasonId/gameId` 绑定后，它在逻辑上属于这一局；如果“所有字节必须在作品内”是硬约束，就把信封改为评论区公开密文，并接受旁观者可见密文和更高评论量。

私信不得直接改变公开地图。任何会改变所有玩家状态的结果最终都由权威端转成公开事件，避免两个人的私信状态与全局账本分叉。

## 5. 作弊边界与减轻方式

### 5.1 必须接受的事实

- 玩家控制自己的电脑，所以本地文件、内存、时钟、渲染结果和下载后的游戏代码都可能被改。
- 本地加密只能阻止别人读取；持有密钥的玩家仍可修改明文并重新加密。
- 数字签名能确认“哪个密钥签了什么”，不能证明签名者遵守游戏规则。
- 平台账号身份能减少冒充，不能阻止账号本人发送伪造游戏指令。
- 不开源、混淆、反调试只能提高成本，不能成为状态可信的基础。

因此目标应从“让本地数据不可修改”调整为“本地修改不产生权威效果，而且异常会被全体检测”。

### 5.2 第一版可落地的约束

1. 客户端无权提交 `result/statePatch/resourceAfter/randomResult`，只提交白名单意图。
2. 每个赛季在创作者置顶/首条控制评论中登记 `seasonId`、规则版本、程序哈希、权威账号和权威公钥。
3. 玩家设备首次加入时登记 Ed25519 公钥；本赛季设备换绑必须由旧设备或权威端签名。
4. 所有事件使用规范 JSON、连续序号、哈希链、签名、幂等键和非重复随机数。
5. 所有影响胜负的计时以平台事件时间和权威修正时间为准，不使用客户端系统时钟。
6. 随机战斗采用多方 `commit-reveal` 种子；缺席者超时后使用其承诺哈希作为替代种子，并固定惩罚，减少最后出种子者选择结果的空间。
7. 公开状态由纯确定性归约器计算；不同客户端的 `stateHash` 不一致时冻结该 revision 并展示分歧证据。
8. 权威端定期签名快照；至少两个在线观察端回签已见 revision，减少权威端向不同玩家展示不同历史的空间。
9. 程序包和规则版本固定到赛季；热修复需要公开迁移事件，普通更新默认用于新赛季。
10. 限制单账号/设备的事件速率、评论分片数、待确认操作数、模型调用数和单包解压大小。

### 5.3 仍然存在的信任点

在“不增加外部服务”的前提下，本局权威端仍是信任点。若服主运行修改版，它可以拒绝玩家、偏置合法但可选择的决策，或停止签发新状态。哈希链能留下证据，不能强迫其公平或保持在线。

可选的第二阶段是 2/3 多签权威：从三名裁判/服主中收集两个相同状态哈希的签名才确认事件。它降低单一恶意服主的影响，但增加等待时间和掉线处理复杂度。第一版建议单权威 + 多客户端审计，协议中预留 `authorityPolicy`。

## 6. 游戏宿主 SDK 草案

```ts
interface FengyueWorldSdk {
  runtime: {
    getInfo(): Promise<{
      runtimeVersion: string; gameId: string; workId: string; seasonId: string;
      accountId: string; isAuthority: boolean; programHash: string;
    }>;
  };
  publicLedger: {
    submitIntent(type: string, payload: unknown, idempotencyKey: string): Promise<{ eventId: string }>;
    readSnapshot(): Promise<{ revision: number; state: unknown; stateHash: string }>;
    subscribe(handler: (event: unknown) => void): () => void;
  };
  privateState: {
    read<T>(namespace: string): Promise<{ revision: number; value: T } | null>;
    submitIntent(type: string, payload: unknown, idempotencyKey: string): Promise<{ privateRevision: number; commitment: string }>;
  };
  direct: {
    send(accountId: string, type: string, payload: unknown): Promise<{ messageId: string }>;
    subscribe(handler: (message: unknown) => void): () => void;
  };
  model: {
    request<T>(request: { task: string; schemaVersion: string; input: unknown; idempotencyKey: string; timeoutMs?: number }):
      Promise<{ requestId: string; result: T; usage?: { points?: number } }>;
    cancel(requestId: string): Promise<void>;
  };
}
```

SDK 不暴露通用 `fetch`、`ipcRenderer`、文件路径、Token、Cookie、平台 `chatId` 或评论删除能力。宿主对每个调用执行 Schema 校验、权限检查、配额、超时和审计记录。

## 7. 世界书和模型路由

每种模型任务使用稳定机器标记：

```text
[[FYOW:TASK:combat.resolve:v1]]
[[FYOW:TASK:farm.harvest:v1]]
[[FYOW:TASK:story.next:v1]]
```

主提示词保存世界观和共同输出规则；世界书条目只保存对应任务的职责、输入/输出 Schema 和错误格式。请求和返回都使用带版本 JSON，模型结果先经过 Schema 和业务规则校验，再由权威端形成事件。模型文本永远不直接作为可执行 HTML/JS。

同一局只由权威端串行请求模型。访客请求先变成 `model-intent`；权威端执行一次并广播结果，避免多客户端重复计费和分叉。重试复用相同幂等键，自动重试最多一次。

## 8. 本轮真实测试

测试程序：`scripts/live-online-world-platform.cjs`。账号和密码只从进程环境变量读取，程序不打印、不写文件、不缓存 Token；两个账号使用独立且在结束时清空的 Electron 会话分区。

### 8.1 创作与保存

- 通过“高级创作”创建作品 `3c18ed97-f452-457a-9d66-5922f4fbc3d7`。
- 填写作品名、惰性程序信封形式的详细介绍、前置词、提示词、后置词。
- 新增关键词 `[[FYOW:TASK:probe:v1]]`，将触发范围显式设为“用户”。
- 向真实 `model-config` 保存接口提交；HTTP 200，结果“成功”。
- 从 `model-config/export` 回读到相同内容，世界书 `key_region=2`、`enable=true`、`probability=100`。
- 测试作品未发布，没有改变公开作品列表。

### 8.2 评论、回复和私信

在通讯测试作品上使用两个真实账号完成：

- 账号 A 发送带唯一测试标记的根评论，账号 B 回读到相同内容和评论 ID。
- 账号 B 回复根评论，账号 A 从评论分支回读到相同回复。
- 账号 B 根据账号 A 的平台账号 ID 建立/复用私信会话并发送消息，账号 A 回读到相同内容。
- 测试内容均带 `FYOW-COMMS-...` 自动联调标记，保留作平台侧可核对记录。

### 8.3 模型和世界书

发送内容：

```text
[[FYOW:TASK:probe:v1]]
{"schema":"fyow.model-request/1","input":{"probe":"world-book"}}
```

实际 SSE 返回：

- `conversation_id`: `5ae34409-8bc7-4d18-aece-a027b7ce3f21`
- `message_id`: `dd6d0ad8-e8b4-4787-8950-3b27ec8532ef`
- `task_id`: `fc1bf78e-b0da-40f4-91a2-568d43509b33`
- 正文：`{"worldBook":"matched","version":1}`
- 延迟：约 `12.786 s`
- 用量：提示 143 token，完成 1180 token，总计 1323 token；平台元数据记为 0 积分

这证明“用户输入机器关键词 → 用户范围世界书 → 模型请求 → SSE 返回”在创作调试链路中成立。创作调试对话没有出现在已安装作品的会话列表，这是平台两条链路的差异，不能把调试会话当正式玩家存档。

### 8.4 登录域名历史样本

| 域名 | 中位数 | 最快–最慢 |
|---|---:|---:|
| `aquantancee.xyz` | 1017 ms | 909–3506 ms |
| `aiwhatis.xyz` | 1144 ms | 1135–1502 ms |
| `aquante.xyz` | 1384 ms | 1004–2606 ms |
| `ai-xan.xyz` | 1447 ms | 926–2147 ms |
| `affectional.xyz` | 1524 ms | 1135–2390 ms |
| `acquainte.xyz` | 1556 ms | 1184–1629 ms |
| `acepro.store` | 1637 ms | 954–2964 ms |
| `acquant.xyz` | 2080 ms | 1378–2375 ms |

节点排名不能永久缓存。自动登录应在每次需要登录时用 Electron 自身网络栈重新测量，按本次结果从低到高尝试，登录失败再切换下一个节点。

## 9. 下一阶段任务安排

### 阶段 A：冻结协议与程序信封

1. 定义 `fyow.program/1`、`fyow.event/2`、`fyow.direct/2` JSON Schema。
2. 做详细介绍提取器、大小/分片限制、哈希和 Ed25519 验签。
3. 用一个已发布的专用测试作品完成第二账号下载同一程序信封的验收。
4. 冻结作者密钥、赛季密钥和设备换绑流程。

### 阶段 B：只读沙箱原型

1. 建立无网络、无 Node 的游戏运行视图。
2. 实现 `runtime.getInfo` 和只读 `publicLedger.readSnapshot`。
3. 用纯本地格子地图展示从固定事件日志归约出的状态。
4. 验证恶意程序包、超限解压、路径穿越、无限循环和资源耗尽处理。

### 阶段 C：单权威评论账本

1. 实现评论分页游标、分支读取、分片、去重、重试和哈希链。
2. 实现玩家设备公钥登记、赛季权威签名和快照。
3. 双账号测试断线重连、重复事件、乱序、删除/缺页和状态哈希分歧。
4. 先只开放公开棋盘移动与占领，不加入私人资源。

### 阶段 D：私人状态与一对一通讯

1. 加入玩家/权威双收件人密文保管箱。
2. 加入训练承诺、完成揭示和部署公开流程。
3. 封装风月私信为 `direct` SDK，验证拉黑、会话不存在、重复消息和换账号。
4. 明确哪些私人数据会被服主看到，并在游戏入口展示规则。

### 阶段 E：模型与首张游戏

1. 封装正式已安装作品的模型请求、SSE、停止、预算和幂等重试。
2. 为战斗、将领对话、随机剧情分别建立世界书机器路由。
3. 模型结果通过 Schema 和确定性规则校验后才写入账本。
4. 制作“站格子—发育—扩张”最小版本，再加入俘虏书信等私信玩法。

### 阶段 F：产品入口

前述夹具通过后，再在“联机同乐”和“编辑个人设定”之间加入“在线游戏世界”。第一版入口包含：作品链接安装、程序版本/作者指纹、权限清单、更新/回滚、选择赛季、数据同步状态和异常账本提示。

## 10. 当前未闭合问题

1. 需要一个允许发布的专用测试作品，验证普通玩家从 `installed-apps` 详情读取详细介绍程序信封；本轮按要求只保存，没有发布。
2. 需要测量详细介绍的最大可保存/可读字符数、HTML 归一化规则和 Base64URL 长文本是否被截断。
3. 需要测量评论最大正文、分页稳定性、作者删除后的表现、折叠评论是否仍可通过 API 读取。
4. 风月私信是账号级通道而非作品内物理存储；必须在“严格单作品密文评论”与“逻辑绑定的私信体验”之间做产品选择。
5. 没有额外可信服务时，恶意权威端和本地程序修改只能被审计、隔离影响，不能获得绝对公平保证。第一版应把规则设计成确定、公开、可复算，并把服主的可选择空间压到最小。
