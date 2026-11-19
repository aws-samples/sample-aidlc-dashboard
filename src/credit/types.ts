// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Shared types of the credit subsystem — owned by u1-credit-storage.
 *
 * Design rationale:
 * - `CreditSnapshot` is the snapshot representation that storage, aggregation and display consume
 *   (contract-summary C1/C2). Its identity is not the single `capturedAt` field but `capturedAt` + a
 *   monotonic `sequence` + `source` together, so simultaneous (auto + manual) captures do not collide
 *   (entities.md, BR1.2).
 * - A success snapshot keeps no raw output (the volatility contract BR1.6, project.md ## Forbidden).
 *   Only a failure snapshot keeps the raw output and the reason, for diagnosis and warnings.
 * - `ParsedUsage` is not a separate entity but a value object of `CreditSnapshot`. u2 CreditParser
 *   produces the value, but the type is owned with the entity by u1 (avoiding a cycle,
 *   contract-summary Finding #2).
 *
 * This file defines u1-owned types only. Types that other units produce and own, such as
 * `ParseResult` (u2) and `TrendSeries` (u3), are not defined here (producer-owned, Q3=A).
 */

/** Credit figures a parse obtained. On a partial parse, the fields it could not obtain are `null`. */
export interface ParsedUsage {
  /** Plan name (e.g. "Pro"). null when not obtained. */
  planName: string | null;
  /** Cumulative usage. */
  usedAmount: number | null;
  /** Remaining amount. */
  remainingAmount: number | null;
  /** Plan limit. */
  planLimit: number | null;
  /** Usage ratio (normalised 0–1). Kept as a ratio, not a %, so the figure can be shown beside it. */
  usageRatio: number | null;
  /** Reset date (string taken from the source output, e.g. "2026-09-01"). */
  resetDate: string | null;
  /** true when any of the six fields is null (whether the parse was partial). */
  partial: boolean;
}

/** The path that triggered the capture. Also the tie-break of the simultaneous-capture identity. */
export type CaptureSource = "auto" | "manual";

/** Capture metadata every snapshot shares (identity). */
export interface SnapshotMeta {
  /** Capture time (ISO 8601 UTC). The primary key of the readAll order. */
  capturedAt: string;
  /** Monotonically increasing sequence (INTEGER PRIMARY KEY). Tie-break against same-instant capture collisions. */
  sequence: number;
  /** Capture trigger path (auto = polling, manual = manual refresh). */
  source: CaptureSource;
}

/** A parse-success snapshot. The raw output is not kept (volatile, BR1.6). */
export interface SuccessSnapshot extends SnapshotMeta {
  ok: true;
  data: ParsedUsage;
}

/** A parse/collection failure snapshot. Keeps the raw output and the reason for diagnosis and warnings. */
export interface FailureSnapshot extends SnapshotMeta {
  ok: false;
  /** The raw output kept on failure. Absent from success snapshots. */
  raw: string;
  /** Failure class and reason (timeout / abnormal exit / empty output / parse failure, etc.). */
  reason: string;
}

/** The snapshot representation storage, queries and display consume. A discriminated union, success/failure told by `ok`. */
export type CreditSnapshot = SuccessSnapshot | FailureSnapshot;
