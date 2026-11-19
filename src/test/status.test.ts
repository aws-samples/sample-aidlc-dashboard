// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The status readings (model/status.ts) and their two renderings: the run line at the
// top of the body and the Run Health card (render/status.ts). The fixture gives one
// real reading of every signal; the variants are built by overriding one field of that
// model, so each test changes exactly the thing it names.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { buildStatus, humanHolds, humanTally } from "../model/status";
import type { DashboardModel } from "../model/types";
import { esc } from "../render/common";
import { strings } from "../render/i18n";
import { renderBody } from "../render/page";
import { renderBanner, renderRunHealth, renderRunLine, waitCountText } from "../render/status";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);

const withGuard = (stopGuard: DashboardModel["health"]["stopGuard"]): DashboardModel => ({
  ...base,
  health: { ...base.health, stopGuard },
});

const withGate = (stage: string, m: DashboardModel = base): DashboardModel => ({
  ...m,
  waits: { ...m.waits, gate: { stage } },
});

const withSensorRow = (
  row: Partial<DashboardModel["sensors"]["stages"][number]>,
): DashboardModel => ({
  ...base,
  sensors: {
    ...base.sensors,
    stages: base.sensors.stages.map((s) =>
      s.stage === base.state.currentStage ? { ...s, ...row } : s,
    ),
  },
});

describe("status — readings", () => {
  test("the fixture: running, blocked once, one answer waiting, one check failure", () => {
    const st = buildStatus(base);
    expect(st.run).toEqual({
      state: "running",
      stageDisplay: "Code Generation",
      verified: true,
      lastEventAgeSec: base.provenance.audit.ageSec,
    });
    // count 1 is the first block after progress — a nudge, not "stuck".
    expect(st.stuck).toEqual({ state: "nudged", stage: "code-generation", cap: 2 });
    expect(st.human?.current).toBe(1);
    expect(st.human?.earlier).toBe(0);
    expect(st.human?.oldestWaitingSec).toBe(base.blockers[0]?.waitingSec);
    expect(st.checks).toEqual({ state: "failed", failed: 1, passed: 0 });
  });

  test("a completed run shows the run chip alone — past blocks and failures are history", () => {
    const st = buildStatus({ ...base, blockers: [], state: { ...base.state, complete: true } });
    expect(st).toEqual({ run: { state: "complete" } });
  });

  test("a completed run keeps unanswered asks reachable, as parked loose ends", () => {
    const st = buildStatus({ ...base, state: { ...base.state, complete: true } });
    expect(st).toEqual({ run: { state: "complete" }, human: { current: 0, earlier: 1 } });
  });

  test("no block-count.json is 'no record', never 'not stuck'", () => {
    expect(buildStatus(withGuard(undefined)).stuck).toEqual({ state: "no-record" });
  });

  test("count 0 is clear", () => {
    expect(buildStatus(withGuard({ signature: "code-generation::40", count: 0 })).stuck).toEqual({
      state: "clear",
    });
  });

  test("a 2.10 three-part signature still names the current stage", () => {
    // 2.10 writes `<stage>::<state sha256>::<directive fingerprint>`. Cutting at the
    // LAST `::` read the stage as `<stage>::<sha>`, so a current block drew as a
    // green "cleared in an earlier stage".
    const signature = `${base.state.currentStage}::${"a".repeat(64)}::${"b".repeat(64)}`;
    expect(buildStatus(withGuard({ signature, count: 3 })).stuck).toEqual({
      state: "released",
      count: 3,
      stage: base.state.currentStage,
      cap: 2,
    });
  });

  test("a block recorded against a state that has since changed is history", () => {
    const m = withGuard({
      signature: `code-generation::${"c".repeat(64)}::${"f".repeat(64)}`,
      count: 2,
    });
    const st = buildStatus({ ...m, waits: { ...m.waits, guardRecordStale: true } });
    expect(st.stuck).toEqual({ state: "state-changed", stage: "code-generation" });
  });

  test("a block recorded in a stage the run has left is not a current block", () => {
    const st = buildStatus(withGuard({ signature: "functional-design::12", count: 5 }));
    expect(st.stuck).toEqual({ state: "earlier-stage", stage: "functional-design" });
  });

  test("no sensor row for the current stage is 'none', not 'passed'", () => {
    const m: DashboardModel = {
      ...base,
      sensors: {
        ...base.sensors,
        stages: base.sensors.stages.filter((s) => s.stage !== base.state.currentStage),
      },
    };
    expect(buildStatus(m).checks).toEqual({ state: "none" });
  });

  test("a pending firing reads as in flight before its outcome", () => {
    expect(buildStatus(withSensorRow({ fired: 2, pending: 1 })).checks?.state).toBe("in-flight");
  });

  test("all firings passed", () => {
    const st = buildStatus(withSensorRow({ fired: 2, passed: 2, failed: 0, pending: 0 }));
    expect(st.checks).toEqual({ state: "passed", passed: 2 });
  });

  // A blocking gate refuses a budget override like a failure.
  test("a budget override alone never reads as passed", () => {
    const st = buildStatus(
      withSensorRow({
        fired: 1,
        passed: 0,
        failed: 0,
        superseded: 0,
        budgetOverride: 1,
        unevaluated: 0,
        unverifiedStanding: 1,
        pending: 0,
      }),
    );
    expect(st.checks).toEqual({ state: "unverified", unverified: 1, passed: 0 });
  });

  test("a failure a later verified pass retired is not a standing failure", () => {
    const st = buildStatus(
      withSensorRow({ fired: 2, passed: 1, failed: 1, superseded: 1, pending: 0 }),
    );
    expect(st.checks).toEqual({ state: "passed", passed: 1 });
  });

  test("a check without a verified result is not a pass", () => {
    const st = buildStatus(
      withSensorRow({
        fired: 2,
        passed: 1,
        failed: 0,
        superseded: 0,
        unevaluated: 1,
        unverifiedStanding: 1,
        pending: 0,
      }),
    );
    expect(st.checks).toEqual({ state: "unverified", unverified: 1, passed: 1 });
  });

  test("an open gate with no unanswered question is still something awaiting the human", () => {
    const m = withGate("code-generation", { ...base, blockers: [] });
    const h = buildStatus(m).human;
    expect(h).toEqual({
      current: 0,
      oldestWaitingSec: undefined,
      awaitingGate: "code-generation",
      earlier: 0,
      waits: m.waits,
    });
  });
});

describe("banner — markup", () => {
  const ko = strings("ko");
  const clear: DashboardModel = { ...base, blockers: [] };

  test("leads the body, with the run line inside it", () => {
    const body = renderBody(base, "ko").trimStart();
    expect(body.startsWith('<section class="banner')).toBe(true);
    const banner = body.slice(0, body.indexOf("</section>"));
    expect(banner).toContain('<div class="runline"');
  });

  test("a waiting ask is the headline: what, where, how long, and its file", () => {
    const html = renderBanner(base, ko);
    const b = base.blockers[0]!;
    expect(html).toContain("banner wait");
    expect(html).toContain("답변을 기다리고 있어요");
    expect(html).toContain(esc(b.heading));
    expect(html).toContain(`/view?rel=${encodeURIComponent(b.rel)}`);
    expect(html).toContain(`data-count="1"`);
  });

  test("its count is the answers tab's count — a gate on the ask's stage is not a second", () => {
    const m = withGate("code-generation");
    expect(waitCountText(m)).toBe("1");
    expect(renderRunHealth(m, ko)).toContain('<b class="mc-n warn">1</b>');
    expect(renderBanner(m, ko)).not.toContain("그 밖에");
  });

  test("several holds name the first and count the rest", () => {
    const m: DashboardModel = {
      ...base,
      waits: {
        ...base.waits,
        decision: { stage: "code-generation", checkpoint: "Learnings", since: base.generatedAt },
      },
    };
    expect(waitCountText(m)).toBe("2");
    expect(renderBanner(m, ko)).toContain("그 밖에 1건 더");
  });

  test("a gate with no ask leads on its own", () => {
    const html = renderBanner(withGate("code-generation", clear), ko);
    expect(html).toContain("banner wait");
    expect(html).toContain("승인 대기 code-generation");
  });

  test("nothing waiting says so, and does not call a quiet run stalled", () => {
    const html = renderBanner(clear, ko);
    expect(html).toContain("banner clear");
    expect(html).toContain("지금 기다리는 답변은 없어요");
    expect(html).toContain('data-count=""');
    // The age is the run line's, stated rather than judged.
    expect(html).toContain("마지막 기록");
  });

  test("an unread questions file is never 'nothing waiting'", () => {
    const m: DashboardModel = {
      ...clear,
      questions: { ...base.questions, unreadable: ["construction/x/code-generation-questions.md"] },
    };
    expect(waitCountText(m)).toBe("0?");
    const html = renderBanner(m, ko);
    expect(html).toContain("banner wait");
    expect(html).not.toContain("지금 기다리는 답변은 없어요");
  });

  test("a finished run is done, with its loose ends counted but not waiting", () => {
    const m: DashboardModel = { ...base, state: { ...base.state, complete: true } };
    expect(waitCountText(m)).toBe("");
    const html = renderBanner(m, ko);
    expect(html).toContain("banner done");
    expect(html).toContain(`답하지 않은 질문 ${base.blockers.length}개`);
  });

  test("English renders with no Hangul", () => {
    for (const m of [base, clear, { ...base, state: { ...base.state, complete: true } }]) {
      expect(/[가-힣]/.test(renderBanner(m, strings("en")))).toBe(false);
    }
  });

  test("the hero names the ask: kind, title, place, age, file, and a pasteable path", () => {
    const html = renderBanner(base, ko);
    const b = base.blockers[0]!;
    expect(html).toContain('<span class="ask-kind">');
    expect(html).toContain(`<h3 class="ask-t">${esc(b.heading)}</h3>`);
    expect(html).toContain(esc([b.unit, b.stage].filter(Boolean).join(" · ")));
    expect(html).toContain(`href="/view?rel=${encodeURIComponent(b.rel)}"`);
    // Workspace-relative, the form a reader pastes into the chat.
    const dir = base.identity.stateRel.split("/").slice(0, -1).join("/");
    expect(html).toContain(`data-copy="${esc(`${dir}/${b.rel}`)}"`);
    expect(html).toContain("째 기다리는 중");
  });

  test("the other holds fold under the card, keyed so the poll keeps them open", () => {
    const m: DashboardModel = {
      ...base,
      waits: {
        ...base.waits,
        decision: {
          stage: "code-generation",
          checkpoint: "Learnings",
          decision: "Anything to add?",
          since: base.generatedAt,
        },
      },
    };
    const html = renderBanner(m, ko);
    expect(html).toContain('<details class="ask-rest" data-key="hero-rest">');
    expect(html).toContain("그 밖에 1건 더 기다리고 있어요");
    expect(html).toContain("Anything to add?");
  });

  test("a hold with no file of its own says where to answer instead of offering a button", () => {
    const m: DashboardModel = {
      ...clear,
      waits: {
        ...base.waits,
        decision: {
          stage: "code-generation",
          decision: "Use this command?",
          since: base.generatedAt,
        },
      },
    };
    const html = renderBanner(m, ko);
    expect(html).toContain("Use this command?");
    expect(html).toContain("대화창에서 답하세요");
    expect(html).not.toContain("data-copy");
  });
});

describe("holds — the list the count is made of", () => {
  const variants: [string, DashboardModel][] = [
    ["the fixture", base],
    ["a gate on the ask's own stage", withGate("code-generation")],
    ["a gate with no ask", withGate("code-generation", { ...base, blockers: [] })],
    [
      "a stage gate and a team unit gate with no ask — one approval",
      {
        ...withGate("code-generation", { ...base, blockers: [] }),
        waits: {
          ...withGate("code-generation").waits,
          teamGate: {
            stage: "code-generation",
            unit: "u1",
            status: "awaiting-approval",
            scopeVerified: true,
          },
        },
      },
    ],
    [
      "a park, a paused unit, a decision and an engine ask on top of the ask",
      {
        ...base,
        waits: {
          ...base.waits,
          parked: { stage: "code-generation", since: base.generatedAt, byPerson: true },
          unitPaused: { unit: "u1", reason: "r", nextAction: "n" },
          decision: { stage: "code-generation", since: base.generatedAt },
          engineAsk: { askType: "plan-approval", stage: "code-generation" },
        },
      },
    ],
    ["nothing", { ...base, blockers: [] }],
    ["a finished run", { ...base, state: { ...base.state, complete: true } }],
  ];
  for (const [name, m] of variants) {
    test(`${name}: the list is as long as the count`, () => {
      const st = buildStatus(m);
      const open = st.run.state === "complete" ? 0 : humanTally(st.human).open;
      expect(humanHolds(m).length).toBe(open);
    });
  }
});

describe("hero age", () => {
  test("days and hours, hours and minutes, or minutes — never zero minutes", () => {
    const ko = strings("ko").status;
    const en = strings("en").status;
    expect(ko.heroAge(26 * 86400 + 21 * 3600 + 5)).toBe("26일 21시간");
    expect(ko.heroAge(3 * 86400)).toBe("3일");
    expect(ko.heroAge(2 * 3600 + 7 * 60)).toBe("2시간 7분");
    expect(ko.heroAge(20)).toBe("1분");
    expect(en.heroAge(26 * 86400 + 21 * 3600)).toBe("26d 21h");
    expect(en.heroAge(45 * 60)).toBe("45m");
  });
});

describe("run line — markup", () => {
  test("names the phase, the stage and the age of the last audit event", () => {
    const html = renderRunLine(base, strings("ko"));
    expect(html).toContain("▶ 진행 중");
    expect(html).toContain("Code Generation");
    expect(html).toContain("마지막 기록");
  });

  test("a completed run says so, with no running dot", () => {
    const html = renderRunLine(
      { ...base, state: { ...base.state, complete: true } },
      strings("ko"),
    );
    expect(html).toContain("rl-dot ok");
    expect(html).not.toContain("rl-dot run");
  });
});

describe("Run Health card — markup", () => {
  const ko = strings("ko");
  const tabsOf = (html: string) => html.match(/<label for="mc-health-\d+">/g)?.length ?? 0;
  const checked = (html: string) => /id="mc-health-(\d+)" value="\d+" checked/.exec(html)?.[1];

  test("four tabs while running — answers, stuck, failed checks, errors — and no combined verdict", () => {
    const html = renderRunHealth(base, ko);
    expect(tabsOf(html)).toBe(4);
    expect(html).toContain(`>${ko.cards.healthTitle}</h2>`);
    expect(html).toContain("내 답변");
    expect(html).toContain("막힘");
    expect(html).toContain("검사 실패");
    expect(html).toContain(">오류 <");
  });

  test("a check without a verified result says so in warning tone, never as passed", () => {
    const m = withSensorRow({
      fired: 1,
      passed: 0,
      failed: 0,
      superseded: 0,
      unevaluated: 1,
      unverifiedStanding: 1,
      pending: 0,
    });
    const html = renderRunHealth({ ...m, sensors: { ...m.sensors, failures: [] } }, ko);
    expect(html).toContain(ko.status.checksUnverified(1));
    expect(html).toContain('<b class="mc-n warn">?</b>');
    expect(html).not.toContain("검사 통과");
  });

  test("tab counts carry the signal: coloured when actionable", () => {
    const html = renderRunHealth(base, ko);
    // One ask waiting, one block, one failure — all three actionable.
    expect(html).toContain('<b class="mc-n warn">1</b>');
    expect(html).toContain('<b class="mc-n bad">1</b>');
  });

  test("opens on the first tab that has a problem", () => {
    expect(checked(renderRunHealth(base, ko))).toBe("0");
    // No asks → the next problem is the block (count 2 reaches the interactive cap).
    const blocked = withGuard({ signature: "code-generation::40", count: 2 });
    expect(checked(renderRunHealth({ ...blocked, blockers: [] }, ko))).toBe("1");
    // A single nudge is not a problem.
    expect(checked(renderRunHealth({ ...base, blockers: [] }, ko))).toBe("2");
    // No asks, no block → the failed check.
    const noBlock = withGuard({ signature: "code-generation::40", count: 0 });
    expect(checked(renderRunHealth({ ...noBlock, blockers: [] }, ko))).toBe("2");
  });

  test("a missing source is a muted dash and a dashed row, never green", () => {
    const html = renderRunHealth(withGuard(undefined), ko);
    expect(html).toContain('<b class="mc-n mute">–</b>');
    expect(html).toMatch(/class="mr t-\w+ dashed"/);
    expect(html).toContain("차단 기록 없음");
    expect(html).not.toContain("✓ 막힘 없음");
  });

  test("each ask links to its file", () => {
    const html = renderRunHealth(base, ko);
    const b = base.blockers[0]!;
    expect(html).toContain(`href="/view?rel=${encodeURIComponent(b.rel)}"`);
    expect(html).toContain(b.heading);
  });

  test("an unrecognised-heading ask and an invalid confirmation each say what they are", () => {
    const b = base.blockers[0]!;
    const html = renderRunHealth(
      {
        ...base,
        blockers: [
          { ...b, kind: "loose", heading: "" },
          {
            ...b,
            kind: "confirmation",
            heading: "Consolidated Summary Confirmation",
            invalidTags: 2,
          },
        ],
      },
      ko,
    );
    expect(html).toContain(ko.blockers.untitled);
    expect(html).toContain(ko.blockers.loose);
    expect(html).toContain(ko.blockers.invalidTags(2));
    // The invalid one says why it is invalid, not just that it is a gate.
    expect(html).toContain(ko.blockers.invalidTagsTip);
  });

  test("an open gate with no question still counts as something awaiting you", () => {
    const html = renderRunHealth(withGate("code-generation", { ...base, blockers: [] }), ko);
    expect(html).toContain("승인 대기 code-generation");
    expect(html).toContain('<b class="mc-n warn">1</b>');
  });

  test("an open gate on the stage whose ask is waiting counts once, not twice", () => {
    const m = withGate(base.state.currentStage);
    expect(base.blockers.filter((b) => b.isCurrentStage).length).toBe(1);
    const html = renderRunHealth(m, ko);
    expect(html).toContain('<b class="mc-n warn">1</b>');
    expect(html).not.toContain('<b class="mc-n warn">2</b>');
  });

  test("every ask is listed — none folded behind a '+N more' with nowhere to go", () => {
    const b = base.blockers[0]!;
    const blockers = Array.from({ length: 8 }, (_, i) => ({ ...b, rel: `${b.rel}-${i}` }));
    const html = renderRunHealth({ ...base, blockers }, ko);
    for (const x of blockers) expect(html).toContain(`/view?rel=${encodeURIComponent(x.rel)}`);
    expect(html).not.toContain(ko.cards.moreRows(2));
  });

  test("a completed run renders every ask as parked, even one in the last named stage", () => {
    expect(base.blockers[0]!.isCurrentStage).toBe(true);
    const html = renderRunHealth({ ...base, state: { ...base.state, complete: true } }, ko);
    expect(html).toContain(ko.blockers.staleStage);
    expect(html).not.toContain("t-warn");
  });

  test("a completed run collapses to one summary tab and keeps parked asks reachable", () => {
    const html = renderRunHealth({ ...base, state: { ...base.state, complete: true } }, ko);
    expect(tabsOf(html)).toBe(1);
    expect(html).toContain("✓ 완료");
    expect(html).toContain(`/view?rel=${encodeURIComponent(base.blockers[0]!.rel)}`);
  });

  test("the page has no blocker card and no status strip", () => {
    const body = renderBody(base, "ko");
    expect(body).not.toContain('id="blockers"');
    expect(body).not.toContain("status-strip");
  });

  test("English renders with no Hangul", () => {
    const html = renderRunHealth(base, strings("en")) + renderRunLine(base, strings("en"));
    expect(/[가-힣]/.test(html)).toBe(false);
    expect(html).toContain("Nudged once");
    expect(html).toContain("Your answers");
  });
});

describe("Run Health card — a partly refused audit ledger", () => {
  // Sensor passes and failures come from the audit, so with a shard refused a clean
  // reading covers only the shards read. The tab count is still what was read; the
  // sentence is what must not claim more.
  const en = strings("en");
  const passedRow = {
    fired: 2,
    passed: 2,
    failed: 0,
    superseded: 0,
    unevaluated: 0,
    unverifiedStanding: 0,
    pending: 0,
  };
  const noFailures = (m: DashboardModel): DashboardModel => ({
    ...m,
    sensors: { ...m.sensors, failures: [] },
  });

  test("passed and none are hedged when a shard was refused", () => {
    const passed = noFailures({ ...withSensorRow(passedRow), partialAudit: { notRead: 2 } });
    const html = renderRunHealth(passed, en);
    expect(html).toContain(esc(en.status.checksPassedPartial(2, 2)));
    expect(html).not.toContain(`>${esc(en.status.checksPassed(2))}<`);
    const none = noFailures({ ...withSensorRow({ fired: 0 }), partialAudit: { notRead: 1 } });
    expect(renderRunHealth(none, en)).toContain(esc(en.status.checksNonePartial(1)));
    expect(renderRunHealth(none, en)).not.toContain(`>${esc(en.status.checksNone)}<`);
  });

  test("and read as before when nothing was refused", () => {
    const html = renderRunHealth(noFailures(withSensorRow(passedRow)), en);
    expect(html).toContain(`>${esc(en.status.checksPassed(2))}<`);
  });
});
