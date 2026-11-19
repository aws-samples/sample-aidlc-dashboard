// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CreditModelAssembler — assembles the stored snapshots into the display view model `CreditViewModel`
 * (BR1.1–BR1.5).
 *
 * A u3-owned view model. It is a standalone named type rather than an indexed access into the host's
 * `DashboardModel["credit"]`, avoiding a u3→u4 back reference and cycle (functional-design review
 * Finding #1). u4 imports `CreditViewModel` and wires it into the `DashboardModel.credit` slot (u4→u3,
 * one direction).
 *
 * Read-only: it reads only the store's `latest()`/`readAll()` (synchronous) and has no write side
 * effects (NFR1.4). It does not call u2 (collection) directly (one-directional layering).
 */

import type { PollHalt } from "../pipeline/polling-scheduler";
import { type TrendSeries, type TrendWindow, buildTrend } from "../trend/trend";
import type { CreditSnapshot, ParsedUsage } from "../types";

/** A last success older than this is stale (freshness lost) (AC7.1.2). */
const STALE_MS = 10 * 60 * 1000;

/** The minimal read interface of the store assembleCredit reads (u1's SnapshotStore satisfies it). */
export interface CreditReadStore {
  latest(): CreditSnapshot | null;
  readAll(): CreditSnapshot[];
}

/** Credit display state. Freshness is expressed independently of the state. */
export type CreditStatus = "loading" | "none" | "partial" | "failure" | "ok";

/**
 * u3-owned display view model. u4 imports this type and wires it into the host model.
 * u3 never refers to the host's `DashboardModel`.
 */
export interface CreditViewModel {
  /** Display state (loading/none/partial/failure/ok). */
  status: CreditStatus;
  /** Figures of the last success snapshot. null with no success history. Kept under failure too. */
  current: ParsedUsage | null;
  /** Capture time of the last success (ISO). null with no success history. */
  lastSuccessAt: string | null;
  /** Freshness of the last success value. Can be stale at the same time as a failure state. */
  freshness: { stale: boolean; lastSuccessAt: string | null };
  /** Trend aggregated for the injected window. */
  trend: TrendSeries;
  /** The raw output and reason when the latest snapshot is a failure; otherwise null. */
  warning: { raw: string; reason: string } | null;
  /**
   * Why automatic polling stopped after repeated failures, or null when it did not.
   *
   * A different fact from `warning`: `warning` is "the last attempt failed", this is "so it no longer
   * tries". Merged, they would let the reader take the number on screen for a value still being updated.
   */
  pollHalt: PollHalt | null;
}

/**
 * Assemble the stored snapshots into a `CreditViewModel`.
 *
 * State order: loading/none → failure (the latest is a failure) → partial → ok. The last success's
 * freshness is a separate field, so failure and stale can be expressed at once.
 *
 * @param store read-only store (latest/readAll, synchronous).
 * @param now   reference time (injected in tests — decides the 10-minute boundary).
 * @param window trend aggregation window (default 30d).
 * @param collecting whether the first collection is running.
 */
export function assembleCredit(
  store: CreditReadStore,
  now: Date = new Date(),
  window: TrendWindow = "30d",
  collecting = false,
  pollHalt: PollHalt | null = null,
): CreditViewModel {
  const all = store.readAll();
  const trend = buildTrend(all, window, now);

  // The last success snapshot (the ok=true with the highest sequence). readAll is sorted by capturedAt
  // then sequence, so the first success found from the end is the latest success.
  let lastSuccess: CreditSnapshot | null = null;
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i];
    if (s?.ok) {
      lastSuccess = s;
      break;
    }
  }

  const current: ParsedUsage | null = lastSuccess?.ok ? lastSuccess.data : null;
  const lastSuccessAt = lastSuccess?.capturedAt ?? null;

  const latest = store.latest();
  const warning =
    latest !== null && latest.ok === false ? { raw: latest.raw, reason: latest.reason } : null;

  const stale = isStale(lastSuccessAt, now);
  const status = resolveStatus(all.length, lastSuccess, latest, collecting);

  return {
    status,
    current,
    lastSuccessAt,
    freshness: { stale, lastSuccessAt },
    trend,
    warning,
    pollHalt,
  };
}

function isStale(lastSuccessAt: string | null, now: Date): boolean {
  if (lastSuccessAt === null) return false;
  const capturedAt = Date.parse(lastSuccessAt);
  return !Number.isNaN(capturedAt) && now.getTime() - capturedAt > STALE_MS;
}

/** Pure state function. The latest collection result takes precedence over freshness. */
function resolveStatus(
  total: number,
  lastSuccess: CreditSnapshot | null,
  latest: CreditSnapshot | null,
  collecting: boolean,
): CreditStatus {
  if (total === 0) return collecting ? "loading" : "none";

  // failure: the latest snapshot is a failure.
  if (latest !== null && latest.ok === false) return "failure";

  // partial: the latest success is a partial parse.
  if (lastSuccess?.ok && lastSuccess.data.partial) return "partial";

  return "ok";
}
