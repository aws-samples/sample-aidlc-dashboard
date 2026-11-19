// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// TrendAggregator unit tests — u3-credit-view (Step 1).
//
// Runner: bun:test. The pure function buildTrend is checked deterministically with an injected now; no
// real storage or network. Covers the window filter, sorting, missing-point preservation, downsampling,
// the summary and empty input.

import { describe, expect, test } from "bun:test";
import type { CreditSnapshot, ParsedUsage } from "../types";
import { buildTrend } from "./trend";

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** Success-snapshot factory. Carries usedAmount as the trend value. */
function ok(sequence: number, capturedAt: string, usedAmount: number | null): CreditSnapshot {
  const data: ParsedUsage = {
    planName: "Pro",
    usedAmount,
    remainingAmount: usedAmount === null ? null : 500 - usedAmount,
    planLimit: 500,
    usageRatio: usedAmount === null ? null : usedAmount / 500,
    resetDate: "2026-09-01",
    partial: usedAmount === null,
  };
  return { sequence, capturedAt, source: "auto", ok: true, data };
}

/** Failure-snapshot factory — in the trend it must become a missing (value=null) point. */
function fail(sequence: number, capturedAt: string): CreditSnapshot {
  return {
    sequence,
    capturedAt,
    source: "manual",
    ok: false,
    raw: "some non-contract output",
    reason: "parse-failure",
  };
}

/** ISO string for daysAgo days before now. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("buildTrend window filter", () => {
  test("7d: leaves out snapshots older than 7 days (injected now)", () => {
    const snaps = [ok(1, daysAgo(10), 100), ok(2, daysAgo(3), 200), ok(3, daysAgo(1), 300)];
    const series = buildTrend(snaps, "7d", NOW);
    expect(series.points.map((p) => p.value)).toEqual([200, 300]);
    expect(series.summary.count).toBe(2);
  });

  test("30d: leaves out snapshots older than 30 days", () => {
    const snaps = [ok(1, daysAgo(40), 100), ok(2, daysAgo(20), 200)];
    const series = buildTrend(snaps, "30d", NOW);
    expect(series.points.map((p) => p.value)).toEqual([200]);
  });

  test("all: includes everything, no period limit", () => {
    const snaps = [ok(1, daysAgo(400), 100), ok(2, daysAgo(1), 200)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points).toHaveLength(2);
  });
});

describe("buildTrend sorting, missing points, summary", () => {
  test("time order: sorts shuffled input by capturedAt then sequence", () => {
    const snaps = [ok(3, daysAgo(1), 300), ok(1, daysAgo(3), 100), ok(2, daysAgo(2), 200)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points.map((p) => p.value)).toEqual([100, 200, 300]);
  });

  test("same capture time: equal capturedAt sorts stably by sequence", () => {
    const at = daysAgo(1);
    const snaps = [ok(6, at, 600), ok(5, at, 500)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points.map((p) => p.value)).toEqual([500, 600]);
  });

  test("keeps missing points: a failed/partial (usedAmount null) snapshot is a value=null point", () => {
    const snaps = [ok(1, daysAgo(3), 100), fail(2, daysAgo(2)), ok(3, daysAgo(1), null)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points.map((p) => p.value)).toEqual([100, null, null]);
    expect(series.points.map((p) => p.ok)).toEqual([true, false, false]);
  });

  test("summary: latest/min/max/count exact (only valued points counted)", () => {
    const snaps = [ok(1, daysAgo(3), 100), fail(2, daysAgo(2)), ok(3, daysAgo(1), 300)];
    const series = buildTrend(snaps, "all", NOW);
    expect(series.summary).toEqual({ latest: 300, min: 100, max: 300, count: 2 });
  });
});

describe("buildTrend downsampling, empty input", () => {
  test("downsampling: >500 points → ≤500, first and last kept", () => {
    const snaps: CreditSnapshot[] = [];
    const total = 1200;
    for (let i = 0; i < total; i++) {
      // Dense from past to present (value=i ascending, time ascending too).
      snaps.push(ok(i + 1, new Date(NOW.getTime() - (total - i) * 60_000).toISOString(), i));
    }
    const series = buildTrend(snaps, "all", NOW);
    expect(series.points.length).toBeLessThanOrEqual(500);
    expect(series.points.length).toBeGreaterThan(1);
    // After sorting, the first point (value 0) and the last (value 1199) are kept.
    expect(series.points[0]?.value).toBe(0);
    expect(series.points[series.points.length - 1]?.value).toBe(1199);
  });

  test("empty input: points=[], summary count=0, the rest null", () => {
    const series = buildTrend([], "30d", NOW);
    expect(series.points).toEqual([]);
    expect(series.summary).toEqual({ latest: null, min: null, max: null, count: 0 });
    expect(series.window).toBe("30d");
  });
});
