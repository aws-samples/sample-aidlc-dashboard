// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// CreditModelAssembler unit tests — u3-credit-view (Step 5).
//
// Runner: bun:test. An injected now checks the 10-minute stale boundary deterministically. The store
// is an injected read-only {latest, readAll} stub (no real storage or network). Covers state and
// independent freshness, loading/none/ok/partial/failure, and the lastSuccessAt derivation.

import { describe, expect, test } from "bun:test";
import type { CreditSnapshot, ParsedUsage } from "../types";
import { assembleCredit } from "./credit-model";

const NOW = new Date("2026-08-16T12:00:00.000Z");
const TEN_MIN = 10 * 60 * 1000;

function usage(overrides: Partial<ParsedUsage> = {}): ParsedUsage {
  return {
    planName: "Pro",
    usedAmount: 120,
    remainingAmount: 380,
    planLimit: 500,
    usageRatio: 0.24,
    resetDate: "2026-09-01",
    partial: false,
    ...overrides,
  };
}

function ok(sequence: number, capturedAt: string, data: ParsedUsage = usage()): CreditSnapshot {
  return { sequence, capturedAt, source: "auto", ok: true, data };
}

function fail(sequence: number, capturedAt: string): CreditSnapshot {
  return {
    sequence,
    capturedAt,
    source: "manual",
    ok: false,
    raw: "some non-contract /usage output",
    reason: "parse-failure",
  };
}

/** Read-only store stub. Assumes latest = highest sequence, readAll = sorted by capturedAt then sequence. */
function stubStore(snaps: CreditSnapshot[]): {
  latest(): CreditSnapshot | null;
  readAll(): CreditSnapshot[];
} {
  const sorted = [...snaps].sort((a, b) => {
    if (a.capturedAt < b.capturedAt) return -1;
    if (a.capturedAt > b.capturedAt) return 1;
    return a.sequence - b.sequence;
  });
  const bySeq = [...snaps].sort((a, b) => a.sequence - b.sequence);
  return {
    latest: () => bySeq[bySeq.length - 1] ?? null,
    readAll: () => sorted,
  };
}

/** ISO string for minutesAgo minutes before now. */
function minutesAgo(min: number): string {
  return new Date(NOW.getTime() - min * 60 * 1000).toISOString();
}

describe("assembleCredit state", () => {
  test("none: 0 snapshots → status 'none', current/lastSuccessAt null", () => {
    const model = assembleCredit(stubStore([]), NOW, "30d");
    expect(model.status).toBe("none");
    expect(model.current).toBeNull();
    expect(model.lastSuccessAt).toBeNull();
    expect(model.warning).toBeNull();
    expect(model.freshness.stale).toBe(false);
    expect(model.trend.summary.count).toBe(0);
  });

  test("loading: first collection running and 0 snapshots → status 'loading'", () => {
    const model = assembleCredit(stubStore([]), NOW, "30d", true);
    expect(model.status).toBe("loading");
    expect(model.current).toBeNull();
  });

  test("ok: latest success and fresh (<10 min) → status 'ok', current filled", () => {
    const model = assembleCredit(stubStore([ok(1, minutesAgo(2))]), NOW, "30d");
    expect(model.status).toBe("ok");
    expect(model.current?.planName).toBe("Pro");
    expect(model.lastSuccessAt).toBe(minutesAgo(2));
    expect(model.warning).toBeNull();
  });

  test("partial: the latest success is partial → status 'partial'", () => {
    const partialUsage = usage({ remainingAmount: null, partial: true });
    const model = assembleCredit(stubStore([ok(1, minutesAgo(3), partialUsage)]), NOW, "30d");
    expect(model.status).toBe("partial");
    expect(model.current?.partial).toBe(true);
  });

  test("stale: last success older than 10 minutes → state kept and freshness.stale=true", () => {
    const model = assembleCredit(stubStore([ok(1, minutesAgo(20))]), NOW, "30d");
    expect(model.status).toBe("ok");
    expect(model.freshness.stale).toBe(true);
    expect(model.current?.planName).toBe("Pro"); // the last success value is kept
  });

  test("failure: latest is a failure → status 'failure', warning{raw,reason}, last success value kept", () => {
    const model = assembleCredit(
      stubStore([ok(1, minutesAgo(3)), fail(2, minutesAgo(1))]),
      NOW,
      "30d",
    );
    expect(model.status).toBe("failure");
    expect(model.warning).toEqual({
      raw: "some non-contract /usage output",
      reason: "parse-failure",
    });
    expect(model.current?.planName).toBe("Pro"); // the last success value is kept
    expect(model.lastSuccessAt).toBe(minutesAgo(3));
  });

  test("latest failure + last success over 10 minutes → keeps both failure and stale", () => {
    const model = assembleCredit(
      stubStore([ok(1, minutesAgo(20)), fail(2, minutesAgo(1))]),
      NOW,
      "30d",
    );
    expect(model.status).toBe("failure");
    expect(model.freshness.stale).toBe(true);
  });
});

describe("assembleCredit boundary and derivation", () => {
  test("10-minute boundary: exactly 10 minutes → fresh, over 10 minutes → stale", () => {
    const atBoundary = new Date(NOW.getTime() - TEN_MIN).toISOString();
    const justOver = new Date(NOW.getTime() - TEN_MIN - 1000).toISOString();
    expect(assembleCredit(stubStore([ok(1, atBoundary)]), NOW, "30d").freshness.stale).toBe(false);
    expect(assembleCredit(stubStore([ok(1, justOver)]), NOW, "30d").freshness.stale).toBe(true);
  });

  test("lastSuccessAt: derived from the latest ok=true (the last success even when a failure is newer)", () => {
    const model = assembleCredit(
      stubStore([ok(1, minutesAgo(5)), ok(2, minutesAgo(3)), fail(3, minutesAgo(1))]),
      NOW,
      "30d",
    );
    expect(model.lastSuccessAt).toBe(minutesAgo(3));
    expect(model.current?.planName).toBe("Pro");
  });

  test("only failures (no success history) → status 'failure', current/lastSuccessAt null", () => {
    const model = assembleCredit(stubStore([fail(1, minutesAgo(2))]), NOW, "30d");
    expect(model.status).toBe("failure");
    expect(model.current).toBeNull();
    expect(model.lastSuccessAt).toBeNull();
    expect(model.warning?.reason).toBe("parse-failure");
  });

  test("trend is aggregated for the injected window", () => {
    const model = assembleCredit(stubStore([ok(1, minutesAgo(3))]), NOW, "7d");
    expect(model.trend.window).toBe("7d");
    expect(model.trend.summary.count).toBe(1);
  });
});
