#!/usr/bin/env node
/**
 * 分页参数上限扫描：App 的每个列表接口一次能拉多少条，`per_page` 超过多少会被拒。
 *
 * 起因：网关 Pages 列表写 `per_page=50` → `400 code 8000024 Invalid list options`，
 * 而 /zones、/workers/scripts 用 100 都没事 —— 上限是按接口各自定的，不能统一假设。
 * 全部只读。输出：docs/evidence/list-limits.json
 */
import { writeFileSync } from "node:fs";
import { loadCreds } from "./lib/token.mjs";

const { tok: TOK, acc: ACC } = loadCreds();
const B = "https://api.cloudflare.com/client/v4";
const H = { authorization: "Bearer " + TOK };

const zones = (await fetch(B + "/zones?per_page=5", { headers: H }).then((r) => r.json())).result.map((z) => z.id);
const ZT = zones[0];

const targets = [
  ["pagesProjects", `/accounts/${ACC}/pages/projects`],
  ["pagesDeployments", `/accounts/${ACC}/pages/projects/__nope__/deployments`],
  ["zones", "/zones"],
  ["workersScripts", `/accounts/${ACC}/workers/scripts`],
  ["workerVersions", `/accounts/${ACC}/workers/scripts/rin-server/versions`],
  ["workerDeployments", `/accounts/${ACC}/workers/scripts/rin-server/deployments?environment=production`],
  ["dnsRecords", `/zones/${ZT}/dns_records`],
  ["zoneSettings", `/zones/${ZT}/settings`],
  ["workerDomains", `/accounts/${ACC}/workers/domains`],
  ["kvNamespaces", `/accounts/${ACC}/storage/kv/namespaces`],
  ["d1Databases", `/accounts/${ACC}/d1/database`],
];
const sizes = [5, 10, 20, 25, 50, 100];

const out = { verifiedAt: new Date().toISOString(), accountTag: ACC, zoneTag: ZT, results: {} };
for (const [name, path] of targets) {
  const row = { maxOkPerPage: null, notes: [], sampleTotal: null };
  for (const n of sizes) {
    const url = path + (path.includes("?") ? "&" : "?") + "per_page=" + n;
    const res = await fetch(B + url, { headers: H, signal: AbortSignal.timeout(25000) });
    const j = await res.json().catch(() => null);
    const e = j?.errors?.[0];
    if (res.status === 200 && (!j || j.success !== false)) {
      row.maxOkPerPage = n;              // 档位从小到大，最后一次通过的才是实际上限（或"至少这么大"）
      const r = j?.result;
      const items = Array.isArray(r) ? r : (r?.items ?? r?.deployments ?? r?.schedules ?? []);
      if (n === 5) row.sampleTotal = j?.result_info?.total_count ?? r?.total_count ?? (Array.isArray(items) ? items.length : null);
    } else {
      row.notes.push(`per_page=${n} → ${res.status} ${e ? e.code + " " + e.message : ""}`.trim());
    }
  }
  // 上限 = 最后一个通过的档位；全过就记 100（说明至少 100 可用）
  out.results[name] = row;
  console.log(name.padEnd(18), "最大通过档位", String(row.maxOkPerPage).padEnd(5), "| 6 档里被拒", row.notes.length, "次", row.notes[0] ? "| 例：" + row.notes[0] : "");
}

writeFileSync("docs/evidence/list-limits.json", JSON.stringify(out, null, 2));
console.log("\n写 docs/evidence/list-limits.json");
