# 10 · 底层 API 全量清单（官方 OpenAPI 展开）

前 9 份文档回答的是「我这四块功能要用的接口能不能跑」。这份回答另一个问题：**Cloudflare 公开的 API 到底有多大，我们这套东西建在多大的面上** —— 依据是官方机器可读规格，不是网页文档目录。

## 1. 数据源与统计

| 项 | 值 |
|---|---|
| 来源 | `cloudflare/api-schemas` 仓库的 `openapi.json`（OpenAPI 3.0.3，BSD-3-Clause，**不是**我们手写清单） |
| 规格 blob sha | `ce5e099f5c19ce18b6e3e5b25a9cf58064d0e942`（缓存于仓库外 `«LOCAL_PATH»`，约 26 MB，不入库） |
| 路径数 | 2303 |
| operation 数（path×method） | 3670 |
| 产品族（tag）数 | undefined |
| 官方标 `deprecated` 的 operation | 335 |
| 规格里能查到「所需令牌权限」的 | 2961 条带 `x-api-token-group`，709 条没标 |

> 每条 operation 都带 `x-api-token-group`（例如 `Workers Scripts Write`、`DNS Write`），这就是**令牌权限的权威名字**，比网页文档里的手写清单可靠。第 4 节把它反查成我们需要的权限集合。

## 2. 与 63 次实测的交叉

| 情况 | 数量 | 说明 |
|---|---|---|
| 实测请求能在规格里找到对应 operation | 38 / 63 | 见下面各块的「实测」列 |
| 实测过、但规格里查无此路径 | 11 | **不是我们测错了**，是规格未收录（回落行为、废弃路径、GraphQL/SQL 这类非 REST 面） |

规格里查无此路径的实测项（逐条给原因，不是笼统的「规格没写」）：

| 请求 | 路径 | HTTP | 为什么不在规格里 |
|---|---|---|---|
| analytics_engine/datasets | `GET /accounts/«ACCOUNT_ID»/analytics_engine/datasets` | 500 | 规格里 `analytics_engine` 只剩 `/sql` 一条 —— **datasets REST 已被移除**，所以它 500。列自建数据集改用 `POST /accounts/{a}/analytics_engine/sql` + 裸 `SHOW TABLES`（本轮实测 200） |
| engine_usage/sum | `GET /accounts/«ACCOUNT_ID»/analytics/engine_usage/sum` | 500 | 规格里完全没有 `engine_usage` 这一族 —— Workers 用量的老接口已经没了，对应 500 |
| turnstile sites | `GET /accounts/«ACCOUNT_ID»/turnstile/widgets` | 400 | 规格里 `turnstile` 相关路径 0 条：这个产品只有网页文档，不在公开 OpenAPI 面上 |
| email_routing 配置 | `GET /accounts/«ACCOUNT_ID»/email_routing/settings` | 400 | 路径写法过时：规格里是 `/accounts/{a}/email/routing/...`（斜杠），下划线老写法未收录 |
| GraphQL 1dGroups(date_geq) | `POST /graphql` | 200 | GraphQL 是独立 schema（`cloudflare/api-schemas` 只收 REST），规格里当然查不到 |
| GraphQL adaptive 国家分布 | `POST /graphql` | 200 | GraphQL 是独立 schema（`cloudflare/api-schemas` 只收 REST），规格里当然查不到 |
| GraphQL adaptive 主机名+协议+状态码 | `POST /graphql` | 200 | GraphQL 是独立 schema（`cloudflare/api-schemas` 只收 REST），规格里当然查不到 |
| versions/{v}/settings（后缀被忽略，同 {v}） | `GET /accounts/«ACCOUNT_ID»/workers/scripts/rin-server/versions/e0b67a07-8532-4843-b2ff-f27029fc135b/settings` | 200 | **后缀回落**验证：`versions/{v}/settings` 未收录，服务端把尾巴丢掉后返回版本详情（200 是假的“存在”） |
| tail 端点存在性 | `GET /accounts/«ACCOUNT_ID»/workers/tails` | 405 | 规格里已无此路径（405 也证明老批量接口不受理 GET）；Tail 改走 `/workers/scripts/{script_name}/tails` 与 `/workers/observability/telemetry/live-tail` |
| old analytics/report | `GET /zones/50c463774e5fc1009c434c996d13353d/analytics/report` | 400 | 规格里 zone 侧只剩 `dns_analytics/report`、`analytics/dashboard` 等；老的 `analytics/report` 已下架（我们 400 收到的正是 7003 路由不存在） |
| kv 键写 PUT(缺值) | `PUT /accounts/«ACCOUNT_ID»/storage/kv/namespaces/cbcec7efa09b774e3dd2ff13e8dc2ef4/keys/probe` | 404 | 规格里 `…/namespaces/{namespace_id}/keys` 只支持 GET，写值路径是 `…/values/{key_name}` —— 10025 的报错原文就把正确路径告诉我们了 |

## 3. 四块目标功能：逐条端点（规格展开 + 实测状态）

### ① 域名流量 — 20 个 operation（GET 17 / 写 3），涉及令牌权限 9 种

| 产品族 | 方法 | 路径 | 说明 | 所需令牌权限 | 实测 |
|---|---|---|---|---|---|
| Analytics Engine | GET | `/accounts/{account_id}/analytics_engine/sql` | Execute an Analytics Engine SQL query via query parameter | `Account Analytics Read` | — |
| Analytics Engine | POST | `/accounts/{account_id}/analytics_engine/sql` | Execute an Analytics Engine SQL query via request body | `Account Analytics Read` | — |
| Analytics SQL | GET | `/accounts/{account_tag}/analytics/sql` | Query analytics datasets | `Account Analytics Read` | — |
| Analytics SQL | POST | `/accounts/{account_tag}/analytics/sql` | Query analytics datasets | `Account Analytics Read` | — |
| Analytics SQL | GET | `/accounts/{account_tag}/analytics/sql/introspection` | List available analytics datasets | `Account Analytics Read` | — |
| Analytics SQL | GET | `/analytics/sql` | Query analytics datasets | `Account Analytics Read` | — |
| Analytics SQL | POST | `/analytics/sql` | Query analytics datasets | `Account Analytics Read` | ✅ 200（实测项「SQL account 维度」） |
| Analytics SQL | GET | `/analytics/sql/introspection` | List available analytics datasets | `Account Analytics Read` | — |
| Analytics | GET | `/accounts/{account_id}/realtime/kit/{app_id}/analytics/daywise` | Fetch day-wise session and recording analytics data for an App | `Realtime Admin` / `Realtime` | — |
| Argo Analytics for Zone | GET | `/zones/{zone_id}/analytics/latency` | Argo Analytics for a zone | `Analytics Read` | — |
| DNS Analytics | GET | `/zones/{zone_id}/dns_analytics/report` ⚠️废弃 | Table | `Analytics Read` | — |
| DNS Analytics | GET | `/zones/{zone_id}/dns_analytics/report/bytime` ⚠️废弃 | By Time | `Analytics Read` | — |
| Usage Analytics | GET | `/accounts/{account_id}/billing/usage` | Get account billing usage | `Billing Read` | — |
| Usage Analytics | GET | `/accounts/{account_id}/media/usage` | Get account Media usage | `Images Read` | — |
| Usage Analytics | GET | `/accounts/{account_id}/stream/usage` | Get account Stream usage | `Stream Read` | — |
| Usage Analytics | GET | `/zones/{zone_id}/media/usage` | Get zone Media usage | `Images Read` | — |
| Usage Analytics | GET | `/zones/{zone_id}/stream/usage` | Get zone Stream usage | `Stream Read` | — |
| User Analytics (Deprecated) | GET | `/user/analytics/dashboard` ⚠️废弃 | Get user analytics dashboard | `User Details Write` / `User Details Read` | — |
| Zone Analytics (Deprecated) | GET | `/zones/{zone_identifier}/analytics/colos` ⚠️废弃 | Get analytics by Co-locations | `Analytics Read` | — |
| Zone Analytics (Deprecated) | GET | `/zones/{zone_identifier}/analytics/dashboard` ⚠️废弃 | Get dashboard | `Analytics Read` | — |

### ② Workers 版本与部署 — 77 个 operation（GET 35 / 写 42），涉及令牌权限 6 种

| 产品族 | 方法 | 路径 | 说明 | 所需令牌权限 | 实测 |
|---|---|---|---|---|---|
| Client Versions | GET | `/accounts/{account_id}/devices/client-versions` | List client versions | — | — |
| Client Versions | GET | `/accounts/{account_id}/devices/client-versions/target-environments` | List available target environments | — | — |
| Live Tail | POST | `/accounts/{account_id}/workers/observability/telemetry/live-tail` | Prepare live tail | `Workers Observability Write` | — |
| Live Tail | POST | `/accounts/{account_id}/workers/observability/telemetry/live-tail/heartbeat` | Live tail heartbeat | `Workers Observability Write` | — |
| Preview Deployments | GET | `/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}/deployments` | List Preview Deployments | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Preview Deployments | POST | `/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}/deployments` | Create Preview Deployment | — | — |
| Preview Deployments | DELETE | `/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}/deployments/{deployment_id}` | Delete Preview Deployment | `Workers Scripts Write` | — |
| Preview Deployments | GET | `/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}/deployments/{deployment_id}` | Get Preview Deployment | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Preview Deployments | PATCH | `/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}/deployments/latest` | Patch Latest Preview Deployment | — | — |
| Versions | GET | `/accounts/{account_id}/workers/workers/{worker_id}/versions` | List Worker Versions | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Versions | POST | `/accounts/{account_id}/workers/workers/{worker_id}/versions` | Create Worker Version | `Workers Scripts Write` | — |
| Versions | DELETE | `/accounts/{account_id}/workers/workers/{worker_id}/versions/{version_id}` | Delete Worker Version | — | — |
| Versions | GET | `/accounts/{account_id}/workers/workers/{worker_id}/versions/{version_id}` | Get Worker Version | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Versions | GET | `/accounts/{account_id}/workers/workers/{worker_id}/versions/latest` | Get Latest Worker Version | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Versions | PATCH | `/accounts/{account_id}/workers/workers/{worker_id}/versions/latest` | Patch Latest Worker Version | — | — |
| Worker Cron Trigger | GET | `/accounts/{account_id}/workers/scripts/{script_name}/schedules` | Get Worker Script Schedules (Cron Triggers) | `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「scripts/{s}/schedules cron」） |
| Worker Cron Trigger | PUT | `/accounts/{account_id}/workers/scripts/{script_name}/schedules` | Update Worker Script Schedules (Cron Triggers) | `Workers Scripts Write` | ⚠️ 400（实测项「schedules 写 PUT(空)」） |
| Worker Deployments | GET | `/accounts/{account_id}/workers/scripts/{script_name}/deployments` | List Worker Deployments | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「deployments?environment=production」） |
| Worker Deployments | POST | `/accounts/{account_id}/workers/scripts/{script_name}/deployments` | Create Worker Deployment | `Workers Scripts Write` | ⚠️ 400（实测项「版本切换 POST(空 versions)」） |
| Worker Deployments | DELETE | `/accounts/{account_id}/workers/scripts/{script_name}/deployments/{deployment_id}` | Delete Worker Deployment | `Workers Scripts Write` | — |
| Worker Deployments | GET | `/accounts/{account_id}/workers/scripts/{script_name}/deployments/{deployment_id}` | Get Worker Deployment | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Worker Environment | GET | `/accounts/{account_id}/workers/services/{service_name}/environments/{environment_name}/content` | Get Worker Environment Script Content | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Worker Environment | PUT | `/accounts/{account_id}/workers/services/{service_name}/environments/{environment_name}/content` | Replace Worker Environment Script Content | `Workers Scripts Write` | — |
| Worker Environment | GET | `/accounts/{account_id}/workers/services/{service_name}/environments/{environment_name}/settings` | Get Worker Environment Settings | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Worker Environment | PATCH | `/accounts/{account_id}/workers/services/{service_name}/environments/{environment_name}/settings` | Patch Worker Environment Settings | — | — |
| Worker Profiling | POST | `/accounts/{account_id}/workers/workers/{worker_id}/versions/{version_id}/profile` | Profile Worker Version | — | — |
| Worker Script | POST | `/accounts/{account_id}/workers/assets/upload` | Upload Worker Assets | — | — |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts` | List Worker Scripts | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「workers/scripts」） |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts-search` | Search Worker Scripts | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Worker Script | DELETE | `/accounts/{account_id}/workers/scripts/{script_name}` | Delete Worker | `Workers Scripts Write` | — |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts/{script_name}` | Download Worker Script | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「scripts/{s} 整包下载(multipart)」） |
| Worker Script | PUT | `/accounts/{account_id}/workers/scripts/{script_name}` | Upload Worker Module | `Workers Scripts Write` | — |
| Worker Script | POST | `/accounts/{account_id}/workers/scripts/{script_name}/assets-upload-session` | Create Worker Assets Upload Session | `Workers Scripts Write` | — |
| Worker Script | PUT | `/accounts/{account_id}/workers/scripts/{script_name}/content` | Replace Worker Script Content | `Workers Scripts Write` | ⚠️ 405（实测项「scripts/{s}/content 代码下载(预期405)」） |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts/{script_name}/content/v2` | Get Worker Script Content | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts/{script_name}/script-settings` | Get Worker Script Settings | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Worker Script | PATCH | `/accounts/{account_id}/workers/scripts/{script_name}/script-settings` | Patch Worker Script Settings | `Workers Scripts Write` | — |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts/{script_name}/secrets` | List secrets bound to a Worker script | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | ⚠️ 405（实测项「secrets 写 POST(空 body)」） |
| Worker Script | PUT | `/accounts/{account_id}/workers/scripts/{script_name}/secrets` | Add a secret to a Worker script | `Workers Scripts Write` | — |
| Worker Script | PATCH | `/accounts/{account_id}/workers/scripts/{script_name}/secrets-bulk` | Patch multiple Worker script secrets | — | — |
| Worker Script | DELETE | `/accounts/{account_id}/workers/scripts/{script_name}/secrets/{secret_name}` | Delete Worker script secret | `Workers Scripts Write` | — |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts/{script_name}/secrets/{secret_name}` | Get a secret binding | — | — |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts/{script_name}/settings` | Get Worker Script and Version Settings | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「scripts/{s}/settings」） |
| Worker Script | PATCH | `/accounts/{account_id}/workers/scripts/{script_name}/settings` | Patch Worker Script and Version Settings | `Workers Scripts Write` | — |
| Worker Script | DELETE | `/accounts/{account_id}/workers/scripts/{script_name}/subdomain` | Delete Worker Script Subdomain | `Workers Scripts Write` | — |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts/{script_name}/subdomain` | Get Worker Script Subdomain | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Worker Script | POST | `/accounts/{account_id}/workers/scripts/{script_name}/subdomain` | Update Worker Script Subdomain | `Workers Scripts Write` | — |
| Worker Script | GET | `/accounts/{account_id}/workers/scripts/{script_name}/usage-model` | Get Worker Script Usage Model | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Worker Script | PUT | `/accounts/{account_id}/workers/scripts/{script_name}/usage-model` | Replace Worker Script Usage Model | `Workers Scripts Write` | — |
| Worker Subdomain | DELETE | `/accounts/{account_id}/workers/subdomain` | Delete Workers Subdomain | `Workers Scripts Write` | — |
| Worker Subdomain | GET | `/accounts/{account_id}/workers/subdomain` | Get a Workers Subdomain | `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「subdomain 是否开启」） |
| Worker Subdomain | PUT | `/accounts/{account_id}/workers/subdomain` | Create a Workers Subdomain | `Workers Scripts Write` | — |
| Worker Tail Logs | GET | `/accounts/{account_id}/workers/scripts/{script_name}/tails` | List Worker Tails | `Workers Tail Read` / `Workers Scripts Write` | — |
| Worker Tail Logs | POST | `/accounts/{account_id}/workers/scripts/{script_name}/tails` | Start Worker Tail | `Workers Tail Read` / `Workers Scripts Write` | — |
| Worker Tail Logs | DELETE | `/accounts/{account_id}/workers/scripts/{script_name}/tails/{id}` | Delete Worker Tail | `Workers Tail Read` / `Workers Scripts Write` | — |
| Worker Versions | GET | `/accounts/{account_id}/workers/scripts/{script_name}/versions` | List Versions | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「versions 第2页(验 result_info)」） |
| Worker Versions | POST | `/accounts/{account_id}/workers/scripts/{script_name}/versions` | Upload Version | `Workers Scripts Write` | ⚠️ 415（实测项「版本上传 POST(非 multipart)」） |
| Worker Versions | GET | `/accounts/{account_id}/workers/scripts/{script_name}/versions/{version_id}` | Get Worker Script Version | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「versions/{v} 详情」） |
| Workers Smart Placement | GET | `/accounts/{account_id}/workers/placement/regions` | List Workers Smart Placement Regions | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Workers | POST | `/accounts/{account_id}/builds/workers` | Create Worker build configuration | `Workers CI Write` | — |
| Workers | GET | `/accounts/{account_id}/builds/workers/{external_script_id}/builds` | List builds for a Worker | `Workers CI Write` / `Workers CI Read` | — |
| Workers | GET | `/accounts/{account_id}/builds/workers/{external_script_id}/triggers` | List triggers for a Worker | `Workers CI Write` / `Workers CI Read` | — |
| Workers | DELETE | `/accounts/{account_id}/builds/workers/{script_tag}` | Delete Worker build configuration | `Workers CI Write` | — |
| Workers | GET | `/accounts/{account_id}/builds/workers/{script_tag}` | Get Worker build configuration | `Workers CI Write` / `Workers CI Read` | — |
| Workers | PATCH | `/accounts/{account_id}/builds/workers/{script_tag}` | Update Worker build configuration | `Workers CI Write` | — |
| Workers | POST | `/accounts/{account_id}/builds/workers/{script_tag}/migrate_to_previews` | Migrate worker to previews | `Workers CI Write` | — |
| Workers | GET | `/accounts/{account_id}/builds/workers/{script_tag}/previews` | List previews | `Workers CI Write` / `Workers CI Read` | — |
| Workers | GET | `/accounts/{account_id}/builds/workers/{script_tag}/previews/{preview_id}` | Get preview | `Workers CI Write` / `Workers CI Read` | — |
| Workers | PATCH | `/accounts/{account_id}/builds/workers/{script_tag}/previews/{preview_id}` | Update preview | `Workers CI Write` | — |
| Workers | GET | `/accounts/{account_id}/builds/workers/{script_tag}/previews/{preview_id}/builds` | List builds by preview | `Workers CI Write` / `Workers CI Read` | — |
| Workers | POST | `/accounts/{account_id}/builds/workers/{script_tag}/previews/{preview_id}/builds` | Create preview build | `Workers CI Write` | — |
| Workers | GET | `/accounts/{account_id}/workers/workers` | List Workers | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Workers | POST | `/accounts/{account_id}/workers/workers` | Create Worker | `Workers Scripts Write` | — |
| Workers | DELETE | `/accounts/{account_id}/workers/workers/{worker_id}` | Delete Worker | `Workers Scripts Write` | — |
| Workers | GET | `/accounts/{account_id}/workers/workers/{worker_id}` | Get Worker | `Workers Tail Read` / `Workers Scripts Write` / `Workers Scripts Read` | — |
| Workers | PATCH | `/accounts/{account_id}/workers/workers/{worker_id}` | Edit Worker | — | — |
| Workers | PUT | `/accounts/{account_id}/workers/workers/{worker_id}` | Update Worker | `Workers Scripts Write` | — |

### ③ Pages 部署与切换 — 26 个 operation（GET 8 / 写 18），涉及令牌权限 2 种

| 产品族 | 方法 | 路径 | 说明 | 所需令牌权限 | 实测 |
|---|---|---|---|---|---|
| Pages Assets | POST | `/pages/assets/check-missing` | Check missing assets | — | — |
| Pages Assets | POST | `/pages/assets/upload` | Upload asset | — | — |
| Pages Assets | POST | `/pages/assets/upsert-hashes` | Upsert asset hashes | — | — |
| Pages Build Cache | POST | `/accounts/{account_id}/pages/projects/{project_name}/purge_build_cache` | Purge the Pages build cache | `Pages Write` | — |
| Pages Deployment | GET | `/accounts/{account_id}/pages/projects/{project_name}/deployments` | List Pages deployments | `Pages Read` / `Pages Write` | ⚠️ 404（实测项「pages deployments（假项目）」） |
| Pages Deployment | POST | `/accounts/{account_id}/pages/projects/{project_name}/deployments` | Create a Pages deployment | `Pages Write` | — |
| Pages Deployment | DELETE | `/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}` | Delete a Pages deployment | `Pages Write` | — |
| Pages Deployment | GET | `/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}` | Get a Pages deployment | `Pages Read` / `Pages Write` | — |
| Pages Deployment | GET | `/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/history/logs` | Get Pages deployment logs | `Pages Read` / `Pages Write` | — |
| Pages Deployment | POST | `/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/retry` | Retry a Pages deployment | `Pages Write` | — |
| Pages Deployment | POST | `/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/rollback` | Roll back a Pages deployment | `Pages Write` | ⚠️ 404（实测项「pages rollback（假项目）」） |
| Pages Deployment | POST | `/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/tails` | Create deployment tail | `Pages Write` | — |
| Pages Deployment | DELETE | `/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/tails/{tail_id}` | Delete deployment tail | `Pages Write` | — |
| Pages Domains | GET | `/accounts/{account_id}/pages/projects/{project_name}/domains` | List Pages custom domains | `Pages Read` / `Pages Write` | ⚠️ 404（实测项「pages domains（假项目）」） |
| Pages Domains | POST | `/accounts/{account_id}/pages/projects/{project_name}/domains` | Add a Pages custom domain | `Pages Write` | — |
| Pages Domains | DELETE | `/accounts/{account_id}/pages/projects/{project_name}/domains/{domain_name}` | Delete a Pages custom domain | `Pages Write` | — |
| Pages Domains | GET | `/accounts/{account_id}/pages/projects/{project_name}/domains/{domain_name}` | Get a Pages custom domain | `Pages Read` / `Pages Write` | — |
| Pages Domains | PATCH | `/accounts/{account_id}/pages/projects/{project_name}/domains/{domain_name}` | Retry custom domain validation | `Pages Write` | — |
| Pages Project | GET | `/accounts/{account_id}/pages/projects` | List Cloudflare Pages projects | `Pages Read` / `Pages Write` | ✅ 200（实测项「pages/projects」） |
| Pages Project | POST | `/accounts/{account_id}/pages/projects` | Create a Cloudflare Pages project | `Pages Write` | — |
| Pages Project | DELETE | `/accounts/{account_id}/pages/projects/{project_name}` | Delete a Cloudflare Pages project | `Pages Write` | — |
| Pages Project | GET | `/accounts/{account_id}/pages/projects/{project_name}` | Get a Cloudflare Pages project | `Pages Read` / `Pages Write` | — |
| Pages Project | PATCH | `/accounts/{account_id}/pages/projects/{project_name}` | Update a Cloudflare Pages project | `Pages Write` | — |
| Pages Project | DELETE | `/accounts/{account_id}/pages/projects/{project_name}/source` | Disconnect a Git repository | `Pages Write` | — |
| Pages Project | POST | `/accounts/{account_id}/pages/projects/{project_name}/source` | Connect a Git repository | `Pages Write` | — |
| Pages Project | GET | `/accounts/{account_id}/pages/projects/{project_name}/upload-token` | Get upload token | `Pages Write` | — |

### ④ 自定义域名 / Zone / DNS — 95 个 operation（GET 39 / 写 56），涉及令牌权限 43 种

| 产品族 | 方法 | 路径 | 说明 | 所需令牌权限 | 实测 |
|---|---|---|---|---|---|
| Cache Reserve Clear | GET | `/zones/{zone_id}/smart_shield/cache_reserve_clear` | Get Cache Reserve Clear | `Zone Settings Write` / `Zone Settings Read` / `Zone Read` / `Zone Write` | — |
| Cache Reserve Clear | POST | `/zones/{zone_id}/smart_shield/cache_reserve_clear` | Start Cache Reserve Clear | `Zone Settings Write` / `Zone Write` | — |
| Custom Hostname Fallback Origin for a Zone | DELETE | `/zones/{zone_id}/custom_hostnames/fallback_origin` | Delete Fallback Origin for Custom Hostnames | `SSL and Certificates Write` | — |
| Custom Hostname Fallback Origin for a Zone | GET | `/zones/{zone_id}/custom_hostnames/fallback_origin` | Get Fallback Origin for Custom Hostnames | `SSL and Certificates Write` / `SSL and Certificates Read` | — |
| Custom Hostname Fallback Origin for a Zone | PUT | `/zones/{zone_id}/custom_hostnames/fallback_origin` | Update Fallback Origin for Custom Hostnames | `SSL and Certificates Write` | — |
| Custom Hostname for a Zone | GET | `/zones/{zone_id}/custom_hostnames` | List Custom Hostnames | `SSL and Certificates Write` / `SSL and Certificates Read` | ⚠️ 403（实测项「custom_hostnames(SaaS)」） |
| Custom Hostname for a Zone | POST | `/zones/{zone_id}/custom_hostnames` | Create Custom Hostname | `SSL and Certificates Write` | — |
| Custom Hostname for a Zone | DELETE | `/zones/{zone_id}/custom_hostnames/{custom_hostname_id}` | Delete Custom Hostname (and any issued SSL certificates) | `SSL and Certificates Write` | — |
| Custom Hostname for a Zone | GET | `/zones/{zone_id}/custom_hostnames/{custom_hostname_id}` | Custom Hostname Details | `SSL and Certificates Write` / `SSL and Certificates Read` | — |
| Custom Hostname for a Zone | PATCH | `/zones/{zone_id}/custom_hostnames/{custom_hostname_id}` | Edit Custom Hostname | `SSL and Certificates Write` | — |
| Custom Hostname for a Zone | DELETE | `/zones/{zone_id}/custom_hostnames/{custom_hostname_id}/certificate_pack/{certificate_pack_id}/certificates/{certificate_id}` | Delete Single Certificate And Key For Custom Hostname | `SSL and Certificates Write` | — |
| Custom Hostname for a Zone | PUT | `/zones/{zone_id}/custom_hostnames/{custom_hostname_id}/certificate_pack/{certificate_pack_id}/certificates/{certificate_id}` | Replace Custom Certificate and Custom Key In Custom Hostname | `SSL and Certificates Write` | — |
| Custom Hostname for a Zone | GET | `/zones/{zone_id}/custom_hostnames/quota` | Get Custom Hostname Quota | `SSL and Certificates Write` / `SSL and Certificates Read` | — |
| Custom SSL for a Zone | GET | `/zones/{zone_id}/custom_certificates` | List SSL Configurations | `Access: Mutual TLS Certificates Write` / `Access: Mutual TLS Certificates Read` / `SSL and Certificates Write` / `SSL and Certificates Read` | — |
| Custom SSL for a Zone | POST | `/zones/{zone_id}/custom_certificates` | Create SSL Configuration | `Access: Mutual TLS Certificates Write` / `SSL and Certificates Write` | — |
| Custom SSL for a Zone | DELETE | `/zones/{zone_id}/custom_certificates/{custom_certificate_id}` | Delete SSL Configuration | `Access: Mutual TLS Certificates Write` / `SSL and Certificates Write` | — |
| Custom SSL for a Zone | GET | `/zones/{zone_id}/custom_certificates/{custom_certificate_id}` | SSL Configuration Details | `Access: Mutual TLS Certificates Write` / `Access: Mutual TLS Certificates Read` / `SSL and Certificates Write` / `SSL and Certificates Read` | — |
| Custom SSL for a Zone | PATCH | `/zones/{zone_id}/custom_certificates/{custom_certificate_id}` | Edit SSL Configuration | `Access: Mutual TLS Certificates Write` / `SSL and Certificates Write` | — |
| Custom SSL for a Zone | PUT | `/zones/{zone_id}/custom_certificates/prioritize` | Re-prioritize SSL Certificates | `Access: Mutual TLS Certificates Write` / `SSL and Certificates Write` | — |
| DNS Records for a Zone | GET | `/zones/{zone_id}/dns_records` | List DNS Records | `DNS Read` / `DNS Write` | ✅ 200（实测项「zones/{id}/dns_records」） |
| DNS Records for a Zone | POST | `/zones/{zone_id}/dns_records` | Create DNS Record | `DNS Write` | ⚠️ 403（实测项「DNS 写 POST(缺字段)」） |
| DNS Records for a Zone | DELETE | `/zones/{zone_id}/dns_records/{dns_record_id}` | Delete DNS Record | `DNS Write` | — |
| DNS Records for a Zone | GET | `/zones/{zone_id}/dns_records/{dns_record_id}` | DNS Record Details | `DNS Read` / `DNS Write` | — |
| DNS Records for a Zone | PATCH | `/zones/{zone_id}/dns_records/{dns_record_id}` | Update DNS Record | `DNS Write` | — |
| DNS Records for a Zone | PUT | `/zones/{zone_id}/dns_records/{dns_record_id}` | Overwrite DNS Record | `DNS Write` | — |
| DNS Records for a Zone | POST | `/zones/{zone_id}/dns_records/batch` | Batch DNS Records | `DNS Write` | — |
| DNS Records for a Zone | GET | `/zones/{zone_id}/dns_records/export` | Export DNS Records | `DNS Read` / `DNS Write` | ✅ 200（实测项「dns_records/export(zone 文件)」） |
| DNS Records for a Zone | POST | `/zones/{zone_id}/dns_records/import` | Import DNS Records | `DNS Write` | — |
| DNS Records for a Zone | POST | `/zones/{zone_id}/dns_records/scan` ⚠️废弃 | Scan DNS Records | `DNS Write` | — |
| DNS Records for a Zone | GET | `/zones/{zone_id}/dns_records/scan/review` | List Scanned DNS Records | `DNS Read` / `DNS Write` | — |
| DNS Records for a Zone | POST | `/zones/{zone_id}/dns_records/scan/review` | Review Scanned DNS Records | `DNS Write` | — |
| DNS Records for a Zone | POST | `/zones/{zone_id}/dns_records/scan/trigger` | Trigger DNS Record Scan | `DNS Write` | — |
| DNS Records for a Zone | GET | `/zones/{zone_id}/dns_records/usage` | Get DNS Record Usage | `Zone DNS Settings Write` / `Zone DNS Settings Read` / `DNS Read` / `DNS Write` | — |
| DNSSEC | DELETE | `/zones/{zone_id}/dnssec` | Delete DNSSEC records | `DNS Write` | — |
| DNSSEC | GET | `/zones/{zone_id}/dnssec` | DNSSEC Details | `DNS Read` / `DNS Write` | — |
| DNSSEC | PATCH | `/zones/{zone_id}/dnssec` | Edit DNSSEC Status | `DNS Write` | — |
| DNSSEC | GET | `/zones/{zone_id}/dnssec/zsk` | List DNSSEC ZSKs | `DNS Read` / `DNS Write` | — |
| Domains | GET | `/accounts/{account_id}/workers/domains` | List Worker Domains | `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「workers/domains」） |
| Domains | PUT | `/accounts/{account_id}/workers/domains` | Attach Worker Domain | `Workers Scripts Write` | ⚠️ 400（实测项「域名绑定 PUT(非法域名)」） |
| Domains | DELETE | `/accounts/{account_id}/workers/domains/{domain_id}` | Detach Worker Domain | `Workers Scripts Write` | — |
| Domains | GET | `/accounts/{account_id}/workers/domains/{domain_id}` | Get Worker Domain | `Workers Scripts Write` / `Workers Scripts Read` | ✅ 200（实测项「workers/domains/{id}」） |
| Universal SSL Settings for a Zone | GET | `/zones/{zone_id}/ssl/universal/settings` | Universal SSL Settings Details | `SSL and Certificates Write` / `SSL and Certificates Read` | ✅ 200（实测项「ssl/universal/settings」） |
| Universal SSL Settings for a Zone | PATCH | `/zones/{zone_id}/ssl/universal/settings` | Edit Universal SSL Settings | `SSL and Certificates Write` | — |
| Worker Routes | GET | `/zones/{zone_id}/workers/routes` | List Worker Routes | `Workers Routes Write` / `Workers Routes Read` | ✅ 200（实测项「zones/{id}/workers/routes」） |
| Worker Routes | POST | `/zones/{zone_id}/workers/routes` | Create Worker Route | `Workers Routes Write` | — |
| Worker Routes | DELETE | `/zones/{zone_id}/workers/routes/{route_id}` | Delete Worker Route | `Workers Routes Write` | — |
| Worker Routes | GET | `/zones/{zone_id}/workers/routes/{route_id}` | Get Worker Route | `Workers Routes Write` / `Workers Routes Read` | — |
| Worker Routes | PUT | `/zones/{zone_id}/workers/routes/{route_id}` | Replace Worker Route | `Workers Routes Write` | — |
| Zone Cache Settings | GET | `/zones/{zone_id}/cache/cache_reserve` | Get Cache Reserve setting | `Zone Settings Write` / `Zone Settings Read` / `Zone Read` / `Zone Write` | — |
| Zone Cache Settings | PATCH | `/zones/{zone_id}/cache/cache_reserve` | Change Cache Reserve setting | `Zone Settings Write` / `Zone Write` | — |
| Zone Cache Settings | GET | `/zones/{zone_id}/cache/cache_reserve_clear` | Get Cache Reserve Clear | `Zone Settings Write` / `Zone Settings Read` / `Zone Read` / `Zone Write` | — |
| Zone Cache Settings | POST | `/zones/{zone_id}/cache/cache_reserve_clear` | Start Cache Reserve Clear | `Zone Settings Write` / `Zone Write` | — |
| Zone Cache Settings | GET | `/zones/{zone_id}/cache/regional_tiered_cache` | Get Regional Tiered Cache setting | `Zone Settings Write` / `Zone Settings Read` / `Zone Read` / `Zone Write` | — |
| Zone Cache Settings | PATCH | `/zones/{zone_id}/cache/regional_tiered_cache` | Change Regional Tiered Cache setting | `Zone Settings Write` / `Zone Write` | — |
| Zone Cache Settings | DELETE | `/zones/{zone_id}/cache/variants` | Delete variants setting | `Zone Settings Write` / `Zone Write` | — |
| Zone Cache Settings | GET | `/zones/{zone_id}/cache/variants` | Get variants setting | `Zone Settings Write` / `Zone Settings Read` / `Zone Read` / `Zone Write` | — |
| Zone Cache Settings | PATCH | `/zones/{zone_id}/cache/variants` | Change variants setting | `Zone Settings Write` / `Zone Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings` ⚠️废弃 | Get all zone settings | `Zone Settings Write` / `Zone Settings Read` | ✅ 200（实测项「zones/{id}/settings(56项)」） |
| Zone Settings | PATCH | `/zones/{zone_id}/settings` ⚠️废弃 | Edit multiple zone settings | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/{setting_id}` | Get zone setting | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/{setting_id}` | Edit zone setting | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/aegis` | Get aegis setting | `Zone Settings Write` / `Zone Settings Read` / `Zone Read` / `Zone Write` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/aegis` | Change aegis setting | `Zone Settings Write` / `Zone Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/automatic_platform_optimization` | Get Automatic Platform Optimization setting | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/automatic_platform_optimization` | Change Automatic Platform Optimization setting | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/binary_ast` | Get Binary AST setting | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/binary_ast` | Change Binary AST setting | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/fonts` | Get Cloudflare Fonts setting | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/fonts` | Change Cloudflare Fonts setting | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/h2_prioritization` | Get HTTP/2 Prioritization setting | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/h2_prioritization` | Change HTTP/2 Prioritization setting | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/image_resizing` | Get Image Transformations setting | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/image_resizing` | Change Image Transformations setting | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/origin_h2_max_streams` | Get Origin H2 Max Streams Setting | `Zone Settings Write` / `Zone Settings Read` / `Zone Read` / `Zone Write` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/origin_h2_max_streams` | Change Origin H2 Max Streams Setting | `Zone Settings Write` / `Zone Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/origin_max_http_version` | Get Origin Max HTTP Version Setting | `Zone Settings Write` / `Zone Settings Read` / `Zone Read` / `Zone Write` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/origin_max_http_version` | Change Origin Max HTTP Version Setting | `Zone Settings Write` / `Zone Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/speed_brain` | Get Cloudflare Speed Brain setting | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/speed_brain` | Change Cloudflare Speed Brain setting | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/transformations_allowed_origins` | Get Image Transformations Allowed Origins setting | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/transformations_allowed_origins` | Change Image Transformations Allowed Origins setting | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/transformations_c2pa` | Get Image Transformations C2PA setting | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/transformations_c2pa` | Change Image Transformations C2PA setting | `Zone Settings Write` | — |
| Zone Settings | GET | `/zones/{zone_id}/settings/transformations_config` | Get Transformations configuration | `Zone Settings Write` / `Zone Settings Read` | — |
| Zone Settings | PATCH | `/zones/{zone_id}/settings/transformations_config` | Change Transformations configuration | `Zone Settings Write` | — |
| Zone | GET | `/zones` | List Zones | `Zone Zone Read` | ✅ 200（实测项「zones」） |
| Zone | POST | `/zones` | Create Zone | `Zone Zone Edit` / `Zone DNS Edit` | — |
| Zone | DELETE | `/zones/{zone_id}` | Delete Zone | `Zone Write` | — |
| Zone | GET | `/zones/{zone_id}` | Zone Details | `Trust and Safety Write` / `Trust and Safety Read` / `Zero Trust: PII Read` / `Zaraz Edit` / `Zaraz Read` / `Zaraz Admin` / `Access: Apps and Policies Revoke` / `Access: Apps and Policies Write` / `Access: Apps and Policies Read` / `Access: Apps and Policies Revoke` / `Access: Mutual TLS Certificates Write` / `Access: Organizations, Identity Providers, and Groups Write` / `Zone Settings Write` / `Zone Settings Read` / `Zone Read` / `DNS Read` / `Workers Scripts Write` / `Workers Scripts Read` / `Zone Write` / `Workers Routes Write` / `Workers Routes Read` / `Stream Write` / `Stream Read` / `SSL and Certificates Write` / `SSL and Certificates Read` / `Logs Write` / `Logs Read` / `Cache Purge` / `Page Rules Write` / `Page Rules Read` / `Load Balancers Write` / `Load Balancers Read` / `Firewall Services Write` / `Firewall Services Read` / `DNS Write` / `Apps Write` / `Analytics Read` / `Access: Apps and Policies Write` / `Access: Apps and Policies Read` | ✅ 200（实测项「zones/{id}」） |
| Zone | PATCH | `/zones/{zone_id}` | Edit Zone | `Zone Write` | — |
| Zone | PUT | `/zones/{zone_id}/activation_check` | Rerun the Activation Check | `Zone Write` | — |
| Zone | POST | `/zones/{zone_id}/environments/{environment_id}/invalidate_cache` | Invalidate Cached Content by Environment | `Zone Versioning Write` | — |
| Zone | POST | `/zones/{zone_id}/environments/{environment_id}/purge_cache` | Purge Cached Content by Environment | `Cache Purge` | — |
| Zone | POST | `/zones/{zone_id}/invalidate_cache` | Invalidate Cached Content | — | — |
| Zone | POST | `/zones/{zone_id}/purge_cache` | Purge Cached Content | `Cache Purge` | ⚠️ 401（实测项「cache purge POST(files:[123])」） |

## 4. 令牌权限反查（照这个勾后台，别自己猜名字）

| 令牌权限名（`x-api-token-group` 原样） | 覆盖的写操作数 | 例子 |
|---|---|---|
| Workers Scripts Write | 27 | DELETE `/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}/deployments/{deployment_id}`；POST `/accounts/{account_id}/workers/workers/{worker_id}/versions` |
| Zone Settings Write | 20 | POST `/zones/{zone_id}/smart_shield/cache_reserve_clear`；PATCH `/zones/{zone_id}/cache/cache_reserve` |
| Pages Write | 15 | POST `/accounts/{account_id}/pages/projects/{project_name}/purge_build_cache`；POST `/accounts/{account_id}/pages/projects/{project_name}/deployments` |
| （规格未标注） | 13 | POST `/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}/deployments`；PATCH `/accounts/{account_id}/workers/workers/{worker_id}/previews/{preview_id}/deployments/latest` |
| Zone Write | 12 | DELETE `/zones/{zone_id}`；PATCH `/zones/{zone_id}` |
| SSL and Certificates Write | 12 | DELETE `/zones/{zone_id}/custom_hostnames/fallback_origin`；PUT `/zones/{zone_id}/custom_hostnames/fallback_origin` |
| DNS Write | 11 | POST `/zones/{zone_id}/dns_records`；DELETE `/zones/{zone_id}/dns_records/{dns_record_id}` |
| Workers CI Write | 6 | POST `/accounts/{account_id}/builds/workers`；DELETE `/accounts/{account_id}/builds/workers/{script_tag}` |
| Access: Mutual TLS Certificates Write | 4 | POST `/zones/{zone_id}/custom_certificates`；DELETE `/zones/{zone_id}/custom_certificates/{custom_certificate_id}` |
| Account Analytics Read | 3 | POST `/accounts/{account_id}/analytics_engine/sql`；POST `/accounts/{account_tag}/analytics/sql` |
| Workers Routes Write | 3 | POST `/zones/{zone_id}/workers/routes`；DELETE `/zones/{zone_id}/workers/routes/{route_id}` |
| Workers Observability Write | 2 | POST `/accounts/{account_id}/workers/observability/telemetry/live-tail`；POST `/accounts/{account_id}/workers/observability/telemetry/live-tail/heartbeat` |
| Workers Tail Read | 2 | POST `/accounts/{account_id}/workers/scripts/{script_name}/tails`；DELETE `/accounts/{account_id}/workers/scripts/{script_name}/tails/{id}` |
| Cache Purge | 2 | POST `/zones/{zone_id}/environments/{environment_id}/purge_cache`；POST `/zones/{zone_id}/purge_cache` |
| Zone Zone Edit | 1 | POST `/zones` |
| Zone DNS Edit | 1 |  |
| Zone Versioning Write | 1 | POST `/zones/{zone_id}/environments/{environment_id}/invalidate_cache` |

> 当前令牌已有的权限面见 `05-令牌权限边界.md`；把这两张表对照，缺的就是「⛔」那几条。

## 5. 其余产品族（本期不做，但要知道大盘有多大）

四块功能只覆盖 218 / 3670 个 operation（5.9%），剩下 3452 个分布在 undefined 个产品族里。前 30 族：

| 产品族 | operation 数 | 其中写操作 | 路径示例 |
|---|---|---|---|
| Email Security Settings | 53 | 36 | `/accounts/{account_id}/email-security/settings/allow_policies` |
| dos-flowtrackd-api_other | 45 | 30 | `/accounts/{account_id}/magic/advanced_dns_protection/configs/dns_protection/rules` |
| Radar HTTP | 41 | 0 | `/radar/http/summary/bot_class` |
| Event | 35 | 24 | `/accounts/{account_id}/cloudforce-one/events` |
| R2 Bucket | 34 | 20 | `/accounts/{account_id}/event_notifications/r2/{bucket_name}/configuration` |
| Brand Protection | 33 | 20 | `/accounts/{account_id}/cloudforce-one/v2/brand-protection/domain/matches` |
| Threat Signals | 32 | 16 | `/accounts/{account_id}/cloudforce-one/v2/threat-signals/articles` |
| Workflows | 31 | 16 | `/accounts/{account_id}/triggers/{script_name}` |
| Devices | 30 | 17 | `/accounts/{account_id}/devices` |
| Queue | 28 | 20 | `/accounts/{account_id}/event_subscriptions/subscriptions` |
| brapi | 27 | 15 | `/accounts/{account_id}/browser-rendering/accessibilityTree` |
| Workers for Platforms | 27 | 17 | `/accounts/{account_id}/workers/dispatch/namespaces` |
| Rules | 25 | 15 | `/accounts/{account_id}/cloudforce-one/rules` |
| Radar DNS | 25 | 0 | `/radar/dns/summary/cache_hit` |
| Waiting Room | 24 | 15 | `/accounts/{account_id}/waiting_rooms` |
| Radar Email Security | 24 | 0 | `/radar/email/security/summary/arc` |
| brand_protection | 23 | 13 | `/accounts/{account_id}/brand-protection/alerts` |
| Security Center Insights | 23 | 6 | `/accounts/{account_id}/intel/attack-surface-report/issue-types` |
| Radar Layer 7 Attacks | 23 | 0 | `/radar/attacks/layer7/summary/http_method` |
| Radar Layer 3 Attacks | 22 | 0 | `/radar/attacks/layer3/summary/bitrate` |
| Email Security | 21 | 9 | `/accounts/{account_id}/email-security/investigate` |
| Resource Sharing | 21 | 12 | `/accounts/{account_id}/shares` |
| Cloudflare Tunnel | 20 | 9 | `/accounts/{account_id}/cfd_tunnel` |
| DEX Synthetic Application Monitoring | 20 | 3 | `/accounts/{account_id}/dex/colos` |
| Artifacts | 19 | 8 | `/accounts/{account_id}/artifacts/namespaces` |
| workers_pipelines_other | 19 | 11 | `/accounts/{account_id}/pipelines` |
| Radar AS112 | 19 | 0 | `/radar/as112/summary/dnssec` |
| Radar BGP | 19 | 0 | `/radar/bgp/hijacks/events` |
| AI Search Instances | 17 | 11 | `/accounts/{account_id}/ai-search/instances` |
| Request for Information (RFI) | 17 | 12 | `/accounts/{account_id}/cloudforce-one/requests` |

剩下的多半是 Zero Trust / Access / Gateway、Radar 公开数据、Turnstile、Email Security、AI/Void 这些。结论没变：**「覆盖网页版全部功能」= 3600 多个 operation，做不完也不需要**；按四块范围做，App 的第一版面对的就是上面第 3 节这 218 个。


## 6. 数据面收口：Analytics SQL / Analytics Engine / Workers Observability

`GET /analytics/sql/introspection?account_tag={a}` 是官方给的**数据集目录接口**（200，90 个数据集），一次把「SQL 面到底能查什么」说死了：

| 分类 | 数据集数 |
|---|---|
| Network | 19 |
| Compute | 17 |
| Storage | 15 |
| Media | 8 |
| Security | 6 |
| AI | 5 |
| Performance | 5 |
| Zero Trust | 4 |
| Other / Uncategorized | 4 |
| Logs and Traces | 4 |
| Email | 2 |
| HTTP Traffic | 1 |

关键判定（都是查这份目录 + 实跑得到的，不是猜）：

- 站点流量在 SQL 面**只有 `events.httpRequests` 一个表**（目录里有），它是自适应采样表，`kind.sampling = adaptive`。
- `events.dnsQueries`、`events.firewallEvents`、`events.workersRequests` **在 SQL 面根本不存在**（目录 0 条 + 实跑 422 `table not found`）。DNS 数据要走 `zones/{z}/dns_analytics/report`，防火墙数据走 GraphQL；Workers 级用量在 REST/SQL 的老路上确实一个都没有，唯一有希望的是下面第 3 条的新 Observability 面。
- 自建 Analytics Engine 数据集在 SQL 里写作 `events.analyticsEngine.{dataset}`；本账号 0 个数据集（`SHOW TABLES` 返回空数组），所以 `analytics_engine/datasets` REST 才一直 500。
- `logs.workersLogs`、`logs.containerLogs` 在目录里（Logs and Traces 类），说明**新版 Workers 日志走的是 SQL 可查的 logs 面**，和老的 Tail 是两条路。

本轮补测的 14 条形状（`node tools/probe-sql-surfaces.mjs` 生成，全部只读）：

| 测的是什么 | 请求 | HTTP | 结果摘要 |
|---|---|---|---|
| SQL introspection（数据集目录） | `GET /analytics/sql/introspection?account_tag={a}` | 200 | {"datasets":[{"name":"events.accessLoginRequests","title":"Access Login Requests","category":"Zero Trust","des |
| SQL 顶层别名（带 scope） | `POST /analytics/sql` | 200 | data=[{"n":5034}] rows=1 |
| SQL account 作用域路径 | `POST /accounts/{a}/analytics/sql` | 200 | data=[{"n":5034}] rows=1 |
| SQL 带 time_range 参数 | `POST /analytics/sql` | 200 | data=[{"d":"2026-10-02 00:00:00","n":2234},{"d":"2026-10-03 00:00:00","n":2649},{"d":"2026-10-04 00:00:00","n" |
| SQL SHOW TABLES（不允许） | `POST /analytics/sql` | 422 | Input was invalid: Error during planning: SHOW TABLES is not supported unless information_schema is enabled |
| AE SHOW TABLES（列自建数据集） | `POST /accounts/{a}/analytics_engine/sql` | 200 | data=[] rows=0 |
| AE 选数据集不能带库名前缀 | `POST /accounts/{a}/analytics_engine/sql` | 422 | Input was invalid: sql parser error: Expected literal string, found: 1 |
| AE GET ?query= | `GET /accounts/{a}/analytics_engine/sql?query=SHOW%20TABLES` | 200 | data=[] rows=0 |
| telemetry/keys 属性目录 | `POST /accounts/{a}/workers/observability/telemetry/keys` | 200 | result=[{"key":"$metadata.message","type":"string","lastSeenAt":1791546568496},{"key":"$metadata.messageTempla |
| telemetry/query 需要 queryId | `POST /accounts/{a}/workers/observability/telemetry/query` | 400 | {"success":false,"_e":null,"_i":{"query":"SELECT 1"},"_c":{"issues":[{"expected":"string","code":"invalid_type |
| telemetry/values 取值 | `POST /accounts/{a}/workers/observability/telemetry/values` | 400 | {"success":false,"_e":null,"_i":{"timeframe":{"start":"2026-10-08T00:00:00Z","end":"2026-10-09T00:00:00Z"}},"_ |
| email routing 正确路径 | `GET /accounts/{a}/email/routing/settings` | 400 | E 7003 Could not route to /accounts/«ACCOUNT_ID»/email/routing/settings, perhaps your obje |
| KV 写值正确路径（不存在则 404） | `GET /accounts/{a}/storage/kv/namespaces/{a}/values/__probe__` | 404 | E 10009 get: 'key not found' |
| workers/tails 老批量接口 | `GET /accounts/{a}/workers/tails` | 405 | E 10405 Method not allowed for this authentication scheme |

三条对写代码有直接影响的结论：

1. **`time_range` 参数可用**：`{query, time_range:{start,end}, scope:{accountTag}}` 实测 200 并按天返回真实计数 —— App 里做时间范围选择器不用自己拼 `WHERE timestamp >= …`，少一类 SQL 注入/拼错风险。
2. **`/accounts/{a}/analytics_engine/sql` 收的是裸 SQL 文本**（`content-type: text/plain` 或 GET `?query=`），跟 `/analytics/sql` 的 JSON 信封完全不同；同一个客户端里要两套调用。AE 面里选数据集**不能带 `events.` 前缀**。
3. **Workers Observability 的 `telemetry/keys` 实测 200** 并返回真实属性目录（`$metadata.message` 之类），但 `telemetry/query` 要 `queryId`（跑已保存查询，不吞裸 SQL）且规格要求 `Workers Observability Write` 权限 —— 想在自己的域名上看 Workers 级用量，这条路是通的，但要补权限并且得先在后台建保存查询。

## 7. 复跑与刷新

```bash
cd «LOCAL_PATH»
node tools/gen-api-catalog.mjs            # sha 没变就走 «LOCAL_PATH» 缓存
node tools/gen-api-catalog.mjs --refresh   # 强制重新拉官方规格（Cloudflare 几乎每天更新）
```

机器可读全量在 `docs/evidence/openapi-operations.json`（3670 条，含族名/权限/废弃标记），后续要按产品族筛接口、生成客户端代码都从它出发。
