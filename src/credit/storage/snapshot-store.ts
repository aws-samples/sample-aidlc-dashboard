// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * SnapshotStore — persists CreditSnapshots append-only in `bun:sqlite` and queries them in time order.
 *
 * A native component of aidlc-dashboard (absorbed). It reimplements credit-dashboard's JSONL/async
 * implementation on bun:sqlite's synchronous API.
 *
 * Layer boundaries (team.md ## Code Style, functional-spec):
 * - It knows no parsing logic. It takes an already assembled CreditSnapshot and only stores and queries
 *   it (one-directional layering).
 * - It only serialises/deserialises the `data` JSON and does not interpret field meanings (the u2
 *   parser's business).
 *
 * Contract (rules.md BR1.1–BR1.6, security-design NFR1.x, NFR4.x):
 * - append-only INSERT. No UPDATE/DELETE API is exposed (BR1.1).
 * - The sequence is stored trusting the monotonic, unique value the upper layer (u2) assigned
 *   (INTEGER PRIMARY KEY, BR1.2).
 * - Queries (readAll/latest/maxSequence) never throw. No data is an empty array/null/0, and a corrupt
 *   record is skipped non-destructively at query time (BR1.4, BR1.5).
 * - The no-throw guarantee is limited to the query path (contract-summary C1 error_behavior). An append
 *   contract violation (duplicate PK) or a storage I/O error is surfaced, not swallowed (no silent failure).
 * - All SQL is static literals, values only through bind parameters (injection prevention, NFR1.2).
 *   Deserialisation is JSON.parse only (no code execution path, NFR4.2).
 */

import { Database } from "bun:sqlite";
import type { CaptureSource, CreditSnapshot, ParsedUsage } from "../types";

const VALID_SOURCES: readonly CaptureSource[] = ["auto", "manual"];

const isFiniteNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const isString = (v: unknown): boolean => typeof v === "string";

/** The value fields of `ParsedUsage` and the acceptance test for each. `null` is allowed in every field (missing). */
const USAGE_FIELDS: Record<string, (v: unknown) => boolean> = {
  planName: isString,
  usedAmount: isFiniteNumber,
  remainingAmount: isFiniteNumber,
  planLimit: isFiniteNumber,
  usageRatio: isFiniteNumber,
  resetDate: isString,
};

/**
 * Normalise the `data` JSON to the `ParsedUsage` contract. `null` when the contract cannot be met (a corrupt row).
 *
 * While this function did not exist, `isValidSnapshot` saw a success `data` only as "a non-null object",
 * so `{}` passed as normal — measured: `readAll()` passed that row on, `assembleCredit` judged it status
 * `ok`, and `renderCredit`'s `fmtNumber` blew up on `undefined.toLocaleString()`. Rendering is outside
 * `assemble`'s credit isolation, so the whole page became a 500. In other words, a defensive gap in the
 * storage layer broke "a credit failure does not take the dashboard down" (NFR1.5).
 *
 * A missing field is filled with `null` (missing), not refused. This DB has no migrations (BR1.3), so
 * adding one field would skip every earlier row as corrupt — paying for one missing value with the whole
 * history. Instead, if anything was filled in, `partial=true` is raised — the "partial data" state the
 * view already renders, so a snapshot without values is not left looking `ok`.
 *
 * A **value of the wrong type, on the other hand, is refused** (`usedAmount: "500"`). Unlike a missing
 * value, it is a shape this store never wrote, so it is outside tampering, and swallowing it as `null`
 * would disguise corruption as a missing value (the non-destructive skip of BR1.4/BR1.5 is the right
 * handling).
 */
function normalizeUsage(value: unknown): ParsedUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let filled = false;
  for (const [field, accepts] of Object.entries(USAGE_FIELDS)) {
    const v = o[field];
    if (v === undefined || v === null) {
      out[field] = null;
      if (v === undefined) filled = true;
      continue;
    }
    if (!accepts(v)) return null;
    out[field] = v;
  }
  if (o.partial !== undefined && typeof o.partial !== "boolean") return null;
  out.partial = o.partial === true || filled;
  return out as unknown as ParsedUsage;
}

/** The DB row shape (the raw representation before deserialisation). */
interface SnapshotRow {
  sequence: number;
  capturedAt: string;
  source: string;
  ok: number;
  data: string | null;
  raw: string | null;
  reason: string | null;
}

/** Defensively check whether an unknown value has the shape of a valid CreditSnapshot (NFR4.2). */
export function isValidSnapshot(value: unknown): value is CreditSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.sequence !== "number" || !Number.isFinite(o.sequence)) return false;
  if (typeof o.capturedAt !== "string" || o.capturedAt.length === 0) return false;
  if (typeof o.source !== "string" || !VALID_SOURCES.includes(o.source as CaptureSource)) {
    return false;
  }
  if (typeof o.ok !== "boolean") return false;
  if (o.ok === true) {
    // A non-null object check alone lets `{}` through — see the measurement in the normalizeUsage header.
    return normalizeUsage(o.data) !== null;
  }
  return typeof o.raw === "string" && typeof o.reason === "string";
}

/**
 * Deserialise one DB row into a CreditSnapshot. A corrupt row (data JSON parse failure, missing required
 * metadata, etc.) returns `null` so the query layer skips it non-destructively (no exception).
 */
function toSnapshot(row: SnapshotRow): CreditSnapshot | null {
  try {
    const source = row.source;
    if (source !== "auto" && source !== "manual") return null;
    if (typeof row.capturedAt !== "string" || row.capturedAt.length === 0) return null;
    if (typeof row.sequence !== "number" || !Number.isFinite(row.sequence)) return null;

    if (row.ok === 1) {
      if (row.data === null) return null;
      // Passing on JSON.parse output alone would leave the field contract unchecked — only normalised values are used.
      const data = normalizeUsage(JSON.parse(row.data));
      if (data === null) return null;
      const candidate: CreditSnapshot = {
        sequence: row.sequence,
        capturedAt: row.capturedAt,
        source,
        ok: true,
        data,
      };
      return isValidSnapshot(candidate) ? candidate : null;
    }

    if (row.raw === null || row.reason === null) return null;
    const candidate: CreditSnapshot = {
      sequence: row.sequence,
      capturedAt: row.capturedAt,
      source,
      ok: false,
      raw: row.raw,
      reason: row.reason,
    };
    return isValidSnapshot(candidate) ? candidate : null;
  } catch {
    // A corrupt row (bad JSON, etc.) → skip (not deleted).
    return null;
  }
}

export class SnapshotStore {
  private readonly db: Database;

  /**
   * @param dbPath bun:sqlite DB path. Default `./data/usage.db` relative to the run directory (FR5.4).
   *   Tests inject `:memory:` or a temporary file path, so no real file is touched (NFR5).
   */
  constructor(dbPath = "./data/usage.db") {
    this.db = new Database(dbPath);
  }

  /**
   * Make the table exist idempotently (CREATE TABLE IF NOT EXISTS). History from before a restart stays
   * as it is (no migrations, BR1.3). The consumer (u2) reads the counter seed through maxSequence().
   */
  init(): void {
    // WAL: queries (the render path) are not blocked while polling appends, and fewer fsyncs happen. It
    // applies only to a file DB; under `:memory:` journal_mode stays "memory" — it does not throw, so the
    // test path is unchanged (measured). With WAL on, close() checkpoints at shutdown.
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS credit_snapshots (sequence INTEGER PRIMARY KEY, capturedAt TEXT NOT NULL, source TEXT NOT NULL, ok INTEGER NOT NULL, data TEXT, raw TEXT, reason TEXT)",
    );
  }

  /**
   * Close the DB handle (shutdown path only). Closing makes SQLite checkpoint the WAL into the main file —
   * measured: the `-wal` file itself stays, but folds to size 0 and its content goes into the DB file.
   * `close(true)` and an explicit `PRAGMA wal_checkpoint(TRUNCATE)` give the same result, so the
   * non-throwing `close(false)` is used.
   */
  close(): void {
    this.db.close(false);
  }

  /**
   * Append one snapshot with a single INSERT (append-only, BR1.1). A success snapshot is
   * data=JSON, raw/reason=null; a failure snapshot is data=null with raw/reason kept (round trip, BR1.6).
   *
   * Unlike the query path it does not guarantee no-throw — a contract violation (duplicate PK) or storage
   * I/O error is surfaced, not swallowed (no silent failure, contract-summary C1 error_behavior).
   */
  append(snapshot: CreditSnapshot): void {
    const insert = this.db.query(
      "INSERT INTO credit_snapshots (sequence, capturedAt, source, ok, data, raw, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    if (snapshot.ok) {
      insert.run(
        snapshot.sequence,
        snapshot.capturedAt,
        snapshot.source,
        1,
        JSON.stringify(snapshot.data),
        null,
        null,
      );
    } else {
      insert.run(
        snapshot.sequence,
        snapshot.capturedAt,
        snapshot.source,
        0,
        null,
        snapshot.raw,
        snapshot.reason,
      );
    }
  }

  /**
   * The highest stored sequence value (the seed for continuity across restarts). A deterministic `0` with
   * no records (BR1.3, NFR1.4). Never throws.
   */
  maxSequence(): number {
    const row = this.db.query("SELECT MAX(sequence) AS max FROM credit_snapshots").get() as {
      max: number | null;
    } | null;
    return row?.max ?? 0;
  }

  /**
   * Deserialise and return the one row with the highest sequence (success or failure). null when there is
   * none. If the top row is corrupt, it is skipped and the next valid row returned (WF3.2). Never throws.
   *
   * Only one row will be used, so it steps down one row at a time. The previous implementation took
   * everything with `.all()`, deserialised all of it and returned the first valid row; `assembleCredit`
   * calls this right after `readAll()`, so every render scanned the same table twice — a failure snapshot
   * holds up to 512KB of `raw` (MAX_STDOUT_BYTES), a cost that grows with history. Corrupt rows are rare,
   * so it usually ends at the first one-row query.
   *
   * Why not leave early from `.iterate()` (measured): `db.query()` caches the compiled statement by SQL
   * string, and breaking out before the iteration ends leaves the cursor unreset, so **the next call
   * continues from the following row** (calling latest() four times on the same DB gave v5, v4, v3, v2).
   * `LIMIT 1 OFFSET ?` leaves no cursor behind on any call, so it has no such trap.
   */
  latest(): CreditSnapshot | null {
    const row = this.db.query(
      "SELECT sequence, capturedAt, source, ok, data, raw, reason FROM credit_snapshots ORDER BY sequence DESC LIMIT 1 OFFSET ?",
    );
    for (let offset = 0; ; offset++) {
      const candidate = row.get(offset) as SnapshotRow | null;
      if (candidate === null) return null;
      const snap = toSnapshot(candidate);
      if (snap !== null) return snap;
    }
  }

  /**
   * Return everything in time order (capturedAt, sequence on ties). A corrupt record (bad data JSON,
   * missing required metadata) is skipped row by row, non-destructively (BR1.4, BR1.5, NFR4.2). Never throws.
   */
  readAll(): CreditSnapshot[] {
    const rows = this.db
      .query(
        "SELECT sequence, capturedAt, source, ok, data, raw, reason FROM credit_snapshots ORDER BY capturedAt, sequence",
      )
      .all() as SnapshotRow[];
    const snapshots: CreditSnapshot[] = [];
    for (const row of rows) {
      const snap = toSnapshot(row);
      if (snap !== null) snapshots.push(snap);
    }
    return snapshots;
  }
}
