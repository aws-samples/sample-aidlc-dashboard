// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The 2×2 cards (render/cards.ts) and the tab/row kit they share (render/card-kit.ts).
// Each test states the reading it protects; the fixture supplies real values, and the
// variants override exactly one field.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import type { DashboardModel, SourceKind } from "../model/types";
import { DRILL, MAX_TABS, TAB_CSS, tabbedCard } from "../render/card-kit";
import { renderDiagnostics, renderSources, renderUnresolved } from "../render/cards";
import { esc, hours, shortTs } from "../render/common";
import { strings } from "../render/i18n";
import { renderPage } from "../render/page";
import { renderTimeline } from "../render/timeline";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);
const ko = strings("ko");
const en = strings("en");
const checkedTab = (html: string, id: string) =>
  new RegExp(`id="mc-${id}-(\\d+)" value="\\d+" checked`).exec(html)?.[1];

describe("card kit", () => {
  test("one radio per tab, exactly one checked, labels wired to them", () => {
    const html = tabbedCard({
      id: "t",
      title: "T",
      tabs: [
        { label: "a", body: "A" },
        { label: "b", body: "B" },
      ],
      selected: 1,
    });
    expect(html.match(/<input class="mc-r"/g)?.length).toBe(2);
    expect(html.match(/ checked>/g)?.length).toBe(1);
    expect(checkedTab(html, "t")).toBe("1");
    expect(html).toContain('<label for="mc-t-0">a</label>');
  });

  test("an out-of-range selection is clamped, never left with nothing checked", () => {
    const html = tabbedCard({
      id: "t",
      title: "T",
      tabs: [{ label: "a", body: "A" }],
      selected: 9,
    });
    expect(checkedTab(html, "t")).toBe("0");
  });

  test("the CSS covers every tab position the kit allows", () => {
    for (let n = 1; n <= MAX_TABS; n++) {
      expect(TAB_CSS).toContain(
        `.mc-r:nth-of-type(${n}):checked ~ .mc-panels > .mc-p:nth-child(${n})`,
      );
    }
  });

  test("the page ships the tab CSS and restores picked tabs across the poll", () => {
    const html = renderPage(base, 60000, "ko");
    expect(html).toContain(".mc-r:nth-of-type(1):checked");
    expect(html).toContain("pickedTabs");
    // A drill-down link must open its closed <details>, not just scroll to it.
    expect(html).toContain("a[data-drill]");
    // The usage window toggle reloads onto ?cw=, and must land with that panel open.
    expect(html).toContain(`/[?&]cw=/.test(location.search)) openDrill("${DRILL.usage}")`);
  });
});

/** `<b>N</b>Title` — the count leads its column; a zero (or floor of zero) is muted. */
const countOf = (n: string, title: string) =>
  new RegExp(`<b(?: class="zero")?>${n.replace("+", "\\+")}</b>${title}`);

describe("Unresolved — three ledgers side by side", () => {
  test("each ledger has its own count and none is summed with another", () => {
    const html = renderUnresolved(base, ko);
    expect(html).toMatch(countOf(String(base.deferrals.items.length), ko.cards.decisionsTab));
    const open = base.diaries.records.filter(
      (r) => r.axis === "openQuestions" && r.questionStatus !== "resolved",
    ).length;
    expect(html).toMatch(countOf(String(open), ko.cards.openQsTab));
    expect(html).toMatch(
      countOf(String(base.deferrals.declared.questions.length), ko.cards.declaredTab),
    );
    expect(html.match(/<div class="un-col">/g)?.length).toBe(3);
  });

  test("each item links to the file it came from and names its owner", () => {
    const html = renderUnresolved(base, ko);
    const it = base.deferrals.items[0]!;
    expect(html).toContain(`/view?rel=${encodeURIComponent(it.rel)}`);
    expect(html).toContain(`→ ${it.ownerStage}`);
  });

  test("a ledger read only in part says so without sending the reader to a panel that is gone", () => {
    // The full deferrals box is unmounted (SHOW_DEFERRALS), so this panel carries the
    // partial read on its own: a floor count and a sentence that points nowhere.
    const m: DashboardModel = {
      ...base,
      deferrals: { ...base.deferrals, items: [], unreadSections: ["inception/x/y.md"] },
    };
    for (const s of [ko, en]) {
      const html = renderUnresolved(m, s);
      expect(html).toContain(`<b class="zero">0+</b>${esc(s.cards.decisionsTab)}`);
      expect(html).toContain(esc(s.cards.notAllRead));
      expect(s.cards.notAllRead).not.toMatch(/패널|panel/i);
    }
  });

  test("the decisions column says what its rows are — records, not open asks", () => {
    for (const s of [ko, en]) {
      const html = renderUnresolved(base, s);
      const decisions = html.slice(
        0,
        html.indexOf('<div class="un-col">', html.indexOf('<div class="un-col">') + 1),
      );
      expect(decisions).toContain(esc(s.cards.decisionsNote));
      expect(s.deferrals.faces.current.tip).not.toMatch(/이번 차례|this turn/);
      expect(s.deferrals.faces.ahead.tip).not.toMatch(/다시 물어옵니다|will be asked/);
    }
  });

  test("a run whose only open points are stage-declared does not read 0 and 0", () => {
    const m: DashboardModel = {
      ...base,
      deferrals: { ...base.deferrals, items: [] },
      diaries: { ...base.diaries, records: [] },
    };
    const html = renderUnresolved(m, ko);
    const q = base.deferrals.declared.questions[0]!;
    expect(html).toMatch(
      countOf(String(base.deferrals.declared.questions.length), ko.cards.declaredTab),
    );
    expect(html).toContain(`/view?rel=${encodeURIComponent(q.rel)}`);
  });
});

describe("diagnostics — Run Health and sources, folded", () => {
  test("holds the whole Run Health card and the sources line", () => {
    const html = renderDiagnostics(base, ko);
    expect(html).toContain('id="card-health"');
    expect(html).toContain('<div class="sources">');
    expect(html).toContain('data-key="diag"');
  });

  test("the summary carries each signal's own count — and never a combined all-clear", () => {
    const html = renderDiagnostics(base, ko);
    const summary = html.slice(0, html.indexOf("</summary>"));
    // The fixture: one recorded check failure, a nudge (count 1, not stuck), a stale graph.
    expect(summary).toContain(`<span class="diag-chip bad">${esc(ko.cards.checksTab)} 1</span>`);
    expect(summary).toContain(`<span class="diag-chip ok">${esc(ko.cards.stuckTab)} 0</span>`);
    expect(summary).toContain(esc(ko.cards.diagStale(ko.cards.sourceNames["runtime-graph"])));
    expect(summary).not.toMatch(/문제 없음|all clear|nothing flagged/i);
  });

  test("opens on its own when something is flagged, stays folded when nothing is", () => {
    expect(renderDiagnostics(base, ko)).toMatch(
      /<details class="diag card" id="diag" data-key="diag" open>/,
    );
    const calm: DashboardModel = {
      ...base,
      sensors: { ...base.sensors, stages: [], failures: [] },
      provenance: Object.fromEntries(
        Object.entries(base.provenance).map(([k, p]) => [k, { ...p, stale: false }]),
      ) as DashboardModel["provenance"],
      waits: { ...base.waits, hooks: { state: "live" } },
    };
    expect(renderDiagnostics(calm, ko)).toMatch(
      /<details class="diag card" id="diag" data-key="diag">/,
    );
    // A stale source is named in the summary but does not open the fold on its own:
    // runtime-graph lags mid-stage by design, so it would hold the fold open every time.
    const staleOnly: DashboardModel = { ...calm, provenance: base.provenance };
    const html = renderDiagnostics(staleOnly, ko);
    expect(html).toMatch(/<details class="diag card" id="diag" data-key="diag">/);
    expect(html).toContain(esc(ko.cards.diagStale(ko.cards.sourceNames["runtime-graph"])));
  });

  test("every source is named with its age, and a stale one is outlined with its reason", () => {
    const html = renderSources(base, ko);
    const kinds = Object.keys(base.provenance) as SourceKind[];
    expect(kinds.length).toBe(7);
    for (const k of kinds) expect(html).toContain(`${esc(ko.cards.sourceNames[k])} · `);
    expect(base.provenance["runtime-graph"].stale).toBe(true);
    expect(html).toMatch(
      /<span class="src stale" title="[^"]+">runtime-graph · [^<]+ · 낡음<\/span>/,
    );
  });

  test("English renders both with no Hangul outside text quoted from the run", () => {
    let html = renderUnresolved(base, en) + renderDiagnostics(base, en);
    for (const t of treeText(base)) html = html.split(esc(t)).join("");
    expect(html.match(/[가-힣]+/g) ?? []).toEqual([]);
  });
});

/** Text the cards quote verbatim from the run (item text, question headings). */
function treeText(m: DashboardModel): string[] {
  return [
    ...m.deferrals.items.map((i) => i.item),
    ...m.deferrals.declared.questions.map((q) => q.text),
    ...m.diaries.records.map((r) => r.text),
    ...m.blockers.map((b) => b.heading),
  ];
}

describe("timeline — unit view", () => {
  const ko = strings("ko");
  const unit = (stage: string, unitName: string, startedAt: string, sec: number) => {
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
    };
    return {
      stage,
      unit: unitName,
      startedAt,
      endedAt,
      endKind: "completed" as const,
      elapsedSec: sec,
      segments: [{ startedAt, endedAt, endKind: "completed" as const, elapsedSec: sec, ...split }],
      ...split,
    };
  };

  // A finished run's line said "no stage in flight · no stage gate open", the wording of
  // a run that is paused between stages. Seen on a finished 2.11.4 run.
  test("a finished run says it ended, not that nothing is in flight", () => {
    const done: DashboardModel = {
      ...base,
      state: { ...base.state, complete: true },
      gates: { ...base.gates, awaitingStage: undefined },
      waits: { ...base.waits, decision: undefined, teamGate: undefined, teamGateUnread: false },
      timing: {
        ...base.timing,
        stages: base.timing.stages.map((sp) =>
          sp.endKind === "in-flight" ? { ...sp, endKind: "completed" as const } : sp,
        ),
      },
    };
    const end = base.timing.lastEventTs ?? base.timing.lastTs ?? "";
    for (const s of [ko, strings("en")]) {
      const html = renderTimeline(done, s);
      expect(html).not.toContain(s.timeline.noneInFlight);
      expect(html).not.toContain(s.timeline.awaitingNone);
      expect(html).toContain(esc(s.timeline.runEnded(shortTs(end))));
    }
  });

  // A "work estimate" column (observed + unclassified) stood beside its own parts and read
  // as work; unclassified is time the ledger does not explain. The parts stay, the sum goes,
  // and the unclassified cell says what ended its gaps.
  test("the stage table has no work-estimate total, and unclassified says what ended it", () => {
    for (const s of [ko, en]) {
      const html = renderTimeline(base, s);
      const gantt = html.slice(html.indexOf('class="tbl gantt"'));
      const head = gantt.slice(gantt.indexOf("<thead>"), gantt.indexOf("</thead>"));
      expect(head).toContain(esc(s.timeline.colObserved));
      expect(head).toContain(esc(s.timeline.colUnknown));
      expect(head).not.toContain("작업 추정");
      expect(head.toLowerCase()).not.toContain("work estimate");
      const cg = base.timing.stages.find((t) => t.stage === "code-generation")!;
      expect(html).toContain(
        `title="${esc(s.timeline.unknownSplit(hours(cg.unknownToTurnSec), hours(cg.unknownSec - cg.unknownToTurnSec)))}"`,
      );
    }
  });

  test("the worker table's unclassified cell says what ended its gaps", () => {
    expect(base.timing.parallel).toBe(true);
    const html = renderTimeline(base, ko);
    for (const w of base.timing.workers) {
      expect(html).toContain(
        `<td class="g-n unknown" title="${esc(
          ko.timeline.unknownSplit(
            hours(w.unknownToTurnSec),
            hours(w.unknownSec - w.unknownToTurnSec),
          ),
        )}">`,
      );
    }
  });

  test("no unit rows, no unit block", () => {
    expect(base.timing.units).toEqual([]);
    expect(renderTimeline(base, ko)).not.toContain(ko.timeline.unitNote);
  });

  // The point of the block: a unit-major stage bar is calendar occupancy, so each stage
  // the units touched sets their summed time beside that bar.
  test("each unit gets a row, and each stage sets its units' time beside its bar", () => {
    const sp = base.timing.stages.find((t) => t.stage === "code-generation")!;
    const m: DashboardModel = {
      ...base,
      timing: {
        ...base.timing,
        units: [
          unit("code-generation", "PU-A", sp.startedAt, 600),
          unit("code-generation", "PU-B", sp.startedAt, 1200),
        ],
      },
    };
    const html = renderTimeline(m, ko);
    expect(html).toContain(ko.timeline.unitSummary(2, 1));
    expect(html).toContain("PU-A");
    expect(html).toContain("PU-B");
    expect(html).toContain(ko.timeline.unitVsStage("code-generation", "30m", hours(sp.elapsedSec)));
  });

  test("a stage whose units were all skipped says so instead of 0 hours", () => {
    const skipped = { ...unit("infrastructure-design", "PU-A", base.timing.firstTs!, 0) };
    skipped.endKind = "skipped" as never;
    skipped.segments = skipped.segments.map((g) => ({ ...g, endKind: "skipped" as never }));
    const html = renderTimeline({ ...base, timing: { ...base.timing, units: [skipped] } }, ko);
    expect(html).toContain(ko.timeline.unitStageSkipped("infrastructure-design"));
  });

  // A lone skip gives the units' window zero width; it must stay a tick.
  test("a zero-length unit segment is a tick, never a full-width bar", () => {
    const skipped = { ...unit("infrastructure-design", "PU-A", base.timing.firstTs!, 0) };
    const html = renderTimeline({ ...base, timing: { ...base.timing, units: [skipped] } }, ko);
    const block = html.slice(html.indexOf(ko.timeline.unitSummary(1, 1)));
    expect(block).toContain('class="g-tick');
    expect(block).not.toContain("width:100.00%");
  });

  // Every tooltip prints the ledger's UTC stamp; the axis must read the same clock.
  test("the units' axis reads UTC, with the date where it changes", () => {
    const a = unit("code-generation", "PU-A", "2026-01-01T22:00:00Z", 3600);
    const b = unit("code-generation", "PU-B", "2026-01-02T01:00:00Z", 3600);
    const html = renderTimeline({ ...base, timing: { ...base.timing, units: [a, b] } }, ko);
    const block = html.slice(html.indexOf(ko.timeline.unitSummary(2, 1)));
    expect(block).toContain(">01-01 22:00<");
    expect(block).toContain(">01-02 00:00<");
  });
});
