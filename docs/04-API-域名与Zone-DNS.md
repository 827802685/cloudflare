# 04 · API 目录：Workers 自定义域名、Zone 路由、DNS 与站点设置

覆盖你要的第四块功能：**自定义 Workers 域名**。顺带把 Zone 侧的 DNS / 站点设置 / 清缓存一并查清了。这一块只读部分 100% 实测通过。

## 1. Workers 自定义域名（核心，全部实测）

| 用途 | 请求 | 结果 |
|---|---|---|
| 列表 | `GET /accounts/{a}/workers/domains` | `200`，**6 条** |
| 单条 | `GET /accounts/{a}/workers/domains/{id}` | `200` |
| **绑定** | `PUT /accounts/{a}/workers/domains` | 用非法域名探测 → `400 code 10082 Can't infer zone from route, please specify zone for "nope.invalid-tld"` → **路由可达、鉴权通过、校验已到业务层，当前令牌有绑定权限** |
| 解绑 | `DELETE /accounts/{a}/workers/domains/{id}` | 未发请求（写操作，待授权） |

真实数据（你账号现状）：

```
acct.example.com      → rin-server        env=production enabled=true previews=false cert=4d597121
rss.acct.example.com  → rssworker         …cert=74fb634e
news.acct.example.com → hot-news          …cert=83bd8352
mail.acct.example.com → mail              …cert=f56d8a6d
jtb.acct.example.com  → web-clipboard     …cert=7b5683a2
1.acct.example.com    → 1                 …cert=87fe165f
```

对象结构：

```jsonc
{ "id": "566001fed4df3107dd8d2b26bef3844a56c618a5",
  "zone_id": "50c463774e5fc1009c434c996d13353d",
  "zone_name": "acct.example.com",
  "hostname": "jtb.acct.example.com",
  "service": "web-clipboard",
  "environment": "production",
  "cert_id": "7b5683a2-5ea0-4f43-91db-b46ec4e70956",
  "previews_enabled": false,
  "enabled": true }
```

**绑定的正式请求体**（`10082` 的报错告诉我们 zone 可以省但省不了推断失败）：

```
PUT /accounts/{a}/workers/domains
{ "hostname": "abc.acct.example.com", "service": "rin-server", "environment": "production" }
```

绑定动作的真实代价，UI 上必须写清楚，因为它是**三个动作合在一起**：

1. 在 `acct.example.com` 这个 zone 里**自动创建一条代理型 DNS 记录**；
2. **签发一张 Advanced Certificate**（对象里的 `cert_id` 就是它），走 Let's Encrypt/CA 流程，有速率限制；
3. 把 Worker 挂到这个 hostname 上。

所以在手机上"解绑一个域名"= 删证书 + 删 DNS 记录 + 解除绑定。做二次确认弹窗时，别只写"确定解绑吗"，要把这三条列出来。另外 Advanced Certificate 每 zone 数量有限额，误绑再解绑攒不出问题，但反复点会撞 CA 速率限制 —— 建议 UI 上做 30 秒冷却。

## 2. Zone 侧的 Workers 路由（老机制，仍在用）

```
GET /zones/{z}/workers/routes → 200
[ { "id": "48caaea6c5f647c4734968e1b9c15546",
    "pattern": "*blog.acct.example.com/*",
    "script": "rin-server",
    "request_limit_fail_open": false } ]
```

- 路由是 **zone 作用域**：`GET /accounts/{a}/workers/routes` → `400 code 7003 路由不存在`。别按 account 找。
- 你的 `blog.acct.example.com` 就是走 route 而不是自定义域名（DNS 里那条 CNAME 指向 `blog.acct.example.com.eo.dnse5.com`，`proxied=false`，所以 blog 其实是外部源站；route 匹配 `*blog.acct.example.com/*` 但只有命中特定路径才进 Worker —— 这类"route + 外部源"的混用状态，看板要能显示清楚，否则你会以为 blog 是 Worker 在服务）。
- 写：`POST/PATCH/DELETE /zones/{z}/workers/routes[/{id}]`，body `{pattern, script}`（`script` 为 `null` 表示该路由只跳过 Worker）。当前令牌有没有 Zone Settings 写权限没测（DNS 写已经被证明缺，见 §3）。

## 3. DNS 记录：读全通、写被权限挡住

| 请求 | 结果 | 结论 |
|---|---|---|
| `GET /zones/{z}/dns_records?per_page=50` | `200`，14 条：`AAAA 6 · CNAME 2 · MX 3 · TXT 3`，其中 `proxied=true` 7 条 | 读 OK |
| `GET /zones/{z}/dns_records?type=A` | `200`，`[]` | 按类型过滤可用（你现在确实没有 A 记录，IPv4 走 CNAME/AAAA） |
| `GET /zones/{z}/dns_records/{id}` | `200` | 单条 OK |
| `GET /zones/{z}/dns_records/export` | `200`，**纯文本 zone 文件**（`;; Domain: acct.example.com. ;; Exported: 2026-10-09 …`） | 导出功能可以白送，注意它不是 JSON |
| `POST /zones/{z}/dns_records`（故意只传 `{}`） | **`403 code 10000 Authentication error`** | **令牌缺 `Zone / DNS / Edit` 权限**，DNS 增删改做不了 |

记录对象结构：

```jsonc
{ "id": "f2c7ec45a750517b4b8257f2a1b4dc47", "name": "blog.acct.example.com", "type": "CNAME",
  "content": "blog.acct.example.com.eo.dnse5.com", "proxiable": true, "proxied": false,
  "ttl": 1, "settings": { "flatten_cname": false }, "meta": {}, "comment": null, "tags": [],
  "created_on": "…", "modified_on": "…" }
```

`ttl: 1` 是 "Auto"。写记录时 `proxied` 与 `type/content` 有组合校验（比如 MX 不能 proxied），这些校验码要等权限补齐才能实测。

→ **解法见 `05` 分册**：新建一把带 `Zone:DNS:Edit` 的令牌即可，不需要换账号也不需要付费。

## 4. Zone 基础信息与站点设置（实测）

```
GET /zones/{z} → 200
{ "id":"20017d32…89e", "name":"acct.example.com", "status":"active", "paused":false,
  "type":"full", "development_mode":0, "name_servers":[…], "vanity_name_servers":[…],
  "plan":{"id":"free","name":"Free Website","legacy_id":"free",…}, … }
```

```
GET /zones/{z}/settings → 200，56 项，其中 editable 44 项、当前值为 "off" 的 19 项
每项：{ "id": "always_use_https", "value": "on", "modified_on": null, "editable": true }
```

前几项实测值：`0rtt=on`、`advanced_ddos=on(不可编辑)`、`always_online=off`、`always_use_https=on`、`automatic_https_rewrites=on`、`brotli=on`、`browser_cache_ttl=14400`、`browser_check=on`。

改单项：`PATCH /zones/{z}/settings/{id}`，body `{"value": "on"}`。`editable:false` 的项目要在 UI 里灰掉（`advanced_ddos` 就是），44 个可编辑项够做一版"站点设置"页了。

Universal SSL：

```
GET /zones/{z}/ssl/universal/settings → 200 {"enabled": true, "certificate_authority": "google"}
```

SSL for SaaS（`custom_hostnames`）：**`403 code 1404 No quota has been allocated for this zone or for this account`** —— 免费套餐没这块配额，功能直接砍，不用考虑。

## 5. 清缓存（Cache Purge）

```
POST /zones/{z}/purge_cache
  {"purge_everything": false, "files": ["123"]}    → 401 code 10000 Authentication error
  {"purge_everything": false, "files": []}         → 401 code 10000 Authentication error
```

→ **令牌缺 `Zone / Cache Purge / Purge` 权限**。补权限后即可用，正式 body：

```json
{ "files": ["https://acct.example.com/a.png"] }          // 单 URL
{ "purge_everything": true }                        // 全站（谨慎，UI 要二次确认）
{ "hosts": ["blog.acct.example.com"] }                   // 按主机（付费特性，未验证）
{ "tags": ["…"] }                                   // 按 Cache-Tag（付费特性，未验证）
```

## 6. 明确不可用 / 已废弃（别再试）

| 接口 | 结果 | 处置 |
|---|---|---|
| `GET /zones/{z}/analytics/report` | `400 code 7003` | 2021 起废弃，路由已消失 → 用 `01` 分册的两套分析接口 |
| `GET /zones/{z}/rate_limits` | **`410`** `This API has been deprecated. Please use the Rulesets API instead.` | 限流规则要走 Rulesets API |
| `GET /zones/{z}/custom_hostnames` | `403 code 1404` 无配额 | 砍掉 |
| `GET /accounts/{a}/r2/buckets` | `403 code 10042 Please enable R2 through the Cloudflare Dashboard.` | R2 未在后台开通 |
| Email Routing / Turnstile 各种路径 | `400 code 7003` | 服务未开通，P6 整块砍掉 |
| `GET /accounts/{a}/d1/database/{uuid}/time_travel[+/info]` | `404` | Time Travel 未开启，D1 相关功能里不要承诺"按时间点恢复" |

顺带把 D1 的读侧确认了，因为你的看板迟早要用：`GET /accounts/{a}/d1/database` → 5 个库（`rin`、`rssworker-db`、`cloud-mail`、`clist-cf`、`cloudpaste-db`）；`POST …/d1/database/{uuid}/query` body `{"sql":"SELECT count(*) FROM info"}` → `200 {"results":[{"n":8}],"meta":{"served_by":"v3-prod","served_by_colo":"DFW",…}}`。

## 7. 这一块的实现要点

1. **首页"域名"页 = 两个来源合并**：`workers/domains`（Worker 直挂域名）+ `zones/{z}/workers/routes`（route 挂 Worker）+ DNS 记录（纯解析）。三者语义完全不同，不要合成一张表，用三个分区显示，否则你迟早被 `blog` 那条误导。
2. **绑定/解绑是不可逆+外呼 CA 的动作**，必须显示"会同时创建 DNS 记录并签发证书"这类后果说明。
3. DNS 写、清缓存、zone 设置写都只缺权限，代码路径可以现在就写完，等 `05` 分册的新令牌一到就能开。

## 8. Rulesets（WAF / 限流）读取路径（2026-10-09 实测，**当前令牌已经够读**）

起因：`hasanzadee/cloudflare-mobile` 源码里写着"没配过规则的阶段 GET 会 404，这是正常空态不是错误"（`lib/features/security/security_providers.dart:36`）。这条经验值得在我们自己账号上重测，因为它决定 WAF 面板到底是被**权限**挡还是被**空态**挡。复跑：`node tools/probe-rulesets-phases.mjs` → `docs/evidence/rulesets-phases.json`。

在 `acct.example.com` 上逐阶段 `GET /zones/{z}/rulesets/phases/{phase}/entrypoint` 的三种结果，**必须分开处理**：

| 阶段名 | HTTP | 错误 | 语义 |
|---|---|---|---|
| `http_request_firewall_custom` | **200** | — | 有 ruleset，`result.rules[]` 直接可读 |
| `http_ratelimit`、`http_request_firewall_managed`、`http_request_cache_settings` | `404` | `code 10003 could not find entrypoint ruleset in the … phase` | **正常空态**：这个 zone 这个相位没配过规则，不是错误、更不是没权限 |
| `entry`、`pre-scrub`、`post-scrub`、`scrub_off`、`http_request_security_rule`、`http_response_managed_settings` | `400` | `unknown phase "…"`（**这条错误没有 code**） | 阶段名对这个 zone/套餐不成立，别当成"接口坏了" |
| `GET /accounts/{a}/rulesets/phases/http_request_firewall_custom/entrypoint` | `404` `10003` | — | 账号级没建规则集（zone 级有，账号级独立） |

实测到的真实内容（不是我编的样例）：`rulesets` 列表 4 条 —— `managed:http_request_sanitize`（Normalization）、`managed:http_request_firewall_managed`（Managed Free）、`managed:ddos_l7`、`zone:http_request_firewall_custom`（名为 `default`）。后者有 **1 条启用的规则**：

```
action=block  enabled=true  ref=…  last_updated=…
description = "AI Crawl Control - Block AI bots by User Agent"
expression  = (http.request.uri.path ne "/robots.txt" and (http.user_agent contains "Claude-SearchBot"))
```

规则对象的字段就是 `action description enabled expression id last_updated ref version`（没有 `action_parameters`，说明这条规则确实只用简单 action）。

**结论与处置**：
- `09` D3 那句"WAF 面板第一版不做"原来的理由（套餐/权限挡）是**不成立的**：实测 `GET …/entrypoint` 直接 200，说明**当前这把令牌就能读规则集**（具体权限项名拿不到 —— `tokens/verify` 对 account-scoped 令牌恒 401，见 `05` §1，所以这里只按实测结果登记，不猜它叫 `Zone:Security:Read`）。不做应当只按"范围裁剪"来表述，不要写成"接口不通"。
- 加只读 WAF 卡片的成本如预期很低：一个 GET + 把 `404 10003` 渲染成"这个阶段还没有规则"、把 `400 unknown phase` 直接从阶段列表里剔除（下方那条就是照这个做的）。写侧（`POST rules` / `PUT phases/{phase}/entrypoint`）仍然一行都不要碰 —— 而且注意"两条路径"问题：**首条规则**只能用 `PUT …/phases/{phase}/entrypoint`（此时没有 ruleset id），后续才用 `POST …/rulesets/{id}/rules`。
- 上面那条候选项**已于 2026-10-10 落地成只读卡片**：网关新增 `GET /v1/zones/{z}/waf`（一次并发打三个 phase 的 entrypoint，`app/gateway/src/catalog.ts` 的 `waf()`），域名屏显示"自定义规则 1 条 / 托管规则集没配过 / 限流没配过"。三种形状在网关里分别归成 `ok / empty / unsupported / denied / error`，`cf.ts` 顺手把 `10003`、`10336` 补进了 `classify()` 的 notFound 映射（之前落到 `unknown`，界面会显示成"没归类错误"）。冒烟脚本对这条做了断言：三个阶段全都必须是这三种"正常"状态之一，出现 `error/denied` 就报错。**写侧仍然一条没碰**，网关也没注册任何 rulesets 写路由。
- 卡片只有规则、**没有命中次数**：GraphQL 的 `firewallEventsAdaptiveGroups` 被套餐挡（`09` §D3），所以别在 UI 上暗示"这条规则拦了多少"。
