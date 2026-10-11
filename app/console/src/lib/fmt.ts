/** 数字/时间格式化：手机上要一眼能读，不要 1567 这种裸数字 */

export function num(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN");
}

export function compact(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + " 万";
  return String(Math.round(n));
}

export function bytes(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return (x >= 10 || i === 0 ? x.toFixed(0) : x.toFixed(2)) + " " + units[i];
}

/** CF 返回的是 "2026-10-09T03:35:30.449022Z"，Date 能吃；带 6 位小数的 Safari 也行 */
export function dt(v: unknown, withTime = true): string {
  if (v === null || v === undefined || v === "") return "—";
  // 数字按 epoch 毫秒处理（网关的 x-gw-fetched-at 就是毫秒），字符串才走 ISO/`YYYY-MM-DD` 那套
  const s = typeof v === "number" ? "" : String(v);
  const d = typeof v === "number" ? new Date(v) : new Date(s.length === 10 ? s + "T00:00:00Z" : s);
  if (Number.isNaN(d.getTime())) return s || "—";
  const p = (x: number) => String(x).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
}

export function rel(v: unknown): string {
  const s = String(v ?? "");
  if (!s) return "—";
  const d = new Date(s).getTime();
  if (Number.isNaN(d)) return s;
  const diff = Date.now() - d;
  const m = Math.round(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  const h = Math.round(m / 60);
  if (h < 24) return h + " 小时前";
  const dd = Math.round(h / 24);
  if (dd < 31) return dd + " 天前";
  return dt(v, false);
}

/** UUID / 长 ID 在手机上截断显示，完整值放 title 里 */
export function shortId(v: unknown, head = 8): string {
  const s = String(v ?? "");
  if (!s) return "—";
  return s.length > head * 2 ? s.slice(0, head) + "…" + s.slice(-4) : s;
}

export function hourLabel(t: string): string {
  // SQL 给的是 "2026-10-08 12:00:00"（无时区标记，实测是 UTC）
  const d = new Date(t.replace(" ", "T") + (t.length === 19 ? "Z" : ""));
  if (Number.isNaN(d.getTime())) return t;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:00`;
}
