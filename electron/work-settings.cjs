// Fields exposed by the platform's custom configuration editor. Metadata and
// account identifiers are deliberately not sent to room members.
const GLOBAL_FIELDS = ["pre_prompt", "pre_text", "post_text", "world_book", "regex_replaces", "custom_css", "bg_image", "bg_mobile", "is_text_prompt_available", "ai_summary", "ai_summary_available", "memory_type", "memory_palace", "gen_conf", "shortcut_commands", "preset_chats", "model"];
function publicGlobalConfig(config = {}) {
  return Object.fromEntries(GLOBAL_FIELDS.filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]]));
}
function countConfigCharacters(value) {
  if (typeof value === "string") return [...value].length;
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((sum, item) => sum + countConfigCharacters(item), 0);
}
function changedGlobalFields(current, expected, next) {
  if (!next || typeof next !== "object" || Array.isArray(next) || !expected || typeof expected !== "object") throw new Error("全局配置必须是 JSON 对象");
  const patch = {};
  for (const key of Object.keys(next)) {
    if (!GLOBAL_FIELDS.includes(key)) throw new Error(`不允许修改配置字段：${key}`);
    if (JSON.stringify(next[key]) === JSON.stringify(expected[key])) continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(expected[key])) throw new Error(`平台的 ${key} 已被其他操作修改，请刷新配置后再保存`);
    if (current[key] != null && (typeof current[key] !== typeof next[key] || Array.isArray(current[key]) !== Array.isArray(next[key]))) throw new Error(`配置字段 ${key} 的数据类型不正确`);
    patch[key] = next[key];
  }
  if (Object.keys(expected).some(key => !Object.hasOwn(next, key))) throw new Error("请保留全部配置字段；清空文本请填写空字符串");
  return patch;
}
module.exports = { publicGlobalConfig, countConfigCharacters, changedGlobalFields };
