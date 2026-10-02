/**
 * SQLite connection + schema for the usage history store.
 *
 * One file, one writer at a time. No ORM, no migration framework: the schema
 * is additive, so `CREATE TABLE IF NOT EXISTS` plus ALTER TABLE for new
 * columns is the whole story, and an older database is brought forward in
 * place instead of being refused.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

/**
 * Schema revision, reported when a database cannot be brought forward.
 * The column list below is the real contract: the schema is additive, so an
 * older file is migrated in place rather than refused.
 */
export const SCHEMA_VERSION = 2;

export const MERGED = 'merged';

/**
 * Columns the code reads, with the SQL type each needs when it has to be
 * added to an existing table. One list drives CREATE TABLE, the migration and
 * the verification, so those three can never drift apart.
 */
type Column = { name: string; type: string };

const EXPECTED_COLUMNS: Record<string, Column[]> = {
  sample: [
    { name: 'id', type: 'INTEGER PRIMARY KEY AUTOINCREMENT' },
    { name: 'ts', type: 'INTEGER NOT NULL' },
    { name: 'provider', type: 'TEXT NOT NULL' },
    { name: 'source', type: 'TEXT NOT NULL' },
    { name: 'ok', type: 'INTEGER NOT NULL' },
    { name: 'err_kind', type: 'TEXT' },
    { name: 'err_text', type: 'TEXT' },
    { name: 'plan_label', type: 'TEXT' },
    // Which accounts failed inside an otherwise-successful read, as a JSON
    // array of keys ('["2","3"]'). `partial` alone cannot say that, and a
    // merged card that silently lost a member is exactly what you cannot
    // diagnose from the timeline a week later.
    { name: 'err_scopes', type: 'TEXT' },
    // Per-account plan labels, as JSON ('[{"key":"1","label":"Max"}]'), so a
    // multi-account card remembers which membership each key was on.
    { name: 'plan_labels', type: 'TEXT' },
    { name: 'partial', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'stale', type: 'INTEGER NOT NULL DEFAULT 0' },
  ],
  sample_row: [
    { name: 'id', type: 'INTEGER PRIMARY KEY AUTOINCREMENT' },
    { name: 'sample_id', type: 'INTEGER NOT NULL REFERENCES sample(id) ON DELETE CASCADE' },
    { name: 'scope', type: 'TEXT NOT NULL' },
    { name: 'kind', type: 'TEXT NOT NULL' },
    { name: 'label', type: 'TEXT' },
    { name: 'percent', type: 'REAL' },
    { name: 'used', type: 'REAL' },
    { name: 'total', type: 'REAL' },
    { name: 'unit', type: 'TEXT' },
    { name: 'reset_at', type: 'INTEGER' },
    { name: 'estimated', type: 'INTEGER NOT NULL DEFAULT 0' },
  ],
};

/**
 * The sampling lease: which process is allowed to poll.
 *
 * Without it, N replicas mean N samplers — N× the upstream calls and N× the
 * samples in one shared database. A lease with an expiry is enough: the
 * holder polls and renews, the others idle, and if the holder dies the lease
 * simply runs out, so there is no cleanup to get wrong.
 */
export const LEASE_TABLE = `
  CREATE TABLE IF NOT EXISTS poll_lease (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    owner       TEXT    NOT NULL,
    expires_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );`;

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
  /** Account keys that failed inside a successful read. */
  errScopes?: string[];
  /** Per-account plan labels, e.g. [{key:'1', label:'Max'}]. */
  planLabels?: { key: string; label: string }[];
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
  errScopes: string[];
  planLabels: { key: string; label: string }[];
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
  for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
    const body = cols.map((c) => `  ${c.name} ${c.type}`).join(',\n');
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (\n${body}\n);`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS sample_provider_ts ON sample(provider, ts);
    CREATE INDEX IF NOT EXISTS sample_row_series ON sample_row(sample_id, scope, kind);
  `);
  db.exec(LEASE_TABLE);
}

/**
 * Add columns an older database is missing.
 *
 * The schema is additive-only, so a database written by a previous build is
 * brought forward with ALTER TABLE instead of being refused — refusing would
 * mean telling the operator to delete a timeline they may care about. Returns
 * the names it added, so a caller can log the upgrade.
 */
export function migrateSchema(db: Db): string[] {
  const added: string[] = [];
  for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (info.length === 0) continue; // table was just created, nothing to add
    const have = new Set(info.map((r) => r.name));
    for (const c of cols) {
      if (have.has(c.name)) continue;
      // SQLite cannot add a PRIMARY KEY column; that case would be a rewrite
      // and is out of scope for an additive schema.
      if (/PRIMARY KEY/i.test(c.type)) {
        throw new Error(`cannot add primary-key column ${table}.${c.name} — move the database aside`);
      }
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${c.name} ${c.type}`);
      added.push(`${table}.${c.name}`);
    }
  }
  return added;
}

/** True when every expected column is present. */
export function schemaMatches(db: Db): boolean {
  for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (info.length === 0) return false;
    const have = new Set(info.map((r) => r.name));
    if (!cols.every((c) => have.has(c.name))) return false;
  }
  return true;
}

function open(file: string): Db {
  const fresh = !fs.existsSync(file);
  const db = new Database(file);
  try {
    applySchema(db);
    const added = migrateSchema(db);
    if (added.length && !fresh) {
      // Visible in the log: a store that silently changed shape is how you
      // lose an afternoon later.
      console.log(`[quota-peek] history db migrated: added ${added.join(', ')}`);
    }
    if (!schemaMatches(db)) {
      throw new Error(`history db at ${file} does not match the expected schema (v${SCHEMA_VERSION})`);
    }
  } catch (err) {
    // Don't leave a handle (and its WAL sidecars) behind on the error path.
    db.close();
    throw err;
  }
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

/** Floor for the lease lifetime — see poller.leaseTtlMs for the reasoning. */
export const MIN_LEASE_MS = 2 * 60_000;

export interface LeaseState {
  owner: string;
  expiresAt: number;
  mine: boolean;
}

/** Stable identity for this process, so "who is sampling" is answerable. */
export function ownerId(): string {
  if (process.env.QP_POLL_OWNER) return process.env.QP_POLL_OWNER;
  return `${os.hostname()}:${process.pid}`;
}

/**
 * Try to take (or renew) the sampling lease.
 *
 * The read-then-write runs inside an IMMEDIATE transaction, so two processes
 * starting at the same instant cannot both see an empty table and both decide
 * they own it: the second one blocks until the first commits, then finds the
 * lease held.
 */
export function acquireLease(
  owner: string,
  ttlMs: number = MIN_LEASE_MS,
  now: number = Date.now(),
): boolean {
  const db = getDb();
  const run = db.transaction(() => {
    const row = db.prepare('SELECT owner, expires_at FROM poll_lease WHERE id = 1').get() as
      | { owner: string; expires_at: number }
      | undefined;
    if (row && row.owner !== owner && row.expires_at > now) return false;
    db.prepare(
      `INSERT INTO poll_lease (id, owner, expires_at, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET owner = excluded.owner,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).run(owner, now + ttlMs, now);
    return true;
  });
  return run.immediate() as boolean;
}

/** Current lease holder, or null when nobody holds it. */
export function leaseState(now: number = Date.now()): LeaseState | null {
  try {
    const row = getDb()
      .prepare('SELECT owner, expires_at FROM poll_lease WHERE id = 1')
      .get() as { owner: string; expires_at: number } | undefined;
    if (!row) return null;
    return { owner: row.owner, expiresAt: row.expires_at, mine: row.owner === ownerId() };
  } catch {
    return null;
  }
}

/** Give the lease up (graceful stop). A crash needs no cleanup — it expires. */
export function releaseLease(owner: string = ownerId()): void {
  try {
    getDb().prepare('DELETE FROM poll_lease WHERE id = 1 AND owner = ?').run(owner);
  } catch {
    /* best effort */
  }
}
