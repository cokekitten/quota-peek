/**
 * 浪费榜：每个额度窗口在「重置那一刻」没用完的比例。
 *
 *   node scripts/waste-leaderboard.mjs [db 路径]      默认 data/quota-peek.db
 *
 * ── 切窗口径 ─────────────────────────────────────────────
 * 库里每条读数带一个 reset_at（provider 声称的窗口重置时刻），但它并不可靠：
 *   · Gemini 5h / 3P 5h 的 reset_at = 采样时刻 + 5h，是随查询滑动的倒计时，
 *     每条读数都在动 —— 按它切窗会切出几百个假窗口；
 *   · MiniMax 5h 的 reset_at 会在近期的 20:00 和两周后的日期之间乱跳；
 *   · Kimi / GLM 的 merged 行把多个账号合成一根柱，reset_at 取「最近一个要重置的
 *     账号」，percent 却是三账号之和 —— 一根柱两种口径。
 * 所以先判断每条时间线的重置时钟是否稳定（相邻读数 reset_at 相差 ≤5 分钟的比例
 * ≥80% 视为可信），可信就按 reset_at 切窗；不可信就按「用量骤降」切窗
 * （percent 相对上一条读数回落 ≥5 个百分点即视为换窗，窗口末用量 = 骤降前那次读数）。
 * 阈值与 lib/history/series.ts 的 RESET_TOLERANCE_MS 一致。
 * 多账号计划（Kimi 3 个、GLM 2 个）只按账号逐条统计，不使用 merged 行。
 * 还在进行中（尚未重置）的窗口不进榜。
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const Database = req('better-sqlite3');

const db = new Database(path.resolve(process.argv[2] ?? 'data/quota-peek.db'), { readonly: true });

const TOLERANCE_MS = 5 * 60_000;
const DROP_POINTS = 5;          // 用量骤降多少个百分点算换窗
/** 周期标称长度（毫秒）：用来判断 provider 报的 reset_at 是不是离谱值。 */
const NOMINAL = {
  '5h': 5 * 3600e3, '3p_5h': 5 * 3600e3,
  weekly: 7 * 864e5, '3p_weekly': 7 * 864e5,
  monthly: 31 * 864e5,
};
/** reset_at 允许的宽容度：多给 1/4 周期，容下 provider 的对齐误差。 */
const SLACK = (kind) => (NOMINAL[kind] ?? 7 * 864e5) * 0.25;
const NAME = {
  kimi: 'Kimi 会员', codex: 'Codex Pro', glm: 'GLM Max', gemini: 'Gemini Google One',
  minimax: 'MiniMax Ultra', supergrok: 'SuperGrok Heavy', mimo: 'MiMo Max',
  stepfun: 'StepFun Max', deepseek: 'DeepSeek', openrouter: 'OpenRouter',
  cursor: 'Cursor Ultra',
};
const PERIOD = { '5h': '5h 窗', '3p_5h': '5h 窗(3P)', weekly: '周', '3p_weekly': '周(3P)', monthly: '月' };

const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** 中日韩字符按 2 列宽估算，其余按 1 列，保证表格能对齐。 */
const width = (x) => [...String(x)].reduce((a, c) => a + (/[　-鿿＀-｠]/.test(c) ? 2 : 1), 0);
const padS = (s, n) => { let o = String(s); while (width(o) < n) o += ' '; return o; };   // 左对齐
const padE = (s, n) => { let o = String(s); while (width(o) < n) o = ' ' + o; return o; }; // 右对齐
const pad = padS;

// ---------- 1. 读数 ----------
const rows = db.prepare(`
  SELECT s.provider, s.ts, r.scope, r.kind, r.label, r.percent, r.used, r.total, r.unit, r.reset_at
    FROM sample_row r JOIN sample s ON s.id = r.sample_id
   WHERE s.ok = 1 AND r.percent IS NOT NULL
   ORDER BY s.provider, r.scope, r.kind, s.ts
`).all();

const series = new Map();
for (const r of rows) {
  const key = `${r.provider}|${r.scope}|${r.kind}`;
  if (!series.has(key)) series.set(key, []);
  series.get(key).push(r);
}

// ---------- 2. 逐时间线切窗 ----------
const meta = [];
const rolling = [];
const windows = [];
const now = Date.now();

for (const [key, pts] of series) {
  const [provider, scope, kind] = key.split('|');
  if (kind === 'spend') continue;
  // 多账号计划只看账号行，merged 行口径不纯
  const hasAccounts = [...series.keys()].some((k) => {
    const [p, sc, kk] = k.split('|');
    return p === provider && kk === kind && sc !== 'merged';
  });
  if (scope === 'merged' && hasAccounts) { meta.push({ key, provider, scope, kind, skipped: 'merged 行（多账号口径不纯）' }); continue; }

  // ── reset_at 合理性校验 ──
  // MiniMax 5h 实测会在正常的 5h 窗口里突然报出 10-14 / 10-21 这种两周后的日期，
  // 那是另一个字段（套餐续费时间）串了位。不校验就会把一个 5h 窗切成十几个假窗。
  for (const p of pts) {
    if (p.reset_at == null) continue;
    if (p.reset_at < p.ts - TOLERANCE_MS || p.reset_at > p.ts + NOMINAL[kind] + SLACK(kind)) {
      p.reset_at = null;
      p.badClock = (p.badClock ?? 0) + 1;
    }
  }

  // 重置时钟的两种病：①时钟乱跳（稳定率低）②根本没有时钟（reset_at ≡ 采样时刻+周期）
  let stable = 0, cmp = 0, withClock = 0;
  const countdowns = [];
  for (const p of pts) if (p.reset_at != null) withClock += 1;
  for (const p of pts) if (p.reset_at != null) countdowns.push(p.reset_at - p.ts);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].reset_at, b = pts[i].reset_at;
    if (a == null || b == null) continue;
    cmp += 1;
    if (Math.abs(b - a) <= TOLERANCE_MS) stable += 1;
  }
  const clockOk = cmp > 0 && stable / cmp >= 0.8;
  const span = pts[pts.length - 1].ts - pts[0].ts;
  const nominal = NOMINAL[kind] ?? 7 * 864e5;
  // 滚动窗口的 countdown 恒等于周期长度（median ≈ 100% 周期）；真窗口的 countdown
  // 从周期长度一路走到 0，median ≈ 半个周期。取 median 而非极值，才不会被零星抖动骗。
  const cdMedian = countdowns.length ? median(countdowns) : 0;
  const rollingClock = withClock / pts.length >= 0.8 && cdMedian > nominal * 0.9
    && span > nominal * 2;
  if (rollingClock) {
    // reset_at ≡ 采样时刻 + 周期（Gemini 5h / 3P 5h 实测如此）——这是滚动回看，
    // 根本没有「重置」那一刻，不能进浪费榜，只报当前水位。
    meta.push({ key, provider, scope, kind, method: '滚动窗口（无重置）', stableRate: cmp ? stable / cmp : 0,
                cdMedian: cdMedian / nominal });
    rolling.push({ provider, scope, kind, pts });
    continue;
  }
  if (withClock / pts.length < 0.5) {
    meta.push({ key, provider, scope, kind, method: '无重置时钟（无法切窗）' });
    continue;
  }
  meta.push({ key, provider, scope, kind, method: clockOk ? '重置时钟' : '重置时钟（不稳定）',
              stableRate: cmp ? stable / cmp : 0, cdMedian: cdMedian / nominal,
              badClock: pts.reduce((a, p) => a + (p.badClock ?? 0), 0) });

  // ── 切窗：只信重置时钟 ──
  // 「用量骤降就切窗」试过，会把 provider 在边界抖出的瞬时 0%（GLM 实测每个窗口边界
  // 都有，时钟那会儿还没跳）切成假窗口，把浪费率顶到 100%。时钟过滤掉离谱值后，
  // 剩下每条时间线的边界间隔都很干净（5.0/4.0h、168h），所以只按时钟切。
  let cur = null;
  for (const p of pts) {
    // 向前跳半个周期以上才算换窗：provider 会串进别的字段（MiniMax 实测报过 10:39、
    // 10-14 这种值），只判「变了」会把一个 5h 窗切成十几个假窗。
    const rolled = cur && cur.resetAt != null && p.reset_at != null
      && (p.reset_at - cur.resetAt) >= nominal * 0.5;
    if (rolled && p.ts - cur.startTs >= 20 * 60_000) {
      windows.push(cur);
      cur = { provider, scope, kind, end: p.percent, peak: p.percent, samples: 1, startTs: p.ts, endTs: p.ts,
              resetAt: p.reset_at, total: p.total, unit: p.unit, usedEnd: p.used };
      continue;
    }
    if (!cur) {
      cur = { provider, scope, kind, end: p.percent, peak: p.percent, samples: 1, startTs: p.ts, endTs: p.ts,
              resetAt: p.reset_at, total: p.total, unit: p.unit, usedEnd: p.used };
      continue;
    }
    // 窗口末用量只认「带有效时钟且时钟没变」的读数。两个原因：
    //  · 边界那两三次采样 provider 会报 reset_at = null（用量已归零、时钟还没跳），
    //    把它们当成末次读数，会把「用满 100% 的窗口」误报成「浪费 100%」；
    //  · 同一时钟下用量突然回落 ≥5 个百分点，是采样噪声。
    const clockKnown = p.reset_at != null;
    const sameClock = clockKnown && cur.resetAt != null && Math.abs(p.reset_at - cur.resetAt) <= TOLERANCE_MS;
    const glitch = sameClock && p.percent <= cur.end - DROP_POINTS;
    cur.samples += 1;
    cur.endTs = p.ts;
    cur.peak = Math.max(cur.peak, p.percent);
    if (clockKnown && !glitch) {
      cur.end = p.percent;
      cur.usedEnd = p.used;
    }
    if (clockKnown) cur.resetAt = p.reset_at;
    cur.total = p.total;
  }
  if (cur) windows.push(cur);
}

// 只保留已经重置过的窗口（reset_at 已过），进行中的窗口不进榜
const closed = [];
for (const w of windows) {
  if (w.resetAt != null && w.resetAt <= now) { closed.push({ ...w, unused: Math.max(0, 100 - w.end) }); }
}

// 调试：QP_DUMP=provider|scope|kind 打印切出来的每個窗口
if (process.env.QP_DUMP) {
  const want = process.env.QP_DUMP.split('|').join('|');
  for (const w of windows.filter((w) => `${w.provider}|${w.scope}|${w.kind}` === want)) {
    console.log(`${fmt(w.startTs)} → ${fmt(w.endTs)}  时钟 ${w.resetAt ? fmt(w.resetAt) : '无'}`
      + `  末次 ${w.end.toFixed(0)}%  峰值 ${w.peak.toFixed(0)}%  读数 ${w.samples}`);
  }
  process.exit(0);
}

const plan = (w) => NAME[w.provider] ?? w.provider;
const acct = (w) => (w.scope === 'merged' ? '合计' : `账号${w.scope}`);
const per = (w) => PERIOD[w.kind] ?? w.kind;

// ---------- 3. 聚合 ----------
const stats = (ws) => {
  const u = ws.map((w) => w.unused);
  return {
    n: ws.length, mean: mean(u), med: median(u),
    idle: ws.filter((w) => w.peak <= 0.5).length,
    full: ws.filter((w) => w.peak >= 90).length,
    peakMean: mean(ws.map((w) => w.peak)),
    last: ws.reduce((a, b) => (a.endTs >= b.endTs ? a : b)),
    best: ws.reduce((a, b) => (a.end >= b.end ? a : b)),
    byTime: [...ws].sort((a, b) => a.resetAt - b.resetAt),
  };
};
const byPlan = new Map();     // 计划 × 周期
const byAcct = new Map();     // 计划 · 账号 × 周期
for (const w of closed) {
  for (const [m, k] of [[byPlan, `${plan(w)}|${per(w)}`], [byAcct, `${plan(w)} · ${acct(w)}|${per(w)}`]]) {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(w);
  }
}

const out = [];
const p = (s = '') => out.push(s);
const R = '═'.repeat(112);

p(`数据 ${fmt(Math.min(...rows.map((r) => r.ts)))} → ${fmt(Math.max(...rows.map((r) => r.ts)))}`
  + `　有效读数 ${rows.length} 条　已重置窗口 ${closed.length} 个（进行中的窗口不计）`);
p();

p(R);
p('【主榜】重置时平均没用完的比例 —— 同周期长度内按浪费率降序（多账号计划按账号窗口合并统计）');
p(R);
p(padS('计划', 20) + padS('周期', 11) + padE('已重置', 7) + padE('平均没用完', 11) + padE('中位', 8)
  + padE('空窗', 10) + padE('顶满≥90%', 11) + '   最近一次重置');
for (const group of ['5h 窗', '5h 窗(3P)', '周', '周(3P)', '月']) {
  const list = [...byPlan.entries()].filter(([k]) => k.endsWith(`|${group}`))
    .map(([k, ws]) => [k.split('|')[0], stats(ws)]).sort((a, b) => b[1].mean - a[1].mean);
  if (!list.length) continue;
  p('─'.repeat(112));
  for (const [name, s] of list) {
    p(padS(name, 20) + padS(group, 11) + padE(s.n, 6) + '  ' + padE(s.mean.toFixed(1) + '%', 10)
      + '  ' + padE(s.med.toFixed(1) + '%', 7) + '   ' + padE(`${s.idle}/${s.n}`, 9) + '   '
      + padE(`${s.full}/${s.n}`, 10) + '  ' + fmt(s.last.resetAt) + ` 用到 ${s.last.end.toFixed(0)}%`);
  }
}

p();
p(R);
p('【账号榜】多账号计划逐账号（周 / 月窗口最能说明钱白花在哪）');
p(R);
p(padS('计划 · 账号', 24) + padS('周期', 11) + padE('已重置', 7) + padE('平均没用完', 11) + padE('中位', 8)
  + padE('空窗', 10) + padE('顶满≥90%', 11) + '   平均峰值');
for (const group of ['周', '周(3P)', '月', '5h 窗', '5h 窗(3P)']) {
  const list = [...byAcct.entries()].filter(([k]) => k.endsWith(`|${group}`))
    .map(([k, ws]) => [k.replace(`|${group}`, ''), stats(ws)]).sort((a, b) => b[1].mean - a[1].mean);
  if (!list.length) continue;
  p('─'.repeat(112));
  for (const [name, s] of list) {
    p(padS(name, 24) + padS(group, 11) + padE(s.n, 6) + '  ' + padE(s.mean.toFixed(1) + '%', 10)
      + '  ' + padE(s.med.toFixed(1) + '%', 7) + '   ' + padE(`${s.idle}/${s.n}`, 9) + '   '
      + padE(`${s.full}/${s.n}`, 10) + '  ' + s.peakMean.toFixed(1) + '%');
  }
}

p();
p(R);
p('【每次重置的时间线】每个计划最近 12 次重置时没用完的比例（%，越靠右越近）');
p(R);
for (const [k, ws] of [...byAcct.entries()].sort()) {
  const s = stats(ws);
  const seq = s.byTime.slice(-12).map((w) => (w.unused >= 99.5 ? '100' : w.unused.toFixed(0).padStart(3)));
  p(padS(k.replace('|', '  '), 24) + ' ' + seq.join(' '));
}

p();
p(R);
p('【单次重置榜】最浪费的 12 个窗口（整窗峰值不到 5% 的空窗不参与排名，它们全是 ~100% 浪费，排不出信息）');
p(R);
const used = closed.filter((w) => w.peak > 5).sort((a, b) => b.unused - a.unused);
const blanks = closed.filter((w) => w.peak <= 5);
for (const w of used.slice(0, 12)) {
  p(`  ${fmt(w.resetAt)}  ${padS(plan(w) + ' · ' + acct(w), 24)} ${padS(per(w), 11)}`
    + `末次 ${padE(w.end.toFixed(0) + '%', 5)} 峰值 ${padE(w.peak.toFixed(0) + '%', 5)} → 浪费 ${w.unused.toFixed(0)}%`
    + (w.total ? `（≈ ${money(w.total * w.unused / 100, w.unit)} / 额度 ${money(w.total, w.unit)}）` : ''));
}
p(`  另有 ${blanks.length} 个整窗峰值 ≤5% 的空窗（平均浪费 ${mean(blanks.map((w) => w.unused)).toFixed(0)}%），不逐条列出`);
p();
p('  —— 反向：额度用得最足的 8 次重置 ——');
for (const w of used.slice(-8).reverse()) {
  p(`  ${fmt(w.resetAt)}  ${padS(plan(w) + ' · ' + acct(w), 24)} ${padS(per(w), 11)}`
    + `末次 ${padE(w.end.toFixed(0) + '%', 5)} 峰值 ${padE(w.peak.toFixed(0) + '%', 5)} → 只浪费 ${w.unused.toFixed(0)}%`
    + (w.total ? `（≈ ${money(w.total * w.unused / 100, w.unit)}）` : ''));
}

function money(n, unit) {
  if (unit === 'cr') return `${(n / 1e8).toFixed(2)} 亿cr`;
  if (unit === '¥' || unit === '$') return `${n.toFixed(2)}${unit}`;
  return `${Math.round(n).toLocaleString('en-US')}tok`;
}

p();
p(R);
p('【充值 / 余额类】没有重置窗，看当前水位（余额不过期，只看本月消费占比）');
p(R);
for (const r of db.prepare(`
  SELECT s.provider, r.percent, r.used, r.total, r.unit, r.reset_at
    FROM sample_row r JOIN sample s ON s.id = r.sample_id
   WHERE s.ok = 1 AND r.kind = 'spend' AND s.id = (SELECT MAX(id) FROM sample WHERE provider = s.provider)
   GROUP BY s.provider`).all()) {
  p(`  ${padS(NAME[r.provider] ?? r.provider, 18)} 已消费 ${padE((r.used?.toFixed(2) ?? '-') + ' ' + r.unit, 14)}`
    + `余额 ${padE((r.total?.toFixed(2) ?? '-') + ' ' + r.unit, 12)} → 消费占比 ${r.percent.toFixed(1)}%`
    + `（消费口径 ${fmt(r.reset_at)} 重置）`);
}

p();
p(R);
p('【滚动窗口】provider 报的重置时刻 ≡ 采样时刻+周期（Gemini 5h），它没有「重置那一刻」，不进浪费榜，只看水位');
p(R);
for (const r of rolling) {
  const vals = r.pts.map((x) => x.percent);
  p(`  ${padS(NAME[r.provider] + ' · ' + (r.scope === 'merged' ? '合计' : '账号' + r.scope), 24)} ${padS(PERIOD[r.kind], 11)}`
    + `当前 ${vals[vals.length - 1].toFixed(1)}%　历史峰值 ${Math.max(...vals).toFixed(1)}%`
    + `　非零读数 ${vals.filter((v) => v > 0.5).length}/${vals.length}`);
}

p();
p(R);
p('【切窗口径明细】每条时间线用什么方法切窗');
p(R);
for (const m of meta) {
  if (m.skipped) { p(`  ${padS(m.key, 34)} 跳过：${m.skipped}`); continue; }
  p(`  ${padS(m.key, 34)} ${m.method}（重置时钟稳定率 ${(m.stableRate * 100).toFixed(0)}%`
    + `${m.cdMedian != null ? `，倒计时中位 ${(m.cdMedian * 100).toFixed(0)}% 周期` : ''}`
    + `${m.badClock ? `，另剔除 ${m.badClock} 条离谱重置时刻` : ''}）`);
}

console.log(out.join('\n'));
