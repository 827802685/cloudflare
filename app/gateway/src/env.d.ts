// 全局类型：Worker 绑定。不要在这个文件里 export，保持它是全局声明脚本。
interface Env {
  /**
   * 可选兜底令牌：只在客户端**没带** `x-cf-token` 时才用（给单账号自用部署省事）。
   * 多账号 / 自带令牌模式下**不需要配** —— 令牌由客户端经 HTTPS 带来，本 Worker 不留副本。
   * 配了也不会盖过客户端带来的那把：`x-cf-token` 永远优先。
   */
  CF_API_TOKEN?: string;
  /**
   * 可选默认账号：只在客户端**没带** `?account=` 时才用。
   * 带了就用客户端的（多账号切换 = 换 `?account=` + 换 `x-cf-token`）。两者都没有 → 需要账号的接口 500。
   */
  CF_ACCOUNT_ID?: string;
  /** 可选：允许接入的设备令牌，逗号分隔。只在「不在客户端存令牌」的旧模式部署里才需要 */
  DEVICE_TOKENS?: string;
  /**
   * 写路由的总闸（第一道闸门）：不是 "true" 时任何非 GET 一律 501，连白名单都不查。
   * 现网默认就是这个状态 —— 回滚方式是删掉这个 secret，不需要重新部署。
   */
  WRITE_ENABLED?: string;
  CF_BASE?: string;
}

declare const process: unknown;
