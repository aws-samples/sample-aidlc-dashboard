// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The time and usage summaries under the journey (render/time-summary.ts). Each test
// names the rule it pins: the split's denominator, the unrecorded tail said apart, hours
// never days, length ≠ colour, the audit hedge, credit never clamped and never silently
// stale, and no ratio for Claude Code tokens.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import type { DashboardModel } from "../model/types";
import { esc, hours } from "../render/common";
import { strings } from "../render/i18n";
import { renderTimeSummary } from "../render/time-summary";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);
const ko = strings("ko");
const en = strings("en");

describe("time — the split", () => {
  test("divides the classified span, and says the unrecorded tail apart", () => {
    const t = base.timing;
    const classified = t.elapsedSec - t.sinceLastEventSec;
    const html = renderTimeSummary(base, ko);
    expect(html).toContain(esc(ko.tsum.classified(hours(classified))));
    expect(html).toContain('class="time-breakdown"');
    expect(t.sinceLastEventSec).toBeGreaterThan(0);
    expect(html).toContain(esc(ko.tsum.tail(hours(t.sinceLastEventSec))));
  });

  test("a finished run has no unrecorded tail to name", () => {
    const html = renderTimeSummary({ ...base, state: { ...base.state, complete: true } }, ko);
    expect(html).not.toContain("기록이 없어 나누지 않았어요");
  });

  test("with an audit path refused, the whole-run claims say 'in what was read'", () => {
    const html = renderTimeSummary({ ...base, partialAudit: { notRead: 2 } }, ko);
    expect(html).toContain("감사 기록 경로 2곳은 읽지 않았어요");
  });

  test("a multi-clone run says the split is the team's clock, not one person's", () => {
    // The fixture is itself a two-clone run, so it carries the note; one clone does not.
    expect(base.timing.parallel).toBe(true);
    const note = ko.timeline.mergedNote(base.timing.workers.length, base.timing.clones);
    expect(renderTimeSummary(base, ko)).toContain(note);
    const solo: DashboardModel = { ...base, timing: { ...base.timing, parallel: false } };
    expect(renderTimeSummary(solo, ko)).not.toContain("팀 단위");
  });

  test("an empty split hedges 'nothing' when an audit path was refused", () => {
    const empty: DashboardModel = {
      ...base,
      timing: { ...base.timing, elapsedSec: 0, sinceLastEventSec: 0 },
    };
    expect(renderTimeSummary(empty, ko)).toContain(esc(ko.tsum.empty));
    expect(renderTimeSummary({ ...empty, partialAudit: { notRead: 1 } }, ko)).toContain(
      esc(ko.tsum.emptyPartial(1)),
    );
  });

  test("never prints a day", () => {
    const html = renderTimeSummary(base, en).replace(/<[^>]+>/g, " ");
    expect(html).not.toMatch(/\b\d+(\.\d+)?d\b/);
  });
});

describe("time — by stage", () => {
  test("a row per stage span; length is calendar time, observed and unclassified stand apart", () => {
    const html = renderTimeSummary(base, ko);
    const rows = html.slice(html.indexOf('class="ts-list"'));
    expect(rows.match(/<span class="ts-n">/g)?.length).toBe(base.timing.stages.length);
    const longest = Math.max(...base.timing.stages.map((r) => r.elapsedSec));
    const cg = base.timing.stages.find((r) => r.stage === "code-generation")!;
    expect(cg.elapsedSec).toBe(longest);
    expect(rows).toContain('<span class="ts-sb" style="width:100.0%">');
    // Unclassified time is time the ledger does not explain — never folded into "work".
    expect(rows).toContain(`<span class="ts-w">${hours(cg.observedSec)}</span>`);
    expect(rows).toMatch(new RegExp(`<span class="ts-u"[^>]*>${hours(cg.unknownSec)}</span>`));
    expect(rows).not.toContain(
      `<span class="ts-w">${hours(cg.observedSec + cg.unknownSec)}</span>`,
    );
  });

  // D3 moved doctor-ended gaps into unclassified, so ranking by observed + unclassified
  // let a stage full of silence outrank one full of recorded work.
  test("stages are ranked by observed time, and a different answer with unclassified is said", () => {
    const at = (stage: string, observedSec: number, unknownSec: number) => ({
      ...base.timing.stages[0]!,
      stage,
      elapsedSec: observedSec + unknownSec,
      observedSec,
      unknownSec,
      unknownToTurnSec: 0,
      humanWaitSec: 0,
      parkedSec: 0,
      conversationSec: 0,
      endKind: "completed" as const,
    });
    const m = {
      ...base,
      timing: {
        ...base.timing,
        stages: [at("reverse-engineering", 600, 0), at("requirements-analysis", 300, 3000)],
      },
    };
    const html = renderTimeSummary(m, ko);
    expect(html).toContain(esc(ko.tsum.stagesNote("reverse-engineering", "requirements-analysis")));
    const agree = {
      ...m,
      timing: {
        ...m.timing,
        stages: [at("reverse-engineering", 600, 0), at("requirements-analysis", 300, 0)],
      },
    };
    expect(renderTimeSummary(agree, ko)).toContain(
      esc(ko.tsum.stagesNote("reverse-engineering", undefined)),
    );
    expect(renderTimeSummary(m, en)).toContain(
      esc(en.tsum.stagesNote("reverse-engineering", "requirements-analysis")),
    );
  });

  // Found in review, reproduced: the ranking ignored a refused audit path, and a run with no
  // observed time named its first stage "the most observed".
  test("the ranking hedges a refused ledger, and names no stage when nothing was observed", () => {
    const hedged = renderTimeSummary({ ...base, partialAudit: { notRead: 2 } }, ko);
    expect(hedged).toContain(esc(ko.tsum.rankPartial(2)));
    expect(renderTimeSummary(base, ko)).not.toContain(esc(ko.tsum.rankPartial(2)));
    const quiet = {
      ...base,
      timing: {
        ...base.timing,
        stages: base.timing.stages.map((r) => ({ ...r, observedSec: 0, unknownSec: 0 })),
      },
    };
    const quietHtml = renderTimeSummary(quiet, ko);
    expect(quietHtml).toContain(`<p>${esc(ko.tsum.stagesNote("", undefined))}</p>`);
  });

  test("the unclassified figure says how much of it a person's message ended", () => {
    const html = renderTimeSummary(base, ko);
    const cg = base.timing.stages.find((r) => r.stage === "code-generation")!;
    const tip = ko.timeline.unknownSplit(
      hours(cg.unknownToTurnSec),
      hours(cg.unknownSec - cg.unknownToTurnSec),
    );
    expect(html).toContain(`title="${esc(tip)}"`);
  });

  test("a 0-second stage is a tick, never a bar", () => {
    const html = renderTimeSummary(base, ko);
    expect(base.timing.stages.some((r) => r.elapsedSec === 0)).toBe(true);
    expect(html).toContain('<span class="ts-tick"></span>');
  });

  test("rework says what happened, and hedges 'none' on a refused ledger", () => {
    expect(renderTimeSummary(base, ko)).toContain(esc(ko.tsum.reworkSome(1, hours(0))));
    const clean = { ...base, rework: { ...base.rework, rejected: 0 } };
    expect(renderTimeSummary(clean, ko)).toContain(esc(ko.tsum.reworkFirstTime(2)));
    expect(renderTimeSummary({ ...clean, partialAudit: { notRead: 1 } }, ko)).toContain(
      esc(ko.tsum.reworkPartial(1)),
    );
    expect(renderTimeSummary({ ...clean, rework: { ...clean.rework, approved: 0 } }, ko)).toContain(
      esc(ko.tsum.reworkNoGate),
    );
  });
});

describe("usage", () => {
  if (base.usage.kind !== "kiro")
    throw new Error("fixture usage is expected to be the Kiro branch");
  const credit = base.usage.credit;
  const withCredit = (c: Partial<typeof credit>): DashboardModel => ({
    ...base,
    usage: { kind: "kiro", credit: { ...credit, ...c } },
  });
  const current = {
    planName: "KIRO POWER",
    usedAmount: 8089.5,
    remainingAmount: 1910.5,
    planLimit: 10000,
    usageRatio: 0.80895,
    resetDate: "2026-12-01",
    partial: false,
  };

  test("no reading is a dash, not zero", () => {
    expect(renderTimeSummary(base, ko)).toContain('<p class="ts-big missing">—</p>');
  });

  test("the source's own ratio, with what it is of and when it resets", () => {
    const html = renderTimeSummary(
      withCredit({
        status: "ok",
        current,
        lastSuccessAt: base.generatedAt,
        freshness: { stale: false, lastSuccessAt: base.generatedAt },
      }),
      ko,
    );
    expect(html).toContain("80.9<span>%</span>");
    expect(html).toContain("12-01 초기화");
    expect(html).not.toContain("기준 값이에요");
  });

  test("an overage is shown as one — never clamped", () => {
    const html = renderTimeSummary(
      withCredit({
        status: "ok",
        current: { ...current, usageRatio: 3.77 },
        freshness: { stale: false, lastSuccessAt: null },
      }),
      ko,
    );
    expect(html).toContain("377.0<span>%</span>");
    expect(html).toContain('class="ts-meter over"');
    expect(html).toContain(esc(ko.tsum.over));
  });

  test("a value from a collection that has since failed carries its date beside it", () => {
    const html = renderTimeSummary(
      withCredit({
        status: "failure",
        current,
        lastSuccessAt: "2026-10-17T13:02:57.358Z",
        freshness: { stale: true, lastSuccessAt: "2026-10-17T13:02:57.358Z" },
      }),
      ko,
    );
    expect(html).toContain('class="ts-usage card stale"');
    expect(html).toContain(esc(ko.tsum.staleFailed("10-17")));
  });

  test("Claude Code tokens get no gauge and no percentage", () => {
    const tokens = {
      status: "ok",
      grandTotal: 1_234_567,
      trend: { window: "7d" as const, points: [], summary: { count: 0 } },
    } as unknown as Extract<DashboardModel["usage"], { kind: "claude" }>["tokens"];
    const html = renderTimeSummary({ ...base, usage: { kind: "claude", tokens } }, ko);
    expect(html).not.toContain("ts-meter");
    expect(html).not.toContain("<span>%</span>");
    expect(html).toContain(esc(ko.tsum.tokensNoLimit));
  });
});

test("English renders with no Hangul outside tree text", () => {
  let html = renderTimeSummary(base, en);
  for (const p of base.state.phases)
    for (const st of p.stages) html = html.split(esc(st.display)).join("");
  expect(html.match(/[가-힣]+/g) ?? []).toEqual([]);
});

// Unit-major keeps Current Stage on the first per-unit stage while units walk the later
// ones, so that stage's span holds every unit's work and the later stages' spans are
// seconds wide (AGENTS.md "Under unit-major a stage bar cannot say where a unit's time
// went"). Measured on a finished 2.11.4 run: the card named Functional Design (51.4 min)
// while Code Generation's unit segments summed to 32 min against a 0.3 min stage span.
describe("time — by stage, under unit-major", () => {
  const span = (stage: string, observedSec: number) => ({
    ...base.timing.stages[0]!,
    stage,
    elapsedSec: observedSec,
    observedSec,
    unknownSec: 0,
    unknownToTurnSec: 0,
    humanWaitSec: 0,
    parkedSec: 0,
    conversationSec: 0,
    endKind: "completed" as const,
  });
  const unit = (stage: string, name: string, observedSec: number) => ({
    stage,
    unit: name,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T01:00:00Z",
    endKind: "completed" as const,
    elapsedSec: observedSec,
    segments: [],
    humanWaitSec: 0,
    parkedSec: 0,
    inferredParkSec: 0,
    observedSec,
    conversationSec: 0,
    unknownSec: 0,
    unknownToTurnSec: 0,
    delegatedSec: 0,
    parkAnomalies: 0,
    unknown: [],
    suspect: [],
    idleSec: 0,
    agentSec: 0,
    workSec: observedSec,
  });
  const PER_UNIT = ["functional-design", "code-generation"];
  const withUnits = (unitMajor: boolean): DashboardModel => ({
    ...base,
    unitMajorStages: unitMajor ? PER_UNIT : [],
    timing: {
      ...base.timing,
      stages: [
        span("reverse-engineering", 900),
        span("functional-design", 3000),
        span("code-generation", 20),
      ],
      units: [
        unit("functional-design", "u1", 400),
        unit("functional-design", "u2", 260),
        unit("code-generation", "u1", 1160),
        unit("code-generation", "u2", 780),
      ],
    },
  });

  test("per-unit stages are compared by their units' segments, and the card says so", () => {
    const html = renderTimeSummary(withUnits(true), ko);
    expect(html).toContain(esc(ko.tsum.stagesNoteUnits("Code Generation", undefined)));
    const rows = html.slice(html.indexOf('class="ts-list"'));
    // Code Generation: Σ units 1160 + 780; Functional Design: 400 + 260 — not its 3000s span.
    expect(rows).toContain(`<span class="ts-w ts-units">${esc(hours(1940))}</span>`);
    expect(rows).toContain(`<span class="ts-w ts-units">${esc(hours(660))}</span>`);
    // A stage without units keeps its own span's figure.
    expect(rows).toContain(`<span class="ts-w">${esc(hours(900))}</span>`);
    expect(renderTimeSummary(withUnits(true), en)).toContain(
      esc(en.tsum.stagesNoteUnits("Code Generation", undefined)),
    );
  });

  // Found in review of the first cut, each reproduced: a per-unit stage with no unit row
  // entered the ranking through its pooled span; a stage the units reached before its
  // own STAGE_STARTED had no row at all; an unknown-length segment counted as zero.
  test("a per-unit stage with no unit segment has no comparable figure", () => {
    const m = withUnits(true);
    const only = {
      ...m,
      timing: { ...m.timing, units: m.timing.units.filter((u) => u.stage === "code-generation") },
    };
    const html = renderTimeSummary(only, ko);
    // Functional Design's 3000s span holds the later units' work: it must not win.
    expect(html).toContain(esc(ko.tsum.stagesNoteUnits("Code Generation", undefined)));
    expect(html).toContain('<span class="ts-w ts-none">—</span>');
  });

  test("a stage the units reached before its own start still gets a row", () => {
    const m = withUnits(true);
    const early = {
      ...m,
      timing: { ...m.timing, stages: m.timing.stages.filter((r) => r.stage !== "code-generation") },
    };
    const html = renderTimeSummary(early, ko);
    const rows = html.slice(html.indexOf('class="ts-list"'));
    expect(rows).toMatch(
      new RegExp(
        `<span class="ts-w ts-units">${esc(hours(1940))}</span><span class="ts-u ts-units"[^>]*>[^<]*</span><span class="ts-e">—</span>`,
      ),
    );
    expect(html).toContain(esc(ko.tsum.stagesNoteUnits("Code Generation", undefined)));
  });

  test("an unknown-length unit segment makes the sum a floor", () => {
    const m = withUnits(true);
    const units = m.timing.units.map((u, i) =>
      i === 2
        ? {
            ...u,
            segments: [{ ...u, elapsedSec: 0, durationUnknown: true }],
          }
        : u,
    );
    const html = renderTimeSummary({ ...m, timing: { ...m.timing, units } }, ko);
    expect(html).toContain(`<span class="ts-w ts-units">${esc(hours(1940))}+</span>`);
  });

  test("under unit-major the units' unclassified time is summed apart, not into Σ", () => {
    const m = withUnits(true);
    const units = m.timing.units.map((u) =>
      u.stage === "functional-design"
        ? { ...u, unknownSec: 5000, workSec: u.observedSec + 5000 }
        : u,
    );
    const html = renderTimeSummary({ ...m, timing: { ...m.timing, units } }, ko);
    const rows = html.slice(html.indexOf('class="ts-list"'));
    expect(rows).toContain(`<span class="ts-w ts-units">${esc(hours(660))}</span>`);
    expect(rows).toMatch(
      new RegExp(`<span class="ts-u ts-units"[^>]*>${esc(hours(10000))}</span>`),
    );
    // Ranked by observed: Code Generation; with unclassified, Functional Design.
    expect(html).toContain(esc(ko.tsum.stagesNoteUnits("Code Generation", "Functional Design")));
  });

  test("outside unit-major the same spans read exactly as before", () => {
    const html = renderTimeSummary(withUnits(false), ko);
    expect(html).toContain(esc(ko.tsum.stagesNote("Functional Design", undefined)));
    expect(html).not.toContain("ts-units");
  });
});
