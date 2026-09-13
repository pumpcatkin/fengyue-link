# Aiero 创作页面填写与保存经验

本文记录在 staging 环境对《猎艳疆土》固定伴生作品进行真实保存与回读的方法。目标页为：

```text
https://staging.aiero.cc/zh/app/b27218e6-80f9-4c0d-91c7-4b8f87d47be8/configuration
```

结果：保存接口与导出回读接口均返回 HTTP 200；作品名称、简介、详细介绍、前置词、提示词、后置词和五个世界书条目逐项比对。该作品是一张游戏卡服务全体玩家的唯一伴生作品，玩家侧不填写或替换作品 ID。游戏卡固定记录作者账号 `39404f0e-7678-45a1-86c6-9a21116bacbd`，运行时以安装作品接口返回的 `created_by_account_id` 再次核对。

## 1. 页面结构

创作页顶部有“基础设置”“世界书设置”“其他设置”三个页签，以及“导出配置”“保存”“发布”“预览”等操作。

“基础设置”内依次填写：

1. 作品名称。
2. 详细介绍：本项目放置完整 `[[FYOW-PROGRAM/1:...]]` 程序信封。
3. 简介。
4. 前置词。
5. 后置词。
6. 提示词：保存共同世界观。

《猎艳疆土》的准确文本保存在 `docs/grid-conquest-companion-work.md`，程序信封由 `npm run game:bundle` 生成。不要把 `<script>`、`<iframe>` 或其他可执行标签直接放入详细介绍；页面会拦截。程序信封只是惰性文本，实际代码由工具下载、验摘要后放进隔离运行时。

## 2. 新增世界书

切换到“世界书设置”，对每个任务执行：

1. 点击“+ 新增”。
2. 保持触发方式为“或”。
3. 在关键词输入框填入机器关键词，再点击输入框右侧“添加”；只输入而不添加，关键词不会进入条目。
4. 将触发范围设为“用户”。导出后的实际值应是 `key_region: 2`。
5. 填写世界书内容，类型保持“提示词”。
6. 概率设为 100%，保持条目启用。

本次保存的关键词为：

```text
[[FYOW:TASK:general.generate:v1]]
[[FYOW:TASK:player.profile-context:v1]]
[[FYOW:TASK:general.dialogue:v1]]
[[FYOW:TASK:general.captive-dialogue:v1]]
[[FYOW:TASK:general.memory.update:v1]]
```

导出数据会给“或”关键词增加 `_or_` 前缀，这是平台序列化格式，页面输入时不需要手工添加。

## 3. 保存流程

填写完成后点击页面顶部“保存”。页面会打开“更新日志”对话框；更新说明可以留空，点击其中的“确认”才会发出最终保存请求。只关闭对话框或停在对话框上不算保存成功。

本次确认的实际保存接口是：

```text
POST /console/api/apps/{workId}/model-config
```

创作页提交的是稳定的完整字段，例如：

```text
app.name
app.description
app.summary
app.language
app.gender
pre_text
pre_prompt
post_text
world_book
```

当前后端实际要求 `app.summary`、`app.language`、`app.gender` 非空或存在。页面虽然把简介标成“选填”，空简介经接口保存会收到“缺少应用简介”，所以应始终填写一句简介。作品语言和面向群体也应在页面中保留有效选择。

## 4. 保存后验证

保存完成后立即读取：

```text
GET /console/api/apps/{workId}/model-config/export
```

至少核对：名称、简介、程序信封、三段提示词、世界书数量、关键词、`key_region=2`、`enable=true` 和 `probability=100`。本次五个固定任务依次覆盖将领生成、玩家角色设定整理、普通互动、俘虏互动和将领记忆整理。程序信封还要解码并核对 `gameId`、宿主 API 版本和 SHA-256，不能只比较字符数。

本次结果：

```text
作品名：猎艳疆土[b27218e680f94c0d]
世界书：5 条
详细介绍：28,966 字符
程序 SHA-256：4a84f3b2b639c1e7d2649978cf3070cd2a9467b3f1eb46eff8234120031a6e03
```

## 5. 导出接口的动态别名

`model-config/export` 的核心字段名不是固定的。连续 20 次读取同一个作品时，同一内容会轮换为下列别名：

| 内容 | 可能的键名 |
|---|---|
| 作品名称 | `name / nm / ttl / title / app_name` |
| 简介 | `summary / smry / abs_txt / sum_info / abstract` |
| 详细介绍 | `description / desc / descr / dsc / intro` |
| 前置词 | `pre_text / pre_tx / pretxt / ptx / prefix_txt` |
| 提示词 | `pre_prompt / pre_pt / prpt / ppt / prompt_pre` |
| 后置词 | `post_text / post_tx / posttxt / potx / suffix_txt` |
| 世界书 | `world_book / world_bk / wbook / lore_bk / wb` |

因此自动化程序应先做别名归一化，再验证内容；也要在整卡备份中保留本次导出的完整原始配置，不能只复制某几个固定缩写。向保存接口写回时应转换为创作页使用的完整字段，不要把某次导出的随机别名原样当作保存 Schema。

## 6. 可重复执行脚本

仓库的 `scripts/configure-grid-companion-work.cjs` 会使用独立 Electron 会话登录，先让真实创作页组装完整保存载荷，再替换为仓库内固定的程序和提示词，提交保存，最后重新导出并逐项验证。账号信息只从环境变量或 Windows 加密凭据读取，脚本不会输出密码、Cookie 或 Token。

只做回读验证时设置 `FYOW_VERIFY_ONLY=1`；排查导出别名时设置 `FYOW_INSPECT=N`，其中 `N` 为 1～30。常规执行会改写目标作品，使用前应再次确认固定 `workId`。
