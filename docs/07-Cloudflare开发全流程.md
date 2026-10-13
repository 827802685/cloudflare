# 07 · Cloudflare 开发全流程（本机已验证的部分 + 完整命令清单）

目的：把"从本地写代码到线上切版本"这条链路整清楚，让 App 里每一个按钮都对应一条我们已经理解的命令或 API。

**注意：下面所有带写动词的 `wrangler` / API 命令本阶段一条都没有执行过**（部署、绑域名、写 secret 需要你明确授权）。执行过的只有只读命令与本地 `wrangler dev`。

## 1. 本地开发闭环（已实测）

```bash
# 沙箱位置：«LOCAL_PATH»（本次调研临时建的，收尾会删）
npm i -D user4@example.com            # 约 1 分钟 / node_modules 172 MB / 37 包
npx wrangler dev                      # 起在 http://127.0.0.1:8787
```

`wrangler.toml` 最小可用形态（**`send_metrics` 要么删掉要么给布尔值**，写 `"off"` / `{disable=true}` 会让整个配置解析失败）：

```toml
name = "cf-feasibility-probe"
main = "src/index.ts"
compatibility_date = "2026-10-01"
```

本地 secret 放 `.dev.vars`（已加 `.gitignore`），`wrangler dev` 自动加载；线上要 `wrangler secret put`。

实测结果：本地 Worker 内部 `fetch("https://api.cloudflare.com/client/v4/accounts")` **成功返回真实账号** → 网关转发逻辑可以在完全离线部署的状态下开发调试。`wrangler dev` 拉 `cf.json` 失败只 warn，`request.cf` 降级成占位值，不影响主流程。`wrangler dev --remote` 则是真在你的账号上跑一个临时预览部署（**会产生线上资源，等你授权再试**）。

Web 侧联调：`vite.config.ts` 里 `server.proxy["/api"] → http://127.0.0.1:8787`，绕开 CORS。

## 2. 版本化部署（Workers Versions / Deployments）

这是你现在 `rin-server` 已经在用的机制 —— 实测它已有 **148 个版本**，部署历史里最近三条分别是 10-09 03:35:30、10-09 03:35:20、10-06 09:17:41，最后一条部署的就是回滚参照版本 `82691ae9-b007-48fb-81a1-5cb5d5c1b2fb`。

```bash
# 只上传，不上生产（可反复验绑定，不动流量）
npx wrangler versions upload

# 查看某个版本的配置（等价于 GET …/versions/{v}）
npx wrangler versions view <version_id>

# 灰度：10% 给新版本
npx wrangler versions deploy <new_version_id>@10 <old_version_id>@90

# 全量切换 / 回滚
npx wrangler deployments list
npx wrangler rollback 82691ae9-b007-48fb-81a1-5cb5d5c1b2fb --name rin-server
```

对应的裸 API（App 要直接打这些，见 `02` §4）：

| 动作 | 请求 |
|---|---|
| 上传版本 | `POST /accounts/{a}/workers/scripts/{s}/versions`（multipart：`metadata` JSON part + 每模块一个 raw part，part 名 == `metadata.main_module`/`module_parts[].part_name`） |
| 查版本 | `GET …/scripts/{s}/versions/{v}` |
| 部署/回滚 | `POST …/scripts/{s}/deployments`，body `{strategy:"percentage", versions:[{version_id,percentage}], annotations:[{type:"workers/message",value:"…"}]}` |
| 部署历史 | `GET …/scripts/{s}/deployments?environment=production` |

生效等待：上传后版本状态会推进（`wrangler versions view` 里能看到），App 里应该轮询而不是假设立即 100% 可用。

## 3. 自定义域名 / Zone 路由

wrangler 侧（`wrangler.toml`）：

```toml
# Zone 路由（老机制，pattern 必须带 /*；你 blog 那条就是这种）
[[routes]]
pattern   = "blog.acct.example.com/*"
zone_name = "acct.example.com"

# Workers 自定义域名：pattern 写成**不带通配符的完整域名**，wrangler 会走
# PUT /accounts/{a}/workers/domains，自动建 DNS + 签 Advanced Certificate
[[routes]]
pattern   = "jtb.acct.example.com"
zone_name = "acct.example.com"
```

裸 API：

```
GET    /accounts/{a}/workers/domains            # 实测 200，6 条
GET    /accounts/{a}/workers/domains/{id}       # 实测 200
PUT    /accounts/{a}/workers/domains            # body {hostname, service, environment}；权限已具备（探测到业务校验码 10082）
DELETE /accounts/{a}/workers/domains/{id}
GET    /zones/{z}/workers/routes                # 实测 200，1 条
POST/PATCH/DELETE /zones/{z}/workers/routes[/{id}]
```

**绑定的后果**（一次动作 = 建 DNS 记录 + 签证书 + 挂 Worker），所以 App 里要做二次确认并列出这三条；`cert_id` 会出现在返回对象里，可以拿来确认证书确实签出来了。

## 4. Secrets / cron / tail / logs

```bash
npx wrangler secret put JWT_SECRET              # 值从 stdin 进；对应 PUT …/scripts/{s}/secrets {name,text,type}
npx wrangler secret list                        # 实测 200：只返回 {name,type}，值永远读不到
npx wrangler deployments list
npx wrangler tail --name rin-server             # 创建 tail + 连 wss，本地要能连 wss 才行（未验证）
```

cron（实测 `GET …/schedules` → `*/20 * * * *`）：`PUT /accounts/{a}/workers/scripts/{s}/schedules`，body `{"schedules":[{"cron":"*/20 * * * *"}]}`。注意 `PUT` 是**整体替换**，不是追加 —— App 里改 cron 要先读全量再改，否则会把已有触发器清掉。

`wrangler.toml` 里的写法：

```toml
[triggers]
crons = ["*/20 * * * *"]
```

Tail 的坑（实测）：`GET /accounts/{a}/workers/tails` → `405 code 10405 Method not allowed for this authentication scheme`。这条集合**不支持列表**，只能 `POST` 创建拿到 `{id, url}` 后直连 wss。App 里"实时日志"要自己做本地会话记录（存 KV/D1 或内存环），否则重进页面就断了。

## 5. 观测：怎么知道自己的 Worker 有没有在报错

`01` 分册已经证明 Workers 自身的用量 REST 接口全部 500/7003，所以可行做法是：

1. **借 zone 流量**：`events.httpRequests` 按 `clientRequestHttpHost` 分组（每个 Worker 都挂在唯一自定义域名上）→ 请求数、状态码、`originResponseStatus`、`edgeTimeToFirstByteMs`。你的 `rin-server` 挂在 `acct.example.com` 上，状态码里 **522 有 2244 次**，这就是"Worker 后端连不上"的直接信号（522 是源站连接超时，说明 Worker 里访问的东西挂了，或者 Worker 自己抛错被边缘判为不可达）。
2. **让 Worker 自己写 Analytics Engine 数据集**，然后 `POST /analytics/sql` 查 `events.analyticsEngine.<数据集名>`（必须带 `time_range` 与 `scope.accountTag`，语法已实测可解析）。
3. **D1 侧**：`POST …/d1/database/{uuid}/query`（单条）或 `/execute`（批量），响应里 `meta.served_by_colo` 之类字段可以直接显示在调试面板上。

## 6. 上线（PWA → APK）

- PWA：`manifest` + Service Worker 离线壳 + `addToHomeScreen`，Lighthouse 验一次 360–430 px 不破版。
- APK：`npx cap add android` 生成工程 → **本机不编译**（只有 JDK 8，没有 Android SDK/Gradle）→ 推 GitHub 用 Actions 出包（`dl.google.com`/`services.gradle.org` 实测可达，所以本地装 SDK 也**能**通，只是没人给你装；这条路要额外下载几百 MB 到 C 盘）。
- Actions artifact 下载要登录，国内不稳 —— 所以第一版**先交付 PWA**，能加主屏就当 App 用，APK 当增强项排后面。

## 7. 一条完整的"手机改一行代码并上线"的假设链路（还没验）

```
端侧编辑 → esbuild 打成 ES module（量 gzip 体积，>3 MB 直接拒绝）
  → POST …/scripts/{s}/versions（multipart + metadata.compatibility_date 必须沿用现有值 "2026-01-20"）
  → GET …/versions/{new_id} 轮询到可用
  → POST …/scripts/{s}/deployments（新版本 @100%，带 workers/message）
  → 出错就 POST …/deployments（旧 version_id @100%）回滚
```

链路里 **compatibility_date 一旦改动就是行为变更**（你现在 7 个 Worker 的 compat date 从 2024-10-03 到 2026-07-25 各不相同），App 里绝不能默认填"今天"，必须从 `scripts/{s}/settings` 读出来原样带上。这是这次调研发现的一个很容易写出事故的默认值。
