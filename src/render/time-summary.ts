// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Where the time went, and what the run has spent — the two summaries under the journey.
// Neither reads anything new: the split is the timing panel's own (`breakdown`, the same
// five buckets over the same denominator), the stage rows are `timing.stages`, and the
// usage figure is the KPI tile's. What this module adds is putting them where they are
// read first, with the rules each one already carried stated in place:
//
//   - The split divides the CLASSIFIED span, never the window. Nothing after the last
//     event is classified, so that stretch is said once, in words, and is in no bucket —
//     dividing by the window would make every share shrink on a quiet tree.
//   - A stage row's LENGTH is calendar occupancy and its FILL is that stretch's own split
//     (a bar's length and its colour must not answer the same question). Observed and
//     unclassified are two figures, never one "work estimate": unclassified is time the
//     ledger does not explain, and summing it in read it as work — the doctor fix (D3)
//     moved ≈252h of doctor-ended gaps into it on the local records, and the sum grew
//     though nothing measured had changed. Stages rank by OBSERVED; when adding
//     unclassified would name another stage, the note says both. A 0-second stage is a
//     tick.
//   - Hours, never days (`hours()`): a reader spends a "day" as about eight working hours.
//   - With an audit path refused, the whole-run claims say "in what was read".
//   - Credit is never clamped: the source's own ratio first, an overage shown as one. A
//     value from a collection that has since failed is labelled with its date beside the
//     number, not only in a footer. Claude Code tokens get no gauge — there is no limit
//     to divide by, and none is synthesised.

import type { DashboardModel } from "../model/types";
import { DRILL } from "./card-kit";
import { esc, hours } from "./common";
import type { Strings } from "./i18n";
import { compact, windowLong } from "./kpi";
import { breakdown, unknownSplitTip } from "./timeline";

function stageName(m: DashboardModel, slug: string): string {
  return m.state.phases.flatMap((p) => p.stages).find((x) => x.slug === slug)?.display ?? slug;
}

function timeCard(m: DashboardModel, s: Strings): string {
  const x = s.tsum;
  const t = m.timing;
  const classified = t.elapsedSec - t.sinceLastEventSec;
  const more = `<a href="#${DRILL.timeline}" data-drill="${DRILL.timeline}">${esc(x.more)}</a>`;
  // No audit event at all, or nothing classified: the same empty test the old tile used.
  if (!t.firstTs || !(classified > 0)) {
    return `<section class="ts-time card"><header class="ts-head"><h2>${esc(x.title)}</h2></header><p class="ts-empty">${esc(
      m.partialAudit ? x.emptyPartial(m.partialAudit.notRead) : x.empty,
    )} · ${more}</p></section>`;
  }
  const lede = m.partialAudit
    ? x.classifiedPartial(hours(classified), m.partialAudit.notRead)
    : x.classified(hours(classified));
  const tail =
    t.sinceLastEventSec > 0 && !m.state.complete
      ? `<p class="ts-note">${esc(x.tail(hours(t.sinceLastEventSec)))}</p>`
      : "";
  // On a multi-clone run the merged split is the team's clock, not a per-person figure —
  // the timing panel's own note, said here too so the summary cannot read as one person's.
  const merged = t.parallel
    ? `<p class="ts-note warn">${s.timeline.mergedNote(t.workers.length, t.clones)}</p>`
    : "";
  return `<section class="ts-time card"><header class="ts-head"><h2>${esc(x.title)}</h2><p>${esc(
    lede,
  )}</p></header>${breakdown(t.total, classified, s)}${tail}${merged}<p class="ts-note">${more}</p></section>`;
}

function usageCard(m: DashboardModel, s: Strings): string {
  const x = s.tsum;
  const k = s.kpi;
  if (m.usage.kind === "claude") {
    const tk = m.usage.tokens;
    const none = tk.status === "none";
    return `<section class="ts-usage card"><header class="ts-head"><h2>${esc(s.usage.tokenSection)}</h2></header><p class="ts-big${
      none ? " missing" : ""
    }">${esc(none ? "—" : compact(tk.grandTotal))}</p><p class="ts-sub">${esc(
      none ? k.usageNone : k.tokenSub(windowLong(tk.trend.window, s)),
    )}</p><p class="ts-note">${esc(x.tokensNoLimit)}</p></section>`;
  }
  const cr = m.usage.credit;
  const cur = cr.current;
  const used = cur?.usedAmount ?? null;
  const limit = cur?.planLimit ?? null;
  const ratio =
    cur?.usageRatio ?? (used !== null && limit !== null && limit > 0 ? used / limit : null);
  const head = `<header class="ts-head"><h2>${esc(s.usage.creditSection)}</h2>${
    cur?.planName ? `<p>${esc(cur.planName)}</p>` : ""
  }</header>`;
  if (used === null || ratio === null) {
    return `<section class="ts-usage card">${head}<p class="ts-big missing">—</p><p class="ts-sub">${esc(
      k.usageNone,
    )}</p></section>`;
  }
  const stale = cr.status === "failure" || cr.freshness.stale;
  const when = cr.lastSuccessAt ? cr.lastSuccessAt.slice(5, 10) : "";
  const over = ratio > 1;
  const meter = `<div class="ts-meter${over ? " over" : ""}" role="img" aria-label="${esc(
    `${(ratio * 100).toFixed(1)}%`,
  )}"><i style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></i></div>`;
  const sub = [
    limit !== null ? x.creditOf(compact(limit), compact(used)) : compact(used),
    cur?.resetDate ? x.resets(cur.resetDate.slice(5)) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<section class="ts-usage card${stale ? " stale" : ""}">${head}<p class="ts-big">${(
    ratio * 100
  ).toFixed(1)}<span>%</span></p>${meter}<p class="ts-sub">${esc(sub)}</p>${
    over ? `<p class="ts-note warn">${esc(x.over)}</p>` : ""
  }${stale ? `<p class="ts-note warn">${esc(cr.status === "failure" ? x.staleFailed(when) : x.stale(when))}</p>` : ""}</section>`;
}

function stagesCard(m: DashboardModel, s: Strings): string {
  const x = s.tsum;
  // Under unit-major a per-unit stage's span is not its work: Current Stage stays on the
  // first per-unit stage while units walk the later ones, and the engine defers the later
  // stages' transitions, so the first span holds every unit's work and the later ones are
  // seconds wide or absent (measured on a finished 2.11.4 run: Functional Design's span
  // 51.4 min, Code Generation's 0.3 min against 32 min of its units). A per-unit stage is
  // compared by the same estimate summed over its recorded unit segments; one with no unit
  // segment recorded has no comparable figure and stays out of the ranking rather than
  // entering it through a pooled span. A segment of unknown length makes the sum a floor.
  // No unit row at all — receipts not in use — leaves every stage on its span, since
  // nothing better was recorded.
  const perUnit = new Set(m.timing.units.length > 0 ? m.unitMajorStages : []);
  const byUnits = new Map<
    string,
    { observed: number; unknown: number; toTurn: number; floor: boolean }
  >();
  for (const u of m.timing.units) {
    if (!perUnit.has(u.stage)) continue;
    const row = byUnits.get(u.stage) ?? { observed: 0, unknown: 0, toTurn: 0, floor: false };
    row.observed += u.observedSec;
    row.unknown += u.unknownSec;
    row.toTurn += u.unknownToTurnSec;
    row.floor ||= u.segments.some((g) => g.durationUnknown);
    byUnits.set(u.stage, row);
  }
  // A per-unit stage the units reached before its own STAGE_STARTED has no span yet.
  const spans = m.timing.stages;
  const unspanned = [...byUnits.keys()].filter((st) => !spans.some((r) => r.stage === st));
  const rows: Array<(typeof spans)[number] | { stage: string; unspanned: true }> = [
    ...spans,
    ...unspanned.map((stage) => ({ stage, unspanned: true as const })),
  ];
  if (rows.length === 0) return "";
  const max = Math.max(1, ...spans.map((r) => r.elapsedSec));
  /** The two compared figures, or undefined when the stage has none comparable. */
  const figures = (
    r: (typeof rows)[number],
  ): { observed: number; unknown: number; toTurn: number } | undefined => {
    const u = byUnits.get(r.stage);
    if (u) return u;
    if (perUnit.has(r.stage) || "unspanned" in r) return undefined;
    return { observed: r.observedSec, unknown: r.unknownSec, toTurn: r.unknownToTurnSec };
  };
  // A stage is named only for a figure above zero: with nothing observed, "the most
  // observed" would name whichever row came first (found in review, reproduced).
  const rankBy = (pick: (f: { observed: number; unknown: number }) => number) =>
    [...rows]
      .filter((r) => figures(r) !== undefined && pick(figures(r)!) > 0)
      .sort((a, b) => pick(figures(b)!) - pick(figures(a)!))[0];
  const top = rankBy((f) => f.observed);
  const withUnknown = rankBy((f) => f.observed + f.unknown);
  const alt =
    withUnknown && withUnknown.stage !== top?.stage ? stageName(m, withUnknown.stage) : undefined;
  const b = s.timeline;
  const body = rows
    .map((r) => {
      const name = stageName(m, r.stage);
      const u = byUnits.get(r.stage);
      const f = figures(r);
      const plus = u?.floor ? "+" : "";
      const splitTip =
        f === undefined
          ? ""
          : unknownSplitTip({ unknownSec: f.unknown, unknownToTurnSec: f.toTurn }, s);
      const figure =
        f === undefined
          ? `<span class="ts-w ts-none">—</span><span class="ts-u ts-none">—</span>`
          : `<span class="ts-w${u ? " ts-units" : ""}">${esc(hours(f.observed))}${plus}</span><span class="ts-u${
              u ? " ts-units" : ""
            }" title="${esc(u ? `${splitTip} · ${x.unitsUnknownTip}` : splitTip)}">${esc(hours(f.unknown))}${plus}</span>`;
      const unitTip = u
        ? ` · ${x.unitsWorkTip}${u.floor ? x.unitsWorkFloorTip : ""}`
        : f === undefined && !("unspanned" in r)
          ? ` · ${x.unitsNoneTip}`
          : "";
      if ("unspanned" in r) {
        return `<li title="${esc(`${name} — ${x.unspannedTip}${unitTip}`)}"><span class="ts-n">${esc(
          name,
        )}</span><span class="ts-b"></span>${figure}<span class="ts-e">—</span></li>`;
      }
      const parts = [
        ["observed", r.observedSec, b.bucketObserved],
        ["wait", r.humanWaitSec, b.bucketWait],
        ["conv", r.conversationSec, b.bucketConversation],
        ["parked", r.parkedSec, b.bucketParked],
        ["unknown", r.unknownSec, b.bucketUnknown],
      ].filter(([, v]) => (v as number) > 0) as [string, number, string][];
      const tip = parts.map(([, v, l]) => `${l} ${hours(v)}`).join(" · ");
      const bar =
        r.elapsedSec > 0
          ? `<span class="ts-sb" style="width:${Math.max(0.6, (r.elapsedSec / max) * 100).toFixed(1)}%">${parts
              .map(([k, v]) => `<i class="${k}" style="flex:${v}"></i>`)
              .join("")}</span>`
          : `<span class="ts-tick"></span>`;
      const live = r.endKind === "in-flight" ? `<span class="ts-live">${esc(x.live)}</span>` : "";
      const title = `${name} — ${tip || "0s"} · ${x.colSpan} ${hours(r.elapsedSec)}${unitTip}`;
      return `<li title="${esc(title)}"><span class="ts-n">${esc(name)}${live}</span><span class="ts-b">${bar}</span>${figure}<span class="ts-e">${esc(
        hours(r.elapsedSec),
      )}</span></li>`;
    })
    .join("");
  const rw = m.rework;
  const rework =
    rw.rejected > 0
      ? x.reworkSome(rw.rejected, hours(rw.reworkSec))
      : m.partialAudit
        ? x.reworkPartial(m.partialAudit.notRead)
        : rw.approved > 0
          ? x.reworkFirstTime(rw.approved)
          : x.reworkNoGate;
  return `<section class="ts-stages card"><header class="ts-head"><h2>${esc(x.stagesTitle)}</h2><p>${esc(
    (byUnits.size > 0 ? x.stagesNoteUnits : x.stagesNote)(top ? stageName(m, top.stage) : "", alt) +
      (top && m.partialAudit ? x.rankPartial(m.partialAudit.notRead) : ""),
  )}</p></header><ol class="ts-list"><li class="ts-lh"><span>${esc(x.colStage)}</span><span></span><span>${esc(
    x.colObserved,
  )}</span><span>${esc(x.colUnknown)}</span><span>${esc(x.colSpan)}</span></li>${body}</ol><p class="ts-note">${esc(rework)}</p></section>`;
}

export function renderTimeSummary(m: DashboardModel, s: Strings): string {
  return `<div class="ts-row">${timeCard(m, s)}${usageCard(m, s)}</div>${stagesCard(m, s)}`;
}
