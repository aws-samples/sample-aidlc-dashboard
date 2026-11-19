// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The timing panel's density and the two figures it gained (2026-11-16, I3–I5): split
// columns that are zero in every row are hidden and named, the reading notes fold, the
// unit view groups by stage and leads under unit-major, delegation sits inside observed,
// and each answered ask is listed with its wait.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import type { DashboardModel } from "../model/types";
import { esc, hours, mins, shortTs } from "../render/common";
import { strings } from "../render/i18n";
import { renderBody } from "../render/page";
import { renderTimeline } from "../render/timeline";
import type { AuditEvent } from "../scan/audit";
import { type UnitSpan, askAnswers, classifyGaps } from "../scan/timing";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);
const ko = strings("ko");
const en = strings("en");

/** The stage Gantt's header row. */
function stageHead(html: string): string {
  const at = html.indexOf('<th class="g-track-h">');
  return html.slice(at, html.indexOf("</thead>", at));
}

function unitSpan(
  stage: string,
  unit: string,
  startedAt: string,
  sec: number,
  extra = {},
): UnitSpan {
  const endedAt = new Date(Date.parse(startedAt) + sec * 1000).toISOString().replace(".000", "");
  const split = {
    humanWaitSec: 0,
    parkedSec: 0,
    inferredParkSec: 0,
    observedSec: sec,
    conversationSec: 0,
    unknownSec: 0,
    unknownToTurnSec: 0,
    delegatedSec: 0,
    parkAnomalies: 0,
    unknown: [],
    idleSec: 0,
    agentSec: 0,
    workSec: sec,
    suspect: [],
    ...extra,
  };
  return {
    stage,
    unit,
    startedAt,
    endedAt,
    endKind: "completed",
    elapsedSec: sec,
    segments: [{ startedAt, endedAt, endKind: "completed", elapsedSec: sec, ...split }],
    ...split,
  };
}

describe("timing panel — a split column zero in every row is hidden and named", () => {
  test("the fixture's stage table has no conversation column, and says so once", () => {
    expect(base.timing.stages.every((sp) => sp.conversationSec === 0)).toBe(true);
    for (const s of [ko, en]) {
      const html = renderTimeline(base, s);
      const head = stageHead(html);
      expect(head).not.toContain(esc(s.timeline.colConversation));
      expect(head).toContain(esc(s.timeline.colWait));
      expect(head).toContain(esc(s.timeline.colObserved));
      expect(html).toContain(esc(s.timeline.hiddenCols([s.timeline.colConversation])));
    }
  });

  test("one row with conversation time brings the column back, and the note goes", () => {
    const m: DashboardModel = {
      ...base,
      timing: {
        ...base.timing,
        stages: base.timing.stages.map((sp, i) => (i === 1 ? { ...sp, conversationSec: 120 } : sp)),
      },
    };
    const note = esc(ko.timeline.hiddenCols([ko.timeline.colConversation]));
    const count = (html: string) => html.split(note).length - 1;
    const html = renderTimeline(m, ko);
    expect(stageHead(html)).toContain(esc(ko.timeline.colConversation));
    // The worker table keeps its own note: its rows are still all zero there.
    expect(count(html)).toBe(count(renderTimeline(base, ko)) - 1);
  });

  test("total and observed are never hidden", () => {
    const zero = (sp: (typeof base.timing.stages)[number]) => ({
      ...sp,
      humanWaitSec: 0,
      parkedSec: 0,
      conversationSec: 0,
      unknownSec: 0,
      observedSec: 0,
    });
    const m: DashboardModel = {
      ...base,
      timing: { ...base.timing, stages: base.timing.stages.map(zero) },
    };
    const head = stageHead(renderTimeline(m, ko));
    expect(head).toContain(esc(ko.timeline.colTotalMin));
    expect(head).toContain(esc(ko.timeline.colObserved));
    expect(head).not.toContain(esc(ko.timeline.colWait));
    expect(head).not.toContain(esc(ko.timeline.colUnknown));
  });
});

describe("timing panel — reading notes fold, caveats on the run stay visible", () => {
  test("the legend and the observed definition sit in a 'how to read' fold", () => {
    const html = renderTimeline(base, ko);
    const fold = html.slice(html.indexOf('<details class="how-read">'));
    expect(
      fold.startsWith(`<details class="how-read"><summary>${esc(ko.timeline.howToRead)}</summary>`),
    ).toBe(true);
    const body = fold.slice(0, fold.indexOf("</details>"));
    expect(body).toContain(ko.timeline.ganttLegend);
    expect(body).toContain(ko.timeline.observedCaveat);
    // Its first sentence still reaches the reader without opening the fold.
    expect(html).toContain(`title="${esc(ko.timeline.colObservedTip)}"`);
  });

  test("the fold is keyed, so the poll keeps it as the reader left it", () => {
    const html = renderBody(base, "ko");
    expect(html).toMatch(/<details data-key="x-\d+" class="how-read">/);
  });
});

describe("timing panel — delegation inside observed", () => {
  test("a stage with delegated time shows it under observed, one without shows nothing", () => {
    const cg = base.timing.stages.find((sp) => sp.stage === "code-generation")!;
    expect(cg.delegatedSec).toBeGreaterThan(0);
    const html = renderTimeline(base, ko);
    const sub = `<span class="g-sub" title="${esc(ko.timeline.delegatedInTip)}">${esc(
      ko.timeline.delegatedIn(ko.timeline.minutes(mins(cg.delegatedSec))),
    )}</span>`;
    expect(html).toContain(sub);
    expect(html.split(`class="g-sub"`).length - 1).toBe(
      base.timing.stages.filter((sp) => sp.delegatedSec > 0).length +
        base.timing.workers.filter((w) => w.delegatedSec > 0).length,
    );
  });
});

describe("timing panel — the unit view groups by stage and leads under unit-major", () => {
  const units = [
    unitSpan("functional-design", "u1-catalog-and-search", "2026-01-01T00:00:00Z", 600, {
      humanWaitSec: 60,
    }),
    unitSpan("functional-design", "u2-checkout", "2026-01-01T00:10:00Z", 900),
    unitSpan("code-generation", "u1-catalog-and-search", "2026-01-01T00:30:00Z", 1200),
  ];
  const withUnits = (unitMajor: boolean): DashboardModel => ({
    ...base,
    unitMajorStages: unitMajor ? ["functional-design", "code-generation"] : [],
    timing: { ...base.timing, units },
  });

  test("one header row per stage, rows named by unit alone", () => {
    const html = renderTimeline(withUnits(true), ko);
    expect(html.match(/<tr class="g-group">/g)?.length).toBe(2);
    expect(html).toContain(
      `<th class="g-name g-unit" title="${esc("functional-design · u2-checkout")}">u2-checkout</th>`,
    );
    expect(html).not.toContain(`u2-checkout<span class="mute">`);
    const bar = base.timing.stages.find((sp) => sp.stage === "functional-design")!;
    expect(html).toContain(
      `<tr class="g-group"><th colspan="5">${ko.timeline.unitVsStage(
        "functional-design",
        esc(hours(1500)),
        esc(hours(bar.elapsedSec)),
      )}</th></tr>`,
    );
  });

  test("under unit-major the unit view comes before the stage table; otherwise after", () => {
    const summary = esc(ko.timeline.unitSummary(3, 2));
    const stageTh = `<th class="g-track-h">${esc(ko.timeline.colTrack)}`;
    const first = renderTimeline(withUnits(true), ko);
    expect(first.indexOf(summary)).toBeLessThan(first.indexOf(stageTh));
    expect(first).toContain(ko.timeline.ganttLegendUnits);
    const after = renderTimeline(withUnits(false), ko);
    expect(after.indexOf(summary)).toBeGreaterThan(after.indexOf(stageTh));
    expect(after).not.toContain(ko.timeline.ganttLegendUnits);
  });

  test("the unit view hides its own zero columns", () => {
    const html = renderTimeline(withUnits(true), ko);
    const view = html.slice(html.indexOf(esc(ko.timeline.unitSummary(3, 2))));
    const head = view.slice(view.indexOf("<thead>"), view.indexOf("</thead>"));
    expect(head).toContain(esc(ko.timeline.colWait));
    expect(head).not.toContain(esc(ko.timeline.colParked));
    expect(view).toContain(
      esc(
        ko.timeline.hiddenCols([
          ko.timeline.colParked,
          ko.timeline.colConversation,
          ko.timeline.colUnknown,
        ]),
      ),
    );
  });
});

describe("answer time per ask", () => {
  const ev = (
    ts: string,
    event: string,
    fields: Record<string, string> = {},
    shard = "s",
  ): AuditEvent => ({
    ts,
    event,
    fields,
    shard,
  });
  const ledger = [
    ev("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", { Stage: "rv" }),
    ev("2026-01-01T00:01:00Z", "ARTIFACT_UPDATED"),
    ev("2026-01-01T00:31:00Z", "GATE_APPROVED", { Stage: "rv" }),
    ev("2026-01-01T00:32:00Z", "QUESTION_ASKED", {
      "Question Id": "q1",
      "Question Type": "scope-confirm",
    }),
    ev("2026-01-01T00:32:30Z", "HUMAN_TURN"),
    ev("2026-01-01T00:40:00Z", "DECISION_RECORDED", { Stage: "fd", Unit: "u1" }),
    ev("2026-01-01T00:41:00Z", "STAGE_STARTED", { Stage: "x" }),
    ev("2026-01-01T01:00:00Z", "HUMAN_TURN"),
  ];

  test("lists each answered ask from the pairing the split counts, and nothing else", () => {
    const asks = askAnswers(ledger);
    expect(asks).toEqual([
      {
        kind: "gate",
        questionType: undefined,
        stage: "rv",
        unit: undefined,
        askedAt: "2026-01-01T00:00:00Z",
        answeredAt: "2026-01-01T00:31:00Z",
        waitSec: 1800,
        spanSec: 1860,
        answeredBy: "GATE_APPROVED",
      },
      {
        kind: "question",
        questionType: "scope-confirm",
        stage: undefined,
        unit: undefined,
        askedAt: "2026-01-01T00:32:00Z",
        answeredAt: "2026-01-01T00:32:30Z",
        waitSec: 0,
        spanSec: 30,
        answeredBy: "HUMAN_TURN",
      },
    ]);
    // The decision closed on a STAGE_STARTED before any answer: not listed.
    expect(asks.reduce((n, a) => n + a.waitSec, 0)).toBe(classifyGaps(ledger).humanWaitSec);
  });

  test("the fold lists the longest waits, with the whole span and the answering row", () => {
    const m: DashboardModel = { ...base, timing: { ...base.timing, asks: askAnswers(ledger) } };
    for (const s of [ko, en]) {
      const html = renderTimeline(m, s);
      expect(html).toContain(esc(s.timeline.asksSummary(2, 2)));
      expect(html).toContain(
        `<li><b title="${esc(s.timeline.askWaitTip)}">${esc(s.timeline.minutes(mins(1800)))}</b> ${esc(
          s.timeline.askGate,
        )} <span class="g-where">rv</span> <span class="mute">${esc(
          shortTs("2026-01-01T00:00:00Z"),
        )}</span> · ${esc(s.timeline.askSpan(s.timeline.minutes(mins(1860))))} <code>GATE_APPROVED</code></li>`,
      );
      expect(html).toContain(
        `<b title="${esc(s.timeline.askWaitTip)}">—</b> ${esc(s.timeline.askQuestion("scope-confirm"))}`,
      );
      // The fixture has two clones: the list can sum above the merged wait, and says so.
      expect(html).toContain(esc(s.timeline.asksParallelNote));
    }
  });

  test("no answered ask, no fold", () => {
    const m: DashboardModel = { ...base, timing: { ...base.timing, asks: [] } };
    expect(renderTimeline(m, ko)).not.toContain(esc(ko.timeline.asksSummary(0, 0)).slice(0, 8));
  });
});
