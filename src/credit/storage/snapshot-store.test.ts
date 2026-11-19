// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// SnapshotStore unit tests — u1-credit-storage.
//
// Runner: bun:test. Isolation: an injected DB path (":memory:" or an mkdtemp temporary file) so the real
// ./data/usage.db is never touched (security-design test isolation, NFR5). No real kiro-cli or network
// (u1 only stores).
//
// The corrupt-record cases INSERT corrupt rows directly through a low-level bun:sqlite Database to
// exercise the defensive path (unit-test-instructions.md #5).

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CreditSnapshot, FailureSnapshot, SuccessSnapshot } from "../types";
import { SnapshotStore, isValidSnapshot } from "./snapshot-store";

/** The temporary directories each test made, to clean up. */
const tmpDirs: string[] = [];
/**
 * Stores that opened a file DB. They are closed before the directory is removed — Windows cannot delete
 * an open file, and `rmSync` threw EBUSY (POSIX unlinks an open file too).
 */
const openStores: SnapshotStore[] = [];

afterEach(() => {
  // Even if one throws, close the rest and remove the directories — a handle left open is an EBUSY.
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // A handle already closed or that cannot be closed. Cleanup continues.
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Make a temporary file DB path (for the reopen-continuity test). */
function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "u1-snap-"));
  tmpDirs.push(dir);
  return path.join(dir, "usage.db");
}

/** Open a file-DB store. afterEach closes it. */
function fileStore(dbPath: string): SnapshotStore {
  const store = new SnapshotStore(dbPath);
  openStores.push(store);
  return store;
}

/** Make an in-memory store, already through init. */
function memStore(): SnapshotStore {
  const store = new SnapshotStore(":memory:");
  store.init();
  return store;
}

function success(
  sequence: number,
  capturedAt: string,
  overrides: Partial<SuccessSnapshot["data"]> = {},
): SuccessSnapshot {
  return {
    sequence,
    capturedAt,
    source: "auto",
    ok: true,
    data: {
      planName: "Pro",
      usedAmount: 120,
      remainingAmount: 380,
      planLimit: 500,
      usageRatio: 0.24,
      resetDate: "2026-09-01",
      partial: false,
      ...overrides,
    },
  };
}

function failure(sequence: number, capturedAt: string): FailureSnapshot {
  return {
    sequence,
    capturedAt,
    source: "manual",
    ok: false,
    raw: "some non-contract /usage output",
    reason: "parse-failure",
  };
}

describe("SnapshotStore append/readAll round trip", () => {
  test("case1: success snapshot round trip — data kept, raw/reason absent", () => {
    const store = memStore();
    const snap = success(1, "2026-08-16T10:00:00.000Z");
    store.append(snap);

    const all = store.readAll();
    expect(all).toHaveLength(1);
    const [got] = all;
    expect(got).toEqual(snap);
    expect(got?.ok).toBe(true);
    // A success snapshot carries no raw/reason fields (volatile round trip, BR1.6).
    expect(got && "raw" in got).toBe(false);
    expect(got && "reason" in got).toBe(false);
  });

  test("case2: failure snapshot round trip — ok=false, raw and reason kept, data absent", () => {
    const store = memStore();
    const snap = failure(1, "2026-08-16T10:00:00.000Z");
    store.append(snap);

    const [got] = store.readAll();
    expect(got).toEqual(snap);
    expect(got?.ok).toBe(false);
    expect(got && "data" in got).toBe(false);
    if (got && got.ok === false) {
      expect(got.raw).toBe("some non-contract /usage output");
      expect(got.reason).toBe("parse-failure");
    }
  });
});

describe("SnapshotStore ordering and continuity", () => {
  test("case3: time order — stored shuffled, read back ascending by capturedAt then sequence", () => {
    const store = memStore();
    store.append(success(3, "2026-08-16T12:00:00.000Z"));
    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    store.append(success(2, "2026-08-16T11:00:00.000Z"));

    const seqs = store.readAll().map((s) => s.sequence);
    expect(seqs).toEqual([1, 2, 3]);
  });

  test("case4: simultaneous capture — two with the same capturedAt and different sequences are told apart and sorted by sequence", () => {
    const store = memStore();
    const at = "2026-08-16T10:00:00.000Z";
    // An auto poll and a manual refresh captured at the same instant.
    store.append(success(6, at));
    store.append(failure(5, at));

    const all = store.readAll();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.sequence)).toEqual([5, 6]);
    expect(all[0]?.ok).toBe(false);
    expect(all[1]?.ok).toBe(true);
  });

  test("case8: restart continuity — after reopening the same file, history is kept and the maxSequence seed is exact", () => {
    const dbPath = tmpDbPath();

    const first = fileStore(dbPath);
    first.init();
    first.append(success(1, "2026-08-16T10:00:00.000Z"));
    first.append(failure(2, "2026-08-16T10:05:00.000Z"));

    // Reopen with a new connection (simulating a server restart).
    const second = fileStore(dbPath);
    second.init();
    expect(second.readAll()).toHaveLength(2);
    expect(second.maxSequence()).toBe(2);
    expect(second.latest()?.sequence).toBe(2);
  });
});

describe("SnapshotStore query contract", () => {
  test("case6: latest() = the one with the highest sequence (success or failure), null when none", () => {
    const store = memStore();
    expect(store.latest()).toBeNull();

    store.append(success(1, "2026-08-16T12:00:00.000Z"));
    store.append(failure(2, "2026-08-16T10:00:00.000Z")); // an earlier time but a higher sequence
    const latest = store.latest();
    expect(latest?.sequence).toBe(2);
    expect(latest?.ok).toBe(false);
  });

  test("case7: maxSequence() = MAX(sequence), a deterministic 0 for an empty DB", () => {
    const store = memStore();
    expect(store.maxSequence()).toBe(0);

    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    store.append(success(7, "2026-08-16T11:00:00.000Z"));
    expect(store.maxSequence()).toBe(7);
  });
});

describe("SnapshotStore defensive deserialisation", () => {
  test("case5: corrupt records are skipped defensively — rows with bad JSON or missing required metadata INSERTed directly leave only the valid rows, no throw", () => {
    const dbPath = tmpDbPath();
    const store = fileStore(dbPath);
    store.init();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    store.append(success(4, "2026-08-16T13:00:00.000Z"));

    // Plant corrupt rows directly through a low-level connection.
    const raw = new Database(dbPath);
    const insert = raw.query(
      "INSERT INTO credit_snapshots (sequence, capturedAt, source, ok, data, raw, reason) VALUES (?,?,?,?,?,?,?)",
    );
    // (a) Marked success, but the data JSON is corrupt.
    insert.run(2, "2026-08-16T11:00:00.000Z", "auto", 1, "{not valid json", null, null);
    // (b) Required metadata (capturedAt) missing.
    insert.run(3, "", "auto", 1, JSON.stringify({ planName: "Pro" }), null, null);
    raw.close();

    let all: CreditSnapshot[] = [];
    expect(() => {
      all = store.readAll();
    }).not.toThrow();
    // Only the 2 valid rows (sequence 1, 4) remain; the 2 corrupt ones are skipped non-destructively.
    expect(all.map((s) => s.sequence)).toEqual([1, 4]);

    // Corrupt rows are not physically deleted (append-only, non-destructive) — checked with a low-level count.
    const check = new Database(dbPath);
    const row = check.query("SELECT COUNT(*) AS n FROM credit_snapshots").get() as { n: number };
    check.close();
    expect(row.n).toBe(4);
  });

  test("case5c: the data field contract — missing is normalised to null + partial, a type mismatch is skipped as corrupt", () => {
    // Regression: while `data` was checked only as "a non-null object", `{}` passed as normal and
    // renderCredit's fmtNumber blew up on `undefined.toLocaleString()`, turning the whole page into a
    // 500 (an NFR1.5 violation). Setting the contract in the storage layer is the repair of that hole.
    const dbPath = tmpDbPath();
    const store = fileStore(dbPath);
    store.init();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));

    const raw = new Database(dbPath);
    const insert = raw.query(
      "INSERT INTO credit_snapshots (sequence, capturedAt, source, ok, data, raw, reason) VALUES (?,?,?,?,?,?,?)",
    );
    // (a) An object with no fields at all → not refused but normalised to all fields missing + partial.
    //     So that adding a field to a DB with no migrations (BR1.3) does not wipe the whole history.
    insert.run(2, "2026-08-16T11:00:00.000Z", "auto", 1, "{}", null, null);
    // (b) Type mismatch → a shape this store never wrote, so skipped as corrupt.
    insert.run(
      3,
      "2026-08-16T12:00:00.000Z",
      "auto",
      1,
      JSON.stringify({ ...success(3, "x").data, usedAmount: "500" }),
      null,
      null,
    );
    // (c) data that is not an object → skipped as corrupt.
    insert.run(4, "2026-08-16T13:00:00.000Z", "auto", 1, "[1,2,3]", null, null);
    raw.close();

    let all: CreditSnapshot[] = [];
    expect(() => {
      all = store.readAll();
    }).not.toThrow();
    expect(all.map((s) => s.sequence)).toEqual([1, 2]);

    const normalized = all[1];
    expect(normalized?.ok).toBe(true);
    if (normalized?.ok) {
      expect(normalized.data.usedAmount).toBeNull();
      expect(normalized.data.planName).toBeNull();
      // Missing values were filled in, so it must show as "partial data", not ok.
      expect(normalized.data.partial).toBe(true);
    }

    // Corrupt rows are not physically deleted either (non-destructive skip).
    const check = new Database(dbPath);
    const row = check.query("SELECT COUNT(*) AS n FROM credit_snapshots").get() as { n: number };
    check.close();
    expect(row.n).toBe(4);
  });

  test("case5d: isValidSnapshot checks the field types of a success data too", () => {
    const base = { sequence: 1, capturedAt: "2026-08-16T10:00:00.000Z", source: "auto", ok: true };
    // A shape that can be normalised passes (missing reads as missing).
    expect(isValidSnapshot({ ...base, data: {} })).toBe(true);
    // A shape that cannot be normalised is refused.
    expect(isValidSnapshot({ ...base, data: { usedAmount: "500" } })).toBe(false);
    expect(isValidSnapshot({ ...base, data: { partial: "no" } })).toBe(false);
    expect(isValidSnapshot({ ...base, data: [] })).toBe(false);
  });

  test("case5b: latest() also skips a corrupt top row and returns the next valid one, no throw", () => {
    const dbPath = tmpDbPath();
    const store = fileStore(dbPath);
    store.init();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));

    const raw = new Database(dbPath);
    raw
      .query(
        "INSERT INTO credit_snapshots (sequence, capturedAt, source, ok, data, raw, reason) VALUES (?,?,?,?,?,?,?)",
      )
      .run(2, "2026-08-16T11:00:00.000Z", "auto", 1, "{broken", null, null);
    raw.close();

    expect(() => store.latest()).not.toThrow();
    const latest = store.latest();
    expect(latest?.sequence).toBe(1);
  });

  test("case5d: a file DB opens in WAL and close() folds the WAL into the main file", () => {
    const dbPath = tmpDbPath();
    const store = fileStore(dbPath);
    store.init();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));

    const check = new Database(dbPath);
    const mode = check.query("PRAGMA journal_mode").get() as { journal_mode: string };
    check.close();
    expect(mode.journal_mode).toBe("wal");

    store.close();
    // Measured: the `-wal` file remains but the checkpoint leaves it at 0 bytes, with its content in the DB
    // file. What is checked is not the file's existence but that no unapplied log is left.
    if (fs.existsSync(`${dbPath}-wal`)) {
      expect(fs.statSync(`${dbPath}-wal`).size).toBe(0);
    }
    // So after closing, a reopen reads the data (BR1.3 restart continuity).
    const reopened = fileStore(dbPath);
    reopened.init();
    expect(reopened.readAll()).toHaveLength(1);
  });

  test("case5c: calling latest() repeatedly returns the same row (regression guard for the row-at-a-time query)", () => {
    // bun:sqlite caches `db.query()` statements, so leaving a cursor-holding query early makes the next
    // call continue from the following row. It is called on every render, so that trap is a wrong answer.
    const store = new SnapshotStore(":memory:");
    store.init();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    store.append(success(2, "2026-08-16T11:00:00.000Z"));
    store.append(success(3, "2026-08-16T12:00:00.000Z"));

    expect(store.latest()?.sequence).toBe(3);
    expect(store.latest()?.sequence).toBe(3);
    expect(store.latest()?.sequence).toBe(3);
    // Mixed with readAll() calls they do not interfere (assembleCredit's real call order).
    expect(store.readAll()).toHaveLength(3);
    expect(store.latest()?.sequence).toBe(3);
  });
});

describe("isValidSnapshot shape defence", () => {
  test("case9: refuses shape violations — missing fields, a bad source, null/strings", () => {
    // A valid snapshot passes.
    expect(isValidSnapshot(success(1, "2026-08-16T10:00:00.000Z"))).toBe(true);
    expect(isValidSnapshot(failure(1, "2026-08-16T10:00:00.000Z"))).toBe(true);

    // Not an object.
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot("snapshot")).toBe(false);
    expect(isValidSnapshot(42)).toBe(false);

    // A bad source.
    expect(
      isValidSnapshot({
        sequence: 1,
        capturedAt: "2026-08-16T10:00:00.000Z",
        source: "cron",
        ok: true,
        data: {},
      }),
    ).toBe(false);

    // capturedAt missing.
    expect(
      isValidSnapshot({ sequence: 1, capturedAt: "", source: "auto", ok: true, data: {} }),
    ).toBe(false);

    // Marked success but no data.
    expect(
      isValidSnapshot({
        sequence: 1,
        capturedAt: "2026-08-16T10:00:00.000Z",
        source: "auto",
        ok: true,
      }),
    ).toBe(false);

    // Marked failure but no raw/reason.
    expect(
      isValidSnapshot({
        sequence: 1,
        capturedAt: "2026-08-16T10:00:00.000Z",
        source: "auto",
        ok: false,
      }),
    ).toBe(false);

    // sequence is not a number.
    expect(
      isValidSnapshot({
        sequence: "1",
        capturedAt: "2026-08-16T10:00:00.000Z",
        source: "auto",
        ok: true,
        data: {},
      }),
    ).toBe(false);
  });
});

describe("SnapshotStore append-only integrity", () => {
  test("case10: no UPDATE/DELETE API exposed (no change path by design)", () => {
    const store = memStore();
    const surface = store as unknown as Record<string, unknown>;
    expect(surface.update).toBeUndefined();
    expect(surface.delete).toBeUndefined();
    expect(surface.remove).toBeUndefined();
    // The exposed methods are limited to storing, querying and initialisation.
    expect(typeof store.append).toBe("function");
    expect(typeof store.readAll).toBe("function");
    expect(typeof store.latest).toBe("function");
    expect(typeof store.maxSequence).toBe("function");
    expect(typeof store.init).toBe("function");
  });

  test("case10b: a duplicate sequence (PK violation) is surfaced, not swallowed (no silent failure)", () => {
    const store = memStore();
    store.append(success(1, "2026-08-16T10:00:00.000Z"));
    // On a u2 contract violation (duplicate sequence), append propagates the error, unlike the query path.
    expect(() => store.append(success(1, "2026-08-16T11:00:00.000Z"))).toThrow();
  });
});
