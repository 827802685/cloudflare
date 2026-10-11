<script lang="ts">
/**
 * DNS 记录的类型驱动表单（新增 / 编辑）。docs/13 §6.16 + §5.3。
 *
 * 为什么单独成文件而不是塞进 DomainsView：切换类型时整块字段区要重建，
 * 这块的显隐规则（代理开关只对可代理类型出现、MX/SRV 才有优先级、TTL 两态）比列表本身复杂得多，
 * 混在一起没人读得动。这里只负责「把表单填成一条 DnsRecordInput + 生成 WritePreview」，
 * 真正发请求、开 ConfirmSheet、写完后 dropMem 重取列表都交给父级（DomainsView）。
 *
 * 与竞品的两处刻意不同（docs/13 §8.2 点名的反面样本）：
 *  1. TTL 非 1 且不在 120–172800 → 当场报错，绝不静默改成 1。
 *  2. 「可代理与否」优先读接口给的 proxiable 字段，比按类型硬判更准（竞品是硬判）。
 *     proxiable 只会「取消」代理资格（如 apex 上的 CNAME 不能代理），不会凭字段放行非 A/AAAA/CNAME。
 */
export default { name: "DnsRecordForm" };
</script>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import ErrorNote from "../ErrorNote.vue";
import {
  DNS_TYPES,
  PROXIABLE_TYPES,
  previewDnsCreate,
  previewDnsUpdate,
  GwError,
  type DnsRecordInput,
  type WritePreview,
} from "../../lib/api";

const props = defineProps<{
  zoneId: string;
  zoneName: string;
  /** null = 新增；给了记录 = 编辑（回填字段，并用它的 proxiable/id） */
  record?: Record<string, any> | null;
  /** 新增模式下由 DNS 向导带来的预填（只有 type/name，content 仍留给人填） */
  preset?: { type?: string; name?: string } | null;
}>();

const emit = defineEmits<{
  (e: "preview", payload: { preview: WritePreview; action: { kind: "create" | "update"; input: DnsRecordInput; id?: string } }): void;
  (e: "cancel"): void;
}>();

const NEEDS_PRIORITY = new Set(["MX", "SRV"]);

/** 每类 content 的示例与提示：校验最终仍以 validateDns 为准，这里只是让人知道该填什么形状 */
const CONTENT_HINT: Record<string, { ph: string; help: string }> = {
  A: { ph: "203.0.113.10", help: "IPv4 地址" },
  AAAA: { ph: "2001:db8::1", help: "IPv6 地址" },
  CAA: { ph: '0 issue "letsencrypt.org"', help: "签发机构授权记录" },
  CERT: { ph: "1 0 0 <base64>", help: "证书数据" },
  CNAME: { ph: "target.example.com", help: "指向的域名，不能指向自己" },
  DNAME: { ph: "alias.example.com", help: "域名别名（整棵子树）" },
  DNSKEY: { ph: "256 3 13 <base64>", help: "DNSSEC 公钥" },
  DS: { ph: "key-tag algo digest-type digest", help: "DNSSEC 委托" },
  HTTPS: { ph: "1 altsvc.example.com", help: "SVCB/HTTPS 服务参数" },
  LOC: { ph: "37 44 30.552 N 121 59 0.120 W ...", help: "地理位置记录" },
  MX: { ph: "mail.example.com", help: "邮件服务器域名（下方填优先级）" },
  NS: { ph: "ns1.example.com", help: "名称服务器域名" },
  OPENPGPKEY: { ph: "<base64>", help: "OpenPGP 公钥" },
  PTR: { ph: "host.example.com", help: "反向解析目标域名" },
  SMIMEA: { ph: "usage selector matching-type <hex>", help: "S/MIME 证书关联" },
  SRV: { ph: "0 0 443 service.example.com", help: "服务定位（优先级 + 权重 + 端口 + 目标）" },
  SSHFP: { ph: "2 1 <hex>", help: "SSH 公钥指纹" },
  TLSA: { ph: "3 1 1 <hex>", help: "DANE 证书关联" },
  TXT: { ph: "v=spf1 -all", help: "任意文本，最长 450 字符/段" },
  URL: { ph: "https://example.com/target", help: "重定向地址（CNAME 拉平，不能开代理）" },
};

const editing = computed(() => !!props.record);
const orig = computed(() => props.record ?? null);
/** 新增模式下的向导预填：record 为 null 时才生效 */
const pre = computed(() => (props.record ? null : props.preset ?? null));

const f = reactive({
  type: String(orig.value?.type ?? pre.value?.type ?? "A"),
  name: String(orig.value?.name ?? pre.value?.name ?? ""),
  content: String(orig.value?.content ?? ""),
  priority: orig.value?.priority === undefined || orig.value?.priority === null ? "" : String(orig.value.priority),
  comment: String(orig.value?.comment ?? ""),
});

/** TTL 两态：自动(1) / 手动秒数。竞品的坑是把非数字静默当 1，我们绝不做 */
const ttlAuto = ref(Number(orig.value?.ttl ?? 1) === 1);
const ttlManual = ref(Number(orig.value?.ttl ?? 120));

const proxied = ref(orig.value?.proxied === true);

/** 切换类型时重建字段区：清掉与新类型不符的可选值（优先级、代理） */
watch(() => f.type, (t) => {
  if (!NEEDS_PRIORITY.has(t)) f.priority = "";
  if (!canProxyType(t)) proxied.value = false;
});

/**
 * 「这一类型在当前这条记录上能不能开代理」。
 * 先看接口给的 proxiable（编辑同类型时最准），它只会取消资格；
 * 没有 proxiable 或换类型时退回 PROXIABLE_TYPES 硬判（A/AAAA/CNAME）。
 */
function canProxyType(t: string): boolean {
  return PROXIABLE_TYPES.has(t);
}
const showProxyToggle = computed(() => {
  if (!canProxyType(f.type)) return false;
  const o = orig.value;
  if (o && String(o.type) === f.type && typeof o.proxiable === "boolean") return o.proxiable;
  return true;
});
const proxiableLockedNote = computed(() => {
  const o = orig.value;
  return o && String(o.type) === f.type && o.proxiable === false && canProxyType(f.type);
});

const hint = computed(() => CONTENT_HINT[f.type] ?? { ph: "记录内容", help: "该类型的记录内容" });
const needPriority = computed(() => NEEDS_PRIORITY.has(f.type));

/** TTL 的手动态实时校验（提交前给个人提示；真正的闸门仍是 validateDns，会抛出来） */
const ttlProblem = computed(() => {
  if (ttlAuto.value) return "";
  const n = Number(ttlManual.value);
  if (!Number.isInteger(n) || n < 120 || n > 172800) return "手动 TTL 必须是 120–172800 之间的整数秒；要「自动」请切回上面。";
  return "";
});

const err = ref<GwError | null>(null);

const input = computed<DnsRecordInput>(() => {
  const r: DnsRecordInput = {
    name: f.name,
    type: f.type,
    content: f.content,
    ttl: ttlAuto.value ? 1 : Number(ttlManual.value),
    proxied: showProxyToggle.value ? proxied.value : false,
  };
  if (needPriority.value && f.priority !== "") r.priority = Number(f.priority);
  if (f.comment.trim()) r.comment = f.comment.trim();
  return r;
});

/** 交给父级的新记录建议类型（DnsSetupWizard 会用到，但这里只做普通提交） */
function submit() {
  err.value = null;
  if (ttlProblem.value) {
    err.value = new GwError("badQuery", 422, null, ttlProblem.value);
    return;
  }
  try {
    const preview = editing.value
      ? previewDnsUpdate(props.zoneId, props.zoneName, String(orig.value!.id), input.value)
      : previewDnsCreate(props.zoneId, props.zoneName, input.value);
    const action = editing.value
      ? { kind: "update" as const, input: input.value, id: String(orig.value!.id) }
      : { kind: "create" as const, input: input.value };
    emit("preview", { preview, action });
  } catch (e) {
    err.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e));
  }
}
</script>

<template>
  <form class="df" @submit.prevent="submit">
    <div class="grid2">
      <label class="fld">
        <span>类型</span>
        <select v-model="f.type" class="field">
          <option v-for="t in DNS_TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
      </label>
      <label class="fld">
        <span>记录名</span>
        <input v-model="f.name" class="field" placeholder="@ 或 sub（相对 {{ zone }}）" autocomplete="off" spellcheck="false" />
      </label>
    </div>

    <label class="fld">
      <span>内容 · {{ hint.help }}</span>
      <input v-model="f.content" class="field mono" :placeholder="hint.ph" autocomplete="off" spellcheck="false" />
    </label>

    <label v-if="needPriority" class="fld fld-narrow">
      <span>优先级（{{ f.type }} 必填，0 起）</span>
      <input v-model="f.priority" class="field" type="number" min="0" inputmode="numeric" />
    </label>

    <div class="fld">
      <span>TTL</span>
      <div class="ttl">
        <button type="button" class="seg" :class="{ on: ttlAuto }" @click="ttlAuto = true">自动</button>
        <button type="button" class="seg" :class="{ on: !ttlAuto }" @click="ttlAuto = false">手动</button>
        <input
          v-if="!ttlAuto"
          v-model="ttlManual"
          class="field ttl-in"
          type="number"
          min="120"
          max="172800"
          inputmode="numeric"
          placeholder="120–172800 秒"
        />
      </div>
      <p v-if="ttlProblem" class="ttl-bad">{{ ttlProblem }}</p>
      <p v-else class="muted small">自动 = 由 Cloudflare 按记录类型决定；手动取值须在 120–172800 秒之间。</p>
    </div>

    <label v-if="showProxyToggle" class="sw">
      <input type="checkbox" class="switch" v-model="proxied" />
      <span>{{ proxied ? "已代理（橙云，走 CF CDN/WAF）" : "仅 DNS（灰云，直接解析到源）" }}</span>
    </label>
    <p v-else-if="proxiableLockedNote" class="muted small">这条记录 Cloudflare 标记为「不可代理」（如 apex 上的 CNAME），代理开关不给。</p>
    <p v-else-if="!canProxyType(f.type)" class="muted small">{{ f.type }} 不能开代理（只有 A / AAAA / CNAME 可以）。</p>

    <label class="fld">
      <span>备注（可选）</span>
      <input v-model="f.comment" class="field" placeholder="给这条记录留个说明" autocomplete="off" />
    </label>

    <ErrorNote :err="err" />

    <div class="foot">
      <button type="button" class="ghost" @click="emit('cancel')">取消</button>
      <button type="submit" class="primary">{{ editing ? '核对改动' : '核对新记录' }}</button>
    </div>
    <p class="muted small note">点「核对」只是生成预览，不会直接写；真正发送前会弹出确认抽屉逐字段核对。</p>
  </form>
</template>

<style scoped>
.df { display: flex; flex-direction: column; gap: 12px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.fld { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--muted); }
.fld-narrow { max-width: 200px; }
.fld span { font-weight: 600; }
.mono { font-family: ui-monospace, Consolas, monospace; }
.ttl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.seg { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2); color: var(--muted); font-size: 13px; cursor: pointer; }
.seg.on { border-color: var(--accent); color: var(--accent); background: rgb(var(--accent-rgb) / .12); }
.ttl-in { max-width: 150px; }
.ttl-bad { margin: 4px 0 0; color: var(--bad); font-size: 12px; }
.sw { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg); cursor: pointer; }
.sw input { width: 18px; height: 18px; accent-color: var(--accent); }
.foot { display: flex; gap: 10px; justify-content: flex-end; }
.note { margin: 0; }
</style>
