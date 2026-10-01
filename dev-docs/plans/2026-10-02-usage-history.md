# 用量历史记录（Usage History）实施计划

- 日期：2026-10-02
- 目标仓库：`~/dev/quota-peek`（OSS，main 分支，工作区干净，基线 `e2a0125`）
- 状态：待实现

## 1. 目标

给每张渠道卡片加一条**时间轴**，回答两个问题：

1. **用量怎么变的** —— 任意时刻回看某张卡的 `5h Window` / `Weekly` / `余额` 曲线，以及"比上一次刷新涨/跌了多少"。
2. **刷新那一刻是多少** —— 每一次取数（后台轮询 / 手动刷新 / 切回页面）都留一条样本，可回看"某次刷新时全渠道快照是什么、哪张卡失败了"。

现状：纯无状态。README 明确写着 "No cron. No database. No background jobs. Providers are queried live on every request."——本次要推翻这句话，所以**记录链路必须与实时取数解耦**：实时卡片的语义不变，记录是旁路。

## 2. 范围

### 做

- 服务端后台轮询（与浏览器无关），默认 5 分钟一轮，可 env 调/关。
- SQLite 落盘（better-sqlite3），原始样本保留 90 天，超期 prune。
- 每次取数记录：百分比、`used`/`total`/金额、**每个子账号分列**（Kimi/StepFun 的 `1`/`2`）、以及 `ok / not_configured / error` 状态。
- 卡片内 sparkline + 变化量徽标（`Δ`），窗口 rollover 时不误报暴跌。
- 独立 `/history` 页：曲线 + **刷新记录**（每次刷新一行）+ 范围切换 + CSV 导出。

### 不做（明确排除，防范围蔓延）

- 不把卡片改成"读缓存"模式（卡片仍实时取数），只加一个 60s 进程内结果缓存避免轮询/页面双打限流 API。
- 不做数据库服务/迁移框架/多用户鉴权。单文件、单进程。
- 不记录 `detail` 自由文本（Claude 的 per-model 明细太长且不稳定），只存 `label`。
- 不做告警/通知。

## 3. 架构

```
                    ┌──────────────── instrumentation.ts (register, 仅 nodejs runtime)
                    ▼
             lib/history/poller.ts ── setInterval(QP_POLL_INTERVAL_MS, 默认 5m)
                    │  globalThis Symbol.for 单例守卫；上一轮未完则跳过本轮
                    ├──► lib/providers/index.ts fetchOneUsage()  (已有)
                    ├──► lib/history/liveCache.ts  60s 结果缓存（页面复用，避免双打）
                    └──► lib/history/store.ts record(source='poll')

  页面 ──► /api/usage/[provider] ──► fetchOneUsage() ──► store.record(source='page')
                │                                             │
                └── 返回原 ProviderResponse（语义不变） ───────┘
                                                              ▼
                                          data/quota-peek.db  (sample + sample_row)

  卡片 ──► /api/history?since=6h  ──► 短窗口序列 → sparkline + Δ
  /history ──► /api/history/[provider]?range=7d ──► 分桶序列 + 刷新记录 → 曲线/表
```

要点：**两条取数路径都写样本**，`source` 列区分 `poll` / `page`。用户手滑连点 3 次刷新就是 3 条样本，这是事实记录，不去重（去重只用于"别把同一次结果写两遍"这种 bug 兜底）。

## 4. 数据模型

```sql
CREATE TABLE IF NOT EXISTS sample (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,             -- epoch ms，取数完成时刻
  provider   TEXT    NOT NULL,             -- ProviderKey
  source     TEXT    NOT NULL,             -- 'poll' | 'page'
  ok         INTEGER NOT NULL,             -- provider 返回了可用数据
  err_kind   TEXT,                         -- NULL | 'not_configured' | 'error'
  err_text   TEXT,                         -- 截断 500 字符
  plan_label TEXT,
  partial    INTEGER NOT NULL DEFAULT 0,   -- 合并卡片漏掉了部分账号
  stale      INTEGER NOT NULL DEFAULT 0    -- 命中 provider 自身缓存（如 Claude）
);
CREATE INDEX IF NOT EXISTS sample_provider_ts ON sample(provider, ts);

CREATE TABLE IF NOT EXISTS sample_row (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id INTEGER NOT NULL REFERENCES sample(id) ON DELETE CASCADE,
  scope     TEXT    NOT NULL,              -- 'merged' | 子账号 key（'1'/'2'…）
  kind      TEXT    NOT NULL,              -- '5h' | 'weekly' | 'monthly' | 'balance' | 'spend' | …
  label     TEXT,
  percent   REAL,
  used      REAL,
  total     REAL,
  unit      TEXT,                          -- '¥' | 'cr' | undefined
  reset_at  INTEGER,                       -- epoch ms，归一化；NULL=未知
  estimated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sample_row_series ON sample_row(sample_id, scope, kind);
```

- 归一化成两张表而不是塞 JSON：序列查询（变化量、分桶、rollover 判定）全是 `WHERE sample_id IN (...)` + 字段比较，JSON 得整取整解。
- 序列身份 = `(provider, scope, kind)`。Claude 的 per-model 行天然靠 `kind` 区分（如 `weekly_fable`）。
- 写入单事务（`db.transaction`），轮询失败不阻塞下一轮。
- `PRAGMA journal_mode=WAL` + `busy_timeout=5000`（页面读取与轮询写入并发）。

**量级估算**：11 渠道 × 288 轮/天 ≈ 3.2k 样本/天、约 7k 行/天 ⇒ 90 天 ≈ 63 万行，SQLite 加索引毫无压力 ⇒ **不做 rollup 表**，历史页靠 API 侧分桶降到 ≤400 点/序列。量真涨了再上 rollup。

## 5. 变化量与 rollover（最容易做错的地方）

朴素 `delta = 最新 - 上一条` 在窗口重置时会说谎：5h 窗口 98% → 重置 → 下一条 0%，直接算出 `-98%`。

规则（`lib/history/series.ts`）：

1. 找同 `(provider, scope, kind)` 的**上一条**样本行。
2. 若 `prev.reset_at` 与 `latest.reset_at` 都非空且**不相等**（且 `latest.reset_at > prev.reset_at`）⇒ 判定为窗口 rollover，**不显示 Δ**，改为 `↻` 标记，曲线在重置点断开。
3. 否则 `Δpercent = latest.percent - prev.percent`；绝对量行（`balance`/`spend`）用 `Δused`（金额型显示 `Δ¥`）。
4. `prev` 与 `latest` 间隔 > 30 min（轮询停了/机器睡了）⇒ Δ 仍给，但 tooltip 明示"距上次 N 分钟"，避免把长间隔斜率当趋势。
5. 曲线断点：相邻点间隔 > 3× 轮询间隔，或中间存在 `ok=0` 样本 ⇒ SVG 里断开，不连直线。

## 6. API

| 路由 | 用途 | 关键参数 |
| --- | --- | --- |
| `GET /api/history` | 卡片 sparkline 短窗口（所有渠道一次拿完） | `since=6h`（默认）、`max=40` 点/序列 |
| `GET /api/history/[provider]` | 历史页：分桶序列 + 刷新记录 | `range=24h\|7d\|30d`（默认 7d）、`scope=merged\|all`、`max=400` |
| `GET /api/history/[provider]/export` | CSV 导出（原始行，非分桶） | 同上 + `range` |

响应形态（`/api/history`）：

```json
{ "ok": true, "from": 1758…, "to": 1758…,
  "providers": { "claude": { "rows": { "merged:5h": { "kind": "5h", "unit": null,
      "points": [{ "t": 1758…, "p": 41.2 }], "delta": -1.8, "deltaAt": 1758…,
      "resetBreak": false, "abs": { "used": 12, "total": 30, "unit": null } } } } } }
```

`p` = percent（可用时），`u`/`n` = used/total（绝对量行必有）。`ok:false` 的 provider 返回 `errKind`，让卡片区分"没消耗"与"取数失败"。

## 7. 前端

### 卡片内（`components/ProviderCard.tsx` + 新 `components/Sparkline.tsx`）

- 取数 effect 里 `Promise.all([usage, history])`；history 失败**绝不影响**用量渲染（best-effort，跟 `probeConfigured` 同一哲学）。
- `Metric` 行尾挂 `Δ` 徽标 + 18px 高 sparkline；`balance`/money 行同样出（金额型曲线最有价值）。
- Δ 徽标配色跟现有 `pace over/under` 一致；rollover 显示 `↻ reset`。
- 子账号切换（Σ/1/2）时 sparkline 跟着切 scope。

### `/history` 页（新 `app/history/page.tsx` + `HistoryChart.tsx`）

- 顶部：渠道 pill 切换 + 范围 `24h / 7d / 30d` + `Export CSV`。
- 每个序列一张手写 SVG 折线图（不引图表库，保持"零依赖"；`ProviderCard` 本来就手搓）。零依赖这条是项目卖点，**不加 recharts**。
- 下方「刷新记录」表：时间 / 来源（poll·manual）/ 各渠道快照值 / 失败卡与原因。这就是"刷新时的用量"的可查形态。
- 曲线断点 + rollover 用竖虚线标出；错误样本在时间轴上打红点。

## 8. 配置、存储与部署

新增 env（全部有安全默认，不配也能跑）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `QP_POLL` | `1` | `0` 关掉后台轮询（`npm run dev` 时嫌吵就关） |
| `QP_POLL_INTERVAL_MS` | `300000` | 轮询间隔；下限强制 ≥60s |
| `QP_DATA_DIR` | `./data` | SQLite 落盘目录 |
| `QP_HISTORY_DAYS` | `90` | 原始样本保留天数，prune 每日一次 |

- `.gitignore` 加 `data/`（含 `data/*.db`、`*.db-wal`、`*.db-shm`）。
- **Docker 运行镜像 `node:20-alpine` → `node:20-slim`**：musl 上没有 better-sqlite3 预编译二进制，要么塞整套 build 工具链（alpine + python3/make/g++，镜像和构建时间都变重），要么换 glibc 基础镜像直接吃官方 prebuild。换 slim 是唯一不引编译链的路。`next.config.mjs` 加 `serverExternalPackages: ['better-sqlite3']`（standalone 打包必须让原生模块外置，否则 `NODE_MODULE_NOT_FOUND`）。
- `docker-compose.yml` 加卷 `./data:/app/data`，并在 compose 里把 uid 1000 的属主问题说明清楚（`USER node` 需要可写；宿主机目录先 `mkdir -p data && chown 1000:1000 data`）。
- 部署注意：这是**有状态**新增，容器 recreate 前历史在宿主机 `./data` 里，不随容器丢。

## 9. 测试

`npm test`（vitest，现有 120 个用例不许回归）新增：

- `lib/history/extract.test.ts` —— `ProviderResult` → 样本/行：合并视图、子账号、money 行 `percent` 缺失、`notConfigured`、`partial`、`stale`。
- `lib/history/store.test.ts` —— 写入/读回、序列身份 `(provider,scope,kind)`、分桶降采样（点数上限、时间对齐、avg）、prune 边界。**用临时目录真实 SQLite 文件**（原生模块本身要真跑才算测到）。
- `lib/history/series.test.ts` —— Δ 计算、**rollover 抑制**（`reset_at` 变化不出 `-98%`）、断点检测、跨 account scope 不串。
- `lib/history/poller.test.ts` —— fake timers：间隔正确、上一轮未完不重入、`QP_POLL=0` 不启动、单例不重复注册。
- `components/Sparkline.test.tsx` —— 纯函数出 points（宽度/极值/全等值/单点/空序列边界），沿用 `renderToStaticMarkup` 风格。
- `lib/history/liveCache.test.ts` —— 60s TTL 内复用、过期重取、失败不污染缓存。

外加手工验收：本地 `npm run dev` 挂 30s 间隔跑 5 分钟 → `/history` 至少有 10 条刷新记录、曲线有点、Δ 有值；`npm run build` 通过；`docker build` 通过且容器内 `/app/data` 可写。

## 10. 风险

| 风险 | 应对 |
| --- | --- |
| native 模块在 standalone 里被错误内联 | `serverExternalPackages` + 容器内真实跑一次读写冒烟 |
| 轮询把限流 API 打爆（Kimi OAuth ~15min、Anthropic 5min 窗口） | 60s `liveCache` 复用；间隔下限 60s；单轮内 provider 顺序执行不并发轰炸；轮询失败只记录不重试 |
| `instrumentation.ts` 在 dev 重复注册 / 在 `next build` 误跑 | `globalThis[Symbol.for('qp.poller')]` 单例守卫；`NEXT_RUNTIME==='nodejs'` 才启动 |
| 多进程（cluster/多副本）重复轮询 | 文档写明**单进程**假设；写库 `busy_timeout` 兜底 |
| 存储无限增长 | 90 天 prune + 量级估算已证明够用 |
| README 承诺失真 | 计划内同步改 README 的 "No cron/No database" 段落 |

## 11. 实施步骤

1. `lib/history/db.ts`（连接、schema、prune）+ `extract.ts` + `store.ts` + `series.ts`，配单测。
2. `liveCache.ts` + `poller.ts` + `instrumentation.ts`，配 fake-timer 单测。
3. `/api/history` + `/api/history/[provider]`(+export) 路由。
4. `Sparkline.tsx` + 卡片 Δ 徽标接线 + 单测。
5. `/history` 页（SVG 曲线 + 刷新记录 + 范围/导出）。
6. 配置收口：env、`.env.example`、`.gitignore`、Dockerfile（slim）、compose 卷。
7. `npm test` / `npm run build` / docker 冒烟全绿。
8. README + `.env.example` 文档更新，分步 commit（历史存储、轮询、卡片 UI、历史页、部署各自一个 commit）。
