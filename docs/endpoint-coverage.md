# 端点覆盖清单（实测状态）

> 由 `node tools/gen-coverage.mjs` 从 `docs/evidence/api-verification.json` 生成；`{a}` `{z}` `{s}` `{version_id}` `{ns}` `{d}` 都是占位符，真实 ID 见证据文件。
> 图例：✅ 实测 200 ｜ 🟢 用非法 payload 证明路由与鉴权可达（写操作本阶段没真发）｜ 🟡 可达但缺真实资源 ｜ ⛔ 令牌缺权限 ｜ 🚫 服务/套餐限制 ｜ 🔥 接口不工作 ｜ ❌ 该写法不成立 ｜ 🟠 用法需修正

| 功能块 | 测的是什么 | 请求 | HTTP | 状态与结论 |
|---|---|---|---|---|
| 账号与资源发现 | accounts | `GET /accounts` | 200 | ✅ 实测 200，已拿到真实数据 |
| 账号与资源发现 | user（用户级信息） | `GET /user` | 403 | ℹ️ account-scoped 令牌无用户级认证主体（正常现象） |
| 账号与资源发现 | zones | `GET /zones?per_page=20` | 200 | ✅ 实测 200，已拿到真实数据 |
| 账号与资源发现 | workers/scripts | `GET /accounts/{a}/workers/scripts` | 200 | ✅ 实测 200，已拿到真实数据 |
| 账号与资源发现 | workers/domains | `GET /accounts/{a}/workers/domains` | 200 | ✅ 实测 200，已拿到真实数据 |
| 账号与资源发现 | pages/projects | `GET /accounts/{a}/pages/projects` | 200 | ✅ 实测 200，已拿到真实数据 |
| 账号与资源发现 | kv namespaces | `GET /accounts/{a}/storage/kv/namespaces` | 200 | ✅ 实测 200，已拿到真实数据 |
| 账号与资源发现 | d1/database | `GET /accounts/{a}/d1/database` | 200 | ✅ 实测 200，已拿到真实数据 |
| 账号与资源发现 | r2/buckets | `GET /accounts/{a}/r2/buckets` | 403 | 🚫 服务未在后台启用（R2） |
| 账号与资源发现 | queues | `GET /accounts/{a}/queues` | 200 | ✅ 实测 200，已拿到真实数据 |
| 账号与资源发现 | analytics_engine/datasets | `GET /accounts/{a}/analytics_engine/datasets?limit=50&offset=0` | 500 | 🔥 接口自身不工作（500 空响应，多形状已复现） |
| 账号与资源发现 | engine_usage/sum | `GET /accounts/{a}/analytics/engine_usage/sum?since=2026-10-02T00:00:00Z&until=2026-10-09T00:00:00Z` | 500 | 🔥 接口自身不工作（500 空响应，多形状已复现） |
| 账号与资源发现 | turnstile sites | `GET /accounts/{a}/turnstile/widgets` | 400 | 🚫 路由不存在 / 服务未开通 |
| 账号与资源发现 | email_routing 配置 | `GET /accounts/{a}/email_routing/settings` | 400 | 🚫 路由不存在 / 服务未开通 |
| 流量分析 | SQL SELECT * LIMIT 1（列名） | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | SQL 完整字段清单（故意用假字段触发） | `POST /analytics/sql` | 422 | 🟠 SQL 语法/字段错误（正确写法见 01） |
| 流量分析 | SQL 7天总量 | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | SQL 按天(带 LIMIT) | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | SQL 按小时 | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | SQL 状态码 | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | SQL 源站状态码+耗时 | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | SQL 主机名 top | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | SQL 路径 top | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | SQL UA/爬虫类别 | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | SQL account 维度 | `POST /analytics/sql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | GraphQL 1dGroups(date_geq) | `POST /graphql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | GraphQL adaptive 国家分布 | `POST /graphql` | 200 | ✅ 实测 200，已拿到真实数据 |
| 流量分析 | GraphQL adaptive 主机名+协议+状态码 | `POST /graphql` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | scripts/{s}/settings | `GET /accounts/{a}/workers/scripts/{s}/settings` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | scripts/{s}/versions | `GET /accounts/{a}/workers/scripts/{s}/versions?per_page=5` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | versions?deployable=true | `GET /accounts/{a}/workers/scripts/{s}/versions?deployable=true&per_page=5` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | versions 第2页(验 result_info) | `GET /accounts/{a}/workers/scripts/{s}/versions?page=2&per_page=3` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | versions/{v} 详情 | `GET /accounts/{a}/workers/scripts/{s}/versions/{version_id}` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | versions/{v}/settings（后缀被忽略，同 {v}） | `GET /accounts/{a}/workers/scripts/{s}/versions/{version_id}/settings` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | deployments 当前生产配比 | `GET /accounts/{a}/workers/scripts/{s}/deployments` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | deployments?environment=production | `GET /accounts/{a}/workers/scripts/{s}/deployments?environment=production&per_page=50` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | scripts/{s} 整包下载(multipart) | `GET /accounts/{a}/workers/scripts/{s}` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | scripts/{s}/secrets 环境变量 | `GET /accounts/{a}/workers/scripts/{s}/secrets` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | scripts/{s}/schedules cron | `GET /accounts/{a}/workers/scripts/{s}/schedules` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | scripts/{s}/content 代码下载(预期405) | `GET /accounts/{a}/workers/scripts/{s}/content?environment=production` | 405 | ❌ 该动词不支持（不是权限问题） |
| Workers 版本与部署 | subdomain 是否开启 | `GET /accounts/{a}/workers/subdomain` | 200 | ✅ 实测 200，已拿到真实数据 |
| Workers 版本与部署 | tail 端点存在性 | `GET /accounts/{a}/workers/tails?per_page=5` | 405 | ❌ 该动词不支持（不是权限问题） |
| 域名 / Zone / DNS | workers/domains/{id} | `GET /accounts/{a}/workers/domains/{d}` | 200 | ✅ 实测 200，已拿到真实数据 |
| 域名 / Zone / DNS | zones/{id} | `GET /zones/{z}` | 200 | ✅ 实测 200，已拿到真实数据 |
| 域名 / Zone / DNS | zones/{id}/settings(56项) | `GET /zones/{z}/settings` | 200 | ✅ 实测 200，已拿到真实数据 |
| 域名 / Zone / DNS | zones/{id}/dns_records | `GET /zones/{z}/dns_records?per_page=50` | 200 | ✅ 实测 200，已拿到真实数据 |
| 域名 / Zone / DNS | dns_records/export(zone 文件) | `GET /zones/{z}/dns_records/export` | 200 | ✅ 实测 200，已拿到真实数据 |
| 域名 / Zone / DNS | ssl/universal/settings | `GET /zones/{z}/ssl/universal/settings` | 200 | ✅ 实测 200，已拿到真实数据 |
| 域名 / Zone / DNS | custom_hostnames(SaaS) | `GET /zones/{z}/custom_hostnames` | 403 | 🚫 套餐无配额（SSL for SaaS） |
| 域名 / Zone / DNS | zones/{id}/workers/routes | `GET /zones/{z}/workers/routes` | 200 | ✅ 实测 200，已拿到真实数据 |
| 域名 / Zone / DNS | old analytics/report | `GET /zones/{z}/analytics/report?since=2026-10-08T00:00:00Z` | 400 | 🚫 路由不存在 / 服务未开通 |
| 端点存在性探测 | pages deployments（假项目） | `GET /accounts/{a}/pages/projects/__nope__/deployments` | 404 | 🟡 路由+鉴权可达，但账号里没有 Pages 项目可验 |
| 端点存在性探测 | pages rollback（假项目） | `POST /accounts/{a}/pages/projects/__nope__/deployments/x/rollback` | 404 | 🟡 路由+鉴权可达，但账号里没有 Pages 项目可验 |
| 端点存在性探测 | pages domains（假项目） | `GET /accounts/{a}/pages/projects/__nope__/domains` | 404 | 🟡 路由+鉴权可达，但账号里没有 Pages 项目可验 |
| 端点存在性探测 | d1 query（真库只读） | `POST /accounts/{a}/d1/database/{uuid}/query` | 200 | ✅ 实测 200，已拿到真实数据 |
| 写权限语义探测（非法 payload） | DNS 写 POST(缺字段) | `POST /zones/{z}/dns_records` | 403 | ⛔ 令牌缺该权限（补齐清单见 05 §3） |
| 写权限语义探测（非法 payload） | 域名绑定 PUT(非法域名) | `PUT /accounts/{a}/workers/domains` | 400 | 🟢 路由+鉴权可达，已到业务校验层（写权限具备） |
| 写权限语义探测（非法 payload） | 版本切换 POST(空 versions) | `POST /accounts/{a}/workers/scripts/{s}/deployments` | 400 | 🟢 路由+鉴权可达，已到业务校验层（写权限具备） |
| 写权限语义探测（非法 payload） | 版本上传 POST(非 multipart) | `POST /accounts/{a}/workers/scripts/{s}/versions` | 415 | 🟢 路由+鉴权可达，已到业务校验层（写权限具备） |
| 写权限语义探测（非法 payload） | secrets 写 POST(空 body) | `POST /accounts/{a}/workers/scripts/{s}/secrets` | 405 | ❌ 该动词不支持（不是权限问题） |
| 写权限语义探测（非法 payload） | schedules 写 PUT(空) | `PUT /accounts/{a}/workers/scripts/{s}/schedules` | 400 | 🟢 路由+鉴权可达，已到业务校验层（写权限具备） |
| 写权限语义探测（非法 payload） | cache purge POST(files:[123]) | `POST /zones/{z}/purge_cache` | 401 | ⛔ 令牌缺该权限（补齐清单见 05 §3） |
| 写权限语义探测（非法 payload） | kv 键写 PUT(缺值) | `PUT /accounts/{a}/storage/kv/namespaces/{ns}/keys/probe` | 404 | ❌ 路径写错：写值要用 `/values/{key}`（错误信息直接给了正确路径） |

## 只在定向探测里出现过的形状（不在上面这批请求中）

| 探测 | 结果 | 结论 |
|---|---|---|
| `GET …/workers/scripts/{s}/versions/{version_id}` | 200 | 版本详情可用，`resources.bindings` 含全部绑定 |
| `GET …/versions/{version_id}/content` | 200 但返回**版本 JSON** | ⚠️ 后缀被忽略，**没有「下载指定版本源码」的接口** |
| `GET …/versions/{version_id}/totallybogus` | 200 版本 JSON | 同上，回落证据 |
| `GET …/workers/scripts/{s}/analytics` | 200 **multipart 整包代码** | 该端点不存在，回落证据 |
| `GET …/workers/scripts/{s}/tail-sessions` | 200 multipart 整包 | 同上 |
| `GET …/versions/{bogus}/content` | 404 `100146` | 版本 ID 确实被解析，只是尾巴被丢 |
| `GET /accounts/{a}/analytics/workers_usage/sum` | 500 | Workers 用量拿不到 |
| `analytics_engine/datasets` 的 `v2` / `?dataplane` / `column/definitions` | 500 ×3 | AE 数据集列表拿不到，改用 SQL 直查 |
| `POST /analytics/sql`（`events.analyticsEngine.default` + `time_range` + `scope.accountTag`） | 200 `n=0` | AE 查询语法确认，只是没有数据集 |
| `POST /analytics/sql`（AE 不带 `time_range`） | 422 `query must include a time range` | 参数口径确认 |
| `GET /accounts/{a}/workers/routes` | 400 `7003` | 路由是 zone 作用域，account 级没有这个集合 |
| `GET /accounts/{a}/workers/tails`、`/tails/any` | 405 `10405` | 只能 POST 创建，无列表；**且该路径已从官方规格移除** |
| `POST /accounts/{a}/workers/scripts/__nope__/tails`（空 body） | 404 `10007` This Worker does not exist | **证明现令牌已具备建 Tail 的权限**：权限检查在资源查找之前，报的是「Worker 不存在」而不是 `10000`。规格里该端点接受 `Workers Tail Read` 或 `Workers Scripts Write` 任一 |
| `GET /accounts/{a}/d1/database/{uuid}/time_travel[/info]` | 404 | 未启用 |
| `GET /accounts/{a}/tokens` | 200 | 能看到令牌名/状态，看不到权限明细 |
| GraphQL `workersAnalyticsAdaptiveGroups` 等 6 个候选数据集名 | `unknown field` | Workers 分析在 GraphQL 里没有对应数据集 |
| GraphQL `httpRequests1mGroups` / `firewallEventsAdaptiveGroups` | `does not have access to the path` | 套餐门控 |
| GraphQL `orderBy:["count_DESC"]` | 200 真实数据 | 排序枚举 = 字段名 + `_ASC`/`_DESC`，且必须是字符串数组 |

## 数据面补测（Analytics SQL / Analytics Engine / Workers Observability）

| 请求 | HTTP | 结论 |
|---|---|---|
| `GET /analytics/sql/introspection?account_tag={a}` | 200 | ✅ GET；返回账号可查的全部数据集清单（名称/分类/采样方式） |
| `POST /analytics/sql` | 200 | ✅ 与 /accounts/{a}/analytics/sql 等价 |
| `POST /accounts/{a}/analytics/sql` | 200 | ✅ 规格里收录的正式路径 |
| `POST /analytics/sql` | 200 | ✅ time_range 替代手写 WHERE |
| `POST /analytics/sql` | 422 | 🟠 httpRequests 面禁用 information_schema |
| `POST /accounts/{a}/analytics_engine/sql` | 200 | ✅ body 是裸 SQL，不是 JSON |
| `POST /accounts/{a}/analytics_engine/sql` | 422 | 🟠 负例：证明这里是 AE 方言，只能选自己的数据集 |
| `GET /accounts/{a}/analytics_engine/sql?query=SHOW%20TABLES` | 200 | ✅ GET 形态同样可用 |
| `POST /accounts/{a}/workers/observability/telemetry/keys` | 200 | ✅ 200 即说明这个产品在本账号可用 |
| `POST /accounts/{a}/workers/observability/telemetry/query` | 400 | 🟠 负例：证明它跑的是已保存查询而不是裸 SQL |
| `POST /accounts/{a}/workers/observability/telemetry/values` | 400 | 🟠 {"success":false,"_e":null,"_i":{"timeframe":{"start":"2026-10-08T00:0 |
| `GET /accounts/{a}/email/routing/settings` | 400 | 🟠 规格里只有 /email/routing/...（斜杠），我们上一轮打的 /email_routing/settings 是老写法 |
| `GET /accounts/{a}/storage/kv/namespaces/{ns}/values/__probe__` | 404 | 🟠 GET；规格里 keys 只能列，写值走 /values/{key_name} |
| `GET /accounts/{a}/workers/tails` | 405 | 🟠 规格里已无此路径，改用 /workers/scripts/{s}/tails |

## 同类 App 交叉核对补测（`tools/probe-shapes6.mjs`）

写动词一律打不存在的 worker/id，只判断路由与动词可达，不产生变更（口径见 `09` §F）。`deploy` / `PATCH domains` 的 405 结论见 `08` §6.2。

| 测的是什么 | 请求 | HTTP | 结论 |
|---|---|---|---|
| script-settings GET | `GET /accounts/{a}/workers/scripts/{s}/script-settings` | 200 | ✅ 实测 200 |
| deployments/{id} GET(假 id) | `GET /accounts/{a}/workers/scripts/{s}/deployments/{deployment_id}` | 404 | 🟠 code 10336 This deployment does not exist on your Worker. |
| deployments/{id} GET(真实 id) | `GET /accounts/{a}/workers/scripts/{s}/deployments/{deployment_id}` | 200 | ✅ 实测 200 |
| worker subdomain GET | `GET /accounts/{a}/workers/subdomain` | 200 | ✅ 实测 200 |
| script subdomain GET | `GET /accounts/{a}/workers/scripts/{s}/subdomain` | 200 | ✅ 实测 200 |
| versions/{v} GET（已在 B2 测过，复跑对照） | `GET /accounts/{a}/workers/scripts/{s}/versions/{version_id}` | 200 | ✅ 实测 200 |
| domains PATCH(假 id) | `PATCH /accounts/{a}/workers/domains/{d}` | 405 | 🟠 code 10405 Method not allowed for this authentication scheme |
| workers/workers/{id}/versions DELETE(假) | `DELETE /accounts/{a}/workers/workers/__probe-nonexistent-worker__/versions/{version_id}` | 404 | 🟠 code 10007 This Worker does not exist on your account. |
| versions/{v}/deploy POST(假 worker) | `POST /accounts/{a}/workers/scripts/__probe-nonexistent-worker__/versions/{version_id}/deploy` | 405 | 🟠 code 1001 method_not_allowed |
| secrets-bulk PATCH(假 worker) | `PATCH /accounts/{a}/workers/scripts/__probe-nonexistent-worker__/secrets-bulk` | 404 | 🟠 code 10007 This Worker does not exist on your account. |
| pages deployments/{id} | `GET /accounts/{a}/pages/projects/__none__/deployments/{deployment_id}` | 404 | 🟠 code 8000007 Project not found. The specified project name does not match |
| pages deployments/{id}/history/logs | `GET /accounts/{a}/pages/projects/__none__/deployments/{deployment_id}/history/logs` | 404 | 🟠 code 8000007 Project not found. The specified project name does not match |
| pages upload-token | `GET /accounts/{a}/pages/projects/__none__/upload-token` | 404 | 🟠 code 8000007 Project not found. The specified project name does not match |

## Rulesets 阶段入口（`tools/probe-rulesets-phases.mjs`）

`404 code 10003` = 该阶段没配过规则（**正常空态**）；`400 unknown phase` = 阶段名对本套餐不成立（该错误对象没有 code）。结论与用法见 `04` §8。

| 测的是什么 | 请求 | HTTP | 结论 |
|---|---|---|---|
| entrypoint entry | `GET /zones/{z}/rulesets/phases/entry/entrypoint` | 400 | 🟠 unknown phase "entry" |
| entrypoint pre-scrub | `GET /zones/{z}/rulesets/phases/pre-scrub/entrypoint` | 400 | 🟠 unknown phase "pre-scrub" |
| entrypoint http_request_security_rule | `GET /zones/{z}/rulesets/phases/http_request_security_rule/entrypoint` | 400 | 🟠 unknown phase "http_request_security_rule" |
| entrypoint http_ratelimit | `GET /zones/{z}/rulesets/phases/http_ratelimit/entrypoint` | 404 | 🟠 code 10003 could not find entrypoint ruleset in the http_ratelimit phas |
| entrypoint scrub_off | `GET /zones/{z}/rulesets/phases/scrub_off/entrypoint` | 400 | 🟠 unknown phase "scrub_off" |
| entrypoint post-scrub | `GET /zones/{z}/rulesets/phases/post-scrub/entrypoint` | 400 | 🟠 unknown phase "post-scrub" |
| entrypoint http_request_firewall_managed | `GET /zones/{z}/rulesets/phases/http_request_firewall_managed/entrypoint` | 404 | 🟠 code 10003 could not find entrypoint ruleset in the http_request_firewa |
| entrypoint http_request_firewall_custom | `GET /zones/{z}/rulesets/phases/http_request_firewall_custom/entrypoint` | 200 | ✅ 实测 200 |
| entrypoint http_request_cache_settings | `GET /zones/{z}/rulesets/phases/http_request_cache_settings/entrypoint` | 404 | 🟠 code 10003 could not find entrypoint ruleset in the http_request_cache_ |
| entrypoint http_response_managed_settings | `GET /zones/{z}/rulesets/phases/http_response_managed_settings/entrypoint` | 400 | 🟠 unknown phase "http_response_managed_settings" |
| rulesets 列表 | `GET /zones/{z}/rulesets` | 200 | ✅ 实测 200 |
| account entrypoint http_request_firewall_custom | `GET /accounts/{a}/rulesets/phases/http_request_firewall_custom/entrypoint` | 404 | 🟠 code 10003 could not find entrypoint ruleset in the http_request_firewa |

## 本阶段刻意没发请求的写操作（需授权后逐项补测）

| 动作 | 请求 | 前置条件 |
|---|---|---|
| 上传新 Worker 版本 | `POST /accounts/{a}/workers/scripts/{s}/versions`（multipart） | 拿测试 Worker，不要用生产那个 |
| 版本切换 / 灰度 | `POST /accounts/{a}/workers/scripts/{s}/deployments` | 可先原样重部署当前 148 版 |
| 绑定自定义域名 | `PUT /accounts/{a}/workers/domains` | 会建 DNS + 签 Advanced Certificate，建议用一次性子域 |
| 解绑自定义域名 | `DELETE /accounts/{a}/workers/domains/{id}` | 同上，注意 CA 速率限制 |
| DNS 记录增删改 | `POST/PATCH/DELETE /zones/{z}/dns_records[/{id}]` | **先补 `Zone:DNS:Edit`** |
| 清缓存 | `POST /zones/{z}/purge_cache` | **先补 `Zone:Cache Purge:Purge`** |
| 站点设置改动 | `PATCH /zones/{z}/settings/{id}` | 权限未测；56 项中 44 项 `editable:true` |
| 写 secret | `PUT /accounts/{a}/workers/scripts/{s}/secrets/{name}` | 值从仓库外文件读，不进日志 |
| 改 cron | `PUT /accounts/{a}/workers/scripts/{s}/schedules` | 整体替换语义，先读后写 |
| 创建 Tail + 连 wss | `POST /accounts/{a}/workers/scripts/{s}/tails`（规格里另有 `/workers/observability/telemetry/live-tail`） | 真机验证 wss 可达性（风险 C3）；老的 `/accounts/{a}/workers/tails` 已从规格移除 |
| Pages 建项目 / 回滚 | `POST /accounts/{a}/pages/projects`、`POST …/deployments/{id}/rollback` | 先要有项目（风险 A1） |
| D1 写 SQL / KV 写 | `POST …/d1/database/{uuid}/execute`、`PUT /storage/kv/namespaces/{id}/values/{key}` | 只在测试库/测试 namespace 上验 |
