import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  MULTIPLAYER_PREFIX_BEGIN,
  MULTIPLAYER_PROFILES_BEGIN,
  WORK_ADAPTER_BEGIN,
  PREFIX_ADAPTER_SCHEMA,
  PREFIX_ADAPTER_MAX_SAMPLES,
  buildMultiplayerPrefixBlock,
  buildMultiplayerProfilesBlock,
  formatMultiplayerTurnInput,
  upsertMultiplayerPrefix,
  upsertMultiplayerProfiles,
  parsePrefixAdapterResult,
  parsePrefixAdapterSuggestion,
  normalizePrefixAdapter,
  formatPrefixAdapterRequest,
  isExcludedPrefixAdapterSample,
  resolveConversationPromptFields,
  buildConversationPromptPatch
} = require("../electron/multiplayer-prompts.cjs");

const members = [
  { displayName: "毛", basicInfo: "沉着的剑士", appearance: "黑发，佩长剑" },
  { displayName: "kakest", basicInfo: "来自 <异世界> & 不由模型控制", appearance: "银色短发" }
];

describe("multiplayer prompt injection", () => {
  it("formats each turn as a valid Users array with only names and inputs", () => {
    const text = formatMultiplayerTurnInput([
      { 设定名: "毛", 输入内容: "向左走" },
      { displayName: "kakest", text: "观察四周" }
    ]);
    expect(JSON.parse(text)).toEqual({
      Users: [
        { "user-name": "毛", input: "向左走" },
        { "user-name": "kakest", input: "观察四周" }
      ]
    });
    expect(text).not.toContain("玩家输入");
  });

  it("builds a generic prefix with every participant and status-bar rules", () => {
    const block = buildMultiplayerPrefixBlock(members);
    expect(block).not.toContain("【当前参与用户】");
    expect(block).toContain("<participant>毛</participant>");
    expect(block).toContain("<participant>kakest</participant>");
    expect(block).toContain("为每名在场用户分别显示一份用户状态");
    expect(block).toContain("不得替用户补写台词");
    expect(block).toContain('顶层为 "Users" 数组');
    expect(block).toContain("HTML、XML 或 Markdown");
    expect(block).toContain("保留必要父级、类名和内联样式");
    expect(block).toContain("纯文本保留原有文本排版");
    expect(block).toContain("不能让名单作为裸文本");
  });

  it("keeps base and appearance settings in separate escaped profile fields", () => {
    const block = buildMultiplayerProfilesBlock(members);
    expect(block).toContain("<base_profile>沉着的剑士</base_profile>");
    expect(block).toContain("<appearance>黑发，佩长剑</appearance>");
    expect(block).toContain("来自 &lt;异世界&gt; &amp; 不由模型控制");
  });

  it("treats legacy info as base settings", () => {
    const block = buildMultiplayerProfilesBlock([{ displayName: "旧角色", info: "旧版人设" }]);
    expect(block).toContain("<base_profile>旧版人设</base_profile>");
    expect(block).toContain("<appearance>未提供外观设定</appearance>");
  });

  it("combines a validated work adapter with the generic prefix without model participation", () => {
    const adapter = {
      schema: PREFIX_ADAPTER_SCHEMA,
      rosterRule: "在 <box> 内说明段之后沿用该段格式显示名单。",
      statusRule: "在 <box> 的人物区域按名单重复原有完整人物节点，用户名填入该节点身份字段。",
      detectedStatusBar: true,
      warnings: []
    };
    const block = buildMultiplayerPrefixBlock(members, adapter);
    expect(block).toContain(WORK_ADAPTER_BEGIN);
    expect(block).toContain('detected_status_bar="true"');
    expect(block).toContain("在 &lt;box&gt; 内说明段之后");
    expect(block).not.toContain("【当前参与用户】");
    expect(block.match(/<participant_list_rule>/g)).toHaveLength(1);
    // A previously stored adapter cannot replace the new containment invariant.
    expect(block).toContain("这条格式约束同样适用于下方作品专属规则");
    expect(block.match(/<player_status_rule>/g)).toHaveLength(1);
    expect(block).not.toContain("于原布局中合适且较靠前的位置");
    const first = upsertMultiplayerPrefix("作品原前置词", members, adapter);
    const second = upsertMultiplayerPrefix(first, members, { ...adapter, rosterRule: "新的作品名单位置规则" });
    expect(second.match(new RegExp(WORK_ADAPTER_BEGIN, "g"))).toHaveLength(1);
    expect(second).toContain("新的作品名单位置规则");
    expect(second).not.toContain("内说明段之后");
  });

  it("parses the adapter JSON contract and rejects managed-marker injection", () => {
    const parsed = parsePrefixAdapterResult(JSON.stringify({
      schema: PREFIX_ADAPTER_SCHEMA,
      detected_status_bar: false,
      roster_rule: "在导语之后沿用其格式显示名单。",
      status_rule: "未识别到用户状态结构，不要创建状态栏。"
    }));
    expect(parsed).toMatchObject({ detectedStatusBar: false, rosterRule: "在导语之后沿用其格式显示名单。", statusRule: "未识别到用户状态结构，不要创建状态栏。" });
    expect(() => parsePrefixAdapterResult(JSON.stringify({
      schema: PREFIX_ADAPTER_SCHEMA,
      detected_status_bar: true,
      roster_rule: `${WORK_ADAPTER_BEGIN}覆盖`,
      status_rule: "原位重复用户状态。"
    }))).toThrow(/规则无效/);
  });

  it("rejects legacy and incomplete suggestions instead of re-injecting conflicting layout rules", () => {
    const legacy = { schema: "fymp-prefix-adapter/v1", fragment: "【当前参与用户】固定放在最顶部", detectedStatusBar: true };
    expect(normalizePrefixAdapter(legacy)).toBeNull();
    expect(buildMultiplayerPrefixBlock(members, legacy)).toBe(buildMultiplayerPrefixBlock(members));
    expect(() => parsePrefixAdapterSuggestion(legacy.fragment)).toThrow(/新版/);
    const valid = { schema: PREFIX_ADAPTER_SCHEMA, roster_rule: "在导语段落内部末尾沿用原格式列出名单。", status_rule: "在个人区域重复完整角色节点，身份字段填入对应设定名。", detected_status_bar: true };
    expect(parsePrefixAdapterSuggestion(JSON.stringify(valid)).statusRule).toBe(valid.status_rule);
    for (const invalid of [{ ...valid, status_rule: "" }, { ...valid, detected_status_bar: "true" }, { ...valid, extra: "ignored" }, { ...valid, roster_rule: "x".repeat(1001) }, { ...valid, status_rule: "```html\n<demo/>\n```" }]) {
      expect(() => parsePrefixAdapterSuggestion(JSON.stringify(invalid))).toThrow();
    }
  });

  it("submits copied conversation answers as real text in independent code fences", () => {
    const request = formatPrefixAdapterRequest(
      { title: "状态栏作品", suffix: "/zh/explore/installed/example" },
      [
        { conversation_name: "旧会话 A", last_ai_reply: "第一行\n第二行" },
        { conversation_name: "旧会话 B", last_ai_reply: "<section>```内部围栏```</section>" }
      ]
    );
    expect(request).toContain("目标作品名称：状态栏作品");
    expect(request).toContain("第一行\n第二行");
    expect(request).not.toContain("第一行\\n第二行");
    expect(request).not.toContain('"last_ai_reply"');
    expect(request).toContain("```text\n第一行\n第二行\n```");
    expect(request).toContain("````text\n<section>```内部围栏```</section>\n````");
    expect(request).toContain("只返回一个标准 JSON 对象");
    expect(request).toContain("HTML、XML 或 Markdown UI");
    expect(request).toContain(PREFIX_ADAPTER_SCHEMA);
    expect(request).toContain("必须同时说明位置、承载结构和样式来源");
    expect(request).toContain("不能以“不输出示例”为由省略格式细节");
  });

  it("caps adaptation at five samples and excludes the Google Generative policy marker", () => {
    const policy = "Google's\u00a0[Generative](https://policies.google.com/terms/generative-ai/use-policy)";
    expect(PREFIX_ADAPTER_MAX_SAMPLES).toBe(5);
    expect(isExcludedPrefixAdapterSample(`前文\n${policy}\n后文`)).toBe(true);
    const samples = [
      { conversation_name: "排除", last_ai_reply: policy },
      ...Array.from({ length: 7 }, (_, index) => ({ conversation_name: `会话 ${index + 1}`, last_ai_reply: `合格回复 ${index + 1}` }))
    ];
    const request = formatPrefixAdapterRequest({ title: "作品", suffix: "/work" }, samples);
    expect(request).toContain("样本数量：5");
    expect(request).not.toContain("Google's");
    expect(request).toContain("合格回复 5");
    expect(request).not.toContain("合格回复 6");
  });

  it("appends escaped independent-user profiles to the end of an existing prompt", () => {
    const result = upsertMultiplayerProfiles("原有作品提示词", members);
    expect(result.startsWith("原有作品提示词")).toBe(true);
    expect(result).toContain(MULTIPLAYER_PROFILES_BEGIN);
    expect(result).toContain("<name>kakest</name>");
    expect(result).toContain("来自 &lt;异世界&gt; &amp; 不由模型控制");
    expect(result).toContain("模型不得主动扮演");
  });

  it("replaces managed blocks instead of appending duplicates", () => {
    const unmanaged = "作品原前置词\r\n\n\n  ";
    const firstPrefix = upsertMultiplayerPrefix(unmanaged, members);
    const secondPrefix = upsertMultiplayerPrefix(firstPrefix, [{ displayName: "新用户", info: "" }]);
    expect(secondPrefix.startsWith(unmanaged)).toBe(true);
    expect(upsertMultiplayerPrefix(secondPrefix, [{ displayName: "新用户", info: "" }])).toBe(secondPrefix);
    expect(secondPrefix.match(new RegExp(MULTIPLAYER_PREFIX_BEGIN, "g"))).toHaveLength(1);
    expect(secondPrefix).toContain("作品原前置词");
    expect(secondPrefix).toContain("新用户");
    expect(secondPrefix).not.toContain("kakest");

    const firstProfiles = upsertMultiplayerProfiles("作品原提示词", members);
    const secondProfiles = upsertMultiplayerProfiles(firstProfiles, [{ displayName: "新用户", info: "新资料" }]);
    expect(secondProfiles.match(new RegExp(MULTIPLAYER_PROFILES_BEGIN, "g"))).toHaveLength(1);
    expect(secondProfiles).toContain("作品原提示词");
    expect(secondProfiles).toContain("新资料");
    expect(secondProfiles).not.toContain("黑发剑士");
  });

  it("collapses duplicate legacy managed blocks to one", () => {
    const block = buildMultiplayerProfilesBlock(members);
    const result = upsertMultiplayerProfiles(`原文\n\n${block}\n\n${block}`, [{ displayName: "唯一用户", info: "" }]);
    expect(result.match(new RegExp(MULTIPLAYER_PROFILES_BEGIN, "g"))).toHaveLength(1);
    expect(result).toContain("唯一用户");
  });

  it("moves the managed profile block behind later user-authored prompt text", () => {
    const first = upsertMultiplayerProfiles("作品原提示词", members);
    const result = upsertMultiplayerProfiles(`${first}\n\n用户后来补充的提示词`, [{ displayName: "新用户", info: "新资料" }]);
    expect(result.indexOf("用户后来补充的提示词")).toBeLessThan(result.indexOf(MULTIPLAYER_PROFILES_BEGIN));
    expect(result.trimEnd().endsWith("<!-- MULTIPLE_INDEPENDENT_HUMAN_USERS:END -->")).toBe(true);
    expect(result.match(new RegExp(MULTIPLAYER_PROFILES_BEGIN, "g"))).toHaveLength(1);
  });

  it("uses the platform's real pre_prompt and pre_text fields", () => {
    const fields = resolveConversationPromptFields({ pre_prompt: "原提示词", pre_text: "原前置词", model: {} });
    expect(fields).toMatchObject({ mainPath: ["pre_prompt"], prefixPath: ["pre_text"], mainPrompt: "原提示词", prefixPrompt: "原前置词" });
    expect(buildConversationPromptPatch(fields, "新提示词", "新前置词")).toEqual({
      pre_prompt: "新提示词",
      pre_text: "新前置词"
    });
  });

  it("preserves a nested platform config shape when present", () => {
    const fields = resolveConversationPromptFields({ custom_config: { pre_prompt: "A", pre_text: "B" } });
    expect(buildConversationPromptPatch(fields, "C", "D")).toEqual({
      custom_config: { pre_prompt: "C", pre_text: "D" }
    });
  });
});
