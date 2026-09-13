# “在线游戏世界”准备方案与实测记录

> 状态：已完成主界面入口、首款游戏前端、固定伴生作品的整包游戏卡、受控详情程序包、FYOW/3 评论协议、分页读取、地图增量同步、玩家本地私有数据、私信唤醒、真实时间规则引擎及将领世界书同步。评论区只追加领地、驻军与部署将领档案；私人保管箱、行动事件、入场答案和其他玩家位置均不上传。
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
4. 公共地图基线和领地增量放在该作品的评论区；不上传行动请求、行动事件、在线状态或玩家位置。
5. 私人状态、行动事件、性取向、人物词条和初始良将描述只保存在当前玩家工具本地；本地副本是唯一存档，不再生成私人保管箱评论。
6. 一对一消息使用风月私信，所有消息都绑定 `workId + seasonId + gameId`。如果要求物理上所有数据都处在同一作品下，则改用评论区密文回复，不能同时依赖平台私信。
7. 游戏前端通过固定 SDK 在宿主内执行本机行动；只有行动造成公开格子、驻军或已部署将领变化时，宿主才生成签名地图增量。

### 1.1 游戏卡整包格式

当前固定格式是 `fyow.game-card/1`。整包至少包含 `cardId`、`gameId`、版本、唯一伴生作品的 `origin/workId/installedUrl/configurationUrl/authorAccountId`、完整创作页配置快照、程序摘要、配置摘要和整包摘要。导入时按以下顺序拒绝不一致内容：整包 Schema → 卡与游戏编号 → HTTPS 作品来源 → 作品 ID 与配置 `app.id` → 作者账号声明与平台 `created_by_account_id` → 配置 SHA-256 → 详细介绍程序信封 → `gameId`/宿主 API/程序摘要 → 整包 SHA-256。

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
  "title": "猎艳疆土",
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

### 4.1 公开数据：只追加领地地图变更

评论区不再保存玩家行动请求、行动结果事件、在线状态或完整私人状态。公共账本只在格子归属、驻军、格子内已部署将领发生实际变化时追加 `fyow.map-delta/1`；开采、金币、训练队列、行军途中位置、性取向、随行将领和普通对话不会产生评论。

```json
{
  "schema": "fyow.map-delta/1",
  "mapDeltaId": "UUID",
  "gameId": "cc.aiero.fyow.grid-conquest",
  "workId": "WORK_ID",
  "seasonId": "SEASON_ID",
  "actorAccountId": "PLATFORM_ACCOUNT_ID",
  "participant": { "displayName": "玩家公开名" },
  "changes": {
    "cells": {
      "4,7": { "ownerAccountId": "PLATFORM_ACCOUNT_ID", "soldiers": 200, "generalIds": [] }
    },
    "generals": {}
  },
  "deviceSigningPublicKey": "ED25519_PUBLIC_KEY",
  "deviceEncryptionPublicKey": "X25519_PUBLIC_KEY",
  "signature": "ED25519_SIGNATURE"
}
```

变更记录本身不携带可由客户端伪造的行动时间。宿主使用评论接口返回的 `created_at` 作为唯一公共顺序；时间戳完全相同才用评论 ID 做稳定次序。客户端对每个格子和已部署将领分别记录最后一次已应用顺序，因此迟到的旧评论不会覆盖新领地，无关格子的迟到评论仍能补齐。每条玩家地图记录还携带服务端公共状态中的 `playerEpoch`；服主重置玩家时世代号递增，旧世代评论永久失效。初始、迁移和压缩快照只包含公共格子、公开参与者通讯密钥、封禁状态、玩家世代号及已部署将领，不含其他玩家位置、加入时间、金币、队列或随行将领。在线服主每观察到 32 条地图增量会自动发布覆盖快照，任何玩家重置/封禁/解封后也立即发布；读取端组装出最新完整快照后停止向旧页翻页。

### 4.2 私人数据：工具本地存档

每名玩家的性取向、金币、开采/训练/行军队列、行军位置、随行与未部署将领、将领私人记忆和行动历史只保存在该玩家工具的本地在线世界缓存中。评论区不再生成 `fyow.private-vault/3`、`fyow.intent/3` 或 `fyow.event/3` 新记录；旧赛季中已经存在的记录只作为历史残留，不参与新版地图归并。

本地数据丢失就等同于私人进度丢失，因此后续若需要换机，应该单独增加由玩家主动执行的本地导出/导入，不把私人内容重新塞回公共评论。这个取舍显著减少评论量并保护性取向等隐私，但公开地图只能确认“哪个平台账号签署了哪次领地变化”，不能从公共评论证明其本地金币和计时数据没有被修改。

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

私信不得直接改变公开地图。任何领地变化都必须另行发布签名地图变更，私信内容本身不参与地图归并。

### 4.4 伴生作品作者服主指令

每张游戏卡的 `companion.authorAccountId` 是作者账号绑定；宿主打开卡后再次读取作品 `created_by_account_id`，只有两者相同的账号才显示游戏内左上角“服主指令”。服主指令统一经过作者密钥签名并写入 `fyow.authority/1`：

- `open-server`：创建赛季控制记录和公共快照；未开服时作者可进入游戏壳层直接操作，普通玩家停留在游戏库。
- `migrate-server`：迁移并重置服务器，完整复制创作页配置与公共快照，在旧作品留下定向迁移记录。
- `player-reset`：从当前或历史玩家中选取目标（包括作者自己），清除领地、部署档案、本地私有数据并递增 `playerEpoch`；旧记录和旧缓存均被视为废弃，目标下次进入必须重新回答四问。
- `player-ban` / `player-unban`：显示玩家名、风月账号名和风月账号 ID，封禁/解封状态公开写入作者快照。封禁期间该账号不能创建角色，所有地图操作、指令和私信唤醒由其他客户端忽略；解封不会自动恢复被重置的数据。

宿主接收游戏卡前端的 `type: "admin"` 消息，负责确认窗口、作者身份、签名、评论上传和结果回传。游戏卡不得在前端自行判断作者或直接调用平台 Token。

## 5. 作弊边界与减轻方式

### 5.1 必须接受的事实

- 玩家控制自己的电脑，所以本地文件、内存、时钟、渲染结果和下载后的游戏代码都可能被改。
- 本地加密只能阻止别人读取；持有密钥的玩家仍可修改明文并重新加密。
- 数字签名能确认“哪个密钥签了什么”，不能证明签名者遵守游戏规则。
- 平台账号身份能减少冒充，不能阻止账号本人发送伪造游戏指令。
- 不开源、混淆、反调试只能提高成本，不能成为状态可信的基础。

当前版本选择“私人进度本地化、公共领地可收敛”：所有客户端能确定同一张地图，但不再承诺从评论区验证金币、计时队列或未部署将领的真实性。

### 5.2 第一版可落地的约束

1. 每个赛季在作者控制评论中登记 `seasonId`、规则版本、程序哈希、作者账号和公钥。
2. 地图变更必须由发布评论的平台账号设备密钥签名，评论作者账号必须与 `actorAccountId` 相同。
3. 地图变更只能写入合法坐标，驻军不得超过该格固定人口的 20%，每格公开将领不超过两名。
4. 客户端完全忽略记录内部自报的行动时间，只按平台评论 `created_at` 排序。
5. 同一格子的较新变更覆盖较旧变更；不同格子的变更分别归并，分页延迟不会导致无关领地丢失。
6. 公共快照删除其他玩家位置、加入时间和全部私人字段，只作为读取加速基线。
7. 程序包和规则版本固定到赛季；热修复需要作者签名启用或迁移到新作品。
8. 对单次地图变更的格子数、将领数、评论分片数和解压大小设置上限。

### 5.3 仍然存在的信任点

在不增加外部服务且不公开私人行动凭证的前提下，平台账号签名只确认地图变更来源，不能证明该玩家本地确实拥有足够金币、兵力或等待了规定时间。若以后重新把严格反作弊作为首要目标，就需要恢复权威操作验证或引入额外可信服务；这与本轮“评论区只保存领地变化”的目标是明确取舍关系。

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
    publishMapDelta(changes: unknown): Promise<{ mapDeltaId: string }>;
    readSnapshot(): Promise<{ revision: number; state: unknown; stateHash: string }>;
    subscribe(handler: (mapDelta: unknown) => void): () => void;
  };
  privateState: {
    read<T>(namespace: string): Promise<{ revision: number; value: T } | null>;
    write<T>(namespace: string, value: T): Promise<{ revision: number }>;
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

主提示词保存世界观和共同输出规则；世界书条目只保存对应任务的职责、输入/输出 Schema 和错误格式。请求和返回都使用带版本 JSON，模型结果先经过 Schema 和本机业务规则校验；只有结果实际部署到领地时才随地图变更公开。模型文本永远不直接作为可执行 HTML/JS。

模型请求由当前玩家工具发起，结果先保存在该玩家本地。重试复用相同幂等键，自动重试最多一次；未部署将领和私人对话不会广播到评论区。

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

- 作品名 `猎艳疆土[b27218e680f94c0d]`，其中方括号内为从固定作品 UUID 派生的 16 位实例 ID；简介、前置词、世界观提示词和后置词均为本仓库固定模板。
- “详细介绍”保存 23,775 字符的 `FYOW-PROGRAM/1` 信封，程序 SHA-256 为 `5b4392a015fa5c71b49bf87a08daae8dfdb656b519ab5d914371c6102c67f1fe`。
- 将领生成、普通将领互动和俘虏将领互动三个世界书均为 `key_region=2`、`enable=true`、`probability=100`。
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
| FYOW/3 评论分片、重组、签名 | `electron/online-world-protocol.cjs` | 已实现，单条硬限制 1000 字符；含作者管理记录 `fyow.authority/1` |
| 玩家设备加密身份 | `electron/online-world-crypto.cjs` | Ed25519 + X25519/HKDF/AES-256-GCM |
| 评论分页、地图增量归并、私信唤醒 | `electron/online-world-service.cjs` | 已实现本地与模拟平台测试 |
| 游戏卡整包、固定作品/作者绑定与摘要校验 | `electron/online-world-card.cjs` | 已实现内置卡、导入/导出、配置快照、作者回读匹配与迁移重绑定 |
| 64×64 规则引擎 | `electron/grid-world-game.cjs` | 已实现固定格子、计时、经济、战斗、将领与记忆 |
| 游戏前端 | `electron/desktop/online-world/grid-conquest/` | 已实现四问入场、ACG 词条、地图缩放/拖动、计时任务、行军队伍、随行/部署/俘虏将领、互动、来信箱与作者专属服主指令 |
| 产品入口 | `electron/desktop/index.html`、`renderer.js` | 已加入“联机同乐”和“编辑个人设定”之间；玩家选择/导入卡名，不填写作品地址 |
| 伴生作品填写稿与保存经验 | `docs/grid-conquest-companion-work.md`、`docs/aiero-creation-page-save-experience.md` | 已保存到固定作品并完成导出回读 |

程序生成命令是 `npm run game:bundle`。当前实现每 5 秒同步；打开游戏及其后每小时会用风月账号接口响应的 HTTP `Date` 校准现实时间，校准间隔内按单调经过时间推进。每个玩家在本机结算自己的到期任务并保存行动事件；只有领地、驻军或已部署将领发生变化时才发布签名 `fyow.map-delta/1`。公共快照仅作地图读取加速基线，不含金币、私人任务、行军位置、性取向、随行将领或行动历史。

## 10. 接下来的验收与增强顺序

1. 在固定伴生作品 `b27218e6-80f9-4c0d-91c7-4b8f87d47be8` 保存《猎艳疆土》程序信封、世界观和三个用户范围世界书，随后用完整游戏卡导出回读并对比摘要。
2. 第二账号从 `installed-apps/{workId}` 下载同一信封，完成“作者初始化 → 玩家加入 → 本机行动 → 领地增量 → 另一客户端回读”完整赛季。
3. 制造 100 页以上的夹具账本，测试完整快照提前终止、跨页分片、评论删除、折叠、乱序和重复事件；当前单元测试已覆盖分片/摘要与基础提前终止，尚缺真实百页压力测试。
4. 实测个人“自定义配置”世界书的跨账号隔离以及部署移除/召回恢复；当前代码会在变化后回读确认，但仍需要真实页面的字段兼容验收。
5. 实测迁移作品的全字段兼容。当前流程会导出 JSON、创建新作品、映射并保存配置、回读核对核心字段、改名并回读旧作品，在新作品写入控制/地图快照，最后才在旧作品发布签名定向迁移；客户端看到指令后自动切换。平台导出字段与保存体字段并不完全同构，所以任一回读不一致都会停在“迁移草稿”而不发布重定向。该映射尚未在真实首张作品上完成验收，且新作品是否仍需创作页手动发布取决于平台当前可见性规则。
6. 增加本地存档导出/导入和损坏修复提示。当前私人进度只在本机保存，换机或清理应用数据前需要玩家主动备份。
7. 继续增加全作品级评论积压上限和程序 CPU/内存卡死监控。评论读取与地图增量归并已经按平台时间戳排序；定向消息有每分钟 12 次发送限制及每发送者每分钟 20 次接收限制。iframe 已断网隔离，但 JavaScript 无限循环仍需要独立可销毁执行进程才能可靠恢复。
8. 增加设备换绑/恢复流程。当前赛季会把平台账号和首次加入时的 Ed25519 设备密钥固定绑定；重装系统或丢失 Windows 加密密钥后，新密钥提交会被拒绝，需要由旧设备或作品作者签名换绑，相关界面尚未加入。

## 11. 已知信任边界

风月评论和私信没有服务器端游戏事务，因此本轮采用“本地私有进度、评论区公共领地”的取舍。玩家修改本地前端、本机时间或缓存可以改变自己的金币、队列和私人记忆；平台签名只能证明某个账号发布了某次地图变更，不能证明其本地资源和等待时间。客户端仍会验签、按平台时间归并并记录异常证据；若以后需要严格反作弊，需要恢复权威操作验证或引入额外可信服务。

私信是账号级通道而非作品内物理存储。当前方案按用户要求用玩家根评论的回复先发布 `DMWAKE`，接收端只读取对应发送者的会话；私信信封绑定 `workId + seasonId + gameId`，但其密文字节仍位于风月私信系统。需要物理上全部落在作品评论树时，可把同一密文信封直接放到评论回复，代价是更高评论量和所有旁观者都能看到密文。
