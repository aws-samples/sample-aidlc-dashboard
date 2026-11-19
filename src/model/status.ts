// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The status strip: one line at the top of the page that answers "is this run
// moving, and is anything wrong?" without the reader opening a panel.
//
// Nothing here is new data. Every chip is a reading of a field the model already
// carries — state.md for the run, the stop hook's block-count for "stuck", the
// blockers for "waiting on you", the audit's sensor roll-up for checks — so no new
// SourceKind is minted. What this module adds is the READING, and three rules keep
// that reading honest:
//
//   1. There is no combined "all good" verdict. Four signals from four sources with
//      four freshnesses do not average into one word; each chip states its own.
//   2. A chip is only green when its signal was READ and is off. A source that is
//      missing reads as "no record" (muted), never as healthy — a run whose stop
//      hook never wrote block-count.json has not been shown to be unstuck.
//   3. No thresholds are invented — and the one the stuck chip uses is the engine's.
//      The stop hook (aidlc-continue-workflow.ts) writes `count` 1 on the first block
//      after progress (a changed signature), adds one per block with no progress,
//      resets to 0 only on done/notice/parked/handoff, and RELEASES the turn once the
//      count reaches its cap: 8 under autonomous Construction, 2 otherwise, unless
//      `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` overrides it — which a file on disk cannot
//      show, so the reading says which default it assumed. 1 is a nudge, not "stuck".
//
// A completed run shows the run chip alone: a past block or a past failed check is
// history, not a problem with the run. The one exception is an ask left unanswered,
// which stays reachable as a loose end (see buildStatus).

import type { Blocker, DashboardModel } from "./types";
import type { Waits } from "./waits";

export type RunReading =
  | { state: "complete" }
  | { state: "unknown" }
  | {
      state: "running";
      stageDisplay: string;
      /** The unit the run is on, when the position names one. */
      unit?: string;
      /** False when the position fell back to a `Current Stage` that can lag. */
      verified: boolean;
      /** Age of the newest audit event — how long since the run last wrote anything. */
      lastEventAgeSec?: number;
    };

export type StuckReading =
  /** No block-count.json: the guard never recorded a block on this clone. */
  | { state: "no-record" }
  /** count 0 — the guard saw progress since its last block. */
  | { state: "clear" }
  /**
   * The recorded block belongs to an earlier stage. The file is only rewritten on a
   * block and its signature starts with the stage, so a signature naming a stage the
   * run has left means no block has happened since the move.
   */
  | { state: "earlier-stage"; stage: string }
  /**
   * The record names a state digest that is not the current state's. The hook writes 1
   * on its next block after any change, so no block has happened since — history.
   */
  | { state: "state-changed"; stage: string }
  /** count 1 — the hook pushed once since the last progress. Normal operation. */
  | { state: "nudged"; stage: string; cap: number }
  /** 2 ≤ count < cap — blocked again with no progress in between. */
  | { state: "blocked"; count: number; stage: string; cap: number }
  /** count ≥ cap — the hook gave up and let the turn end. */
  | { state: "released"; count: number; stage: string; cap: number };

export interface HumanReading {
  /** Unanswered asks in the stage the engine is on — the ones stopping the run. */
  current: number;
  /** Longest wait among `current`, in seconds. */
  oldestWaitingSec?: number;
  /** Stage whose gate is open and awaiting approval, from the audit. */
  awaitingGate?: string;
  /** Unanswered asks parked in earlier stages — loose ends, not the reason it stopped. */
  earlier: number;
  /** The run's other holds, read from the engine's own records — see model/waits.ts. */
  waits?: Waits;
  /**
   * Questions paths that exist and could not be read (scan/record-read.ts). Absent when
   * none. While set, no count here is complete in EITHER direction: a blank answer in
   * them is missing, and a plan-approval marker the file would have explained is not
   * deduplicated against it (model/waits.ts `planInFile`) — so "nothing awaiting you"
   * cannot be said, and the count is not a floor either.
   */
  unread?: number;
}

/**
 * How many holds are waiting on the person — the ONE count the answers tab, the status
 * banner and the tab title all print, so the three can never disagree.
 *
 * An open gate is usually answered IN the current-stage questions file, so adding it to
 * their count would report one approval twice: it counts on its own only when no current
 * ask carries it. A park, a paused unit, an engine ask (compose included) and an open
 * decision each hold the run on their own and count once each; a replied gate, revising, engine-only,
 * turn-ended, hook and autonomy rows are shown, not counted (see model/waits.ts). An open
 * team unit gate counts like the stage gate — it is the same approval, held per unit
 * instead of on the state row.
 *
 * `incomplete`: a questions file that exists and could not be read makes the count
 * incomplete either way — it can miss a blank answer, and it can count a plan-approval
 * marker the file would have explained — so it is neither a green zero nor a floor.
 */
export interface HumanTally {
  open: number;
  incomplete: boolean;
}

export function humanTally(h: HumanReading | undefined): HumanTally {
  const w = h?.waits;
  const current = h?.current ?? 0;
  const holds =
    (w?.parked ? 1 : 0) + (w?.unitPaused ? 1 : 0) + (w?.engineAsk ? 1 : 0) + (w?.decision ? 1 : 0);
  const gateOpen = !!h?.awaitingGate || w?.teamGate?.status === "awaiting-approval";
  return {
    open: (current > 0 ? current : gateOpen ? 1 : 0) + holds,
    incomplete: (h?.unread ?? 0) > 0,
  };
}

/**
 * The holds `humanTally` counts, one entry each, in the order the page names them: the
 * run's own stops first (a park or a paused unit holds the run whatever else is open),
 * then the current-stage asks (each carries a file the reader can open), then the gate,
 * the audit-opened decision and the engine's own ask.
 *
 * Built by the SAME rules as the tally — a gate counts only when no current ask carries
 * it, and the stage gate and a team unit gate are one approval — so `length` always
 * equals `humanTally(...).open` (pinned in status.test.ts). A list that could disagree
 * with the count printed beside it would be the defect this function exists to prevent.
 */
export type Hold =
  | { kind: "parked"; stage: string; since: string; byPerson: boolean }
  | { kind: "unit-paused"; unit: string; stage?: string; reason: string; nextAction: string }
  | { kind: "ask"; blocker: Blocker }
  | { kind: "gate"; stage: string; since?: string }
  | { kind: "team-gate"; unit: string; stage: string }
  | { kind: "decision"; decision: NonNullable<Waits["decision"]> }
  | {
      kind: "engine-ask";
      askType?: string;
      stage: string;
      unit?: string;
      unlessUnattended?: true;
    };

export function humanHolds(m: StatusInput): Hold[] {
  if (m.state.complete) return [];
  const w = m.waits;
  const out: Hold[] = [];
  if (w.parked) out.push({ kind: "parked", ...w.parked });
  if (w.unitPaused) out.push({ kind: "unit-paused", ...w.unitPaused });
  const current = m.blockers.filter((b) => b.isCurrentStage);
  for (const blocker of current) out.push({ kind: "ask", blocker });
  if (current.length === 0) {
    if (w.gate) out.push({ kind: "gate", stage: w.gate.stage, since: w.gate.since });
    else if (w.teamGate?.status === "awaiting-approval") {
      out.push({ kind: "team-gate", unit: w.teamGate.unit, stage: w.teamGate.stage });
    }
  }
  if (w.decision) out.push({ kind: "decision", decision: w.decision });
  if (w.engineAsk) out.push({ kind: "engine-ask", ...w.engineAsk });
  return out;
}

export type ChecksReading =
  /** No sensor firing recorded for the current stage. */
  | { state: "none" }
  | { state: "in-flight"; pending: number; failed: number; passed: number }
  /**
   * At least one failure in this stage that no later verified pass of the same output
   * retired (`SensorFailure.supersededAt`). Still "failures recorded", not "failing
   * now": the engine re-fires sensors live at the gate, which no record shows ahead.
   */
  | { state: "failed"; failed: number; passed: number }
  /**
   * No standing failure, but no verified result either: a pass carrying a `Note`, or a
   * budget override, that no later verified pass answered. A blocking gate refuses both.
   */
  | { state: "unverified"; unverified: number; passed: number }
  | { state: "passed"; passed: number };

export interface StatusStrip {
  run: RunReading;
  /** Absent when the run is complete. */
  stuck?: StuckReading;
  /** On a complete run, present only when asks are left unanswered. */
  human?: HumanReading;
  /** Absent when the run is complete. */
  checks?: ChecksReading;
}

type StatusInput = Pick<
  DashboardModel,
  "state" | "health" | "blockers" | "sensors" | "timing" | "provenance" | "waits" | "questions"
>;

/** The stop hook's default cap — see rule 3 in the header. */
export function defaultStopCap(autonomous: boolean): number {
  return autonomous ? 8 : 2;
}

/**
 * The stage part of a stop-guard signature — everything before the FIRST `::`.
 * The 2.11 shape is `<Current Stage>::<state sha256>::<directive fingerprint>`
 * (`hooks/aidlc-continue-workflow.ts`); cutting at the LAST `::` read it as the stage
 * `<stage>::<sha>`, which never equals the current stage, so a run blocked right now
 * drew as a green "cleared, last block in an earlier stage". A stage slug never
 * contains `::`, so the first separator is the stage.
 */
function signatureStage(signature: string): string {
  const cut = signature.indexOf("::");
  return cut < 0 ? signature : signature.slice(0, cut);
}

function readStuck(m: StatusInput): StuckReading {
  const guard = m.health.stopGuard;
  if (!guard) return { state: "no-record" };
  if (guard.count === 0) return { state: "clear" };
  const stage = signatureStage(guard.signature);
  const current = m.state.currentStage;
  if (current && stage && stage !== current) return { state: "earlier-stage", stage };
  if (m.waits.guardRecordStale) return { state: "state-changed", stage };
  const cap = defaultStopCap(m.waits.autonomous);
  if (guard.count >= cap) return { state: "released", count: guard.count, stage, cap };
  if (guard.count === 1) return { state: "nudged", stage, cap };
  return { state: "blocked", count: guard.count, stage, cap };
}

function readHuman(m: StatusInput): HumanReading {
  const current = m.blockers.filter((b) => b.isCurrentStage);
  const waits = current
    .map((b) => b.waitingSec)
    .filter((w): w is number => w !== undefined && Number.isFinite(w));
  const unread = m.questions.unreadable.length;
  return {
    current: current.length,
    oldestWaitingSec: waits.length > 0 ? Math.max(...waits) : undefined,
    awaitingGate: m.waits.gate?.stage,
    earlier: m.blockers.length - current.length,
    waits: m.waits,
    ...(unread > 0 ? { unread } : {}),
  };
}

function readChecks(m: StatusInput): ChecksReading {
  const stage = m.state.currentStage;
  const row = stage ? m.sensors.stages.find((s) => s.stage === stage) : undefined;
  if (!row || row.fired === 0) return { state: "none" };
  const failed = row.failed - row.superseded;
  if (row.pending > 0) {
    return { state: "in-flight", pending: row.pending, failed, passed: row.passed };
  }
  if (failed > 0) return { state: "failed", failed, passed: row.passed };
  if (row.unverifiedStanding > 0) {
    return { state: "unverified", unverified: row.unverifiedStanding, passed: row.passed };
  }
  return { state: "passed", passed: row.passed };
}

export function buildStatus(m: StatusInput): StatusStrip {
  if (m.state.complete) {
    // Blocks and failed checks on a finished run are history. An unanswered ask is
    // not: it is a loose end the run left behind, and since the asks list lives under
    // this chip, dropping the chip would leave it unreachable. It is reported as
    // parked — nothing is waiting on it for the run to proceed.
    // A questions file that could not be read is the same kind of loose end: an
    // answer left blank in it would be listed here if it could be read.
    const unread = m.questions.unreadable.length;
    if (m.blockers.length === 0 && unread === 0) return { run: { state: "complete" } };
    return {
      run: { state: "complete" },
      human: { current: 0, earlier: m.blockers.length, ...(unread > 0 ? { unread } : {}) },
    };
  }
  const pos = m.waits.position;
  // The position's stage, not Current Stage, when the engine's own records name a
  // later one (unit-major) — and its display name only when it IS the Current Stage.
  const stage = pos.stage ?? m.state.currentStage;
  const run: RunReading = stage
    ? {
        state: "running",
        stageDisplay: stage === m.state.currentStage ? m.state.currentStageDisplay || stage : stage,
        unit: pos.unit,
        verified: pos.verified,
        lastEventAgeSec: m.provenance.audit.ageSec,
      }
    : { state: "unknown" };
  return { run, stuck: readStuck(m), human: readHuman(m), checks: readChecks(m) };
}
