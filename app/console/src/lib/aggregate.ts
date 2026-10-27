/**
 * 多账号合一模式（2026-10-27）。
 *
 * 用户口径：一次性把两个（或更多）账号的数据拉下来做加法 —— Workers 与 Pages 合并成一份，
 * 数量直接相加；域名页同样按账号合并展示。
 *
 * 三条硬约束（都是实测踩出来的，别再放松）：
 *  1. **只读**：合并视图里不摆任何写入口。写操作必须发生在单账号上下文里，
 *     否则"改的是哪个账号的 DNS"会变成猜谜。点条目 → 先切到所属账号再进详情。
 *  2. **按账号独立取数、独立失败**：一个账号令牌过期/权限不足，不能把整屏拖成错误页，
 *     其它账号照常出数，失败账号在顶部单独说明。
 *  3. **OAuth 账号在网页/网关模式下不可用**：它的 refresh token 只在系统钥匙串里，
 *     前端拿不到访问令牌。合并时跳过并如实说明，不假装成功。
 *
 * 状态只在本次会话有效（不落盘）：冷启动时保险箱还没解锁，list 是空的，
 * 持久化一个"合并中"只会制造"界面在合并、实际没账号"的脏状态。
 */
import { reactive } from "vue";
import { acctState, labelOf, type CfAccount } from "./accounts";
import { isNativeApp, loadConfig, saveConfig } from "./config";
import { requestReload } from "./bus";

export const agg = reactive({ on: false });

/** 账号数 ≥ 2 且已解锁，才谈得上合并 */
export function aggReady(): boolean {
  return acctState.list.length >= 2 && !acctState.locked;
}

/** 合并时可用的账号：网页/网关模式跳过 OAuth（拿不到长期凭据） */
export function aggAccounts(): CfAccount[] {
  const allowOAuth = isNativeApp();
  return acctState.list.filter((a) => allowOAuth || a.auth !== "oauth");
}

/** 被跳过的账号（用于顶部如实说明，不静默少一个账号） */
export function aggSkipped(): CfAccount[] {
  const allowOAuth = isNativeApp();
  return allowOAuth ? [] : acctState.list.filter((a) => a.auth === "oauth");
}

/** 账号 id → 显示名（别名优先）；找不到就空串，界面据此不摆账号标 */
export function nameOf(id?: string): string {
  if (!id) return "";
  const a = acctState.list.find((x) => x.id === id);
  return a ? labelOf(a) : "";
}

/**
 * 点合并视图里的条目：先切回它所属账号（合并模式随之关闭），再导航。
 * 切换要写本机配置，并把当前屏刷新一次 —— 详情页读的是"当前账号"，不切就会读成别人的数据。
 */
export function focusAccount(id: string): string {
  const a = acctState.list.find((x) => x.id === id);
  const wasAgg = agg.on;
  agg.on = false;
  if (!a) {
    if (wasAgg) requestReload(); // 账号找不到也要退回单账号视图，不能留着合并的旧数据
    return "";
  }
  const cur = loadConfig();
  if (cur.account !== a.id) {
    saveConfig({ ...cur, account: a.id, accountName: labelOf(a) });
    requestReload();
  } else if (wasAgg) {
    requestReload(); // 账号没变但退出了合并：当前屏必须重取成单账号视图
  }
  return labelOf(a);
}

/** 给列表项打上账号标；统一用 `__acc` / `__accName` 两个字段，组件里不各自造名字 */
export function tagAccount<T extends object>(items: T[], acc: CfAccount): Array<T & { __acc: string; __accName: string }> {
  return items.map((x) => ({ ...x, __acc: acc.id, __accName: labelOf(acc) }));
}

/**
 * 小并发池：多账号 × 多 zone 一次全打出去会把手机和 CF 配额一起打爆。
 * fn 自己负责 catch（这里不兜），失败隔离在调用方。
 */
export async function mapLimit<T, R>(list: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i]);
    }
  });
  await Promise.all(lanes);
  return out;
}
