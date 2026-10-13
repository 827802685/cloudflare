/**
 * 多账号（多 CF 令牌）。
 *
 * 令牌**不明文落盘** —— 交给 vault.ts 用「口令派生密钥」加密后再存（见那里的说明）。
 * 这一层管账号的内存态与加解密编排：
 *   - 保险箱没建 → `exists=false`，界面引导设口令；
 *   - 建了但没解锁 → `locked=true`，list 为空，界面只给解锁入口；
 *   - 解锁后 → list 是解密出来的账号，任何增删都同步重新加密写回。
 *
 * 与设备令牌的分工不变：设备令牌回答「谁能用这个网关」，CF 令牌回答「用哪个账号的数据」。
 */
import { reactive } from "vue";
import * as vault from "./vault";

export interface CfAccount {
  /** 该账号的 CF API Token（Bearer）；请求时经 x-cf-token 带给网关 */
  token: string;
  /** CF 账号 id（32 位 hex），添加时拿令牌打 /accounts 得到 */
  id: string;
  /** CF 账号名（从 CF 来，只读） */
  name: string;
  /** 用户起的别名；空则回退到 name */
  alias: string;
}

const HEX32 = /^[0-9a-f]{32}$/i;
/** 上一版（明文）用的 key —— 只为一次性迁移，迁完就删 */
const LEGACY_KEY = "cfconsole.accounts.v1";

function norm(a: any): CfAccount | null {
  const token = String(a?.token ?? "").trim();
  const id = String(a?.id ?? "").trim().toLowerCase();
  if (!token || !HEX32.test(id)) return null;
  return { token, id, name: String(a?.name ?? "").trim(), alias: String(a?.alias ?? "").trim() };
}

/** 读上一版遗留的明文账号（迁移用；读完由设置页引导加密并清掉） */
export function readLegacyPlain(): CfAccount[] {
  try {
    const s = localStorage.getItem(LEGACY_KEY);
    if (!s) return [];
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr.map(norm).filter((x): x is CfAccount => !!x);
  } catch {
    return [];
  }
}
export function clearLegacyPlain(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}

export const acctState = reactive<{
  list: CfAccount[];
  /** 有保险箱但还没解锁（界面给解锁入口） */
  locked: boolean;
  /** 这台设备上有没有保险箱（false = 首次，引导设口令） */
  exists: boolean;
  /** 内存里暂存的旧明文账号（迁移中），加密落盘后清空 */
  legacy: CfAccount[];
}>({
  list: [],
  locked: true,
  exists: vault.vaultExists(),
  legacy: vault.vaultExists() ? [] : readLegacyPlain(),
});

export function getAccounts(): CfAccount[] {
  return acctState.list;
}
export function findAccount(id: string): CfAccount | null {
  return acctState.list.find((x) => x.id === id) || null;
}
/** 界面显示名：别名优先，没有就用 CF 给的账号名，再没有就退账号 id 前 8 位 */
export function labelOf(a: CfAccount): string {
  return a.alias || a.name || a.id.slice(0, 8) + "…";
}

/** 首次：设口令建保险箱（内存里有旧明文账号就一并加密进去） */
export async function createVault(pass: string): Promise<void> {
  await vault.createVault(pass);
  const seed = acctState.legacy.map(norm).filter((x): x is CfAccount => !!x);
  acctState.list = seed;
  if (seed.length) await vault.seal(seed);
  clearLegacyPlain();
  acctState.legacy = [];
  acctState.locked = false;
  acctState.exists = true;
}

export async function unlockAccounts(pass: string): Promise<void> {
  const list = await vault.unlock(pass);
  acctState.list = list.map(norm).filter((x): x is CfAccount => !!x);
  acctState.locked = false;
  acctState.exists = true;
}

export function lockAccounts(): void {
  vault.lock();
  acctState.list = [];
  acctState.locked = true;
}

export async function addAccount(a: CfAccount): Promise<CfAccount[]> {
  const clean = norm(a);
  if (!clean) throw new Error("账号数据不完整（缺令牌或账号 id）");
  acctState.list = [...acctState.list.filter((x) => x.id !== clean.id), clean];
  await vault.seal(acctState.list);
  return acctState.list;
}

export async function removeAccount(id: string): Promise<CfAccount[]> {
  acctState.list = acctState.list.filter((x) => x.id !== id);
  if (!acctState.locked) await vault.seal(acctState.list);
  return acctState.list;
}

/** 改口令（用旧口令读出、用新口令重新加密整个列表） */
export async function changePassphrase(oldPass: string, newPass: string): Promise<void> {
  const list = await vault.changePassphrase(oldPass, newPass);
  acctState.list = list.map(norm).filter((x): x is CfAccount => !!x);
}

/** 销毁保险箱（连密文一起删）。不可逆，UI 要二次确认。 */
export function destroyAll(): void {
  vault.destroyVault();
  acctState.list = [];
  acctState.locked = true;
  acctState.exists = false;
}
