// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Trend aggregation: turns the snapshot series into a TrendSeries per window (7 days / 30 days / all)
 * (BR3.1, BR3.4).
 *
 * Pure functions. u4 (host wiring) aggregates the snapshots it read from storage for display (storage
 * knows nothing of aggregation; layering is one-directional). Failed and partial snapshots are
 * value=null missing points, kept apart from normal values. A faithful port of credit-dashboard's
 * `src/server/trend.ts`; ownership and definition of the trend types (TrendWindow, TrendPoint,
 * TrendSummary, TrendSeries) move to u3 (producer-owned).
 */

import type { CreditSnapshot } from "../types";

/** The trend chart's time window (BR3.2). Owned by u3. */
export type TrendWindow = "7d" | "30d" | "all";

/** One point of the trend chart. Keeps missing (failed/partial) apart from normal values (BR3.4). Owned by u3. */
export interface TrendPoint {
  /** Capture time (ISO 8601). */
  ts: string;
  /** Cumulative usage value. null when failed or missing (drawn as a break in the line). */
  value: number | null;
  /** Whether this point is a normal snapshot (has a value). */
  ok: boolean;
}

/** Text summary set beside the trend chart (accessibility: latest/min/max). Owned by u3. */
export interface TrendSummary {
  latest: number | null;
  min: number | null;
  max: number | null;
  /** Number of normal (valued) points in the window. */
  count: number;
}

/** Per-window aggregation result. Owned by u3 (u4 imports and wires it). */
export interface TrendSeries {
  window: TrendWindow;
  points: TrendPoint[];
  summary: TrendSummary;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Look-back period per window (ms). "all" is unbounded. */
const WINDOW_MS: Record<Exclude<TrendWindow, "all">, number> = {
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

/** Maximum number of points drawn in the line chart. Beyond it, downsample evenly (NFR3.2). */
const DEFAULT_MAX_POINTS = 500;

/** Turn one snapshot into a trend point. A point with no value (failed/partial) is value=null. */
function toPoint(s: CreditSnapshot): TrendPoint {
  if (s.ok && s.data.usedAmount !== null) {
    return { ts: s.capturedAt, value: s.data.usedAmount, ok: true };
  }
  return { ts: s.capturedAt, value: null, ok: false };
}

/**
 * Even downsampling. The first and last points are always kept. At or below maxPoints, the input is returned as is.
 */
function downsample(points: TrendPoint[], maxPoints: number): TrendPoint[] {
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const result: TrendPoint[] = [];
  const stride = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * stride);
    const p = points[Math.min(idx, points.length - 1)];
    if (p !== undefined) result.push(p);
  }
  return result;
}

/**
 * Snapshot array → TrendSeries for one window.
 * @param snapshots snapshots read from storage (assumed in time order, re-sorted defensively).
 * @param window    7 days / 30 days / all.
 * @param now       reference time (injectable for tests).
 * @param maxPoints downsampling cap (default 500).
 */
export function buildTrend(
  snapshots: CreditSnapshot[],
  window: TrendWindow,
  now: Date = new Date(),
  maxPoints: number = DEFAULT_MAX_POINTS,
): TrendSeries {
  const nowMs = now.getTime();

  const filtered = snapshots.filter((s) => {
    if (window === "all") return true;
    const t = Date.parse(s.capturedAt);
    if (Number.isNaN(t)) return false; // a timestamp that cannot be parsed is left out of the window
    return nowMs - t <= WINDOW_MS[window];
  });

  // Defensive time-order sort (storage guarantees order, but a pure function stays independent of it).
  filtered.sort((a, b) => {
    if (a.capturedAt < b.capturedAt) return -1;
    if (a.capturedAt > b.capturedAt) return 1;
    return a.sequence - b.sequence;
  });

  const allPoints = filtered.map(toPoint);
  const points = downsample(allPoints, maxPoints);

  // SUMMARY IS OVER THE WINDOW, NOT OVER THE DRAWN POINTS. It used to read `points`,
  // which is the downsampled set, so past 500 snapshots `count` froze at 500 while its
  // own doc says "number of valued points in the window" — and min/max lost whatever the stride skipped.
  // Reachable in ordinary use: at 5-minute polling 500 points is about 42 hours, and the 7-day window holds 2016.
  // Measured (1001 inputs): count 500, and the maximum 999999 placed at position 502 went missing as 1000.
  // The text summary sits beside the chart for a reader who cannot see it, so it must
  // describe the DATA; a pixel-accurate summary of a lossy line answers nobody.
  const values: number[] = [];
  for (const p of allPoints) {
    if (p.value !== null) values.push(p.value);
  }

  const summary: TrendSummary = {
    latest: values.length > 0 ? (values[values.length - 1] ?? null) : null,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
    count: values.length,
  };

  return { window, points, summary };
}
