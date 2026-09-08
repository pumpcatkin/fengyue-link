const AUTHOR_NAME = "八爪毛米";

// Keep every public author/community destination in one reviewed allowlist.
// Empty values are intentionally rendered as “待作者补充” and cannot open.
const AUTHOR_LINKS = Object.freeze({
  homepage: "",
  releasePost: "",
  feedbackPost: "",
  github: "https://github.com/pumpcatkin/fengyue-link"
});

const AUTHOR_LINK_LABELS = Object.freeze({
  homepage: "作者主页",
  releasePost: "风月发布帖",
  feedbackPost: "问题反馈帖",
  github: "GitHub 项目页"
});

function configuredAuthorUrl(key) {
  const normalizedKey = String(key || "");
  if (!Object.hasOwn(AUTHOR_LINKS, normalizedKey)) throw new Error("未知的作者信息链接");
  const value = AUTHOR_LINKS[normalizedKey];
  if (!value) throw new Error(`${AUTHOR_LINK_LABELS[normalizedKey]}链接待作者补充`);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${AUTHOR_LINK_LABELS[normalizedKey]}必须使用 HTTPS`);
  return url.href;
}

function publicAuthorInfo() {
  return {
    name: AUTHOR_NAME,
    links: Object.fromEntries(Object.keys(AUTHOR_LINKS).map(key => ({
      key,
      label: AUTHOR_LINK_LABELS[key],
      configured: Boolean(AUTHOR_LINKS[key]),
      url: AUTHOR_LINKS[key] || null
    })).map(item => [item.key, item]))
  };
}

module.exports = {
  AUTHOR_NAME,
  AUTHOR_LINKS,
  AUTHOR_LINK_LABELS,
  configuredAuthorUrl,
  publicAuthorInfo
};
