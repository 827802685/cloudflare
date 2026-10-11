<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import ErrorNote from "../components/ErrorNote.vue";
import UnavailableNote from "../components/board/UnavailableNote.vue";
import { api, gwHealth, gwMeta, GwError, setWritesOptIn, writesOptIn, type Account } from "../lib/api";
import { baseSource } from "../lib/config";
import { THEME_OPTIONS, loadThemePref, saveThemePref, type ThemePref, ACCENT_OPTIONS, loadAccentPref, saveAccentPref, type AccentPref } from "../lib/theme";
import { LIST_PRESETS, listCount, setListCount } from "../lib/lists";
import FoldNote from "../components/FoldNote.vue";
import { dt } from "../lib/fmt";
import { useGatewayStore } from "../stores/gateway";

const gw = useGatewayStore();
const baseUrl = ref(gw.config.baseUrl);
const token = ref(gw.config.deviceToken);
/** 跟着输入框实时算：留空时会退回"打包默认"或同源 /api，界面必须说清退回到哪一级 */
const baseInfo = computed(() => baseSource({ ...gw.config, baseUrl: baseUrl.value.trim().replace(/\/+$/, ""), deviceToken: token.value }));
/**
 * 原来顶栏右上角那条（网关地址 + 来源 + 账号名）搬进这一屏了。
 * 它和上面 `baseInfo` 不是一回事：`baseInfo` 算的是**输入框里的草稿**（还没保存），
 * 这两个算的是**这台设备当前真正生效**的配置 —— 两者不一样时正好说明"改了还没保存"。
 */
const savedBase = computed(() => baseSource(gw.config));
const savedAccount = computed(() =>
  gw.config.accountName
    ? gw.config.accountName
    : gw.config.account
      ? gw.config.account.slice(0, 8) + "…（选过账号，名字没在这台设备上存下来）"
      : "网关默认（这台设备没另选过账号）",
);
const reveal = ref(false);
const testing = ref(false);
/* ---------- 外观档位（MASTER.md §7）：默认跟随系统，可显式钉住浅/深 ---------- */
const theme = ref<ThemePref>(loadThemePref());
function setTheme(v: ThemePref) { theme.value = saveThemePref(v); }
/* ---------- 强调色档：只换控件/选中态，读数轨四态编码不受影响（见 main.css [data-accent]） ---------- */
const accent = ref<AccentPref>(loadAccentPref());
function setAccent(v: AccentPref) { accent.value = saveAccentPref(v); }
const result = ref<{ health?: any; account?: string; error?: GwError }>({});
/** 令牌可见的账号全量列表 + 网关本次实际用的那个（?account 没传时就是 env 里的默认账号） */
const accounts = ref<Account[]>([]);
const active = ref("");
const switching = ref(false);
/**
 * 设备存储里那个账号现在还作不作数。/v1/accounts 豁免 ?account=（自救路径必须无条件可达），
 * 所以它既能列出可见账号、又能回显 requested/applied —— 三者一起用才不会把"失效的选择"显示成"还在用"。
 */
const pickStale = computed(() => !!gw.config.account && accounts.value.every((a) => a.id !== gw.config.account));

async function test() {
  testing.value = true;
  result.value = {};
  const saved = { ...gw.config };
  gw.save({ baseUrl: baseUrl.value, deviceToken: token.value });
  try {
    const health = await gwHealth(baseUrl.value);
    let account: string | undefined;
    try {
      const acc = await api.accounts();
      accounts.value = Array.isArray(acc.result) ? acc.result : [];
      active.value = String(acc.active || "");
      const hit = accounts.value.find((a) => a.id === active.value) || accounts.value[0] || null;
      // 选择失效时不能只写"bai account"：那样等于替一个已经不生效的选择背书（§E17 同一类）
      account = hit
        ? pickStale.value
          ? `${hit.name}（${(hit.id || "").slice(0, 8)}…）· 这是网关默认账号，不是你选的「${gw.config.accountName || gw.config.account.slice(0, 8)}…」`
          : `${hit.name}（${(hit.id || "").slice(0, 8)}…）`
        : "账号列表为空";
      gw.pinged();
    } catch (e) {
      result.value = { health, error: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) };
      return;
    }
    result.value = { health, account };
  } catch (e) {
    result.value = { error: e instanceof GwError ? e : new GwError("network", 0, null, String(e)) };
    gw.save(saved);          // 连不上就别把坏配置留下
  } finally {
    testing.value = false;
  }
}

/** 切账号 = 改存储里的 account，之后每个请求都自动带 ?account=，网关那侧还会再校验一次 */
async function pick(a: Account) {
  if (a.id === gw.config.account || switching.value) return;
  switching.value = true;
  gw.save({ account: a.id, accountName: a.name });
  try {
    await test();
  } finally {
    switching.value = false;
  }
}
/** 回到"不传 account"，也就是网关 env 里的默认账号 */
async function useGatewayDefault() {
  if (!gw.config.account) return;
  switching.value = true;
  gw.save({ account: "", accountName: "" });
  try {
    await test();
  } finally {
    switching.value = false;
  }
}
onMounted(() => { if (gw.configured) test(); });

/* ============================================================================
 * 写开关（本地那道闸门）。两道闸门的处置方式不同，界面上必须分开说（docs/12 §3 P3 契约）：
 *   - 本地关着：写请求根本不出这台设备 —— 网关无从知晓，也不会被打扰；
 *   - 本地开着、网关 WRITE_ENABLED 关着：请求会发到网关，被它以 501 writesDisabled 拒掉，
 *     要开通得改网关侧（另一个分支在实现），在这台设备上做什么都没用。
 * health.writes 只有真测过连接才知道；没测过时显示"没测过"，不猜成 disabled。
 * ========================================================================== */
const allowWrites = ref(writesOptIn());
/** 打开要二次确认：先落在 pending，点"确认打开"才写进存储 */
const confirmOpenWrites = ref(false);
function requestOpenWrites() { confirmOpenWrites.value = true; }
function commitOpenWrites() {
  setWritesOptIn(true);
  allowWrites.value = true;
  confirmOpenWrites.value = false;
}
function closeWrites() {
  setWritesOptIn(false);
  allowWrites.value = false;
  confirmOpenWrites.value = false;
}
const gwWrites = computed<string | null>(() => {
  const w = result.value.health?.writes;
  return w === "enabled" || w === "disabled" ? w : null;
});
const writeGateNote = computed(() => {
  if (!allowWrites.value) {
    return gwWrites.value === "enabled"
      ? "本地闸门关着：写请求在本机就被拦下、不会发出。网关那侧其实已经放行（writes=enabled），但你不打开它也不起作用 —— 这是默认状态。"
      : gwWrites.value === "disabled"
        ? "本地闸门关着：写请求在本机就被拦下、不会发出。网关那侧也没放行（writes=disabled），两边都关，一切写操作都停留在纸面上。"
        : "本地闸门关着：写请求在本机就被拦下、不会发出。网关那侧的状态还不知道（下面点过「保存并测试连接」才会显示），但不影响这条：本机不发就是不发。";
  }
  if (gwWrites.value === "enabled") {
    return "两道闸门都开着：App 里的 DNS 增删改与清缓存会真的作用于你的 Cloudflare 账号。每个动作发出前仍会回显完整请求并要求确认。";
  }
  if (gwWrites.value === "disabled") {
    return "本地已打开，但网关这侧 WRITE_ENABLED 没放行：请求会发到网关并被它以 501 拒绝。处置在网关（app/gateway 的 WRITE_ENABLED，写链路分支上线），不是在这台设备上再点什么。";
  }
  return "本地已打开，但还没测过连接，网关那侧是 enabled 还是 disabled 未知 —— 先点上面「保存并测试连接」。在那之前发出去的写请求会得到什么答复，取决于你没看到的那个开关。";
});

/* ---------- 请求预算（调度器账本，来自 stores/gateway.ts） ---------- */
/** 年龄必须真的会走：不接心跳的话"5 秒前"能盯成"5 分钟前"（BoardView 同一课） */
const nowTick = ref(Date.now());
const clock = setInterval(() => (nowTick.value = Date.now()), 10_000);
onUnmounted(() => clearInterval(clock));
const ageText = computed(() => {
  nowTick.value;
  const at = gwMeta.fetchedAt;
  if (!at) return "这台设备还没取到过数据";
  const s = Math.max(0, Math.round((nowTick.value - at) / 1000));
  return s < 60 ? `${s} 秒前落地` : `${Math.round(s / 60)} 分钟前落地`;
});
const budgetRunning = computed(() => gw.budget.running);
</script>

<template>
  <div class="set">
    <!-- ============ 连接 ============ -->
    <div class="card wide">
      <h3>网关配置</h3>
      <!-- 这台设备现在真的走哪个网关、哪个账号：顶栏右上角那条搬来的，措辞按"生效/草稿"分开 -->
      <div class="small muted" style="margin-bottom: 10px">
        <template v-if="gw.configured">
          当前生效：<code>{{ savedBase.base }}</code>（来源：{{ savedBase.from }}）· 账号：{{ savedAccount }}
        </template>
        <template v-else>当前状态：<b>未配置</b> —— 这台设备还没有设备令牌，除了本页哪一屏都进不去（顶栏那个红点就是它）。</template>
      </div>
      <label class="lbl">网关地址（留空 = {{ baseInfo.from === "同源 /api" ? "同源 /api，本地开发由 vite 反代到 127.0.0.1:8788" : "用打包时写进去的默认地址" }}）</label>
      <input v-model="baseUrl" class="field" placeholder="https://控制台域名.你的站点" spellcheck="false" />
      <div class="small muted" style="margin-top: 6px">
        按当前填法会走 <code>{{ baseInfo.base }}</code>（来源：{{ baseInfo.from }}；改了要先点"保存并测试连接"才生效）。<br />
        必须填你自己的域名：实测 <code>*.workers.dev</code> 在本机网络不可达（DNS 被污染到 <code>108.160.166.148</code>），
        而 <code>acct.example.com</code> 这类自定义域名可达（docs/09 §C1）。
      </div>

      <label class="lbl">设备令牌（对应网关的 DEVICE_TOKENS，不是 CF API Token）</label>
      <div class="row">
        <input v-model="token" class="field" style="flex: 1" :type="reveal ? 'text' : 'password'" spellcheck="false" />
        <button class="ghost" @click="reveal = !reveal">{{ reveal ? "隐藏" : "显示" }}</button>
      </div>

      <div class="row" style="margin-top: 12px">
        <button class="primary" :disabled="testing" @click="test">{{ testing ? "测试中" : "保存并测试连接" }}</button>
      </div>
    </div>

    <div class="card" v-if="result.health || result.error">
      <h3>连接结果</h3>
      <ErrorNote :err="result.error || undefined" />
      <dl class="kv" v-if="result.health">
        <dt>服务状态</dt><dd>{{ result.health.service }}</dd>
        <dt>写操作</dt><dd><span class="badge" :class="{ live: result.health.writes === 'enabled' }">{{ result.health.writes === 'enabled' ? '已启用' : '未启用' }}</span></dd>
        <dt>时间窗</dt><dd>{{ (result.health.ranges || []).join(" / ") }}</dd>
        <dt>账号</dt><dd>{{ result.account || "—" }}</dd>
      </dl>
    </div>

    <!-- ============ 外观：深浅档 + 强调色档 ============ -->
    <div class="card">
      <h3>外观</h3>
      <div class="opt">
        <div class="opt-h">深浅档</div>
        <div class="row">
          <button
            v-for="opt in THEME_OPTIONS"
            :key="opt.value"
            class="chip"
            :class="{ on: theme === opt.value }"
            @click="setTheme(opt.value)"
          >{{ opt.label }}</button>
        </div>
      </div>
      <div class="opt">
        <div class="opt-h">强调色（控件 / 选中态）</div>
        <div class="row">
          <button
            v-for="opt in ACCENT_OPTIONS"
            :key="opt.value"
            class="chip"
            :class="{ on: accent === opt.value }"
            @click="setAccent(opt.value)"
          ><i class="dot" :data-a="opt.value" />{{ opt.label }}</button>
        </div>
      </div>
      <div class="opt">
        <div class="opt-h">长列表默认显示</div>
        <div class="row">
          <button
            v-for="p in LIST_PRESETS"
            :key="p.v"
            class="chip"
            :class="{ on: listCount === p.v }"
            @click="setListCount(p.v)"
          >{{ p.label }}</button>
        </div>
      </div>
      <FoldNote label="这几项是怎么回事">
        深浅两档都是正式设计过的（语义色按各自底色重挑过对比度）。选「跟随系统」时跟着系统的深浅走；显式选浅/深会钉住。
        强调色只换按钮、标签、焦点环这一族控件色；<b>卡片左沿那条读数轨不受它影响，仍是「橙 = 有真数 / 蓝 = 取数中」</b>，
        所以换色不会把四态编码混掉。字体不点名具体字体（只给通用族），本机换字体界面跟着换。
        「长列表默认显示」这一档管的是<b>「一行一个东西」的列表</b>：Worker 版本列表与部署历史、Pages 部署历史、DNS 记录、
        D1 库 / KV 命名空间 / R2 桶的左栏、KV 的 Key 表 —— 超出这个条数就出「展开更多」，选「全部」则不折。
        <b>不跟这一档走的是计算页顶部的「每日额度」和「按 Worker 事件分布」</b>：那两块默认只留消耗/数量最高的那条，
        是刻意的极值读数而不是分页，展开按钮照旧。
        三项都存在本机（<code>cfconsole.theme.v1</code>、<code>cfconsole.accent.v1</code>、<code>cfconsole.listCount.v1</code>），
        不上云、不影响取数请求数。
      </FoldNote>
    </div>

    <!-- ============ 账号 ============ -->
    <div class="card wide" v-if="accounts.length">
      <h3>这把令牌能看见的账号</h3>
      <div class="small muted">
        <template v-if="pickStale">
          你在这台设备上选过「{{ gw.config.accountName || gw.config.account.slice(0, 8) + "…" }}」，但它已经不在可见列表里了
          （多半是后台改了这把令牌的账号作用域）。这一屏还能打开是因为账号列表豁免 account 参数，
          其它屏的请求都会被网关 422 挡掉 —— 点下方「回到网关默认账号」恢复。
        </template>
        <template v-else>
          {{ accounts.length === 1
            ? "只有 1 个账号，所以不给切换器 —— 界面上所有数据都来自它。"
            : `${accounts.length} 个账号，选一个后所有界面跟着切（网关会拿 /accounts 的可见集合校验，不合法的 id 直接 422）。` }}
        </template>
      </div>
      <ul v-if="accounts.length > 1" class="list">
        <li v-for="a in accounts" :key="a.id" class="item">
          <div class="k">
            {{ a.name }}
            <div class="small muted">{{ a.id.slice(0, 8) }}…{{ a.type ? " · " + a.type : "" }}</div>
          </div>
          <button
            class="chip"
            :class="{ on: a.id === (gw.config.account || active) }"
            :disabled="switching"
            @click="pick(a)"
          >{{ a.id === (gw.config.account || active) ? "当前使用中" : "选择此账号" }}</button>
        </li>
      </ul>
      <div v-else class="list" style="margin-top: 8px">
        <div class="item">
          <div class="k">
            {{ accounts[0].name }}
            <div class="small muted">{{ accounts[0].id.slice(0, 8) }}…{{ accounts[0].type ? " · " + accounts[0].type : "" }}</div>
          </div>
          <!-- 选择失效时这个账号只是"网关默认"，不能标成当前（标了就等于替失效的选择背书） -->
          <span class="chip" :class="{ on: !pickStale }">{{ pickStale ? "网关默认" : "当前使用中" }}</span>
        </div>
      </div>
      <div v-if="gw.config.account" class="row" style="margin-top: 8px">
        <button class="ghost" :disabled="switching" @click="useGatewayDefault">回到网关默认账号</button>
        <span class="small muted">当前：{{ gw.config.accountName || gw.config.account.slice(0, 8) + "…" }}</span>
      </div>
      <div v-else-if="accounts.length > 1" class="small muted" style="margin-top: 8px">
        当前用的是网关 env 里的默认账号（没传 account）。
      </div>
      <div class="small muted" style="margin-top: 8px">
        诚实提示：多账号的读侧接口面在本机验过（假 id 422 / 真 id 200），但"切到第二个账号后数据真的变了"
        要等有第二个账号才能实测，见 docs/09 §F。
      </div>
    </div>

    <!-- ============ 写闸门 ============ -->
    <div class="card wide">
      <h3>写操作（两道闸门）</h3>
      <div class="item" style="border-radius: 8px">
        <div class="k">
          本机写开关
          <div class="small muted">{{ allowWrites ? "已打开：写请求会从这台设备发出" : "关着（默认）：写请求不出这台设备" }}</div>
        </div>
        <button v-if="!allowWrites" class="chip" @click="requestOpenWrites">打开</button>
        <button v-else class="chip on" @click="closeWrites">关掉</button>
      </div>

      <template v-if="confirmOpenWrites && !allowWrites">
        <div class="small" style="margin-top: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 8px">
          打开后，App 里的 <b>DNS 新增 / 修改 / 删除</b> 与 <b>清缓存</b> 会<b>真的作用于你选定的 Cloudflare 账号</b>
          （目前是「{{ gw.config.accountName || (gw.config.account ? gw.config.account.slice(0, 8) + "…" : "网关默认账号") }}」
          。每个动作发出前仍会回显完整请求（方法 / 路径 / 请求体）并要求你确认，删除类还要点名。<br />
          这一开关只解锁本机出口；网关那侧是否放行见下面的 writes 状态，两道闸门缺一不可。
          <div class="row" style="margin-top: 10px">
            <button class="primary" @click="commitOpenWrites">确认打开</button>
            <button class="ghost" @click="confirmOpenWrites = false">先不打开</button>
          </div>
        </div>
      </template>

      <dl class="kv" style="margin-top: 12px">
        <dt>本机闸门</dt>
        <dd>{{ allowWrites ? "开" : "关（默认）" }}</dd>
        <dt>网关闸门</dt>
        <dd>
          <span v-if="gwWrites === 'enabled'" class="badge live">已放行</span>
          <span v-else-if="gwWrites === 'disabled'" class="badge">未放行</span>
          <span v-else class="badge">没测过 —— 点上方「保存并测试连接」才知道</span>
          <span class="small muted">（来自 /health 的 writes 字段，非猜测）</span>
        </dd>
      </dl>
      <div class="small" style="margin-top: 8px">{{ writeGateNote }}</div>
    </div>

    <!-- ============ 运行 ============ -->
    <div class="card wide">
      <h3>请求预算（调度器账本）</h3>
      <div class="small muted">
        规则：进 App 拉一轮，之后每 5 分钟一轮；后台标签页不打网关，回前台只有已过期才补。<br />
        当前数据：{{ ageText }}。<span v-if="budgetRunning">这一轮正在跑…</span>
      </div>
      <dl class="kv" style="margin-top: 10px">
        <dt>调度轮次数</dt><dd>{{ gw.budget.rounds }} 轮</dd>
        <dt>最近一轮</dt>
        <dd v-if="gw.budget.lastRoundAt">{{ dt(gw.budget.lastRoundAt) }} · 发网关 {{ gw.budget.last.requests }} 条 / 本机缓存命中 {{ gw.budget.last.localHits }} 条（没出网）/ 网关回源 CF {{ gw.budget.last.cfCalls }} 次 / 失败 {{ gw.budget.last.errors }} 块</dd>
        <dd v-else>还没跑过第一轮</dd>
        <dt>累计</dt>
        <dd>发网关 {{ gw.budget.total.requests }} 条 · 回源 CF {{ gw.budget.total.cfCalls }} 次 · 缓存命中 {{ gw.budget.total.localHits }} 条</dd>
        <dt>下一轮</dt><dd>{{ gw.nextRoundNote }}</dd>
      </dl>
      <div class="row" style="margin-top: 10px">
        <button class="ghost" :disabled="budgetRunning || !gw.configured" @click="gw.roundNow()">立刻走一轮（新鲜数据直接复用缓存，几乎不出网）</button>
        <button class="ghost" :disabled="budgetRunning || !gw.configured" @click="gw.roundForceFresh()">强制新取一轮（破两层缓存，会真的打网关和 CF）</button>
      </div>
      <div class="small muted" style="margin-top: 8px">
        口径说明：这份账只覆盖调度器发出的列表级请求（看板 + Workers/Pages/域名清单）。你在详情页的加载和各屏「刷新」按钮不经调度器、不进这份账
        —— 但它们同样被本机 5 分钟缓存和网关缓存拦着。CF 侧真实总次数以网关响应头 x-gw-cf-calls 为准，这里累加的就是它，不是估算。
      </div>
    </div>

    <!-- 看板上的「取不到」清单搬到这里了（10-11：读数面只放数，介绍进设置） -->
    <div class="wide"><UnavailableNote /></div>

    <!-- ============ 说明（本机存储 / 未开放功能）============ -->
    <div class="card">
      <h3>这台设备存了什么</h3>
      <div class="small muted">
        localStorage 里只有 <code>cfconsole.config.v1</code>：网关地址 + 设备令牌 + 选定账号 id 与名字，外加两枚本机偏好 <code>cfconsole.theme.v1</code>（深浅档）、<code>cfconsole.accent.v1</code>（强调色档）。<br />
        CF API Token 只在网关侧（本地 <code>app/gateway/.dev.vars</code>，线上 <code>wrangler secret put</code>），
        前端拿不到，也永远不该拿到。吊销某台设备 = 从网关的 DEVICE_TOKENS 里删掉那一项。
      </div>
    </div>

    <div class="card">
      <h3>写功能与还没开放的功能</h3>
      <div class="small muted">
        DNS 增删改、清缓存：本机契约与确认抽屉已就绪（见上面「写操作」）。实际能不能落到你的账号，取决于上面两道闸门的组合
        —— 本机开关默认关；当前这台网关是否放行以 /health 的 writes 为准，没测过就是不知道，不猜。<br /><br />
        版本切换 / 回滚 / 灰度、Pages 部署与回滚、写 secret、改 cron —— 这几类网关侧链路还在另一个分支实现，本 App 不提供入口；
        对只读网关发过去也会得到 <code>501 writesDisabled</code>。原因是两类问题还没解决：一是需要你明确授权对账号做变更，
        二是这些写链路的请求体形状只有反推、没有实测（docs/09 §B）。
        <br /><br />
        实时日志（Workers Tail）也没做，而且原因分两层：tail 的 <code>wss://</code> 端点已实测在本机网络不可达
        （DNS 污染 + TCP 443 超时，docs/09 §C1/C3），所以直连这条路是死的；"挂在你自己域名下的中继能不能work"
        这层仍未实测，且不能拿本地 <code>wrangler dev</code> 测（必然假阴性）。所以这里不提供入口，也不暗示以后能开。
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 设置页排版：窄屏单列，宽屏两列；正文/输入类卡片横跨整行，紧凑卡片并排。
   只动排版，卡片壳与读数轨仍走全局 .card，不改观感语义。 */
.set { display: grid; gap: 12px; grid-template-columns: 1fr; align-items: start; }
@media (min-width: 880px) {
  .set { grid-template-columns: 1fr 1fr; }
  .set > .wide { grid-column: 1 / -1; }
}
.set > .card { margin-bottom: 0; }
.set > .wide :deep(.card) { margin-bottom: 0; }
.opt { margin-bottom: 12px; }
.opt-h { font-size: var(--t-xs); color: var(--muted); letter-spacing: .04em; margin-bottom: 6px; }
/* 强调色预览点：这是"选项本身"的固定色，不是界面当前色，所以写字面值 */
.dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; border: 1px solid rgb(0 0 0 / .18); }
.dot[data-a="orange"] { background: #a8480a; }
.dot[data-a="blue"] { background: #1e5cc8; }
</style>
