// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The view-model the renderers consume, and the provenance record every panel
// carries.
//
// WHY PROVENANCE IS A FIRST-CLASS FIELD. The four sources this dashboard reads
// have genuinely different freshness, and mixing them without saying so produces
// confident wrong numbers:
//
//   disk         live at read time
//   audit        live, but only as live as the hooks that append to it
//   state.md     rewritten at each transition; carries its own Last Updated
//   runtime-graph recompiled ONLY at stage transitions — measured 19h behind the
//                audit on a real in-flight run, under-reporting 6 stages
//
// So a panel says where its numbers came from and how old they are, and a stale
// source is called stale on screen rather than quietly averaged in.

import type { TokenViewModel } from "../credit/claude/token-model";
import type { CreditViewModel } from "../credit/view/credit-model";
import type { AgentTier } from "../scan/agent-catalog";
import type { StageArtifact } from "../scan/artifacts";
import type { CheckpointProofNote } from "../scan/checkpoint-proofs";
import type { DeferralReport } from "../scan/deferrals";
import type { HealthReport } from "../scan/hooks-health";
import type { ConstructionMatrix } from "../scan/matrix";
import type { DiaryReport } from "../scan/memory-diary";
import type { AidlcState } from "../scan/parser";
import type { AskKind, QuestionsReport } from "../scan/questions";
import type { ReworkReport } from "../scan/rework";
import type { SensorReport } from "../scan/sensors";
import type { TimingReport } from "../scan/timing";
import type { UnitArtifactMode } from "../scan/unit-artifact-mode";
import type { ErrorReading } from "./errors";
import type { Waits } from "./waits";

/** Where a number came from. */
export type SourceKind =
  | "disk"
  | "audit"
  | "state.md"
  | "runtime-graph"
  | "hooks-health"
  | "stage-graph"
  /** The harness's agent definitions (`agents/*.md`, `agent-tiers.json`) — declared, not run. */
  | "agent-catalog";

/** Freshness of one source, resolved at assembly time. */
export interface Provenance {
  source: SourceKind;
  /** ISO timestamp the source last changed (embedded field preferred over mtime). */
  asOf?: string;
  /** Seconds between `asOf` and the assembly clock. Undefined when asOf is. */
  ageSec?: number;
  /** True when this source is known to lag another that corroborates it. */
  stale: boolean;
  /**
   * Why, as a CODE AND ITS FACTS. Only set when stale.
   *
   * A sentence here would be prose in the model, the same defect `Warning` records — and
   * it reaches `/api/model`, so a consumer had to substring-match a Korean paragraph to
   * learn that the graph was merely lagging. `render/i18n` says it; this names it.
   */
  staleReason?: StaleReason;
}

export type StaleReason =
  | { code: "graph-behind"; lagSec: number; sensorDrift?: { fired: number; missing: number } }
  | { code: "graph-unreadable" }
  | { code: "stage-graph-missing" };

/** Identity of the run being shown. */
export interface RunIdentity {
  /** Workspace root passed on the command line. */
  root: string;
  /** Active space name. */
  space: string;
  /** Intent record dir name. */
  record: string;
  /** Record-relative path of the state file, for display. */
  stateRel: string;
  /**
   * Absolute path of the intent record dir. NOT for display — this is the jail
   * the /open endpoint resolves artifact paths against, so a click can never
   * reach a file outside the record being shown.
   */
  recordDir: string;
  /**
   * Harness dir the stage catalogue was read from (".kiro" / ".claude" /
   * ".aidlc" / …), or undefined when none was found. Display-only: the dashboard
   * reads the `aidlc/` docs tree, which is the same on every harness, so this
   * says which engine install happens to sit beside it — not what is supported.
   */
  harnessDir?: string;
  /** Registry metadata for this intent, when intents.json listed it. */
  slug?: string;
  scope?: string;
  status?: string;
}

/** The unanswered-question blocker, lifted to the top of the model. */
export interface Blocker {
  /** Stage the question belongs to. */
  stage: string;
  /** Unit of work, for a per-unit Construction question. */
  unit?: string;
  /** Question heading, e.g. "Q1 — Plan Approval". */
  heading: string;
  /** `confirmation` for a gate heading with no `Q<n>` id, `loose` for a blank tag
   *  under no recognised heading — see scan/questions.ts. */
  kind: AskKind;
  /** A summary confirmation holding this many tags — the engine reads no answer from it. */
  invalidTags?: number;
  /** Record-relative path of the questions artifact. */
  rel: string;
  /** Which same-titled section of that file this is, past the first (scan/questions.ts). */
  occurrence?: number;
  /** When the artifact was last written — how long the ask has been open. */
  since: string;
  /** Seconds outstanding at assembly time. */
  waitingSec?: number;
  /** True when this question belongs to the stage the engine is currently on. */
  isCurrentStage: boolean;
}

/** Approval-gate ledger. */
export interface GateSummary {
  approved: number;
  rejected: number;
  /** `Revision Count` from state.md — rework the run absorbed. */
  revisionCount?: number;
  /** Stage sitting at an approval gate right now — the state row's `[?]` (model/waits.ts). */
  awaitingStage?: string;
  jumps: number;
}

/**
 * Which usage panel to show. `auto` resolves from the harness dir the workspace
 * carries; `kiro`/`claude` pin it.
 *
 * Why an override exists rather than harness detection alone: the two providers
 * measure different things (Kiro reports a remote quota, Claude Code reports
 * local token counts), and a dev tree can hold `.kiro` and `.claude` side by
 * side — in which case catalogue probe order, not the reader's intent, would pick
 * the panel. `auto` still does the obvious thing; the flag exists for the tree
 * where the obvious thing is ambiguous.
 */
export type UsageMode = "auto" | "kiro" | "claude";

/**
 * Reading language of the rendered page. Two values, because the audience splits
 * Korean / non-Korean and English serves the second as a lingua franca — this is
 * not a list of regional locales, and `ko-KR` vs `ko` is not a distinction anyone
 * reading this dashboard is making.
 *
 * It lives HERE, beside `UsageMode`, only because that is where this repo keeps the
 * closed unions the CLI parses. It is NOT part of `DashboardModel` and `assemble`
 * never sees it — see the header of `render/locale.ts` for why.
 */
export type Locale = "ko" | "en";

/**
 * A non-fatal reading problem, as a CODE AND ITS FACTS — never as a sentence.
 *
 * WHY THIS IS NOT A STRING. It was, and that put eleven Korean paragraphs inside
 * `assemble`, which is the same rule this repo already broke once and wrote down:
 * `byOwner` stood a missing stage up as `` `(${status})` ``, a display string built in
 * the scan layer, and it printed an English `(unassigned)` on a Korean screen. The fix
 * there was "the scan layer names nothing it does not read from the tree"; these
 * warnings were the 11 places still exempt from it.
 *
 * Three things follow, and only one of them is about translation:
 *
 *   - `/api/model` stops carrying prose. A consumer gets `code` + facts and can act on
 *     it; before, it got a paragraph in one language and had to substring-match.
 *   - The TESTS stop matching on copy. Fifteen assertions did
 *     `warnings.some(w => w.includes(<a Korean phrase>))`, so rewording a sentence broke
 *     the suite while a wrong CODE passed silently. They assert codes now.
 *   - And a second language becomes a table lookup rather than an edit to `assemble`.
 *
 * The union is closed and `render/warnings.ts` switches on it exhaustively, so adding a
 * member without giving it copy is a typecheck failure rather than a blank line on
 * screen.
 */
/** Where the engine refuses an unreadable unit DAG — see the `unit-dag-malformed` warning. */
export type UnitDagStop = "units-generation-gate" | "construction";

export type Warning =
  | { code: "catalog-read-failed"; harnessDir: string }
  | { code: "catalog-not-found" }
  | { code: "audit-empty" }
  /** Audit shards or a whole audit dir refused by the engine's rules — reached through
   *  a symlink or outside the workspace root, or not a regular file — and so not read;
   *  paths relative to the workspace root. Replaces `audit-empty`, which it explains. */
  | { code: "audit-shard-refused"; paths: string[] }
  /** Listed shards that exist and could not be read for another reason than a refusal
   *  (`AuditLedger.unread`), paths relative to the workspace root. With nothing read at
   *  all it, too, replaces `audit-empty`. */
  | { code: "audit-shard-unread"; paths: string[] }
  /** All three are REQUIRED: the harness version is read off the catalogue, so a
   *  mismatch can only be detected when the catalogue — and its dir — is in hand.
   *  `harnessDir?` let the sentence print `(undefined/tools/aidlc-lib.ts)`, which the
   *  copy test caught; the type says it cannot happen instead of a fallback hiding it. */
  | {
      code: "state-version-mismatch";
      stateVersion: string;
      harnessVersion: string;
      harnessDir: string;
    }
  /** `stateVersion` absent = the field was missing; present = it was there and unusable. */
  | { code: "state-version-unreadable"; stateVersion?: string }
  | { code: "team-without-unit-major"; constructionIteration?: string }
  | { code: "unit-progress-malformed" }
  /** The authored unit DAG the engine refuses (`resolveBoltDag` → `malformed`). `stop` is
   *  where the engine refuses it: the Units Generation gate while that stage is open
   *  (the file may be mid-write), the per-unit Construction stages once it has closed. */
  | { code: "unit-dag-malformed"; reason: string; detail: string; stop: UnitDagStop }
  /** `stageLevel`: the plan runs per-unit stages at stage level, so no matrix stands in. */
  | { code: "unit-progress-missing"; stageLevel?: boolean }
  | {
      code: "roster-mismatch";
      stateVersion?: string;
      unknownToCatalog: string[];
      missingFromState: string[];
    }
  | { code: "harness-coexist"; harnesses: string[]; chosen: "kiro" | "claude" }
  /** Questions files with a fence/comment/raw block never closed, read as text. */
  | { code: "questions-unclosed-block"; files: string[] }
  /** Record files (or dirs) that exist and could not be read — questions, A&OQ
   *  artifacts, stage diaries; record-relative, sorted. `questions` is true when a
   *  questions file or a dir the questions walk needed is among them, so the blocker
   *  count is a floor (scan/record-read.ts). */
  | { code: "record-file-unreadable"; files: string[]; questions: boolean }
  | { code: "token-usage-failed"; detail: string }
  | { code: "credit-assembly-failed"; detail: string };

/**
 * The usage panel, discriminated by provider. A union rather than two optional
 * fields: exactly one provider is shown, and the type should not be able to say
 * otherwise.
 *
 * `kiro` carries the credit/quota view (u3 `CreditViewModel`, fed by the polled
 * `kiro-cli /usage` snapshots). `claude` carries the token view, aggregated from
 * local Claude Code transcripts — no quota exists there, so the panel reports
 * measured tokens instead of a percentage of an unknown limit.
 */
export type UsageView =
  | { kind: "kiro"; credit: CreditViewModel }
  | { kind: "claude"; tokens: TokenViewModel };

/** Everything the page needs. Serialised verbatim as /api/model. */
/** A review request no completion has answered (scan/timing.ts `pairReviews`). */
export interface PendingReview {
  reviewer: string;
  stage: string;
  unit?: string;
  /** `single-stage:<slug>` for an isolated run's request; absent on the main workflow. */
  workflow?: string;
  iteration: number;
  /** The request's own timestamp, and its age at assembly time. */
  since: string;
  sinceSec: number;
}

export interface ReviewerStat {
  reviewer: string;
  /**
   * Completions that answer a recorded request — same Request Id and fingerprint. The
   * engine also checks the verdict shape and the review record before it counts one;
   * that is not transcribed, so this is what was recorded, not what the engine accepts.
   */
  reviews: number;
  ready: number;
  notReady: number;
  /** Paired completions past the first pass (`Iteration` above 1). */
  rePasses: number;
  /**
   * Requests closed by the engine's NOT-READY fallback (`Review Finished: no`): the retried
   * review still wrote no whole review, so no reviewer gave the verdict. They close the
   * request and count nowhere else here.
   */
  unfinished: number;
  /**
   * Sum of each request → its completion. The timing panel pairs with the same rule but
   * over its own window and counts overlapping delegation once, so the two totals differ.
   */
  pairedSec: number;
  /** Where the reviews ran, in first-seen order. */
  where: { stage: string; unit?: string; count: number }[];
}

export interface HelperStat {
  /** `Agent Type` verbatim; `unknown` when the dispatch named none. */
  agentType: string;
  sent: number;
  finished: number;
}

export interface DeclaredAgent {
  slug: string;
  displayName?: string;
  tier?: AgentTier;
  /** In-scope stages this agent is declared to lead, support, or review. */
  lead: string[];
  support: string[];
  reviews: string[];
  /** The ledger names it as a reviewer or a helper somewhere in this run. */
  recorded: boolean;
}

/**
 * Who did delegated work in this run (model/agents.ts). Built from what the ledger
 * RECORDS — review requests paired with their completions, helper dispatch and
 * completion rows — with the catalogue's declared crew beside it, never mixed in.
 */
export interface AgentsReport {
  /**
   * Unanswered requests on the stage (and unit) the run is CONFIRMED to be on, of the
   * main workflow and the newest claim attempt, with no attempt boundary after them —
   * the only "open now". Even this is a request, not proof a reviewer is running.
   */
  open: PendingReview[];
  /** Every other request with no matching completion in the records read. Not "working". */
  pending: PendingReview[];
  /** The run position is confirmed; without it no request can be called open. */
  positionVerified: boolean;
  reviewers: ReviewerStat[];
  helpers: HelperStat[];
  /** Any `SUBAGENT_DISPATCHED` row at all — without one, helpers have completions only. */
  helpersDispatchRecorded: boolean;
  /** Latest finished review (not a `Review Finished: no` fallback) or helper completion. */
  lastFinished?: string;
  /** Display name per agent slug the panel shows, from the harness's files or the roster. */
  names: Record<string, string>;
  /** The in-scope stages' declared crew; empty when the catalogue declares none. */
  declared: DeclaredAgent[];
  /** In-scope stages that declare a `mode`, and how many of them run inline. */
  inline: { inline: number; total: number };
  /**
   * What the pairing could not use: completions that answer no recorded request, and
   * unanswered legacy requests with no `Request Id`. Counted, never listed with the
   * unanswered requests — for a completion, an answer WAS recorded.
   */
  unpaired: { completions: number; legacyRequests: number };
}

export interface DashboardModel {
  /** ISO timestamp of this assembly — the clock all ages are relative to. */
  generatedAt: string;
  identity: RunIdentity;
  state: AidlcState;
  matrix?: ConstructionMatrix;
  /**
   * Where per-unit stages write (scan/unit-artifact-mode.ts). `stage-level` — the plan
   * skips Units Generation — withholds the matrix: there is no unit to draw a column for.
   */
  unitArtifactMode: UnitArtifactMode;
  /**
   * The per-unit stages, when they walk unit by unit: `Construction Iteration: unit-major`
   * and a plan with units (not `stage-level`); empty otherwise. The engine then keeps
   * Current Stage on the first per-unit stage while units walk the later ones and defers
   * the later stages' transitions, so none of these stages' spans says where its units'
   * time went — the units' own segments (`timing.units`) can. Checkpoints alone are not
   * enough: they floor receipts per unit, but after the skeleton unit the router walks
   * stage by stage (`emitPerUnitRunStage`). Catalogue order; with no catalogue, the stages
   * the unit rows name.
   */
  unitMajorStages: string[];
  /**
   * How the unit roster resolved (scan/unit-dag.ts), without the roster itself — the
   * matrix carries that. `malformed` withholds the matrix (the engine's unit set is
   * unknowable); `graphDiffers` says the runtime graph's cached roster was outvoted.
   */
  unitDag:
    | { state: "ok"; graphDiffers: boolean }
    | { state: "none" }
    | { state: "malformed"; reason: string; detail: string; stop: UnitDagStop };
  /**
   * `## Unit Progress` disagrees with the roster the engine rebuilds it from
   * (`deriveTeamUnitProgressModel` re-reads the DAG on every `next`, and refuses one that
   * is not `ok`): the table is the last projection written, not the current authority.
   * `missing` = roster units the table lacks, `extra` = table rows the roster lacks.
   */
  unitProgressStale?:
    | { kind: "roster"; missing: string[]; extra: string[] }
    | { kind: "dag-unreadable" };
  /**
   * Unit checkpoint proofs the engine cannot count verified (scan/checkpoint-proofs.ts) —
   * only where checkpoints are in force. A diagnostic beside the matrix: the next move is
   * the agent's, so none of them is a wait.
   */
  checkpointProofs?: CheckpointProofNote[];
  sensors: SensorReport;
  questions: QuestionsReport;
  diaries: DiaryReport;
  /**
   * Decisions the run put off, and where each is scheduled to be asked again.
   * Separate from `diaries` (what the orchestrator thought) and from `blockers`
   * (a blank `[Answer]:`): a run can have zero blockers and still carry hundreds
   * of these, which is exactly the case the reader cannot otherwise see.
   */
  deferrals: DeferralReport;
  health: HealthReport;
  timing: TimingReport;
  blockers: Blocker[];
  gates: GateSummary;
  /** Where the run is and what else holds it — see model/waits.ts. */
  waits: Waits;
  /**
   * How much of the run was done over again. Separate from `gates`, which only
   * counts the events: this pairs each rejection with the approval that closed it
   * and carries the human reasons.
   */
  rework: ReworkReport;
  /** Delegated work: reviewers, helpers, and the declared crew — see model/agents.ts. */
  agents: AgentsReport;
  /**
   * The engine's ERROR_LOGGED rows, grouped, with what the logging clone did next
   * (model/errors.ts). A diagnostic, never a wait: the next move after an engine error
   * is the agent's.
   */
  errors: ErrorReading;
  /**
   * Usage view for the top-of-page panel. Always present — a run with no usage
   * data degrades to an empty view of the resolved kind rather than an absent
   * slot, so the renderer never has to guard for it.
   */
  usage: UsageView;
  /** Audit event counts by type, for the stream filter. */
  eventCounts: [string, number][];
  /** Newest audit events, for the stream panel (bounded — see assemble.ts). */
  recentEvents: {
    ts: string;
    event: string;
    stage?: string;
    unit?: string;
    detail?: string;
    shard: string;
  }[];
  /** Total events in the ledger, so a truncated stream can say so. */
  totalEvents: number;
  /**
   * Set when any audit path was not read — refused (`audit-shard-refused`) or a listed
   * shard that could not be read (`audit-shard-unread`); `notRead` counts both. The readable rest is
   * a ledger, just not the run's, so a sentence that claims something of the whole
   * run — "every gate passed first time", "no stage in flight", "N checks passed",
   * "no audit events" — would rest on an absence the refusal can explain, and is
   * hedged instead. That holds when every shard was refused too: nothing read is not
   * nothing recorded. Absent only when nothing was refused.
   *
   * The waits and the receipt matrix are NOT hedged by it. They transcribe engine
   * readers that read through the lenient 2.11.0 `readAuditShardEvents` /
   * `readAllAuditShards` (the decision pairing, the unit gate, the unit lifecycle),
   * which skip a refused shard the same way — so the refusal does not move them away
   * from those readers. The strict `readActiveAuditShardEvents`, which refuses the
   * whole history, backs `audit history` and `log answers`, not a wait.
   *
   * A shard that vanished between the listing and the read is skipped without a trace, as
   * the engine skips it, so this field being absent is still not proof of a whole ledger.
   */
  partialAudit?: { notRead: number };
  /** Freshness per source, keyed by source kind. */
  provenance: Record<SourceKind, Provenance>;
  /** Non-fatal problems hit while reading (missing catalogue, unreadable file). */
  warnings: Warning[];
  /**
   * Files each stage produced, keyed by the same identity the overview renders:
   * `<phase>/<slug>` for ordinary stages, `construction/<unit>/<slug>` for the
   * per-unit Construction copies (the slug alone repeats once per Bolt, so it is
   * not a key). Absent key = we never scanned that stage; empty array = we did
   * and it had nothing, which is why the toggle can be disabled honestly.
   */
  artifacts: Record<string, StageArtifact[]>;
}
