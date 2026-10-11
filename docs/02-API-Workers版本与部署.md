# 02 · API 目录：Workers 版本与部署

覆盖你要的第二块功能：**Workers 版本查看 + 版本切换（含回滚）**。这一块是四块里实测最完整的，只读部分全部拿到真实数据。

基址统一是 `https://api.cloudflare.com/client/v4`，下面省略。账号 ID 记作 `{a}`。

## 1. 只读接口（全部实测 200）

| 用途 | 方法与路径 | 实测要点 |
|---|---|---|
| 脚本列表 | `GET /accounts/{a}/workers/scripts` | 返回 7 个。**脚本名在 `id` 字段，不在 `name`**（`name` 是 undefined，我第一版就栽在这里，导致后面全部 404 `10007`）。`tag` 是遗留字段，别当 ID 用 |
| 单脚本概览 / **整包代码下载** | `GET /accounts/{a}/workers/scripts/{s}` | **返回 `multipart/form-data`，不是 JSON**，`rin-server` 整包 2 558 574 字节 |
| 脚本当前设置 | `GET /accounts/{a}/workers/scripts/{s}/settings` | `placement, compatibility_date, compatibility_flags, usage_model, tags, tail_consumers, logpush, …` |
| 版本列表 | `GET /accounts/{a}/workers/scripts/{s}/versions?per_page=5` | 信封是 `result.items[]` **+ `result_info`**，`total_count=148`。翻页 `?page=2` 实测可用 |
| 只列可部署版本 | `GET …/versions?deployable=true` | 200 |
| **单个版本详情** | `GET …/versions/{version_id}` | 200，见 §2 结构 |
| 部署历史 | `GET …/deployments?environment=production&per_page=50` | 信封 `result.deployments[]` |
| 单次部署详情 | `GET …/deployments/{deployment_id}` | **200 实测**（用真实生产部署 id `7f9ad0a6-…`），字段 `id,source,strategy,annotations,versions,created_on`，`versions` = `[{version_id, percentage}]`。假 id → `404 code 10336 This deployment does not exist on your Worker.` |
| **脚本级 settings（另一条路由）** | `GET …/scripts/{s}/script-settings` | 200，`{logpush, tags, tail_consumers, observability}` —— 和上面 `/settings`（含 `compatibility_date/placement/usage_model`）**是两套不同的读写面**，字段几乎不重叠。做"改 logpush / 改 tail consumer / 开关 Observability"要打在 `script-settings` 上，打 `settings` 会写错地方。**读侧已进网关白名单**：`GET /v1/workers/{s}/script-settings`，Worker 详情的 Observability / 日志推送两行现在只从这条取（`09` §E16） |
| 密钥**名**列表 | `GET …/secrets` | 200，只有 `{name,type}`，**值永远读不到** |
| cron 触发器 | `GET …/schedules` | 200，`{"schedules":[{"cron":"*/20 * * * *","created_on":…,"modified_on":…}]}` |
| workers.dev 前缀（账号级） | `GET /accounts/{a}/workers/subdomain` | 200 `{"subdomain":"acct0501"}`（该域名本机不可达，只做展示用） |
| workers.dev 开关（脚本级） | `GET /accounts/{a}/workers/scripts/{s}/subdomain` | 200 `{"enabled":true,"previews_enabled":true}` —— **`rin-server` 的 workers.dev 是开着的**，但按 `00` 分册实测它在你的网络不可达，所以"能读"不等于"能访问"。读侧已进网关：`GET /v1/workers/{s}/subdomain`，Worker 详情"设置"卡里那行「workers.dev 已启用」就是它 |
| 遗留 service API | `GET /accounts/{a}/workers/services/{s}/environments/production/scripts` | 200，`environment, script_tag, created_on`。**wrangler 之前的老写法，现在还能用**，新项目不建议依赖 |

## 2. 版本详情的真实结构（`versions/{v}`，4029 字节）

```jsonc
{
  "id": "e0b67a07-8532-4843-b2ff-f27029fc135b",
  "number": 148,
  "metadata": {
    "created_on": "2026-10-09T03:35:30.449022Z",
    "source": "wrangler",
    "author_id": "e18fba761923af88f63319ad1e1dd26b",
    "author_email": "",
    "has_preview": true
  },
  "annotations": { "workers/triggered_by": "upload" },
  "resources": {
    "script": {
      "etag": "03014dfd747f4ed4e946d78969bafd3d…",
      "handlers": ["fetch", "scheduled", "queue"],
      "placement_mode": "smart",
      "placement": { "mode": "smart" },
      "last_deployed_from": "wrangler"
    },
    "script_runtime": {
      "assets": { "serve_directly": true, "raw_run_worker_first": false, "base_path": "/" },
      "compatibility_date": "2026-01-20",
      "usage_model": "standard"
    },
    "bindings": [ /* 27 条，见下 */ ]
  }
}
```

`bindings[]` 每条的形态随 `type` 变（实测 7 种以上）：

```jsonc
{ "name": "JWT_SECRET", "type": "secret_text" }                     // 只有名字，无值
{ "name": "PAGE_SIZE", "type": "plain_text", "text": "5" }
{ "name": "DB", "type": "d1", "id": "84f4174e-…", "database_id": "84f4174e-…" }
{ "name": "TASK_QUEUE", "type": "queue", "queue_name": "rin-server-tasks" }
{ "name": "AI", "type": "ai", "project": "<catalog>" }
{ "name": "ASSETS", "type": "assets" }
{ "name": "ADMIN_PASSWORD", "type": "secret_text" }
```

**版本对比页直接把两个版本的 `resources` 做深比较就够了** —— 绑定、runtime、handlers、compatibility_date、placement 全在这里，不需要额外接口。这是本次调研里最省事的一个发现：**"这个版本和上个版本有什么差别"能真正回答出来**（虽然代码差异要另外下载整包才能比）。

## 3. 部署记录（`deployments`）

```jsonc
{ "id": "7f9ad0a6-2aa5-4168-bad4-e080011df277",
  "source": "wrangler",
  "strategy": "percentage",
  "annotations": { "workers/message": "Automatic deployment on upload.",
                   "workers/triggered_by": "upload" },
  "versions": [ { "version_id": "e0b67a07-…", "percentage": 100 } ],
  "created_on": "2026-10-09T03:35:30.449022Z" }
```

实测近三条：`7f9ad0a6 → e0b67a07 100%`（10-09 03:35:30）、`7980fbe4 → ff03e70e 100%`（10-09 03:35:20）、`d32db2cb → 82691ae9 100%`（10-06 09:17:41）。

两个 UI 结论：

1. **`versions[]` 是数组，可以两条百分比相加**（灰度发布就是这个）。手机上"把 30% 流量分给新版本"就是把 `[{v1,70},{v2,30}]` 提交上去。
2. **`annotations["workers/message"]` 是给用户看的部署说明**，回滚前一定显示它，否则用户面对 148 个 UUID 完全分不清哪个是"上次改头像的那次"。你的 `rin-server` 现在全是 `"Automatic deployment on upload."`，说明上传时没带 message —— App 里要在部署动作里强制填 message。

## 4. 写接口：本阶段**没有真发过**任何有效写请求

只做了非法 payload 的语义探测（服务端必拒，用来确认路由存在 + 权限状态）：

| 动作 | 请求 | 实测响应 | 说明 |
|---|---|---|---|
| 切换版本 | `POST …/versions/{id}/deployments` body `{"versions":[]}` | `400 code 10210 Invalid deployment: The value "[]" is invalid for field "versions"` | 路由通、鉴权通、校验在业务层 → **说明当前令牌有 Workers Scripts 写权限** |
| 上传新版本 | `POST …/scripts/{s}/versions`（故意用 json 而不是 multipart） | `415 code 10001 Content-Type must be one of: multipart/form-data` | 同上，路由与鉴权通 |
| 写密钥 | `PUT …/secrets`（空 body） | `405 code 10405` | 见 §6 关于 10405 的解释 |
| 写 cron | `PUT …/schedules`（空 body） | `400 code 10026 Could not parse request body` | 路由通 |

### 4.1 版本切换的正式请求（待你授权后实测）

```
POST /accounts/{a}/workers/scripts/rin-server/deployments
content-type: application/json

{ "versions": [ { "version_id": "82691ae9-b007-48fb-81a1-5cb5d5c1b2fb", "percentage": 100 } ],
  "annotations": [ { "type": "workers/message", "value": "回滚到 10-06 那版" } ],
  "strategy": "percentage" }
```

要点（依据 `10210` 的报错语义 + 部署记录反推）：`versions[].percentage` 之和必须为 100；`annotations` 是 `{type,value}` 数组而不是对象（和 GET 返回的形态**不一样**，GET 是 map、POST 是数组，这是最容易写错的地方）。

### 4.2 上传新版本（multipart，待授权后实测）

一个 `metadata` JSON part + 每个模块一个 raw part：

```
metadata = {
  "main_module": "index-XXXX.js",
  "compatibility_date": "2026-01-20",
  "compatibility_flags": [],
  "usage_model": "standard",
  "bindings": [...],
  "annotations": [ { "type": "workers/message", "value": "从手机改的一行" } ],
  "tags": [],
  "tails": []
}
```

打包必须在**手机端侧用 esbuild 出 ES module**，不要在网关 Worker 里打（免费 CPU 10 ms 不够，而且 §7 那个回落行为会让调试变成噩梦）。免费 bundle 上限 3 MB gzip，端侧要先量。

回滚不需要重新上传：直接从 `versions` 里挑一个旧 `version_id` 提交部署即可，这正是 `wrangler rollback <version-id>` 做的事。

## 5. 代码查看能做到什么程度

| 需求 | 能不能做 | 怎么做 |
|---|---|---|
| 看**当前**部署的完整源码 | ✅ | `GET …/scripts/{s}` → 解析 multipart，`Content-Disposition: form-data; name="_worker.js"` 之类一段一段取（实测首段就是 `_worker.js` 的 var 声明） |
| 看**某个历史版本**的源码 | ❌ **没有公开接口** | `versions/{v}/content` 不存在（见 §7 回落坑），dashboard 上的版本对比是它自己的内部接口 |
| 看某个版本的配置/绑定/运行时 | ✅ | `GET …/versions/{v}` 的 `resources` |
| 看代码 diff | ⚠️ 只能"当前 vs 当前" | 端侧下载整包缓存，两次对比自己算 diff；2.5 MB 的包**不要**在列表页拉 |
| 从手机改代码并上线 | ✅ 路径存在 | 端侧编辑 → esbuild → §4.2 上传 → §4.1 部署；**这一段是本调研里唯一还整块没实测的链路** |

`versions/{v}/secrets` 也返回 200，内容就是版本对象（回落行为），不是密钥。

## 6. 实时日志（Tail）

- `GET /accounts/{a}/workers/tails` → `405 code 10405 Method not allowed for this authentication scheme`。**注意**：这个 10405 不是"没权限"，是这个集合只允许 `POST`（创建）。补充一条：对照官方 OpenAPI 规格（`10-API-全量清单.md`），`/accounts/{a}/workers/tails` 这个**老批量路径已经整族下架**，规格里只剩按脚本的 `/accounts/{a}/workers/scripts/{script_name}/tails`。
- 权限已实测排除：`POST /accounts/{a}/workers/scripts/__nope__/tails`（空 body）→ `404 code 10007 This Worker does not exist`。CF 是先查权限再查资源，报 10007 而不是 10000，说明**现令牌就能建 Tail，不用补权限**（规格里该端点接受 `Workers Tail Read` 或 `Workers Scripts Write` 任一，你已有后者）。
- 创建（按规格的正确形状）：`POST /accounts/{a}/workers/scripts/{s}/tails`，body 里给 `filters`（老写法是 `{scripts:[{script_name}], filters}`，新版本按脚本路径寻址后不再需要 `scripts` 数组 —— **这一点没实测**，第一次真建时以服务端报错为准）→ 返回 `{id, url}`，App **直连 `wss://`**（不能把 WS 转发过网关 Worker）。`*.workers.dev` 在你网络不可达这件事对 tail 的 wss 端点同样是风险，需要真机验证后才能承诺这个功能。
- 还有一条新路：`POST /accounts/{a}/workers/observability/telemetry/live-tail`（+ `…/live-tail/heartbeat`），属 Workers Observability 族，规格要求 `Workers Observability Write`（现令牌没有）。同族的 `telemetry/keys` 实测 200 能读属性目录，`telemetry/query` 只跑后台保存好的 `queryId`。要做"实时日志"就先在老 Tail 上做，新的等权限齐了再切。
- 清理：`DELETE /accounts/{a}/workers/scripts/{s}/tails/{id}`（规格里同族，同样只需上述任一权限）。

## 7. 三个会坑到客户端的形状问题

1. **未知路径后缀会被忽略并回落成父资源**（详见 `00` §7）。所以 `versions/{v}/content` 看着 200 其实给的是版本 JSON；`scripts/{s}/analytics` 看着 200 给的是整个代码包。→ 每个接口都要校验 `content-type` + 关键字段是否存在，不能只看状态码。
2. **列表信封不统一**：普通列表是 `result: [...]`（zones/dns/kv/d1/domains），Workers 版本是 `result: {items: [...]}`，部署是 `result: {deployments: [...]}`，Analytics SQL 是顶层 `data: [...]`，GraphQL 是 `data/errors`。→ 客户端封装要能按路由指定拆包策略，别写一个通用 `result` 取值器就完事。
3. **分页信息在 `result_info`**（`{page, per_page, count, total_count}`），不是 `X-Total-Count` 头。`total_count=148` 就是要显示的"共 148 个版本"。

## 8. 这一块还缺什么才能开工

- §4 的两条写链路（上传 + 切换）需要一次真机验证。**我建议用你自己的 `rin-server` 做一次"原样回滚再滚回来"**：把当前 100% 的版本重新部署一次（不改任何东西），只验请求体和权限码；出问题时用回滚参照版本 `82691ae9-b007-48fb-81a1-5cb5d5c1b2fb`。这一步要你明确授权才做。
- Pages 项目数为 0，见 `03`。
