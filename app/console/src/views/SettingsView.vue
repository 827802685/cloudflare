<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import ErrorNote from "../components/ErrorNote.vue";
import UnavailableNote from "../components/board/UnavailableNote.vue";
import { api, gwHealth, gwMeta, GwError, isNativeApp, setWritesOptIn, writesOptIn, probeToken, type Account } from "../lib/api";
import { acctState, addAccount, removeAccount, labelOf, createVault, unlockAccounts, lockAccounts, destroyAll, type CfAccount } from "../lib/accounts";
import { baseSource } from "../lib/config";
import { THEME_OPTIONS, loadThemePref, saveThemePref, type ThemePref, ACCENT_OPTIONS, loadAccentPref, saveAccentPref, type AccentPref } from "../lib/theme";
import { LIST_PRESETS, listCount, setListCount } from "../lib/lists";
import FoldNote from "../components/FoldNote.vue";
import { dt } from "../lib/fmt";
import { useGatewayStore } from "../stores/gateway";

const gw = useGatewayStore();
/**
 * 这台设备跑在哪种模式：APK（Capacitor 原生壳）= 直连，请求不经过网关；
 * 浏览器 / PWA = 走网关。整屏文案按它切换 —— 直连模式里"网关"那套说法全是空的，
 * 照旧显示会让人去找一个根本不存在的网关。
 */
const directMode = isNativeApp();
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
      : directMode
        ? "还没选账号（直连模式下必须选一个才能取数）"
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

/* ============================================================================
 * 账号 = 一把 CF API Token（多账号就是这么实现的）。
 * 令牌由这台设备保存、每次请求经 HTTPS 带给网关（x-cf-token），网关只在这一次请求里用它调 CF。
 * 三件事：验证并添加（probeToken 先打一次 /v1/accounts）、切换（改 config.account）、删除。
 * ========================================================================== */
const accts = computed(() => acctState.list);
const newAlias = ref("");
const newToken = ref("");
const revealNew = ref(false);
const adding = ref(false);
const addErr = ref<GwError | null>(null);

/* ---------- 保险箱（令牌加密存储）：首次设口令 / 解锁 / 上锁 ---------- */
const pass1 = ref("");
const pass2 = ref("");
const vaultBusy = ref(false);
const vaultErr = ref("");
/** 旧版本留下的明文账号（迁移用）；加密落盘后由 accounts.createVault 清空 */
const legacyCount = computed(() => acctState.legacy.length);

async function doCreate() {
  vaultErr.value = "";
  if (pass1.value !== pass2.value) { vaultErr.value = "两次输入的口令不一样"; return; }
  if (pass1.value.length < 6) { vaultErr.value = "口令至少 6 位"; return; }
  vaultBusy.value = true;
  try {
    await createVault(pass1.value);
    pass1.value = "";
    pass2.value = "";
    await test();
  } catch (e) {
    vaultErr.value = String((e as Error)?.message || e);
  } finally {
    vaultBusy.value = false;
  }
}

async function doUnlock() {
  vaultErr.value = "";
  if (!pass1.value) { vaultErr.value = "先输口令"; return; }
  vaultBusy.value = true;
  try {
    await unlockAccounts(pass1.value);
    pass1.value = "";
    await test();
  } catch {
    // GCM 校验失败就是口令不对（或密文被改过），别说成"解密失败"这种含糊话
    vaultErr.value = "口令不对（或保险箱被改过）";
  } finally {
    vaultBusy.value = false;
  }
}

function doLock() {
  lockAccounts();
  pass1.value = "";
  pass2.value = "";
  result.value = {};
}

async function doDestroy() {
  if (!confirm("销毁保险箱会连同所有已保存的令牌一起删掉，且不可恢复。确定？")) return;
  destroyAll();
  gw.save({ account: "", accountName: "" });
  result.value = {};
}

async function addAcc() {
  addErr.value = null;
  const token = newToken.value.trim();
  if (!token) { addErr.value = new GwError("badQuery", 422, null, "先粘一把 Cloudflare API Token"); return; }
  adding.value = true;
  try {
    const r = await probeToken(token);
    const list = Array.isArray(r.result) ? r.result : [];
    if (!list.length) {
      addErr.value = new GwError("permission", 403, null, "这把令牌没看见任何账号 —— 多半缺 Account:Read 权限，或者令牌已经失效");
      return;
    }
    const first = list[0];
    const acc: CfAccount = { token, id: String(first.id), name: String(first.name || ""), alias: newAlias.value.trim() };
    await addAccount(acc);
    // 本机第一个账号、或当前没选账号 → 自动选中（否则"加了但没在用"会很迷惑）
    if (!gw.config.account || acctState.list.length === 1) gw.save({ account: acc.id, accountName: labelOf(acc) });
    newAlias.value = "";
    newToken.value = "";
    await test();
    if (list.length > 1) {
      result.value = { ...result.value, account: `${labelOf(acc)}（这把令牌可见 ${list.length} 个账号，已添加第一个；其余的可各存一把令牌）` };
    }
  } catch (e) {
    addErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    adding.value = false;
  }
}

async function pickAcc(a: CfAccount) {
  if (a.id === gw.config.account || switching.value) return;
  switching.value = true;
  gw.save({ account: a.id, accountName: labelOf(a) });
  try { await test(); } finally { switching.value = false; }
}

/** 删账号：删的是选中项就顺位选剩下的第一个；一个都不剩就回到"网关默认令牌" */
async function delAcc(a: CfAccount) {
  await removeAccount(a.id);
  if (gw.config.account === a.id) {
    const next = acctState.list[0];
    gw.save(next ? { account: next.id, accountName: labelOf(next) } : { account: "", accountName: "" });
  }
  await test();
}

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
  // 直连模式（APK）：写请求从这台设备直接发给 CF，**没有网关这道闸门**，
  // 所以"两道闸门"的说法在这里不成立 —— 只有本机开关一个。别照抄网关模式的文案。
  if (directMode) {
    return allowWrites.value
      ? "直连模式：写请求会从这台设备直接发给 Cloudflare，只受上面这个本机开关管辖（没有网关第二道闸门）。每个动作发出前仍会回显完整请求并要求确认。"
      : "直连模式：本机开关关着，写请求在这台设备上就被拦下、不会发出。直连模式没有网关那道闸门，所以这一个是唯一的闸门。";
  }
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
      <template v-if="directMode">
        <div class="small" style="margin-bottom: 10px; padding: 10px; border: 1px solid var(--line); border-radius: 8px">
          这台设备是 <b>APK 直连模式</b>：所有请求从本机直接发给 <code>api.cloudflare.com</code>，<b>不经过网关</b> ——
          令牌由这台设备加密保存、每次请求现取现带，装包即用，不需要部署任何服务。<br />
          下面这组网关配置在 APK 里<b>不生效</b>（只对浏览器 / PWA 模式有意义）。
        </div>
      </template>
      <!-- 这台设备现在真的走哪个网关、哪个账号：顶栏右上角那条搬来的，措辞按"生效/草稿"分开 -->
      <div class="small muted" style="margin-bottom: 10px">
        <template v-if="directMode">
          当前生效：<b>直连 api.cloudflare.com</b> · 账号：{{ savedAccount }}
        </template>
        <template v-else-if="gw.configured">
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

      <label class="lbl">设备令牌（对应网关的 DEVICE_TOKENS；它只管「谁能用这个网关」，网关没配名单可留空）</label>
      <div class="row">
        <input v-model="token" class="field" style="flex: 1" :type="reveal ? 'text' : 'password'" spellcheck="false" />
        <button class="ghost" @click="reveal = !reveal">{{ reveal ? "隐藏" : "显示" }}</button>
      </div>

      <div class="row" style="margin-top: 12px">
        <button class="primary" :disabled="testing" @click="test">{{ testing ? "测试中" : directMode ? "测试直连连接" : "保存并测试连接" }}</button>
      </div>
    </div>

    <div class="card" v-if="result.health || result.error">
      <h3>连接结果</h3>
      <ErrorNote :err="result.error || undefined" />
      <dl class="kv" v-if="result.health">
        <dt>服务状态</dt><dd>{{ result.health.service }}</dd>
        <dt>写操作</dt>
        <dd>
          <template v-if="result.health.direct">只受本机开关管辖（直连模式没有网关那道闸门）</template>
          <template v-else><span class="badge" :class="{ live: result.health.writes === 'enabled' }">{{ result.health.writes === 'enabled' ? '已启用' : '未启用' }}</span></template>
        </dd>
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

    <!-- ============ 账号（CF 令牌，加密保管）============ -->
    <div class="card wide">
      <h3>账号（CF 令牌）</h3>
      <div class="small muted">
        一个账号 = 一把 Cloudflare API Token。令牌由这台设备<b>用口令派生的密钥加密后</b>保存
        （PBKDF2 + AES-256-GCM）。
        <template v-if="directMode">
          直连模式下，每次请求由本机直接带 <code>Authorization: Bearer</code> 头打 Cloudflare，不经过任何中间服务。
        </template>
        <template v-else>
          每次请求经 HTTPS 带给网关（头 <code>x-cf-token</code>），网关只在这一次请求里用它调 CF、不留副本。
        </template>
      </div>

      <!-- ① 还没建保险箱：设口令 -->
      <template v-if="!acctState.exists">
        <div class="small" style="margin-top: 12px">
          先给这台设备设一个<b>解锁口令</b>：它只用来加解密本机的令牌，<b>不上传、也不存盘</b> ——
          忘了就只剩「销毁重来」。
          <template v-if="legacyCount"> 检测到 <b>{{ legacyCount }}</b> 个旧版明文账号，设完口令会自动加密收进去。</template>
        </div>
        <label class="lbl" style="margin-top: 10px">解锁口令（至少 6 位）</label>
        <input v-model="pass1" class="field" type="password" spellcheck="false" />
        <label class="lbl" style="margin-top: 8px">再输一遍</label>
        <input v-model="pass2" class="field" type="password" spellcheck="false" @keyup.enter="doCreate" />
        <div class="row" style="margin-top: 10px">
          <button class="primary" :disabled="vaultBusy" @click="doCreate">{{ vaultBusy ? "创建中…" : "创建并解锁" }}</button>
        </div>
        <div v-if="vaultErr" class="small" style="color: var(--bad); margin-top: 8px">{{ vaultErr }}</div>
      </template>

      <!-- ② 有保险箱但没解锁 -->
      <template v-else-if="acctState.locked">
        <div class="small muted" style="margin-top: 12px">
          这台设备上的令牌是加密保存的，输口令解锁后才能用。
        </div>
        <div class="row" style="margin-top: 10px">
          <input v-model="pass1" class="field" style="flex: 1" type="password" placeholder="解锁口令" spellcheck="false" @keyup.enter="doUnlock" />
          <button class="primary" :disabled="vaultBusy" @click="doUnlock">{{ vaultBusy ? "解锁中…" : "解锁" }}</button>
        </div>
        <div v-if="vaultErr" class="small" style="color: var(--bad); margin-top: 8px">{{ vaultErr }}</div>
        <div class="row" style="margin-top: 10px">
          <button class="ghost" @click="doDestroy">忘了口令？销毁保险箱重来</button>
          <span class="small muted">销毁会删掉所有已保存的令牌，不可恢复。</span>
        </div>
      </template>

      <!-- ③ 已解锁：管理账号 -->
      <template v-else>
        <div style="margin-top: 12px">
          <label class="lbl">别名（随便起，用来认）</label>
          <input v-model="newAlias" class="field" placeholder="例如：主账号 / 备用号" spellcheck="false" />
          <label class="lbl" style="margin-top: 8px">Cloudflare API Token</label>
          <div class="row">
            <input v-model="newToken" class="field" style="flex: 1" :type="revealNew ? 'text' : 'password'" placeholder="粘一把 API Token" spellcheck="false" />
            <button class="ghost" @click="revealNew = !revealNew">{{ revealNew ? "隐藏" : "显示" }}</button>
          </div>
          <div class="row" style="margin-top: 10px">
            <button class="primary" :disabled="adding" @click="addAcc">{{ adding ? "验证中…" : "验证并添加" }}</button>
            <span class="small muted">先拿它打一次 <code>/v1/accounts</code> —— 令牌和权限对不对，当场就知道。</span>
          </div>
          <ErrorNote :err="addErr || undefined" />
        </div>

        <div v-if="accts.length" class="list" style="margin-top: 12px">
          <div v-for="a in accts" :key="a.id" class="item">
            <div class="k">
              {{ labelOf(a) }}
              <div class="small muted">{{ a.id.slice(0, 8) }}…{{ a.name && a.name !== labelOf(a) ? " · " + a.name : "" }}</div>
            </div>
            <div class="row">
              <button class="chip" :class="{ on: a.id === gw.config.account }" :disabled="switching" @click="pickAcc(a)">
                {{ a.id === gw.config.account ? "使用中" : "用它" }}
              </button>
              <button class="chip" :disabled="switching" @click="delAcc(a)">删除</button>
            </div>
          </div>
        </div>
        <div v-else class="empty" style="margin-top: 12px">还没添加账号 —— 粘一把 Cloudflare API Token 就能用了。</div>

        <div v-if="pickStale" class="small muted" style="margin-top: 8px">
          这台设备选过「{{ gw.config.accountName || gw.config.account.slice(0, 8) + "…" }}」，但它已经不在上面这个列表里了。
          <template v-if="directMode">请求会失败（这个账号不在所选令牌的可见范围里）—— 点任一账号的「用它」恢复。</template>
          <template v-else>请求会被网关 422 挡掉 —— 点任一账号的「用它」恢复。</template>
        </div>
        <div v-else-if="!gw.config.account && accts.length" class="small muted" style="margin-top: 8px">
          <template v-if="directMode">当前没选账号：直连模式下必须选一个账号才能取数。</template>
          <template v-else>当前没选账号，请求走的是网关 env 里那把默认令牌。</template>
        </div>

        <div class="row" style="margin-top: 12px">
          <button class="ghost" @click="doLock">上锁（清掉内存里的密钥）</button>
        </div>
      </template>
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
          <template v-if="directMode">这一开关是直连模式下<b>唯一</b>的闸门：打开后写请求直接从这台设备发给 Cloudflare。</template>
          <template v-else>这一开关只解锁本机出口；网关那侧是否放行见下面的 writes 状态，两道闸门缺一不可。</template>
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
          <template v-if="directMode">
            <span class="badge">不存在</span>
            <span class="small muted">（直连模式没有网关这道闸门，写请求从本机直达 CF）</span>
          </template>
          <template v-else>
            <span v-if="gwWrites === 'enabled'" class="badge live">已放行</span>
            <span v-else-if="gwWrites === 'disabled'" class="badge">未放行</span>
            <span v-else class="badge">没测过 —— 点上方「保存并测试连接」才知道</span>
            <span class="small muted">（来自 /health 的 writes 字段，非猜测）</span>
          </template>
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
        <code>cfconsole.vault.v1</code>：<b>加密后</b>的账号列表 —— 口令经 PBKDF2-SHA256（31 万次）派生密钥，
        令牌用 AES-256-GCM 加密。口令本身不落盘、也不上传，解锁后的密钥只驻留内存，关页面或点「上锁」即丢：
        <b>把整份 localStorage 拖走也解不开</b>。<br />
        <code>cfconsole.config.v1</code>：网关地址 + 设备令牌 + 选定的账号 id 与名字（这些不是凭据，明文存）；
        外加本机偏好 <code>cfconsole.theme.v1</code> / <code>cfconsole.accent.v1</code> / <code>cfconsole.listCount.v1</code> / <code>cfconsole.writes.v1</code>。<br /><br />
        <b>边界说清楚</b>：加密防的是「存储被拖走 / 被云备份同步出去」这类<b>静态</b>窃取；解锁之后，同源的脚本照样能拿到令牌。
        所以别用全局 API Key，给每把令牌只勾它真正需要的权限，手机上加锁屏。<br /><br />
        设备令牌（<code>DEVICE_TOKENS</code>）仍然留着，但角色是「谁能用这个网关」；CF 令牌回答「用哪个账号的数据」。
        网关侧不长期保存 CF 令牌（请求自带、用完即弃），要停用某台设备就从 <code>DEVICE_TOKENS</code> 里删掉那一项。
        <template v-if="directMode"><br />直连模式（APK）下设备令牌用不到：请求不经过网关，鉴权就是本机保存的 CF 令牌本身。</template>
      </div>
    </div>

    <div class="card">
      <h3>写功能与还没开放的功能</h3>
      <div class="small muted">
        DNS 增删改、清缓存：本机契约与确认抽屉已就绪（见上面「写操作」）。
        <template v-if="directMode">
          实际能不能落到你的账号，只取决于本机开关这一道闸门（直连模式没有网关闸门）—— 默认关；打开后写请求直接从这台设备发给 CF。
        </template>
        <template v-else>
          实际能不能落到你的账号，取决于上面两道闸门的组合 —— 本机开关默认关；当前这台网关是否放行以 /health 的 writes 为准，没测过就是不知道，不猜。
        </template><br /><br />
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
