<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import ErrorNote from "../components/ErrorNote.vue";
import UnavailableNote from "../components/board/UnavailableNote.vue";
import { api, gwHealth, gwMeta, GwError, isNativeApp, setWritesOptIn, writesOptIn, probeToken, type Account } from "../lib/api";
import { acctState, addAccount, findAccount, removeAccount, labelOf, createVault, unlockAccounts, lockAccounts, destroyAll, type CfAccount } from "../lib/accounts";
import { beginOAuthLogin, oauthClientCfg, saveOAuthClientCfg, REDIRECT_HINT, revokeOAuth } from "../lib/oauth";
import { baseSource } from "../lib/config";
import { THEME_OPTIONS, loadThemePref, saveThemePref, type ThemePref, ACCENT_OPTIONS, loadAccentPref, saveAccentPref, type AccentPref } from "../lib/theme";
import { LIST_PRESETS, listCount, setListCount } from "../lib/lists";
import { dt } from "../lib/fmt";
import { useGatewayStore } from "../stores/gateway";
import { APP_VERSION, ACCEL_BASES, checkUpdate, type UpdateInfo } from "../lib/version";

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
  // OAuth 账号：先把钥匙串里的授权撤掉（撤销失败也照样删本地，见 oauth.ts 的取舍）
  if (a.auth === "oauth" && a.credRef) void revokeOAuth(a.credRef);
  await removeAccount(a.id);
  if (gw.config.account === a.id) {
    const next = acctState.list[0];
    gw.save(next ? { account: next.id, accountName: labelOf(next) } : { account: "", accountName: "" });
  }
  await test();
}

/* ============================================================================
 * Cloudflare OAuth（Authorization Code + PKCE，仅 APK 直连）
 * 凭据边界：access token 只在内存；refresh token 进系统钥匙串（lib/oauth.ts）。
 * 这里只做三件事：存 client 参数、发起授权、把返回的账号选择后写进账号列表。
 * ========================================================================== */
const ocfg = ref(oauthClientCfg());
const oCfgNote = ref("");
const oBusy = ref(false);
const oErr = ref("");
/** 授权成功后待选的账号（一次授权可能看见多个账号；这里仍按「一个账号一条记录」存） */
const oCandidates = ref<Account[]>([]);
const oCredRef = ref("");
const oHasRefresh = ref(true);

function saveOAuthCfg() {
  oCfgNote.value = "";
  ocfg.value = saveOAuthClientCfg(ocfg.value);
  oCfgNote.value = "已保存到本机（重装应用会丢；构建期变量仍可给它兜底）";
}

async function doOAuthLogin() {
  if (oBusy.value) return;
  oErr.value = "";
  oCandidates.value = [];
  oBusy.value = true;
  try {
    const r = await beginOAuthLogin();
    oCredRef.value = r.credRef;
    oHasRefresh.value = r.hasRefresh;
    // 用刚换到的 access token 打一次 /accounts：既验证授权可用，又拿到要写进本地的账号元数据
    const list = (await probeToken(r.accessToken)).result;
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) {
      oErr.value = "授权成功，但这把 OAuth 令牌看不到任何账号 —— 多半是授权时没勾账号，或 OAuth client 缺 Account Read。";
      return;
    }
    if (arr.length === 1) {
      await addOAuthAccount(arr[0]);
    } else {
      oCandidates.value = arr;
    }
  } catch (e) {
    oErr.value = String((e as Error)?.message || e);
  } finally {
    oBusy.value = false;
  }
}

async function addOAuthAccount(a: Account) {
  const acc: CfAccount = { token: "", id: String(a.id), name: String(a.name || ""), alias: "", auth: "oauth", credRef: oCredRef.value };
  // 同一账号重新授权：旧的那条授权要撤掉，否则钥匙串里会留下一条永远用不到的 refresh token
  const prev = findAccount(acc.id);
  if (prev?.auth === "oauth" && prev.credRef && prev.credRef !== oCredRef.value) void revokeOAuth(prev.credRef);
  await addAccount(acc);
  if (!gw.config.account || acctState.list.length === 1) gw.save({ account: acc.id, accountName: labelOf(acc) });
  oCandidates.value = [];
  await test();
}

async function test() {
  testing.value = true;
  result.value = {};
  const saved = { ...gw.config };
  // 直连模式（APK）没有网关地址 / 设备令牌这两样东西，测试就是拿本机令牌打一次 CF，
  // 别把空串覆盖进 config —— 那两个字段在 APK 里既不显示也不生效。
  if (!directMode) gw.save({ baseUrl: baseUrl.value, deviceToken: token.value });
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
    if (!directMode) gw.save(saved);          // 连不上就别把坏配置留下
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
  // 长解释搬去了 docs/14 §5，界面只留一句"现在是什么状态、下一步做什么"
  if (directMode) {
    return allowWrites.value
      ? "已打开：写请求直接从这台设备发给 Cloudflare，每个动作发出前仍逐条确认。"
      : "关着：写请求不出这台设备（直连模式这是唯一的闸门）。";
  }
  if (!allowWrites.value) return "本地闸门关着：写请求不出这台设备，网关那侧什么状态都不影响这条。";
  if (gwWrites.value === "enabled") return "两道闸门都开着：写操作会真实生效，发出前仍逐条确认。";
  if (gwWrites.value === "disabled") return "网关这侧 WRITE_ENABLED 没放行：请求会被 501 拒绝，处置在网关侧（docs/14 §5）。";
  return "本地已打开；网关状态未知，先点「保存并测试连接」。";
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

/* ---------- 版本 / 更新检查（lib/version.ts） ---------- */
const checking = ref(false);
const checked = ref(false);
const update = ref<UpdateInfo | null>(null);
const updateErr = ref("");
async function doCheckUpdate() {
  checking.value = true;
  updateErr.value = "";
  update.value = null;
  try {
    update.value = await checkUpdate();
    checked.value = true;
  } catch (e) {
    checked.value = false;
    updateErr.value = String((e as Error)?.message || e);
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <div class="set">
    <!-- ============ 连接 ============ -->
    <div class="card wide">
      <h3>{{ directMode ? "连接（APK 直连）" : "网关配置" }}</h3>
      <template v-if="directMode">
        <div class="small muted" style="margin-bottom: 10px">
          当前生效：<b>直连 api.cloudflare.com</b> · 账号：{{ savedAccount }}
        </div>
        <div class="row">
          <button class="primary" :disabled="testing" @click="test">{{ testing ? "测试中" : "测试直连连接" }}</button>
        </div>
      </template>
      <template v-else>
        <!-- 这台设备现在真的走哪个网关、哪个账号：措辞按"生效/草稿"分开 -->
        <div class="small muted" style="margin-bottom: 10px">
          <template v-if="gw.configured">
            当前生效：<code>{{ savedBase.base }}</code>（来源：{{ savedBase.from }}）· 账号：{{ savedAccount }}
          </template>
          <template v-else>当前状态：<b>未配置</b> —— 还没有设备令牌，除了本页哪一屏都进不去（顶栏那个红点就是它）。</template>
        </div>
        <label class="lbl">网关地址（留空 = {{ baseInfo.from }}）</label>
        <input v-model="baseUrl" class="field" placeholder="https://控制台域名.你的站点" spellcheck="false" />

        <label class="lbl" style="margin-top: 10px">设备令牌（网关没配名单可留空）</label>
        <div class="row">
          <!-- 不用 type=password：WebView 里它会唤起"安全键盘"，第三方输入法直接失效。
               这里用 -webkit-text-security 做同款圆点遮罩，行为一致且输入法照常。 -->
          <input v-model="token" class="field sec" :class="{ plain: reveal }" style="flex: 1" type="text" autocomplete="off" spellcheck="false" />
          <button class="ghost" @click="reveal = !reveal">{{ reveal ? "隐藏" : "显示" }}</button>
        </div>

        <div class="row" style="margin-top: 12px">
          <button class="primary" :disabled="testing" @click="test">{{ testing ? "测试中" : "保存并测试连接" }}</button>
        </div>
      </template>
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
      <!-- 各档位的设计考量与生效范围见 docs/14 §2，界面不再复述 -->
    </div>

    <!-- ============ 版本 / 更新 ============ -->
    <div class="card">
      <h3>版本</h3>
      <div class="small muted">
        当前版本：<code>{{ APP_VERSION }}</code> · 检查更新{{ ACCEL_BASES.length ? `走加速域名 ${ACCEL_BASES.join(" → ")}${ACCEL_BASES.length > 1 ? "（坏了自动换下一个）" : ""}` : "直连 GitHub" }}。
      </div>
      <div class="row" style="margin-top: 10px">
        <button class="primary" :disabled="checking" @click="doCheckUpdate">{{ checking ? "检查中…" : "检查更新" }}</button>
        <a v-if="update" class="chip" :href="update.downloadUrl" target="_blank" rel="noopener">打开下载页</a>
        <a v-if="update" class="chip" :href="update.notesUrl" target="_blank" rel="noopener">发行说明</a>
      </div>
      <div v-if="update" class="small" style="margin-top: 8px">
        发现新版本 <b>v{{ update.version }}</b> —— 下载页已带加速前缀，进去挑最新的 APK 装上即可。
      </div>
      <div v-else-if="checked" class="small muted" style="margin-top: 8px">已是最新版本。</div>
      <div v-if="updateErr" class="small" style="color: var(--bad); margin-top: 8px">{{ updateErr }}</div>
    </div>

    <!-- ============ 账号（CF 令牌，本机保管）============ -->
    <div class="card wide">
      <h3>账号（CF 令牌）</h3>
      <div class="small muted">
        一个账号 = 一把 Cloudflare API Token，{{ directMode ? "本机随机密钥自动加密保存（无需口令），直连 Cloudflare" : "口令加密保存，每次请求现取现带给网关、不留副本" }}。
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
            <!-- 同上：type=password 的"安全键盘"在 WebView 里弊大于利，改用 CSS 圆点遮罩 -->
            <input v-model="newToken" class="field sec" :class="{ plain: revealNew }" style="flex: 1" type="text" placeholder="粘一把 API Token" autocomplete="off" spellcheck="false" />
            <button class="ghost" @click="revealNew = !revealNew">{{ revealNew ? "隐藏" : "显示" }}</button>
          </div>
          <div class="row" style="margin-top: 10px">
            <button class="primary" :disabled="adding" @click="addAcc">{{ adding ? "验证中…" : "验证并添加" }}</button>
          </div>
          <ErrorNote :err="addErr || undefined" />
        </div>

        <div v-if="accts.length" class="list" style="margin-top: 12px">
          <div v-for="a in accts" :key="a.id" class="item">
            <div class="k">
              {{ labelOf(a) }}
              <span v-if="a.auth === 'oauth'" class="badge live" style="margin-left: 6px">OAuth</span>
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

        <div v-if="!directMode" class="row" style="margin-top: 12px">
          <button class="ghost" @click="doLock">上锁（清掉内存里的密钥）</button>
          <span class="small muted">上锁后要重新输口令才能取数。</span>
        </div>
      </template>
    </div>

    <!-- ============ Cloudflare OAuth（仅 APK 直连）============ -->
    <div v-if="directMode" class="card wide">
      <h3>Cloudflare OAuth 登录</h3>
      <div class="small muted">
        Authorization Code + PKCE，公共客户端（无 secret）。授权在<b>系统浏览器</b>里完成，
        换到的 access token 只留内存，refresh token 存系统钥匙串；请求直连 Cloudflare，不经过任何中间服务器。
        <br />需要先在 Cloudflare 后台建好 OAuth client，并把下面的 redirect_uri 原样登记进去。
      </div>

      <label class="lbl" style="margin-top: 12px">OAuth client_id</label>
      <input v-model="ocfg.clientId" class="field" placeholder="在 CF 后台 OAuth clients 里创建后得到" spellcheck="false" />

      <label class="lbl" style="margin-top: 8px">redirect_uri</label>
      <input v-model="ocfg.redirect" class="field" :placeholder="REDIRECT_HINT" spellcheck="false" />

      <label class="lbl" style="margin-top: 8px">scope（可选，留空 = 按 client 注册时勾选的）</label>
      <input v-model="ocfg.scope" class="field" placeholder="例：account:read offline_access" spellcheck="false" />

      <div class="row" style="margin-top: 12px">
        <button class="ghost" @click="saveOAuthCfg">保存本机配置</button>
        <button class="primary" :disabled="oBusy" @click="doOAuthLogin">{{ oBusy ? "授权中…" : "用 Cloudflare 登录" }}</button>
        <router-link class="chip" to="/settings/tokens">管理 API 令牌</router-link>
      </div>
      <div v-if="oCfgNote" class="small muted" style="margin-top: 8px">{{ oCfgNote }}</div>
      <div v-if="oErr" class="small" style="color: var(--bad); margin-top: 8px">{{ oErr }}</div>
      <div v-if="!oHasRefresh && !oCandidates.length && accts.some((a) => a.auth === 'oauth')" class="small muted" style="margin-top: 8px">
        这次授权没有拿到 refresh token（缺 <code>offline_access</code>）：重开应用要重新登录。
      </div>

      <!-- 一次授权看见多个账号：让用户挑一个写进本地；其余账号再授权一次即可 -->
      <div v-if="oCandidates.length" class="oauth-pick">
        <div class="small"><b>这次授权可见 {{ oCandidates.length }} 个账号</b>，选一个加到本机：</div>
        <div class="list" style="margin-top: 8px">
          <div v-for="a in oCandidates" :key="a.id" class="item">
            <div class="k">{{ a.name }}<div class="small muted">{{ a.id.slice(0, 8) }}…</div></div>
            <button class="chip" @click="addOAuthAccount(a)">加这个</button>
          </div>
        </div>
        <div class="small muted" style="margin-top: 6px">
          其余账号：再点一次「用 Cloudflare 登录」并选对应账号 —— 一次授权对应本地一条账号记录。
        </div>
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
          打开后，<b>DNS 新增 / 修改 / 删除</b> 与 <b>清缓存</b> 会<b>真的作用于你选定的 Cloudflare 账号</b>
          （当前：{{ gw.config.accountName || (gw.config.account ? gw.config.account.slice(0, 8) + "…" : "网关默认账号") }}）。
          每个动作发出前仍会回显完整请求并要求确认。
          <div class="row" style="margin-top: 10px">
            <button class="primary" @click="commitOpenWrites">确认打开</button>
            <button class="ghost" @click="confirmOpenWrites = false">先不打开</button>
          </div>
        </div>
      </template>

      <dl class="kv" style="margin-top: 12px">
        <dt>本机闸门</dt>
        <dd>{{ allowWrites ? "开" : "关（默认）" }}</dd>
        <dt v-if="!directMode">网关闸门</dt>
        <dd v-if="!directMode">
          <span v-if="gwWrites === 'enabled'" class="badge live">已放行</span>
          <span v-else-if="gwWrites === 'disabled'" class="badge">未放行</span>
          <span v-else class="badge">没测过</span>
        </dd>
      </dl>
      <div class="small" style="margin-top: 8px">{{ writeGateNote }}</div>
    </div>

    <!-- ============ 运行 ============ -->
    <div class="card wide">
      <h3>请求预算（调度器账本）</h3>
      <div class="small muted">
        进 App 拉一轮，之后每 5 分钟一轮；后台不打，回前台按需补。当前数据：{{ ageText }}。<span v-if="budgetRunning">这一轮正在跑…</span>
      </div>
      <dl class="kv" style="margin-top: 10px">
        <dt>调度轮次数</dt><dd>{{ gw.budget.rounds }} 轮</dd>
        <dt>最近一轮</dt>
        <dd v-if="gw.budget.lastRoundAt">{{ dt(gw.budget.lastRoundAt) }} · 发网关 {{ gw.budget.last.requests }} 条 / 本机缓存命中 {{ gw.budget.last.localHits }} 条 / 回源 CF {{ gw.budget.last.cfCalls }} 次 / 失败 {{ gw.budget.last.errors }} 块</dd>
        <dd v-else>还没跑过第一轮</dd>
        <dt>累计</dt>
        <dd>发网关 {{ gw.budget.total.requests }} 条 · 回源 CF {{ gw.budget.total.cfCalls }} 次 · 缓存命中 {{ gw.budget.total.localHits }} 条</dd>
        <dt>下一轮</dt><dd>{{ gw.nextRoundNote }}</dd>
      </dl>
      <div class="row" style="margin-top: 10px">
        <button class="ghost" :disabled="budgetRunning || !gw.configured" @click="gw.roundNow()">立刻走一轮</button>
        <button class="ghost" :disabled="budgetRunning || !gw.configured" @click="gw.roundForceFresh()">强制新取一轮</button>
      </div>
      <!-- 口径说明（只覆盖调度器请求、x-gw-cf-calls 是实测口径等）见 docs/14 §6 -->
    </div>

    <!-- 看板上的「取不到」清单搬到这里了（10-11：读数面只放数，介绍进设置） -->
    <div class="wide"><UnavailableNote /></div>

    <!-- ============ 说明 ============ -->
    <div class="card">
      <h3>这台设备存了什么</h3>
      <div class="small muted">
        账号令牌（{{ directMode ? "API Token：随机密钥加密，无口令；OAuth：refresh token 进系统钥匙串、access token 只在内存" : "口令加密" }}）+ 界面偏好，全部只存本机、不上云。
        存储键清单与加密的边界（防什么、不防什么）见 <code>docs/14</code> §4。
      </div>
    </div>

    <div class="card">
      <h3>已就绪与未开放</h3>
      <div class="small muted">
        已就绪：DNS 增删改、清缓存、版本切换 / 回滚 / 灰度（见「写操作」的本机开关，默认关）。<br />
        未开放：版本删除、Pages 部署、写 secret、改 cron、实时日志（Tail）—— 原因与实测依据见 <code>docs/14</code> §7。
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
.oauth-pick { margin-top: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; }
.opt-h { font-size: var(--t-xs); color: var(--muted); letter-spacing: .04em; margin-bottom: 6px; }
/* 强调色预览点：这是"选项本身"的固定色，不是界面当前色，所以写字面值 */
.dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; border: 1px solid rgb(0 0 0 / .18); }
.dot[data-a="orange"] { background: #a8480a; }
.dot[data-a="blue"] { background: #1e5cc8; }
/* 令牌输入的圆点遮罩：type=password 会唤起 WebView 的"安全键盘"（第三方输入法失效、
   粘贴被拦），所以输入框永远是 type=text，遮罩用 -webkit-text-security 实现。
   浏览器不支持这个属性时输入会显示明文 —— 有"显示/隐藏"按钮兜底，可接受。 */
.sec { -webkit-text-security: disc; }
.sec.plain { -webkit-text-security: none; }
</style>
