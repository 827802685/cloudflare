// 全局类型：Worker 绑定。不要在这个文件里 export，保持它是全局声明脚本。
interface Env {
  /** CF API 令牌：只存在 Worker secret 里（wrangler secret put），绝不进仓库/前端 */
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  /** 允许接入的设备令牌，逗号分隔；手机侧只持有它，永远拿不到 CF 令牌 */
  DEVICE_TOKENS: string;
  /**
   * 写路由的总闸（第一道闸门）：不是 "true" 时任何非 GET 一律 501，连白名单都不查。
   * 现网默认就是这个状态 —— 回滚方式是删掉这个 secret，不需要重新部署。
   */
  WRITE_ENABLED?: string;
  CF_BASE?: string;
}

declare const process: unknown;
