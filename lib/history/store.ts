/**
 * History store: append samples, read them back as series, prune by age.
 *
 * Writes are per-sample transactions so a provider failure can never leave a
 * half-written sample behind. Reads are plain range queries — at the measured
 * volume (~3.2k samples/day across 11 channels) SQLite answers a 30-day range
 * in single-digit milliseconds, so there is deliberately no rollup table.
 */

import { getDb, MERGED, type SampleInput, type SampleRowInput, type StoredRow, type StoredSample } from './db';

const DEFAULT_RETENTION_DAYS = 90;

export function retentionDays(): number {
  const n = Number(process.env.QP_HISTORY_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export interface Recorded {
  id: number;
  ts: number;
  provider: string;
  source: string;
  rows: number;
  skipped?: string;
}

/** Rows are written per row kind so a partial failure is never a partial curve. */
const insertRowStmt = `INSERT INTO sample_row
  (sample_id, scope, kind, label, percent, used, total, unit, reset_at, estimated)
  VALUES (@sample_id, @scope, @kind, @label, @percent, @used, @total, @unit, @reset_at, @estimated)`;

function rowParams(sampleId: number, row: SampleRowInput) {
  return {
    sample_id: sampleId,
    scope: row.scope,
    kind: row.kind,
    label: row.label ?? null,
    percent: row.percent ?? null,
    used: row.used ?? null,
    total: row.total ?? null,
    unit: row.unit ?? null,
    reset_at: row.resetAt ?? null,
    estimated: row.estimated ? 1 : 0,
  };
}

/**
 * Persist one provider fetch. Never throws: history is a side channel and a
 * broken store must not take a card down with it. Returns `skipped` instead.
 */
export function record(input: SampleInput, ts: number = Date.now()): Recorded {
  try {
    const db = getDb();
    const rows = input.rows ?? [];
    const tx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO sample (ts, provider, source, ok, err_kind, err_text, plan_label, partial, stale)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ts,
          input.provider,
          input.source,
          input.ok ? 1 : 0,
          input.errKind ?? null,
          input.errText ?? null,
          input.planLabel ?? null,
          input.partial ? 1 : 0,
          input.stale ? 1 : 0,
        );
      const sampleId = Number(info.lastInsertRowid);
      if (rows.length) {
        const stmt = db.prepare(insertRowStmt);
        for (const row of rows) stmt.run(rowParams(sampleId, row));
      }
      return { id: sampleId, rows: rows.length };
    });
    const { id, rows: n } = tx();
    return { id, ts, provider: input.provider, source: input.source, rows: n };
  } catch (err) {
    return {
      id: 0,
      ts,
      provider: input.provider,
      source: input.source,
      rows: 0,
      skipped: err instanceof Error ? err.message : String(err),
    };
  }
}

const SAMPLE_COLS = `id, ts, provider, source, ok, err_kind, err_text, plan_label, partial, stale`;

function mapSample(row: Record<string, unknown>): StoredSample {
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    provider: String(row.provider),
    source: String(row.source),
    ok: Number(row.ok) === 1,
    errKind: (row.err_kind as string) ?? null,
    errText: (row.err_text as string) ?? null,
    planLabel: (row.plan_label as string) ?? null,
    partial: Number(row.partial) === 1,
    stale: Number(row.stale) === 1,
  };
}

export interface QueryOptions {
  provider: string;
  from: number;
  to: number;
  scope?: string;
  limit?: number;
}

function inClause(values: readonly string[]): string {
  return values.map(() => '?').join(',');
}

/**
 * The most recent samples in [from, to], oldest first.
 *
 * Ordered newest-first *inside* SQL so the row cap keeps the latest reads: a
 * 30-day range at a 5-minute interval holds ~8.6k samples per provider, and
 * `ORDER BY ts ASC LIMIT 5000` would have handed back the oldest half of the
 * window instead of the recent one.
 */
export function samplesInRange({ provider, from, to, limit = 5000 }: QueryOptions): StoredSample[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ${SAMPLE_COLS} FROM (
         SELECT ${SAMPLE_COLS} FROM sample
         WHERE provider = ? AND ts >= ? AND ts <= ?
         ORDER BY ts DESC LIMIT ?
       ) ORDER BY ts ASC`,
    )
    .all(provider, from, to, limit);
  return rows.map((r) => mapSample(r as Record<string, unknown>));
}

/** Row points for one provider in [from, to], optionally restricted to scopes. */
export function pointsInRange({
  provider,
  from,
  to,
  scope,
  limit = 40000,
}: QueryOptions & { scope?: string | readonly string[] }): StoredRow[] {
  const db = getDb();
  const scopes = scope === undefined ? null : typeof scope === 'string' ? [scope] : scope;
  const args: unknown[] = [provider, from, to];
  let sql = `SELECT r.id, r.sample_id, r.scope, r.kind, r.label, r.percent, r.used, r.total,
                    r.unit, r.reset_at, r.estimated, s.ts, s.ok, s.err_kind
             FROM sample_row r JOIN sample s ON s.id = r.sample_id
             WHERE s.provider = ? AND s.ts >= ? AND s.ts <= ?`;
  if (scopes) {
    if (scopes.length === 0) return [];
    sql += ` AND r.scope IN (${inClause(scopes)})`;
    args.push(...scopes);
  }
  sql += ' ORDER BY s.ts ASC, r.id ASC LIMIT ?';
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    sampleId: Number(r.sample_id),
    ts: Number(r.ts),
    ok: Number(r.ok) === 1,
    errKind: (r.err_kind as string) ?? null,
    scope: String(r.scope),
    kind: String(r.kind),
    label: (r.label as string) ?? null,
    percent: (r.percent as number) ?? null,
    used: (r.used as number) ?? null,
    total: (r.total as number) ?? null,
    unit: (r.unit as string) ?? null,
    resetAt: (r.reset_at as number) ?? null,
    estimated: Number(r.estimated) === 1,
  }));
}

export interface FetchedProvider {
  provider: string;
  samples: StoredSample[];
  points: StoredRow[];
}

export interface Fetched {
  providers: FetchedProvider[];
  from: number;
  to: number;
  truncated: boolean;
}

const MAX_ROWS = 40000;
const MAX_SAMPLES = 5000;

/** Every provider's samples + row points in one range (dashboard sparklines). */
export function fetchAll(from: number, to: number): Fetched {
  const db = getDb();
  const sampleRows = db
    .prepare(
      `SELECT ${SAMPLE_COLS} FROM sample WHERE ts >= ? AND ts <= ? ORDER BY provider ASC, ts ASC LIMIT ?`,
    )
    .all(from, to, MAX_SAMPLES) as Record<string, unknown>[];
  const samples = sampleRows.map((r) => mapSample(r));
  const byProvider = new Map<string, StoredSample[]>();
  for (const s of samples) {
    const list = byProvider.get(s.provider);
    if (list) list.push(s);
    else byProvider.set(s.provider, [s]);
  }
  const providers: FetchedProvider[] = [];
  let rowsUsed = 0;
  let truncated = false;
  for (const [provider, list] of byProvider) {
    const remaining = MAX_ROWS - rowsUsed;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const points = pointsInRange({ provider, from, to, limit: remaining });
    rowsUsed += points.length;
    if (points.length === remaining) truncated = true;
    providers.push({ provider, samples: list, points });
  }
  return { providers, from, to, truncated };
}

export interface PruneResult {
  samples: number;
  rows: number;
  cutoff: number;
}

/** Drop samples (and, by cascade, their rows) older than the retention window. */
export function prune(days: number = retentionDays(), now: number = Date.now()): PruneResult {
  const cutoff = now - days * 864e5;
  try {
    const db = getDb();
    const rows = db.prepare('SELECT COUNT(*) AS c FROM sample_row WHERE sample_id IN (SELECT id FROM sample WHERE ts < ?)').get(cutoff) as { c: number };
    const info = db.prepare('DELETE FROM sample WHERE ts < ?').run(cutoff);
    return { samples: info.changes, rows: rows.c, cutoff };
  } catch {
    return { samples: 0, rows: 0, cutoff };
  }
}

export interface CsvRow {
  ts: number;
  source: string;
  scope: string;
  kind: string;
  label: string | null;
  percent: number | null;
  used: number | null;
  total: number | null;
  unit: string | null;
  resetAt: number | null;
  ok: boolean;
  errKind: string | null;
  planLabel: string | null;
  partial: boolean;
  stale: boolean;
}

/**
 * Raw joined rows for the CSV export — no downsampling, every sample's
 * metadata included. This is the "spreadsheet" view of the same data the
 * charts draw, so it is only ever called by an explicit user export.
 */
export function csvRowsInRange(
  provider: string,
  from: number,
  to: number,
  limit = 200_000,
): CsvRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.ts, s.source, s.ok, s.err_kind, s.plan_label, s.partial, s.stale,
              r.scope, r.kind, r.label, r.percent, r.used, r.total, r.unit, r.reset_at
       FROM sample s JOIN sample_row r ON r.sample_id = s.id
       WHERE s.provider = ? AND s.ts >= ? AND s.ts <= ?
       ORDER BY s.ts ASC, r.id ASC LIMIT ?`,
    )
    .all(provider, from, to, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    ts: Number(r.ts),
    source: String(r.source),
    scope: String(r.scope),
    kind: String(r.kind),
    label: (r.label as string) ?? null,
    percent: (r.percent as number) ?? null,
    used: (r.used as number) ?? null,
    total: (r.total as number) ?? null,
    unit: (r.unit as string) ?? null,
    resetAt: (r.reset_at as number) ?? null,
    ok: Number(r.ok) === 1,
    errKind: (r.err_kind as string) ?? null,
    planLabel: (r.plan_label as string) ?? null,
    partial: Number(r.partial) === 1,
    stale: Number(r.stale) === 1,
  }));
}

/** Total stored samples — used by the history page header. */
export function sampleCount(): number {
  try {
    const db = getDb();
    const r = db.prepare('SELECT COUNT(*) AS c FROM sample').get() as { c: number };
    return r.c;
  } catch {
    return 0;
  }
}

export { MERGED };
