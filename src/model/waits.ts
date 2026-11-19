// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// What the run is held on besides an unanswered question — and where it is.
//
// The status strip used to answer "is anything waiting on you" from two things:
// blank `[Answer]:` tags in the stage `Current Stage` names, and an approval the
// audit had seen asked but not yet seen the stage move past. Both were read against
// the wrong stage under unit-major (see scan/run-position.ts), the gate stayed
// "awaiting" after it was answered, and four other ways the engine holds a run for a
// person were not read at all. Each reading below names the engine source it
// mirrors, because "waiting on you" is a claim the page makes on the engine's
// behalf.
//
//   - GATE: the engine treats the run as waiting on a person when the Current Stage
//     row is `[?]` (aidlc-continue-workflow.ts `isHumanWaitStop`). The row is the
//     authority; the audit (`pendingOrganicGate`, scan/gate-wait.ts) only says since
//     when. An audit-open gate on a row that is not `[?]` is a stale stamp.
//     Since 2.11.4 the row holds the turn only while the person has NOT replied to the
//     gate (`repliedToGate`): after a reply the move is the agent's, which must record
//     the approval or rejection. A replied gate is shown as such and not counted.
//   - TEAM UNIT GATE: under team ownership the engine reads a unit's gate from the
//     audit by unit, gate scope and CLAIM ATTEMPT (`unitGateStatus`) and never moves
//     the global row to `[?]`; `isHumanWaitStop` asks it first, for the active stage
//     and unit at `effectiveUnitGateRhythm`'s scope. Read here the same way
//     (scan/team-gate.ts, the claim filter in scan/claim-attempt.ts): an open one
//     counts like the stage gate, a revising one is shown like `[R]`. Where the claim
//     attempt cannot be resolved (an intent registry the engine would throw on) it is
//     said to be unread, never an absent `[?]` read as "nothing waiting". The active
//     stage and unit are the hook's own probe, so the scope follows the decision's.
//   - REVISING: a `[R]` row — the person rejected the gate. The hook's own comment
//     says the row covers both asking the person what to change and the rework, so it
//     is shown, not counted, and the copy does not say whose move it is.
//   - PARKED: `Parked` + `Parked At Stage` in `## Runtime State`, valid only while
//     `Parked At Stage` is still the Current Stage — a park the run has moved past
//     is a leftover. `Parked By: person` (2.11) marks one a person set.
//     A current marker of kind `parked` is the engine's own park directive and counts
//     too — it covers the checkout-local park (`aidlc/.aidlc-unit-parked`), which the
//     state does not record. That file alone is shown but not counted: whether it
//     applies to this intent is decided by a scope stamp this reader does not check.
//   - UNIT PAUSED: `Unit State: paused`, with the engine's own reason and next action.
//     The engine's hold on it is its `unit-paused` ask, which only the per-unit routers
//     issue — each after its stage-level return (aidlc-orchestrate.ts) — so at stage
//     level a paused unit holds nothing: it is a leftover of an earlier plan, said as
//     one (`unitCacheLeftover`) and not counted.
//   - ENGINE ASK: a current `active-directive.json` of kind `ask` — 2.11.4 holds sixteen
//     kinds of question there (`ENGINE_ASK_TYPES`, plus `plan-approval` and `compose`)
//     and writes a questions file for only one of them (plan approval), so without the
//     marker the rest are invisible. A current
//     marker is not proof the ask is still open, so two answered shapes are dropped:
//     a plan approval whose questions file already holds the section (the blocker
//     list reads it, answered or not), and a guard-recovery ask whose response is
//     `ready`. `delivery` is not read as "shown to the person" — ordinary publication
//     leaves `issued`.
//   - ENGINE-ONLY BLANK: the stop hook's raw test (`rawBlank`) on the active stage's
//     own questions files, when no ask this dashboard reads explains it — a fenced
//     example, a placeholder answered elsewhere. A diagnostic, not a count: what it
//     proves is that the hook may let the turn end there, not that a person owes an
//     answer. The hook reads them only while the Current Stage row is `[-]` — except
//     for a team unit-major directive, where it skips that row check.
//   - OPEN DECISION: an ask opened through the audit (`DECISION_RECORDED`) that no
//     receipt has closed — learnings, "Anything to add?", a Construction Unit or
//     Swarm Batch Approval (scan/decision-wait.ts). Read under the stop hook's own
//     preconditions (`isPendingDecisionStop`): the Current Stage row `[-]` unless a
//     team unit-major directive; a stage running ahead of Current Stage read in attempt
//     mode first. Under autonomous Construction 2.11.4 still waits on it
//     (`decisionWaitsOnPerson`) unless the driver is unattended (`AIDLC_UNATTENDED=1`)
//     and the block carries no `Checkpoint`. The driver's environment is not recorded,
//     so a plain decision there is counted and says so (`unlessUnattended`).
//   - COMPOSE: the composer's approve/edit/reject gate is, since 2.11.4, a current
//     marker of kind `ask` with `ask_type: "compose"` (`composeGateOpen`) — an ENGINE
//     ASK above. The `aidlc/.aidlc-compose-pending` file 2.11.0 read is retired (the
//     2.11.4 doctor names it a leftover nobody reads), so it is not read here either.
//   - TURN ENDED: `.aidlc-engine/turn-end` newer than `human-turn` (`turnEndIsOpen`,
//     2.11): the engine's last word was a question or a print the agent stops after.
//     Shown, not counted — it says the next message is the person's, not that a
//     question is owed; the question, when there is one, is the engine ask above.
//   - HOOKS: the newest hook heartbeat against the newest STAGE_/GATE_ row
//     (`hookLiveness`): more than five minutes behind is stale, none at all is never
//     fired. 2.11 refuses a plan approval in that state, so it is said next to the
//     asks, not counted among them.
//
// Read-only, never throws.

import { type AuditEvent, type AuditLedger, type UntimedBlock, isReplyTurn } from "../scan/audit";
import type { ClaimFilter } from "../scan/claim-attempt";
import { type OpenDecision, openDecision, openDecisionInAttempt } from "../scan/decision-wait";
import { pendingGate } from "../scan/gate-wait";
import type { AidlcState } from "../scan/parser";
import type { QuestionsReport } from "../scan/questions";
import type { DirectiveMarker, MarkerMiss, RunPosition } from "../scan/run-position";
import type { StageIndex } from "../scan/stage-jump";
import { unitGateStatus } from "../scan/team-gate";
import type { Blocker } from "./types";

export interface Waits {
  position: RunPosition;
  /** The Current Stage's gate is open (row `[?]`); `since` from the audit when it says. */
  gate?: { stage: string; since?: string };
  /**
   * An open gate — the stage's `[?]`, or a team unit's — the person has replied to since
   * it was shown (2.11.4 `repliedToGate`): the agent's move to record the choice. Shown,
   * not counted; `gate`/`teamGate` are then absent.
   */
  gateReplied?: { stage: string; unit?: string };
  /** The Current Stage row is `[R]`. */
  revising?: string;
  parked?: { stage: string; since: string; byPerson: boolean };
  unitPaused?: { unit: string; stage?: string; reason: string; nextAction: string };
  /**
   * At stage level, the unit cache the state still carries. The engine writes none in
   * this mode and asks about none, so it is shown as a leftover and never counted.
   */
  unitCacheLeftover?: { unit: string; stage?: string; paused: boolean };
  /** `askType` absent = a marker that carried none (2.11 always writes one). */
  /**
   * `unlessUnattended` on a compose ask under autonomous Construction: the stop hook lets
   * the turn end on it when the driver is unattended (`isPendingComposeStop`), which no
   * file records — the plain decision's hedge.
   */
  engineAsk?: { askType?: string; stage: string; unit?: string; unlessUnattended?: true };
  /** `aidlc/.aidlc-unit-parked` exists in this checkout — applicability unchecked. */
  checkoutPark: boolean;
  /**
   * Team ownership: the active unit's own gate (`unitGateStatus`), as the stop hook reads it
   * before the state row — only an open (`awaiting-approval`) or `revising` one is carried.
   * `scopeVerified` as on `decision`: the stage and unit came from a current marker.
   */
  teamGate?: {
    stage: string;
    unit: string;
    status: "awaiting-approval" | "revising";
    scopeVerified: boolean;
  };
  /** Team ownership with a unit position whose gate this reader could not decide. */
  teamGateUnread: boolean;
  /** Which unit and stage that undecided gate is — beside a stage-level leftover, it must say. */
  teamGateUnreadAt?: { stage: string; unit: string; scopeVerified: boolean };
  /**
   * The stop-hook record names the state it blocked on (the signature's digest) and that
   * state is not the current one — the count is history, whatever its size.
   */
  guardRecordStale: boolean;
  /** Record-relative paths — see ENGINE-ONLY BLANK above. */
  engineOnly: string[];
  /** `Construction Autonomy Mode: autonomous` — the stop hook's cap and rules differ. */
  autonomous: boolean;
  /**
   * `unlessUnattended`: autonomous Construction and no `Checkpoint` on the block — the
   * engine waits on it unless the driver set `AIDLC_UNATTENDED=1`, which no file records.
   */
  decision?: OpenDecision & { unlessUnattended?: true };
  turnEnded: boolean;
  hooks: HookLiveness;
}

/** `hookLiveness`, reduced to the verdict and the two times it compares. */
export type HookLiveness =
  | { state: "live" | "unknown" }
  | { state: "stale"; heartbeat: string; event: string }
  | { state: "never"; event: string };

export interface WaitsInput {
  state: AidlcState;
  position: RunPosition;
  /**
   * Under team ownership (`isTeamUnitOwnership`): the checkout's claim filter and the gate
   * scope `effectiveUnitGateRhythm` gives (`unknown` when the stamp's applicability cannot
   * be read). Absent outside team ownership.
   */
  teamGate?: {
    claim: ClaimFilter;
    scope: "per-stage" | "unit-end" | "unknown";
    /** The applicable scope stamp's unit: the router walks `[stamp.unit]`, not the roster. */
    stampUnit?: string;
  };
  marker: { marker: DirectiveMarker } | { miss: MarkerMiss };
  events: AuditEvent[];
  questions: QuestionsReport;
  /** The blocker list, already classified current/earlier — for the plan-approval dedup. */
  blockers: Blocker[];
  checkoutParkFile: boolean;
  /** The block-count signature, and the digest of the current state. */
  guard?: { signature: string; stateDigest: string };
  /** Every `*.last` file, as `hookLiveness` reads them (scan/hooks-health.ts). */
  hookHeartbeats: { present: boolean; stamps: string[] };
  /** mtimes (ms) of the engine's turn markers, when present. */
  marks: { turnEnd?: number; humanTurn?: number };
  /** The read clock, ISO. */
  now: string;
  /** Catalogue stage order, for `stageJumpReaches`. */
  stageIndex?: StageIndex;
  /**
   * A LISTED shard file was refused or could not be read (`AuditLedger.refusedShards` /
   * `unread`). The engine's presence reader fails closed on one (`humanTurnState`), so a
   * replied gate is never claimed. A refused audit DIRECTORY is not in that list: the
   * engine's `auditShards` leaves a refused dir out of the listing, and a vanished shard is
   * skipped. Built by `ledgerWaitInputs`.
   */
  auditIncomplete?: boolean;
  /** Blocks with an Event and no Timestamp (`AuditLedger.untimed`), for the gate's showing. */
  untimed?: readonly UntimedBlock[];
  /** `AuditLedger.copyGroups`: files that are one clone's record, read once between them. */
  copyGroups?: readonly (readonly string[])[];
  /**
   * The plan runs per-unit stages at stage level (scan/unit-artifact-mode.ts): there is
   * no unit to pause, gate or scope a decision by.
   */
  stageLevel?: boolean;
}

/** The engine's `PLAN_APPROVAL_CHECKPOINT` (aidlc-testing-posture.ts), matched exactly. */
const PLAN_APPROVAL_CHECKPOINT = "Code Generation Plan Approval";
/** The engine's `HOOK_HEARTBEAT_STALE_SLACK_MS`. */
const HOOK_STALE_MS = 5 * 60 * 1000;

/**
 * Rows that spend the person's reply — the engine's `MESSAGE_SPENDING_EVENTS`
 * (aidlc-lib.ts, 2.11.4). `REQUEST_ROUTED` is read because `humanRepliedSinceGate`
 * asks with `replies: true`; `AUTONOMY_MODE_SET` spends it only when it grants autonomy.
 */
const REPLY_SPENT = new Set([
  "GATE_APPROVED",
  "GATE_REJECTED",
  "PLAN_APPROVAL_RECORDED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "VERIFICATION_COMMAND_RECORDED",
  "CONSTRUCTION_POLICY_RECORDED",
  "QUESTION_UNANSWERED",
  "REQUEST_ROUTED",
]);
/** `GATE_WORDS_LIFECYCLE_EVENTS`: the latest of these for the gate must be its showing. */
const GATE_LIFECYCLE = new Set([
  "STAGE_STARTED",
  "STAGE_AWAITING_APPROVAL",
  "STAGE_REVISING",
  "STAGE_COMPLETED",
  "STAGE_SKIPPED",
  "GATE_APPROVED",
  "GATE_REJECTED",
]);
/** `GATE_WORDS_ANSWERED_BY`: a row answering another engine question takes the turns before it. */
const GATE_WORDS_ANSWERED_BY = new Set([
  "GATE_APPROVED",
  "GATE_REJECTED",
  "QUESTION_ANSWERED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "VERIFICATION_COMMAND_RECORDED",
  "CONSTRUCTION_POLICY_RECORDED",
  "PLAN_APPROVAL_RECORDED",
  "AUTONOMY_MODE_SET",
  "REQUEST_ROUTED",
]);

/** Same-shard append order: `pos` when parsed, else the merged ledger's order. */
function appendedBefore(events: AuditEvent[], a: number, b: number): boolean {
  const pa = events[a]?.pos;
  const pb = events[b]?.pos;
  return pa !== undefined && pb !== undefined ? pa < pb : a < b;
}

/**
 * `humanRepliedSinceGate` = `humanTurnState(…, { replies: true }) === "acted"`, over every
 * shard: the latest reply turn is later than the latest row that spent a reply. At equal
 * seconds a turn wins only over resolutions in its own shard appended before it — a
 * cross-shard tie is unordered and consumes the turn, as the engine reads it.
 */
function humanRepliedSinceGate(events: AuditEvent[]): boolean {
  const humans: number[] = [];
  const spent: number[] = [];
  events.forEach((e, i) => {
    if (isReplyTurn(e)) humans.push(i);
    else if (
      REPLY_SPENT.has(e.event) ||
      (e.event === "AUTONOMY_MODE_SET" && e.fields.Mode === "autonomous")
    )
      spent.push(i);
  });
  if (humans.length === 0) return false;
  if (spent.length === 0) return true;
  const latest = (xs: number[]) => xs.reduce((m, i) => (events[i]!.ts > m ? events[i]!.ts : m), "");
  const h = latest(humans);
  const r = latest(spent);
  if (h !== r) return h > r;
  const lastH = humans.filter((i) => events[i]!.ts === h);
  const lastR = spent.filter((i) => events[i]!.ts === r);
  return lastH.some((hi) =>
    lastR.every((ri) => events[ri]!.shard === events[hi]!.shard && appendedBefore(events, ri, hi)),
  );
}

/**
 * `personRepliedSincePresentation`: on the clone's own shard, a reply turn after the
 * gate's latest showing (`gatePresentationStart`, `answeredBy`) — a later lifecycle row
 * for the gate unsets it, and a row answering another engine question after it moves the
 * start past the turns before it. The engine reads ITS OWN clone's shard; a committed
 * tree has no own clone, so the shard that wrote the latest showing stands in for it —
 * that clone is the one the person was answering in. This reader's choice, not a
 * transcription.
 *
 * The engine walks that shard's RAW blocks; this reader has its parsed rows, which differ
 * in two ways, and where they could differ it claims nothing (the gate stays counted, as
 * before 2.11.4 was read) — also this reader's choice:
 *   - the shard is one of a copy group (`copyGroups`, a claimed unit's local record and
 *     its tracked shard included): a row both files hold is read once, from either, so a
 *     lifecycle row that reset the showing in this file may have been read from the other;
 *   - a block with an Event and no Timestamp (`untimed`, not an event here) lies after the
 *     showing in that shard: it may be a lifecycle row that reset it.
 * The opposite case is not claimed either: an untimed reply turn or showing, which the
 * engine would read as replied, leaves the gate counted.
 */
function personRepliedSincePresentation(
  events: AuditEvent[],
  gate: { stage: string; unit?: string },
  untimed: readonly UntimedBlock[] = [],
  copyGroups: readonly (readonly string[])[] = [],
): boolean {
  const matches = (e: AuditEvent) =>
    GATE_LIFECYCLE.has(e.event) &&
    e.fields.Stage === gate.stage &&
    (gate.unit === undefined || e.fields.Unit === gate.unit);
  let shown: AuditEvent | undefined;
  for (const e of events) {
    if (matches(e) && e.event === "STAGE_AWAITING_APPROVAL" && e.fields.Recovered !== "true")
      shown = e;
  }
  if (shown === undefined) return false;
  const shard = shown.shard;
  if (copyGroups.some((group) => group.includes(shard))) return false;
  if (untimed.some((u) => u.shard === shard && (shown.pos === undefined || u.pos > shown.pos)))
    return false;
  const own = events
    .map((e, i) => ({ e, i }))
    .filter((x) => x.e.shard === shard)
    .sort((a, b) => (appendedBefore(events, a.i, b.i) ? -1 : 1));
  let from: number | null = null;
  own.forEach(({ e }, k) => {
    if (matches(e)) {
      from = e.event === "STAGE_AWAITING_APPROVAL" && e.fields.Recovered !== "true" ? k : null;
    } else if (from !== null && GATE_WORDS_ANSWERED_BY.has(e.event)) {
      from = k;
    }
  });
  if (from === null) return false;
  return own.slice(from).some(({ e }) => isReplyTurn(e));
}

/** `repliedToGate`: the person replied to the open gate — the agent's move now. */
function repliedToGate(
  w: Pick<WaitsInput, "events" | "auditIncomplete" | "untimed" | "copyGroups">,
  gate: { stage: string; unit?: string },
): boolean {
  if (w.auditIncomplete) return false;
  return (
    humanRepliedSinceGate(w.events) &&
    personRepliedSincePresentation(w.events, gate, w.untimed, w.copyGroups)
  );
}

/** The ledger fields the waits read, mapped once (assemble and the tests share it). */
export function ledgerWaitInputs(
  ledger: Pick<AuditLedger, "events" | "refusedShards" | "unread" | "untimed" | "copyGroups">,
): Pick<WaitsInput, "events" | "auditIncomplete" | "untimed" | "copyGroups"> {
  return {
    events: ledger.events,
    auditIncomplete: (ledger.refusedShards?.length ?? 0) > 0 || (ledger.unread?.length ?? 0) > 0,
    untimed: ledger.untimed ?? [],
    copyGroups: ledger.copyGroups ?? [],
  };
}

function hookLiveness(
  heartbeats: { present: boolean; stamps: string[] },
  events: AuditEvent[],
): HookLiveness {
  const newest = (xs: string[]) =>
    xs.reduce<string | undefined>(
      (m, x) => (m === undefined || Date.parse(x) > Date.parse(m) ? x : m),
      undefined,
    );
  const event = newest(
    events
      .filter(
        (e) =>
          (e.event.startsWith("STAGE_") || e.event.startsWith("GATE_")) &&
          Number.isFinite(Date.parse(e.ts)),
      )
      .map((e) => e.ts),
  );
  if (!event) return { state: "unknown" };
  // The engine's `neverFired`: no `.last` file at all — an empty one still counts.
  if (!heartbeats.present) return { state: "never", event };
  const heartbeat = newest(heartbeats.stamps);
  if (!heartbeat) return { state: "unknown" };
  return Date.parse(event) - Date.parse(heartbeat) > HOOK_STALE_MS
    ? { state: "stale", heartbeat, event }
    : { state: "live" };
}

function rowStatuses(state: AidlcState, slug: string): string[] {
  return state.phases.flatMap((p) => p.stages.filter((s) => s.slug === slug).map((s) => s.status));
}

/** Is this questions file one of the active stage's own — the dir the stop hook reads? */
function inActiveDir(rel: string, stage: string, unit: string | undefined): boolean {
  const parts = rel.split("/");
  if (unit)
    return (
      parts.length === 4 && parts[0] === "construction" && parts[1] === unit && parts[2] === stage
    );
  return parts.length === 3 && parts[1] === stage;
}

export function buildWaits(w: WaitsInput): Waits {
  const { state, position } = w;
  const rt = state.runtime;
  const current =
    state.currentStage && state.currentStage !== "none" ? state.currentStage : undefined;
  // The engine reads the FIRST row of the Current Stage's slug (`parseCheckboxes(…)
  // .find`), so a later `[-]` row of the same slug does not make it in progress.
  const row = current ? rowStatuses(state, current)[0] : undefined;
  const autonomous = rt.autonomyMode === "autonomous";
  const marker = "marker" in w.marker ? w.marker.marker : undefined;

  let gateReplied: Waits["gateReplied"];
  const gateOpen = current !== undefined && row === "awaiting";
  if (gateOpen && repliedToGate(w, { stage: current })) gateReplied = { stage: current };
  let gate =
    gateOpen && !gateReplied
      ? { stage: current, since: pendingGate(w.events, current)?.since }
      : undefined;
  const revising = current && row === "revising" ? current : undefined;

  const parkedHere = rt.parked !== "" && rt.parkedAtStage !== "" && rt.parkedAtStage === current;
  const parked = parkedHere
    ? { stage: rt.parkedAtStage, since: rt.parked, byPerson: rt.parkedBy === "person" }
    : marker?.kind === "parked"
      ? { stage: marker.stage, since: "", byPerson: false }
      : undefined;

  const stageLevel = w.stageLevel === true;
  const unitPaused =
    !stageLevel && rt.unitState === "paused" && rt.activeUnit
      ? {
          unit: rt.activeUnit,
          stage: rt.unitStage || undefined,
          reason: rt.unitPauseReason,
          nextAction: rt.unitNextAction,
        }
      : undefined;

  // A plan-approval ask also writes the questions file the blocker list reads — so a
  // file holding the section, answered or not, is that ask; only one with no file is
  // the marker's alone.
  const planInFile = (stage: string, unit?: string) =>
    w.questions.files.some(
      (f) =>
        f.stage === stage &&
        f.unit === unit &&
        f.questions.some((q) => q.kind === "confirmation" && /plan approval/i.test(q.heading)),
    );
  const unitCacheLeftover =
    stageLevel && rt.activeUnit
      ? {
          unit: rt.activeUnit,
          ...(rt.unitStage ? { stage: rt.unitStage } : {}),
          paused: rt.unitState === "paused",
        }
      : undefined;

  const answered =
    (marker?.askType === "plan-approval" && planInFile(marker.stage, marker.unit)) ||
    (marker?.askType === "guard-recovery" && marker.guardRecovery === "ready") ||
    // The same paused unit is already its own row.
    (marker?.askType === "unit-paused" && unitPaused?.unit === marker.unit);
  const engineAsk =
    marker?.kind === "ask" && !answered
      ? {
          askType: marker.askType,
          stage: marker.stage,
          unit: marker.unit,
          ...(marker.askType === "compose" && autonomous
            ? { unlessUnattended: true as const }
            : {}),
        }
      : undefined;

  // The stop hook reads the active stage's own files only while its row is `[-]` (a
  // team unit-major directive skips that check), and under autonomy only a pending
  // plan approval — which the blocker list reads already.
  const team = state.unitOwnership === "team";
  const teamUnitMajor = team && state.constructionIteration === "unit-major" && !!position.unit;
  const engineOnly =
    position.stage && !autonomous && (teamUnitMajor || row === "active")
      ? w.questions.files
          .filter(
            (f) =>
              f.rawBlank &&
              f.unanswered.length === 0 &&
              inActiveDir(f.rel, position.stage ?? "", position.unit),
          )
          .map((f) => f.rel)
      : [];

  // The 2.11 signature is `<stage>::<state digest>::<directive fingerprint>`; one in any
  // other shape carries no digest to compare, so it is not dated this way.
  const sigDigest = w.guard?.signature.split("::")[1];
  const guardRecordStale =
    !!w.guard &&
    !!sigDigest &&
    /^[0-9a-f]{64}$/.test(sigDigest) &&
    sigDigest !== w.guard.stateDigest;

  // Open decision, under `isPendingDecisionStop`'s own preconditions. The hook's
  // `activeStage`/`activeUnit` come from its own fresh `next` probe, and the nearest
  // record of that is a current directive marker; the unit cache is a mirror the
  // engine keeps for cheap status reads, so a decision scoped by it alone is said to be
  // unconfirmed rather than claimed as the hook's.
  // At stage level too: the hook's `directive.unit ?? activeMarker.unit` lets a stage-level
  // probe's null unit fall through to the marker's, so the marker scopes the decision as
  // it does per unit. The unit cache is what stage level drops, and it reaches here only
  // through `position` (scan/run-position.ts).
  const scope = marker
    ? { stage: marker.stage, unit: marker.unit }
    : { stage: position.stage, unit: position.unit };
  const scopeVerified = !!marker || (position.basis === "current-stage" && position.verified);
  const teamScope = team && state.constructionIteration === "unit-major" && !!scope.unit;
  let decision: Waits["decision"];
  if (teamScope && scope.stage) {
    decision = openDecisionInAttempt(w.events, scope.stage, scope.unit, w.stageIndex);
  } else if (current && row === "active") {
    const ahead = scope.stage;
    if (ahead && ahead !== current)
      decision = openDecisionInAttempt(w.events, ahead, undefined, w.stageIndex);
    decision ??= openDecision(w.events, current);
  }
  // A plan approval asked through a decision (the legacy picker path, one unit or a
  // batch) also has its section in each unit's file. It is the same interaction only
  // where that section is a blank ask ALREADY COUNTED as current — a file of another
  // unit, or one only listed as an earlier leftover, is not a duplicate of it.
  if (decision && decision.checkpoint === PLAN_APPROVAL_CHECKPOINT) {
    const units = decision.unit ? [decision.unit] : (decision.units ?? []);
    const counted = w.blockers.some(
      (b) =>
        b.isCurrentStage &&
        b.stage === decision?.stage &&
        b.kind === "confirmation" &&
        /plan approval/i.test(b.heading) &&
        (units.length === 0
          ? b.unit === undefined
          : b.unit !== undefined && units.includes(b.unit)),
    );
    if (counted) decision = undefined;
  }
  if (decision)
    decision = {
      ...decision,
      scopeVerified,
      ...(autonomous && decision.checkpoint === undefined
        ? { unlessUnattended: true as const }
        : {}),
    };

  // Team unit gate, as `isHumanWaitStop` reads it first: the active stage and unit, at the
  // effective gate scope. Its `activeStage`/`activeUnit` are the hook's own probe
  // (`directive.unit ?? marker.unit`), so the scope follows the decision's — a current
  // marker, else the unit cache, unconfirmed. At stage level `position` already holds no
  // cached unit (the router returns before team unit routing, so only a marker names one).
  // A cache unit off the resolved roster is not where the engine is — unless an applicable
  // scope stamp names it, since the team router then walks `[stamp.unit]` instead of the
  // roster (`emitTeamUnitMajorRunStage`); an unreadable roster stops that walk too.
  const cacheOffRoster =
    !marker &&
    (position.offRoster === "unknown" ||
      (position.offRoster === "absent" && w.teamGate?.stampUnit !== position.unit));
  let teamGate: Waits["teamGate"];
  let teamGateUnread = false;
  let teamGateUnreadAt: Waits["teamGateUnreadAt"];
  if (w.teamGate && scope.stage && scope.unit && !cacheOffRoster) {
    const status =
      w.teamGate.scope === "unknown"
        ? "unknown"
        : unitGateStatus(
            w.events,
            scope.stage,
            scope.unit,
            w.teamGate.scope,
            w.teamGate.claim,
            w.stageIndex,
          );
    if (status === "unknown") {
      teamGateUnread = true;
      teamGateUnreadAt = { stage: scope.stage, unit: scope.unit, scopeVerified };
    } else if (
      status === "awaiting-approval" &&
      repliedToGate(w, { stage: scope.stage, unit: scope.unit })
    ) {
      // The engine returns here without reading the state row (`isHumanWaitStop`).
      gateReplied = { stage: scope.stage, unit: scope.unit };
      gate = undefined;
    } else if (status === "awaiting-approval" || status === "revising") {
      teamGate = { stage: scope.stage, unit: scope.unit, status, scopeVerified };
    }
  }

  const turnEnded =
    w.marks.turnEnd !== undefined &&
    w.marks.humanTurn !== undefined &&
    w.marks.turnEnd > w.marks.humanTurn;

  return {
    position,
    decision,
    turnEnded,
    hooks: hookLiveness(w.hookHeartbeats, w.events),
    gate,
    ...(gateReplied ? { gateReplied } : {}),
    revising,
    parked,
    unitPaused,
    ...(unitCacheLeftover ? { unitCacheLeftover } : {}),
    engineAsk,
    engineOnly,
    autonomous,
    checkoutPark: w.checkoutParkFile && !parked,
    teamGate,
    teamGateUnread,
    ...(teamGateUnreadAt ? { teamGateUnreadAt } : {}),
    guardRecordStale,
  };
}
