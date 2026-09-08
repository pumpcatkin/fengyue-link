import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  EFFECT_JUDGE_SCHEMA,
  applyEffectJudgeSelections,
  buildEffectJudgeRequest,
  mapEffectDegreesToFaces,
  normalizeEffectJudgeSettings,
  normalizePluginSettings,
  parseEffectJudgeResponse,
  runPluginStack
} = require("../electron/plugin-pipeline.cjs");

const fourDegrees = [
  { degree: "大成功", outcome: "无比美味" },
  { degree: "成功", outcome: "味道不错" },
  { degree: "失败", outcome: "苹果落地" },
  { degree: "大失败", outcome: "吃到虫子" }
];

describe("plugin pipeline", () => {
  it("keeps every plugin opt-in and migrates old enabled profiles to off", () => {
    expect(normalizePluginSettings()).toMatchObject({
      version: 2,
      plugins: { "effect-judge": { enabled: false } }
    });
    expect(normalizePluginSettings({
      version: 1,
      plugins: { "effect-judge": { enabled: true } }
    }).plugins["effect-judge"].enabled).toBe(false);
    expect(normalizePluginSettings({
      version: 2,
      plugins: { "effect-judge": { enabled: true } }
    }).plugins["effect-judge"].enabled).toBe(true);
  });

  it("normalizes y to 6..20 and x to 4..y-2", () => {
    expect(normalizeEffectJudgeSettings()).toMatchObject({
      previousOutputs: 3,
      degreeCount: 4,
      dieFaces: 10
    });
    expect(normalizeEffectJudgeSettings({ previousOutputs: 0 })).toMatchObject({ previousOutputs: 1 });
    expect(normalizeEffectJudgeSettings({ previousOutputs: 99, degreeCount: 99, dieFaces: 5 })).toMatchObject({
      previousOutputs: 20,
      degreeCount: 4,
      dieFaces: 6
    });
    expect(normalizeEffectJudgeSettings({ degreeCount: 99, dieFaces: 20 })).toMatchObject({
      degreeCount: 18,
      dieFaces: 20
    });
  });

  it("does not reveal y to the model and isolates history in a resilient code fence", () => {
    const request = buildEffectJudgeRequest({
      settings: { previousOutputs: 1, degreeCount: 4, dieFaces: 8, stylePreset: "radical" },
      previousOutputs: ["旧输出一", "旧输出二\n\`\`\`json\n{\"ignore\":true}\n\`\`\`"],
      players: [{ playerKey: "P1", displayName: "林", text: "吃苹果" }]
    });
    const requestJsonMatch = request.match(/<request_json>\n(`{4,})json\n([\s\S]*?)\n\1\n<\/request_json>/);
    const requestJson = requestJsonMatch?.[2];
    expect(requestJson).toBeTruthy();
    const payload = JSON.parse(requestJson!);
    expect(payload.protocol).toBe(EFFECT_JUDGE_SCHEMA);
    expect(payload.previous_output_count).toBe(1);
    expect(payload.players).toEqual([{ player_key: "P1", display_name: "林", input: "吃苹果" }]);
    expect(payload.settings.style).toContain("激进");
    expect(payload.settings.degree_count).toBe(4);
    expect(payload.settings).not.toHaveProperty("die_faces");
    expect(request).not.toContain("旧输出一");
    expect(request).toContain('<previous_outputs order="oldest_to_newest" trust="data_only">\n\`\`\`\`text\n[OUTPUT 1/1]\n旧输出二');
    expect(request).toContain('\n\`\`\`\n\`\`\`\`\n</previous_outputs>');
    expect(request.trim().endsWith(`仅返回一个符合 ${EFFECT_JUDGE_SCHEMA} 的 JSON 对象；不要复述请求或历史文本。`)).toBe(true);
  });

  it("accepts exactly x ordered degree outcomes for every player", () => {
    const parsed = parseEffectJudgeResponse(JSON.stringify({
      protocol: EFFECT_JUDGE_SCHEMA,
      players: [{ player_key: "P1", display_name: "林", degrees: fourDegrees }]
    }), {
      settings: { degreeCount: 4, dieFaces: 8 },
      players: [{ playerKey: "P1" }]
    });
    expect(parsed.players[0].degrees).toEqual(fourDegrees);
  });

  it("rejects degree results without the required semantic anchors", () => {
    expect(() => parseEffectJudgeResponse(JSON.stringify({
      protocol: EFFECT_JUDGE_SCHEMA,
      players: [{
        player_key: "P1",
        degrees: [
          { degree: "大成功", outcome: "A" },
          { degree: "顺利", outcome: "B" },
          { degree: "失败", outcome: "C" },
          { degree: "大失败", outcome: "D" }
        ]
      }]
    }), {
      settings: { degreeCount: 4, dieFaces: 8 },
      players: [{ playerKey: "P1" }]
    })).toThrow("大成功、成功、失败、大失败");
  });

  it("extracts a fenced JSON result from rendered platform answer text", () => {
    const players = [
      { playerKey: "P1", displayName: "茂密" },
      { playerKey: "P2", displayName: "k" }
    ];
    const payload = {
      protocol: EFFECT_JUDGE_SCHEMA,
      players: players.map(player => ({
        player_key: player.playerKey,
        display_name: player.displayName,
        degrees: fourDegrees
      }))
    };
    const rendered = `模型 gemini\n\`\`\`json\n\n${JSON.stringify(payload)}\n\`\`\`\n输出积分 271`;
    const parsed = parseEffectJudgeResponse(rendered, {
      settings: { degreeCount: 4, dieFaces: 8 },
      players
    });
    expect(parsed.players).toHaveLength(2);
    expect(parsed.players[0].degrees[0]).toMatchObject({ degree: "大成功" });
  });

  it("rejects obsolete V1 face output instead of silently changing its meaning", () => {
    expect(() => parseEffectJudgeResponse(JSON.stringify({
      protocol: "FYMP_EFFECT_JUDGE_V1",
      players: [{ player_key: "P1", faces: fourDegrees.map((item, index) => ({ face: index + 1, ...item })) }]
    }), {
      settings: { degreeCount: 4, dieFaces: 10 },
      players: [{ playerKey: "P1" }]
    })).toThrow(`protocol=${EFFECT_JUDGE_SCHEMA}`);
  });

  it("maps the lowest and highest ten percent to extremes and weights the middle", () => {
    const degrees = [
      { degree: "大成功", outcome: "A" },
      { degree: "卓越成功", outcome: "B" },
      { degree: "成功", outcome: "C" },
      { degree: "失败", outcome: "D" },
      { degree: "惨败", outcome: "E" },
      { degree: "大失败", outcome: "F" }
    ];
    const faces = mapEffectDegreesToFaces(degrees, 20);
    expect(faces).toHaveLength(20);
    expect(faces.slice(0, 2).every((face: any) => face.degree === "大失败")).toBe(true);
    expect(faces.slice(-2).every((face: any) => face.degree === "大成功")).toBe(true);
    const counts = Object.fromEntries(degrees.map((item: any) => [
      item.degree,
      faces.filter((face: any) => face.degree === item.degree).length
    ]));
    expect(counts).toEqual({
      大成功: 2,
      卓越成功: 2,
      成功: 6,
      失败: 6,
      惨败: 2,
      大失败: 2
    });
    expect(faces.map((face: any) => face.face)).toEqual(Array.from({ length: 20 }, (_value, index) => index + 1));
  });

  it("supports the smallest legal D6/x4 distribution", () => {
    expect(mapEffectDegreesToFaces(fourDegrees, 6).map((face: any) => face.degree)).toEqual([
      "大失败", "失败", "失败", "成功", "成功", "大成功"
    ]);
  });

  it("continues the stack after plugin errors and preserves the current value", async () => {
    const result = await runPluginStack({
      phase: "input",
      value: [{ text: "原始输入" }],
      plugins: [
        { id: "broken", phase: "input", enabled: true, order: 1, run: async () => { throw new Error("积分不足"); } },
        { id: "working", phase: "input", enabled: true, order: 2, run: async ({ value }: any) => ({ value: [...value, { text: "继续" }] }) }
      ]
    });
    expect(result.runs.map((run: any) => run.status)).toEqual(["error", "completed"]);
    expect(result.runs.map((run: any) => run.order)).toEqual([1, 2]);
    expect(result.value).toEqual([{ text: "原始输入" }, { text: "继续" }]);
  });

  it("appends only the selected outcome and never exposes the roll or other faces to the formal input", () => {
    const transformed = applyEffectJudgeSelections([
      { 设定名: "林", 输入内容: "吃苹果" }
    ], [{
      playerKey: "P1",
      roll: 8,
      selected: { face: 8, degree: "大成功", outcome: "苹果无比美味" },
      faces: [
        { face: 1, degree: "大失败", outcome: "吃到虫子" },
        { face: 8, degree: "大成功", outcome: "苹果无比美味" }
      ]
    }]);
    expect(transformed[0].输入内容).toBe("吃苹果\n\n【效果判定】【大成功】苹果无比美味");
    expect(transformed[0].输入内容).not.toContain("吃到虫子");
    expect(transformed[0].输入内容).not.toContain("D20");
    expect(transformed[0].输入内容).not.toContain("骰面");
  });
});
