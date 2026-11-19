// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Who did delegated work in this run — read from what the ledger RECORDS.
//
// THE DECLARED CREW IS NOT A RECORD OF WORK. The stage graph names a lead for every
// stage, support agents and a reviewer for some, and the state carries an `Active Agent`
// — but in 2.11.4 29 of the 33 stages run `inline`: the main session plays the lead
// itself, nothing is sent, and the ledger records no delegation. `STAGE_STARTED.Agent`
// and `Active Agent` are that same declared lead. So none of them is ever "working":
// measured over the local trees, 174 of 650 declared agent slots ever appear in a ledger,
// and a reader that showed the other 476 as "unused" or the current stage's lead as
// "working" would be reporting the catalogue as if it were the run.
//
// WHAT IS RECORDED, AND WHAT EACH RECORD CAN CARRY:
//   - Reviews. `REVIEW_REQUESTED` / `REVIEW_COMPLETED` pair by the same matching rule the
//     timing panel's delegated time uses (scan/timing.ts `pairReviews` — not a second
//     reader), so a reviewer's reviews, verdicts, passes and request → completion time
//     are measured. The engine also checks the verdict shape and the review record before
//     a completion COUNTS (`reviewCompletionMatchesRequest`); that is not transcribed, so a
//     review here is one recorded, not one the engine accepted. A NOT-READY fallback
//     (`Review Finished: no`) closes its request but is no review the reviewer finished.
//   - "Open now" is narrower than "no completion found", because the timing pairing's
//     remainder is not the engine's pending request (found in review, each reproduced against
//     the 2.11.4 accounting in `reviewAttemptAccounting`): the run position must be
//     VERIFIED and on the request's stage and unit; the request must be the main
//     workflow's (an isolated `single-stage:*` run has its own accounting) and of the
//     newest claim attempt of its scope (a late row of an older attempt came after a newer
//     one in the ledger); and no attempt boundary may follow it — its stage completed in
//     ITS workflow, its unit completed, the stage re-entered, a gate rejection reopening
//     the stage, or a later pass of the same review. Every other unanswered request is
//     only "no matching completion found in the records read" — never "working", and not
//     "the run moved on" either, which the reader cannot prove.
//   - A request with no `Request Id` is a legacy binding the engine still pairs with an
//     id-less completion of its fingerprint; one left unanswered is COUNTED apart, never
//     listed. A request with no `sha256:` fingerprint is no request at all to the engine
//     (`reviewRequestBindingFromBlock`), and pairReviews skips it: the 110 old id-less
//     requests on local trees were all of that kind, so they left the panel entirely and
//     their completions are counted among the ones nothing pairs (122 over 50 runs).
//   - Helpers. No key shared by every helper links a dispatch to its completion
//     (`SUBAGENT_DISPATCHED` names an `Agent Type`, plus a `Dispatch Agent` only for a
//     Kiro reviewer copy), so helpers get counts per type, no duration and no "running".
//     35 of 205 local records carry any dispatch row, so completions only is the normal
//     case, and is said.

import { type AgentCatalog, agentShortName } from "../scan/agent-catalog";
import type { AuditEvent } from "../scan/audit";
import { answeredBy } from "../scan/decision-wait";
import { AGENT_DISPLAY } from "../scan/parser";
import type { RunPosition } from "../scan/run-position";
import type { StageCatalog } from "../scan/stage-catalog";
import { bindableReviewRequest, pairReviews } from "../scan/timing";
import type { AgentsReport, DeclaredAgent, HelperStat, PendingReview, ReviewerStat } from "./types";

export interface AgentsInput {
  events: readonly AuditEvent[];
  position: RunPosition;
  /** Assembly clock, for an open request's age. */
  now: string;
  catalog?: StageCatalog;
  agentCatalog?: AgentCatalog;
  /** Stages this plan runs; absent = every catalogue stage. */
  inScope?: (slug: string) => boolean;
  /**
   * A per-unit stage under unit-major (`Construction Iteration: unit-major` or checkpoints
   * on): the engine floors it per unit, so a stage start is no boundary there.
   */
  unitMajor?: (slug: string) => boolean;
  /**
   * How a rejection or a Fix findings pick on a stage is scoped, as
   * `reviewAttemptAccounting` reads it: `unitScoped` is a per-unit stage under
   * `unitScopedLifecycleFloors` (team ownership, checkpoints on, or unit-major), where a
   * rejection naming a unit starts only that unit's attempt again; `team` is a per-unit
   * stage under team ownership or checkpoints, where a unit-less one leaves a unit's
   * request alone too. Absent: neither, so every rejection is stage-wide.
   */
  rejectionScope?: (slug: string) => { unitScoped: boolean; team: boolean };
}

const field = (e: AuditEvent, name: string): string => e.fields[name] ?? "";
const stageOf = (e: AuditEvent): string => e.fields.Stage ?? e.stage ?? "";

/** Display name for an agent slug: its own file, then the known roster, else none. */
export function agentDisplayName(slug: string, catalog?: AgentCatalog): string | undefined {
  return catalog?.agents.get(slug)?.displayName ?? AGENT_DISPLAY[slug];
}

function secsBetween(a: string, b: string): number {
  const d = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isFinite(d) ? Math.max(0, d) : 0;
}

/** A review row the engine reads: a bindable request, or a completion with a verdict. */
function readableReviewRow(e: AuditEvent): boolean {
  if (e.event === "REVIEW_REQUESTED") return bindableReviewRequest(e);
  if (e.event !== "REVIEW_COMPLETED") return false;
  const v = field(e, "Verdict");
  return v === "READY" || v === "NOT-READY";
}

const list = (v: string): string[] =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** The engine's `BLOCKING_SENSOR_OVERRIDE_DECISION` and `…_OPTIONS` (aidlc-lib.ts, 2.11.4). */
const BLOCKING_DECISION = "Blocking gate sensor failure";
const BLOCKING_OPTIONS = ["Fix findings", "Override blocking sensors"] as const;
/** `BLOCKING_SENSOR_BOUNDARY_EVENTS`: rows that start a stage's gate over. */
const BLOCKING_BOUNDARY = new Set(["STAGE_STARTED", "STAGE_AWAITING_APPROVAL", "GATE_REJECTED"]);
/** `DECISION_PAIRING_EVENTS`: an ask and every row that can answer one. */
const DECISION_PAIRING = new Set([
  "DECISION_RECORDED",
  "QUESTION_ANSWERED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "VERIFICATION_COMMAND_RECORDED",
  "CONSTRUCTION_POLICY_RECORDED",
  "PLAN_APPROVAL_RECORDED",
  "GATE_APPROVED",
  "GATE_REJECTED",
]);

/** `optionsList`: `|a|b` or `a, b`. */
function optionsList(text: string): string[] {
  const value = text.trimStart();
  return (value.startsWith("|") ? value.slice(1).split("|") : value.split(",")).map((o) =>
    o.trim(),
  );
}

/** `offeredChoiceLabel` (aidlc-lib.ts, with `stripRecommendedDecorator`), for these labels. */
function offeredChoice(details: string): (typeof BLOCKING_OPTIONS)[number] | undefined {
  const text = details
    .trim()
    .replace(/\s*\(recommended\)\s*$/i, "")
    .trim()
    .replace(/^(?:(?:[A-Za-z]|\d+)[.)])\s*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  for (const choice of BLOCKING_OPTIONS) {
    if (text.slice(0, choice.length).toLowerCase() !== choice.toLowerCase()) continue;
    const tail = text.slice(choice.length);
    if (tail === "" || /^[\s:;,.!-]/.test(tail)) return choice;
  }
  return undefined;
}

/** `checkLabel`: one reply to several questions is one record, read part by part. */
function checkLabel(details: string): (typeof BLOCKING_OPTIONS)[number] | undefined {
  for (const part of details.split(/[;,]/)) {
    const choice = offeredChoice(part.trim().replace(/^Q\d+:\s*/, ""));
    if (choice !== undefined) return choice;
  }
  return undefined;
}

/**
 * The Fix findings picks at a blocking gate sensor's question (2.11.4 `blockingSensorPicks`
 * read through `blockingSensorFixes`): the ledger index of each answer that picked it, with
 * the unit whose review attempt it starts again, or null for every unit. The engine reads
 * such a pick like a Request Changes, because the fix rewrites the reviewed document.
 *
 * Pairing per shard, in attempt order: the open decision is the shard's own (`answeredBy`,
 * the engine's `nextOpenDecision`); a later question displaces an open sensor question
 * until the stage's next boundary, and an answer naming one of its labels still takes it.
 * A pick needs a `HUMAN_TURN` in that shard between the question and the answer, and the
 * question must offer both choices.
 *
 * Two parts are NOT transcribed, and they err in OPPOSITE directions. The checkpoint
 * walk's earlier reply (in unit-major checkpoint work the refusal itself asks, so a reply
 * after the refusing fire also backs a pick — that needs each stage's blocking sensors)
 * is left out, so a pick the engine takes can be missed here: FEWER boundaries, a request
 * left "open now" that the engine no longer holds. The narrowing of a unit-less pick to
 * the units whose outputs failed is left out too, so on a per-unit stage under unit-scoped
 * floors such a pick reads as null, and where that lands depends on the policy
 * (`boundaryAfter`'s `rejectionScope`):
 *   - team or checkpoints: a unit-less rejection leaves unit requests alone, so the pick
 *     reopens none of them, the failed unit's included — FEWER boundaries, a request the
 *     engine closes left "open now";
 *   - solo unit-major (neither team nor checkpoints): it reopens every unit's request,
 *     where the engine keeps the units that did not fail — MORE boundaries, a request the
 *     engine still holds moved out of "open now".
 * Outside unit-scoped floors a pick is stage-wide in the engine too, and nothing differs.
 */
function fixFindingsPicks(events: readonly AuditEvent[]): Map<number, string | null> {
  const order = events
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e }) =>
        (DECISION_PAIRING.has(e.event) || BLOCKING_BOUNDARY.has(e.event)) &&
        e.fields.Stage !== undefined &&
        !field(e, "Workflow").startsWith("single-stage:"),
    )
    .sort((a, b) => {
      if (a.e.ts !== b.e.ts) return a.e.ts < b.e.ts ? -1 : 1;
      if (a.e.shard === b.e.shard) return (a.e.pos ?? a.i) - (b.e.pos ?? b.i);
      if ((a.e.shardIndex ?? 0) !== (b.e.shardIndex ?? 0))
        return (a.e.shardIndex ?? 0) - (b.e.shardIndex ?? 0);
      return (a.e.pos ?? a.i) - (b.e.pos ?? b.i);
    });
  const posOf = (i: number) => events[i]?.pos ?? i;
  const picks = new Map<number, string | null>();
  // Keyed by shard and stage: the engine runs this per stage over the stage's rows.
  const open = new Map<string, number>();
  const displaced = new Map<string, number>();
  const asksCheck = (i: number | undefined) =>
    i !== undefined && events[i]?.fields.Decision === BLOCKING_DECISION;
  for (const { e, i } of order) {
    const stage = e.fields.Stage ?? "";
    const key = `${e.shard}\u0000${stage}`;
    if (BLOCKING_BOUNDARY.has(e.event)) {
      for (const k of [...displaced.keys()]) if (k.endsWith(`\u0000${stage}`)) displaced.delete(k);
    }
    if (!DECISION_PAIRING.has(e.event)) continue;
    const latest = open.get(key);
    if (e.event === "DECISION_RECORDED") {
      open.set(key, i);
      if (asksCheck(i)) displaced.delete(key);
      else if (asksCheck(latest)) displaced.set(key, latest!);
    } else if (latest === undefined || answeredBy(events[latest], e)) {
      open.delete(key);
    }
    const details = field(e, "Details");
    const takesDisplaced =
      e.event === "QUESTION_ANSWERED" && !asksCheck(latest) && checkLabel(details) !== undefined;
    const decision = takesDisplaced ? displaced.get(key) : latest;
    if (takesDisplaced) displaced.delete(key);
    if (decision === undefined || e.event !== "QUESTION_ANSWERED" || !asksCheck(decision)) continue;
    const q = events[decision]!;
    const offered = optionsList(field(q, "Options"));
    if (!BLOCKING_OPTIONS.every((o) => offered.includes(o))) continue;
    const replied = events.some(
      (t, ti) =>
        t.event === "HUMAN_TURN" &&
        t.shard === e.shard &&
        posOf(ti) > posOf(decision) &&
        posOf(ti) < posOf(i),
    );
    if (!replied) continue;
    const numbered = /^(\d+)[.)]?$/.exec(details);
    const named = numbered ? offered[Number(numbered[1]) - 1] : checkLabel(details);
    if (named !== BLOCKING_OPTIONS[0]) continue;
    // `answer.Unit ?? decision.Unit`, nullish as the engine reads it: an empty Unit on the
    // answer is no unit (a unit-less pick), not the question's.
    picks.set(i, (e.fields.Unit ?? q.fields.Unit) || null);
  }
  return picks;
}

/**
 * The engine's `attemptEventDefinitelyBefore`: append order inside one shard, a strictly
 * earlier second across shards (two clones' rows in one second are unordered).
 */
function definitelyBefore(events: readonly AuditEvent[], a: number, b: number): boolean {
  const x = events[a]!;
  const y = events[b]!;
  if (x.shard === y.shard) return (x.pos ?? a) < (y.pos ?? b);
  return x.ts < y.ts;
}

/**
 * The engine's `keptReviewRejections` (2.11.4): for each re-entry row of `slug` carrying
 * `Review Kept`, the LAST stage-level rejection of `slug` definitely before it
 * (`maximalAttemptEvents`, falling back to the latest second when the mixed order leaves
 * no maximal row) is kept — only when it is the one such row and its time is the one the
 * field names. A tie for the last keeps none, so the review is asked for again. Returns
 * ledger indices.
 */
function keptReviewRejections(events: readonly AuditEvent[], slug: string): Set<number> {
  const kept = new Set<number>();
  events.forEach((row, r) => {
    if (row.event !== "STAGE_AWAITING_APPROVAL" || row.fields.Stage !== slug) return;
    const at = row.fields["Review Kept"];
    if (at === undefined) return;
    const candidates: number[] = [];
    events.forEach((c, i) => {
      if (
        c.event === "GATE_REJECTED" &&
        c.fields.Stage === slug &&
        c.fields.Unit === undefined &&
        definitelyBefore(events, i, r)
      ) {
        candidates.push(i);
      }
    });
    let last = candidates.filter(
      (i) => !candidates.some((o) => o !== i && definitelyBefore(events, i, o)),
    );
    if (last.length === 0 && candidates.length > 0) {
      const latest = candidates.reduce((t, i) => (events[i]!.ts > t ? events[i]!.ts : t), "");
      last = candidates.filter((i) => events[i]!.ts === latest);
    }
    if (last.length === 1 && events[last[0]!]!.ts === at) kept.add(last[0]!);
  });
  return kept;
}

/**
 * An attempt boundary follows this request in the ledger, so the engine's accounting no
 * longer holds it (`reviewAttemptAccounting`'s floors): the stage completed in the
 * request's own workflow, its unit completed, the stage started again (not under
 * unit-major, which floors per unit), a gate rejection reopened the stage — the engine's
 * `gateStagesReopened`: `Gate Stages` else `Stage`, minus `Skipped Stages`, a unit-scoped
 * one only for that unit, and not a rejection whose review was kept (`keptReviewRejections`)
 * — or a later pass of the same review that the engine reads.
 */
function boundaryAfter(
  events: readonly AuditEvent[],
  at: number,
  unitMajor: (slug: string) => boolean,
  fixes: ReadonlyMap<number, string | null>,
  rejectionScope: (slug: string) => { unitScoped: boolean; team: boolean },
): boolean {
  const req = events[at]!;
  const stage = field(req, "Stage");
  const unit = field(req, "Unit");
  const workflow = field(req, "Workflow");
  const iteration = Number(field(req, "Iteration"));
  const same = (e: AuditEvent) =>
    ["Stage", "Reviewer", "Unit", "Workflow"].every((f) => field(e, f) === field(req, f));
  const kept = keptReviewRejections(events, stage);
  for (let j = at + 1; j < events.length; j++) {
    const e = events[j]!;
    const sameWorkflow = field(e, "Workflow") === workflow;
    if (e.event === "STAGE_COMPLETED" && stageOf(e) === stage && sameWorkflow) return true;
    if (e.event === "STAGE_STARTED" && stageOf(e) === stage && sameWorkflow && !unitMajor(stage)) {
      return true;
    }
    if (unit && e.event === "UNIT_COMPLETED" && field(e, "Unit") === unit && stageOf(e) === stage) {
      return true;
    }
    if (e.event === "GATE_REJECTED" || fixes.has(j)) {
      // `gateStagesReopened`: `Gate Stages` else `Stage`, minus `Skipped Stages`.
      const named = field(e, "Gate Stages") ? list(field(e, "Gate Stages")) : [field(e, "Stage")];
      const skipped = list(field(e, "Skipped Stages"));
      if (!named.filter((x) => x && !skipped.includes(x)).includes(stage)) continue;
      // A rejection whose review a later re-entry kept starts no attempt.
      if (kept.has(j)) continue;
      // `rejectionUnits`: the row's own Unit, else the pick's; null is stage-wide.
      const own = field(e, "Unit");
      const rejected = own ? own : fixes.has(j) ? (fixes.get(j) ?? null) : null;
      const { unitScoped, team } = rejectionScope(stage);
      if (unitScoped && unit && rejected !== unit && (team || rejected !== null)) continue;
      if (unitScoped && !unit && rejected !== null) continue;
      return true;
    }
    if (readableReviewRow(e) && same(e) && Number(field(e, "Iteration")) > iteration) return true;
  }
  return false;
}

/** Some readable row of the same review scope carries a numerically newer claim attempt. */
function olderAttempt(events: readonly AuditEvent[], at: number): boolean {
  const req = events[at]!;
  const mine = Number(field(req, "Attempt Generation") || "0");
  return events.some(
    (e) =>
      readableReviewRow(e) &&
      ["Stage", "Reviewer", "Unit", "Workflow"].every((f) => field(e, f) === field(req, f)) &&
      Number(field(e, "Attempt Generation") || "0") > mine,
  );
}

export function buildAgents(input: AgentsInput): AgentsReport {
  const { events, position, now } = input;
  const pairing = pairReviews(events);
  const fixes = fixFindingsPicks(events);

  // Reviewers, from the completions that answer a recorded request.
  const byReviewer = new Map<string, ReviewerStat>();
  let lastFinished: string | undefined;
  for (const p of pairing.pairs) {
    const req = events[p.request]!;
    const done = events[p.completion]!;
    const reviewer = field(done, "Reviewer");
    const stat = byReviewer.get(reviewer) ?? {
      reviewer,
      reviews: 0,
      ready: 0,
      notReady: 0,
      rePasses: 0,
      unfinished: 0,
      pairedSec: 0,
      where: [],
    };
    byReviewer.set(reviewer, stat);
    // The engine's fallback when a retried review still wrote no whole review: it closes
    // the request, but no reviewer gave this verdict (`REVIEW_FINISHED_FIELD`).
    if (field(done, "Review Finished") === "no") {
      stat.unfinished++;
      continue;
    }
    stat.reviews++;
    const verdict = field(done, "Verdict");
    if (verdict === "READY") stat.ready++;
    else if (verdict === "NOT-READY") stat.notReady++;
    if (Number(field(done, "Iteration")) > 1) stat.rePasses++;
    stat.pairedSec += secsBetween(req.ts, done.ts);
    const stage = field(done, "Stage");
    const unit = field(done, "Unit") || undefined;
    const spot = stat.where.find((w) => w.stage === stage && w.unit === unit);
    if (spot) spot.count++;
    else stat.where.push({ stage, ...(unit ? { unit } : {}), count: 1 });
    if (!lastFinished || done.ts > lastFinished) lastFinished = done.ts;
  }

  // Unanswered requests: "open now" only on the confirmed position, of the main workflow
  // and newest attempt, with no boundary after it; the rest are only "not found answered".
  const open: PendingReview[] = [];
  const pending: PendingReview[] = [];
  let legacyRequests = 0;
  for (const at of pairing.pending) {
    const req = events[at]!;
    if (!field(req, "Request Id")) {
      legacyRequests++;
      continue;
    }
    const stage = field(req, "Stage");
    const unit = field(req, "Unit") || undefined;
    const workflow = field(req, "Workflow") || undefined;
    const row: PendingReview = {
      reviewer: field(req, "Reviewer"),
      stage,
      ...(unit ? { unit } : {}),
      ...(workflow ? { workflow } : {}),
      iteration: Number(field(req, "Iteration")),
      since: req.ts,
      sinceSec: secsBetween(req.ts, now),
    };
    const here =
      position.verified &&
      !workflow &&
      stage === position.stage &&
      (!unit || !position.unit || unit === position.unit);
    const held = !boundaryAfter(
      events,
      at,
      input.unitMajor ?? (() => false),
      fixes,
      input.rejectionScope ?? (() => ({ unitScoped: false, team: false })),
    );
    (here && held && !olderAttempt(events, at) ? open : pending).push(row);
  }
  open.reverse();
  pending.reverse();

  const paired = new Set(pairing.pairs.map((p) => p.completion));
  const unpairedCompletions = events.filter(
    (e, i) => e.event === "REVIEW_COMPLETED" && !paired.has(i),
  ).length;

  // Helpers: counts per type — nothing pairs a dispatch with its completion.
  const byType = new Map<string, HelperStat>();
  let dispatched = false;
  for (const e of events) {
    if (e.event !== "SUBAGENT_DISPATCHED" && e.event !== "SUBAGENT_COMPLETED") continue;
    const agentType = field(e, "Agent Type") || "unknown";
    const stat = byType.get(agentType) ?? { agentType, sent: 0, finished: 0 };
    if (e.event === "SUBAGENT_DISPATCHED") {
      stat.sent++;
      dispatched = true;
    } else {
      stat.finished++;
      if (!lastFinished || e.ts > lastFinished) lastFinished = e.ts;
    }
    byType.set(agentType, stat);
  }

  // The declared crew of the stages this plan runs.
  const recorded = new Set<string>();
  for (const e of events) {
    if (e.event.startsWith("REVIEW_")) recorded.add(field(e, "Reviewer"));
    if (e.event.startsWith("SUBAGENT_")) {
      recorded.add(field(e, "Agent Type"));
      recorded.add(field(e, "Dispatch Agent"));
    }
  }
  const crew = new Map<string, DeclaredAgent>();
  const role = (slug: string | undefined, key: "lead" | "support" | "reviews", stage: string) => {
    // `orchestrator` is the engine's own pseudo-lead, not an agent anyone sends.
    if (!slug || slug === "orchestrator") return;
    const def = input.agentCatalog?.agents.get(slug);
    const a = crew.get(slug) ?? {
      slug,
      ...(agentDisplayName(slug, input.agentCatalog)
        ? { displayName: agentDisplayName(slug, input.agentCatalog) }
        : {}),
      ...((def?.tier ?? input.agentCatalog?.tiers.get(agentShortName(slug)))
        ? { tier: def?.tier ?? input.agentCatalog?.tiers.get(agentShortName(slug)) }
        : {}),
      lead: [],
      support: [],
      reviews: [],
      recorded: recorded.has(slug),
    };
    if (!a[key].includes(stage)) a[key].push(stage);
    crew.set(slug, a);
  };
  let inline = 0;
  let withMode = 0;
  for (const st of input.catalog?.stages ?? []) {
    if (input.inScope && !input.inScope(st.slug)) continue;
    if (st.mode) {
      withMode++;
      if (st.mode === "inline") inline++;
    }
    role(st.leadAgent, "lead", st.slug);
    for (const s of st.supportAgents ?? []) role(s, "support", st.slug);
    role(st.reviewer, "reviews", st.slug);
  }

  const reviewers = [...byReviewer.values()].sort(
    (a, b) => b.reviews - a.reviews || a.reviewer.localeCompare(b.reviewer),
  );
  const helpers = [...byType.values()].sort(
    (a, b) => b.sent + b.finished - (a.sent + a.finished) || a.agentType.localeCompare(b.agentType),
  );
  const names: Record<string, string> = {};
  const name = (slug: string) => {
    const n = agentDisplayName(slug, input.agentCatalog);
    if (slug && n) names[slug] = n;
  };
  for (const r of reviewers) name(r.reviewer);
  for (const h of helpers) name(h.agentType);
  for (const p of [...open, ...pending]) name(p.reviewer);
  for (const d of crew.values()) name(d.slug);
  return {
    open,
    pending,
    positionVerified: position.verified,
    reviewers,
    helpers,
    helpersDispatchRecorded: dispatched,
    ...(lastFinished ? { lastFinished } : {}),
    declared: [...crew.values()],
    inline: { inline, total: withMode },
    names,
    unpaired: { completions: unpairedCompletions, legacyRequests },
  };
}
