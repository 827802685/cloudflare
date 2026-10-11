import { computed, ref, type ComputedRef, type Ref } from "vue";
import { GwError, gwMeta, MEM_TTL_MS, type ErrKind } from "../lib/api";

/* ============================================================================
 * 三态容器契约（docs/13 §1.3「异步拉详情 = 先加载态、数据回来原地替换」+ §7.3
 * 「loading / error / content 三态互斥」），并且把两种"看起来都是空"拆开：
 *
 *   loading  取数中（请求在路上）
 *   error    没取到（err.kind 决定处置方式：auth 去设置页、planLimit 灰掉，等等）
 *   empty    取到了，而且确实为空（接口 200 但列表长度 0）
 *   content  取到了且有内容
 *   stale    有内容，但已超过 MEM_TTL_MS —— 不是新状态，是内容态上的一个角标，
 *            界面要能说"这是 X 分钟前的数据"，而不是悄悄把它当新的展示
 *
 * 四者不能混：把 empty 显示成 0、把 stale 显示成实时、把 error 说成"空目录"，
 * 都是 docs/09 §E16 那一类撒谎。
 * ========================================================================== */

/**
 * "取到了，但内容为空"的判定。null/undefined 不算空 —— 那是"没取到/还没取"，
 * 由 loading / error 负责，绝不让 empty 冒充它们。
 * 认三种常见包装：裸数组、CF 信封 {result:[...]}、Analytics 信封 {rows:[...]}。
 */
export function isEmptyValue(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.result)) return o.result.length === 0;
    if (Array.isArray(o.rows)) return o.rows.length === 0;
    return Object.keys(o).length === 0;
  }
  return false; // 数字/字符串永远"有内容"；0 不是 empty
}

/**
 * 全局心跳：stale / ageMs 必须真的会走。用求值时刻算出来的"多少分钟前"若不接心跳，
 * 会冻在首次渲染那一秒（BoardView 踩过，见其 clock 注释）。10 秒一跳足够人眼精度。
 */
const heartbeat = ref(Date.now());
let hbTimer: ReturnType<typeof setInterval> | null = null;
function ensureHeartbeat() {
  if (hbTimer === null && typeof setInterval !== "undefined") {
    hbTimer = setInterval(() => (heartbeat.value = Date.now()), 10_000);
  }
}

/* 同一 key 的并发加载共享同一个 in-flight Promise：一轮里两处同时要 workers()，
 * 只发一条网关请求。key 用「数据身份」（endpoint+参数），不要用组件实例。 */
const inflight = new Map<string, Promise<unknown>>();
export function sharedLoad<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const live = inflight.get(key);
  if (live) return live as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export interface Loader<T> {
  data: Ref<T | null>;
  err: Ref<GwError | null>;
  loading: Ref<boolean>;
  run: () => Promise<void>;
  /** 本轮成功取值后 gwMeta 的快照：数据真正被取的时刻（x-gw-fetched-at 口径），0 = 还没取到过 */
  fetchedAt: Ref<number>;
  /** 距今多久（响应式，10 秒一跳）；没取到过是 Infinity */
  ageMs: ComputedRef<number>;
  /** 取到了、没失败、但内容为空 —— 「确实为空」，不是「没取到」 */
  empty: ComputedRef<boolean>;
  /** 有值但已超过 TTL —— 界面该说"这是几分钟前的旧数据" */
  stale: ComputedRef<boolean>;
  /** 三态容器的单选态：loading / error / empty / content / idle（idle = 还没发起过） */
  uiState: ComputedRef<"idle" | "loading" | "error" | "empty" | "content">;
}

/**
 * 每个界面都用同一套"加载中 / 失败 / 空"三态，避免各处手写 try/catch 走形。
 * err 保留 GwError 实例，ErrorNote 要靠 kind 决定语气和文案。
 *
 * opts.shareKey：给了就走 in-flight 合并（同 key 并发只发一条）；不给保持逐次独立调用，
 * 与改造前行为完全一致 —— 现有调用点一个都不用动。
 */
export function useLoad<T>(fn: () => Promise<T>, opts?: { shareKey?: string; ttlMs?: number }): Loader<T> {
  ensureHeartbeat();
  const ttl = opts?.ttlMs ?? MEM_TTL_MS;
  const data = ref<T | null>(null) as Ref<T | null>;
  const err = ref<GwError | null>(null);
  const loading = ref(false);
  const fetchedAt = ref(0);
  const run = async () => {
    loading.value = true;
    err.value = null;
    try {
      const call = async () => {
        // 先记下发起时刻：gw() 若命中本机内存缓存，gwMeta.fetchedAt 会被写成缓存条目的旧时刻，
        // 这正是"这是几分钟前的数据"的来源；若是网络路径，响应回来时 gwMeta 已被就地刷新。
        data.value = opts?.shareKey ? (await sharedLoad(opts.shareKey, fn)) : await fn();
        fetchedAt.value = gwMeta.fetchedAt || Date.now();
      };
      await call();
    } catch (e) {
      err.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e));
    } finally {
      loading.value = false;
    }
  };
  const ageMs = computed(() => (fetchedAt.value ? Math.max(0, heartbeat.value - fetchedAt.value) : Number.POSITIVE_INFINITY));
  const empty = computed(() => !loading.value && !err.value && data.value !== null && isEmptyValue(data.value));
  const stale = computed(() => !loading.value && data.value !== null && ageMs.value >= ttl);
  const uiState = computed<Loader<T>["uiState"]["value"]>(() => {
    if (loading.value) return "loading";
    if (err.value) return "error";
    if (data.value === null) return "idle";
    return empty.value ? "empty" : "content";
  });
  return { data, err, loading, run, fetchedAt, ageMs, empty, stale, uiState };
}

/** 多块并行加载：一块失败不能拖累别的块（对应网关 overview 的 allSettled 思路） */
export function useParallel(fns: Record<string, () => Promise<unknown>>, opts?: { ttlMs?: number }) {
  ensureHeartbeat();
  const ttl = opts?.ttlMs ?? MEM_TTL_MS;
  interface Block {
    loading: boolean;
    err: GwError | null;
    /** 失败原因归类（GwError.kind），界面按它决定"去设置页"还是"这块灰掉"；没失败是 null */
    kind: ErrKind | null;
    /** 成功取到的值（原先被丢弃，empty 判定要用） */
    value: unknown;
    has: boolean;
    /** 取到值的真实时刻；0 = 这块还没成功取到过 */
    at: number;
  }
  const blank = (): Block => ({ loading: false, err: null, kind: null, value: null, has: false, at: 0 });
  const states = ref<Record<string, Block>>({});
  for (const k of Object.keys(fns)) states.value[k] = blank();
  const run = async () => {
    await Promise.allSettled(
      Object.entries(fns).map(async ([k, f]) => {
        states.value[k] = { ...states.value[k], loading: true, err: null, kind: null };
        try {
          const v = await sharedLoad("parallel:" + k, f);
          // 见 stores/gateway.ts 同款说明：await 恢复的微任务里读 gwMeta，拿到的就是本条响应的落点
          states.value[k] = { loading: false, err: null, kind: null, value: v, has: true, at: gwMeta.fetchedAt || Date.now() };
        } catch (e) {
          const ge = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
          states.value[k] = { ...states.value[k], loading: false, err: ge, kind: ge.kind };
        }
      }),
    );
  };
  /** 单块的四态：与 useLoad.uiState 同一套词汇，界面组件可以共用 */
  const blockState = (k: string): "idle" | "loading" | "error" | "empty" | "content" => {
    const b = states.value[k];
    if (!b || b.loading) return b ? "loading" : "idle";
    if (b.err) return "error";
    if (!b.has) return "idle";
    return isEmptyValue(b.value) ? "empty" : "content";
  };
  const blockStale = (k: string): boolean => {
    const b = states.value[k];
    return !!b && b.has && b.at > 0 && heartbeat.value - b.at >= ttl;
  };
  const blockAgeMs = (k: string): number => {
    const b = states.value[k];
    return b && b.at ? Math.max(0, heartbeat.value - b.at) : Number.POSITIVE_INFINITY;
  };
  return { states, run, blockState, blockStale, blockAgeMs };
}
