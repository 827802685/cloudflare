import { computed, reactive, ref } from "vue";

/**
 * 长列表"默认显示几条"这台旋钮。
 *
 * 以前每个屏各写各的常量（版本 10、部署 12、Pages 8、DNS 15…），
 * 想多看几条只能改代码；现在统一读这一个偏好，设置页里调，各屏立刻跟着变。
 * 只管"一行一个东西"的实体列表；每日额度那类"只留最高那条"的极值读数不归它管。
 * 0 = 全部（不折叠）。选不选得中 0 由这里管，界面只负责把话说清楚。
 */
const KEY = "cfconsole.listCount.v1";

export const LIST_PRESETS: { v: number; label: string }[] = [
  { v: 5, label: "5 条" },
  { v: 8, label: "8 条（默认）" },
  { v: 12, label: "12 条" },
  { v: 20, label: "20 条" },
  { v: 0, label: "全部" },
];

const DEFAULT = 8;

function load(): number {
  try {
    // 没存过 ≠ 存了个 0：Number(null) 正好是 0，而 0 是合法档位（全部），
    // 所以必须先判 null，否则新设备默认会变成"全部"而不是 8。
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT;
    const n = Number(raw);
    return LIST_PRESETS.some((p) => p.v === n) ? n : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** 响应式：设置页改一下，正开着的屏跟着走 */
export const listCount = ref<number>(load());

export function setListCount(n: number): void {
  listCount.value = LIST_PRESETS.some((p) => p.v === n) ? n : DEFAULT;
  try {
    localStorage.setItem(KEY, String(listCount.value));
  } catch {
    /* 隐私模式写不进去，这一档就只在本次会话生效 */
  }
}

/** 全站统一的一句折叠文案，别每屏自己发明 */
export function foldText(open: boolean, total: number): string {
  return open ? `收起（只显示前 ${listCount.value} 条）` : `展开更多（共 ${total} 条）`;
}

/**
 * 挂到任意一条列表上：src 每次重新求值（数据刷新、筛选变了都能跟上）。
 * 返回 reactive 对象，这样调用处写 `f.shown` / `f.open` 就行，不用到处 `.value`。
 * open 是"这一条列表已经点了展开"，与全局条数是两回事，别合并。
 */
export function useFold<T>(src: () => readonly T[]) {
  const open = ref(false);
  const shown = computed(() => {
    const arr = src();
    const n = listCount.value;
    return !n || open.value || arr.length <= n ? arr : arr.slice(0, n);
  });
  /** 超出这一档的条数，与"是否已点开"无关 —— 若按当前已显示条数算，点开后按钮就消失，收不回去 */
  const over = computed(() => (listCount.value ? Math.max(0, src().length - listCount.value) : 0));
  return reactive({
    open,
    shown,
    /** 0 就不该出按钮 */
    rest: over,
    label: computed(() => foldText(open.value, src().length)),
  });
}
