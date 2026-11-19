// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * CreditView — renders the `CreditViewModel` as a server-side HTML string in the host's look and feel
 * (BR2.x, BR3.2, BR4.1, NFR1.1, NFR1.2, NFR7).
 *
 * It turns credit-dashboard's `src/ui/app.ts` client-side fetch (`/api/current`, `/api/trend`) + DOM
 * rendering into **server-side string rendering**. No new JSON endpoint: switching the trend window is
 * a server re-render through `?cw=7d|30d|all` links (a radiogroup).
 *
 * Escaping rule: external text in the HTML context goes through the host's `esc()`
 * (`../../render/common`), in the SVG context through `escapeXml` (svg-chart). Uncontracted external
 * text (`planName`, `warning.raw`, `reason`) is always escaped. Missing values become `"—"`, so no
 * `undefined`/`NaN`/`[object Object]` leaks. Read-only: no storage or write side effects (NFR1.4).
 */

import { bar, esc, pill, section, shortTs } from "../../render/common";
import type { Strings } from "../../render/i18n";
import type { PollHalt } from "../pipeline/polling-scheduler";
import type { TrendWindow } from "../trend/trend";
import type { ParsedUsage } from "../types";
import type { CreditStatus, CreditViewModel } from "./credit-model";
import { buildAriaLabel, renderLineChart } from "./svg-chart";

/** Wording belongs to the catalogue (`render/i18n`) — this only sets the window order and tone. */
function windowLabel(w: TrendWindow, s: Strings): string {
  return w === "7d"
    ? s.usage.windowLong7d
    : w === "30d"
      ? s.usage.windowLong30d
      : s.usage.windowLongAll;
}

/** Window toggle radio definitions (display order). */
const WINDOW_ORDER: readonly TrendWindow[] = ["7d", "30d", "all"];

function windowChipLabel(w: TrendWindow, s: Strings): string {
  return w === "7d" ? s.usage.window7d : w === "30d" ? s.usage.window30d : s.usage.windowAll;
}

/** Badge per state. Reuses the host's `pill()`. */
function statusPill(status: CreditStatus, s: Strings): string {
  const t = s.usage;
  if (status === "loading") return pill(t.statusLoading, "mute");
  if (status === "ok") return pill(t.statusOk, "ok");
  if (status === "partial") return pill(t.statusPartial, "warn");
  if (status === "failure") return pill(t.statusFailure, "bad");
  return pill(t.statusNone, "mute");
}

/** Number format (missing and NaN become an em dash). */
function fmtNumber(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

/** Usage-ratio format (0–1 ratio → %). Missing and NaN become an em dash. */
function fmtRatio(r: number | null): string {
  if (r === null || Number.isNaN(r)) return "—";
  return `${(r * 100).toFixed(1)}%`;
}

/**
 * Sanitise the `?cw` query value to an allowed window (NFR1.3). Only `7d`/`30d`/`all` are accepted;
 * invalid, injected or absent values fall back to `30d`.
 */
export function resolveWindow(cw: string | null | undefined): TrendWindow {
  if (cw === "7d" || cw === "30d" || cw === "all") return cw;
  return "30d";
}

/**
 * Render the five current figures as a table. Missing values are "—". External text (planName) is escaped.
 *
 * `resetDate` is parsed but not put in the table — a field taken off the screen, so it remains in
 * `ParsedUsage`, storage and the trend.
 */
function metricsTable(current: ParsedUsage, s: Strings): string {
  const t = s.usage;
  const rows: [string, string][] = [
    [t.rowPlan, esc(current.planName ?? "—")],
    [t.rowUsed, fmtNumber(current.usedAmount)],
    [t.rowRemaining, fmtNumber(current.remainingAmount)],
    [t.rowLimit, fmtNumber(current.planLimit)],
    [t.rowRatio, fmtRatio(current.usageRatio)],
  ];
  const body = rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="g-n">${v}</td></tr>`)
    .join("");
  return `<table class="tbl"><tbody>${body}</tbody></table>`;
}

/** Usage-ratio progress bar + an accessible progressbar. Not computable (null) gives an empty track + a note. */
function progressBlock(ratio: number | null, s: Strings): string {
  const pct = ratio === null ? null : Math.max(0, Math.min(100, ratio * 100));
  const label = ratio === null ? s.usage.ratioUnavailable : s.usage.ratioLabel(fmtRatio(ratio));
  const valueNow = pct === null ? "" : ` aria-valuenow="${pct.toFixed(1)}"`;
  return `<div class="credit-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"${valueNow} aria-label="${esc(label)}">
  ${bar(pct)}
  <p class="note">${esc(label)}</p>
</div>`;
}

/** Failure warning banner (role=alert). Both the reason and the raw output are escaped. */
function warningBanner(warning: { raw: string; reason: string }, s: Strings): string {
  const t = s.usage;
  return `<div class="warnbox" role="alert">
  ${esc(t.fetchFailed(warning.reason))}
  <details><summary>${esc(t.rawSummary)}</summary><pre>${esc(
    warning.raw || t.rawEmpty,
  )}</pre></details>
</div>`;
}

/**
 * Notice that automatic collection stopped.
 *
 * A **separate fact** from `warningBanner`, so a separate block — the banner says "the last attempt
 * failed", this one "so it no longer tries". Merged, the reader would take the number on screen for a
 * value still being updated, when in fact it stays as it is for good.
 */
function haltNotice(halt: PollHalt, s: Strings): string {
  const t = s.usage;
  // Pass the minutes **as a number only** — attaching the unit belongs to the catalogue (a Korean literal
  // in a render module is exactly the defect `### Page language` exists to prevent).
  const retryEvery = String(Math.max(1, Math.round(halt.retryEveryMs / 60_000)));
  return `<div class="warnbox" role="status">
  ${esc(t.pollHalted(String(halt.failures), retryEvery))}
  ${halt.lastReason === undefined ? "" : `<div class="note">${esc(t.pollHaltedReason(halt.lastReason))}</div>`}
</div>`;
}

/**
 * Trend window toggle (radiogroup). Only the current window has aria-checked="true". Re-rendered on the
 * server through `?cw=` links.
 *
 * The chip shape is entirely the `.window-toggle a` CSS — the `pickbtn` class it used to carry is scoped
 * to `header.top nav`, so here it styled nothing, and the three windows ran together as three bare
 * links that read as one phrase.
 */
function windowToggle(current: TrendWindow, s: Strings): string {
  const radios = WINDOW_ORDER.map(
    (w) =>
      `<a role="radio" aria-checked="${w === current ? "true" : "false"}" href="?cw=${w}">${esc(
        windowChipLabel(w, s),
      )}</a>`,
  ).join("");
  return `<div class="window-toggle" role="radiogroup" aria-label="${esc(
    s.usage.trendToggleLabel,
  )}">${radios}</div>`;
}

/** Trend panel: window toggle + line chart (SVG) + text summary (for accessibility). */
function trendPanel(model: CreditViewModel, window: TrendWindow, s: Strings): string {
  const chart = renderLineChart(model.trend, s);
  const summaryText = buildAriaLabel(model.trend, windowLabel(model.trend.window, s), s);
  return `<div class="credit-trend">
  ${windowToggle(window, s)}
  <div class="credit-chart">${chart}</div>
  <p class="note">${esc(summaryText)}</p>
</div>`;
}

/**
 * Render the credit view as an HTML string in the host's look and feel, wrapped in the host's `section()` card.
 * Placing it at the top (replacing the blockers panel) is u4's wiring into the host page.
 *
 * @param model  the u3-owned view model (output of assembleCredit).
 * @param window the current trend window (for the toggle's aria-checked).
 */
export function renderCredit(model: CreditViewModel, window: TrendWindow, s: Strings): string {
  const t = s.usage;
  const parts: string[] = [];

  const stalePill = model.freshness.stale ? ` ${pill(t.stalePill, "warn")}` : "";
  parts.push(`<div class="credit-head">${statusPill(model.status, s)}${stalePill}</div>`);

  if (model.status === "loading") {
    parts.push(`<p class="note" role="status">${esc(t.firstCollection)}</p>`);
  }

  if (model.status === "none") {
    parts.push(`<p class="note">${esc(t.noCreditYet)}</p>`);
  }

  if (model.pollHalt !== null) {
    parts.push(haltNotice(model.pollHalt, s));
  }

  if (model.status === "failure" && model.warning !== null) {
    parts.push(warningBanner(model.warning, s));
  }

  if (model.freshness.stale) {
    parts.push(`<p class="note warn">${esc(t.staleNote)}</p>`);
  }

  if (model.current !== null) {
    // The donut gauge was removed. The table, the text under the bar and the gauge said the same ratio
    // three times, and it was a shape found nowhere else on the page, so this panel looked as if it came
    // from another screen. The table and the bar state the ratio.
    parts.push(`<div class="credit-current">${metricsTable(model.current, s)}</div>`);
    parts.push(progressBlock(model.current.usageRatio, s));
    parts.push(
      `<p class="note">${esc(t.lastSuccess(shortTs(model.lastSuccessAt ?? undefined)))}</p>`,
    );
  }

  parts.push(trendPanel(model, window, s));

  return section(t.creditSection, parts.join("\n"), "credit");
}
