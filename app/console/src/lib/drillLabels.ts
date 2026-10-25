/**
 * 下钻 / 缓存状态这类**枚举值**的中文化。
 *
 * CF 的 Analytics 返回的是英文枚举（desktop / mobile / tablet、hit / miss / none …），
 * 界面直接把枚举甩给人看是偷懒：同一个概念在控制台叫「桌面」，在这里叫「desktop」。
 * 这里做的是**显示层翻译**，不改数据本身 —— 未登记的值一律原样透出，不猜、不吞。
 *
 * `bot` 那档要特别说明：CF 对"没识别出 bot 类别"的请求给的是**空字符串**
 * （本账号 7 天里 42412 条都是这个），所以空值显示成「未识别」而不是空白。
 * 这不等于"确认是人类" —— 只能说到"CF 没给出类别"为止。
 */
const MAPS: Record<string, Record<string, string>> = {
  device: { desktop: "桌面", mobile: "手机", tablet: "平板", other: "其他" },
  cache: {
    none: "未缓存",
    hit: "命中",
    miss: "未命中",
    dynamic: "动态生成",
    bypass: "绕过缓存",
    revalidated: "重新验证",
    expired: "已过期",
    stale: "陈旧",
    updating: "更新中",
  },
  bot: {
    "AI Crawler": "AI 爬虫",
    "AI Search": "AI 搜索",
    "Page Preview": "页面预览",
    "Search Engine Crawler": "搜索引擎爬虫",
    "Verified Bot": "已验证机器人",
    "Likely Automated": "疑似自动化",
    "Likely Human": "疑似人类",
  },
};

export type LabelScope = "device" | "cache" | "bot" | "host" | "path";

/** 枚举值 → 中文；没登记过的原样返回（宁可露出英文，也不要编一个假中文名） */
export function enumLabel(scope: LabelScope, k: unknown): string {
  const key = String(k ?? "").trim();
  if (!key) return scope === "bot" ? "未识别" : "未给出";
  return MAPS[scope]?.[key] ?? key;
}
