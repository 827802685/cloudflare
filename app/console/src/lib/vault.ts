/**
 * 令牌加密存储（本地保险箱）。
 *
 * 为什么要有它：CF API Token 是账号级凭据。明文躺在 localStorage 里，等于把钥匙插在门上 ——
 * 手机被云同步、备份被导出、或有人拿到这台设备的存储，令牌就是白送的。
 *
 * 做法（与同类产品的通行做法一致，见 docs/08 §2）：主口令经 PBKDF2-SHA256（31 万次）派生
 * AES-256-GCM 密钥，整个账号列表加密成一个 blob 存 localStorage；**密钥只活在内存**，
 * 解锁一次管到关闭页面。口令本身不落盘 —— 所以把 localStorage 整个拖走也解不开。
 *
 * 这一层只管「加解密一个 blob」，账号的增删编排在 accounts.ts。
 * 将来出 APK 时这层可以换成 Capacitor 的安全存储（Android Keystore），接口不用动。
 */
import type { CfAccount } from "./accounts";

const KEY = "cfconsole.vault.v1";
const ITER = 310_000;

interface VaultBlob {
  v: 1;
  salt: string;
  iter: number;
  iv: string;
  ct: string;
}

/** 解锁后驻留内存的 AES 密钥；上锁即丢弃 */
let dataKey: CryptoKey | null = null;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function raw(): VaultBlob | null {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return null;
    const b = JSON.parse(s) as VaultBlob;
    return b && b.v === 1 && b.salt && b.iv && b.ct ? b : null;
  } catch {
    return null;
  }
}

/** 这台设备上有没有已加密的保险箱（有 = 需要口令解锁） */
export function vaultExists(): boolean {
  return raw() !== null;
}

export function isUnlocked(): boolean {
  return dataKey !== null;
}

/** 上锁：丢掉内存里的密钥。之后拿不到任何令牌，直到重新解锁 */
export function lock(): void {
  dataKey = null;
}

async function derive(pass: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: buf(salt), iterations: iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptBlob(key: CryptoKey, salt: Uint8Array, iter: number, list: CfAccount[]): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, enc.encode(JSON.stringify(list)));
  const blob: VaultBlob = { v: 1, salt: toB64(salt), iter, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
  return JSON.stringify(blob);
}

function writeBlob(json: string): void {
  try {
    localStorage.setItem(KEY, json);
  } catch {
    throw new Error("本机存储写不进去（隐私模式？）");
  }
}

/** 首次创建保险箱：设口令、写入一个空列表。salt 全新。 */
export async function createVault(pass: string): Promise<void> {
  if (pass.length < 6) throw new Error("口令至少 6 位");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(pass, salt, ITER);
  writeBlob(await encryptBlob(key, salt, ITER, []));
  dataKey = key;
}

/**
 * 用口令开箱，返回里面的账号列表。
 * 口令不对（或密文被改过）→ GCM 校验失败会抛错；调用方据此说「口令不对」，别笼统说「解密失败」。
 */
export async function unlock(pass: string): Promise<CfAccount[]> {
  const b = raw();
  if (!b) {
    dataKey = null;
    return [];
  }
  const salt = fromB64(b.salt);
  const key = await derive(pass, salt, b.iter || ITER);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64(b.iv)) }, key, buf(fromB64(b.ct)));
  dataKey = key;
  const list = JSON.parse(dec.decode(plain));
  return Array.isArray(list) ? list : [];
}

/** 把账号列表加密写回。必须已解锁，且盐与解锁时一致（所以密钥复用得上）。 */
export async function seal(list: CfAccount[]): Promise<void> {
  if (!dataKey) throw new Error("保险箱没解锁，无法写入");
  const b = raw();
  if (!b) throw new Error("保险箱不存在，先 createVault");
  writeBlob(await encryptBlob(dataKey, fromB64(b.salt), b.iter || ITER, list));
}

/** 改口令：先用旧密钥读出内容，再用新口令重建。 */
export async function changePassphrase(oldPass: string, newPass: string): Promise<CfAccount[]> {
  const list = await unlock(oldPass);
  if (newPass.length < 6) throw new Error("新口令至少 6 位");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(newPass, salt, ITER);
  writeBlob(await encryptBlob(key, salt, ITER, list));
  dataKey = key;
  return list;
}

/** 彻底删掉保险箱（连密文一起）。不可逆，UI 要二次确认。 */
export function destroyVault(): void {
  dataKey = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
