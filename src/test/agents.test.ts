// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The Agents tab: who did delegated work in this run, read from what the ledger RECORDS,
// never from who a stage DECLARES. The catalogue names a lead for every stage, but 29 of
// the 33 stages in 2.11.4 run inline — the main session plays the lead and nothing is
// sent — so "the declared lead of the current stage" is not someone working. The only
// honest "open now" is a review request no completion has answered yet.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgents } from "../model/agents";
import { assemble } from "../model/assemble";
import { renderAgents } from "../render/agents";
import { kpiPanels } from "../render/cards";
import { strings } from "../render/i18n";
import { readAgentCatalog } from "../scan/agent-catalog";
import type { AuditEvent } from "../scan/audit";
import type { RunPosition } from "../scan/run-position";
import { pairReviews } from "../scan/timing";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const ko = strings("ko");
const en = strings("en");

const FP = `sha256:${"a".repeat(64)}`;
let seq = 0;
function ev(
  ts: string,
  event: string,
  fields: Record<string, string> = {},
  shard = "a.md",
): AuditEvent {
  return { ts, event, fields, shard, stage: fields.Stage, pos: seq++ };
}
function request(ts: string, o: Record<string, string> = {}): AuditEvent {
  return ev(ts, "REVIEW_REQUESTED", {
    Stage: "functional-design",
    Reviewer: "aidlc-architecture-reviewer-agent",
    Iteration: "1",
    "Artifact Fingerprint": FP,
    "Request Id": "review:00000000000000000000000000000001",
    ...o,
  });
}
function completion(ts: string, o: Record<string, string> = {}): AuditEvent {
  return ev(ts, "REVIEW_COMPLETED", {
    Stage: "functional-design",
    Reviewer: "aidlc-architecture-reviewer-agent",
    Iteration: "1",
    Verdict: "READY",
    "Request Fingerprint": FP,
    "Artifact Fingerprint": FP,
    "Request Id": "review:00000000000000000000000000000001",
    ...o,
  });
}
const at = (stage: string, unit?: string): RunPosition => ({
  stage,
  unit,
  basis: "current-stage",
  verified: true,
});
const NOW = "2026-01-01T12:00:00Z";

describe("review pairing is the timing panel's, exported — not a second reader", () => {
  test("a completion closes the request whose Request Id it echoes", () => {
    const events = [request("2026-01-01T10:00:00Z"), completion("2026-01-01T10:05:00Z")];
    const p = pairReviews(events);
    expect(p.pairs).toEqual([{ request: 0, completion: 1 }]);
    expect(p.pending).toEqual([]);
  });

  test("a completion for another request id closes nothing", () => {
    const events = [
      request("2026-01-01T10:00:00Z"),
      completion("2026-01-01T10:05:00Z", {
        "Request Id": "review:ffffffffffffffffffffffffffffffff",
      }),
    ];
    const p = pairReviews(events);
    expect(p.pairs).toEqual([]);
    expect(p.pending).toEqual([0]);
  });

  test("a replacement takes the pass over: one request pending, counted once", () => {
    const events = [
      request("2026-01-01T10:00:00Z"),
      request("2026-01-01T10:02:00Z", {
        "Request Id": "review:00000000000000000000000000000002",
        "Replaces Request Id": "review:00000000000000000000000000000001",
      }),
      completion("2026-01-01T10:06:00Z", {
        "Request Id": "review:00000000000000000000000000000002",
      }),
    ];
    const p = pairReviews(events);
    expect(p.pairs).toEqual([{ request: 1, completion: 2 }]);
    expect(p.pending).toEqual([]);
  });

  test("a malformed request does not take over the pass it names (engine skips it)", () => {
    // reviewRequestBindingFromBlock returns null for a request with no sha256 fingerprint,
    // and reviewAttemptAccounting then skips the row: the valid request stays pending and
    // its completion still closes it.
    const events = [
      request("2026-01-01T10:00:00Z"),
      request("2026-01-01T10:01:00Z", {
        "Request Id": "review:00000000000000000000000000000009",
        "Artifact Fingerprint": "",
      }),
      completion("2026-01-01T10:05:00Z"),
    ];
    const p = pairReviews(events);
    expect(p.pairs).toEqual([{ request: 0, completion: 2 }]);
    expect(p.pending).toEqual([]);
  });

  test("SUBAGENT_COMPLETED never closes a review", () => {
    const events = [
      request("2026-01-01T10:00:00Z"),
      ev("2026-01-01T10:03:00Z", "SUBAGENT_COMPLETED", {
        "Agent Type": "aidlc-architecture-reviewer-agent",
      }),
    ];
    expect(pairReviews(events).pending).toEqual([0]);
  });
});

describe("what the Agents tab claims", () => {
  test("a declared lead or the state's Active Agent is never 'open now'", () => {
    const events = [
      ev("2026-01-01T10:00:00Z", "STAGE_STARTED", {
        Stage: "functional-design",
        Agent: "aidlc-architect-agent",
      }),
    ];
    const r = buildAgents({ events, position: at("functional-design"), now: NOW });
    expect(r.open).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.reviewers).toEqual([]);
    expect(r.helpers).toEqual([]);
  });

  test("an unanswered request on the stage the run is on is open, with its age", () => {
    const r = buildAgents({
      events: [request("2026-01-01T11:56:00Z")],
      position: at("functional-design"),
      now: NOW,
    });
    expect(r.open.map((o) => [o.reviewer, o.stage, o.sinceSec])).toEqual([
      ["aidlc-architecture-reviewer-agent", "functional-design", 240],
    ]);
    expect(r.pending).toEqual([]);
  });

  test("an unanswered request on a stage that has moved on is NOT working — no completion recorded", () => {
    const events = [
      request("2026-01-01T10:00:00Z"),
      ev("2026-01-01T10:30:00Z", "STAGE_COMPLETED", { Stage: "functional-design" }),
    ];
    const r = buildAgents({ events, position: at("code-generation"), now: NOW });
    expect(r.open).toEqual([]);
    expect(r.pending.map((o) => o.stage)).toEqual(["functional-design"]);
  });

  test("a unit's request is open only for that unit", () => {
    const events = [request("2026-01-01T11:00:00Z", { Unit: "u1" })];
    expect(buildAgents({ events, position: at("functional-design", "u2"), now: NOW }).open).toEqual(
      [],
    );
    expect(
      buildAgents({ events, position: at("functional-design", "u1"), now: NOW }).open.length,
    ).toBe(1);
  });

  test("a stale claim attempt's request does not stay open once a later attempt reviewed", () => {
    const events = [
      request("2026-01-01T10:00:00Z", { Unit: "u1", "Attempt Generation": "1" }),
      request("2026-01-01T10:10:00Z", {
        Unit: "u1",
        "Attempt Generation": "2",
        "Request Id": "review:00000000000000000000000000000002",
      }),
      completion("2026-01-01T10:20:00Z", {
        Unit: "u1",
        "Attempt Generation": "2",
        "Request Id": "review:00000000000000000000000000000002",
      }),
    ];
    const r = buildAgents({ events, position: at("functional-design", "u1"), now: NOW });
    expect(r.open).toEqual([]);
    expect(r.pending.length).toBe(1);
  });

  test("per reviewer: reviews, verdicts, re-passes, paired time, and where each ran", () => {
    const id = (n: number) => `review:${String(n).padStart(32, "0")}`;
    const events = [
      request("2026-01-01T10:00:00Z", { "Request Id": id(1) }),
      completion("2026-01-01T10:06:00Z", { "Request Id": id(1), Verdict: "NOT-READY" }),
      request("2026-01-01T10:10:00Z", { "Request Id": id(2), Iteration: "2" }),
      completion("2026-01-01T10:14:00Z", { "Request Id": id(2), Iteration: "2" }),
      request("2026-01-01T11:00:00Z", {
        "Request Id": id(3),
        Stage: "code-generation",
        Unit: "u1",
      }),
      completion("2026-01-01T11:02:00Z", {
        "Request Id": id(3),
        Stage: "code-generation",
        Unit: "u1",
      }),
    ];
    const r = buildAgents({ events, position: at("code-generation"), now: NOW });
    expect(r.reviewers).toHaveLength(1);
    const rv = r.reviewers[0]!;
    expect([rv.reviews, rv.ready, rv.notReady, rv.rePasses, rv.pairedSec]).toEqual([
      3, 2, 1, 1, 720,
    ]);
    expect(rv.where).toEqual([
      { stage: "functional-design", count: 2 },
      { stage: "code-generation", unit: "u1", count: 1 },
    ]);
    expect(r.lastFinished).toBe("2026-01-01T11:02:00Z");
  });

  test("a request from before request ids is counted apart, never listed as unanswered", () => {
    // A request with no Request Id is a valid legacy binding, and the engine pairs it with
    // an id-less completion of its fingerprint; this completion carries none, so nothing
    // pairs, and the request is counted apart rather than listed as unanswered.
    const events = [
      ev("2026-01-01T10:00:00Z", "REVIEW_REQUESTED", {
        Stage: "functional-design",
        Reviewer: "aidlc-architecture-reviewer-agent",
        Iteration: "1",
        "Artifact Fingerprint": FP,
      }),
      ev("2026-01-01T10:04:00Z", "REVIEW_COMPLETED", {
        Stage: "functional-design",
        Reviewer: "aidlc-architecture-reviewer-agent",
        Iteration: "1",
        Verdict: "READY",
      }),
      ev("2026-01-01T10:30:00Z", "STAGE_COMPLETED", { Stage: "functional-design" }),
    ];
    const r = buildAgents({ events, position: at("code-generation"), now: NOW });
    expect(r.reviewers).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.open).toEqual([]);
    expect(r.unpaired).toEqual({ completions: 1, legacyRequests: 1 });
  });

  test("an unconfirmed position never makes a request 'open now'", () => {
    const r = buildAgents({
      events: [request("2026-01-01T11:56:00Z")],
      position: { ...at("functional-design"), verified: false },
      now: NOW,
    });
    expect(r.open).toEqual([]);
    expect(r.pending.length).toBe(1);
  });

  test("a late request of an older claim attempt is not the open one", () => {
    const events = [
      request("2026-01-01T11:50:00Z", { Unit: "u1", "Attempt Generation": "2" }),
      request("2026-01-01T11:52:00Z", {
        Unit: "u1",
        "Attempt Generation": "1",
        "Request Id": "review:00000000000000000000000000000002",
      }),
    ];
    const r = buildAgents({ events, position: at("functional-design", "u1"), now: NOW });
    expect(r.open.map((o) => o.since)).toEqual(["2026-01-01T11:50:00Z"]);
  });

  test("another workflow's stage completion does not move a request past; an isolated one is never open", () => {
    const events = [
      request("2026-01-01T11:50:00Z"),
      ev("2026-01-01T11:55:00Z", "STAGE_COMPLETED", {
        Stage: "functional-design",
        Workflow: "single-stage:functional-design",
      }),
      request("2026-01-01T11:56:00Z", {
        Workflow: "single-stage:functional-design",
        "Request Id": "review:00000000000000000000000000000003",
      }),
    ];
    const r = buildAgents({ events, position: at("functional-design"), now: NOW });
    expect(r.open.map((o) => o.since)).toEqual(["2026-01-01T11:50:00Z"]);
    expect(r.pending.map((o) => o.since)).toEqual(["2026-01-01T11:56:00Z"]);
  });

  test("a gate rejection that reopens the stage ends the request's attempt", () => {
    const events = [
      request("2026-01-01T11:00:00Z"),
      ev("2026-01-01T11:30:00Z", "GATE_REJECTED", { Stage: "functional-design" }),
    ];
    const r = buildAgents({ events, position: at("functional-design"), now: NOW });
    expect(r.open).toEqual([]);
    expect(r.pending.length).toBe(1);
  });

  test("a Fix findings pick at a blocking gate sensor starts the review attempt again", () => {
    // 2.11.4 `blockingSensorFixes`: the pick rewrites the reviewed document, so the review
    // before it no longer covers it — read like a Request Changes (`reviewAttemptAccounting`).
    const ask = (o: Record<string, string> = {}) =>
      ev("2026-01-01T11:10:00Z", "DECISION_RECORDED", {
        Stage: "functional-design",
        Decision: "Blocking gate sensor failure",
        Options: "Fix findings, Override blocking sensors",
        ...o,
      });
    const turn = () => ev("2026-01-01T11:20:00Z", "HUMAN_TURN");
    const answer = (details: string, o: Record<string, string> = {}) =>
      ev("2026-01-01T11:21:00Z", "QUESTION_ANSWERED", {
        Stage: "functional-design",
        Details: details,
        ...o,
      });
    const openWith = (
      extra: AuditEvent[],
      unit?: string,
      rejectionScope?: (slug: string) => { unitScoped: boolean; team: boolean },
    ) =>
      buildAgents({
        events: [request("2026-01-01T11:00:00Z", unit ? { Unit: unit } : {}), ...extra],
        position: at("functional-design", unit),
        now: NOW,
        ...(rejectionScope ? { rejectionScope } : {}),
      }).open.length;
    const scoped = () => ({ unitScoped: true, team: false });
    expect(openWith([ask(), turn(), answer("Fix findings")])).toBe(0);
    // The label is read as the engine reads it: a number on the question's own Options, a
    // decorator, a `Q1:` slot.
    expect(openWith([ask(), turn(), answer("1")])).toBe(0);
    expect(openWith([ask(), turn(), answer("Q1: fix findings (Recommended)")])).toBe(0);
    // Overriding keeps the review; so does an answer with no person's turn behind it, a
    // question that does not offer both choices, or another question.
    expect(openWith([ask(), turn(), answer("Override blocking sensors")])).toBe(1);
    expect(openWith([ask(), answer("Fix findings")])).toBe(1);
    expect(openWith([ask({ Options: "Fix findings" }), turn(), answer("Fix findings")])).toBe(1);
    expect(openWith([ask({ Decision: "Something else" }), turn(), answer("Fix findings")])).toBe(1);
    // Under unit-scoped floors (`unitScopedLifecycleFloors`) a pick for another unit
    // leaves this unit's request alone; outside them (solo stage-major) it starts every
    // unit's attempt again, as a Request Changes does.
    expect(openWith([ask({ Unit: "u2" }), turn(), answer("Fix findings")], "u1", scoped)).toBe(1);
    expect(openWith([ask({ Unit: "u1" }), turn(), answer("Fix findings")], "u1", scoped)).toBe(0);
    expect(openWith([ask({ Unit: "u2" }), turn(), answer("Fix findings")], "u1")).toBe(0);
    // The answer's own Unit wins over the question's, read nullish: an empty one on the
    // answer is no unit, not the question's (the engine's `??`), so it reopens every unit.
    expect(
      openWith([ask({ Unit: "u1" }), turn(), answer("Fix findings", { Unit: "" })], "u2", scoped),
    ).toBe(0);
  });

  test("a gate rejection narrows to its unit only under unit-scoped floors", () => {
    // `reviewAttemptAccounting`: a rejection naming a Unit starts that Unit's attempt
    // again under team, checkpoints or unit-major; otherwise it is stage-wide. Under team
    // ownership a unit-less rejection leaves a unit's request alone.
    const open = (
      rejection: Record<string, string>,
      rejectionScope?: (slug: string) => { unitScoped: boolean; team: boolean },
    ) =>
      buildAgents({
        events: [
          request("2026-01-01T11:00:00Z", { Unit: "u1" }),
          ev("2026-01-01T11:30:00Z", "GATE_REJECTED", { Stage: "functional-design", ...rejection }),
        ],
        position: at("functional-design", "u1"),
        now: NOW,
        ...(rejectionScope ? { rejectionScope } : {}),
      }).open.length;
    expect(open({ Unit: "u2" })).toBe(0);
    expect(open({ Unit: "u2" }, () => ({ unitScoped: true, team: false }))).toBe(1);
    expect(open({ Unit: "u1" }, () => ({ unitScoped: true, team: false }))).toBe(0);
    expect(open({}, () => ({ unitScoped: true, team: false }))).toBe(0);
    expect(open({}, () => ({ unitScoped: true, team: true }))).toBe(1);
  });

  test("a row the engine skips is no boundary: a malformed later pass leaves the request open", () => {
    const events = [
      request("2026-01-01T11:50:00Z"),
      request("2026-01-01T11:52:00Z", {
        Iteration: "2",
        "Request Id": "review:00000000000000000000000000000004",
        "Artifact Fingerprint": "not-a-fingerprint",
      }),
    ];
    const r = buildAgents({ events, position: at("functional-design"), now: NOW });
    expect(r.open.map((o) => o.since)).toEqual(["2026-01-01T11:50:00Z"]);
  });

  test("a rejection reopens only the stages it names, minus the ones it skipped, unless the review was kept", () => {
    const base = request("2026-01-01T11:00:00Z");
    const pos = at("functional-design");
    const openWith = (extra: AuditEvent[]) =>
      buildAgents({ events: [base, ...extra], position: pos, now: NOW }).open.length;
    // Gate Stages names another stage: Stage alone is not read when Gate Stages is set.
    expect(
      openWith([
        ev("2026-01-01T11:10:00Z", "GATE_REJECTED", {
          Stage: "functional-design",
          "Gate Stages": "nfr-design",
        }),
      ]),
    ).toBe(1);
    // The stage was skipped by the unit: the person's skip stands.
    expect(
      openWith([
        ev("2026-01-01T11:10:00Z", "GATE_REJECTED", {
          Stage: "functional-design",
          "Skipped Stages": "functional-design",
        }),
      ]),
    ).toBe(1);
    // The gate came back with the review it was rejected on.
    expect(
      openWith([
        ev("2026-01-01T11:10:00Z", "GATE_REJECTED", { Stage: "functional-design" }),
        ev("2026-01-01T11:20:00Z", "STAGE_AWAITING_APPROVAL", {
          Stage: "functional-design",
          "Review Kept": "2026-01-01T11:10:00Z",
        }),
      ]),
    ).toBe(1);
  });

  test("Review Kept keeps only the one latest rejection definitely before the re-entry (keptReviewRejections)", () => {
    const openWith = (extra: AuditEvent[]) =>
      buildAgents({
        events: [request("2026-01-01T11:00:00Z", { Unit: "u1" }), ...extra],
        position: at("functional-design", "u1"),
        now: NOW,
      }).open.length;
    const rejected = (ts: string, shard = "a.md") =>
      ev(ts, "GATE_REJECTED", { Stage: "functional-design", Units: "u1" }, shard);
    const reentry = (kept: string) =>
      ev("2026-01-01T11:20:00Z", "STAGE_AWAITING_APPROVAL", {
        Stage: "functional-design",
        "Review Kept": kept,
      });
    // The one latest rejection, named: kept, so the request stays.
    expect(openWith([rejected("2026-01-01T11:10:00Z"), reentry("2026-01-01T11:10:00Z")])).toBe(1);
    // Two clones' rejections in one second tie for the last: the engine keeps none.
    expect(
      openWith([
        rejected("2026-01-01T11:10:00Z", "a.md"),
        rejected("2026-01-01T11:10:00Z", "b.md"),
        reentry("2026-01-01T11:10:00Z"),
      ]),
    ).toBe(0);
    // The kept time names an earlier rejection, not the last one: neither is kept.
    expect(
      openWith([
        rejected("2026-01-01T11:05:00Z"),
        rejected("2026-01-01T11:10:00Z"),
        reentry("2026-01-01T11:05:00Z"),
      ]),
    ).toBe(0);
  });

  test("under unit-major a stage start is no boundary, as the engine floors per unit", () => {
    const events = [
      request("2026-01-01T11:00:00Z", { Unit: "u1" }),
      ev("2026-01-01T11:10:00Z", "STAGE_STARTED", { Stage: "functional-design" }),
    ];
    const unitMajor = (slug: string) => slug === "functional-design";
    expect(
      buildAgents({ events, position: at("functional-design", "u1"), now: NOW, unitMajor }).open
        .length,
    ).toBe(1);
    expect(
      buildAgents({ events, position: at("functional-design", "u1"), now: NOW }).open.length,
    ).toBe(0);
  });

  test("Review Finished: no closes the request but is not a review the reviewer finished", () => {
    const events = [
      request("2026-01-01T10:00:00Z"),
      completion("2026-01-01T10:09:00Z", { Verdict: "NOT-READY", "Review Finished": "no" }),
    ];
    const r = buildAgents({ events, position: at("functional-design"), now: NOW });
    expect(r.pending).toEqual([]);
    const rv = r.reviewers[0]!;
    expect([rv.reviews, rv.notReady, rv.unfinished, rv.pairedSec]).toEqual([0, 0, 1, 0]);
    expect(r.lastFinished).toBeUndefined();
  });

  test("display names come from the harness's own files, also outside the declared crew", () => {
    const r = buildAgents({
      events: [
        request("2026-01-01T10:00:00Z", { Reviewer: "acme-custom-reviewer" }),
        completion("2026-01-01T10:05:00Z", { Reviewer: "acme-custom-reviewer" }),
      ],
      position: at("functional-design"),
      now: NOW,
      agentCatalog: {
        agents: new Map([
          [
            "acme-custom-reviewer",
            { slug: "acme-custom-reviewer", displayName: "Custom Reviewer" },
          ],
        ]),
        tiers: new Map(),
      },
    });
    expect(r.names["acme-custom-reviewer"]).toBe("Custom Reviewer");
  });

  test("helpers are counts per Agent Type only — no time, no 'running'", () => {
    const events = [
      ev("2026-01-01T10:00:00Z", "SUBAGENT_DISPATCHED", { "Agent Type": "aidlc-developer-agent" }),
      ev("2026-01-01T10:05:00Z", "SUBAGENT_COMPLETED", { "Agent Type": "aidlc-developer-agent" }),
      ev("2026-01-01T10:06:00Z", "SUBAGENT_DISPATCHED", { "Agent Type": "aidlc-developer-agent" }),
      ev("2026-01-01T10:07:00Z", "SUBAGENT_COMPLETED", { "Agent Type": "aidlc-quality-agent" }),
    ];
    const r = buildAgents({ events, position: at("code-generation"), now: NOW });
    expect(r.helpers).toEqual([
      { agentType: "aidlc-developer-agent", sent: 2, finished: 1 },
      { agentType: "aidlc-quality-agent", sent: 0, finished: 1 },
    ]);
    expect(r.helpersDispatchRecorded).toBe(true);
    expect(r.open).toEqual([]);
  });
});

describe("agent definitions come from whichever harness dir the run uses", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-catalog-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("frontmatter name, display_name and a folded description; tiers by short name", () => {
    const dir = path.join(tmp, ".claude", "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "aidlc-architect-agent.md"),
      "---\nname: aidlc-architect-agent\ndisplay_name: Architect Agent\ndescription: >\n  Designs the domain.\n  Leads design stages.\n---\nbody\n",
    );
    fs.writeFileSync(path.join(dir, "notes.txt"), "not an agent");
    fs.mkdirSync(path.join(tmp, ".claude", "tools", "data"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude", "tools", "data", "agent-tiers.json"),
      JSON.stringify({ architect: "judgment" }),
    );
    const c = readAgentCatalog(tmp, ".claude");
    expect(c?.agents.get("aidlc-architect-agent")).toEqual({
      slug: "aidlc-architect-agent",
      displayName: "Architect Agent",
      description: "Designs the domain. Leads design stages.",
      tier: "judgment",
    });
    expect(c?.asOf).toBeDefined();
  });

  test("no agents dir and no tiers file → no catalogue", () => {
    expect(readAgentCatalog(tmp, ".kiro")).toBeUndefined();
  });
});

describe("the reference run", () => {
  const m = assemble(FIXTURE);

  test("reads the recorded review and the helper completion, and claims nothing open", () => {
    expect(m.agents.reviewers.map((r) => [r.reviewer, r.reviews, r.ready, r.pairedSec])).toEqual([
      ["code-reviewer", 1, 1, 300],
    ]);
    expect(m.agents.helpers).toEqual([{ agentType: "code-reviewer", sent: 0, finished: 1 }]);
    expect(m.agents.helpersDispatchRecorded).toBe(false);
    // The state's Active Agent is aidlc-developer-agent: a declared lead, not a delegation.
    expect(m.agents.open).toEqual([]);
  });

  test("the declared crew comes from the harness, labelled by stage role", () => {
    const architect = m.agents.declared.find((d) => d.slug === "aidlc-architect-agent");
    expect(architect?.displayName).toBe("Architect Agent");
    expect(architect?.tier).toBe("judgment");
    expect(architect?.lead).toContain("functional-design");
    expect(m.agents.inline.total).toBeGreaterThan(0);
    expect(m.provenance["agent-catalog"].asOf).toBeDefined();
  });

  test("a fourth Details tab, after timing", () => {
    expect(kpiPanels(m, ko).map((p) => p.id)).toEqual([
      "drill-overview",
      "drill-usage",
      "drill-timeline",
      "drill-agents",
    ]);
    expect(kpiPanels(m, ko)[3]?.title).toBe(ko.agents.section);
  });

  test("the declared crew is folded and says it is not a record of work", () => {
    const html = renderAgents(m, ko);
    expect(html).toMatch(/<details class="ag-crew"><summary>/);
    expect(html).toContain(ko.agents.declaredNote);
    expect(renderAgents(m, en)).toContain(en.agents.declaredNote);
  });

  test("English renders with no Hangul", () => {
    expect(/[가-힣]/.test(renderAgents(m, en))).toBe(false);
  });
});

describe("a run with no delegation keeps the tab, quietly", () => {
  test("one mute line, no rows — only the folded declared crew keeps its list", () => {
    const m = assemble(FIXTURE);
    const quiet = {
      ...m,
      agents: {
        ...m.agents,
        reviewers: [],
        helpers: [],
        open: [],
        pending: [],
        lastFinished: undefined,
      },
    };
    const html = renderAgents(quiet, ko);
    expect(html).toContain(ko.agents.quiet);
    const outsideFold = html.replace(/<details class="ag-crew">[\s\S]*<\/details>/, "");
    expect(outsideFold).not.toContain('class="mr ');
    expect(outsideFold).not.toContain(ko.agents.reviewersTitle);
  });

  test("with the position unconfirmed it does not say nothing is open where the run is", () => {
    const m = assemble(FIXTURE);
    const unverified = { ...m, agents: { ...m.agents, positionVerified: false } };
    const html = renderAgents(unverified, en);
    expect(html).not.toContain("No review request open where the run is");
    expect(m.agents.positionVerified).toBe(m.waits.position.verified);
  });

  test("with a refused shard a non-empty panel says its figures are of the records read", () => {
    const m = assemble(FIXTURE);
    const html = renderAgents({ ...m, partialAudit: { notRead: 2 } }, en);
    expect(html).toContain(en.agents.partialNote(2));
    expect(renderAgents(m, en)).not.toContain(en.agents.partialNote(2));
  });

  test("with a refused shard the quiet line is hedged", () => {
    const m = assemble(FIXTURE);
    const quiet = {
      ...m,
      partialAudit: { notRead: 1 },
      agents: {
        ...m.agents,
        reviewers: [],
        helpers: [],
        open: [],
        pending: [],
        lastFinished: undefined,
      },
    };
    expect(renderAgents(quiet, ko)).toContain(ko.agents.quietPartial(1));
  });
});
