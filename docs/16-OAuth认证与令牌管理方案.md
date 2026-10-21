# 16 · OAuth 2.0 认证与令牌管理方案（计划稿，未实施）

> 状态：**只做了可行性与官方能力核实，代码一行没动**。文内凡是标「待实测」的，都是我不能凭文档下结论的项，
> 实施前必须先跑通 P0，否则不做。
>
> 提出日期 2026-10-21。对应需求：① 认证走 Cloudflare 官方 OAuth 2.0 + PKCE；② Token 只存系统钥匙串；
> ③ 请求直连 Cloudflare、没有中间服务器；④ 增加「创建令牌 / 管理令牌」功能。

---

## 0. 一句话结论

**在 APK（Capacitor 壳）里，这四条可以同时成立；在浏览器 / PWA 里，三条里有两条物理上做不到。**
原因是浏览器的 CORS 与「没有系统钥匙串」这两条硬限制，不是实现取舍。

| 要求 | APK（Capacitor） | 浏览器 / PWA |
| --- | --- | --- |
| OAuth 2.0 + PKCE | ✅ 可完整实现 | ⚠️ 能发起授权，但换到 token 后调 API 会被 CORS 拦死 |
| Token 只存系统钥匙串 | ✅ Android Keystore | ❌ 无系统钥匙串可用 |
| 直连 CF、无中间服务器 | ✅ `CapacitorHttp` 已开启 | ❌ 不可行 |
| 创建 / 管理令牌 | ✅ 账户级 token 有官方 OAuth scope | ✅ 同上（但要经网关转发，等于有中间服务器） |

---

## 1. 实测证据（2026-10-21，本机 curl）

### 1.1 浏览器直连 CF API：不通

```
OPTIONS https://api.cloudflare.com/client/v4/user
  Origin: https://console.example.com
  Access-Control-Request-Method: POST
→ HTTP/2 400，响应头里没有 Access-Control-Allow-Origin
```

这条与 `app/console/src/lib/api.ts` 文件头「浏览器绕不过 CORS，必须走网关」的判断完全一致。
所以「PWA 直连 CF」不是没做，是浏览器不让做。

### 1.2 OAuth 端点存在且在线

```
GET https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=bogus&...
→ 302 https://dash.cloudflare.com/oauth/error?error=invalid_client&error_description=...Client does not exist.
```

### 1.3 令牌端点的 CORS 是「按注册 origin 放行」

```
OPTIONS https://dash.cloudflare.com/oauth2/token
  Origin: https://console.example.com
→ HTTP/2 204
   vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Accept-Encoding
   （未注册的 origin 不下发 Access-Control-Allow-Origin）
```

`vary: Origin` 说明它确实按 Origin 计算响应头；注册 OAuth client 时有 `allowed_cors_origins` 字段，
**待实测**：把 origin 填进去后，token 端点是否真的下发 ACAO。

### 1.4 OIDC 发现文档（`https://dash.cloudflare.com/.well-known/openid-configuration`）摘录

| 字段 | 值 | 对方案的影响 |
| --- | --- | --- |
| `authorization_endpoint` | `https://dash.cloudflare.com/oauth2/auth` | 直接用 |
| `token_endpoint` | `https://dash.cloudflare.com/oauth2/token` | 直接用 |
| `revocation_endpoint` | `https://dash.cloudflare.com/oauth2/revoke` | 退出登录时撤销 |
| `end_session_endpoint` | `https://dash.cloudflare.com/oauth2/sessions/logout` | 单点登出 |
| `grant_types_supported` | 含 `authorization_code`、`refresh_token` | 支持刷新 |
| `token_endpoint_auth_methods_supported` | 含 `none` | 公共客户端（无 secret）可行 |
| `code_challenge_methods_supported` | **未声明** | ⚠️ 待实测；官方文档明确要求公共客户端用 PKCE S256 |

> Cloudflare One 的 agent OAuth 文档写着 access token 默认 900 秒。那是另一个产品，
> **不能直接套到 self-managed OAuth 上**——`expires_in` 必须以真实换 token 的响应为准（待实测）。

---

## 2. 官方能力事实（有文档依据）

1. **self-managed OAuth clients** 于 2026-06-03 上线：第三方可自建 OAuth 应用，
   让应用在用户授权后代表用户访问其 Cloudflare 账号。Free/Pro/Business/Enterprise 均可用。
2. **只支持 Authorization Code**；明确不支持 Client Credentials、Implicit、密码模式、设备码。
3. **公共客户端（浏览器 / 移动 / 桌面 / CLI）必须走 PKCE + S256 + `token_endpoint_auth_method = none`**，
   不需要 client secret，也不允许把 secret 打进客户端。
4. 可见性默认 `private`（仅创建者所在账号的成员可授权）；转 `public` 前必须完成
   **client URL 域名所有权验证**（DNS TXT，带 `cloudflare_oauth_client_publisher=` 前缀）；
   **转 public 不可逆**。
5. **可选 scope 已 GA**（2026-08-20）：scope 可分「必需 / 可选」，用户同意页可拒绝可选 scope。
6. **OAuth 创建令牌**（2026-10-01 上线）：请求 `account_api_tokens:create` scope 的 OAuth 客户端
   可以创建**账户级** API Token；文档原话「starting with Cloudflare CLI」，第三方客户端能否申请
   **待实测**。创建出的 token 权限被限制在授权时授予的 scopes 内。
7. 创建账户级 token 需要 **API Token Provisioning 角色**或超级管理员。
8. **用户级 token 不建议纳入**：`User > API Tokens > Edit` 官方注明只在
   「Create additional tokens」模板里可用，自定义构建器没有该权限；OAuth 侧是否开放未见文档。

令牌管理端点（账户级）：

| 操作 | 方法与路径 |
| --- | --- |
| 列表 | `GET /accounts/{account_id}/tokens` |
| 详情 | `GET /accounts/{account_id}/tokens/{token_id}` |
| 创建 | `POST /accounts/{account_id}/tokens` |
| 更新 | `PUT /accounts/{account_id}/tokens/{token_id}` |
| 轮转值 | `PUT /accounts/{account_id}/tokens/{token_id}/value` |
| 删除 | `DELETE /accounts/{account_id}/tokens/{token_id}` |
| 权限组 | `GET /accounts/{account_id}/tokens/permission_groups` |

创建请求体核心字段：`name`、`policies[]`（`effect` / `resources` / `permission_groups`）、
可选 `not_before` / `expires_on` / `condition.request.ip`。**token 明文只在创建响应里出现一次。**

---

## 3. 架构设计（只在直连模式生效）

### 3.1 两种登录方式并存，不替换

| 方式 | 适用 | 凭据 | 存储 |
| --- | --- | --- | --- |
| API Token（现状） | PWA / 网页 / APK 兼容 | 用户手填 | 保险库（PWA 口令派生 / APK 设备密钥） |
| **OAuth（新增）** | **仅 APK** | refresh + access | refresh 进 Keystore，access 只在内存 |

`CfAccount` 增加判别字段：

```ts
type CfAccount =
  | { auth: "api_token"; token: string; id: string; name: string; alias: string }
  | { auth: "oauth"; id: string; name: string; alias: string; /* 不存任何 secret */ };
```

OAuth 账号的 secret 由新的 `lib/oauth.ts` 持有，`accounts.ts` 只存元数据（账号 id / 名称 / 别名）。
`direct.ts` 的 `send()` 不再固定读 `acc.token`，改为向 `oauth.ts` 要一个当前有效的 access token
（过期前自动刷新；刷新失败则清空并让界面回到「重新授权」）。

### 3.2 授权流程（APK，无后端）

```
1. 生成 code_verifier（43~128 字节随机）+ code_challenge = S256(verifier)
2. @capacitor/browser 打开：
   https://dash.cloudflare.com/oauth2/auth
     ?response_type=code
     &client_id=<client_id>
     &redirect_uri=<registered_redirect>
     &scope=...
     &code_challenge=<challenge>&code_challenge_method=S256
     &state=<random>
3. 用户在 CF 页面登录并同意 → 重定向到 redirect_uri
4. @capacitor/app 的 appUrlOpen 收回调 → 校验 state → 取 code
5. POST https://dash.cloudflare.com/oauth2/token
     grant_type=authorization_code&code=...&redirect_uri=...&client_id=...&code_verifier=...
   （CapacitorHttp 走原生网络栈，不参与同源策略）
6. 拿到 access_token / refresh_token / expires_in → refresh 写 Keystore，access 留内存
```

**redirect_uri 选择（待实测排序）**：
1. 自定义 scheme：`io.zjkl.console://oauth/callback` —— 最干净；但 CF 是否接受自定义 scheme 未验证。
2. 退路：自己的域名上一个**纯静态** `oauth/callback.html`，落地后 302 到自定义 scheme。
   仍然没有服务端逻辑，不违反「无中间服务器」。
3. 不建议 `https://localhost/oauth/callback`：系统浏览器把 `localhost` 指向手机自身，回不到 App。

### 3.3 安全边界（写清楚，不美化）

- access token 只在内存，进程死即失效。
- refresh token 进 Android Keystore（`EncryptedSharedPreferences` / Keystore 派生密钥），
  **不可导出**；这是「只存系统钥匙串」的实际落点。
- 现有 APK 设备保险库（`vault.ts` 的 `deviceSeal`）是「密钥与密文同存本机」，
  文件里已诚实写明只防翻文件、不防整库拖走；**新 OAuth 路径不复用它**。
- 退出登录 = 调 `/oauth2/revoke` 撤销 refresh token + 清 Keystore。
- 客户端无 secret，因此 client_id 公开不构成风险；风险面是 redirect_uri 是否被严格校验。

### 3.4 原生存储插件

仓库当前**没有 `android/` 原生工程**（CI 用 `npx cap add android` 现生成，
见 `.github/workflows/cf-console-build.yml`）。所以加 Keystore 存储有两条路：

| 方案 | 优点 | 代价 |
| --- | --- | --- |
| 社区插件（如 `@aparajita/capacitor-secure-storage`） | 改动小 | 需核实 Capacitor 7 兼容与维护状态；引第三方原生依赖 |
| 自写最小 Android 插件（`EncryptedSharedPreferences`） | 无第三方依赖、行为完全可控 | 多一份原生代码与 gradle 依赖 |

倾向先评估社区插件；若兼容性不合格再自写。**待实测**。

---

## 4. 令牌管理面板

### 4.1 范围

- **只做账户级（Account API tokens）**：官方有 OAuth scope 支撑。
- 用户级 token 不做（理由见 §2.8）。
- 页面：`views/TokensView.vue`，入口放「设置 / 安全」，与账号切换同级。

### 4.2 功能

| 功能 | 端点 | 说明 |
| --- | --- | --- |
| 列表 | `GET /accounts/{id}/tokens` | 只显示元数据：id、名称、权限组、创建者、`expires_on` |
| 创建 | `POST /accounts/{id}/tokens` | 名称 + 权限组 + 可选到期时间；**明文只显示一次** |
| 轮转 | `PUT …/tokens/{tid}/value` | 旧值立即失效 |
| 删除 | `DELETE …/tokens/{tid}` | 二次确认 |

安全口径：

- `account_api_tokens:create` 必须设为**可选 scope**，默认不申请；用户在同意页主动勾选才获得发 token 能力。
- 创建结果弹层：展示 + 复制，**关闭即清内存，绝不落盘**。
- 写操作仍受现有两层写闸门约束：网关模式看 `WRITE_ENABLED`，直连模式看本机写开关。
- 网关侧新增路由要进 `catalog.ts` 白名单 + 参数校验，并与 `direct.ts` 保持同形状，
  扩 `tools/check-direct-parity.mjs` 契约断言。

---

## 5. 实施计划与验收门

### P0 · 前置实测（不动产品代码，全部通过才继续）

| # | 要验的事 | 通过标准 |
| --- | --- | --- |
| 1 | 建 private OAuth client（`token_endpoint_auth_method=none`、`response_types=[code]`） | 建成功，拿到 client_id |
| 2 | 真实 PKCE 流程换 token | 返回 `access_token` + `refresh_token`，记录 `expires_in` |
| 3 | S256 是否被接受 | 换 token 成功；若拒绝，记录实际报错 |
| 4 | 自定义 scheme 能否注册为 redirect_uri | 注册通过且回调能回到 App |
| 5 | `GET /oauth/scopes` | 确认 `account_api_tokens:*` 对第三方 client 是否可选；读/删/轮转的准确 scope 名 |
| 6 | OAuth token 能否直接调 `api.cloudflare.com` | 调 `/accounts` 返回 200 |
| 7 | `POST /accounts/{id}/tokens` 建临时 token | 建成功 → 用它读一次 → `DELETE` 删掉（自清理） |
| 8 | token 端点 CORS（仅 PWA 相关） | 填 `allowed_cors_origins` 后是否下发 ACAO |

> P0 需要一把能建 OAuth client 的凭据：CF 后台 `Manage Account → OAuth clients` 手工建，
> 或提供带 `OAuth Clients Write` 的 API Token。

### P1 · APK 直连 OAuth 登录

- `lib/oauth.ts`（PKCE、授权、换 token、刷新、撤销）
- `lib/secure-store.ts`（Keystore 适配层，提供 get/set/remove）
- `accounts.ts` 增加 `auth` 判别与迁移（老账号不动）
- `direct.ts` 改为动态取 token
- 设置页新增「用 Cloudflare 登录」
- 验收：装机 → 登录 → 杀进程重开免登录 → 刷新可用 → 退出后 Keystore 无残留

### P2 · 令牌管理面板

- `TokensView.vue` + 网关/直连双通道路由
- 契约测试 52 条基线继续扩
- 验收：建只读 token → 用它读 → 删除 → 再用 401；临时资源全部自清理

### P3 · PWA 策略

- 保持现状：网关模式 + 口令保险库，**不提供 OAuth 直连**。
- 若要求 PWA 也 OAuth，就必须加转发服务，与「无中间服务器」冲突 → 默认不做。

### P4 · 文档

- `docs/14` 补「设置页两种登录方式」的界面口径
- `docs/09` 风险清单登记：public client 不可逆、redirect 限制、scope 白名单

---

## 6. 未验证清单（实施前必须消掉）

| # | 项 | 风险 | 消掉方式 |
| --- | --- | --- | --- |
| 1 | `account_api_tokens:*` 是否对第三方 client 开放 | 令牌管理功能可能整个做不了 | P0-5 |
| 2 | 自定义 scheme 是否可作为 redirect_uri | 深链回跳失败 | P0-4 |
| 3 | `code_challenge_methods_supported` 未出现在发现文档 | PKCE 可能被拒 | P0-3 |
| 4 | access token 实际寿命 | 刷新策略与用户体验 | P0-2 |
| 5 | OAuth token 调 `api.cloudflare.com` 的可用性 | 直连模式地基 | P0-6 |
| 6 | Keystore 插件与 Capacitor 7 的兼容性 | 需自写原生插件 | P1 前评估 |
| 7 | 转 public 不可逆 | 一旦转公开无法回退 | 先 private 长期跑通再决定 |

---

## 7. 待拍板

1. **范围**：只做 APK 的 OAuth 直连（PWA 保持网关）—— 建议；还是 PWA 也必须要（那就得接受转发服务）。
2. **令牌管理范围**：只做账户级 token —— 建议；用户级大概率无官方支持。
3. **client 可见性**：先 private（无需域名验证、可长期自用）；确认稳定后再评估转 public（不可逆 + 需 DNS TXT 验证）。

---

## 9. 实施记录（2026-10-21，代码已落地，待真机验证）

> 状态说明：**代码路径与类型检查已通过，OAuth 与令牌创建均未经过真机端到端验证** ——
> 缺真实 `client_id`、缺在 CF 后台登记 redirect、缺装机实测。按「不能凭感觉」的口径，
> 在 P0 跑完之前，这两项只能算「已实现」，不能算「已完成」。

### 9.1 落地文件

| 文件 | 作用 |
| --- | --- |
| `app/console/src/lib/secure-store.ts` | 系统钥匙串抽象；Android 走 `@aparajita/capacitor-secure-storage`（Keystore），网页回退 localStorage（OAuth 在网页不可用） |
| `app/console/src/lib/oauth.ts` | PKCE S256、系统浏览器授权、`cfconsole://oauth/callback` 回调、换 token、按 credRef 串行刷新、撤销 |
| `app/console/src/lib/accounts.ts` | 账号新增 `auth` / `credRef`；OAuth 账号 `token` 恒空，长期凭据不进账号列表 |
| `app/console/src/lib/api.ts` | `directCtx` 改异步：OAuth 账号先取（必要时刷新）access token；网关模式对 OAuth 账号直接报错 |
| `app/console/src/lib/direct.ts` | 账户级令牌 5 个端点 + 本地校验（资源键、权限组 id、到期时间） |
| `app/console/src/views/TokensView.vue` | 令牌列表 / 创建 / 轮转 / 删除；明文只显示一次；建/删/轮转受本机写开关管辖 |
| `app/console/src/views/SettingsView.vue` | OAuth 登录卡片（client_id / redirect_uri / scope 本机可改）+ 多账号候选选择 |
| `.github/workflows/cf-console-build.yml` | `cap sync` 后注入 `cfconsole://oauth` intent-filter；`CF_OAUTH_*` 走仓库变量 |

### 9.2 与计划稿的偏差（按更严的执行）

1. **令牌管理不进网关**：OAuth 凭据只在钥匙串，网关拿不到也不该拿。网页模式下该屏只给说明。
2. **一次授权 = 一个账号**：多账号即多次授权；等 P0-10 证明「一个 token 可跨账号」后再考虑合并凭据。
3. **资源形状两种都收**：官方 Create Token 示例是扁平 `{"com.cloudflare.api.account.zone.<id>": "*"}`，
   而 schema 写 `map[string] or map[map[string]]`；早前只放行嵌套会把官方示例直接 422 掉。

### 9.3 仍需真机消掉的项

- OAuth：授权回跳、`expires_in`、是否返回 `refresh_token`（需 `offline_access`）、refresh 是否轮换。
- 令牌管理：`account_api_tokens:*` 是否可申请、`POST/GET /accounts/{id}/tokens` 与 `permission_groups` 是否可用。
- private client 能否访问非签发账号（决定多账号是否需要转 public，不可逆）。

---

## 10. 参考

- [Create your OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Integrate your OAuth client with Cloudflare](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
- [Authorizing an application](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/)
- [Introducing self-managed OAuth clients（2026-06-03）](https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/)
- [Account members can self-serve create Account API tokens（2026-10-01）](https://developers.cloudflare.com/changelog/post/2026-10-01-account-api-token-provisioning/)
- [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
- [Create tokens via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)
- [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Optional OAuth scopes（2026-08-20）](https://developers.cloudflare.com/changelog/post/2026-08-20-oauth-optional-scopes/)
