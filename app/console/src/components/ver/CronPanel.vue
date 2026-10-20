<script lang="ts">
/**
 * cron 触发器管理（docs/13 §6.4、§2.5「触发器」那一行）。
 * 抄竞品的三件事：列表 / 10 行预设快捷 / 「你输入的是北京时间、提交的是 UTC」这条常驻说明。
 * 不抄的一件事：它的保存只走 Toast（§8.2），我们每条结果留在屏上。
 *
 * 语义坑（必须写在界面上）：CF 这个接口是 **PUT 全量覆盖**，没有"删一条"的动词。
 * 所以"删除某个 cron"= 把剩下的列表整体 PUT 回去；界面在确认抽屉里把覆盖后的完整结果摆出来。
 * 写路由 PUT /v1/workers/:s/crons 网关还没有 → 请求真发，被拒时如实显示 kind。
 */
export default { name: "VerCronPanel" };
</script>

<script setup lang="ts">
import { computed, ref } from "vue";
import ConfirmSheet from "../ConfirmSheet.vue";
import AsyncBlock from "./AsyncBlock.vue";
import { GwError, gwWrite, setWritesOptIn, writesOptIn, type WritePreview } from "../../lib/api";
import { dt } from "../../lib/fmt";

const props = withDefaults(
  defineProps<{ name: string; crons?: any[] | null; loading?: boolean; err?: GwError | { kind?: string; message?: string } | null }>(),
  { crons: null, loading: false, err: null },
);
const emit = defineEmits<{ (e: "retry"): void; (e: "changed"): void }>();

/** 竞品的 10 行预设（`WorkerFragment.kt:2244-2255`），这里按"北京时间语义 → UTC cron"重算了一遍 */
const PRESETS: { cn: string; cron: string; how: string }[] = [
  { cn: "每 5 分钟", cron: "*/5 * * * *", how: "分钟步长与时区无关" },
  { cn: "每 15 分钟", cron: "*/15 * * * *", how: "同上" },
  { cn: "每 20 分钟", cron: "*/20 * * * *", how: "账号里现在就是这条" },
  { cn: "每 30 分钟", cron: "*/30 * * * *", how: "同上" },
  { cn: "每小时整点", cron: "0 * * * *", how: "同上" },
  { cn: "每天 北京 08:00", cron: "0 0 * * *", how: "北京 08:00 = UTC 00:00" },
  { cn: "每天 北京 12:00", cron: "0 4 * * *", how: "北京 12:00 = UTC 04:00" },
  { cn: "每天 北京 19:30", cron: "30 11 * * *", how: "北京 19:30 = UTC 11:30" },
  { cn: "工作日 北京 09:00", cron: "0 1 * * 1-5", how: "北京 09:00 = UTC 01:00，同一自然日，星期不变" },
  { cn: "每周日 北京 10:00", cron: "0 2 * * 0", how: "北京 10:00 = UTC 02:00，仍在周日" },
];

/**
 * 「按北京时间生成」那三格：时 + 分 + 频率。换算固定 UTC-8，跨年/跨月的表达不在这个范围里，
 * 所以频率只给"每天 / 某个星期几 / 工作日"三种，其它一律不假装支持（红线三）。
 */
const bjHour = ref(8);
const bjMinute = ref(0);
const bjWhen = ref<"daily" | "weekday" | "sun" | "mon">("daily");
function buildFromBeijing(): string {
  const h = Math.min(23, Math.max(0, Math.floor(Number(bjHour.value) || 0)));
  const m = Math.min(59, Math.max(0, Math.floor(Number(bjMinute.value) || 0)));
  const utcH = (h + 24 - 8) % 24;
  if (bjWhen.value === "weekday") return `${m} ${utcH} * * 1-5`;
  if (bjWhen.value === "sun") return `${m} ${utcH} * * 0`;
  if (bjWhen.value === "mon") return `${m} ${utcH} * * 1`;
  return `${m} ${utcH} * * *`;
}
const builtHint = computed(() => `换算结果（UTC）：${buildFromBeijing()} —— 提交的就是这一串`);

/* ---------- 校验：空值与非法形状都报错，不静默改值（竞品 TTL 静默当 1 是反面样本） ---------- */
const input = ref("");
const inputErr = ref("");
const FIELD_RE = /^[0-9*]+(\/[0-9]+)?(-[0-9]+)?(,[0-9]+(-[0-9]+)?(\/[0-9]+)?)*$/;
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function validateCron(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return "cron 不能为空（竞品这里是 Toast 一闪而过，我们停在行上）";
  const parts = s.split(" ");
  if (parts.length !== 5) return `要 5 个字段（分 时 日 月 周），现在是 ${parts.length} 个：${s}`;
  for (let i = 0; i < 5; i++) {
    const f = parts[i];
    if (!FIELD_RE.test(f)) return `第 ${i + 1} 个字段「${f}」形状不认识，只支持数字、* 、步长 /n、区间 a-b、逗号列表`;
    if (f === "*") continue;
    for (const seg of f.split(",")) {
      const base = seg.split("/")[0];
      if (base === "*") continue;
      for (const num of base.split("-")) {
        const n = Number(num);
        const [lo, hi] = RANGES[i];
        if (!Number.isInteger(n) || n < lo || n > hi) return `第 ${i + 1} 个字段「${seg}」超出范围 ${lo}-${hi}`;
      }
    }
  }
  return "";
}

const existing = computed<string[]>(() => (props.crons ?? []).map((c: any) => String(c?.cron ?? "")).filter(Boolean));

const addErr = ref("");
async function tryAdd() {
  inputErr.value = "";
  addErr.value = "";
  const bad = validateCron(input.value);
  if (bad) { inputErr.value = bad; return; }
  const cron = input.value.trim().replace(/\s+/g, " ");
  if (existing.value.includes(cron)) { inputErr.value = `这一条已经在列表里了：${cron}`; return; }
  ask({ next: [...existing.value, cron], title: "新增 cron 触发器", desc: `将新增：${cron}` });
}
function applyPreset(p: { cron: string; cn: string }) {
  inputErr.value = "";
  if (existing.value.includes(p.cron)) { inputErr.value = `这一条已经在了：${p.cron}（${p.cn}）`; return; }
  input.value = p.cron;
  ask({ next: [...existing.value, p.cron], title: "用预设新增触发器", desc: `将新增：${p.cron}（${p.cn}）` });
}
function askRemove(cron: string) {
  ask({ next: existing.value.filter((c) => c !== cron), title: "删除 cron 触发器", desc: `将移除：${cron}` });
}

/* ---------- 写侧：PUT 全量覆盖 ---------- */
const preview = ref<WritePreview | null>(null);
const busy = ref(false);
const sheetErr = ref("");
const log = ref<{ text: string; ok: boolean }[]>([]);
const pending = ref<string[] | null>(null);
const optIn = ref(writesOptIn());
function toggleOptIn(v: boolean) {
  setWritesOptIn(v);
  optIn.value = writesOptIn();
}

function ask(a: { next: string[]; title: string; desc: string }) {
  pending.value = a.next;
  sheetErr.value = "";
  preview.value = {
    method: "PUT",
    path: `/v1/workers/${encodeURIComponent(props.name)}/crons`,
    body: { schedules: a.next.map((c) => ({ cron: c })) },
    title: a.title,
    lines: [
      { k: "Worker", v: props.name },
      { k: a.next.length > existing.value.length ? "新增" : "移除", v: a.desc },
      { k: "覆盖后完整列表", v: a.next.length ? a.next.join(" ｜ ") : "空（这个 Worker 将没有任何定时触发）" },
      { k: "语义", v: "CF 这个接口是 PUT 全量覆盖，没有「单条删除」的动词 —— 上面这份列表会整体替换现有配置" },
      { k: "时区", v: "提交的是 UTC；界面按 UTC+8（北京）理解你的输入" },
      { k: "路由状态", v: "上游形状 2026-10-19 实测（crons 原样回写 200）：上游是 PUT schedules 裸数组 [{cron}]，包 {schedules:…} 信封会被 400 —— 拆包在两层里做，客户端只发 {schedules:[{cron}]}" },
    ],
    danger: "normal",
  };
}

async function confirmWrite() {
  const next = pending.value;
  const p = preview.value;
  if (!next || !p || busy.value) return;
  busy.value = true;
  sheetErr.value = "";
  try {
    // 真的 await 到底：竞品那种 delay(500) 再弹成功 Toast 的写法不能要（docs/13 §8.2）
    await gwWrite(p.method, p.path, p.body);
    log.value.unshift({ text: `已提交 ${next.length} 条 cron（网关确认 200）`, ok: true });
    preview.value = null;
    pending.value = null;
    input.value = "";
    emit("changed");
  } catch (e) {
    const g = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
    const text = `提交失败 · kind=${g.kind}${g.code ? " · code=" + g.code : ""} · ${g.message}`;
    sheetErr.value = `${text}\n${g.hint}`;
    log.value.unshift({ text, ok: false });
  } finally {
    busy.value = false;
  }
}
function cancelWrite() {
  preview.value = null;
  pending.value = null;
  sheetErr.value = "";
}

function dash(v: unknown) {
  return v === undefined || v === null || v === "" ? "—" : String(v);
}
</script>

<template>
  <div class="cron">
    <div class="switchline">
      <label class="row" style="gap: 6px">
        <input type="checkbox" class="switch" :checked="optIn" @change="toggleOptIn(($event.target as HTMLInputElement).checked)" />
        <span>本机写开关：{{ optIn ? "已打开" : "未打开" }}</span>
      </label>
      <span class="small muted">定时触发按 <b>UTC</b> 执行；这一屏所有输入都按 <b>UTC+8（北京）</b> 理解、提交前换算成 UTC。</span>
    </div>

    <AsyncBlock :loading="loading" :err="err" :has="(crons ?? []).length > 0" empty-text="当前没有任何 cron 触发（接口返回空列表）" @retry="emit('retry')">
      <div class="list">
        <div v-for="c in crons ?? []" :key="String(c?.cron)" class="item">
          <div style="min-width: 0">
            <div class="k mono">{{ dash(c?.cron) }}</div>
            <div class="small muted">建立 {{ dt(c?.created_on) }} · 改动 {{ dt(c?.modified_on) }}</div>
          </div>
          <div class="v"><button class="ghost sm danger" type="button" @click="askRemove(String(c?.cron))">删除</button></div>
        </div>
      </div>
    </AsyncBlock>

    <h4 class="ttl">10 行预设（点击即走确认抽屉）</h4>
    <div class="presets">
      <button v-for="p in PRESETS" :key="p.cron" class="chip" type="button" :title="p.how" @click="applyPreset(p)">{{ p.cn }}<span class="mono pc"> {{ p.cron }}</span></button>
    </div>

    <h4 class="ttl">按北京时间生成</h4>
    <div class="row gen">
      <select v-model="bjWhen" class="field">
        <option value="daily">每天</option>
        <option value="weekday">工作日</option>
        <option value="mon">每周一</option>
        <option value="sun">每周日</option>
      </select>
      <input v-model.number="bjHour" class="field hh" type="number" min="0" max="23" aria-label="北京时间 时" />
      <span class="muted">:</span>
      <input v-model.number="bjMinute" class="field hh" type="number" min="0" max="59" aria-label="北京时间 分" />
      <button class="chip" type="button" @click="input = buildFromBeijing(); inputErr = ''">填进输入框</button>
    </div>
    <p class="small muted">{{ builtHint }}</p>

    <h4 class="ttl">直接写 cron（UTC 五字段）</h4>
    <div class="row">
      <input v-model="input" class="field" placeholder="例如 0 3 * * *" spellcheck="false" @keyup.enter="tryAdd" />
      <button class="ghost" type="button" @click="tryAdd">新增</button>
    </div>
    <p class="small errtext" v-if="inputErr">{{ inputErr }}</p>

    <div class="log" v-if="log.length">
      <div class="small muted">提交结果：</div>
      <div v-for="(l, i) in log" :key="i" :class="l.ok ? 'ok' : 'no'">{{ l.text }}</div>
    </div>

    <p class="small muted">
      CF 对单个脚本的 cron 条数有上限，但那个上限跟套餐走、本项目没实测过（docs/09），所以这里不做本地拦截，超出时以网关返回的错误为准。
    </p>

    <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="confirmWrite" @cancel="cancelWrite" />
  </div>
</template>

<style scoped>
.cron { display: flex; flex-direction: column; gap: 9px; }
.switchline { display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-2); }
.ttl { margin: 10px 0 0; font-size: 12px; color: var(--muted); font-weight: 600; }
.presets { display: flex; flex-wrap: wrap; gap: 6px; }
.pc { color: var(--muted); font-size: 11px; margin-left: 4px; }
.gen .field { max-width: 110px; }
.gen .hh { max-width: 62px; text-align: center; }
.mono { font-family: var(--font-num); }
.errtext { color: var(--bad); }
button.sm { padding: 4px 10px; font-size: 12px; }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.log { display: flex; flex-direction: column; gap: 3px; }
.log .ok { color: var(--ok); font-size: 12px; }
.log .no { color: var(--bad); font-size: 12px; word-break: break-all; }
</style>
