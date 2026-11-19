// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * ClaudeTokenModel — assembles the transcript aggregate into the display view model `TokenViewModel`.
 *
 * It takes the same place as the Kiro path's `assembleCredit` (u3), but freshness means something else.
 *
 * Kiro polls a remote `/usage`, so "stale once the last success is more than 10 minutes old" holds.
 * This path re-reads local files on every assemble, so **the displayed value is structurally always
 * current** (just as the host provenance's `disk` is fresh by definition). An old last activity does
 * not mean the data is stale; it means Claude Code was not used in the meantime, so instead of a stale
 * badge it shows `lastActivityAt` as it is. It follows the host rule of not numbing the badge with
 * meaningless warnings (the same reasoning as freshness.ts's judgement of state.md).
 *
 * Pure functions — transcript-reader reads the files; this module turns the aggregate into a view model.
 */

import type { TrendSeries, TrendWindow } from "../trend/trend";
import {
  type ModelBreakdown,
  type SessionTimeAggregate,
  type TokenTotals,
  type TranscriptAggregate,
  totalOf,
} from "./transcript-reader";

/** Display state. `partial` means the aggregate is incomplete (cap, corrupt lines, read failures). */
export type TokenStatus = "none" | "partial" | "ok";

/** Session time breakdown (for display). The view formats the time unit, so seconds are carried here. */
export interface SessionTimeView {
  sessions: number;
  /**
   * Number of sessions left out because they straddle the window edge.
   *
   * There is a reason it is not a `TokenNote`: a note is a defect signal ("the aggregate is
   * incomplete") and renders in the `warn` colour. A session crossing the window is not a defect but
   * the normal shape of sessions that run for days (12 in a 7d window, measured), so painting it as a
   * warning would overstate it. So it is this block's own value, stated plainly inside the block.
   * It does not turn on `status: partial` either.
   */
  straddling: number;
  totalSec: number;
  apiSec: number;
  toolSec: number;
  /**
   * API time / session wall clock (0–1). null when the denominator is 0.
   *
   * Measured percentiles: p10 0.004 · p50 0.141 · p90 0.541 — so the median session is 86% outside the
   * API. That value is the point of this block, and the only independent figure to set against the
   * observed/wait split the timing panel derives from the audit ledger.
   */
  apiRatio: number | null;
}

/** Claude Code token usage view model. Fills the slot matching Kiro's `CreditViewModel`. */
export interface TokenViewModel {
  status: TokenStatus;
  totals: TokenTotals;
  /** Token total (= input + output + cacheRead + cacheCreate). thinking is included in output. */
  grandTotal: number;
  /**
   * Share of prompt tokens read from cache (0–1). null when the denominator is 0.
   *
   * It may sit on this panel because it is **a ratio of two measured values**. What the rule against
   * making a usage ratio from a limit that does not exist (the gauge note in the module header)
   * forbids is a ratio whose denominator was not measured; here numerator and denominator are both
   * numbers read from the transcripts.
   */
  cachedPromptRatio: number | null;
  /**
   * Session time breakdown. null when there is no `cost-state` record, and then the panel does not draw this block.
   *
   * **A cross-check with no authority.** The timing panel answers the same question ("how long did it
   * work and how long did it wait") from the audit ledger, and this answers it from a fully independent
   * source — the same place `runtime-graph` takes as a cross-check against the audit. Sessions do not
   * map onto stages or units, so only a whole-run comparison is possible, and the screen says so.
   */
  sessionTime: SessionTimeView | null;
  byModel: ModelBreakdown[];
  messages: number;
  sidechainMessages: number;
  sessions: number;
  /** Daily token-total series. The host's `renderLineChart` consumes it as is. */
  trend: TrendSeries;
  /** Time of the last message (ISO). null with no activity. */
  lastActivityAt: string | null;
  /** Time of the first message in the window (ISO). */
  firstActivityAt: string | null;
  /** The transcript directory read. null when not found. */
  dir: string | null;
  /** The path tried when the directory was not found — the screen says what it looked for. */
  triedPath: string;
  /** Why the aggregate is incomplete. Shown on screen as is when not empty. */
  /**
   * The cautions shown on screen, carried **as codes** (the sentences belong to `render/i18n`).
   *
   * For the same reason as `model.warnings`: if the model layer built Korean paragraphs, no further
   * language could be added, and `/api/model` would carry prose. The numbers here are facts, so they
   * travel with the code, and the view formats digit grouping for the locale.
   */
  notes: TokenNote[];
}

/** Turn the daily aggregate into the TrendSeries the host chart consumes. */
function toTrend(daily: { date: string; total: number }[], window: TrendWindow): TrendSeries {
  const points = daily.map((d) => ({
    // Local midnight. The chart only uses Date.parse on the x axis, so days stay evenly spaced.
    ts: `${d.date}T00:00:00`,
    value: d.total,
    ok: true,
  }));
  const values = daily.map((d) => d.total);
  return {
    window,
    points,
    summary: {
      latest: values.length > 0 ? (values[values.length - 1] ?? null) : null,
      min: values.length > 0 ? Math.min(...values) : null,
      max: values.length > 0 ? Math.max(...values) : null,
      count: values.length,
    },
  };
}

/**
 * Share of prompt tokens read from cache. null when the denominator is 0.
 *
 * **The denominator is all three prompt-side buckets**, because all three fields the transcripts carry
 * are of the `*_input_tokens` family — `input_tokens` (input that did not go through the cache),
 * `cache_read_input_tokens` (input read from cache), `cache_creation_input_tokens` (input written to
 * cache while processing). `totalOf()` adds the same three.
 *
 * Dropping `cacheCreate` from the denominator reads **100% even in a window that built a large cache
 * anew** — the prompt spent filling the cache disappears from the count, which no longer answers the
 * question this value is meant to answer ("how much of the prompt was served from cache"). `output` is
 * not a prompt, so it is not in the denominator.
 */
function cachedPromptRatioOf(t: TokenTotals): number | null {
  const prompt = t.input + t.cacheRead + t.cacheCreate;
  return prompt > 0 ? t.cacheRead / prompt : null;
}

/** Reader aggregate → display. With no record (half the projects have none) it passes null through as is. */
function sessionTimeOf(agg: SessionTimeAggregate | null): SessionTimeView | null {
  if (agg === null) return null;
  const totalSec = agg.totalMs / 1000;
  return {
    sessions: agg.sessions,
    straddling: agg.straddling,
    totalSec,
    apiSec: agg.apiMs / 1000,
    toolSec: agg.toolMs / 1000,
    apiRatio: agg.totalMs > 0 ? agg.apiMs / agg.totalMs : null,
  };
}

/**
 * The caution that the aggregate is incomplete — a code and its facts only; the sentence belongs to
 * `render/i18n`. A closed union, so the type forces `token-view`'s switch to handle every case.
 */
export type TokenNote =
  | { code: "no-transcripts"; triedPath: string }
  | { code: "files-capped"; count: number }
  | { code: "unreadable-files"; count: number }
  | { code: "malformed-lines"; count: number };

/**
 * Aggregate → view model. The state is decided in the order `none` (no data) → `partial` (incomplete) → `ok`.
 *
 * @param agg    the aggregate transcript-reader produced.
 * @param window the current window (for the window toggle).
 */
export function assembleTokens(agg: TranscriptAggregate, window: TrendWindow): TokenViewModel {
  const notes: TokenNote[] = [];

  if (agg.dir === null) {
    notes.push({ code: "no-transcripts", triedPath: agg.triedPath });
  }
  if (agg.filesCapped > 0) {
    notes.push({ code: "files-capped", count: agg.filesCapped });
  }
  if (agg.unreadableFiles > 0) {
    notes.push({ code: "unreadable-files", count: agg.unreadableFiles });
  }
  if (agg.malformedLines > 0) {
    notes.push({ code: "malformed-lines", count: agg.malformedLines });
  }

  const incomplete = agg.filesCapped > 0 || agg.unreadableFiles > 0 || agg.malformedLines > 0;
  // `none` is **only when there really is no usage**. An incomplete aggregate is `partial` even with 0
  // messages — a single file over the cap leaves filesRead 0 and messages 0, and returning `none` then
  // shows "no usage in this period — try a wider window". There is usage, and a wider window hits the cap
  // harder. This was where the no-silent-truncation rule broke.
  const status: TokenStatus =
    agg.messages === 0 && !incomplete ? "none" : incomplete ? "partial" : "ok";

  return {
    status,
    totals: agg.totals,
    grandTotal: totalOf(agg.totals),
    cachedPromptRatio: cachedPromptRatioOf(agg.totals),
    sessionTime: sessionTimeOf(agg.sessionTime),
    byModel: agg.byModel,
    messages: agg.messages,
    sidechainMessages: agg.sidechainMessages,
    sessions: agg.sessions,
    trend: toTrend(agg.daily, window),
    lastActivityAt: agg.lastAt,
    firstActivityAt: agg.firstAt,
    dir: agg.dir,
    triedPath: agg.triedPath,
    notes,
  };
}
