/**
 * 系统钥匙串存储（Android Keystore / iOS Keychain）。
 *
 * 为什么单独一层：OAuth 的 refresh token 是长期凭据，不能像 API Token 那样塞进
 * `vault.ts` 的「密钥与密文同存本机」设备保险箱 —— 那种做法防翻文件、不防整库拖走，
 * 对长期凭据不够。这里用 `@aparajita/capacitor-secure-storage`：Android 侧由
 * AndroidKeyStore 生成 AES-GCM 密钥、密文落 SharedPreferences，密钥不可导出。
 *
 * 浏览器里（PWA）没有系统钥匙串，插件会退化成 WebStorage。OAuth 本来也只在 APK 提供，
 * 所以这一层在网页里只是保证「不会崩」，不承诺安全边界 —— 界面据此不展示 OAuth 入口。
 */
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { isNativeApp } from "./config";

/** 加前缀，避免与别的插件/应用共用命名空间时撞键 */
const PREFIX = "cfconsole.";

/** 这台设备的存储属于哪一档：keystore = 硬件级；web = 浏览器存储（仅供开发调试） */
export function secureBackend(): "keystore" | "web" {
  return isNativeApp() ? "keystore" : "web";
}

export async function secureGet(key: string): Promise<string | null> {
  try {
    const v = await SecureStorage.get(PREFIX + key);
    return typeof v === "string" ? v : v === null || v === undefined ? null : String(v);
  } catch {
    // 键不存在 / 系统拒绝：都当"没有"，由调用方决定下一步（不要在这里伪造空串）
    return null;
  }
}

export async function secureSet(key: string, value: string): Promise<void> {
  await SecureStorage.set(PREFIX + key, value);
}

export async function secureRemove(key: string): Promise<void> {
  try {
    await SecureStorage.remove(PREFIX + key);
  } catch {
    /* 本来就没有：删除是幂等的 */
  }
}
