// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Panel (c) — where the wall-clock went.
//
// Every second belongs to one visible bucket: user wait, parked, observed
// execution, or unknown. Unknown is deliberately not painted as execution.

import type { DashboardModel } from "../model/types";
import type {
  AskAnswer,
  GapSplit,
  StageEndKind,
  StageSegment,
  StageSpan,
  TimingReport,
  UnitSegment,
  UnitSpan,
} from "../scan/timing";
import { esc, hours, mins, pill, section, shortTs } from "./common";
import type { Strings } from "./i18n";

/** Track offset+width as percentages of the whole run, for the gantt row. */
function trackGeometry(
  startedAt: string,
  elapsedSec: number,
  runStart: number,
  runSpan: number,
): { left: number; width: number; tick: boolean } {
  // A zero-length segment is a tick whatever the track, or a lone skip on a units'
  // window of zero width would paint a full-width bar.
  if (elapsedSec <= 0 && runSpan <= 0) return { left: 0, width: 0, tick: true };
  if (runSpan <= 0) return { left: 0, width: 100, tick: false };
  const left = ((Date.parse(startedAt) - runStart) / 1000 / runSpan) * 100;
  const width = (elapsedSec / runSpan) * 100;
  // A 0-second stage is normal (the three bootstrap stages stamp STARTED and
  // COMPLETED in the same second), but the 0.4% floor that keeps a bar visible is
  // worth 31 minutes on a 130h run — enough to make `workspace-scaffold` (0.0min) as
  // wide as `scope-definition` (29.9min), and to stack the three bootstrap bars into
  // one indistinguishable blob. So a zero-length stage gets a tick, not a bar.
  if (elapsedSec <= 0) return { left: Math.max(0, left), width: 0, tick: true };
  return { left: Math.max(0, left), width: Math.max(0.4, width), tick: false };
}

function kindClass(kind: StageEndKind): string {
  if (kind === "completed") return "done";
  if (kind === "skipped") return "skip";
  if (kind === "awaiting-approval") return "await";
  if (kind === "superseded") return "sup";
  if (kind === "paused") return "pause";
  return "live";
}

/** One segment's own split, so the tooltip describes the bar under the cursor. */
function segmentTip(
  stage: string,
  g: GapSplit & { startedAt: string; endedAt: string; endKind: StageEndKind },
  s: Strings,
): string {
  const t = s.timeline;
  return t.segmentTip(
    stage,
    t.endKinds[g.endKind],
    shortTs(g.startedAt),
    shortTs(g.endedAt),
    t.splitLine(
      mins(g.humanWaitSec),
      mins(g.parkedSec),
      mins(g.observedSec),
      mins(g.conversationSec),
      mins(g.unknownSec),
    ),
  );
}

/** The bars of one row — a stage's or a unit's segments on the run track. */
function trackBars(
  name: string,
  segments: readonly (StageSegment | UnitSegment)[],
  runStart: number,
  runSpan: number,
  s: Strings,
): string {
  return segments
    .map((segment) => {
      const g = trackGeometry(segment.startedAt, segment.elapsedSec, runStart, runSpan);
      // FILL THE BAR WITH THE SPLIT, not with the end kind. Bar width is calendar
      // occupancy, and on a real run the widest stage (30.6% of the track) was 93.8%
      // parked and ranked 16th of 22 in observed execution — so colouring by end kind
      // made a night of waiting look identical to a night of work. End kind moves to
      // the outline; the four buckets are the fill.
      const total =
        segment.humanWaitSec +
        segment.parkedSec +
        segment.observedSec +
        segment.conversationSec +
        segment.unknownSec;
      const fill =
        total > 0
          ? (
              [
                ["wait", segment.humanWaitSec],
                ["parked", segment.parkedSec],
                ["observed", segment.observedSec],
                ["conv", segment.conversationSec],
                ["unknown", segment.unknownSec],
              ] as const
            )
              .filter(([, sec]) => sec > 0)
              .map(
                ([kind, sec]) =>
                  `<i class="${kind}" style="width:${((sec / total) * 100).toFixed(2)}%"></i>`,
              )
              .join("")
          : "";
      if (g.tick) {
        return `<span class="g-tick k-${kindClass(segment.endKind)}" style="left:${g.left.toFixed(
          2,
        )}%" title="${esc(
          `${segmentTip(name, segment, s)}\n${
            "durationUnknown" in segment && segment.durationUnknown
              ? s.timeline.durationUnknownTip
              : "pauseOnly" in segment && segment.pauseOnly
                ? s.timeline.pauseOnlyTip
                : s.timeline.zeroSecondTip
          }`,
        )}"></span>`;
      }
      return `<span class="g-bar k-${kindClass(segment.endKind)}" style="left:${g.left.toFixed(
        2,
      )}%;width:${g.width.toFixed(2)}%" title="${esc(
        "startInferred" in segment && segment.startInferred
          ? `${segmentTip(name, segment, s)}\n${s.timeline.inferredStartTip(
              shortTs(segment.startedAt),
              segment.receiptStartedAt ? shortTs(segment.receiptStartedAt) : undefined,
            )}`
          : segmentTip(name, segment, s),
      )}">${fill}</span>`;
    })
    .join("");
}

/**
 * What ended the gaps behind an unclassified figure — a person's message or any other row.
 * Shown where the figure is explained (its tooltip), never as a column: neither part is
 * user wait (no ask is paired to it) or work, so neither earns a figure of its own.
 */
export function unknownSplitTip(
  g: Pick<GapSplit, "unknownSec" | "unknownToTurnSec">,
  s: Strings,
): string {
  return s.timeline.unknownSplit(
    hours(g.unknownToTurnSec),
    hours(g.unknownSec - g.unknownToTurnSec),
  );
}

/**
 * Which split columns a table shows. A column that is zero in every row is hidden and
 * named once under the table (`hiddenNote`): measured over 49 local runs, the parked
 * column was all zero in 31 stage tables and 26 of 30 unit views, the conversation column
 * in 36 and 28. Total and observed are never hidden — observed is the figure stages are
 * ranked by, and a hidden total would leave the row without its denominator.
 */
interface Cols {
  wait: boolean;
  parked: boolean;
  conv: boolean;
  unknown: boolean;
}

type SplitFigures = Pick<GapSplit, "humanWaitSec" | "parkedSec" | "conversationSec" | "unknownSec">;

function shownCols(rows: readonly SplitFigures[]): Cols {
  return {
    wait: rows.some((r) => r.humanWaitSec > 0),
    parked: rows.some((r) => r.parkedSec > 0),
    conv: rows.some((r) => r.conversationSec > 0),
    unknown: rows.some((r) => r.unknownSec > 0),
  };
}

function colCount(c: Cols): number {
  return [c.wait, c.parked, c.conv, c.unknown].filter(Boolean).length;
}

/** Header cells for the split columns, after the total. */
function splitHeads(c: Cols, x: Strings["timeline"]): string {
  return [
    c.wait ? `<th>${esc(x.colWait)}</th>` : "",
    c.parked ? `<th>${esc(x.colParked)}</th>` : "",
    `<th title="${esc(x.colObservedTip)}">${esc(x.colObserved)}</th>`,
    c.conv ? `<th title="${esc(x.colConversationTip)}">${esc(x.colConversation)}</th>` : "",
    c.unknown ? `<th>${esc(x.colUnknown)}</th>` : "",
  ].join("");
}

function hiddenNote(c: Cols, x: Strings["timeline"]): string {
  const hidden = [
    c.wait ? "" : x.colWait,
    c.parked ? "" : x.colParked,
    c.conv ? "" : x.colConversation,
    c.unknown ? "" : x.colUnknown,
  ].filter(Boolean);
  return hidden.length ? `<p class="note">${esc(x.hiddenCols(hidden))}</p>` : "";
}

/**
 * The observed figure, with its delegated part beneath it. Delegation is INSIDE observed
 * (`delegationGaps` files a matched window as observed), the way thinking is inside
 * output, so it is never a column of its own that could be added to the row.
 */
function observedCell(g: Pick<GapSplit, "observedSec" | "delegatedSec">, s: Strings): string {
  const x = s.timeline;
  return `<td class="g-n work"><b>${esc(mins(g.observedSec))}</b>${
    g.delegatedSec > 0
      ? `<span class="g-sub" title="${esc(x.delegatedInTip)}">${esc(
          x.delegatedIn(x.minutes(mins(g.delegatedSec))),
        )}</span>`
      : ""
  }</td>`;
}

/**
 * The numeric cells every Gantt row shares, after the track. There is no "work estimate"
 * (observed + unclassified) cell: it was a total beside its own parts, and unclassified
 * is time the ledger does not explain — summing it with observed read it as work.
 */
function splitCells(
  g: GapSplit & { elapsedSec: number },
  s: Strings,
  c: Cols,
  durationUnknown = false,
): string {
  return `<td class="g-n">${durationUnknown ? "—" : esc(mins(g.elapsedSec))}</td>
  ${c.wait ? `<td class="g-n wait">${esc(mins(g.humanWaitSec))}</td>` : ""}
  ${c.parked ? `<td class="g-n parked">${esc(mins(g.parkedSec))}</td>` : ""}
  ${observedCell(g, s)}
  ${c.conv ? `<td class="g-n conv">${esc(mins(g.conversationSec))}</td>` : ""}
  ${
    c.unknown
      ? `<td class="g-n unknown" title="${esc(unknownSplitTip(g, s))}">${esc(mins(g.unknownSec))}</td>`
      : ""
  }`;
}

/** A table's reading notes, folded: they explain the table rather than state the run. */
function howToRead(x: Strings["timeline"], ...notes: string[]): string {
  return `<details class="how-read"><summary>${esc(x.howToRead)}</summary>
${notes.map((n) => `<p class="note">${n}</p>`).join("\n")}
</details>`;
}

function ganttRow(sp: StageSpan, runStart: number, runSpan: number, s: Strings, c: Cols): string {
  const bars = trackBars(sp.stage, sp.segments, runStart, runSpan, s);
  // Abbreviated so the column stays one line; the full text is the cell tooltip.
  const t = s.timeline;
  const load = [
    sp.workload.artifacts ? t.loadArtifacts(sp.workload.artifacts) : "",
    // `sensor` is the engine's own noun and reads the same in both languages.
    sp.workload.sensors ? `sensor ${sp.workload.sensors}` : "",
    // Sensor failures were tallied and then dropped here; on a real run that hid 84.
    sp.workload.sensorFailures ? t.loadFailures(sp.workload.sensorFailures) : "",
    sp.workload.delegations ? t.loadDelegations(sp.workload.delegations) : "",
    sp.workload.humanTurns ? t.loadHumanTurns(sp.workload.humanTurns) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<tr>
  <th class="g-name">${esc(sp.stage)}</th>
  <td class="g-track"><div class="g-track-line">${bars}</div></td>
  ${splitCells(sp, s, c)}
  <td class="g-load" title="${esc(load)}">${esc(load)}</td>
</tr>`;
}

/**
 * The unit view — one row per (stage, unit) from the unit lifecycle rows, on the same
 * track as the stage Gantt. See `UnitSpan` for why it exists: under unit-major one
 * stage's bar covers every later stage the units walked, so the stage table cannot say
 * where each unit's time went. Each stage the units touched also gets one line setting
 * the units' summed time beside that stage's bar, because the two answer different
 * questions and the gap between them is the point.
 */
function unitBlock(t: TimingReport, s: Strings): string {
  if (t.units.length === 0) return "";
  const x = s.timeline;
  // The units' own window, not the run's: Construction is often a sliver at the end of
  // the run track, which drew every unit bar as a dot.
  const runStart = Math.min(...t.units.map((u) => Date.parse(u.startedAt)));
  const runSpan = (Math.max(...t.units.map((u) => Date.parse(u.endedAt))) - runStart) / 1000;
  const c = shownCols(t.units);
  // Grouped by stage, in the order the stages were first entered, so a row names its unit
  // alone: "unit · stage" ran past the name column in 169 of 261 local rows. The stage's
  // line — its units summed beside its own bar — heads its group.
  const byStage = new Map<string, UnitSpan[]>();
  for (const u of t.units) byStage.set(u.stage, [...(byStage.get(u.stage) ?? []), u]);
  // name, track, total and observed are always there; the split columns may not be.
  const width = 4 + colCount(c);
  const groups = [...byStage]
    .map(([stage, units]) => {
      const skippedOnly = units.every((u) => u.segments.every((g) => g.endKind === "skipped"));
      const bar = t.stages.find((sp) => sp.stage === stage);
      const head = skippedOnly
        ? x.unitStageSkipped(esc(stage))
        : x.unitVsStage(
            esc(stage),
            esc(hours(units.reduce((n, u) => n + u.elapsedSec, 0))),
            bar ? esc(hours(bar.elapsedSec)) : undefined,
          );
      const rows = units
        .map((u) => {
          const name = `${u.stage} · ${u.unit}`;
          const inferred = u.segments.some((g) => g.startInferred);
          return `<tr>
  <th class="g-name g-unit" title="${esc(name)}">${esc(u.unit)}${
    inferred ? `<span class="prov-mark" title="${esc(x.inferredRowTip)}">~</span>` : ""
  }</th>
  <td class="g-track"><div class="g-track-line">${trackBars(name, u.segments, runStart, runSpan, s)}</div></td>
  ${splitCells(
    u,
    s,
    c,
    u.segments.every((g) => g.durationUnknown),
  )}
</tr>`;
        })
        .join("\n");
      return `<tr class="g-group"><th colspan="${width}">${head}</th></tr>\n${rows}`;
    })
    .join("\n");
  return `<details open><summary>${esc(x.unitSummary(t.units.length, byStage.size))}</summary>
<div class="timeline-table-wrap"><table class="tbl gantt">
  <thead><tr><th>${esc(x.colUnitStage)}</th><th class="g-track-h">${esc(x.colUnitTrack)}${axis(
    runStart,
    runSpan,
    0,
    s,
  )}</th><th>${esc(x.colTotalMin)}</th>${splitHeads(c, x)}</tr></thead>
  <tbody>${groups}</tbody>
</table></div>
${hiddenNote(c, x)}
${howToRead(x, x.unitNote)}
</details>`;
}

/**
 * Answer time per ask (`TimingReport.asks`): the asks that waited longest, with the
 * whole ask-to-answer span beside the part counted as wait. Folded — the split above
 * already carries the total; this says which asks it came from.
 */
function askBlock(t: TimingReport, s: Strings): string {
  if (t.asks.length === 0) return "";
  const x = s.timeline;
  const kind = (a: AskAnswer): string =>
    a.kind === "gate"
      ? x.askGate
      : a.kind === "decision"
        ? x.askDecision
        : x.askQuestion(a.questionType);
  const top = [...t.asks]
    .sort((a, b) => b.waitSec - a.waitSec || b.spanSec - a.spanSec)
    .slice(0, 12);
  const items = top
    .map((a) => {
      const where = [a.stage, a.unit].filter(Boolean).join(" · ");
      return `<li><b title="${esc(x.askWaitTip)}">${
        a.waitSec > 0 ? esc(x.minutes(mins(a.waitSec))) : "—"
      }</b> ${esc(kind(a))}${where ? ` <span class="g-where">${esc(where)}</span>` : ""} <span class="mute">${esc(
        shortTs(a.askedAt),
      )}</span> · ${esc(x.askSpan(x.minutes(mins(a.spanSec))))} <code>${esc(a.answeredBy)}</code></li>`;
    })
    .join("");
  return `<details><summary>${esc(x.asksSummary(t.asks.length, top.length))}</summary><ul class="gaps">${items}</ul>
<p class="note">${esc(x.asksNote)}</p>${
    t.parallel ? `\n<p class="note">${esc(x.asksParallelNote)}</p>` : ""
  }</details>`;
}

function pct(value: number, total: number): string {
  return total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
}

/**
 * What the run waits on at a gate, in the order the status strip reads it. The state
 * row's `[?]` is the stage gate; an audit-opened decision (a unit or batch approval)
 * and a team unit gate never move that row, so "no gate open" there was contradicted by
 * the waits tab on the same page. Other asks are not gates and stay in that tab.
 */
function awaitingLine(m: DashboardModel, x: Strings["timeline"]): string {
  if (m.gates.awaitingStage) return x.awaiting(esc(m.gates.awaitingStage));
  const d = m.waits.decision;
  if (d) {
    const name = d.checkpoint ?? d.decision;
    // Same caveat the waits tab carries: scoped by the unit cache alone, the decision
    // may belong to a unit the engine is not on (model/waits.ts).
    return `${x.awaitingDecision(name ? esc(name) : undefined)}${
      d.scopeVerified === false ? x.awaitingDecisionUnscoped : ""
    }`;
  }
  const t = m.waits.teamGate;
  if (t?.status === "awaiting-approval") {
    return `${x.awaitingTeam(esc(t.unit), esc(t.stage))}${
      t.scopeVerified === false ? x.awaitingDecisionUnscoped : ""
    }`;
  }
  if (m.waits.teamGateUnread) return x.awaitingTeamUnread;
  const r = m.waits.gateReplied;
  if (r) return x.awaitingReplied(esc(r.stage), r.unit === undefined ? undefined : esc(r.unit));
  return x.awaitingNone;
}

/**
 * Rework — the ledger's most valuable signal and, until now, the one the panel was
 * silent about. `m.gates` counted the events and no render module read it, so a run
 * with 11 rejections and 18.9h of redone work looked identical to one with none.
 *
 * The rejection reason is shown verbatim: it is a human's own sentence about what was
 * wrong, which no aggregate can replace.
 */
function reworkBlock(m: DashboardModel, classifiedSec: number, s: Strings): string {
  const t = s.timeline;
  const r = m.rework;
  if (r.rejected === 0 && r.revisions === 0 && r.jumps === 0 && r.reopened === 0) {
    // "Every gate passed first time" is a claim about the whole run; with a shard
    // refused the rejection may be in it (DashboardModel.partialAudit).
    return `<p class="note">${esc(
      m.partialAudit ? t.reworkNonePartial(m.partialAudit.notRead) : t.reworkNone(r.approved),
    )}</p>`;
  }
  const share = classifiedSec > 0 ? pct(r.reworkSec, classifiedSec) : "0.0";
  const rows = r.stages
    .map((st) => {
      return `<tr>
  <th class="g-name">${esc(st.stage)}${
    st.unit ? `<span class="mute"> · ${esc(st.unit)}</span>` : ""
  }${
    st.settled ? "" : `<span class="prov-mark" title="${esc(t.reworkProvisionalTip)}">~</span>`
  }</th>
  <td class="g-n">${esc(String(st.submissions || "—"))}</td>
  <td class="g-n unknown"><b>${esc(String(st.rejections))}</b></td>
  <td class="g-n">${esc(String(st.revisions || "—"))}${
    st.revisionHigh ? `<span class="mute"> /${esc(String(st.revisionHigh))}</span>` : ""
  }</td>
  <td class="g-n"><b>${esc(hours(st.reworkSec))}</b></td>
  <td class="g-n">${st.feedback.length > 0 ? esc(t.feedbackCount(st.feedback.length)) : "—"}</td>
</tr>`;
    })
    .join("\n");

  // The reason goes UNDER the table, at full card width. It is a human's dense
  // paragraph — 1042 characters on one measured rejection, no line breaks — and a
  // table cell competing with five numeric columns is the wrong container for it
  // twice over: the cell clamped it visually AND the renderer sliced it at 400
  // characters, dropping 642 of those 1042 without a mark to say so. "Shown
  // verbatim" has to mean the whole thing, so nothing is sliced here.
  const reasons = r.stages
    .filter((st) => st.feedback.length > 0)
    .flatMap((st) =>
      st.feedback.map(
        (f) => `<li class="why-item">
  <div class="why-head"><b>${esc(st.stage)}${st.unit ? ` · ${esc(st.unit)}` : ""}</b><span class="mute">${esc(shortTs(f.at))}</span></div>
  <p class="why-text">${esc(f.text)}</p>
</li>`,
      ),
    )
    .join("");
  const reasonBlock = reasons
    ? `<details class="why-all"><summary>${esc(
        t.reasonsSummary(r.stages.reduce((n, st) => n + st.feedback.length, 0)),
      )}</summary>
  <p class="note">${t.reasonsNote}</p>
  <ul class="why-list">${reasons}</ul>
</details>`
    : "";

  return `<div class="time-stats">
  <div class="unknown"><span class="time-stat-n">${esc(hours(r.reworkSec))}</span><span class="time-stat-l">${esc(
    t.reworkStatShare(share),
  )}</span></div>
  <div><span class="time-stat-n">${r.rejected}</span><span class="time-stat-l">${esc(t.statRejected)}</span></div>
  <div><span class="time-stat-n">${r.approved}</span><span class="time-stat-l">${esc(t.statApproved)}</span></div>
  <div><span class="time-stat-n">${r.revisions}</span><span class="time-stat-l">${esc(t.statRevisions)}</span></div>
  ${r.jumps ? `<div><span class="time-stat-n">${r.jumps}</span><span class="time-stat-l">${esc(t.statJumps)}</span></div>` : ""}
  ${r.reopened ? `<div title="${esc(t.statReopenedTip)}"><span class="time-stat-n">${r.reopened}</span><span class="time-stat-l">${esc(t.statReopened)}</span></div>` : ""}
  ${r.freezeBlocked ? `<div><span class="time-stat-n">${r.freezeBlocked}</span><span class="time-stat-l">${esc(t.statFreezeBlocked)}</span></div>` : ""}
</div>
<div class="timeline-table-wrap"><table class="tbl">
  <thead><tr><th>${esc(t.colStage)}</th><th title="${esc(t.colSubmissionsTip)}">${esc(
    t.colSubmissions,
  )}</th><th>${esc(t.colRejections)}</th><th title="${esc(t.colRevisionsTip)}">${esc(
    t.colRevisions,
  )}</th><th title="${esc(t.colReworkTip)}">${esc(t.colRework)}</th><th title="${esc(
    t.colReasonTip,
  )}">${esc(t.colReason)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
${reasonBlock}
<p class="note">${t.reworkNote(share, esc(hours(classifiedSec)), r.provisional)}</p>`;
}

/**
 * The five buckets: one bar plus a legend that carries BOTH the hours and the share.
 *
 * The hours used to live in a tile strip above the bar — six equal tiles holding the
 * window total and its five parts, which made the whole look like a sixth part and
 * invited an addition that does not work (the five sum to the CLASSIFIED span, 52.1h,
 * not to the 57.2h window; the 4.7h of unrecorded time is in neither). The tiles also duplicated
 * this legend, which already listed all five, and the sixth tile wrapped onto a row of
 * its own. So the total is now a headline (it is the denominator, not a part) and the
 * hours moved down here, next to the share they belong to.
 */
export function breakdown(split: GapSplit, total: number, s: Strings): string {
  const t = s.timeline;
  const parts = [
    ["wait", t.bucketWait, split.humanWaitSec, t.bucketWaitTip],
    ["parked", t.bucketParked, split.parkedSec, t.bucketParkedTip],
    ["observed", t.bucketObserved, split.observedSec, t.bucketObservedTip],
    ["conv", t.bucketConversation, split.conversationSec, t.bucketConversationTip],
    [
      "unknown",
      t.bucketUnknown,
      split.unknownSec,
      split.unknownSec > 0
        ? `${t.bucketUnknownTip} · ${unknownSplitTip(split, s)}`
        : t.bucketUnknownTip,
    ],
  ] as const;
  return `<div class="time-breakdown" role="img" aria-label="${esc(
    parts.map(([, label, seconds]) => `${label} ${pct(seconds, total)}%`).join(", "),
  )}">
${parts
  .filter(([, , seconds]) => seconds > 0)
  .map(
    ([kind, label, seconds]) =>
      `<span class="${kind}" style="width:${pct(seconds, total)}%" title="${esc(
        `${label} ${hours(seconds)} (${pct(seconds, total)}%)`,
      )}"></span>`,
  )
  .join("")}
</div>
<div class="time-legend">
${parts
  .map(
    ([kind, label, seconds, tip]) =>
      `<span class="lgi" title="${esc(tip)}"><i class="${kind}"></i><b class="${kind}">${esc(
        hours(seconds),
      )}</b> ${esc(label)} <span class="mute">${esc(pct(seconds, total))}%</span></span>`,
  )
  .join("")}
</div>`;
}

/**
 * The per-worker table, shown only for a parallel run.
 *
 * WHY BOTH NUMBERS ARE KEPT. The merged and per-worker idle figures measure
 * different things, and NEITHER dominates the other — both directions were
 * measured:
 *
 *   - merged UNDER-reports when clones overlap: while A waits at a gate, B's
 *     events land inside that gap, so the gate→HUMAN_TURN pair is no longer
 *     adjacent and the wait reads as work. On a real 4-developer run this lost
 *     69% of the waiting (819 min merged vs 2,632 min per-worker).
 *   - merged OVER-reports at a handoff: A's SESSION_ENDED followed 45 min later
 *     by B's SESSION_STARTED is a real team-wide pause, but it belongs to neither
 *     shard's own timeline, so per-worker misses it entirely.
 *
 * So: merged idle = "nobody on the team was working"; per-worker idle = "how long
 * each person waited". Both are shown, labelled for what they are, and the delta
 * is described in whichever direction it actually falls.
 */
function workerTable(t: TimingReport, s: Strings): string {
  if (!t.parallel) return "";
  const x = s.timeline;
  const c = shownCols(t.workers);

  const rows = t.workers
    .map((w) => {
      const lead = w.gatesApproved > 0;
      return `<tr>
  <th class="g-name">${esc(w.label)}${
    lead ? ` <span class="tag-lead" title="${esc(x.leadTagTip)}">${esc(x.leadTag)}</span>` : ""
  }</th>
  <td class="g-n">${w.events}</td>
  <td class="g-n">${esc(mins(w.elapsedSec))}</td>
  ${c.wait ? `<td class="g-n wait">${esc(mins(w.humanWaitSec))}</td>` : ""}
  ${c.parked ? `<td class="g-n parked">${esc(mins(w.parkedSec))}</td>` : ""}
  ${observedCell(w, s)}
  ${c.conv ? `<td class="g-n conv">${esc(mins(w.conversationSec))}</td>` : ""}
  ${
    c.unknown
      ? `<td class="g-n unknown" title="${esc(unknownSplitTip(w, s))}">${esc(mins(w.unknownSec))}</td>`
      : ""
  }
  <td class="g-n">${w.gatesApproved || ""}</td>
  <td class="g-load" title="${esc(w.stages.join(", "))}">${esc(w.stages.slice(0, 2).join(", "))}</td>
  <td class="g-n" title="${esc(w.units.join(", ") || x.noUnitAttribution)}">${
    w.units.length || "—"
  }</td>
</tr>`;
    })
    .join("\n");

  const par = t.parallelism;
  const delta = t.personIdleSec - t.total.idleSec;
  // WHY THE TWO FIGURES DIFFER, stated from what was measured rather than assumed.
  // The old wording blamed interleaving ("someone else's events filled my wait")
  // unconditionally; on a run whose clones never overlap that is impossible, and the
  // real cause there is the handover gap. So the reason is chosen by overlap.
  const deltaNote =
    Math.abs(delta) <= 60
      ? esc(x.deltaSame)
      : t.overlapSec > 0
        ? delta > 0
          ? x.deltaOverlapUnder(esc(hours(delta)), esc(hours(t.overlapSec)))
          : x.deltaOverlapOver(esc(hours(-delta)))
        : delta > 0
          ? x.deltaHandoverUnder(esc(hours(delta)))
          : x.deltaHandoverOver(esc(hours(-delta)), esc(hours(t.handoverSec)));

  // "Parallel" is a claim about time, so it is made only when the windows actually
  // overlap. Measured on a real 3-shard run: 0 overlap, i.e. a sequential handover.
  const shapeLabel =
    t.overlapSec > 0
      ? x.workerShapeOverlap(t.clones, esc(hours(t.overlapSec)))
      : x.workerShapeSequential(
          t.clones,
          t.handoverSec > 60 ? esc(hours(t.handoverSec)) : undefined,
        );
  const hostNote =
    t.workers.length > t.clones
      ? `<p class="note">${x.hostNote(t.workers.length, t.clones)}</p>`
      : "";
  const parkedOut = t.workers.filter((w) => w.endedParked);

  return `<details open><summary>${esc(x.workerSummary(shapeLabel))}</summary>
<div class="worker-stats">
  <span><b>${esc(hours(t.personElapsedSec))}</b> ${esc(x.personTotal)}</span>
  <span><b>${esc(hours(t.personHumanWaitSec))}</b> ${esc(x.bucketWait)}</span>
  <span><b>${esc(hours(t.personParkedSec))}</b> ${esc(x.bucketParked)}</span>
  <span><b>${esc(hours(t.personObservedSec))}</b> ${esc(x.bucketObserved)}</span>
  <span><b>${esc(hours(t.personConversationSec))}</b> ${esc(x.bucketConversation)}</span>
  <span><b>${esc(hours(t.personUnknownSec))}</b> ${esc(x.bucketUnknown)}</span>
  ${par ? `<span><b>${esc(par.toFixed(2))}×</b> ${esc(x.personParallelism)}</span>` : ""}
</div>
<div class="timeline-table-wrap"><table class="tbl">
  <thead><tr><th>${esc(x.colClone)}</th><th>${esc(x.colEvents)}</th><th>${esc(
    x.colSpanMin,
  )}</th>${splitHeads(c, x)}<th>${esc(x.colGates)}</th><th>${esc(x.colMainStage)}</th><th>${esc(
    x.colUnits,
  )}</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
${hiddenNote(c, x)}
<p class="note">${x.workerNote(esc(hours(t.total.idleSec)), deltaNote)}</p>
${hostNote}
${
  parkedOut.length
    ? `<p class="note warn">${parkedOut
        .map((w) => x.endedParked(esc(w.label), esc(shortTs(w.lastTs))))
        .join(" · ")}${esc(x.endedParkedTail)}</p>`
    : ""
}
${par ? `<p class="note">${x.parallelismNote}</p>` : ""}
${t.workers.some((w) => w.units.length === 0) ? `<p class="note">${x.unitColumnNote}</p>` : ""}
</details>`;
}

/**
 * A time axis for the Gantt track, plus the read clock at the right edge.
 *
 * Without it the last bar always touches the right edge, which reads as "the run
 * finished here" on a run that is merely open — and the stretch after the last event
 * (which bars no longer cover, since the first redesign) had nothing to name it.
 */
function trackAxis(t: TimingReport, runStart: number, runSpan: number, s: Strings): string {
  if (!t.firstTs) return "";
  return axis(runStart, runSpan, t.sinceLastEventSec, s);
}

/**
 * Five ticks over `runSpan` seconds from `runStart`, plus the unrecorded tail as a band.
 * Dates where the track spans days; times of day where it spans less — five "10-06"
 * labels under a 19-hour track said nothing.
 */
function axis(runStart: number, runSpan: number, silenceSec: number, s: Strings): string {
  if (runSpan <= 0) return "";
  const ticks = 4;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const byTime = runSpan < 36 * 3600;
  const marks: string[] = [];
  let lastDay = "";
  for (let i = 0; i <= ticks; i++) {
    // UTC, the clock every tooltip on this panel prints (`shortTs` reads the ledger's own
    // `…Z` stamp) — a server-local axis under UTC tooltips put two times on one instant.
    const at = new Date(runStart + (runSpan * 1000 * i) / ticks);
    const day = `${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
    const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
    // A time-of-day axis names the date where it changes, so a midnight crossing does not
    // repeat one clock reading for two days.
    const label = !byTime ? day : day !== lastDay ? `${day} ${time}` : time;
    lastDay = day;
    marks.push(
      `<span class="ax-t" style="left:${((i / ticks) * 100).toFixed(2)}%">${esc(label)}</span>`,
    );
  }
  // The silence gets its own shaded band so it is visibly outside the bars.
  const silence =
    silenceSec > 0
      ? `<span class="ax-gap" style="left:${(((runSpan - silenceSec) / runSpan) * 100).toFixed(
          2,
        )}%;width:${((silenceSec / runSpan) * 100).toFixed(2)}%" title="${esc(
          s.timeline.axisSilenceTip(hours(silenceSec)),
        )}"></span>`
      : "";
  return `<div class="g-axis">${silence}${marks.join("")}</div>`;
}

function body(m: DashboardModel, s: Strings): string {
  const x = s.timeline;
  const t = m.timing;
  const partial = m.partialAudit;
  // Said once, first, rather than beside every figure: the window, the split, "no
  // overlap" in the worker table and the rework counts all stand on the events read.
  const partialNote = partial
    ? `<p class="note warn">${esc(x.partialAuditNote(partial.notRead))}</p>\n`
    : "";
  if (t.stages.length === 0 || !t.firstTs) {
    return `${partialNote}<p class="note">${esc(
      partial ? x.noStageSpansPartial(partial.notRead) : x.noStageSpans,
    )}</p>`;
  }

  const runStart = Date.parse(t.firstTs);
  const runSpan = t.elapsedSec;

  // WHAT IS THE RUN WAITING ON — said out loud rather than left to be inferred from
  // the rightmost bar. The gate claim is the one the status strip makes (the state
  // row's `[?]`, model/waits.ts), not this ledger's last STAGE_AWAITING_APPROVAL —
  // which stayed "awaiting" after the gate was answered. Silence there is what made a
  // reader guess from bar colour.
  const inFlight = t.stages.filter((s) => s.endKind === "in-flight");
  const awaiting = awaitingLine(m, x);
  // A finished run with nothing open has ended — "nothing in flight · no gate open" is the
  // wording of a run paused between stages (seen on a finished 2.11.4 run).
  const ended = inFlight.length === 0 && m.state.complete && awaiting === x.awaitingNone;
  const nowLine = `<p class="note">${
    ended
      ? esc(x.runEnded(shortTs(t.lastEventTs ?? t.lastTs)))
      : `${
          inFlight.length
            ? x.inFlight(
                inFlight
                  .map((sp) => `<b>${esc(sp.stage)}</b> ${esc(hours(sp.elapsedSec))}`)
                  .join(" · "),
              )
            : esc(partial ? x.noneInFlightPartial(partial.notRead) : x.noneInFlight)
        } · ${awaiting}`
  }${m.rework.provisional ? esc(x.reworkPending) : ""}</p>`;

  // On a multi-clone run the merged split is not a per-person figure.
  const mergedNote = t.parallel
    ? `<p class="note warn">${x.mergedNote(t.workers.length, t.clones)}</p>`
    : "";

  // The window total is the DENOMINATOR of everything below it, not a sixth bucket, so
  // it stands alone. `classified span` is stated beside it because that — not the window — is
  // what the percentages divide by. The gap between the two is the unrecorded stretch, and
  // that is named ONCE, in the date-range note below: the pill lives next to the last
  // event, which is what it is about. Saying it here as well put the same fact twice
  // within five lines. The number still has to be stated somewhere — an open run's
  // window grows on every poll while the ledger does not — but once is enough.
  const classified = runSpan - t.sinceLastEventSec;
  const kpis = `${partialNote}<div class="time-head">
  <span class="time-head-n" title="${esc(
    t.sinceLastEventSec > 0 ? x.windowTipOpen(hours(t.sinceLastEventSec)) : x.windowTipClosed,
  )}">${esc(hours(runSpan))}</span>
  <span class="time-head-l">${esc(t.parallel ? x.windowTeam : x.windowSolo)}</span>
  <span class="time-head-sub">${x.windowSub(esc(hours(classified)))}</span>
</div>
${
  // The percentages are OF THE CLASSIFIED SPAN, not of the window: nothing past the
  // last event is classified, so dividing by the window would make the five shares
  // shrink every poll on a quiet tree and never reach 100%.
  breakdown(t.total, classified, s)
}
<p class="note">${esc(shortTs(t.firstTs))} ~ ${esc(shortTs(t.lastEventTs ?? t.lastTs))}${
    // The window of an open run ends at the read clock, so it keeps growing while
    // nothing happens — name that stretch instead of folding it into the span.
    t.sinceLastEventSec > 0
      ? ` · ${pill(x.unrecordedPill(hours(t.sinceLastEventSec)), "warn")}`
      : ""
  }${t.parallel ? ` · ${pill(x.clonesPill(t.clones), "warn")}` : ""}${esc(
    x.delegated(hours(t.total.delegatedSec)),
  )}</p>
${nowLine}
${mergedNote}
<details${m.rework.rejected > 0 ? " open" : ""}><summary>${esc(
    x.reworkSummary(m.rework.rejected, hours(m.rework.reworkSec)),
  )}</summary>
${reworkBlock(m, runSpan - t.sinceLastEventSec, s)}
</details>
${workerTable(t, s)}`;

  const c = shownCols(t.stages);
  const rows = t.stages.map((sp) => ganttRow(sp, runStart, runSpan, s, c)).join("\n");

  // The long unclassified gaps, surfaced rather than folded silently into WORK.
  // WHICH STAGE WAS THIS GAP IN. The span itself carries only its two event names, so
  // "18 minutes between two artifact writes" was unactionable — the reader could not
  // tell which part of the run to go look at. The stage whose segment contains the
  // timestamp is derivable from data already on the page, so derive it.
  const stageAt = (ts: string): string | undefined =>
    t.stages.find((s) => s.segments.some((g) => ts >= g.startedAt && ts <= g.endedAt))?.stage;
  const unknown = [...t.total.unknown]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 12)
    .map((g) => {
      const stage = stageAt(g.at);
      return `<li><b>${esc(x.minutes(mins(g.seconds)))}</b> ${
        stage ? `<span class="g-where">${esc(stage)}</span>` : ""
      } <code>${esc(g.fromEvent)} → ${esc(g.toEvent)}</code> <span class="mute">${esc(
        shortTs(g.at),
      )}</span></li>`;
    })
    .join("");

  // Under unit-major the stage bars of per-unit stages are not those stages' work (see
  // `ganttLegendUnits`), so the unit view comes first there; elsewhere it follows.
  const unitsFirst = m.unitMajorStages.length > 0 && t.units.length > 0;
  const stageTable = `<div class="timeline-table-wrap"><table class="tbl gantt">
  <thead><tr><th>${esc(x.colStage)}</th><th class="g-track-h">${esc(x.colTrack)}${trackAxis(
    t,
    runStart,
    runSpan,
    s,
  )}</th><th>${esc(x.colTotalMin)}</th>${splitHeads(c, x)}<th>${esc(x.colWorkload)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
${hiddenNote(c, x)}
${unitsFirst ? `<p class="note">${x.ganttLegendUnits}</p>\n` : ""}${howToRead(x, x.ganttLegend, x.observedCaveat)}`;

  return `${kpis}
${unitsFirst ? `${unitBlock(t, s)}\n${stageTable}` : `${stageTable}\n${unitBlock(t, s)}`}
${askBlock(t, s)}
${
  unknown
    ? `<details><summary>${esc(
        x.unknownGapsSummary(t.total.unknown.length),
      )}</summary><ul class="gaps">${unknown}</ul>
<p class="note">${esc(x.unknownGapsNote)}</p></details>`
    : ""
}
${
  t.total.inferredParkSec > 0 || t.total.parkAnomalies > 0
    ? `<p class="note warn">${esc(
        x.inferredPark(hours(t.total.inferredParkSec), t.total.parkAnomalies),
      )}</p>`
    : ""
}`;
}

export function renderTimeline(m: DashboardModel, s: Strings): string {
  return section(s.timeline.section, body(m, s), "timeline");
}
