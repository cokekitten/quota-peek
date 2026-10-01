/**
 * SQLite connection + schema for the usage history store.
 *
 * One file, one process, one writer. There is no ORM and no migration runner:
 * `CREATE TABLE IF NOT EXISTS` is the whole migration story (the schema is
 * additive-only — see SCHEMA_VERSION for the guard that keeps an older file
 * from being read with today's column list).
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

/**
 * Bump when the sample/sample_row column list changes, so an old database file
 * is detected (and reported) instead of being queried with columns it lacks.
 */
export const SCHEMA_VERSION = 1;

export const MERGED = 'merged';

export interface SampleRowInput {
  scope: string;
  kind: string;
  label?: string | null;
  percent?: number | null;
  used?: number | null;
  total?: number | null;
  unit?: string | null;
  resetAt?: number | null;
  estimated?: boolean;
}

export interface SampleInput {
  provider: string;
  source: string;
  ok: boolean;
  errKind?: string | null;
  errText?: string | null;
  planLabel?: string | null;
  partial?: boolean;
  stale?: boolean;
  rows?: SampleRowInput[];
}

export interface StoredSample {
  id: number;
  ts: number;
  provider: string;
  source: string;
  ok: boolean;
  errKind: string | null;
  errText: string | null;
  planLabel: string | null;
  partial: boolean;
  stale: boolean;
}

/** A row read back from the store: every column is resolved (null, not undefined). */
export interface StoredRow {
  id: number;
  sampleId: number;
  ts: number;
  ok: boolean;
  errKind: string | null;
  scope: string;
  kind: string;
  label: string | null;
  percent: number | null;
  used: number | null;
  total: number | null;
  unit: string | null;
  resetAt: number | null;
  estimated: boolean;
}

export const DEFAULT_DATA_DIR = 'data';
export const DB_FILENAME = 'quota-peek.db';

export function dataDir(): string {
  return process.env.QP_DATA_DIR || path.join(process.cwd(), DEFAULT_DATA_DIR);
}

export function dbPath(): string {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, DB_FILENAME);
}

function applySchema(db: Db): void {
  db.pragma('journal_mode = WAL');
  // The poller writes while page reads are in flight; without a busy timeout
  // those reads would throw SQLITE_BUSY instead of waiting a few ms.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sample (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      provider   TEXT    NOT NULL,
      source     TEXT    NOT NULL,
      ok         INTEGER NOT NULL,
      err_kind   TEXT,
      err_text   TEXT,
      plan_label TEXT,
      partial    INTEGER NOT NULL DEFAULT 0,
      stale      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sample_provider_ts ON sample(provider, ts);

    CREATE TABLE IF NOT EXISTS sample_row (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id INTEGER NOT NULL REFERENCES sample(id) ON DELETE CASCADE,
      scope     TEXT    NOT NULL,
      kind      TEXT    NOT NULL,
      label     TEXT,
      percent   REAL,
      used      REAL,
      total     REAL,
      unit      TEXT,
      reset_at  INTEGER,
      estimated INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sample_row_series ON sample_row(sample_id, scope, kind);
  `);
}

/**
 * Columns the code reads. The store validates them against the real file
 * (instead of trusting a version marker) so a database created elsewhere —
 * or by an older build — fails with a clear message rather than a confusing
 * "no such column" at query time.
 */
const EXPECTED_COLUMNS: Record<string, string[]> = {
  sample: [
    'id',
    'ts',
    'provider',
    'source',
    'ok',
    'err_kind',
    'err_text',
    'plan_label',
    'partial',
    'stale',
  ],
  sample_row: [
    'id',
    'sample_id',
    'scope',
    'kind',
    'label',
    'percent',
    'used',
    'total',
    'unit',
    'reset_at',
    'estimated',
  ],
};

function schemaMatches(db: Db): boolean {
  for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (info.length === 0) return false;
    const have = new Set(info.map((r) => r.name));
    if (!cols.every((c) => have.has(c))) return false;
  }
  return true;
}

function open(file: string): Db {
  const fresh = !fs.existsSync(file);
  const db = new Database(file);
  if (!fresh && !schemaMatches(db)) {
    // Don't leave a handle (and its WAL sidecars) behind on the error path.
    db.close();
    throw new Error(
      `history db at ${file} does not match the expected schema (v${SCHEMA_VERSION}); move it aside to start fresh`,
    );
  }
  applySchema(db);
  return db;
}

let cached: Db | null = null;

/** Open (once) and return the history database. */
export function getDb(): Db {
  if (!cached) cached = open(dbPath());
  return cached;
}

/** Test seam: drop the cached handle (next getDb() reopens). */
export function closeDb(): void {
  if (cached) {
    try {
      cached.close();
    } catch {
      /* already closed */
    }
    cached = null;
  }
}
