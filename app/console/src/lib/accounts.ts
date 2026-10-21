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
import { isNativeApp } from "./config";

export interface CfAccount {
  /**
   * 该账号的 CF API Token（Bearer）。
   * `auth === "oauth"` 时**恒为空字符串** —— OAuth 的凭据（refresh token）在系统钥匙串里，
   * 由 oauth.ts 按 `credRef` 取，绝不进这个列表（列表是会被整体加密落盘的，钥匙串不该被复制一份）。
   */
  token: string;
  /** CF 账号 id（32 位 hex），添加时拿令牌（或 OAuth access token）打 /accounts 得到 */
  id: string;
  /** CF 账号名（从 CF 来，只读） */
  name: string;
  /** 用户起的别名；空则回退到 name */
  alias: string;
  /** 认证方式：缺省（老数据）= api_token；oauth 只在 APK 直连模式可用（docs/16） */
  auth?: "api_token" | "oauth";
  /** 仅 oauth：系统钥匙串里那条授权的键。一个 credRef 对应一次授权 */
  credRef?: string;
}

const HEX32 = /^[0-9a-f]{32}$/i;
/** 上一版（明文）用的 key —— 只为一次性迁移，迁完就删 */
const LEGACY_KEY = "cfconsole.accounts.v1";

/**
 * APK 直连模式**不设解锁口令**（2026-10-18 定的）：令牌由 vault.ts 的设备密钥保险箱
 * 自动加密（首启随机生成 AES-256 密钥，无口令），换来"粘令牌即用"的最短路径。
 * 诚实边界：密钥与密文同在本机，防「翻文件」不防「整库拖走」—— 所以防线仍是
 * 「令牌权限最小化 + 手机锁屏」。网页 / PWA 不受影响，仍走口令派生的口令保险箱。
 */
const nativeMode = isNativeApp();

/**
 * 直连模式的启动装载：有设备密文就解；没有就从老版明文 key（cfconsole.accounts.v1，
 * 历史版本装过的话）迁移进来，加密落盘后清掉旧的。解密失败（换机/清了应用数据）
 * 按空列表处理，让设置页回到"粘一把令牌"的起点，而不是卡死。
 */
async function nativeLoad(): Promise<CfAccount[]> {
  if (vault.deviceVaultExists()) {
    try {
      return await vault.deviceUnlock();
    } catch {
      return [];
    }
  }
  const legacy = readLegacyPlain();
  if (legacy.length) {
    await vault.deviceSeal(legacy);
    clearLegacyPlain();
  }
  return legacy;
}

function norm(a: any): CfAccount | null {
  const id = String(a?.id ?? "").trim().toLowerCase();
  if (!HEX32.test(id)) return null;
  // 认证方式缺省按 api_token（兼容升级前的存储）；oauth 必须有 credRef，令牌字段留空
  const auth: "api_token" | "oauth" = a?.auth === "oauth" ? "oauth" : "api_token";
  const credRef = String(a?.credRef ?? "").trim();
  const token = String(a?.token ?? "").trim();
  if (auth === "oauth" ? !credRef : !token) return null;
  const base: CfAccount = { token: auth === "oauth" ? "" : token, id, name: String(a?.name ?? "").trim(), alias: String(a?.alias ?? "").trim() };
  return auth === "oauth" ? { ...base, auth, credRef } : base;
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
  /** 有保险箱但还没解锁（界面给解锁入口）；直连模式恒为 false（没有口令这回事） */
  locked: boolean;
  /** 这台设备有没有可用的账号存储（false = 首次，引导设口令）；直连模式恒为 true */
  exists: boolean;
  /** 内存里暂存的旧明文账号（迁移中），加密落盘后清空 */
  legacy: CfAccount[];
}>({
  list: [],
  locked: true,
  exists: false,
  legacy: [],
});

if (nativeMode) {
  // 直连模式永远是"已就绪、未上锁"状态，异步把加密数据解出来。
  // 必须放在 acctState 声明之后：这里要往 reactive 状态上写。
  acctState.exists = true;
  acctState.locked = false;
  void nativeLoad()
    .then((list) => {
      acctState.list = list.map(norm).filter((x): x is CfAccount => !!x);
    })
    .catch(() => {
      /* 解不开就当空列表：设置页仍是可用的起点 */
    });
} else {
  // 网页 / PWA：口令保险箱模式（原语义不变）
  acctState.exists = vault.vaultExists();
  acctState.legacy = vault.vaultExists() ? [] : readLegacyPlain();
}

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

/** 首次：设口令建保险箱（内存里有旧明文账号就一并加密进去）。直连模式没有口令，只把状态置成"就绪" */
export async function createVault(pass: string): Promise<void> {
  if (nativeMode) {
    acctState.locked = false;
    acctState.exists = true;
    return;
  }
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
  if (nativeMode) {
    acctState.list = (await nativeLoad()).map(norm).filter((x): x is CfAccount => !!x);
    acctState.locked = false;
    acctState.exists = true;
    return;
  }
  const list = await vault.unlock(pass);
  acctState.list = list.map(norm).filter((x): x is CfAccount => !!x);
  acctState.locked = false;
  acctState.exists = true;
}

export function lockAccounts(): void {
  if (nativeMode) return; // 直连没有口令，"上锁"无从谈起（界面在直连模式也不给这个按钮）
  vault.lock();
  acctState.list = [];
  acctState.locked = true;
}

export async function addAccount(a: CfAccount): Promise<CfAccount[]> {
  const clean = norm(a);
  if (!clean) throw new Error("账号数据不完整（缺令牌或账号 id）");
  acctState.list = [...acctState.list.filter((x) => x.id !== clean.id), clean];
  if (nativeMode) await vault.deviceSeal(acctState.list);
  else await vault.seal(acctState.list);
  return acctState.list;
}

export async function removeAccount(id: string): Promise<CfAccount[]> {
  acctState.list = acctState.list.filter((x) => x.id !== id);
  if (nativeMode) await vault.deviceSeal(acctState.list);
  else if (!acctState.locked) await vault.seal(acctState.list);
  return acctState.list;
}

/** 改口令（用旧口令读出、用新口令重新加密整个列表）。直连模式没有口令，不该被调到 */
export async function changePassphrase(oldPass: string, newPass: string): Promise<void> {
  if (nativeMode) throw new Error("直连模式没有解锁口令，无从修改");
  const list = await vault.changePassphrase(oldPass, newPass);
  acctState.list = list.map(norm).filter((x): x is CfAccount => !!x);
}

/** 删掉这台设备的全部账号。不可逆，UI 要二次确认。 */
export function destroyAll(): void {
  if (nativeMode) {
    vault.deviceDestroy();
    acctState.list = [];
    acctState.exists = true; // 直连模式存储永远"就绪"，删光了就是空列表
    return;
  }
  vault.destroyVault();
  acctState.list = [];
  acctState.locked = true;
  acctState.exists = false;
}
