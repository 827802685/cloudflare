# 03 · API 目录：Pages 部署与切换

**这份文档里除了 §1，其余全部不是"打真实请求测出来的"。** 其中 §3 已经从 wrangler 源码逐行核实（源码口径，比文档口径硬，但仍等于"没真传过一次"），§2 其余部分仍是官方文档口径。原因很直接：

```
GET /accounts/{a}/pages/projects → 200 {"result": [], "success": true}   # 0 个项目
```

你账号里**一个 Pages 项目都没有**，所以拿不到任何真实响应形状。我能做到的验证上限是下面这一层。

## 1. 已经证实的部分

| 探测 | 结果 | 证实了什么 |
|---|---|---|
| `GET /accounts/{a}/pages/projects` | `200`，`result: []` | 路由可达、当前令牌**有 Pages 读权限** |
| `GET /accounts/{a}/pages/projects/__none__` | `404` `code 8000007 Project not found. The specified project name does not match any of your existing projects.` | 项目用**名字**而不是 ID 寻址；错误码 `8000007` 是 Pages 专用段（`8000xxx`，和 Workers 的 `100xxx` 不是一套） |
| `GET …/pages/projects/__none__/deployments` | `404` `8000007` | 部署列表路由存在，且**先校验项目存在再校验子资源** |
| `POST …/pages/projects/__none__/deployments/x/rollback` | `404` `8000007` | rollback 是 `POST …/deployments/{id}/rollback`，路由存在（**没被 10000/10001 挡住，说明令牌也有 Pages 写权限**） |
| `GET …/pages/projects/__none__/domains` | `404` `8000007` | 域名子路由存在 |
| `GET /accounts/{a}/pages/projects?per_page=12` | `400` **`code 8000024 Invalid list options`** | Pages 的列表分页**不吃大 per_page**；二分下来上限是 **10**（`per_page=10/8/6` 通过，`12/15/20/24` 拒绝），而 Workers/DNS 那些列表端点 5–100 都收。证据：`docs/evidence/list-limits.json`，复跑：`node tools/probe-list-limits.mjs` |

`8000007` 而不是 `10000 Authentication error` 是关键区别：说明**卡住我们的不是权限，是没数据**。

分页这条坑跟"有没有数据"无关，所以它现在是确定的：Pages 列表**不能**像其它端点那样一次 `per_page=100` 捞完。网关里 `pagesList()` 因此固定 `per_page=10` 循环翻页（最多 10 页 = 100 条封顶），前端不做二次分页。等你真建了项目，这个循环要复验一次 —— 因为账号里 0 个项目时，`result` 到底是数组还是 `{deployments:[…]}` 这个信封形状还确认不了（网关两种都做了拆包：`cf.ts` 的 `listify()` 认 `items/deployments/schedules/data`）。

## 2. Pages 的端点清单（官方文档口径，**逐条标了怎么才能验**）

基址 `/accounts/{a}/pages`。

### 只读

| 用途 | 路径 |
|---|---|
| 项目列表 | `GET /projects` |
| 项目详情 | `GET /projects/{project_name}` |
| 部署列表 | `GET /projects/{project_name}/deployments` （`?per_page&page`，**per_page 上限 10**，见 §1） |
| 单次部署详情 | `GET /projects/{project_name}/deployments/{deployment_id}` |
| 部署下的文件清单 | `GET /projects/{project_name}/deployments/{deployment_id}/files` |
| 目录列表 | `GET /projects/{project_name}/deployments/{deployment_id}/directories?path=/` |
| 项目域名 | `GET /projects/{project_name}/domains` |
| 别名 | `GET /projects/{project_name}/aliases/{hash}` |

项目对象里与"版本切换"直接相关的字段是 `production_branch`（当前生产分支）和部署对象的 `id / short_id / url / created_on / modified_on / state / environment_produced / is_switch_deploy / production_branch?`。**这些字段名我一个都没实测到**，UI 上先按"能显示就显示、缺字段不崩"来写。

### 写（就是你要的"版本切换"）

| 用途 | 请求 | 风险 |
|---|---|---|
| **回滚到某次部署** | `POST /projects/{p}/deployments/{deployment_id}/rollback`，body 为空 `{}` | 生产立即切换，**这是唯一一个"一键换版本"动作** |
| 触发一次新部署（Git 项目） | `POST /projects/{p}/deployments`，body `{branch}` | 会真的跑构建 |
| 直传部署（Direct Upload） | 五步链路：`GET /projects/{p}/upload-token` → `POST /pages/assets/check-missing` → `POST /pages/assets/upload`（**JSON 批量**，不是每文件一个 multipart）→ `POST /pages/assets/upsert-hashes` → `POST /projects/{p}/deployments`（multipart，`manifest` = `路径→哈希`） | 完整契约见 §3；这一行上一版写错过（把 `upsert_hashes` 说成部署 body 的字段、把上传说成逐文件 multipart），已按 wrangler 4.149 源码改正 |
| 拿上传用的临时 JWT | `GET /projects/{p}/upload-token` | 只读性质但会签发凭据；JWT 只在内存里用，**不进日志、不进仓库** |
| 改生产分支 | `PATCH /projects/{p}/production_branch`，body `{branch_name}` | 只适用于 Git 托管项目 |
| 删除部署 | `DELETE /projects/{p}/deployments/{deployment_id}` | 不可逆 |
| 域名绑定/解绑 | `POST /DELETE /projects/{p}/domains/{domain}` | 会动 DNS |
| 构建缓存清除 | `PURGE /projects/{p}/cache` | 轻微 |

## 3. 直传部署的哈希契约（已从 wrangler 源码逐行核实 → 风险 A2 关闭）

来源：本机安装的 wrangler **4.149** 打包产物 `app/gateway/node_modules/wrangler/wrangler-dist/cli.js`。行号是这一版的，升级 wrangler 后要按下面的关键字重新 grep：`blake3Wasm.hash`、`/pages/assets/check-missing`、`/pages/assets/upsert-hashes`。复跑核对：

```bash
cd app/gateway/node_modules/wrangler/wrangler-dist
grep -n "blake3Wasm.hash\|pages/assets/check-missing\|pages/assets/upsert-hashes\|MAX_BUCKET_SIZE =" cli.js
```

### 3.1 哈希公式（L167309-167318，`hashFile`）

```js
const contents = fs.readFileSync(filepath);
const base64Contents = contents.toString("base64");
const extension = path.extname(filepath).substring(1);        // 去掉点的扩展名，没有扩展名就是 ""
return blake3Wasm.hash(base64Contents + extension).toString("hex").slice(0, 32);
```

三个容易算错的点，**我们上一版的记述里就有一个是错的**：

1. BLAKE3 的输入**不是文件字节**，而是"文件字节的 base64 字符串"再拼**无点扩展名**。直接对字节做 BLAKE3 得到的是另一套哈希，服务端会把每个文件都当新内容。
2. 输出取 hex 的**前 32 个字符**（不是完整 64 位）。
3. 历史文档里那个 `!size` 之类的后缀在 4.149 这一版**不存在**，别按老资料加。

**反例（2026-10-10 从第三方源码读到的）**：`CloudFlareAssistant` 的 `core/crypto/PagesBlake3Hasher.kt:49` 写的是 `"$b64.$ext"` —— base64 和扩展名之间**多了个字面点**，而它自己的文档注释声称"与 wrangler v4 对齐"。同文件 L69 那段旧 SHA-256 fallback 反而注明"此处没有点"。它的单测 `PagesBlake3HasherTest.kt` 只拿 BouncyCastle 当参照做自证（没有任何服务端返回的哈希作为 fixture），所以**证明不了服务端认哪种**。我们按 wrangler 的无点版实现；真机跑 `docs/11` §4.5 时如果发现"每次全量重传"（第 1 条描述的典型症状），第一件事就是把点号加回去再比对。详见 `08` §7.3。

### 3.2 真实调用顺序（和上一版记的不一样：先问缺什么，最后才 upsert）

| 步 | 请求 | 说明（源码位置） |
|---|---|---|
| 1 | `GET /accounts/{a}/pages/projects/{p}/upload-token` | 拿短时效 JWT；`code 8000013` 或 JWT 过期时重新取（L306006、L306040） |
| 2 | `POST /pages/assets/check-missing` | `Authorization: Bearer <jwt>`，body `{hashes:[…]}`，返回**缺失哈希**。整个上传的中枢（L306023） |
| 3 | `POST /pages/assets/upload` | **JSON 不是 multipart**：`[{key:hash, value:base64(内容), metadata:{contentType}, base64:true}]`；只传第 2 步返回的那些（L306097-306110） |
| 4 | `POST /pages/assets/upsert-hashes` | **放在最后**，body `{hashes:[全部哈希]}`。失败只 `logger.warn("Failed to update file hashes…")` 不阻断部署（L306175-306212） |
| 5 | `POST /accounts/{a}/pages/projects/{p}/deployments` | multipart 创建部署，`manifest` = `JSON.stringify({"/相对路径": hash})`（L306364 起） |

第 4 步的语义要看清：它不是"告诉服务端我手上有哪些"，而是把这次传过的哈希写回缓存，让**下次**部署能少传。所以它失败只是下次变慢，本次部署照常成功。

第 3 步的分桶与并发（L187135-187137、L306050-306090）：`MAX_BUCKET_SIZE = 40 MiB`、`MAX_BUCKET_FILE_COUNT = 2000`（**Windows 下 1000**）、`BULK_UPLOAD_CONCURRENCY = 3`，文件按大小降序装箱，上传失败重试 5 次，JWT 过期会自动刷新后重试。

第 5 步的 multipart 字段（缺了就省略，全部可选除 `manifest`）：`manifest`、`branch`、`commit_message`（用 `truncateUtf8Bytes(…, MAX_COMMIT_MESSAGE_BYTES)` 截断，**按 UTF-8 字节**不是字符）、`commit_hash`、`commit_dirty`、`_headers`（File）、`_redirects`（File）、`functions-filepath-routing-config.json`（File）、`wrangler_config_hash`（对 `wrangler.toml` 做 SHA-256 hex）、`pages_build_output_dir`（相对 `cwd` 的路径）。Functions 目录由 esbuild 打成 `_worker.bundle` 一起发。

### 3.3 校验与限制

- 单文件 ≤ **25 MiB**（`MAX_ASSET_SIZE = 25 * 1024 * 1024`，L165539 / L187133）；文件数默认 **20 000**（`MAX_ASSET_COUNT_DEFAULT = 2e4`，L187132），但可被 JWT claim `max_file_count_allowed` 覆盖（`maxFileCountAllowedFromClaims`，被 `pages functions`/`validate` 用在 `CF_PAGES_UPLOAD_JWT` 存在时）——**上限是服务端发的，不是我们写死的**，网关要读这个 claim 而不是硬编码。
- 排除清单是 **glob**（`IGNORE_LIST`，L305832-305841）：`_worker.js`、`_redirects`、`_headers`、`_routes.json`、`functions`、`**/.DS_Store`、`node_modules`、`.git`、`.wrangler`；另外目录里如果有 `.assetsignore`（`CF_ASSETS_IGNORE_FILENAME`，L165540）会叠加生效。这四个被排除的文件走 multipart 字段单独传，不作为静态资产。
- Functions 目录由 esbuild 打成 `_worker.bundle` 一起发。

### 3.4 结论与仍然存在的边界

可行性判定：**高**。BLAKE3 有纯 JS/wasm 实现，WebView 里能算，公式与协议都是确定的，不需要"先砍掉直传"。

但这一节仍然是**源码口径已核实、真实上传未做**：你账号里 0 个 Pages 项目，第 2/3/4 步一个都没打过真请求（见 §4 路线 A）。要变成实测，需要一次最小的 Direct Upload。

## 4. 要把这一块变成"实测"，只有两条路

**路线 A（推荐，成本最低）**：你在 Cloudflare Pages 里建一个测试项目 —— 拿你现成的任意静态站点或 `web-clipboard` 的构建产物，走一次 `Create deployment`（Git 或 Direct 都行）。之后我就能把 §2 的 8 个只读接口 + rollback 全部跑真数据，并把响应样本存进 `docs/evidence/`。
- 需要你授权，因为这会在你账号里**创建资源**（Pages 免费套餐内，构建次数也够）。
- 建完请告诉我项目名，我会把 `docs/evidence/pages/*.json` 补齐。

**路线 B**：暂时不做 Pages 功能，UI 上留一个"未启用"入口。
- 好处是零风险、零等待；坏处是你以后想用还得再开发一轮。

我倾向 A + 只建一个最小测试项目（比如一个单文件 HTML 的 Direct Upload 项目），因为它同时能验 §3：哈希公式与五步链路在源码层已经确定，但"我们自己算出来的哈希服务端是否照收"只有真实上传一次才算闭环。

## 5. 一个已经确定的坏消息

Pages 的 `*.pages.dev` 预览域名在你当前网络**不可达**（和 `workers.dev` 同样症状，超时）。所以即使 Pages 功能做出来了，App 里"点开预览链接"这一步在你手机上也得靠你自己的域名（`pages/{p}` 支持绑定自定义域名）才可用。这一点在验收时不要算成 App 的 bug。
