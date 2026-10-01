/**
 * Seed a throwaway history DB with synthetic samples so the dashboard and
 * /history can be eyeballed without waiting days for real data.
 *
 *   node scripts/seed-demo-history.mjs /tmp/qp-visual 24
 *
 * Purely a development aid: it writes to the QP_DATA_DIR you pass and never
 * touches a real database.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const dir = process.argv[2] ?? '/tmp/qp-visual';
const hours = Number(process.argv[3] ?? 24);
const req = createRequire(import.meta.url);
const Database = req('better-sqlite3');
const { mkdirSync } = await import('node:fs');

mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'quota-peek.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sample (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL,
    source TEXT NOT NULL, ok INTEGER NOT NULL, err_kind TEXT, err_text TEXT,
    plan_label TEXT, partial INTEGER NOT NULL DEFAULT 0, stale INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS sample_provider_ts ON sample(provider, ts);
  CREATE TABLE IF NOT EXISTS sample_row (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id INTEGER NOT NULL REFERENCES sample(id) ON DELETE CASCADE,
    scope TEXT NOT NULL, kind TEXT NOT NULL, label TEXT, percent REAL, used REAL, total REAL,
    unit TEXT, reset_at INTEGER, estimated INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS sample_row_series ON sample_row(sample_id, scope, kind);
`);

const STEP = 5 * 60_000;
const now = Date.now();
const N = Math.floor((hours * 3600e3) / STEP);
const insS = db.prepare(
  `INSERT INTO sample (ts, provider, source, ok, err_kind, err_text, plan_label, partial, stale)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insR = db.prepare(
  `INSERT INTO sample_row (sample_id, scope, kind, label, percent, used, total, unit, reset_at, estimated)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

// Stable window clocks, like a real provider: a 5h grid that jumps by exactly
// one window when it rolls, and a weekly anchor that stays put.
const FIVE_H = 5 * 3600e3;
const fiveHReset = (ts) => Math.ceil(ts / FIVE_H) * FIVE_H;
const weeklyReset = now + 3 * 864e5;

const tx = db.transaction(() => {
  for (let i = N; i >= 0; i--) {
    const ts = now - i * STEP;
    const t = (N - i) * STEP;
    const source = i % 40 === 0 ? 'page' : 'poll';

    // Claude: 5h window saws up to ~95% then resets; weekly climbs slowly.
    if (Math.random() > 0.02) {
      const p5 = (t % (5 * 3600e3)) / (5 * 3600e3);
      const wk = 8 + (t / (7 * 864e5)) * 34;
      const id = insS.run(ts, 'claude', source, 1, null, null, 'Max 20x', 0, 0).lastInsertRowid;
      insR.run(id, 'merged', '5h', '5h Window', Math.round(p5 * 92 + Math.random() * 6), null, null, null, fiveHReset(ts), 0);
      insR.run(id, 'merged', 'weekly', 'Weekly', Math.round(wk * 10) / 10, 1_240_000_000, 8_000_000_000, null, weeklyReset, 0);
    } else {
      insS.run(ts, 'claude', source, 0, 'error', 'HTTP 529 from api.anthropic.com', null, 0, 0);
    }

    // Kimi: two accounts merged.
    {
      const a1 = 12 + (t / (7 * 864e5)) * 26;
      const a2 = 6 + (t / (7 * 864e5)) * 15;
      const id = insS.run(ts, 'kimi', source, 1, null, null, 'Kimi Code 会员', 0, 0).lastInsertRowid;
      insR.run(id, 'merged', 'weekly', 'Weekly', Math.round(((a1 + a2) / 2) * 10) / 10, null, null, null, weeklyReset, 0);
      insR.run(id, '1', 'weekly', 'Weekly', Math.round(a1 * 10) / 10, null, null, null, weeklyReset, 0);
      insR.run(id, '2', 'weekly', 'Weekly', Math.round(a2 * 10) / 10, null, null, null, weeklyReset, 0);
    }

    // GLM: 5h + weekly.
    {
      const p5 = ((t + 3600e3) % (5 * 3600e3)) / (5 * 3600e3);
      const id = insS.run(ts, 'glm', source, 1, null, null, 'GLM Max', 0, 0).lastInsertRowid;
      insR.run(id, 'merged', '5h', '5h Window', Math.round(p5 * 70), null, null, null, fiveHReset(ts), 0);
      insR.run(id, 'merged', 'weekly', 'Weekly', 16 + Math.round((t / (7 * 864e5)) * 20), null, null, null, weeklyReset, 0);
    }

    // DeepSeek: money rows (balance draining, month spend climbing).
    {
      const bal = 1587.53 - (t / 3600e3) * 0.42;
      const spend = 5.58 + (t / 3600e3) * 0.19;
      const id = insS.run(ts, 'deepseek', source, 1, null, null, null, 0, 0).lastInsertRowid;
      insR.run(id, 'merged', 'balance', 'Balance', 0, Math.round(bal * 100) / 100, null, '¥', null, 0);
      insR.run(id, 'merged', 'spend', 'Spend', Math.round((spend / bal) * 1000) / 10, Math.round(spend * 100) / 100, Math.round(bal * 100) / 100, '¥', now + 20 * 864e5, 0);
    }

    // MiMo: credits + money.
    {
      const id = insS.run(ts, 'mimo', source, 1, null, null, 'Token Plan', 0, 0).lastInsertRowid;
      insR.run(id, 'merged', 'monthly', 'Monthly', 16 + (t / 3600e3) * 0.3, 13_486_940_705 + t * 900_000, 82_000_000_000, 'cr', now + 12 * 864e5, 0);
      insR.run(id, 'merged', 'balance', 'Balance', 0, 92.4 - (t / 3600e3) * 0.02, null, '¥', null, 0);
    }
  }
});
tx();

const counts = db.prepare('SELECT provider, COUNT(*) c FROM sample GROUP BY provider').all();
console.log('seeded', dir, counts);
db.close();
