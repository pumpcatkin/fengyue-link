# 在线游戏世界通讯接口总表

> 当前宿主协议：`fyow-host/1`  
> 当前公共评论编码：`§FYOW3§`  
> 游戏：`cc.aiero.fyow.grid-conquest`（猎艳疆土）  
> 更新日期：2026-09-14

本文是游戏前端、桌面宿主、风月平台评论区/私信和伴生作品模型之间的通讯单一索引。游戏程序始终运行在断网沙箱中，不接触账号令牌、Cookie、平台接口或文件系统；所有外部通讯都必须交给桌面宿主。

## 1. 完整链路

```text
游戏单文件前端
  └─ postMessage / fyow-host/1
      └─ 桌面渲染层
          └─ 受信 IPC
              └─ OnlineWorldService
                  ├─ /console/api/comments/*      公共地图账本
                  ├─ /console/api/chats/*         加密将领书信
                  ├─ /go/api/apps/chat-messages  伴生作品模型
                  ├─ /console/api/apps/*          作品配置与迁移
                  └─ /go/api/account/profile      平台时间校准
```

状态职责固定如下：

- 评论区：公共领地、驻军、已部署将领档案、服主封禁/重置/搬迁指令。
- 平台私信：由将领互动触发的一对一加密书信正文。
- 本地存档：金币、玩家位置、行军队伍、任务、性取向、性癖标签、未部署将领、私人互动历史和待重试模型任务。
- 伴生作品模型：玩家设定整理、将领生成、普通互动、俘虏互动、记忆压缩等结构化任务；模型不保存权威游戏状态。

## 2. 游戏前端与桌面宿主

### 2.1 请求信封

```json
{
  "source": "fyow-grid-conquest",
  "protocol": "fyow-host/1",
  "type": "intent",
  "requestId": "UUID",
  "intent": {}
}
```

宿主同时校验：消息必须来自当前游戏 iframe、`source` 和 `protocol` 必须精确匹配、需要回包的请求必须带 UUID、序列化后不得超过 128 KiB。游戏前端也只接收 `event.source === parent` 的宿主回包。

需要回包的类型：

| type | 载荷 | 用途 |
| --- | --- | --- |
| `intent` | `intent` | 提交一项本机游戏行动 |
| `preferences` | `preferences` | 保存本机性取向和性癖标签 |
| `admin` | `command` | 作品作者执行开服、迁移、重置、封禁与解封 |
| `direct` | `message` | 预留的受控定向消息入口；猎艳疆土界面没有手动发送框 |

不需要业务回包的类型：

| type | 用途 |
| --- | --- |
| `ready` | 前端启动完成，请求宿主推送完整状态 |
| `library` | 返回在线游戏世界游戏库 |

### 2.2 回包信封

```json
{
  "source": "fengyue-host",
  "protocol": "fyow-host/1",
  "type": "result",
  "requestId": "与请求相同的 UUID",
  "result": {}
}
```

失败时 `type` 为 `error`，正文为 `message`。后台状态推送使用 `type: state`，不带请求号。确认框被用户取消时返回 `{ "cancelled": true }`，确保按钮结束等待状态。

同一前端操作在回包前只允许存在一次；重复点击不会生成第二个行动。服务层还会串行化所有玩家行动，避免评论区同步、模型请求和本地状态同时改写世界。

### 2.3 玩家行动

公开前端可提交：

- `join`
- `start-mining`、`stop-mining`
- `train`、`power-train`
- `march`
- `deploy-general`、`recall-general`、`take-general`
- `talk-general`

宿主内部使用但不接受游戏卡任意构造：

- `record-general-dialogue`
- `surrender-general`
- `grant-general`

每项行动都带 `idempotencyKey`。公共地图写入失败时，世界、本地事件和入场偏好统一回滚；公共地图已经成功提交后，后续将领生成失败会进入本地待重试队列，界面明确显示“领地变化已经生效”，避免玩家重复行动。

## 3. 桌面 IPC

预加载层只向本地受信桌面页面开放以下方法，主进程再次检查 IPC 发送者 URL：

| IPC | 说明 |
| --- | --- |
| `online-world:get-state` | 读取投影后的当前状态 |
| `online-world:list-cards` | 读取本地游戏卡库 |
| `online-world:import-card` / `export-card` | 导入或由作者导出完整卡包 |
| `online-world:open` / `close` | 打开或关闭游戏卡服务 |
| `online-world:initialize` | 作者开服 |
| `online-world:activate-program` | 作者签名启用详细介绍中的新程序 |
| `online-world:sync` | 静默同步评论区、私信唤醒和本地计时任务 |
| `online-world:submit-intent` | 串行执行玩家行动 |
| `online-world:send-direct` | 发送受控将领书信 |
| `online-world:migrate` | 搬迁伴生作品和赛季账本 |
| `online-world:administer` | 玩家重置、封禁和解封 |
| `online-world:update-preferences` | 更新本机性取向与标签 |
| `online-world:state` | 主进程向桌面推送静默状态变化 |

## 4. 评论区公共账本

### 4.1 平台接口

```text
POST /console/api/comments/{workId}/1
GET  /console/api/comments/{workId}/1?page={page}&limit=50&order=desc&filter_type=all
GET  /console/api/comments/branches/{rootCommentId}
```

单条评论最大 1000 字符。记录先做 JSON 规范化、gzip、Base64URL 和 SHA-256，再按 `§FYOW3§类型§记录ID§分片/总数§摘要§内容` 切片。读取端只组装摘要一致且分片完整的记录，最大 512 片、解压后最大 8 MiB。

每个评论分片写入遇到暂时错误时最多重试三次。中途仍失败会让本次公开提交整体失败；残留的不完整分片不会被其他客户端应用。

### 4.2 当前会写入的 Schema

| Schema | 类型 | 内容 |
| --- | --- | --- |
| `fyow.control/3` | `CTRL` | 作者、赛季、程序摘要和权威公钥 |
| `fyow.snapshot/3` | `SNAP` | 作者签名的公共地图覆盖快照 |
| `fyow.map-delta/1` | `MAP` | 一次领地、驻军或已部署将领变化 |
| `fyow.authority/1` | `AUTH` | 作者签名的玩家重置、封禁、解封 |
| `fyow.direct-wake/3` | `DMWAKE` | 回复玩家根评论，通知其读取某条私信 |
| `fyow.reset/3` | `RESET` | 旧作品指向新作品的作者签名搬迁记录 |

`fyow.intent/3`、`fyow.event/3`、`fyow.private-vault/3`、`fyow.general-definition/3`、`fyow.general-memory/3` 和评论内 `fyow.direct/3` 只保留在协议解析器中用于旧记录兼容；当前版本不再写入这些内容。

### 4.3 顺序、覆盖与分页

- 所有玩家操作先后以平台评论时间戳为主、评论 ID 为次序。
- 每个格子、已部署将领和参与者分别保存最后应用顺序，旧记录不能覆盖新记录。
- 封禁账号的地图记录被忽略；玩家重置后旧 `playerEpoch` 的记录被忽略。
- 作者每累计 32 条公共增量写入覆盖快照。客户端读取到完整的新快照后，可以跳过被其完全覆盖的旧页面。
- 平台当前会忽略 `order=desc` 并按旧到新分页，因此客户端先用持久化尾页提示与指数探测定位真实最后一页，再从尾页向第 1 页回扫；不会在旧首页看到快照后误停。每次全量打开还会比较首页与尾页时间戳自动确认分页方向，平台以后恢复真正倒序时会从第 1 页向后扫描。
- 全量读取上限 10000 页；尾页编号和最近 500 个评论 ID 保存在本地，平时只检查尾页附近，在已知记录或覆盖快照处提前停止。跨页分片未组装完整时继续读取更旧页面。

## 5. 一对一将领书信

```text
GET  /console/api/chats?page=1&limit=500
POST /console/api/chats                    { receive_id }
POST /console/api/chats/messages           { chat_id, content }
GET  /console/api/chats/messages?chat_id={id}&page=1&limit=500
```

发送顺序：

1. 验证发信将领正在身边、处于俘虏区，或与玩家同格部署。
2. 验证收件人是该将领档案中存在过的主公。
3. 用接收方设备加密公钥封装正文，并用发送方签名私钥签名。
4. 先在接收方根评论下写入 `DMWAKE` 回复。
5. 再把 `fyow.direct/3` 密文分片写入双方平台私信会话；分片同样最多重试三次。
6. 接收端验证赛季、发送方签名、封禁状态和频率，再解密放入本地收件箱。

限制为每个发送设备每分钟 12 封、每个发送方每分钟最多接收处理 20 个唤醒。书信正文最多 500 字。前端只显示设定名；账号 ID 仅用于路由、签名验证和服主列表。

## 6. 伴生作品模型

```text
POST /go/api/apps/chat-messages
```

请求体由 `createModelRequestPayload` 生成，只传固定伴生作品 ID 和：

```text
[[FYOW:TASK:任务名:v1]]
{"schema":"fyow.model-request/1","input":{...}}
```

每次尝试都不携带旧会话编号；平台必须返回一个从未使用过的新 `conversationId`。工具完整读取事件流直到结束事件，之后才解析 JSON 并向游戏前端回包。单次请求最长等待 180 秒，同一工具实例的模型请求严格串行。五类任务均在失败时最多使用三个全新会话重试，并校验任务各自的 Schema、长度、枚举、数值范围和禁止占位内容。

当前五类任务：

- `player.profile-context`
- `general.generate`
- `general.dialogue`
- `general.captive-dialogue`
- `general.memory.update`

普通/俘虏互动的模型输入不包含玩家账号 UUID、将领内部 ID或私信账号目标。历任主公只以设定名和一次性的 `former-lord-N` 路由键出现；模型若返回书信指令，宿主通过本机保存的路由表换回平台账号后发送。回答、书信和压缩记忆中出现账号 UUID，或模型返回越权指令，都会令本次结果失效并在新会话重试。

模型返回只作为结构化内容，不直接决定金币、领地、兵力、时间或战斗结果。初始将领先返回本地预览，玩家可重抽或编辑，确认后才创建玩家；因此预览失败不会产生需要回滚的公共状态。占地奖励将领在公开地图已经提交后进入本地指数退避队列，30 秒起步、最长 15 分钟，保留稳定发现编号避免重试生成两名将领。

## 7. 创作页与迁移

```text
GET  /console/api/installed-apps/{workId}
GET  /console/api/apps/{workId}/model-config/export
POST /console/api/apps/{workId}/model-config
POST /console/api/apps
```

打开卡时从平台回读作品作者并与游戏卡 `companion.authorAccountId` 对照。迁移时导出旧配置、创建新作品、写入配置、再次导出校验摘要、改名旧作品、在新作品写入控制和快照，最后才在旧评论区发布 `RESET`。任一步回读不一致都不会发布重定向。

## 8. 时间与同步

```text
GET /go/api/account/profile
```

工具使用响应 `Date` 头校准时间，以单调时钟推进本地计时；每小时重新校准。评论区静默同步间隔为 5 秒。同步正在执行或玩家行动正在提交时，新一次同步直接合并到下一轮，避免同时覆盖内存状态。

## 9. 本轮缺陷检查结果

已修复：

- 评论接口按旧到新分页却从第 1 页开始读取，旧快照会让全量与后续轮询长期错过真实尾页。
- 同步失败后仍可能使用旧缓存接受玩家行动，造成“界面能操作、平台没有交互”的假运行状态。
- 部署将领互动的内部记忆记录会先发布一次地图增量，外层互动又重复发布相同变更。
- 互动模型可以看到并返回账号 UUID，普通将领也可能返回俘虏专用指令，书信目标缺少本机别名路由校验。
- 回答有效但记忆或书信失败时缺少清晰的原子边界；现在记忆与地图一起提交，书信作为提交后的独立传输报告结果。

- 前端回包没有请求编号，快速操作时可能把结果交给错误按钮。
- iframe 只检查消息标记、未同时检查消息是否来自父窗口。
- 服主确认框取消后没有业务回包，按钮可能永久等待。
- 除入场外的玩家行动没有服务层串行锁，可能与另一行动或后台同步交叉修改。
- 公共评论分片遇到一次临时错误就停止，没有短重试。
- 公开地图已提交、奖励将领生成失败时仍把整次行动报成失败，可能诱导重复行动。
- 公开提交前失败时只有入场会回滚，其余公开行动可能残留在内存。
- 待重试将领若使用新的发现编号，极端崩溃恢复时可能重复生成；现已使用稳定发现编号。

继续观察：

- 平台评论和私信接口的字段、分页与速率规则属于外部依赖，平台改版后需要重新实测。
- 评论区适合秒级到小时级策略同步，不适合即时动作或强实时对战。
- 本地私人数据仍可被本机高级修改者篡改；凡会影响其他玩家的结果必须继续收敛为签名公共地图记录和可验证规则，不能信任对方上传的私人结论。
