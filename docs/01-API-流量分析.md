# 01 · API 目录：域名流量分析

这一分册回答一个问题：**手机上要显示"域名流量"，到底该调哪个接口、能拿到哪些维度、哪些数字是准的。**

结论：Cloudflare 现在有**两套主分析接口**，能力不重叠，必须都用；另外还挂着**两个专用面**（Analytics Engine 的裸 SQL 端点、Workers Observability 的 telemetry 族），形状和前两个都不一样，见 §2.7：

| | Analytics SQL API（新） | GraphQL（`/client/v4/graphql`，传统） |
|---|---|---|
| 路径 | `POST /client/v4/analytics/sql` | `POST /client/v4/graphql` |
| 擅长 | 明细下钻：路径、UA、状态码、按小时、ray 级排查 | 聚合口径与控制台一致：请求总量、带宽、**国家分布**、设备类型 |
| 没有的维度 | **国家、ASN、缓存命中、referer、query 全都没有列** | 明细粒度粗（采样聚合），不能按 ray 查 |
| 实测 | 7 天 16 237 请求 / 478 412 371 字节 全绿 | 国家分布 US 7168 / DE 2217 全绿 |
| 建议用法 | 详情下钻 + Top N | 首页大数字 + 饼图 |

## 2. Analytics SQL API（实测形状）

```
POST https://api.cloudflare.com/client/v4/analytics/sql
content-type: application/json
authorization: Bearer <token>

{ "query": "SELECT …",
  "params": { "s": "2026-10-08T00:00:00Z" },     // 占位符写 $s
  "scope":  { "zoneTag": "20017d32…89e" },       // 或 accountTag，值必须是字符串
  "time_range": { "start": "…", "end": "…" } }   // AE 数据集必须给，否则 422
```

响应**不是**标准 CF 信封，是：

```json
{ "data": [ { "n": 1602 } ], "rows": 1,
  "statistics": { "elapsed_ms": 41, "rows_read": 22679136, "bytes_read": 162342504 } }
```

`statistics.bytes_read` 要显示出来 —— 它是你唯一的"这次查询贵不贵"信号，免费套餐下尤其重要。

### 2.1 SQL 面到底有哪些表：官方 introspection 接口（比"报错逼字段"正规的手段）

```
GET /client/v4/analytics/sql/introspection?account_tag={a}     → 200，90 个数据集
```

不带 `account_tag`（或用 `zone_tag`）会 `400 Provide the account_tag query parameter`；也可以用等价路径 `/accounts/{a}/analytics/sql/introspection`。返回 `{datasets:[{name,title,category,description,kind,hidden}]}`，原始响应已存在 `docs/evidence/sql-introspection.json`。90 个数据集按分类的分布：**Network 19、Compute 17、Storage 15、Media 8、Security 6、AI 5、Performance 5、Zero Trust 4、Logs and Traces 4、Other 4、Email 2、HTTP Traffic 1**。

对"域名流量"这块，这张目录给出了硬边界：

| 想查的东西 | SQL 面 | 结论 |
|---|---|---|
| 站点 HTTP 流量 | `events.httpRequests`（HTTP Traffic 分类里**唯一一个**） | ✅ 可查，`kind.sampling = adaptive` |
| 自己 Worker 写的 AE 数据 | `events.analyticsEngine.{dataset}` | ✅ 语法可查；本账号 0 个数据集（`SHOW TABLES` 返回空数组），所以 `analytics_engine/datasets` REST 才一直 500 —— **列数据集要用下面 §2.6 的裸 SQL 面** |
| DNS 查询数据 | 目录里**没有** `events.dnsQueries` | ❌ 实跑 422 `table not found`；走 `zones/{z}/dns_analytics/report` |
| 防火墙/WAF 事件 | 目录里**没有** `events.firewallEvents` | ❌ 同上；走 GraphQL `firewallEventsAdaptiveGroups`（本套餐被门控） |
| Workers 执行用量 | 目录里**没有** `events.workersRequests`／`workerVersions`／`auditEvents` | ❌ 老 REST 路（`engine_usage`）规格里整族消失；唯一有希望的是新的 Workers Observability 面，见 §2.6 |
| 容器/Workers 日志 | `logs.workersLogs`、`logs.containerLogs` 在目录里（Logs and Traces 类） | 新日志面走 SQL 可查，和老的 Tail 是两条路 |
| `SHOW TABLES` / `information_schema` | ❌ `SHOW TABLES is not supported unless information_schema is enabled`（422） | 所以表清单**只能**靠上面的 introspection 接口 |

### 2.2 `events.httpRequests` 的完整列（服务端错误信息原样吐出，共 27 列）

```
accountTag  botScore  clientAsn  clientRefererHost  clientRequestHttpHost  clientRequestPath
clientRequestQuery  edgeResponseBytes  edgeResponseStatus  edgeTimeToFirstByteMs  ja4  originAsn
originResponseDurationMs  originResponseStatus  rayId  sampleInterval  timestamp  userAgent
verifiedBotCategory  wafAttackScore  wafRceAttackScore  wafSqliAttackScore  wafXssAttackScore
webAssetsOperationId  xRequestedWith  zoneTag
```

`SELECT *` 实测返回的 13 列（其余在该行上是 null）：`accountTag, clientRequestHttpHost, clientRequestPath, edgeResponseBytes, edgeResponseStatus, originResponseDurationMs, originResponseStatus, rayId, sampleInterval, timestamp, userAgent, verifiedBotCategory, zoneTag`。

**注意没有 `countryName` / 没有任何缓存命中列。** 我在实现国家分布前先按 `ClientCountryName`、`responseType` 试过一次，都是 `422 Schema error` —— 这条路由不通，别浪费时间，走 GraphQL。

`botScore` 更特殊：`403 not permitted to access column on events.httpRequests: botScore` —— 列存在但不给读，属套餐门控。

### 2.3 字段名写错会把合法清单吐回来（免费的 introspection）

```sql
SELECT __bogus__ FROM events.httpRequests LIMIT 1
→ 422 Input was invalid: Schema error: No field named __bogus__. Valid fields are events."httpRequests"."accountTag", …
```

GraphQL 的 `__type` 内省返回 null（被禁），所以**这套"故意写错"的探测仍是查列名的唯一手段**（表清单已有 §2.1 的官方接口，列清单没有）。`tools/probe-graphql-fields.mjs` 就是这么扫出可用字段清单的。

### 2.4 请求体里可以直接给 `time_range`（本轮实测新结论）

```json
{ "query": "SELECT toStartOfDay(timestamp) d, count() n FROM events.httpRequests GROUP BY d ORDER BY d LIMIT 8",
  "time_range": { "start": "2026-10-02T00:00:00Z", "end": "2026-10-09T00:00:00Z" },
  "scope": { "accountTag": "{a}" } }   → 200，按天真实计数
```

也就是说**时间窗不需要写进 `WHERE`**，`time_range` 对 `events.httpRequests` 同样生效（早先只在 AE 上验证过它必填）。App 里做 24h/7d/30d 切换时只改这个对象，SQL 模板可以固定，少一类拼错风险。`/analytics/sql` 与 `/accounts/{a}/analytics/sql` 两条路径实测等价（同一查询都是 5034 计数）。

### 2.5 实测可用的查询（每条都跑过，返回真实数据）

| 用途 | SQL |
|---|---|
| 总量 | `SELECT count() AS reqs, sum(edgeResponseBytes) AS bytes FROM events.httpRequests` + scope/time_range |
| 按天 | `SELECT toDate(timestamp) AS d, count() AS reqs … GROUP BY d ORDER BY d LIMIT 31` |
| 按小时 | `SELECT toStartOfHour(timestamp) AS h, count() AS reqs … GROUP BY h ORDER BY h DESC LIMIT 24` |
| 状态码 | `SELECT edgeResponseStatus, count() AS reqs … GROUP BY edgeResponseStatus ORDER BY reqs DESC LIMIT 12` |
| 源站健康 | `SELECT originResponseStatus, round(avg(originResponseDurationMs)) AS avg_ms, count() AS reqs … GROUP BY originResponseStatus` |
| 主机名 Top | `SELECT clientRequestHttpHost, count() AS reqs … GROUP BY … LIMIT 12` |
| 路径 Top | `SELECT clientRequestPath, count() AS reqs … GROUP BY … LIMIT 12` |
| 爬虫构成 | `SELECT verifiedBotCategory, count() AS reqs … GROUP BY …` |
| 按 ray 排查 | `WHERE rayId = $r`（列在，值形如 `8f…-PDX`） |

真实数字（`acct.example.com`，2026-10-02 → 10-09）：

```
总量   16 237 请求 / 478 412 371 字节
按天   10-02 1656 · 10-03 2025 · 10-04 1899 · 10-05 1591 · …
状态码 200 → 10 800 · 522 → 2 244 · 301 → 703 · 403/499 若干
主机名 blog.acct.example.com 5 781 · rss.acct.example.com 3 213 · dsh 825 · acct 793 · jtb 303 · 1.acct …
路径   / 5 868 · /rss/telegram/channel/Galaxy_leak 1 071 · …
爬虫   空类别 15 484 · AI Crawler 424 · AI Search 319
```

顺带说一句：**522 有 2244 次**，说明你的源站（Rin 跑在 Worker 后面）经常连不上。这不归本调研管，但看板上线后你会第一天就看到它。

### 2.6 SQL 的四个语法硬规矩（都撞过）

1. `ORDER BY` 必须配 `LIMIT`，否则 `422 ORDER BY requires a LIMIT clause (add \`LIMIT 100\` to the query)`。
2. `DISTINCT` 聚合直接禁：`count(DISTINCT rayId)` → `unsupported expression: DISTINCT aggregates are not supported on adaptive datasets`。
3. 没有 `toFloat64`（ClickHouse 写法），函数是 DataFusion/Presto 系：`toDate` / `toStartOfHour` / `round` / `avg` 可用。
4. 必须有时间下界；`now() - 7` 会报类型错，用 `time_range` 或 `timestamp >= $s`。

### 2.7 Analytics Engine 与 Workers Observability：两套完全不同的调用形态（本轮新测）

这是最容易写错的地方，因为**名字都像"SQL 查询"，信封却不一样**：

| | `/analytics/sql`（分析 SQL） | `/accounts/{a}/analytics_engine/sql`（AE SQL） |
|---|---|---|
| Content-Type | `application/json` | **`text/plain`（裸 SQL）**，或 GET `?query=` |
| 请求体 | `{query, params, scope, time_range}` | 就是 SQL 语句本身；JSON 会被解析器当成语句 → `422 Expected an SQL statement, found: {` |
| 能查的表 | `events.httpRequests` 等平台数据集 | **只有你自己的 AE 数据集**，而且**不能带 `events.` 库名前缀**（`422 cannot specify a database when selecting a dataset`） |
| 列数据集 | 用 §2.1 的 introspection | 用 `SHOW TABLES` → 200 `{meta:[{name:"dataset"}], data:[…], rows:0}`；本账号返回空数组 |
| 权限（规格里标的） | `Account Analytics Read` | `Account Analytics Read` |

证据：`docs/evidence/sql-surfaces.json`（14 条，`node tools/probe-sql-surfaces.mjs` 生成）。

**Workers Observability（OTel 面，规格里新增的一族）**：

- `POST /accounts/{a}/workers/observability/telemetry/keys` → **200，返回真实属性目录**（`$metadata.message`、`$metadata.messageTemplate`…），说明这个产品在你账号上是活的，不需要单独开通。
- `POST …/telemetry/query` → 400，报的错是 `expected string, code invalid_type, path ["queryId"]`：**它跑的是后台"已保存查询"的 `queryId`，不吞裸 SQL**。规格里这条要 `Workers Observability Write` 权限。
- `POST …/telemetry/values` → 400（body 形状还没试出来，只给了 `timeframe` 不够）。
- 同族还有 `…/live-tail` 与 `…/live-tail/heartbeat`（POST），是新版实时日志入口，和老的 `/workers/scripts/{s}/tails` 并存。

结论对 App 的影响：想显示"某个 Worker 自己的运行指标"，路径是**后台建一个已保存查询 → App 里按 `queryId` 调 `telemetry/query`**，并且要给令牌补 `Workers Observability Write`；这比原来打算的"用 hostname 归属反推"更准，但多一道后台配置。两条都留着：默认用 hostname 归属（零配置），进阶用 telemetry query（准但要配置 + 权限）。

## 3. 采样：数字对不上就是这个原因（实测数据在此）

同一天（2026-10-08）用四种口径统计同一个 zone：

| 口径 | 数字 |
|---|---|
| GraphQL `httpRequests1dGroups` 的 `sum.requests`（= 控制台显示值） | **1 567** |
| SQL `count()` | 1 602 |
| SQL `sum(1.0 / sampleInterval)` | 1 460 |
| SQL `sum(sampleInterval)` | 2 840 ❌ 明显高估 |

`sampleInterval` 的实际分布：`1` 有 1420 行，`2` 有 48 行，`8` 有 72 行，`10` 有 30 行，`20` 有 20 行。

**所以：**
- 首页"总请求/总带宽/国家分布"这类**要给用户看的口径，一律用 GraphQL `httpRequests1dGroups`**，与控制台一致。
- SQL 的 `count()` 在低流量日与控制台差 ~2%，但在高流量日会明显偏低（采样率上去后行数远小于请求数）。**看板上的大数字不要用 SQL 算**。
- 不要向用户解释采样细节，但要在 UI 上标一句"下钻明细基于采样数据"，避免他拿 SQL 的数字去对控制台的数字然后以为 App 有 bug。（实现里已经这么做了：看板下面固定一行说明两套口径的差额与原因。）

### 3.1 比采样更坑的是"窗口边界"（2026-10-09 实测）

`1dGroups` 按**自然日**聚合，只能取到"已经走完的日期"；adaptive 和 SQL 用的是**滚动时间窗**（`datetime_geq/datetime_lt`），包含今天已经过去的钟点。选"24 小时"时两边几乎不重叠，实测同一个时刻：

| 数 | 窗口 | 值 |
|---|---|---|
| `1dGroups` 的 `requests` / `bytes` | 只有 `2026-10-08` 一个完整日期 | 2 144 请求 / 8.27 MB |
| SQL 按小时 `series` | 24 个桶，`10-08 14:00 → 10-09 13:00` | 4 063 请求 |
| adaptive `sum` | 同一条滚动 24 小时 | `visits` 1 295 / `edgeResponseBytes` **710 MB** |

也就是说流量数字能差到 80 倍，而且**不是**采样造成的：今天有大文件传输，昨天没有。选 7d/30d 时这个偏差会被"至少 7 个完整日"稀释掉，看起来只差几个百分点，所以只在 24 小时窗暴露出来。

结论：UI 里凡并排显示两个口径，就必须同时说明**窗口**（自然日 vs 滚动窗）而不只是"采样"；`1dGroups` 那张卡的标签不能写成"最近 24 小时"，得写成"已完成自然日"。

## 4. GraphQL（实测可用字段全清单）

请求：`POST /client/v4/graphql`，body `{query}`。信封：`{"data":…,"errors":null}`，**HTTP 永远是 200，出错看 `errors` 数组**。

### 4.1 `httpRequests1dGroups` — 按天汇总，与控制台同口径

```graphql
{ viewer { zones(filter: {zoneTag: "<id>"}) { rows: httpRequests1dGroups(
      limit: 30, filter: {date_geq: "2026-10-05", date_lt: "2026-10-10"}) {
    dimensions { date }
    sum { requests bytes pageViews threats encryptedRequests }
} } } }
```

| 项 | 实测结果 |
|---|---|
| filter 参数 | ✅ `date_geq` / `date_lt`（值形如 `"2026-10-05"`）。**`datetime_geq` 会报 `unknown arg datetime_geq`** —— 这是最容易踩的一个坑 |
| dimensions | ✅ `date`；`day` / `datetime` 不存在 |
| sum 可用 | ✅ `requests`(10 427) `bytes`(651 519 273) `pageViews`(5 786) `threats`(321) `encryptedRequests`(8 659) |
| sum 不存在 | ❌ `visits` `uniques` `cached` `originErrors` `savedBytes` `indexedBytes` `totalBytes` `bandwidth` `edgeResponseBytes` |

### 4.2 `httpRequestsAdaptiveGroups` — 多维下钻（国家分布只有这里有）

```graphql
{ viewer { zones(filter: {zoneTag: "<id>"}) { rows: httpRequestsAdaptiveGroups(
      limit: 8,
      filter: {datetime_geq: "2026-10-02T00:00:00Z", datetime_lt: "2026-10-09T23:59:59Z"},
      orderBy: ["count_DESC"]) {
    count
    sum { visits edgeResponseBytes }
    dimensions { clientCountryName }
} } } }
```

| 项 | 实测 |
|---|---|
| `sum` 只有两个字段 | ✅ `visits`（2 492） `edgeResponseBytes`（618 509 176）。没有 `requests` / `byte` / `cached` / `originErrors` / `savedBytes` / `indexedBytes` / `threats` / `uniques` / `pageViews` |
| 聚合还有 `count` | ✅ 直接写 `count`（不是 `sum{count}`，也没有 `max`/`min`/`avg`） |
| `dimensions` 可用（9 个） | ✅ `clientCountryName` `clientRequestHTTPHost` `clientRequestHTTPProtocol` `clientRequestHTTPMethodName` `edgeResponseStatus` `clientIP` `cacheStatus` `clientDeviceType` `originResponseStatus` |
| `dimensions` 被套餐/权限挡（4 个） | ⚠️ `clientASNDescription` `clientRequestQuery` `clientRequestReferer` `clientRequestScheme` → `zone … does not have access to the field 'xxx' from the path`（**这是权限/套餐问题，不是字段名写错**） |
| `dimensions` 不存在（17 个候选） | ❌ `countryName` `cdnCacheStatus` `edgeCacheStatus` `clientRequestURIPath` `contentType` `workerVersion` `jobName` `workloadRunStatus` `visitorUUID` 等 |
| `orderBy` | ✅ **必须是字符串数组**，形如 `["count_DESC"]`、`["clientCountryName_DESC"]`。写 `"-count"` → `not a list`；写对象 → `not a string`；写 `[["_count_DESC"]]` → `unknown enum value`。枚举名 = 选择集里的字段名 + `_ASC`/`_DESC` |
| 采样窗口 | adaptive 数据集是采样的，窗口越长越粗；建议只做 ≤30 天 |

真实国家分布（7 天）：`US 7 168 · DE 2 217 · …`；协议分布 `HTTP/1.1 12 960`。

### 4.3 其他数据集在你这个账号上的实测结果

| 数据集 | 结果 | 含义 |
|---|---|---|
| `httpRequests1mGroups` | ⚠️ `zone … does not have access to the path` | 分钟级明细要更高权限；想做"实时曲线"就得考虑别的路子 |
| `firewallEventsAdaptiveGroups` | ⚠️ 同上 | WAF 事件面板暂不可行 |
| `cachesAdaptiveGroups` | ❌ `unknown field`（数据集名不存在） | 缓存分析只能退到 `dimensions{cacheStatus}` |
| `visitorTimeseriesByRequests1dGroups` | ❌ `unknown field` | |
| `workersAnalyticsAdaptiveGroups` / `workerAnalyticsAdaptiveGroups` / `workerVersionsAdaptiveGroups` / `engineUsageAdaptiveGroups` / `workersRequestsAdaptiveGroups` | ❌ 全部 `unknown field` | **Workers 自身的调用量/CPU 在 GraphQL 里根本没有对应数据集** |

### 4.4 账号级 `viewer.accounts`（网关看板用的这一套）

前面 4.1/4.2 全部写在 `viewer.zones(filter:{zoneTag})` 下，但手机上看板要的是"整个账号"，所以把外层换成 `viewer.accounts(filter:{accountTag:"<id>"})`，其余参数形状完全一致（`date_geq/date_lt` vs `datetime_geq/datetime_lt`、`orderBy` 同样是字符串数组）。2026-10-09 用 `tools/probe-gql-account-fields.mjs` 扫过一遍，结论是**字段集合跟 zone 级不一样，别照抄**（证据：`docs/evidence/graphql-account-fields.json`）：

| 数据集 | 账号级可用 | 不存在（写上去就 `unknown field`） | 被套餐/权限挡 |
|---|---|---|---|
| `httpRequests1dGroups.sum` | ✅ `requests`(8 867) `bytes`(131 352 359) `encryptedRequests`(5 683) `threats`(223) | ❌ `visits` **`bandwidth`** `cachedDatabytes` `uncachedDatabytes` `pageSessions` `indexedBytes` `savedBytes` `originErrorRequests` `botRequests` | — |
| `httpRequests1dGroups.dimensions` | ✅ `date`（`"2026-10-06"`） | ❌ `day` `datetimeDay` `countryName` | — |
| `httpRequestsAdaptiveGroups.sum` | ✅ `visits`(4 284) `edgeResponseBytes`(769 269 413) | ❌ `count` `requests` `originalResponseBytes` `cachedRequestCount` `uncachedRequestCount` `encryptedRequestCount` `savedBytes` `indexedBytes` | — |
| `httpRequestsAdaptiveGroups.dimensions` | ✅ `clientCountryName` `clientRequestHTTPHost` `cacheStatus` `clientDeviceType` `edgeResponseStatus` `originResponseStatus` | — | ⚠️ `clientASNDescription` `clientRequestReferer` → `does not have access to the field from the path` |

三条直接影响实现的结论：

1. **带宽字段名是 `bytes`，不是 `bandwidth`。** 控制台中文界面写着"带宽"，接口里没有这个字段；`1dGroups` 出 `bytes`，adaptive 出 `edgeResponseBytes`，两者口径不同（7 天实测 343 MB vs 1 022 MB），UI 上分开标注，不混显。
2. **`visits`（访问数）只有 adaptive 有**，所以这张卡天生是采样口径，跟同页 `1dGroups` 的"请求数"对不上属正常。
3. **缓存命中率、设备类型在账号级只有 GraphQL adaptive 能给**（`dimensions{cacheStatus}` / `clientDeviceType`，配 `orderBy:["count_DESC"]`）。SQL 侧 `events.httpRequests` 没有等价列，网关里对应 `/v1/traffic/adaptive?dim=cache|device`，返回统一成 `{rows:[{k,reqs}], source:"graphql-adaptive", sampled:true}`，前端把 `sampled` 标出来。

## 5. Workers 用量：REST 接口全部拿不到（实测）

| 尝试 | 结果 |
|---|---|
| `GET /accounts/{a}/analytics/engine_usage/sum` | **500 空响应**（带不带 `vizTimeseries`、换参数都一样） |
| `GET /accounts/{a}/analytics/workers_usage/sum` | 500 |
| `GET /accounts/{a}/analytics_engine/datasets` | 500（`limit/offset/dataplane/v2/column-definitions` 各种形状都试过） |
| `GET /accounts/{a}/workers/analysis/overview` | 400 `7003` 路由不存在 |
| `GET /accounts/{a}/workers/budget` | 400 `7003` |
| GraphQL 各种 Workers 数据集名 | `unknown field` |

→ **App 里的"Workers 用量"卡片怎么做？** 用这个实测可行的替代方案：

**按主机名把 zone 流量归属到 Worker。** `GET /accounts/{a}/workers/domains` 返回 6 条 `hostname → service` 映射（`acct.example.com→rin-server`、`rss.acct.example.com→rssworker`、`news.acct.example.com→hot-news`、`mail.acct.example.com→mail`、`jtb.acct.example.com→web-clipboard`、`1.acct.example.com→1`），再用 SQL `WHERE clientRequestHttpHost = $h` 或 GraphQL `dimensions{clientRequestHTTPHost}` 出数。你的 Worker 全都挂在自定义域名上，所以这个归属关系是准确的。

**但只看 `workers/domains` 会漏。** 实测 `blog.acct.example.com` 不在自定义域名表里，它是 **Zone 路由**（`GET /zones/{z}/workers/routes` 里 `pattern="*blog.acct.example.com/*"` → `script="rin-server"`），而它是你流量最大的主机名（近 7 天 5 450 请求）。所以控制台里的归属卡片两个面都取：自定义域名按 `service` 对，Zone 路由按 `script` 对，pattern 主机名要剥掉前导 `*` 或 `*.`（**注意是 `*blog.` 而不是 `*.` 这种带点的形式**，只剥 `*.` 会留下一个带星号的假主机名，我自己踩过）。剥完两边合起来才是这个 Worker 的量：`rin-server = blog.acct.example.com 5 450（路由）+ acct.example.com 2 478（自定义域名）= 7 928`。

两个已知偏差，界面上都写出来了：路径级路由（`example.com/api/*`）会按整个主机名归属，数字偏大；`top?dim=host` 只取 Top 20，榜外主机名单独列成"绑了但没上榜"，不显示成 0。

上面那张"全部拿不到"的表现在还有一层解释：官方 OpenAPI 规格里**`engine_usage` 这一族根本不存在**，`analytics_engine` 只剩 `/sql` 一条（见 `10-API-全量清单.md` 第 2 节）。所以不是我们请求写错了，是这些 REST 路径已经被下架 —— 列 AE 数据集要改用 `POST /accounts/{a}/analytics_engine/sql` + 裸 `SHOW TABLES`（实测 200）。

真要 Worker 内部的执行次数/CPU/内存，三条路，按成本排序：

1. **Workers Observability 的 `telemetry/keys`（实测 200）**：产品活着、属性目录能读，但 `telemetry/query` 只跑后台"已保存查询"的 `queryId`，且规格要求 `Workers Observability Write` 权限 —— 准，但要配置 + 补权限。详见 §2.7。
2. 让 Worker 自己往 Analytics Engine 写数据集，然后 `SELECT … FROM events.analyticsEngine.<数据集名>`（`/analytics/sql` 侧语法已实测可解析，本账号 0 个数据集所以 `SHOW TABLES` 为空；AE 查询**必须**带 `time_range`，否则 422 `query must include a time range`）。
3. hostname 归属反推（零配置，默认用这条）。

## 6. 已废弃 / 不要再用

- `GET /zones/{id}/analytics/report` → `400 code 7003 Could not route to …`。这个 2021 年就废弃的接口现在连路由都没有了，网上大量老教程还在写它。
- `GET /zones/{id}/rate_limits` → **`410 This API has been deprecated. Please use the Rulesets API instead.`**

## 7. 落到实现上的建议

1. 首页看板 = 1 次 GraphQL `1dGroups`（30 天） + 1 次 GraphQL adaptive（国家 Top 8） + 1 次 SQL（状态码 Top）。三次请求，不要更多（限流 1200/5min，而且手机端流量贵）。
2. 下钻页才发 SQL，并且把 `statistics.bytes_read` 显示出来，超过 ~50 MB 时提示用户缩短时间窗（上面那条 `per-hostname 24h` 查询就读了 499 MB，是个反面例子）。
3. 时间窗必须做白名单：`24h / 7d / 30d`，不要给自由选起止 —— adaptive 数据集窗口一长就退化成粗采样，用户会觉得"数字在乱跳"。时间范围统一走请求体的 `time_range:{start,end}`（§2.4 实测可用），SQL 模板固定不动。
4. 多 zone 并发要串行化。你现在只有 1 个 zone，但接口形状是按 `zoneTag` 循环设计的，加第二个 zone 时别并发 5 个 GraphQL。
