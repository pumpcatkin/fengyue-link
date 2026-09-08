# 风月联机工具插件创作指南

> 适用版本：`0.10.0` 及其后续兼容版本
> 用途：在新对话中设计、实现和验收联机工具内插件  
> 注意：这里的“插件”是风月联机工具的内置功能，不是 Electron 扩展、浏览器插件或 Codex 插件。

## 新对话怎样使用本文

插件专项任务只需先阅读本文，再按任务类型读取本文列出的代码。除非改动登录、房间协议、安装器或整个对话视图，否则不必全文读取 `docs/project-handoff.md`。

推荐把下面这段作为新对话的开场请求：

```text
请先完整阅读 docs/plugin-authoring-guide.md，并以其中的当前实现和验收清单为准。
本次要制作的插件是：……
阶段/触发方式是：……
它读取：……
它返回或修改：……
平台插件作品后缀或 appId 是：……
不要全文读取 docs/project-handoff.md；只有出现跨模块问题时再按需读取相关章节。
完成后必须运行测试、提升版本并重新生成正式安装包。
```

插件任务的最小代码阅读集合：

```powershell
Get-Content electron/plugin-pipeline.cjs -Raw
Get-Content tests/plugin-pipeline.test.ts -Raw
rg -n "publicPluginSettings|updatePluginSettings|runConversationPluginStack|runPlatformAutomationModel|injectConversationPluginCards" electron/main.cjs
rg -n "effect-judge|plugin" electron/desktop/index.html electron/desktop/renderer.js
```

只有修改多人正式输入格式时才读 `electron/multiplayer-prompts.cjs`；只有修改房间传输或访客同步时才继续读取 `electron/main.cjs` 对应协议段。

## 一、当前插件架构的真实状态

### 0.10.8 增补

独立视角的首次尝试使用整理作品当前模型。重试继续由新的隐藏窗口和纯净会话承担，并在创建窗口前切换整理作品模型：第二次优先实时列表中的 Gemini Flash，第三次优先 DeepSeek V4 Flash，缺失时使用其他未使用型号。模型写入后必须回读 provider/name；验证失败不发送。该操作只改独立视角整理作品的 `model` 字段，不改提示词或正式剧情作品。

### 0.10.7 增补

一键适配成功状态显示“当前对话已适配”，说明前置词写入会话配置，不宣称修改作品全局配置。访客占位改用经过实测的 Grok 优先策略（替代下文历史 Other 策略），监听真实任务编号并确认服务端输出流结束后同步；失败不能重复发送占位。插件结果仍必须等房主输出和访客平台记录验证完成才能显示。详见 `guest-termination-test-20260901.md`；零正文输出不等于平台零积分。

### 0.10.6 增补

插件页顶部加入通用兼容性提醒。一键适配仍生成 v2 的两个短规则，但名单规则必须明确位置、承载节点、必要父级及样式来源，不能仅写“在面板前后沿用原格式”；HTML/XML 名单不得裸露在面板之间或渲染容器、围栏之外，纯文本作品不强加 HTML。生成器提示词已同步更新，需要用户手动替换后重新适配异常作品。访客占位模型新增 Other 最低价、同价最低出字率策略，独立于插件模型与房主正式模型，不改这两类模型。

### 0.10.5 增补

独立视角是自动重试的显式例外：超时、请求失败和解析失败均最多尝试 3 次（包含首次），每次重新打开并重载后台整理作品，以确认纯净的新会话发送相同请求；先销毁失败窗口再重试，不重新生成正式剧情。正常回合和刷新记录共用 `runPerspectivePlugin`；全部失败仍暂不公开原文。记录 attemptCount/attempts 和累计已读取积分，无法读取的尝试通过 pointsIncomplete 标明。单次后台调用支持可选 `{timeoutMs}` 参数，独立视角设置为 10 分钟，其余插件默认行为不变。

### 0.10.4 增补

联机前置词适配改用 `fymp-prefix-adapter/v2`，仅生成 `roster_rule`、`status_rule` 两条短规则及 `detected_status_bar` 布尔标记。名单规则与用户状态规则分别替换通用默认项，不追加整份提示词，不要求固定标题、顶端位置或输出示范。生成器提示词见 `docs/status-adapter-generator-prompt.md`，旧 v1 结果保留但不注入。独立视角启用时若已选作品但没有会话 UUID，会先初始化真实会话、写入并确认，避免无写入却报告启用成功。

### 0.10.0 增补

新增输出插件“独立视角”，纯逻辑在 `electron/perspective-split.cjs`，作品提示词在 `docs/perspective-split-work-prompt.md`，测试在 `tests/perspective-split.test.ts`。设置归一化现在同时保留效果判定与独立视角。下文以效果判定为例的旧说明不表示输出栈仍为空。

独立视角是失败开放策略的隐私例外：错误后继续完成回合，但只能同步占位文本，不能回退广播原文。`perspectiveOutputs` 是房主内部映射；`broadcastRoomPacket` 必须先调用 `personalizeResult`，不能把映射发给访客。运行记录只含状态、计数与积分，不包含全员正文。

房主平台会话保留全员原文，通过 Electron Fetch 响应投影仅改变房主页面收到的历史内容。`perspective-views-{profile}.json` 只保存原文哈希及房主自己的投影。生成、整理期间不展示未整理页面。刷新独立视角记录时重新整理，暂不提供单人文本覆盖全员原文的编辑操作。

插件前置词在独立 `FYMP_TWO_PART_NARRATIVE` 标记内；目标清单跨重启保存，停用时逐会话删除该标记块并验证。其他提示词和块外空白必须原样保留。记忆与全局配置接口另见 `electron/work-settings.cjs`；访客只读。

离线界面和真实响应拦截验证可运行 `node_modules/.bin/electron.cmd scripts/verify-desktop.cjs`，不会读取登录资料或调用平台模型。

当前正式插件有“效果判定”和“独立视角”。“联机前置词适配”属于辅助处理器，但仍是单独接线的既有功能。

目前不是动态插件市场，也没有从文件夹自动发现 manifest 的机制。新增插件仍需修改工具源码、UI 和测试。不要只增加一个配置对象并假设工具会自动加载它。

现有分类：

| 类型 | phase | 触发点 | 是否阻塞正式回合 | 当前实例 |
| --- | --- | --- | --- | --- |
| 输入转换器 | `input` | 全员输入收齐后、房主发送前 | 是 | 效果判定 |
| 输出转换器 | `output` | 房主模型输出完成后、同步前 | 是 | 独立视角 |
| 辅助处理器 | `auxiliary` | 用户操作或自定义事件 | 由功能决定 | 联机前置词适配 |

“对话信息处理”是输入/输出转换器的 UI 分组；“其他信息处理”是辅助处理器的 UI 分组。

## 二、房主权威执行流程

```text
全员确认输入
  → collecting
  → processing-input
  → 房主依序执行全部输入转换器
  → 生成最终 Users JSON
  → round-input 同步输入和 pluginRuns
  → 访客建立可编辑回复并立即终止自己的生成
  → generating（只有房主等待正式模型）
  → processing-output
  → 房主依序执行全部输出转换器
  → round-result 同步权威输出和 pluginRuns
  → 访客以平台编辑功能覆盖本地占位回复
  → syncing
  → 全部访客回执后进入下一轮 collecting
```

硬性约束：

1. 插件只由房主执行。访客只接收配置、运行结果和卡片数据，不能再次调用插件作品。
2. 输入插件必须全部结束后，正式作品才能收到输入。
3. 输出插件必须全部结束后，下一轮输入才能开放。
4. 对话栈采用“等待完成、失败开放”：失败要生成错误运行记录，但不能吞掉玩家输入或卡死正式回合。
5. 插件不能绕开现有 `round-input → 访客终止 → round-result → 编辑覆盖 → ack` 链路。
6. 所有插件默认关闭，只有房主明确勾选后才生效。

## 三、当前数据契约

### 1. phase

定义位于 `electron/plugin-pipeline.cjs`：

```js
const PLUGIN_PHASES = {
  INPUT: "input",
  OUTPUT: "output",
  AUXILIARY: "auxiliary"
};
```

### 2. 栈执行器契约

`runPluginStack` 接收：

```js
{
  phase,
  value,
  context,
  plugins: [{ id, name, phase, order, enabled, run }],
  onRun
}
```

单个插件的运行函数：

```js
async function run({ value, context }) {
  return {
    value: nextValue,
    run: {
      // 可序列化的插件专属结果
    }
  };
}
```

执行器自动生成并维护：

```js
{
  runId,
  pluginId,
  name,
  phase,
  order,
  round,
  status,       // running | completed | error
  startedAt,
  completedAt,
  error
}
```

插件返回的 `run` 会合并进这份记录。若插件在模型已经产生积分后解析失败，应把模型、积分等信息放进 `error.pluginRun` 再抛出，使错误卡片仍能显示真实消耗。

运行记录会进入 `round-input` / `round-result`，因此必须可以被 `JSON.stringify`：禁止放 DOM、函数、窗口对象、循环引用、Token 或 Cookie。

### 3. 输入与输出 value

当前输入转换器接收：

```js
[
  { "设定名": "玩家名", "输入内容": "本轮原文" }
]
```

全部输入插件完成后，由 `formatMultiplayerTurnInput` 统一转换成正式作品输入：

```json
{
  "Users": [
    { "user-name": "玩家名", "input": "处理后的输入" }
  ]
}
```

当前输出转换器接收和返回完整模型输出字符串。

`context` 目前只稳定提供 `{ round }`。需要成员、历史或作品配置的插件，应像效果判定一样由 `AccountBackend` 的闭包读取明确数据，不要假设 `context` 已包含未实现字段。

### 4. 插件设置

设置保存在 Electron `userData/plugin-settings/{profileId}.json`，房主通过 `plugin-settings-sync` 发给访客。

当前 `normalizePluginSettings` 保留效果判定与独立视角；未知插件 ID 会被丢弃。制作新的正式插件时，必须先扩展这个归一化函数，否则新配置会在保存、广播或访客接收时消失。

当前 `updatePluginSettings` 接受 `effect-judge` 与 `perspective-split`。新增插件必须扩展校验和保存分支，或先重构为注册表驱动。设置变更仍需遵守：

- 插件运行中不可修改；
- 回合已经有人确认输入后不可修改；
- 访客不可修改房主插件；
- 房间等待阶段的变更必须立即广播；
- 新插件首次加入必须默认 `enabled: false`；
- 若提升设置 schema 版本，不能顺带关闭用户已经明确启用的旧插件。

## 四、调用平台作品模型

统一入口是 `AccountBackend.runPlatformAutomationModel(appId, modelInput, label)`。

### 实际技术路线

1. 使用当前账号实例的持久化 Chromium partition，继承同一登录态和 Windows 系统代理。
2. 用当前登录节点拼接：`{origin}/zh/explore/installed/{appId}`。禁止写死 `staging.aiero.cc`、`acquant.xyz` 等完整域名。
3. 为每次调用建立不可见的独立 `BrowserWindow`，不复用正在游玩的作品页。
4. 清空该插件作品在 `conversationIdInfo` 中的当前会话，并重新载入，验证输入和回复数量均为零。
5. 向 `#ai-chat-input` 写入完整请求，触发 React 所需的 `input/change` 事件，再点击 `#ai-send-button`。
6. 等待新的 `#ai-chat-answer` 同时出现模型名、输入积分和输出积分，表示生成完成。
7. 优先点击 `#customized-edit-button`，从可见编辑框读取原始回复；若编辑框为空，才回退到清理按钮和积分文字后的渲染文本。
8. 从平台 DOM 读取实际模型名和积分，返回后销毁临时窗口。

返回形状：

```js
{
  output,
  outputSource: "editor" | "rendered",
  conversationId,
  model,
  points: { input, output, total }
}
```

当前帮助函数不会传入或自动选择模型 provider/model；实际使用平台作品当前生效的模型，并从回复 DOM 读取模型名。不要在插件代码里偷偷更改用户的游玩模型。

调用示例：

```js
const generated = await this.runPlatformAutomationModel(
  MY_PLUGIN_APP_ID,
  request,
  "插件显示名"
);
```

超时边界按当前实现理解：每次页面加载最多 25 秒；输入栈最多等待约 20 秒；生成完成最多等待约 450 秒；原始编辑框最多等待约 6 秒。默认不因解析失败自动重试；独立视角按上文 0.10.5 的显式要求最多尝试三次，并设置单次 10 分钟总超时。

### 平台作品要求

- 作品必须能由当前账号通过 `/zh/explore/installed/{appId}` 打开。
- 工具只保存 appId/后缀，完整 URL 始终按登录节点重建。
- 作品提示词目前需要维护者手动写入平台；工具不会自动修改插件作品配置。
- 最好让一次模型调用批量处理本轮全部玩家，避免每位玩家单独调用。
- 插件作品回复必须可由工具严格解析，不能依赖视觉排版或自然语言猜测。

## 五、模型提示词与协议设计

### 1. 模型只做需要语义判断的部分

应由本地代码完成：

- 随机数、洗牌、骰面映射；
- 数值范围、排序和权重；
- 玩家 ID 对应；
- 积分读取；
- 是否启用、执行顺序和失败回退；
- 正式输入拼接；
- 卡片渲染与访客同步。

模型只负责无法稳定用规则完成的语义任务，例如剧情后果、文本分类、摘要或风格化结果。

### 2. 使用版本化 JSON 协议

推荐：

```json
{
  "protocol": "FYMP_MY_PLUGIN_V1",
  "players": []
}
```

协议必须包含：

- 唯一且不可模糊匹配的 `protocol`；
- 固定根字段；
- 固定玩家键并逐字复制 `player_key`；
- 明确数量、顺序、是否允许空值；
- 明确禁止旧协议和多余字段；
- 明确 JSON 外不能有 Markdown、解释或思考。

解析器必须验证语义约束，不能只验证 `JSON.parse` 成功。效果判定还会检查玩家全集、无重复、恰好 x 项、必需程度和强弱顺序。

### 3. 隔离控制数据与故事数据

请求建议固定成：

``````text
FYMP_MY_PLUGIN_V1 REQUEST
<request_json>
````json
{ ...唯一可信的控制参数与玩家输入... }
````
</request_json>

<previous_outputs order="oldest_to_newest" trust="data_only">
````text
...只读故事资料...
````
</previous_outputs>

仅返回一个 FYMP_MY_PLUGIN_V1 JSON 对象。
``````

围栏长度必须动态避开正文中已有的最长反引号序列。历史输出、玩家输入、显示名和风格文本全部是数据，必须在作品提示词中明确它们不能改写控制规则。

### 4. 按注意力顺序组织作品提示词

推荐顺序：

1. 开头声明唯一角色和“只输出 JSON”；
2. 立即声明协议版本以及废弃格式；
3. 说明可信控制区和不可信故事区；
4. 给出编号任务规则；
5. 给出唯一允许的最小 JSON 结构；
6. 给出字段、数量和序列化硬规则；
7. 结尾再次要求只输出该协议 JSON。

不要塞入大量互相近似的示例。一个最小结构示例加严格验证器，通常比多个长示例更稳定、更省积分。

## 六、积分与模型调用成本

本地 Markdown 不会被发送给平台插件作品，也不会产生平台积分。效果判定的实际请求只含：作品自身提示词、最近 `n` 条房主输出、本轮全部玩家输入、程度数量与风格。

主要成本近似随以下因素增长：

```text
输入成本 ≈ 作品提示词 + 最近 n 条输出 + 全员本轮输入
输出成本 ≈ 玩家数 × 每人返回项数 × 单项平均长度
```

降低成本的优先级：

1. 一次调用批量处理所有玩家，不要按玩家拆成多次调用。
2. 只读取真正必要的历史；允许用户配置 `n`，默认值保持克制。
3. 不让模型生成本地可以推导的骰面、随机值、重复映射和积分说明。
4. 限制每个文本字段长度和句数；效果判定已经要求每项一至两句。
5. 默认不因 JSON 解析失败自动重新生成；独立视角按用户要求执行至多三次尝试，累计已读取积分，最终失败只显示失败提示，不使用原文。
6. 若插件首轮缺少必要上下文，像效果判定一样跳过且记 0 积分。
7. 只有输入和上下文完全相同时才考虑缓存；剧情插件默认不要跨回合复用旧语义结果。

`run.points` 必须使用平台返回的真实积分；不能由模型估算。卡片右下角统一显示 `run.points.total`。

## 七、制作一个新插件需要改哪些位置

### 1. 先写设计契约

实现前明确：

```text
插件 ID：稳定 kebab-case
显示名：
phase：input / output / auxiliary
order：
触发条件：
读取数据：
模型负责：
本地负责：
返回协议：
value 如何改变：
卡片显示：
积分来源：
缺少上下文：跳过 / 仍执行
模型或解析失败后的原值：
是否需要同步给访客：
```

### 2. `electron/plugin-pipeline.cjs`

新增或扩展：

- 插件 ID 和协议常量；
- 设置归一化；
- 请求构造器；
- 严格响应解析器；
- 本地确定性变换；
- 导出项；
- `normalizePluginSettings` 中的持久化与默认关闭配置。

尽量把可测试的纯逻辑留在这里，不要在该文件操作 Electron、DOM 或网络。

### 3. `electron/main.cjs`

至少检查：

- 顶部 import 与插件作品 appId；
- `state().plugins.definitions`；
- `publicPluginSettings()`；
- `updatePluginSettings()`；
- 新插件 runner；
- `runConversationPluginStack()` 中的注册顺序；
- `plugin-settings-sync` 的访客归一化；
- `round-input` / `round-result` 中需要同步的 run 数据；
- `injectConversationPluginCards()` 的专属卡片分支。

第二个正式插件加入前，优先把“插件定义、设置归一化、runner、UI 元数据”整理为一个注册表；当前的多个 `effect-judge` 硬编码分支不适合长期复制。

### 4. UI

相关文件：

- `electron/desktop/index.html`：折叠卡片和表单；
- `electron/desktop/renderer.js`：状态渲染、校验、保存；
- `electron/desktop/theme.css` / `login.css`：确有新增样式时才改；
- `electron/preload.cjs`：只有新增 IPC 时才改。

统一规则：

- 插件位于联机栏顶部“插件”页；
- 默认折叠；
- 启用 checkbox 位于折叠标题最左侧，点击 checkbox 不展开卡片；
- 默认关闭；
- 访客只读；
- 运行中锁定不安全设置；
- UI 只解释用途、成本和用户需要填写的内容，不展示底层实现原理；
- 流程文字使用“插件{插件名}处理输入/输出信息中”。

### 5. 对话卡片

当前正式卡片由 `injectConversationPluginCards()` 注入真实平台消息 DOM：

- 只处理非 `running`、非 `skipped` 的输入阶段 run；
- 锚定完整聚合输入，依次尝试原文、去空白原文、包含关系，最后才回退最新输入；
- 以 `round + runId` 幂等去重；
- 按 `order`、再按插件 ID 排序；
- 使用 closed Shadow DOM，避免作品 CSS 污染；
- 平台 React 重绘后通过恢复函数重新放置；
- 错误卡片明确说明已降级发送原始输入；
- 右下角显示实际积分。

通用分支目前只显示“插件已完成”。需要专属字段时必须增加专属渲染分支，所有文本使用 `textContent`，禁止把模型字符串写入 `innerHTML`。

输出处理卡片尚未实现。制作第一个输出转换器时，必须新增“模型输出行之后”的锚定与恢复逻辑，不能误用输入卡片的位置。

### 6. 提示词、前置词和后置词修改

当前栈的直接返回值只有输入数组或输出字符串。修改作品提示词/前置词/后置词还没有通用事务契约。

若新插件需要这些能力，应让 run 返回明确的、可序列化的 `effects`，再由 `AccountBackend` 在规定阶段统一应用和校验；复用现有作品配置 API 与 `syncHostMultiplayerConversationConfig` 思路。不要在纯插件函数里直接改平台配置，也不要把提示词修改偷偷塞进玩家正文。

必须另外定义：作用域（本轮/会话/持久）、覆盖还是追加、失败回滚、与多人前置词的合并顺序、访客是否只展示还是需要同步配置。

## 八、测试与验收

### 纯逻辑测试

在 `tests/plugin-pipeline.test.ts` 覆盖：

- 默认关闭和旧设置迁移；
- 参数边界；
- 请求不泄露本地计算参数；
- 动态代码围栏；
- 严格协议解析；
- 未知/重复/缺失玩家；
- 数量、排序、空值和旧协议拒绝；
- 本地确定性映射；
- 模型错误后沿用旧 value；
- 后续插件仍继续执行；
- 正式输入只包含允许写入的结果。

### Electron 回归测试

在 `tests/electron-regressions.test.ts` 覆盖：

- UI 入口、折叠状态和 checkbox 位置；
- renderer 保存调用；
- 当前登录域名拼接；
- 房主唯一调用、访客不调用；
- `pluginRuns` 进入权威回合包；
- 卡片锚点、排序、幂等和积分；
- 输出插件不得提前开放下一轮。

### 手动联机验收矩阵

至少测试：

1. 全插件关闭；
2. 仅新插件开启；
3. 新插件与效果判定同时开启，交换 order；
4. 首轮无历史；
5. 模型返回合法 JSON；
6. 模型返回代码围栏 JSON；
7. 模型返回坏 JSON、少玩家、重复玩家；
8. 插件作品加载失败或积分不足；
9. 房主和两个访客卡片一致；
10. 访客端未再次产生插件积分；
11. 平台 React 重绘、切换介绍再返回对话后卡片仍恢复；
12. 下一轮继续正常输入、生成、编辑和回执。

### 发布要求

本项目规定任何功能或文档改动都必须：

```powershell
node --check electron/main.cjs
node --check electron/preload.cjs
node --check electron/desktop/renderer.js
npm test
npm run build
npm audit --package-lock-only
```

随后提升 `package.json` / `package-lock.json` / UI 初始版本号，生成新的 Windows NSIS 安装包并验证版本、ASAR、Electron 版本和冒烟启动。

## 九、现有实现参考

- 管线与纯逻辑：`electron/plugin-pipeline.cjs`
- 房主执行和模型调用：`electron/main.cjs`
- 插件设置 UI：`electron/desktop/index.html`、`electron/desktop/renderer.js`
- 纯逻辑测试：`tests/plugin-pipeline.test.ts`
- Electron 回归测试：`tests/electron-regressions.test.ts`
- 效果判定作品提示词：`docs/effect-judge-plugin-prompt.md`
- 多人提示词注入：`docs/multiplayer-prompt-injection.md`
- 管线概念简表：`docs/plugin-pipeline.md`

效果判定是“输入转换器 + 一次批量模型调用 + 本地随机映射 + 专属对话卡片”的完整样例。联机前置词适配是“辅助处理器 + 读取其他会话 + 一次平台作品模型调用 + 写回作品配置”的样例。

## 十、文档读取与额度说明

平台插件作品不会读取仓库 Markdown。`runPlatformAutomationModel` 只发送代码构造的 `modelInput`，因此本地文档和运行日志不会增加平台插件积分。

对新开发对话而言，当前最大的固定文档是 `docs/project-handoff.md`：约 43 KB、660 行。它包含完整架构、历史版本、发布流程，并重复概述了 `README.md`、`docs/plugin-pipeline.md` 和效果判定文档中的部分内容。它适合跨模块交接，但不适合每个插件小任务都全文加载。

插件专项任务建议：

1. 只附本文；
2. 让开发者用 `rg` 定位本文列出的函数；
3. 只有修改具体子系统时才读取对应专题文档；
4. 不要同时附上 README、完整交接文档、插件管线和效果判定提示词，除非任务确实横跨这些内容。

没有发现运行时代码会自动或重复读取某个 Markdown。重复消耗只会来自新对话主动附加/读取文档，或开发过程中为了定位问题再次读取代码和日志，而不是联机插件模型调用。
