import { ref } from "vue";

/**
 * 顶栏「刷新当前屏」的总线（2026-10-25 加）。
 *
 * 为什么不在顶栏直接调 refresh：每屏要刷的数据集完全不同 —— 看板一条 overview、
 * Worker 详情九段、计算页三个列表，顶栏没有资格知道这些。所以顶栏只表达"请求一次刷新"，
 * 怎么刷由屏自己决定：各屏 watch 这个计数，调自己的 refresh()。
 *
 * 这样原来每屏右上角那个「刷新」按钮就可以收掉（6 个合成 1 个），
 * 而"刷新"这个动作的语义（是否破缓存、动几个请求）仍留在各屏里，不被抹平。
 */
export const reloadTick = ref(0);

/** 顶栏刷新键的转圈态。由 requestReload 自动开、600ms 后自动落回——
 *  各屏刷新快慢不一，不做"等所有屏回传"的握手（那要么加协议、要么卡死按钮）。 */
export const reloading = ref(false);
let spinTimer: ReturnType<typeof setTimeout> | null = null;

export function requestReload(): void {
  reloadTick.value++;
  reloading.value = true;
  if (spinTimer) clearTimeout(spinTimer);
  spinTimer = setTimeout(() => { reloading.value = false; }, 600);
}
