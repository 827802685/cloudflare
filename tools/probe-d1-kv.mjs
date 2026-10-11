/** 探针：D1 列表 + 详情 + 查询，KV 列表 + keys */
import { loadCreds } from "./lib/token.mjs";
const { tok: token, acc: acct } = loadCreds();
if (!token || !acct) { console.error("没读到令牌或账号 id：设 CLOUDFLARE_API_TOKEN，或确认 app/gateway/.dev.vars 存在"); process.exit(1); }
const base = "https://api.cloudflare.com/client/v4";

async function main() {
  // D1 databases
  const r1 = await fetch(base + "/accounts/" + acct + "/d1/database", {
    headers: { Authorization: "Bearer " + token },
  });
  const t1 = await r1.text();
  let j1;
  try {
    j1 = JSON.parse(t1);
  } catch (e) {
    j1 = { _t: t1.slice(0, 400) };
  }
  console.log("D1 list:", r1.status, JSON.stringify(j1).slice(0, 800));

  // D1 query on first db
  if (j1.result && j1.result.length) {
    const db = j1.result[0];
    console.log("  → db:", db.id, db.name, db.version || "no version");
    const r3 = await fetch(
      base + "/accounts/" + acct + "/d1/database/" + db.id + "/query",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sql: 'SELECT name FROM sqlite_master WHERE type="table" LIMIT 10',
        }),
      }
    );
    const t3 = await r3.text();
    let j3;
    try {
      j3 = JSON.parse(t3);
    } catch (e) {
      j3 = { _t: t3.slice(0, 400) };
    }
    console.log("D1 query:", r3.status, JSON.stringify(j3).slice(0, 600));

    // D1 schema via PRAGMA
    const r5 = await fetch(
      base + "/accounts/" + acct + "/d1/database/" + db.id + "/query",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql: "PRAGMA table_info(info)" }),
      }
    );
    const t5 = await r5.text();
    let j5;
    try {
      j5 = JSON.parse(t5);
    } catch (e) {
      j5 = { _t: t5.slice(0, 400) };
    }
    console.log("D1 schema:", r5.status, JSON.stringify(j5).slice(0, 600));
  }

  // KV namespaces
  const r2 = await fetch(base + "/accounts/" + acct + "/storage/kv/namespaces", {
    headers: { Authorization: "Bearer " + token },
  });
  const t2 = await r2.text();
  let j2;
  try {
    j2 = JSON.parse(t2);
  } catch (e) {
    j2 = { _t: t2.slice(0, 400) };
  }
  console.log("\nKV list:", r2.status, JSON.stringify(j2).slice(0, 800));

  // KV keys for first namespace
  if (j2.result && j2.result.length) {
    const ns = j2.result[0];
    console.log("  → ns:", ns.id, ns.title, ns.id_presentation || "");
    const r4 = await fetch(
      base +
        "/accounts/" +
        acct +
        "/storage/kv/namespaces/" +
        ns.id +
        "/keys?limit=10",
      { headers: { Authorization: "Bearer " + token } }
    );
    const t4 = await r4.text();
    let j4;
    try {
      j4 = JSON.parse(t4);
    } catch (e) {
      j4 = { _t: t4.slice(0, 400) };
    }
    console.log("KV keys:", r4.status, JSON.stringify(j4).slice(0, 600));

    // KV metadata for first key
    if (j4.result && j4.result.length && j4.result[0].name) {
      const keyName = j4.result[0].name;
      const r6 = await fetch(
        base +
          "/accounts/" +
          acct +
          "/storage/kv/namespaces/" +
          ns.id +
          "/metadata/" +
          encodeURIComponent(keyName),
        { headers: { Authorization: "Bearer " + token } }
      );
      const t6 = await r6.text();
      let j6;
      try {
        j6 = JSON.parse(t6);
      } catch (e) {
        j6 = { _t: t6.slice(0, 400) };
      }
      console.log(
        "KV meta:",
        r6.status,
        JSON.stringify(j6).slice(0, 400)
      );
    }
  }
}

main().catch((e) => console.error(e));
