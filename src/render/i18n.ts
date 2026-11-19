// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The message catalogue contract: one interface, two implementations.
//
// WHY AN INTERFACE AND NOT A KEY-STRING MAP. `t("blockers.none")` cannot be checked — a
// typo is a runtime blank, and a message that needs three parameters has no way to say
// so. Here `KO` and `EN` both have to *satisfy* `Strings`, so a missing message or a
// changed parameter list is a typecheck failure, and every call site gets its parameters
// spelled out. Same reasoning as the `never` guard that already protects `Warning`:
// completeness at build time, never a runtime fallback that shows Korean on an English
// screen.
//
// SHAPE. Grouped per panel, matching the render module that consumes it, so a panel's
// copy reads top to bottom in one place. Plain strings where there is nothing to
// interpolate, methods where there is.
//
// WHAT IS NOT HERE, deliberately:
//
//   - Text read from the workspace — question headings, gate `**Feedback**`, artifact
//     names, assignment cells, stage names out of `stage-graph.json`. That is measured data,
//     and translating it would put words in the run's mouth.
//   - A failure `reason` already written to `usage.db`. There are no migrations
//     (BR1.3), so a row recorded in Korean stays Korean; it is history, not copy.
//   - `usage-parser.ts`'s Korean label list. Those are matching keys against
//     `kiro-cli`'s own output, not our words, and they already carry English aliases.
//

import type { Locale, SourceKind, UnitDagStop } from "../model/types";
import type { CheckpointKind, ProofFault, UnreadableCause } from "../scan/checkpoint-proofs";
import type { DeclaredSource } from "../scan/declared-open-questions";
import type { OwnerStatus } from "../scan/deferrals";
import type { CellState, ReceiptReason } from "../scan/matrix";
import type { StageEndKind } from "../scan/timing";
import { EN } from "./i18n-en";
import { KO } from "./i18n-ko";

/** Every user-facing string the render layer emits, grouped by panel. */
export interface Strings {
  readonly locale: Locale;
  readonly warn: WarnStrings;
  readonly blockers: BlockerStrings;
  readonly status: StatusStrings;
  readonly overview: OverviewStrings;
  readonly page: PageStrings;
  readonly health: HealthStrings;
  readonly deferrals: DeferralStrings;
  readonly timeline: TimelineStrings;
  readonly picker: PickerStrings;
  readonly usage: UsageStrings;
  readonly errorPage: ErrorPageStrings;
  readonly cli: CliStrings;
  readonly openFile: OpenFileStrings;
  readonly viewer: ViewerStrings;
  readonly explorer: ExplorerStrings;
  readonly freshness: FreshnessStrings;
  readonly cards: CardStrings;
  readonly kpi: KpiStrings;
  readonly agents: AgentStrings;
  readonly journey: JourneyStrings;
  readonly tsum: TimeSummaryStrings;
}

/**
 * The time and usage summaries under the journey (render/time-summary.ts). Hours, never
 * days — see `hours()` in render/common.ts.
 */
export interface TimeSummaryStrings {
  readonly title: string;
  /** `h` is the classified span, already formatted. */
  classified(h: string): string;
  classifiedPartial(h: string, refused: number): string;
  /** The stretch since the last event, which no bucket holds. */
  tail(h: string): string;
  readonly empty: string;
  /** `empty` with an audit path refused: nothing read is not nothing recorded. */
  emptyPartial(refused: number): string;
  readonly more: string;
  readonly stagesTitle: string;
  /**
   * `top` is the stage with the most OBSERVED time (not the longest bar), by display name.
   * `withUnknown` is the stage that would rank first with unclassified time added, given
   * only when it is a different stage — unclassified is time the ledger does not explain,
   * so it never ranks a stage on its own, but a reader should know the answer changes.
   */
  stagesNote(top: string, withUnknown: string | undefined): string;
  /**
   * `stagesNote` under unit-major: per-unit stages are compared by their units' segments,
   * because the first per-unit stage's span holds every unit's work.
   */
  stagesNoteUnits(top: string, withUnknown: string | undefined): string;
  /** Appended to the ranking sentence when an audit path was refused: it ranks what was read. */
  rankPartial(refused: number): string;
  /** Tooltip tail on a per-unit stage's observed figure under unit-major. */
  readonly unitsWorkTip: string;
  /** Tooltip tail on a per-unit stage's unclassified figure under unit-major. */
  readonly unitsUnknownTip: string;
  /** Appended to `unitsWorkTip` when a unit segment's length is unknown: the sum is a floor. */
  readonly unitsWorkFloorTip: string;
  /** Tooltip tail on a per-unit stage with no unit segment recorded: no comparable figure. */
  readonly unitsNoneTip: string;
  /** Tooltip on a per-unit stage the units reached before its own STAGE_STARTED. */
  readonly unspannedTip: string;
  readonly colStage: string;
  readonly colObserved: string;
  readonly colUnknown: string;
  readonly colSpan: string;
  readonly live: string;
  reworkSome(rejected: number, h: string): string;
  reworkFirstTime(approved: number): string;
  readonly reworkNoGate: string;
  reworkPartial(refused: number): string;
  /** `limit` and `used`, compacted. */
  creditOf(limit: string, used: string): string;
  resets(date: string): string;
  readonly over: string;
  /** A value whose source has since gone stale / whose latest collection failed. */
  stale(date: string): string;
  staleFailed(date: string): string;
  readonly tokensNoLimit: string;
}

/**
 * The journey board (render/journey.ts): every stage by phase, one current position, the
 * units under it. Stage and unit NAMES are tree text and are never translated here.
 */
export interface JourneyStrings {
  readonly title: string;
  /** `total` stage rows the state lists, `inScope` of them this plan runs. */
  summary(total: number, inScope: number): string;
  /** The checkbox that shows the `n` out-of-scope rows hidden by default. */
  showOut(n: number): string;
  /** A phase with nothing in this plan's scope. */
  readonly phaseOut: string;
  readonly kind: {
    readonly done: string;
    readonly active: string;
    readonly awaiting: string;
    readonly revising: string;
    readonly todo: string;
    readonly skip: string;
    readonly out: string;
  };
  readonly hereYou: string;
  readonly hereNow: string;
  /** Beside the tag when the position fell back to a Current Stage that can lag. */
  readonly hereUnverified: string;
  /** Work + conversation time in a stage's tip, already formatted. */
  workChat(time: string): string;
  readonly unitsTitle: string;
  readonly unitHere: string;
  readonly unitDone: string;
  readonly matrixLink: string;
}

/**
 * The 2×2 card grid (render/cards.ts, render/status.ts) and the lines around it.
 *
 * The card titles used to be English in both catalogues, chosen beside the
 * engine-vocabulary "Stage" and "Unit" cards. Those cards became the journey
 * (render/journey.ts), so the Korean page now names its panels in Korean; the English
 * page keeps "Run Health".
 */
export interface CardStrings {
  /** The three-ledger panel under the time summary (renderUnresolved). */
  readonly unresolvedHeading: string;
  readonly unresolvedLede: string;
  /** The folded Run Health + sources (renderDiagnostics). */
  readonly diagTitle: string;
  /** Summary chip: hook heartbeats stale or never fired. */
  readonly diagHooks: string;
  /** Summary chip naming the stale sources, comma-joined. */
  diagStale(names: string): string;
  readonly healthTitle: string;
  readonly colStage: string;
  /** Column header for work + conversation time. */
  readonly workChatTip: string;
  readonly cellLabel: Record<CellState, string>;
  readonly decisionsTab: string;
  readonly openQsTab: string;
  readonly declaredTab: string;
  readonly colItemOwner: string;
  readonly colAge: string;
  readonly noDecisions: string;
  readonly noOpenQs: string;
  readonly noDeclared: string;
  /** A tab's empty text when part of its ledger could not be read or parsed. */
  readonly notAllRead: string;
  /** Under the decisions tab: what its rows are, and what the ledger cannot say. */
  readonly decisionsNote: string;
  readonly answersTab: string;
  readonly stuckTab: string;
  readonly checksTab: string;
  /** Run Health's engine-error tab; also the diagnostics chip's label. */
  readonly errorsTab: string;
  readonly summaryTab: string;
  readonly colAsk: string;
  readonly colWait: string;
  readonly colGuard: string;
  readonly colCount: string;
  readonly colCheck: string;
  readonly colWhen: string;
  readonly colErrCmd: string;
  /** Folded remainder under a list. */
  moreRows(n: number): string;
  readonly moreDeferrals: string;
  /** Run Health's link: the timing panel, read for where the run waited. */
  readonly moreWaits: string;
  readonly sourcesLabel: string;
  /** `age` already formatted. */
  sourceAge(age: string): string;
  readonly sourceMissing: string;
  readonly sourceStale: string;
  readonly sourceNames: Record<SourceKind, string>;
}

/**
 * The KPI strip and the one chart it drives (render/kpi.ts). Figures arrive already
 * formatted; each tile says where its number came from.
 */
export interface KpiStrings {
  /** The Details area's aria label (render/kpi.ts). */
  readonly heading: string;
  /** The Details area's visible title. */
  readonly detailsTitle: string;
  /** Claude Code: `window` is the usage window's long name. No limit exists locally. */
  tokenSub(window: string): string;
  readonly usageNone: string;
}

/**
 * The Agents panel (render/agents.ts): delegated work as the ledger records it. Agent,
 * stage and unit names are tree text and pass through untranslated.
 */
export interface AgentStrings {
  /** Tab and panel title. */
  readonly section: string;
  /** Where a request or review ran; `unit` absent for a stage-level review. */
  place(stage: string, unit: string | undefined): string;
  /** `n`-th pass of the review (its `Iteration`). */
  pass(n: number): string;
  /** `age` is a compact duration (`dur()`) since the request was sent. */
  openSince(age: string): string;
  readonly openTitle: string;
  readonly colSince: string;
  readonly openTip: string;
  /** No request open; `ago` is how long since the last recorded completion. */
  noneOpen(ago: string): string;
  /** Nothing open, but the run position is unconfirmed, so "where the run is" is unknown. */
  noneOpenUnverified(ago: string): string;
  readonly reviewersTitle: string;
  readonly colAgent: string;
  readonly colReviews: string;
  /** Definition of the bar and the time figure, on the column header. */
  readonly reviewersTip: string;
  reviewerValue(
    reviews: number,
    ready: number,
    notReady: number,
    rePasses: number,
    unfinished: number,
    time: string,
  ): string;
  /** One place a reviewer ran: `stage`, optional `unit`, how many reviews there. */
  where(stage: string, unit: string | undefined, count: number): string;
  moreWhere(n: number): string;
  readonly pendingTitle: string;
  readonly pendingNote: string;
  /** Completions no recorded request pairs with; `legacy` requests had no Request Id. */
  unpairedNote(completions: number, legacy: number): string;
  readonly helpersTitle: string;
  readonly colHelper: string;
  readonly colHelperCount: string;
  /** The column when the ledger has no dispatch rows at all: completions only. */
  readonly colHelperFinished: string;
  helperValue(sent: number, finished: number): string;
  helperFinished(finished: number): string;
  readonly helpersNote: string;
  /** No `SUBAGENT_DISPATCHED` row in the ledger, so every count is completions only. */
  readonly helpersNoDispatch: string;
  readonly unnamedHelper: string;
  /** The folded declared crew: `n` agents. */
  declaredSummary(n: number): string;
  readonly declaredNote: string;
  /** `inline` of `total` in-scope stages run inline, so nothing is sent for them. */
  inlineNote(inline: number, total: number): string;
  /** Stage roles of one declared agent; each list is stage slugs, possibly empty. */
  roles(lead: string[], support: string[], reviews: string[]): string;
  readonly colTier: string;
  readonly recordedMark: string;
  readonly recordedLegend: string;
  readonly tier: Record<"judgment" | "balanced" | "templated", string>;
  readonly tierTip: string;
  readonly quiet: string;
  quietPartial(refused: number): string;
  /** Above the panel when an audit path was refused: every figure is of the records read. */
  partialNote(refused: number): string;
  /** A request of an isolated run (`single-stage:<slug>`). */
  isolated(workflow: string): string;
  more(n: number): string;
}

/** `model.warnings`, one member per `Warning` code — see model/types.ts. */
export interface WarnStrings {
  catalogReadFailed(harnessDir: string): string;
  readonly catalogNotFound: string;
  readonly auditEmpty: string;
  auditShardRefused(paths: string[]): string;
  /** Listed shards that exist and could not be read (permissions, I/O), not a refusal. */
  auditShardUnread(paths: string[]): string;
  stateVersionMismatch(stateVersion: string, harnessVersion: string, harnessDir: string): string;
  /** `stateVersion` undefined = the field was missing; present = it was unusable. */
  stateVersionUnreadable(stateVersion: string | undefined): string;
  teamWithoutUnitMajor(constructionIteration: string | undefined): string;
  readonly unitProgressMalformed: string;
  /** `stageLevel`: no matrix is drawn in this mode, so none is offered in the table's place. */
  unitProgressMissing(stageLevel: boolean): string;
  rosterMismatch(
    stateVersion: string | undefined,
    unknownToCatalog: string[],
    missingFromState: string[],
  ): string;
  harnessCoexist(harnesses: string[], chosen: "kiro" | "claude"): string;
  questionsUnclosedBlock(files: string[]): string;
  /** `questions`: a questions file or dir is among them, so the blocker count is a floor. */
  recordFileUnreadable(files: string[], questions: boolean): string;
  /** The authored unit DAG the engine refuses (scan/unit-dag.ts); `reason` is the engine's. */
  unitDagMalformed(reason: string, detail: string, stop: UnitDagStop): string;
  tokenUsageFailed(detail: string): string;
  creditAssemblyFailed(detail: string): string;
}

/** One unanswered ask, as a row in the Run Health card's "answers" tab. */
export interface BlockerStrings {
  readonly staleStage: string;
  readonly confirmation: string;
  readonly confirmationTip: string;
  /** A blank tag under no heading the reader recognises — the run waits on it all the same. */
  readonly loose: string;
  readonly looseTip: string;
  /** The heading slot of a `loose` tag that sits above every heading. */
  readonly untitled: string;
  /** A summary confirmation holding `tags` tags: the engine reads no answer from it. */
  invalidTags(tags: number): string;
  readonly invalidTagsTip: string;
  /** The path in a blocker row is a LINK now. It used to be plain text, so the one panel
   *  whose whole job is "something is waiting on you" named the file and left the reader
   *  to go find it. */
  viewTip(rel: string): string;
}

/**
 * The status strip at the top of the page (render/status.ts). Each chip is a head
 * and a sub line; the sub line always names where the reading came from, because
 * the four chips have four different sources and freshnesses.
 */
export interface StatusStrings {
  /** Banner headline: at least one hold is waiting on the person. */
  readonly bannerWaiting: string;
  /** `n` holds besides the one the hero card names — the summary of the folded list. */
  bannerMore(n: number): string;
  /** The hero's eyebrow: something is waiting / a plain "now" / the run finished. */
  readonly heroEyeYou: string;
  readonly heroEyeNow: string;
  readonly heroEyeDone: string;
  /** The chip on a hold, by what kind of hold it is. */
  readonly heroKind: {
    readonly question: string;
    readonly confirmation: string;
    readonly loose: string;
    readonly gate: string;
    readonly decision: string;
    readonly engineAsk: string;
    readonly parked: string;
    readonly unitPaused: string;
  };
  /** A wait in calendar time — days are right here: this is elapsed waiting, not work. */
  heroAge(sec: number): string;
  readonly heroAgeCap: string;
  readonly heroCopyPath: string;
  readonly heroCopied: string;
  readonly heroOpen: string;
  /** A hold with no file of its own: the answer goes back through the conversation. */
  readonly heroAnswerInChat: string;
  readonly bannerOpenFile: string;
  /** Nothing counted, but a questions file could not be read — not "nothing waiting". */
  readonly bannerIncomplete: string;
  readonly bannerIncompleteSub: string;
  /** Under a waiting banner when a questions file could not be read. */
  readonly bannerIncompleteNote: string;
  readonly bannerClear: string;
  readonly bannerDone: string;
  /** A finished run's unanswered asks — loose ends, not waits. */
  bannerDoneLoose(n: number): string;
  readonly bannerUnknown: string;
  readonly runComplete: string;
  readonly runUnknown: string;
  readonly runSource: string;
  readonly running: string;
  /** `age` is how long since the newest audit event, already formatted. */
  runningSub(stage: string, age: string): string;
  readonly runTip: string;
  /** `runTip` while `DashboardModel.partialAudit` is set: the run may be writing to a shard not read. */
  runTipPartial(refused: number): string;
  /** Appended to the stage when the position names the unit the run is on. */
  runningUnit(unit: string): string;
  /** The position fell back to a Current Stage that can lag (unit-major). */
  readonly runUnverified: string;
  readonly runUnverifiedTip: string;
  /** The current directive names another stage/unit than the unit cache. */
  runConflict(where: string): string;
  readonly runConflictTip: string;
  /** The unit cache names a unit outside the resolved roster, or the roster is unreadable. */
  runOffRoster(unit: string, why: "absent" | "unknown"): string;
  readonly runOffRosterTip: string;
  readonly stuckNoRecord: string;
  readonly stuckClear: string;
  stuckEarlier(stage: string): string;
  readonly stuckStateChanged: string;
  readonly stuckNudged: string;
  stuckBlocked(count: number, cap: number): string;
  stuckReleased(count: number, cap: number): string;
  readonly stuckSource: string;
  /** `cap` is the default the reading assumed; `autonomous` says which one. */
  stuckTip(cap: number, autonomous: boolean): string;
  humanGate(stage: string): string;
  readonly humanGateSource: string;
  humanRevising(stage: string): string;
  readonly humanRevisingTip: string;
  humanParked(stage: string, byPerson: boolean): string;
  readonly humanParkedTip: string;
  readonly humanStateSource: string;
  humanUnitPaused(unit: string, reason: string): string;
  humanUnitNext(next: string): string;
  /**
   * At stage level, the unit cache the state still carries (`Waits.unitCacheLeftover`):
   * a leftover of an earlier plan, shown and never counted.
   */
  humanUnitCacheLeftover(unit: string, stage: string | undefined, paused: boolean): string;
  readonly humanUnitCacheLeftoverTip: string;
  /** `askType` absent = a marker that carried none. */
  humanEngineAsk(askType: string | undefined, where: string): string;
  readonly humanEngineAskSource: string;
  readonly humanEngineAskTip: string;
  humanEngineOnly(file: string): string;
  readonly humanEngineOnlyTip: string;
  /** A team-owned unit's own gate is open (`unitGateStatus` = awaiting-approval). */
  humanTeamGate(unit: string, stage: string): string;
  /**
   * The same gate back in revision — a rejection, or a jump/redo re-entry (both write
   * `GATE_REJECTED`) — shown, not counted, like `[R]`. Says reopened, not rejected.
   */
  humanTeamGateRevising(unit: string, stage: string): string;
  readonly humanTeamGateSource: string;
  readonly humanTeamGateTip: string;
  readonly humanTeamGateUnread: string;
  readonly humanTeamGateUnreadTip: string;
  /** A row in the answers tab: `n` questions paths exist and could not be read. */
  humanUnreadable(n: number): string;
  readonly humanUnreadableTip: string;
  readonly humanCheckoutPark: string;
  readonly humanCheckoutParkTip: string;
  /** `checkpoint` / `decision` are the audit's own fields, either may be absent. */
  humanDecision(checkpoint: string | undefined, decision: string | undefined): string;
  readonly humanDecisionSource: string;
  readonly humanDecisionTip: string;
  /** Appended when the decision's stage came from the unit cache alone. */
  readonly humanDecisionUnscoped: string;
  /** A gate the person replied to since it was shown — the agent's move to record it. */
  humanGateReplied(stage: string, unit: string | undefined): string;
  readonly humanGateRepliedTip: string;
  /** Beside a decision counted under autonomy with no `Checkpoint`. */
  readonly humanDecisionUnlessUnattended: string;
  readonly humanTurnEnded: string;
  readonly humanTurnEndedTip: string;
  /** Both ages already formatted. */
  humanHooksStale(heartbeatAge: string, eventAge: string): string;
  readonly humanHooksNever: string;
  readonly humanHooksStaleTip: string;
  readonly humanHooksNeverTip: string;
  readonly humanAutonomous: string;
  readonly humanAutonomousTip: string;
  readonly humanNone: string;
  readonly humanSource: string;
  readonly checksNone: string;
  /** `checksNone` when some audit paths were not read (`DashboardModel.partialAudit`). */
  checksNonePartial(refused: number): string;
  checksInFlight(pending: number): string;
  checksFailed(failed: number): string;
  checksPassed(passed: number): string;
  /** `checksPassed` when some audit paths were not read — a failure may be among them. */
  checksPassedPartial(passed: number, refused: number): string;
  checksUnverified(n: number): string;
  readonly checksUnverifiedTip: string;
  /** Names the stage the checks are for — Current Stage, which can differ from the run line. */
  checksSource(stage: string): string;
  readonly checksFailedTip: string;
  readonly errorsNone: string;
  /** `errorsNone` when some audit paths were not read (`DashboardModel.partialAudit`). */
  errorsNonePartial(refused: number): string;
  /** What the logging clone recorded after the error — an observation, not "moved on". */
  readonly errorsFollowed: string;
  readonly errorsErrorsOnly: string;
  readonly errorsStageClosed: string;
  /** The stop hook's error directive: it delivered the error and kept the turn going. */
  readonly errorsDelivered: string;
  /** The stage the error is placed in — inferred, and said so; `latest` for a repeat group. */
  errorsAfterStage(stage: string, unit: string | undefined, latest: boolean): string;
  /** Tooltip tail: how often, when (both UTC ISO), which clone. */
  errorsTip(count: number, first: string, last: string, shard: string): string;
  /** The audit-log link's tooltip — the viewer opens the whole shard. */
  errorsViewTip(ts: string): string;
  errorsHelpDropped(n: number): string;
  readonly errorsSource: string;
}

export interface OverviewStrings {
  readonly sectionProgress: string;
  /** The state's `Plan` — a plan composed for this work, beside the scope. */
  planLabel(name: string): string;
  readonly sectionUnitProgress: string;
  readonly sectionMatrix: string;
  readonly runComplete: string;
  readonly nowLabel: string;
  readonly updatedLabel: string;
  readonly kindArtifact: string;
  readonly kindQuestions: string;
  readonly kindDiary: string;
  openInEditor(rel: string): string;
  readonly provisionalTip: string;
  readonly totalColumn: string;
  readonly unassignedOwner: string;
  readonly batchNote: string;
  /** Carries `<code>`/`<b>` markup, so it is interpolated raw — never through esc(). */
  readonly unitProgressNote: string;
  /**
   * The table's unit set differs from the resolved roster (DashboardModel.unitProgressStale).
   * `rewritesOnNext` is false at stage level: the only `next`-time writer of the table is
   * the team unit-major router, which a stage-level plan returns before reaching.
   */
  unitProgressStaleRoster(missing: string[], extra: string[], rewritesOnNext: boolean): string;
  /** The roster cannot be read, so the engine cannot rebuild the table. */
  readonly unitProgressStaleDag: string;
  /** The Unit Progress section title when the plan runs per-unit stages at stage level. */
  readonly sectionUnitProgressStageLevel: string;
  /** Carries `<code>` markup, so it is interpolated raw — never through esc(). */
  readonly unitProgressStageLevelNote: string;
  readonly noUnits: string;
  readonly noUnitsPill: string;
  /** The plan skips Units Generation (scan/unit-artifact-mode.ts) — there are no units. */
  readonly stageLevelUnits: string;
  readonly stageLevelUnitsPill: string;
  /** No readable Units Generation action: the matrix assumes per-unit placement. */
  readonly unitModeUnknown: string;
  /** The authored unit DAG is unreadable to the engine: no roster is drawn in its place. */
  unitDagMalformed(reason: string, stop: UnitDagStop): string;
  unitDagMalformedPill(stop: UnitDagStop): string;
  /** The authored DAG outvoted a runtime-graph cache that no longer matches it. */
  readonly unitDagHealed: string;

  // Cell tooltips. `unverified` is per CAUSE — see the ReceiptReason note in scan/matrix.ts.
  tipPartial(missing: string[]): string;
  tipComplete(present: string[]): string;
  tipUnsettled(present: string[]): string;
  tipUnverified(reason: ReceiptReason, present: string[]): string;
  tipNotApplicable(present: string[]): string;
  /** `reason` is the engine's own, from the UNIT_SKIPPED row; may be empty. */
  tipSkipped(reason: string): string;
  readonly tipNotStarted: string;

  // Legend FRAGMENTS. The conditional composition stays in overview.ts — it is logic —
  // and only the words live here.
  readonly legendBase: string;
  readonly legendUnsettled: string;
  readonly legendUnverified: string;
  readonly legendNa: string;
  readonly legendSkipped: string;
  /** Shown when stateCompat !== "verified". Carries `<b>` markup. */
  readonly legendUnverifiedContract: string;
  legendNoContract(receiptAware: boolean): string;

  // Unit checkpoint proofs the engine cannot count verified (scan/checkpoint-proofs.ts).
  readonly checkpointHeading: string;
  /** What a definite note does and does not settle, and why none of them is a wait. */
  readonly checkpointNote: string;
  /** For the notes marked `?` — this reader cannot settle them. */
  readonly checkpointIndefiniteNote: string;
  checkpointKind(kind: CheckpointKind): string;
  /** `detail` is the joined `checkpointFault` phrases. */
  checkpointFailed(unit: string, kind: string, detail: string, startedAt: string): string;
  checkpointFault(fault: ProofFault, exitCode: number | null, signal: string | null): string;
  checkpointMalformed(unit: string, kind: string): string;
  checkpointUnreadable(unit: string, kind: string, cause: UnreadableCause): string;
  readonly checkpointKindUndetermined: string;
  readonly checkpointOutputTail: string;
}

export interface PageStrings {
  readonly warningsHeading: string;
  readonly harnessNotFound: string;
  readonly pickFolder: string;
  /** Header workspace switcher (render/workspace-menu.ts). */
  readonly wsMenuTip: string;
  readonly wsHeading: string;
  /** Discovery found nothing besides the current workspace. */
  readonly wsNoOthers: string;
  readonly wsLoading: string;
  readonly wsLoadFailed: string;
  readonly wsCurrent: string;
  readonly wsTruncated: string;
  readonly reloadTitle: string;
  readonly reloadLabel: string;
  readonly footer: string;
  readonly langGroupLabel: string;
  readonly langKo: string;
  readonly langEn: string;
  /**
   * The desktop-notification switch (render/notify.ts): one label and one tip per state.
   * The label carries the state in words, so it never rests on the dot's colour alone.
   */
  readonly notifyOff: string;
  readonly notifyOn: string;
  readonly notifyBlocked: string;
  readonly notifyUnsupported: string;
  readonly notifyOffTip: string;
  readonly notifyOnTip: string;
  readonly notifyBlockedTip: string;
  readonly notifyUnsupportedTip: string;

  // Strings the CLIENT script interpolates. They are injected with JSON.stringify, so an
  // apostrophe in English copy cannot terminate the JS literal it lands in.
  readonly jsReloading: string;
  readonly jsRefreshedPrefix: string;
  readonly jsRefreshFailed: string;
  /** `{status}` is substituted with the HTTP status by the client script. */
  readonly jsOpenFailedStatus: string;
  readonly jsOpenFailedUnreachable: string;
  /** The body line under the new hold: `{name}` the run, `{n}` the waiting count the tab title also prints. */
  readonly jsNotifyWaitBody: string;
  /** Appended to the body when the poll found more new holds: `{n}` of them. */
  readonly jsNotifyMore: string;
  /** The one confirmation sent when the reader turns notifications on. */
  readonly jsNotifyOnTitle: string;
  readonly jsNotifyOnBody: string;
}

/**
 * Decisions and issues / audit ledger. Both panels are BUILT but not MOUNTED (`SHOW_DIARY` /
 * `SHOW_STREAM` in health.ts), so this copy is carried for the flag-flip rather than
 * for the current screen — which is why the golden-output tests do not cover it.
 */
export interface HealthStrings {
  readonly sectionDiary: string;
  readonly sectionStream: string;
  readonly kindDeviation: string;
  readonly kindDeviationTip: string;
  readonly kindTradeoff: string;
  readonly kindTradeoffTip: string;
  readonly kindInterpretation: string;
  readonly kindInterpretationTip: string;
  readonly kindResolved: string;
  readonly kindResolvedTip: string;
  readonly kindFollowUp: string;
  readonly kindFollowUpTip: string;
  readonly kindNote: string;
  readonly kindNoteTip: string;
  readonly sourceLink: string;
  openTip(rel: string): string;
  readonly noRecords: string;
  more(count: number): string;
  stageRollup(count: number): string;
  readonly colStage: string;
  readonly colDecision: string;
  readonly colDeviation: string;
  readonly colFollowUp: string;
  readonly colResolved: string;
  readonly colNote: string;
  readonly colTotal: string;
  readonly noDiaryFiles: string;
  readonly noDiaryRecords: string;
  readonly statFollowUp: string;
  readonly statResolved: string;
  readonly statDeviation: string;
  readonly statDecision: string;
  readonly tidyPill: string;
  readonly tidyPillTip: string;
  readonly tidyNote: string;
  readonly headingFollowUp: string;
  readonly headingRecentDecisions: string;
  readonly headingRecentDeviations: string;
  resolvedRecords(count: number): string;
  readonly emptyLedger: string;
  readonly filterLabel: string;
  filterAll(total: number): string;
  streamMeta(shown: number, total: number, shards: number): string;
  readonly colTime: string;
  readonly colEvent: string;
  readonly colStageUnit: string;
  readonly colDetail: string;
}

/** Deferred decisions — the deferral ledger. Several entries carry `<code>`/`<b>` markup and are
 *  interpolated raw; they are our own copy, never anything read from the tree. */
export interface DeferralStrings {
  readonly section: string;
  readonly faces: Record<OwnerStatus, { readonly label: string; readonly tip: string }>;
  readonly ageTip: string;
  /** `sourceLink` now points at `/view` — the in-dashboard source — because that is what
   *  the word says. `editorLink` is the old destination, `/open`, named for what it does. */
  readonly sourceLink: string;
  viewTip(rel: string): string;
  readonly editorLink: string;
  openTip(rel: string): string;
  readonly assignLabel: string;
  readonly noneApplicable: string;
  more(key: string, count: number): string;
  ownerRollup(stages: number): string;
  readonly colOwner: string;
  readonly colStatus: string;
  readonly colCount: string;
  readonly assumptionPill: string;
  readonly assumptionPillTip: string;
  assumptionSummary(count: number): string;
  /** Raw markup. */
  readonly assumptionNote: string;
  readonly diaryFollowUpPill: string;
  readonly diaryFollowUpTip: string;
  readonly diaryNotePill: string;
  readonly diaryNoteTip: string;
  diarySummary(count: number): string;
  /** Raw markup. */
  diaryNote(resolved: number): string;
  readonly ledgerItems: string;
  /** Raw markup. */
  readonly ledgerItemsSource: string;
  readonly ledgerAssumptions: string;
  /** Raw markup. */
  readonly ledgerAssumptionsSource: string;
  readonly ledgerDiary: string;
  /** Raw markup. */
  readonly ledgerDiarySource: string;
  readonly ledgerDeclared: string;
  /** Raw markup. */
  readonly ledgerDeclaredSource: string;
  readonly declaredFaces: Record<DeclaredSource, { readonly label: string; readonly tip: string }>;
  declaredSummary(count: number): string;
  /** Raw markup. */
  readonly declaredNote: string;
  readonly contractLabel: string;
  readonly blocksLabel: string;
  /** Raw markup; `files` is already-escaped markup. */
  declaredUnread(files: string): string;
  /** Raw markup; `files` is already-escaped markup. */
  declaredMissing(files: string): string;
  /** Raw markup; `files` is already-escaped markup. */
  declaredUnreadable(files: string): string;
  /** A&OQ artifacts or dirs that exist and could not be read; `files` is markup. */
  aoqUnreadable(files: string): string;
  /** Stage diaries that exist and could not be read; `files` is markup. */
  diaryUnreadable(files: string): string;
  /** Raw markup; `files` is already-escaped markup. */
  unreadAlongside(unread: number, files: string): string;
  readonly chipUnassignedTip: string;
  readonly chipFollowUp: string;
  readonly chipFollowUpTip: string;
  readonly chipOther: string;
  readonly chipOtherTip: string;
  /** Raw markup. */
  readonly ledgersNote: string;
  /** Raw markup. */
  /** `unreadable` > 0: some artifacts or dirs could not be read, so "none" is only of what was. */
  noSections(artifacts: number, unreadable: number): string;
  /** Raw markup. */
  unreadSections(sections: number, unread: number, emptySections: number): string;
  readonly noOpenPill: string;
  readonly noOpenPillTip: string;
  /** Raw markup. */
  /** `partial`: something could not be read, so "all" is all of what was. */
  allNone(sections: number, partial: boolean): string;
  /** Raw markup. */
  lead(items: number, sections: number, rows: number, exits: number): string;
  /** Raw markup. */
  readonly catalogMissingNote: string;
  headingPassed(count: number): string;
  headingCurrent(count: number): string;
  summaryAhead(count: number): string;
  summaryRest(count: number): string;
}

/** Timing — the timing panel. Entries marked "raw markup" carry `<b>`/`<i>`/`<code>`
 *  and are interpolated without esc(); they are our own copy. */
export interface TimelineStrings {
  readonly section: string;
  readonly endKinds: Record<StageEndKind, string>;
  segmentTip(stage: string, endKind: string, from: string, to: string, split: string): string;
  splitLine(
    wait: string,
    parked: string,
    observed: string,
    conversation: string,
    unknown: string,
  ): string;
  readonly zeroSecondTip: string;
  loadArtifacts(n: number): string;
  loadFailures(n: number): string;
  loadDelegations(n: number): string;
  loadHumanTurns(n: number): string;
  readonly noStageSpans: string;
  noStageSpansPartial(refused: number): string;
  /** Said once at the head of the panel while `DashboardModel.partialAudit` is set. */
  partialAuditNote(refused: number): string;

  // buckets
  readonly bucketWait: string;
  readonly bucketWaitTip: string;
  readonly bucketParked: string;
  readonly bucketParkedTip: string;
  readonly bucketObserved: string;
  readonly bucketObservedTip: string;
  readonly bucketConversation: string;
  readonly bucketConversationTip: string;
  readonly bucketUnknown: string;
  readonly bucketUnknownTip: string;

  // headline
  windowTipOpen(silence: string): string;
  readonly windowTipClosed: string;
  readonly windowTeam: string;
  readonly windowSolo: string;
  /** Raw markup. */
  windowSub(classified: string): string;
  unrecordedPill(silence: string): string;
  clonesPill(clones: number): string;
  delegated(hours: string): string;
  /** Raw markup. */
  inFlight(list: string): string;
  readonly noneInFlight: string;
  /** A finished run's in-flight line: `at` is the last event, shortTs-formatted (UTC). */
  runEnded(at: string): string;
  noneInFlightPartial(refused: number): string;
  /** Raw markup. */
  awaiting(stage: string): string;
  /**
   * Raw markup; `name` already escaped. An audit-opened decision leaves the state row
   * alone, so the line names it rather than saying no gate is waiting.
   */
  awaitingDecision(name: string | undefined): string;
  /** Raw markup, appended when the decision's stage came from the unit cache alone. */
  readonly awaitingDecisionUnscoped: string;
  /** Raw markup. A team-owned unit's own gate is open; `unit`/`stage` arrive escaped. */
  awaitingTeam(unit: string, stage: string): string;
  /** Raw markup. Team ownership: the unit gate needs a read this checkout cannot give. */
  readonly awaitingTeamUnread: string;
  /** Raw markup. An open gate the person replied to — the agent's move; args arrive escaped. */
  awaitingReplied(stage: string, unit: string | undefined): string;
  /** Raw markup. Claims the stage gate only — other asks live in the waits tab. */
  readonly awaitingNone: string;
  readonly reworkPending: string;
  /** Raw markup. */
  mergedNote(workers: number, clones: number): string;
  axisSilenceTip(silence: string): string;

  // rework
  reworkSummary(rejected: number, hours: string): string;
  /**
   * `approved` is the ledger's GATE_APPROVED count. With none, nothing has passed yet,
   * so "first time" would be vacuous; with some, the claim covers those alone.
   */
  reworkNone(approved: number): string;
  /** Never "every gate passed first time": a shard not read can hold the rejection. */
  reworkNonePartial(refused: number): string;
  readonly reworkProvisionalTip: string;
  feedbackCount(n: number): string;
  reasonsSummary(n: number): string;
  /** Raw markup. */
  readonly reasonsNote: string;
  reworkStatShare(share: string): string;
  readonly statRejected: string;
  readonly statApproved: string;
  readonly statRevisions: string;
  readonly statJumps: string;
  readonly statReopened: string;
  readonly statReopenedTip: string;
  readonly statFreezeBlocked: string;
  readonly colSubmissions: string;
  readonly colSubmissionsTip: string;
  readonly colRejections: string;
  readonly colRevisions: string;
  readonly colRevisionsTip: string;
  readonly colRework: string;
  readonly colReworkTip: string;
  readonly colReason: string;
  readonly colReasonTip: string;
  /** Raw markup. */
  reworkNote(share: string, classified: string, provisional: boolean): string;

  // gantt table
  readonly colStage: string;
  readonly colTrack: string;
  readonly colTotalMin: string;
  readonly colWait: string;
  readonly colParked: string;
  readonly colObserved: string;
  readonly colConversation: string;
  readonly colConversationTip: string;
  readonly colUnknown: string;
  /**
   * Tooltip on an unclassified figure: how much of it a person's message ended (`turn`) and
   * how much anything else did (`rest`). Neither is user wait or work.
   */
  unknownSplit(turn: string, rest: string): string;
  readonly colWorkload: string;
  /** Raw markup. */
  readonly ganttLegend: string;
  /** Under the stage table, under unit-major when units were recorded (the unit view is above it). */
  readonly ganttLegendUnits: string;
  readonly colUnitStage: string;
  unitSummary(units: number, stages: number): string;
  /** One stage's units summed against that stage's bar; `stageHours` absent when no bar. */
  unitVsStage(stage: string, unitHours: string, stageHours?: string): string;
  readonly unitNote: string;
  inferredStartTip(firstWrite: string, receipt?: string): string;
  readonly inferredRowTip: string;
  readonly durationUnknownTip: string;
  readonly pauseOnlyTip: string;
  readonly colUnitTrack: string;
  unitStageSkipped(stage: string): string;
  /** Raw markup. */
  readonly observedCaveat: string;
  unknownGapsSummary(count: number): string;
  readonly unknownGapsNote: string;
  minutes(min: string): string;
  inferredPark(hours: string, anomalies: number): string;
  /** Under a table whose split columns were all zero: the hidden columns' labels. */
  hiddenCols(names: string[]): string;
  /** The fold holding a table's reading notes. */
  readonly howToRead: string;
  /** Tooltip on the observed column's header. */
  readonly colObservedTip: string;
  /** Under an observed figure: the delegated part of it. */
  delegatedIn(min: string): string;
  readonly delegatedInTip: string;
  /** The per-ask answer-time fold; `shown` is how many are listed. */
  asksSummary(count: number, shown: number): string;
  readonly askGate: string;
  readonly askDecision: string;
  askQuestion(type?: string): string;
  askSpan(min: string): string;
  readonly askWaitTip: string;
  readonly asksNote: string;
  readonly asksParallelNote: string;

  // worker table
  workerShapeOverlap(clones: number, overlap: string): string;
  workerShapeSequential(clones: number, handover: string | undefined): string;
  workerSummary(shape: string): string;
  readonly leadTag: string;
  readonly leadTagTip: string;
  readonly noUnitAttribution: string;
  readonly personTotal: string;
  readonly personParallelism: string;
  readonly colClone: string;
  readonly colEvents: string;
  readonly colSpanMin: string;
  readonly colGates: string;
  readonly colMainStage: string;
  readonly colUnits: string;
  /** Raw markup. */
  workerNote(teamIdle: string, deltaNote: string): string;
  readonly deltaSame: string;
  /** Raw markup. */
  deltaOverlapUnder(delta: string, overlap: string): string;
  /** Raw markup. */
  deltaOverlapOver(delta: string): string;
  /** Raw markup. */
  deltaHandoverUnder(delta: string): string;
  /** Raw markup. */
  deltaHandoverOver(delta: string, handover: string): string;
  /** Raw markup. */
  hostNote(workers: number, clones: number): string;
  /** Raw markup. */
  endedParked(label: string, at: string): string;
  readonly endedParkedTail: string;
  /** Raw markup. */
  readonly parallelismNote: string;
  /** Raw markup. */
  readonly unitColumnNote: string;
}

/** The workspace picker — its own document, so it carries a title and a footer. */
export interface PickerStrings {
  readonly docTitle: string;
  readonly heading: string;
  /** Heads the card of the workspace the dashboard is showing now. */
  readonly currentMark: string;
  /** Marks a workspace found in (or under) the folder the command was launched from. */
  readonly launchMark: string;
  readonly tagWorkspace: string;
  readonly tagAidlcTree: string;
  readonly tagUnreadable: string;
  readonly open: string;
  readonly explorerEmpty: string;
  readonly explorerRootsLabel: string;
  readonly breadcrumbLabel: string;
  /**
   * The one path field: it opens a workspace, goes to any other folder, and — for the
   * text after the last separator — filters the folder on screen.
   */
  readonly pathLabel: string;
  /** Shown instead of filtering while the typed path points at another folder. */
  readonly pathHint: string;
  /** Live count while the field filters the folder on screen. */
  dirMatchCount(n: number): string;
  readonly showHidden: string;
  readonly hideHidden: string;
  readonly filterNoMatch: string;
  readonly noWorkspacesFound: string;
  /** The one count line beside the list: workspaces found, folders the scan read. */
  foundCount(found: string, scanned: string): string;
  /** The filter over the found workspaces (client-side, name and path). */
  readonly wsFilterLabel: string;
  readonly wsFilterPlaceholder: string;
  readonly wsFilterNoMatch: string;
  /** Label over the workspaces with a run, after the one on screen. */
  readonly runGroup: string;
  /** Summary of the folded group holding workspaces with no run to show. */
  idleGroup(count: string): string;
  /** Summary of the fold holding the path field and the folder listing. */
  readonly otherLocations: string;
  /** Raw markup — what the path field does on Enter, and its keys. */
  readonly pathNote: string;
  readonly foundHeading: string;
  readonly rescan: string;
  readonly truncated: string;

  /**
   * The per-card summary. Labels are rendered SERVER-side into empty slots and the client
   * fills only the numbers, so the catalogue stays the one place copy lives — the same
   * reason `?cw=` is threaded rather than built in the browser.
   *
   * Every state gets its own sentence. `noRunNone` and `noRunAmbiguous` are the two halves
   * of the resolve failure and must not collapse: a tree with no record and a tree with
   * several records and no cursor need different actions from the reader.
   */
  readonly summaryPctLabel: string;
  /** Blank `[Answer]:` slots in the questions files — the main page's own term. */
  readonly summaryBlankLabel: string;
  readonly summaryBlankNone: string;
  /** The state file's `Last Updated`, relative; `rel` is one of the `ago*` forms. */
  summaryUpdated(rel: string): string;
  readonly agoNow: string;
  agoMinutes(n: string): string;
  agoHours(n: string): string;
  agoDays(n: string): string;
  readonly summaryNoRunNone: string;
  readonly summaryNoRunAmbiguous: string;
  summaryNoRunArchived(count: string): string;
  readonly summaryUnreadable: string;
  readonly summaryFailed: string;
  /** Names the source and its date — the card mixes two freshnesses, so neither is silent. */
  summaryProgressTip(done: string, total: string, asOf: string): string;
  summaryBlockersTip(asked: string): string;
  /** Appended to the tip when `n` questions paths could not be read. */
  summaryBlockersUnreadableTip(n: string): string;
  /** Raw markup — carries the workspace path in <code>. */
  footer(path: string): string;
}

/**
 * The usage cards — Kiro credit (credit/view) and Claude tokens (credit/claude).
 *
 * ONE group for both, because they share the window toggle, the chart and the card slot
 * (`model.usage` is a discriminated union). What they do NOT share is a
 * quota: Claude Code exposes no limit locally, so there is no `usageRatio` entry on that
 * side and none is invented.
 */
export interface UsageStrings {
  readonly windowLong7d: string;
  readonly windowLong30d: string;
  readonly windowLongAll: string;
  readonly window7d: string;
  readonly window30d: string;
  readonly windowAll: string;
  readonly trendToggleLabel: string;
  readonly tokenToggleLabel: string;

  // Kiro credit
  readonly creditSection: string;
  readonly statusLoading: string;
  readonly statusOk: string;
  readonly statusPartial: string;
  readonly statusFailure: string;
  readonly statusNone: string;
  readonly rowPlan: string;
  readonly rowUsed: string;
  readonly rowRemaining: string;
  readonly rowLimit: string;
  readonly rowRatio: string;
  readonly ratioUnavailable: string;
  ratioLabel(pct: string): string;
  fetchFailed(reason: string): string;
  readonly rawSummary: string;
  readonly rawEmpty: string;
  readonly stalePill: string;
  readonly firstCollection: string;
  readonly noCreditYet: string;
  readonly staleNote: string;
  /** Automatic collection SLOWED after N consecutive failures — a DIFFERENT fact from "the last
   *  attempt failed", so it gets its own sentence. Not a stop: it recovers on its own, and the
   *  copy has to say the retry period rather than imply the panel is frozen. */
  /** `retryEveryMinutes` is a bare number — the unit word belongs to each catalogue. */
  pollHalted(failures: string, retryEveryMinutes: string): string;
  pollHaltedReason(reason: string): string;
  lastSuccess(at: string): string;
  chartEmpty(windowLabel: string): string;
  chartSummary(windowLabel: string, min: string, max: string, latest: string): string;
  readonly chartNoData: string;

  // Claude tokens
  readonly tokenSection: string;
  readonly tokenPartial: string;
  readonly rowTokenTotal: string;
  readonly rowInput: string;
  readonly rowOutput: string;
  readonly rowThinking: string;
  readonly rowCacheRead: string;
  readonly rowCacheCreate: string;
  /** Cache hit share of prompt tokens. The tip must name the denominator: the row is a
   *  RATIO, and a ratio whose denominator is not stated is the unlabelled number this
   *  dashboard refuses elsewhere. */
  readonly rowCachedPrompt: string;
  readonly rowCachedPromptTip: string;
  readonly rowSessions: string;
  readonly rowMessages: string;
  readonly colModel: string;
  readonly colShare: string;
  tokenChartEmpty(windowLabel: string): string;
  tokenChartSummary(
    windowLabel: string,
    days: number,
    min: string,
    max: string,
    latest: string,
  ): string;
  readonly noTokens: string;
  span(range: string): string;
  sidechain(count: string): string;
  /**
   * Session time, from the `cost-state` checkpoints Claude Code writes. A CROSS-CHECK: the
   * timing panel answers the same question from the audit ledger, so the copy has to say
   * which is authoritative and that sessions do not map onto stages.
   */
  readonly rowSessionWall: string;
  readonly rowSessionApi: string;
  readonly rowSessionTool: string;
  readonly rowSessionCount: string;
  readonly sessionCrossCheck: string;
  sessionStraddling(count: string): string;
  sessionAllStraddling(count: string): string;
  /** One per `TokenNote` code — the switch in token-view.ts is exhaustive. */
  noteNoTranscripts(triedPath: string): string;
  noteFilesCapped(count: string): string;
  noteUnreadableFiles(count: string): string;
  noteMalformedLines(count: string): string;
}

/** The 404/500 page `server.ts` renders when a read fails. */
export interface ErrorPageStrings {
  readonly docTitle: string;
  readonly heading: string;
  /** Label only — the path itself is wrapped in <code> by the caller. */
  readonly triedPathLabel: string;
  /** Raw markup — names the two cursor files in <code>. */
  readonly checkThis: string;
  readonly pickAnother: string;
  readFailed(message: string): string;
  readonly noSelection: string;
  /** The picker's own message when a typed path holds no `aidlc/`. */
  notAWorkspace(dir: string): string;
  /** `/api/body` before a workspace has been chosen. */
  readonly noWorkspaceSelected: string;
  /** `/view` was asked for a file of a record the dashboard no longer shows. */
  readonly otherRecord: string;
}

/**
 * CLI diagnostics. The operator typed the flag, so these are read in a terminal rather
 * than in the browser — but they are still user-facing, and `--lang` is resolved by a
 * pre-pass over argv so even a parse error can answer in the right language.
 * `USAGE` itself is already English on both sides and is not duplicated here.
 */
export interface CliStrings {
  needValue(flag: string): string;
  mustBeNumber(flag: string, raw: string): string;
  msFloor(flag: string, floor: number, zeroOk: boolean, got: number): string;
  portRange(max: number, got: number): string;
  readonly needRoot: string;
  pathMissing(path: string): string;
  notAWorkspace(path: string): string;
  harnessMissing(path: string): string;
  readonly needUsage: string;
  badUsage(raw: string): string;
  readonly needLang: string;
  badLang(raw: string): string;
  unknownArg(arg: string): string;
  readonly noRootPicker: string;
  /** The running Bun is below package.json's `engines.bun` floor. */
  bunTooOld(have: string, floor: string): string;
  /** The port already serves an aidlc-dashboard: this launch opens that one (src/launch.ts). */
  alreadyRunning(url: string): string;
  /** That running server took the `--root` this launch was given. */
  switchedTo(root: string): string;
  /** That running server kept its workspace; `status` is the HTTP status or "failed". */
  switchRefused(root: string, status: string): string;
  /** Something other than an aidlc-dashboard holds the port. */
  portBusy(port: number): string;
  /** The credit history's folder is inside a workspace (`workspaceHoldingDir`). */
  dataDirInWorkspace(dir: string, workspace: string): string;
  /** A Windows console about to close on a startup error waits for this. */
  readonly pressEnterToClose: string;
  // Startup and isolated-failure lines the operator reads to judge whether the run is
  // healthy. They follow `--lang`: there is one operator per process and that flag is
  // exactly their choice.
  manualRefreshFailed(detail: string): string;
  routeFailed(route: string): string;
  creditBootFailed(detail: string): string;
  readonly unhandled: string;
  readonly harnessNotFound: string;
  startupSummary(audit: number, langDefault: string): string;
  intentAmbiguous(root: string): string;
  /** Only archived intents (`count` of them), and no cursor naming one. */
  intentArchived(root: string, count: number): string;
  noWorkflow(root: string): string;
}

/** `/open` refusals — these reach the page as a link tooltip, one per `OpenRefusal` code. */
export interface OpenFileStrings {
  readonly badRel: string;
  readonly badChars: string;
  readonly outsideRecord: string;
  extension(allowed: string[]): string;
  readonly symlinkEscape: string;
  readonly notFound: string;
  readonly statFailed: string;
  readonly notAFile: string;
  platformUnsupported(platform: string): string;
  readonly interpreterMetachars: string;
  openerMissing(cmd: string): string;
  spawnFailed(detail: string): string;
  /** Console-only: the async spawn error that would otherwise kill the process. */
  spawnFailedLog(cmd: string, detail: string): string;
  /** `ViewRefusal`'s one extra code: the jail passed and the read still failed. */
  readFailed(detail: string): string;
}

/**
 * The `/view` source page. The artifact's TEXT is never here — it is read from the tree
 * and shown verbatim, like every other measured string (see "What is NOT translated").
 */
export interface ViewerStrings {
  docTitle(rel: string): string;
  readonly back: string;
  readonly openInEditor: string;
  size(bytes: string): string;
  /** A cap must never read as completeness — this states both numbers. */
  truncated(shown: string, total: string): string;
  readonly refusalHeading: string;
  readonly empty: string;
  /** The questions panel's own counts for this file: asks without an answer, of all. */
  blankCount(blank: number, total: number): string;
  readonly outlineHeading: string;
  /** Shown beside a blank `[Answer]:` tag (CSS, not text) and read out in the outline. */
  readonly badgeBlank: string;
  readonly stateAnswered: string;
  /** Tooltip on a line the engine does not read: in a code block or a comment. */
  readonly exampleTip: string;
  readonly copyPathLabel: string;
  readonly copyPathTip: string;
  /** Outline label for a blank tag under no recognised heading. */
  readonly untitledAsk: string;
  readonly unclosedNote: string;
}

/**
 * Explorer root chips. Only the SYNTHESISED labels are here — a volume's own name and a
 * OneDrive folder's name are read from the filesystem and stay verbatim, which is why
 * `ExplorerRootLabel` splits the two.
 */
export interface ExplorerStrings {
  readonly rootHome: string;
  readonly rootCurrent: string;
  /** The filesystem root chip (`/`), named rather than shown as a bare slash. */
  readonly rootRoot: string;
  volume(name: string): string;
  mount(name: string): string;
  media(name: string): string;
  browseFailed(dir: string, message: string): string;
}

/** Freshness reasons. Carried on `Provenance`; reaches `/api/model` today. */
export interface FreshnessStrings {
  graphBehind(lag: string, drift: string | undefined): string;
  readonly graphUnreadable: string;
  readonly stageGraphMissing: string;
  sensorDrift(fired: number, missing: number): string;
}

/** The catalogue for one request. */
export function strings(locale: Locale): Strings {
  return locale === "en" ? EN : KO;
}
