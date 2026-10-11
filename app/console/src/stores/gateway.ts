import { defineStore } from "pinia";
import { watch } from "vue";
import { api, gwAgeMs, gwMeta, MEM_TTL_MS, forceFreshWindow } from "../lib/api";
import { sharedLoad } from "../composables/useLoad";
import { loadConfig, saveConfig, type Config } from "../lib/config";

/**
 * 刷新协调器（用户原话的落地）：「降低网关对 cf 的请求次数，改成进 app 一次 + 每格 5 分钟
 * 请求一次，能合并的请求也一起合并了」。
 *
 * 分层不动：api.ts 的 5 分钟内存缓存、网关的只读缓存与 inflight 合并都已在，
 * 这里只补调度层，规则是：
 *  1. 进 App 拉一轮（限"列表级"数据集：看板 + Workers/Pages/域名 三个列表），之后每 5 分钟一轮；
 *  2. 一轮内每个数据集经 sharedLoad 合并 —— 同轮并发只要同 key，就只发一条网关请求；
 *     各屏 onMounted 的自取请求落在 api.ts 内存缓存上：调度轮把数据焐热后，
 *     屏来回切换命中 local（0 条出网请求），这就是"切回来不发请求"的机制；
 *  3. 后台标签页（document.hidden）定时器到点直接跳过，不打网关；回前台只有整轮已过期才补一轮
 *     —— 用 lastRoundAt 判，而不是"醒来就打"；
 *  4. 账目：每条任务完成后读 gwMeta（gw() 在响应落地时同步写它，await 恢复的微任务里读到
 *     的就是本条的落点），state=local → 本机缓存、没出网；否则网关请求 +1，cfCalls 累加
 *     响应头 x-gw-cf-calls 报的次数。设置页显示的就是这份账 —— "请求降下来了"要有数字依据。
 *     口径如实限定：只统计调度器发出的请求；详情页/手动刷新不经调度器，不进这份账，
 *     但它们同样被两层缓存拦着（界面文案里写清了这一点）。
 */

/** 一轮拉哪些数据集：只列"进 App 一定会被某个屏用到"的列表级端点，详情类（按 id）进不了预热情景 */
const ROUND_JOBS: { key: string; run: () => Promise<unknown> }[] = [
  { key: "overview:7d", run: () => api.overview("7d") },   // 看板默认 range；网关内部已把 3 条 CF 合成 1 条请求
  { key: "workers", run: () => api.workers() },
  { key: "pages", run: () => api.pages() },
  { key: "domains", run: () => api.domains() },
  { key: "zones", run: () => api.zones() },
];

export interface RoundStats {
  /** 真的发到网关的请求条数（命中本机内存缓存的不计） */
  requests: number;
  /** 命中本机 5 分钟缓存、一条网关请求都没发的任务数 */
  localHits: number;
  /** 这些网关请求内部实际打了 api.cloudflare.com 的次数（响应头 x-gw-cf-calls 累加） */
  cfCalls: number;
  /** 失败的任务块数（一块失败不拖别的块） */
  errors: number;
}
const zero = (): RoundStats => ({ requests: 0, localHits: 0, cfCalls: 0, errors: 0 });

let timer: ReturnType<typeof setInterval> | null = null;
let attached = false;

export const useGatewayStore = defineStore("gateway", {
  state: (): {
    config: Config;
    lastOkAt: number;
    budget: {
      rounds: number;
      lastRoundAt: number;
      lastRoundDoneAt: number;
      last: RoundStats;
      total: RoundStats;
      running: boolean;
    };
  } => {
    // App.vue 在任何路由下都会实例化这个 store，所以这里就是"进 App"这个钩子；
    // 微任务里再挂，是为了等 pinia 实例化走完（state() 执行时 this 还不可用）。
    if (!attached) {
      queueMicrotask(() => {
        try { useGatewayStore().attachScheduler(); } catch { /* 无 app 上下文（单测）时不硬挂 */ }
      });
    }
    return {
      config: loadConfig(),
      lastOkAt: 0,
      budget: { rounds: 0, lastRoundAt: 0, lastRoundDoneAt: 0, last: zero(), total: zero(), running: false },
    };
  },
  getters: {
    /** 没设备令牌就别发请求了，直接引导去设置页；否则每个界面都会 401 刷屏 */
    configured: (s) => s.config.deviceToken.length > 0,
    /** 最近一次经手数据距今多久；Infinity = 这台设备还没取到过（界面不能说"0 秒前"） */
    dataAgeMs: () => gwAgeMs(),
    stale: () => gwAgeMs() >= MEM_TTL_MS,
    /** 设置页的诚实文案：下一轮大概什么时候（后台挂起时给"回前台时按需补"） */
    nextRoundNote: (s) => {
      if (!s.budget.lastRoundAt) return "还没跑过第一轮";
      const next = s.budget.lastRoundAt + MEM_TTL_MS;
      return next <= Date.now() ? "已到期（切回前台即补一轮）" : new Date(next).toLocaleTimeString();
    },
  },
  actions: {
    save(next: Partial<Config>) {
      this.config = saveConfig({ ...this.config, ...next });
      // 第一次把令牌填进来 = App 现在"有资格"取数了：挂上调度器并马上走一轮，别等 5 分钟
      if (this.configured) {
        this.attachScheduler();
        void this.round();
      }
    },
    reload() {
      this.config = loadConfig();
    },
    pinged() {
      this.lastOkAt = Date.now();
    },

    attachScheduler() {
      if (attached) return;
      attached = true;
      if (typeof setInterval !== "undefined") {
        timer = setInterval(() => {
          if (typeof document !== "undefined" && document.hidden) return; // 后台标签页不打网关
          void this.round();
        }, MEM_TTL_MS);
      }
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) return;
          // 回前台：只有整轮已过期才补；新鲜期内的回前台一条请求都不发（屏那边靠内存缓存直接出图）
          if (!this.budget.lastRoundAt || Date.now() - this.budget.lastRoundAt >= MEM_TTL_MS) void this.round();
        });
      }
      // 进 App 的第一轮刻意**延后**到首屏自己的请求落地之后再发（或 3 秒兜底）：
      // gw() 没有 in-flight 去重（不许改它），若首轮与首屏挂载请求同时出发，同一份 overview 会打到网关两次。
      // 等落地一个数据点，首轮对首屏那份就变成本机缓存命中（local），重复的那条自然省掉。
      let started = false;
      let stopWait: (() => void) | null = null;
      const kick = () => {
        if (started) return;
        started = true;
        if (stopWait) stopWait();
        void this.round();
      };
      if (gwMeta.fetchedAt) {
        kick(); // 已经有数据（比如刚在设置页测过连接），不必再等
      } else {
        const stopWatch = watch(() => gwMeta.fetchedAt, (v) => { if (v) kick(); });
        const fallback = setTimeout(kick, 3000);
        stopWait = () => { stopWatch(); clearTimeout(fallback); };
      }
    },

    /**
     * 走一轮。running 互斥（同一时刻只有一轮在打）；距上轮不足 TTL 直接跳过（除非 force）。
     * 返回是否真的跑了，调用方（设置页按钮）据此说实话。
     */
    async round(opts?: { force?: boolean }): Promise<boolean> {
      if (!this.configured || this.budget.running) return false;
      const startedAt = Date.now();
      if (!opts?.force && this.budget.lastRoundAt && startedAt - this.budget.lastRoundAt < MEM_TTL_MS) return false;
      this.budget.running = true;
      const s = zero();
      try {
        await Promise.allSettled(
          ROUND_JOBS.map((j) =>
            sharedLoad("round:" + j.key, async () => {
              try {
                await j.run();
                if (gwMeta.state === "local") s.localHits++;
                else { s.requests++; s.cfCalls += gwMeta.cfCalls; }
              } catch (e) {
                s.errors++;
                throw e;
              }
            }),
          ),
        );
      } finally {
        const t = this.budget.total;
        this.budget.rounds++;
        this.budget.lastRoundAt = startedAt;
        this.budget.lastRoundDoneAt = Date.now();
        this.budget.last = s;
        this.budget.total = { requests: t.requests + s.requests, localHits: t.localHits + s.localHits, cfCalls: t.cfCalls + s.cfCalls, errors: t.errors + s.errors };
        this.budget.running = false;
      }
      return true;
    },

    /** 设置页「立刻走一轮」：走缓存语义（新鲜任务会 local 命中），几乎不出网 */
    roundNow(): Promise<boolean> {
      return this.round({ force: false });
    },
    /** 设置页「强制新取一轮」：破两层缓存，会真的打网关与 CF —— 按钮文案必须写明 */
    roundForceFresh(): Promise<boolean> {
      forceFreshWindow();
      return this.round({ force: true });
    },
  },
});
