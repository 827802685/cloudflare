/**
 * 探针脚本共用的凭证读取：环境变量 → F:\work\cf-probe\app\.dev.vars → F:\Documents\GitHub\Rin\.env.local
 * → 仓库内 app\gateway\.dev.vars（最后一档，让"只有这个仓库"的环境也能跑探针）。
 * 只读，绝不打印令牌内容，也绝不写进任何证据文件。
 *
 * 前两个外部来源排在前面是刻意的：换机器/换令牌时已有探针的行为不变，
 * 仓库内那份只是兜底，不是覆盖。任何探针脚本都**不许**再内联令牌字面量
 * （历史上 tools/probe-d1-kv.mjs 硬编码过一把真令牌，push 前会连 git 历史一起带出去）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tools/lib/token.mjs → 仓库根
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadCreds() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return { tok: process.env.CLOUDFLARE_API_TOKEN, acc: process.env.CLOUDFLARE_ACCOUNT_ID || "" };
  }
  const sources = [
    "F:/work/cf-probe/app/.dev.vars",
    "F:/Documents/GitHub/Rin/.env.local",
    resolve(REPO_ROOT, "app", "gateway", ".dev.vars"),
  ];
  for (const p of sources) {
    try {
      const s = readFileSync(p, "utf8");
      const tok = /^(?:CF_API_TOKEN|CLOUDFLARE_API_TOKEN)=(.+)$/m.exec(s)?.[1]?.trim();
      const acc = /^(?:CF_ACCOUNT_ID|CLOUDFLARE_ACCOUNT_ID)=(.+)$/m.exec(s)?.[1]?.trim();
      if (tok) return { tok, acc: acc || "" };
    } catch { /* 下一个来源 */ }
  }
  throw new Error("没找到令牌：设 CLOUDFLARE_API_TOKEN，或确认 F:/work/cf-probe/app/.dev.vars / Rin/.env.local 存在");
}
