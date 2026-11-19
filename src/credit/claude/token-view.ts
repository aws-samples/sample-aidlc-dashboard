// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * ClaudeTokenView — renders the `TokenViewModel` as an HTML string in the host's look and feel.
 *
 * It takes the same card slot as Kiro's `renderCredit` and uses the same host primitives (`section`,
 * `pill`, `esc`, `bar`) and the same chart (`renderLineChart`), because the two panels must look like
 * siblings. Only the table's content differs: measured tokens, not a quota (plan, limit, remaining,
 * usage ratio).
 *
 * The usage ratio (% of a limit) is not drawn. Claude Code's local data has no limit, so there is no
 * denominator. A configured limit could make a %, but then an unmeasured value would sit in a measured
 * value's place (the host's "no unlabelled numbers" rule).
 *
 * Escaping rule: external text (model names, paths, aggregate notes) always goes through `esc()`.
 * Missing values are `"—"`. Read-only — no side effects.
 */

import { bar, esc, hours, pill, section, shortTs } from "../../render/common";
import type { Strings } from "../../render/i18n";
import type { TrendWindow } from "../trend/trend";
import { renderLineChart } from "../view/svg-chart";
import type { TokenNote, TokenStatus, TokenViewModel } from "./token-model";
import { totalOf } from "./transcript-reader";

/** Window names and chip labels belong to the catalogue (`render/i18n`). Shares the `?cw=` contract with the Kiro panel. */
function windowLabelOf(w: TrendWindow, s: Strings): string {
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

/** `TokenNote` → sentence. The switch's `never` guard forces every case to be handled. */
function noteText(note: TokenNote, s: Strings): string {
  const t = s.usage;
  const n = (v: number) => fmtNumber(v, s.locale);
  switch (note.code) {
    case "no-transcripts":
      return t.noteNoTranscripts(note.triedPath);
    case "files-capped":
      return t.noteFilesCapped(n(note.count));
    case "unreadable-files":
      return t.noteUnreadableFiles(n(note.count));
    case "malformed-lines":
      return t.noteMalformedLines(n(note.count));
    default: {
      const unhandled: never = note;
      return unhandled;
    }
  }
}

function statusPill(status: TokenStatus, s: Strings): string {
  if (status === "ok") return pill(s.usage.statusOk, "ok");
  if (status === "partial") return pill(s.usage.tokenPartial, "warn");
  return pill(s.usage.statusNone, "mute");
}

/** Thousands separators are the same in ko-KR and en-US (checked) — they do not differ by locale. */
function fmtNumber(n: number | null, locale: string): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toLocaleString(locale);
}

/**
 * 0–1 ratio → percentage with one decimal. Missing is `"—"`.
 *
 * It takes no locale — this panel's `modelTable` already prints shares with `toFixed(1)`, and the
 * decimal point is the same in ko-KR and en-US (the same measured basis as the `fmtNumber` comment).
 */
function fmtPercent(ratio: number | null): string {
  if (ratio === null || Number.isNaN(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** The five token buckets + cache hit ratio + sessions and messages table. The label says thinking is a subset of output. */
function totalsTable(m: TokenViewModel, s: Strings): string {
  const t = s.usage;
  const n = (v: number | null) => fmtNumber(v, s.locale);
  // The third cell is the `<th>`'s title — a ratio row that does not state its denominator is an unlabelled number.
  const rows: [string, string, string?][] = [
    [t.rowTokenTotal, n(m.grandTotal)],
    [t.rowInput, n(m.totals.input)],
    [t.rowOutput, n(m.totals.output)],
    [t.rowThinking, n(m.totals.thinking)],
    [t.rowCacheRead, n(m.totals.cacheRead)],
    [t.rowCacheCreate, n(m.totals.cacheCreate)],
    [t.rowCachedPrompt, fmtPercent(m.cachedPromptRatio), t.rowCachedPromptTip],
    [t.rowSessions, n(m.sessions)],
    [t.rowMessages, n(m.messages)],
  ];
  const body = rows
    .map(([k, v, tip]) => {
      const th =
        tip === undefined ? `<th>${esc(k)}</th>` : `<th title="${esc(tip)}">${esc(k)}</th>`;
      return `<tr>${th}<td class="g-n">${v}</td></tr>`;
    })
    .join("");
  return `<table class="tbl"><tbody>${body}</tbody></table>`;
}

/**
 * Session time breakdown. Draws nothing when there is no record (half the projects have none).
 *
 * **The screen itself says it is a cross-check with no authority.** The timing panel answers the same
 * question from the audit ledger and this is an independent source, so when the two figures differ the
 * reader must know which to trust. It also says that sessions do not map onto stages — which is why it
 * cannot be broken down per stage.
 */
function sessionTimeBlock(m: TokenViewModel, s: Strings): string {
  const st = m.sessionTime;
  if (st === null || st.sessions === 0) {
    // Only straddling sessions and an empty total: state just that fact, with no numbers.
    if (st !== null && st.straddling > 0) {
      return `<p class="note">${esc(s.usage.sessionAllStraddling(fmtNumber(st.straddling, s.locale)))}</p>`;
    }
    return "";
  }
  const t = s.usage;
  const rows: [string, string][] = [
    [t.rowSessionWall, hours(st.totalSec)],
    [
      t.rowSessionApi,
      `${hours(st.apiSec)}${st.apiRatio === null ? "" : ` (${fmtPercent(st.apiRatio)})`}`,
    ],
    [t.rowSessionTool, hours(st.toolSec)],
    [t.rowSessionCount, fmtNumber(st.sessions, s.locale)],
  ];
  const body = rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="g-n">${esc(v)}</td></tr>`)
    .join("");
  const straddling =
    st.straddling > 0
      ? `<p class="note">${esc(t.sessionStraddling(fmtNumber(st.straddling, s.locale)))}</p>`
      : "";
  return `<table class="tbl"><tbody>${body}</tbody></table>
${straddling}
<p class="note">${esc(t.sessionCrossCheck)}</p>`;
}

/** Per-model breakdown table. The share is shown as a bar against the token total (not colour alone — the figure too). */
function modelTable(m: TokenViewModel, s: Strings): string {
  if (m.byModel.length === 0) return "";
  const t = s.usage;
  const n = (v: number | null) => fmtNumber(v, s.locale);
  const rows = m.byModel
    .map((row) => {
      const total = totalOf(row.totals);
      const share = m.grandTotal > 0 ? (total / m.grandTotal) * 100 : null;
      return `<tr>
  <td>${esc(row.model)}</td>
  <td class="g-n">${n(total)}</td>
  <td class="g-n">${n(row.totals.output)}</td>
  <td class="g-n">${n(row.messages)}</td>
  <td class="token-share">${bar(share)}<span class="note">${share === null ? "—" : `${share.toFixed(1)}%`}</span></td>
</tr>`;
    })
    .join("");
  return `<table class="tbl token-models">
  <thead><tr><th>${esc(t.colModel)}</th><th>${esc(t.rowTokenTotal)}</th><th>${esc(
    t.rowOutput,
  )}</th><th>${esc(t.rowMessages)}</th><th>${esc(t.colShare)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

/** Window toggle (radiogroup). Uses the same `?cw=` links and the same `.window-toggle` chip CSS as the Kiro panel. */
function windowToggle(current: TrendWindow, s: Strings): string {
  const radios = WINDOW_ORDER.map(
    (w) =>
      `<a role="radio" aria-checked="${w === current ? "true" : "false"}" href="?cw=${w}">${esc(
        windowChipLabel(w, s),
      )}</a>`,
  ).join("");
  return `<div class="window-toggle" role="radiogroup" aria-label="${esc(
    s.usage.tokenToggleLabel,
  )}">${radios}</div>`;
}

/** Daily token trend + accessible text summary. */
function trendPanel(m: TokenViewModel, window: TrendWindow, s: Strings): string {
  const label = windowLabelOf(m.trend.window, s);
  const { summary } = m.trend;
  const n = (v: number | null) => fmtNumber(v, s.locale);
  const summaryText =
    summary.count === 0
      ? s.usage.tokenChartEmpty(label)
      : s.usage.tokenChartSummary(
          label,
          summary.count,
          n(summary.min),
          n(summary.max),
          n(summary.latest),
        );
  const chart = renderLineChart(m.trend, s, { ariaLabel: summaryText });
  return `<div class="credit-trend">
  ${windowToggle(window, s)}
  <div class="credit-chart">${chart}</div>
  <p class="note">${esc(summaryText)}</p>
</div>`;
}

/**
 * Render the token usage card, wrapped in the host's `section()` so it sits where the Kiro panel does.
 *
 * @param m      the view model (output of assembleTokens).
 * @param window the current window (for the toggle's aria-checked).
 */
export function renderTokens(m: TokenViewModel, window: TrendWindow, s: Strings): string {
  const t = s.usage;
  const parts: string[] = [];

  parts.push(
    `<div class="credit-head">${statusPill(m.status, s)}${pill("Claude Code", "mute")}</div>`,
  );

  for (const note of m.notes) {
    parts.push(`<p class="note warn">${esc(noteText(note, s))}</p>`);
  }

  if (m.status === "none" && m.dir !== null) {
    parts.push(`<p class="note">${esc(t.noTokens)}</p>`);
  }

  if (m.messages > 0) {
    parts.push(`<div class="credit-current">${totalsTable(m, s)}</div>`);
    parts.push(modelTable(m, s));

    const span =
      m.firstActivityAt !== null && m.lastActivityAt !== null
        ? `${esc(shortTs(m.firstActivityAt))} — ${esc(shortTs(m.lastActivityAt))}`
        : "—";
    parts.push(`<p class="note">${t.span(span)}</p>`);

    if (m.sidechainMessages > 0) {
      parts.push(
        `<p class="note">${esc(t.sidechain(fmtNumber(m.sidechainMessages, s.locale)))}</p>`,
      );
    }

    parts.push(sessionTimeBlock(m, s));
  }

  parts.push(trendPanel(m, window, s));

  return section(t.tokenSection, parts.join("\n"), "credit");
}
