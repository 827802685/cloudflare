# CF 控制台（cloudflare）

自建 Cloudflare 第三方客户端：一个 Vue 3 单页应用，可打包成安卓 APK。
**APK 是纯直连模式 —— 粘一把 Cloudflare API Token 就能用，不需要部署任何服务。**

## 功能一览

- **看板**：流量总览 / 趋势曲线 / 状态码 / 国家分布 / Top 主机 / 环比
- **计算**：Workers 版本与部署历史、今日用量、自定义域名
- **域名**：Zone 状态、DNS 记录增删改（逐条回显确认）、WAF 规则、缓存清理
- **数据库**：D1（只读 SQL 查询）/ KV / R2
- **Zero Trust**：Access 应用 / 组 / 策略（只读）
- **多账号**：一个账号一把令牌，可切换、可并存

所有 API 路径白名单写死、逐字段校验，不是通用透传；错误按 63 次实测的错误码归并成人类可读的提示（详见 `docs/05`、`docs/06`）。

## 两种使用方式

| | APK（推荐） | 网页 / PWA |
|---|---|---|
| 连接方式 | 直连 `api.cloudflare.com` | 需先部署 `app/gateway`（CF 官方 API 无 CORS，浏览器直连不通） |
| 需要部署 | **无** | 一个 Cloudflare Worker |
| 使用步骤 | 设置 → 粘贴 API Token → 即用 | 部署网关 → 设置页填地址和设备令牌 → 再加账号令牌 |
| 令牌存储 | 本机随机密钥自动加密（AES-256-GCM，无口令） | 口令派生密钥加密（PBKDF2 + AES-256-GCM） |

## 快速开始（APK）

1. 从 [Releases](https://github.com/827802685/cloudflare/releases) 下载 APK 装上（或自己在 Actions 里构建）
2. 设置 → 粘贴一把 Cloudflare API Token（应用会拿它问一次 `/accounts` 验证并自动发现账号）
3. 完成。数据直连 Cloudflare，不经任何中间服务

**令牌权限建议**：按需最小化。只看数据给 `Account:Read` + 各资源的 Read；要改 DNS 再加 `DNS:Edit`。完整权限边界清单见 [docs/05-令牌权限边界.md](docs/05-令牌权限边界.md)。**不要用 Global API Key。**

## 构建

**GitHub Actions（最省事）**：Actions → `cf-console-build` → Run workflow

- `build_type = debug`：调试密钥签名，产物在 run 的 Artifacts 里
- `build_type = release`：用仓库 secrets 里的密钥签名，可发布成 Release 公开下载

**本地**：

```bash
cd app/console
npm ci
npm run build          # 类型检查 + 静态包
npx cap add android    # 生成 Android 工程（首次）
npx cap sync android
cd android && ./gradlew assembleDebug
```

## 网页 / PWA 模式

需要先部署网关（`app/gateway`，一条 Hono 路由白名单 Worker）：

```bash
cd app/gateway
npx wrangler deploy
```

然后把 `app/console/dist` 挂到同域（或任意静态托管），在设置页填网关地址。部署细节见 [docs/12-交付总览与完整实施计划.md](docs/12-交付总览与完整实施计划.md)。

## 安全模型（如实说明）

- **令牌是唯一凭证**：账号 ID 由令牌自动发现并逐请求校验，不是凭据
- **APK**：令牌 AES-256-GCM 加密保存，密钥首启随机生成、存于本机 —— 这道加密防「翻应用文件」，密钥与密文同在本机，防不住「整库拖走」；配合手机锁屏与最小权限使用
- **网页**：口令派生密钥加密，口令不落盘，拖走 localStorage 也解不开
- **网关**：只转发白名单路由，不留令牌副本；写操作有本机 + 网关两道开关，默认全关

## 文档

`docs/` 目录是完整的实测档案：API 流量分析、令牌权限边界、架构选型、竞品对照、风险清单等 16 篇。想理解「为什么这么设计」，从 [00-可行性实测报告.md](docs/00-可行性实测报告.md) 和 [06-架构方案与技术选型.md](docs/06-架构方案与技术选型.md) 开始。

## License

见 [LICENSE](LICENSE)。
