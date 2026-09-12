# “在线游戏世界”准备方案与实测记录

> 状态：已完成主界面入口、首款游戏前端、固定伴生作品的整包游戏卡、受控详情程序包、FYOW/3 评论协议、分页快照、玩家/权威双收件人私人保管箱、私信唤醒、真实时间规则引擎及将领世界书同步的本地实现；固定伴生作品的程序与世界书已保存并回读，创作页保存、模型请求、双账号评论/回复/私信的真实链路测试均已通过。完整多人赛季仍待发布前验收。
>
> 最近实测：2026-09-13（Asia/Shanghai）
>
> 通讯测试作品：`4ac2ab60-67ff-459d-ae9a-6274f1802195`
>
> 创作测试作品：`3c18ed97-f452-457a-9d66-5922f4fbc3d7`，名称 `FYOW 在线游戏世界接口联调`，保持未发布
>
> 首张游戏卡伴生作品：`b27218e6-80f9-4c0d-91c7-4b8f87d47be8`，一张卡固定绑定这一作品；玩家侧没有作品 ID 输入项

## 1. 本轮结论

“在线游戏世界”采用“工具内的受控游戏运行时 + 一张游戏卡固定绑定一个风月伴生作品”。本地导入的是完整游戏卡包，而不是让每名玩家填写伴生作品 ID；卡包同时保存固定作品引用、详细介绍中的程序信封、前置词/提示词/后置词、世界书配置快照及多层摘要。普通玩家导入一次卡包后，只选择卡名进入。

建议冻结以下职责边界：

1. 一张游戏卡只绑定一个服务全体玩家的伴生作品；作品 ID 不是玩家个人配置。
2. 伴生作品的“详细介绍”保存惰性编码的游戏程序包及清单，服主修改作品即可发布新程序版本。
3. 工具下载原始详细介绍、提取程序、校验清单和作者签名，然后在隔离 `WebContents` 中运行。
4. 公开世界状态、操作事件和快照放在该作品的评论区。
5. 私人状态以密文形式锚定到评论账本，由本局权威端验证并签名；本地副本只作缓存。
6. 一对一消息使用风月私信，所有消息都绑定 `workId + seasonId + gameId`。如果要求物理上所有数据都处在同一作品下，则改用评论区密文回复，不能同时依赖平台私信。
7. 游戏前端只提交“意图”，不提交“执行后的结果”；状态归约、合法性检查、平台通讯和模型调用全部由工具宿主完成。

### 1.1 游戏卡整包格式

当前固定格式是 `fyow.game-card/1`。整包至少包含 `cardId`、`gameId`、版本、唯一伴生作品的 `origin/workId/installedUrl/configurationUrl`、完整创作页配置快照、程序摘要、配置摘要和整包摘要。导入时按以下顺序拒绝不一致内容：整包 Schema → 卡与游戏编号 → HTTPS 作品来源 → 作品 ID 与配置 `app.id` → 配置 SHA-256 → 详细介绍程序信封 → `gameId`/宿主 API/程序摘要 → 整包 SHA-256。

导出由作品作者在已打开游戏卡中执行。工具实时调用 `model-config/export` 回读创作页，而不是把本地模板冒充远端内容；生成的 `.fyow-card.json` 因而同时是可导入卡包和伴生作品配置备份。卡包只含公开的创作配置，不含账号令牌、Cookie、密码、设备私钥或玩家私人数据。

导入只安装卡包并锁定它指定的伴生作品，不会为玩家复制作品，也不会把配置写回平台。作者签名迁移指令是唯一允许更新该绑定的运行时路径；迁移后工具原子更新本地卡库，再从新作品继续同步。

评论区适合增量、回合制、农场/攻城、随机文字冒险等低频游戏，不适合动作游戏或秒级 PvP。既有五次公开读取样本为 `1561 / 913 / 5630 / 892 / 896 ms`，中位数 `913 ms`，长尾达到 `5.630 s`。

## 2. 作品中的程序分发

### 2.1 为什么不能直接保存可执行标签

创作页明确拦截 `<script>`、`<iframe>`、`<object>` 等潜在可执行标签。测试程序因此采用不会在风月网页中执行的惰性载荷：

```text
[[FYOW-PROGRAM/1:SHA256:BASE64URL_GZIP_MANIFEST]]
```

工具读取的是接口返回的原始详细介绍，不从渲染后的 DOM 复制代码。详细介绍只充当分发载体；解码后的代码由工具自己的运行时执行。

### 2.2 程序信封

第一版已经采用单个 Base64URL 文本信封，清单压缩前结构为：

```json
{
  "format": "fyow.program/1",
  "gameId": "cc.aiero.fyow.grid-conquest",
  "title": "艳猎征途",
  "apiVersion": 1,
  "html": "SELF_CONTAINED_HTML"
}
```

宿主处理顺序固定为：读取原文 → 提取唯一信封 → Base64URL 解码 → 限制 256 KiB 压缩包与 1 MiB HTML → SHA-256 → 检查游戏 ID/API → 对照作者签名控制记录中的程序哈希 → 强制覆盖 CSP → Blob URL → 启动沙箱。

运行环境为 `iframe sandbox="allow-scripts"`，没有 `allow-same-origin`、Node、Cookie/Token、文件系统或任意网络；强制 CSP 将 `connect-src`、frame、worker、object、base 和 form 全部关闭。游戏代码只通过固定 `postMessage` 提交意图，父页面还会核对 `event.source`。

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

创作页实际提交使用稳定的完整字段；`model-config/export` 则会在每次读取时从同义别名中选择键名。工具不能把某一次导出的缩写写死。2026-09-13 连续 20 次回读观察到的核心映射如下：

| 页面字段 | 保存体字段 | 已观察到的导出别名 |
|---|---|---|
| 作品名称 | `app.name` | `name / nm / ttl / title / app_name` |
| 简介 | `app.summary` | `summary / smry / abs_txt / sum_info / abstract` |
| 详细介绍 | `app.description` | `description / desc / descr / dsc / intro` |
| 前置词 | `pre_text` | `pre_text / pre_tx / pretxt / ptx / prefix_txt` |
| 提示词 | `pre_prompt` | `pre_prompt / pre_pt / prpt / ppt / prompt_pre` |
| 后置词 | `post_text` | `post_text / post_tx / posttxt / potx / suffix_txt` |
| 世界书 | `world_book` | `world_book / world_bk / wbook / lore_bk / wb` |

作品名也会使用 `name / nm / ttl / title / app_name`。保存体的 `app.summary`、`app.language` 和 `app.gender` 当前均是后端必填项，即使页面把简介写成“选填”；缺失时服务器会依次返回“缺少应用简介”“缺少语言设置”“缺少作品面向群体”。工具导出整卡时会保留完整原始配置，再建立稳定的规范化核心字段和摘要。

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

固定伴生作品 `b27218e6-80f9-4c0d-91c7-4b8f87d47be8` 又在 2026-09-13 完成一次正式配置保存：

- 作品名 `艳猎征途[b27218e680f94c0d]`，其中方括号内为从固定作品 UUID 派生的 16 位实例 ID；简介、前置词、世界观提示词和后置词均为本仓库固定模板。
- “详细介绍”保存 13,870 字符的 `FYOW-PROGRAM/1` 信封，程序 SHA-256 为 `0b6523b9c5c1ef9783cfd2ce13af0031a98d66ea960ed8971121d235ec74e231`。
- 将领生成和将领对话两个世界书均为 `key_region=2`、`enable=true`、`probability=100`。
- 保存接口 HTTP 200，随后导出接口 HTTP 200；上述七项逐一比对全部通过。
- 具体操作和平台字段经验见 `docs/aiero-creation-page-save-experience.md`。

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

## 9. 当前实现清单

| 部分 | 当前文件 | 状态 |
|---|---|---|
| 程序信封与强制沙箱 CSP | `electron/online-world-runtime.cjs` | 已实现并有摘要/类型/大小/断网测试 |
| FYOW/3 评论分片、重组、签名 | `electron/online-world-protocol.cjs` | 已实现，单条硬限制 1000 字符 |
| 玩家设备加密身份 | `electron/online-world-crypto.cjs` | Ed25519 + X25519/HKDF/AES-256-GCM |
| 评论分页、快照、意图裁决、私信唤醒 | `electron/online-world-service.cjs` | 已实现本地与模拟平台测试 |
| 游戏卡整包、固定作品绑定与摘要校验 | `electron/online-world-card.cjs` | 已实现内置卡、导入/导出、配置快照与迁移重绑定 |
| 64×64 规则引擎 | `electron/grid-world-game.cjs` | 已实现固定格子、计时、经济、战斗、将领与记忆 |
| 游戏前端 | `electron/desktop/online-world/grid-conquest/` | 已实现地图、计时任务、携将行军、将领操作、密谈/书信与来信箱 |
| 产品入口 | `electron/desktop/index.html`、`renderer.js` | 已加入“联机同乐”和“编辑个人设定”之间；玩家选择/导入卡名，不填写作品地址 |
| 伴生作品填写稿与保存经验 | `docs/grid-conquest-companion-work.md`、`docs/aiero-creation-page-save-experience.md` | 已保存到固定作品并完成导出回读 |

程序生成命令是 `npm run game:bundle`。当前实现每 5 秒同步；打开游戏及其后每小时会用风月账号接口响应的 HTTP `Date` 校准现实时间，校准间隔内按单调经过时间推进。作者端在轮询时结算到期任务并发布签名事件、公开快照及受影响玩家的私人保管箱。公开快照不含金币、私人任务、随行将领设定和随行将领 ID；私人包分别密封给玩家设备与作者权威密钥。

## 10. 接下来的验收与增强顺序

1. 在固定伴生作品 `b27218e6-80f9-4c0d-91c7-4b8f87d47be8` 保存首张游戏程序信封、世界观和两个用户范围世界书，随后用完整游戏卡导出回读并对比摘要。
2. 第二账号从 `installed-apps/{workId}` 下载同一信封，完成“作者初始化 → 玩家加入 → 评论意图 → 作者裁决 → 玩家回读”完整赛季。
3. 制造 100 页以上的夹具账本，测试完整快照提前终止、跨页分片、评论删除、折叠、乱序和重复事件；当前单元测试已覆盖分片/摘要与基础提前终止，尚缺真实百页压力测试。
4. 实测个人“自定义配置”世界书的跨账号隔离以及部署移除/召回恢复；当前代码会在变化后回读确认，但仍需要真实页面的字段兼容验收。
5. 实测迁移作品的全字段兼容。当前流程会导出 JSON、创建新作品、映射并保存配置、回读核对核心字段、改名并回读旧作品、在新作品写入控制/快照/全员私人保管箱，最后才在旧作品发布签名定向迁移；客户端看到指令后自动切换。平台导出字段与保存体字段并不完全同构，所以任一回读不一致都会停在“迁移草稿”而不发布重定向。该映射尚未在真实首张作品上完成验收，且新作品是否仍需创作页手动发布取决于平台当前可见性规则。
6. 为权威端增加离线提醒或候补权威。当前所有现实时间结算以作者端宿主时间为准；作者端离线期间客户端可显示倒计时，但公开结果要等权威端恢复后确认。
7. 继续增加全作品级积压上限和程序 CPU/内存卡死监控。当前普通行动在提交端及权威端均限制为每账号每分钟 30 次，权威轮询单轮最多处理 60 条；将领模型对话另有 15 秒权威状态冷却，定向消息有每分钟 12 次发送限制及每发送者每分钟 20 次接收限制。iframe 已断网隔离，但 JavaScript 无限循环仍需要独立可销毁执行进程才能可靠恢复。
8. 增加设备换绑/恢复流程。当前赛季会把平台账号和首次加入时的 Ed25519 设备密钥固定绑定；重装系统或丢失 Windows 加密密钥后，新密钥提交会被拒绝，需要由旧设备或作品作者签名换绑，相关界面尚未加入。

## 11. 已知信任边界

风月评论和私信没有服务器端游戏事务，因此“不增加额外服务”意味着作品作者的权威端必须在线裁决。玩家修改本地前端、本机时间或缓存只会改变自己的显示，无法生成通过权威签名的地图快照；作者本人仍持有权威密钥，可以停服、删帖或签署偏置状态。客户端验签和缓存能够提供不一致证据，但不能迫使作者公平或在线。

私信是账号级通道而非作品内物理存储。当前方案按用户要求用玩家根评论的回复先发布 `DMWAKE`，接收端只读取对应发送者的会话；私信信封绑定 `workId + seasonId + gameId`，但其密文字节仍位于风月私信系统。需要物理上全部落在作品评论树时，可把同一密文信封直接放到评论回复，代价是更高评论量和所有旁观者都能看到密文。
