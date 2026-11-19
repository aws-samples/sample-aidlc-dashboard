// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The 2×2 card grid under the page header, the full panels the KPI tiles open, and the
// sources line at the bottom.
//
// A CARD IS A SUMMARY, NOT A SECOND COPY OF A PANEL. Each card answers one question in
// a handful of bar-backed rows — which stage took the time, which unit is short of its
// contract, what is still unresolved, whether anything needs the human — and links to
// the full panel for the rest. The full panels are the existing renderers, mounted
// unchanged under the KPI tiles (render/kpi.ts), so no reading this dashboard already
// made is lost or re-implemented: the cards only choose what to show first.
//
// Two rules carry over from the panels they summarise:
//   - A number that was not measured is not drawn. A stage with no audit span shows
//     "—", not 0h; a unit with no contract shows the files it has, not a fraction.
//   - Stage time is WORK + CONVERSATION (`observedSec + conversationSec`), the same two
//     buckets the timing panel classifies, never elapsed wall time. Waiting on a human,
//     parked time and unclassified gaps are excluded, and the column tip says so.

import { renderTokens } from "../credit/claude/token-view";
import { renderCredit } from "../credit/view/credit-view";
import { buildStatus } from "../model/status";
import type { DashboardModel, Provenance, SourceKind } from "../model/types";
import { renderAgents } from "./agents";
import { DRILL, type Row, rowList, share, viewLink } from "./card-kit";
import { dur, esc, hours } from "./common";
import { renderDeferrals } from "./deferrals";
import type { Strings } from "./i18n";
import type { KpiPanel } from "./kpi";
import { renderOverview } from "./overview";
import { renderRunHealth } from "./status";
import { renderTimeline } from "./timeline";

/** Rows a card shows before folding the rest into "+N more". */
const CARD_ROWS = 6;

// ── Unresolved ───────────────────────────────────────────────────────────────

function decisionRows(m: DashboardModel, s: Strings): Row[] {
  const items = m.deferrals.items;
  const max = Math.max(0, ...items.map((it) => it.ageSec ?? 0));
  return items.map((it) => {
    const owner = it.ownerStage ?? s.deferrals.faces[it.ownerStatus].label;
    return {
      label: `${viewLink(it.rel, it.item)} <span class="mr-sub">→ ${esc(owner)}</span>`,
      value: dur(it.ageSec),
      pct: it.ageSec === undefined ? undefined : share(it.ageSec, max),
      tone: it.ownerStatus === "passed" ? "warn" : it.ownerStatus === "current" ? "accent" : "none",
      tip: s.deferrals.faces[it.ownerStatus].tip,
    };
  });
}

function openQuestionRows(m: DashboardModel): Row[] {
  const now = Date.parse(m.generatedAt);
  const open = m.diaries.records
    .filter((r) => r.axis === "openQuestions" && r.questionStatus !== "resolved")
    // Follow-ups first: the same order the full panel uses.
    .sort((a, b) =>
      a.questionStatus === b.questionStatus ? 0 : a.questionStatus === "followUp" ? -1 : 1,
    );
  const ages = open.map((r) => (r.ts ? (now - Date.parse(r.ts)) / 1000 : undefined));
  const max = Math.max(0, ...ages.filter((a): a is number => a !== undefined && a > 0));
  return open.map((r, i) => {
    const age = ages[i];
    const where = r.unit ? `${r.stage} · ${r.unit}` : r.stage;
    return {
      label: `${viewLink(r.rel, r.text)} <span class="mr-sub">· ${esc(where)}</span>`,
      value: age !== undefined && age >= 0 ? dur(age) : "—",
      pct: age !== undefined && age >= 0 ? share(age, max) : undefined,
      tone: r.questionStatus === "followUp" ? "warn" : "none",
    };
  });
}

/**
 * The Open questions requirements-analysis and contract-design declare in their own
 * artifact (scan/declared-open-questions.ts). Its own tab, because neither of the other
 * two reads it and it shares an owner cell with neither: without it a run whose open
 * points lived only there showed two empty tabs.
 */
function declaredRows(m: DashboardModel, s: Strings): Row[] {
  const now = Date.parse(m.generatedAt);
  const list = m.deferrals.declared.questions;
  const ages = list.map((q) => (q.since ? (now - Date.parse(q.since)) / 1000 : undefined));
  const max = Math.max(0, ...ages.filter((a): a is number => a !== undefined && a > 0));
  return list.map((q, i) => {
    const age = ages[i];
    const valid = age !== undefined && Number.isFinite(age) && age >= 0;
    return {
      label: `${viewLink(q.rel, q.text)} <span class="mr-sub">· ${esc(
        s.deferrals.declaredFaces[q.source].label,
      )}${q.blocks ? ` → ${esc(q.blocks.replace(/`/g, ""))}` : ""}</span>`,
      value: valid ? dur(age) : "—",
      pct: valid ? share(age, max) : undefined,
      tone: "none",
      tip: s.deferrals.declaredFaces[q.source].tip,
    };
  });
}

/**
 * The three ledgers side by side rather than as tabs, each with its own count and never
 * summed: owner-bearing deferrals, the orchestrator's own open questions, and the ones a
 * stage declared in its artifact answer different questions (see renderBody). The rows
 * are the card's own builders, unchanged.
 *
 * This is the only surface of these ledgers on the page (the full deferrals box is
 * unmounted, SHOW_DEFERRALS), so a column whose ledger was not wholly read cannot print a
 * plain count or "none": the count is a floor and the empty text says the read was
 * partial. It names no panel — there is none left to name the gaps.
 */
export function renderUnresolved(m: DashboardModel, s: Strings): string {
  const c = s.cards;
  const gaps = {
    decisions: m.deferrals.unreadable.length > 0 || m.deferrals.unreadSections.length > 0,
    questions: m.diaries.unreadable.length > 0,
    declared: m.deferrals.declared.ledgers.some((l) => l.status !== "none" && l.status !== "read"),
  };
  const col = (
    title: string,
    rows: Row[],
    gap: boolean,
    empty: string,
    head: [string, string],
    note?: string,
  ) =>
    `<div class="un-col"><p class="un-h"><b${rows.length > 0 ? "" : ' class="zero"'}>${rows.length}${
      gap ? "+" : ""
    }</b>${esc(title)}</p>${rowList(rows, {
      head,
      max: CARD_ROWS,
      moreText: c.moreRows,
      empty: gap ? c.notAllRead : empty,
      note,
    })}</div>`;
  const owner: [string, string] = [c.colItemOwner, c.colAge];
  return `<section class="unres card" id="card-unresolved"><header class="un-head"><h2>${esc(
    c.unresolvedHeading,
  )}</h2><p>${esc(c.unresolvedLede)}</p></header><div class="un-grid">${col(
    c.decisionsTab,
    decisionRows(m, s),
    gaps.decisions,
    c.noDecisions,
    owner,
    c.decisionsNote,
  )}${col(c.openQsTab, openQuestionRows(m), gaps.questions, c.noOpenQs, [c.colStage, c.colAge])}${col(
    c.declaredTab,
    declaredRows(m, s),
    gaps.declared,
    c.noDeclared,
    owner,
  )}</div>${
    SHOW_DEFERRALS
      ? `<a class="mc-more" href="#${DRILL.deferrals}">${esc(c.moreDeferrals)}</a>`
      : ""
  }</section>`;
}

/**
 * Run Health and the sources line, folded. The holds that need the reader already lead
 * the page, so what is left here is the agent-side reading — stuck, failed checks, hook
 * liveness — and how old each input is.
 *
 * Folding must not hide a problem, so the summary carries each signal's own count in
 * its own tone (no combined "all clear" — model/status.ts rule 1), names the stale
 * sources (staleness is stated on screen, never averaged away), and the fold opens on
 * its own when stuck, checks or hooks are flagged. A stale source alone does NOT open
 * it: `runtime-graph` lags the audit systematically mid-stage and was stale
 * on every real tree checked, so letting it open the fold would leave it always open.
 */
export function renderDiagnostics(m: DashboardModel, s: Strings): string {
  const c = s.cards;
  const st = buildStatus(m);
  const chips: { text: string; tone: "ok" | "warn" | "bad" | "mute" }[] = [];
  if (st.stuck) {
    const r = st.stuck;
    chips.push(
      r.state === "blocked" || r.state === "released"
        ? { text: `${c.stuckTab} ${r.count}`, tone: "warn" }
        : r.state === "no-record"
          ? { text: `${c.stuckTab} –`, tone: "mute" }
          : { text: `${c.stuckTab} 0`, tone: "ok" },
    );
  }
  if (st.checks) {
    const r = st.checks;
    chips.push(
      r.state === "failed" || (r.state === "in-flight" && r.failed > 0)
        ? { text: `${c.checksTab} ${r.failed}`, tone: "bad" }
        : r.state === "unverified"
          ? { text: `${c.checksTab} ?`, tone: "warn" }
          : r.state === "passed"
            ? { text: `${c.checksTab} 0`, tone: "ok" }
            : { text: `${c.checksTab} –`, tone: "mute" },
    );
  }
  // Engine errors: a count, muted — most are history (model/errors.ts). Only a clone
  // that stopped on one, or an open error directive, warns and so opens the fold. A
  // finished run shows none, as Run Health shows it no errors tab: all of it is history.
  const e = m.errors;
  if (!m.state.complete) {
    chips.push({
      text: `${c.errorsTab} ${e.total}`,
      tone: e.warn ? "warn" : e.total === 0 && !m.partialAudit ? "ok" : "mute",
    });
  }
  const hooks = m.waits.hooks.state;
  if (!m.state.complete && (hooks === "stale" || hooks === "never")) {
    chips.push({ text: c.diagHooks, tone: "warn" });
  }
  const flagged = chips.some((x) => x.tone === "warn" || x.tone === "bad");
  const stale = SOURCE_ORDER.filter((k) => m.provenance[k].stale).map((k) => c.sourceNames[k]);
  if (stale.length > 0) chips.push({ text: c.diagStale(stale.join(", ")), tone: "warn" });
  return `<details class="diag card" id="diag" data-key="diag"${flagged ? " open" : ""}><summary><b>${esc(
    c.diagTitle,
  )}</b>${chips
    .map((x) => `<span class="diag-chip ${x.tone}">${esc(x.text)}</span>`)
    .join(
      "",
    )}</summary><div class="diag-body">${renderRunHealth(m, s)}${renderSources(m, s)}</div></details>`;
}

// ── Grid, drill-downs, sources ───────────────────────────────────────────────

/**
 * The full panels, in tab order: progress → overview, usage → credit or tokens, time →
 * timing, agents → who did the delegated work. They open under the tiles rather than on the page by
 * default — the page should open on the summary, not on 20 screens of tables.
 */
export function kpiPanels(m: DashboardModel, s: Strings): KpiPanel[] {
  const usage =
    m.usage.kind === "claude"
      ? renderTokens(m.usage.tokens, m.usage.tokens.trend.window, s)
      : renderCredit(m.usage.credit, m.usage.credit.trend.window, s);
  const usageTitle = m.usage.kind === "claude" ? s.usage.tokenSection : s.usage.creditSection;
  return [
    { id: DRILL.overview, title: s.overview.sectionProgress, html: renderOverview(m, s) },
    { id: DRILL.usage, title: usageTitle, html: usage },
    { id: DRILL.timeline, title: s.timeline.section, html: renderTimeline(m, s) },
    { id: DRILL.agents, title: s.agents.section, html: renderAgents(m, s) },
  ];
}

// SHOW_DEFERRALS — deferred decisions as a box under the grid. Off since 2026-10-17: readers do not read the whole ledger here, and the run's own terminal
// answers it when asked. Unmounted, not deleted — the ledger is still read, the
// Unresolved card still summarises it, and turning this on brings the box back with the
// card's "see all" link to it.
const SHOW_DEFERRALS = false;

/** The deferrals ledger in full, as its own box — empty while SHOW_DEFERRALS is off. */
export function renderDeferralBox(m: DashboardModel, s: Strings): string {
  return SHOW_DEFERRALS ? renderDeferrals(m, s) : "";
}

/** Sources in the order a reader checks them: the ledger, the state file, then the rest. */
const SOURCE_ORDER: SourceKind[] = [
  "audit",
  "state.md",
  "disk",
  "hooks-health",
  "runtime-graph",
  "stage-graph",
  "agent-catalog",
];

function staleText(p: Provenance, s: Strings): string | undefined {
  const r = p.staleReason;
  if (!r) return undefined;
  switch (r.code) {
    case "graph-behind":
      return s.freshness.graphBehind(
        hours(r.lagSec),
        r.sensorDrift
          ? s.freshness.sensorDrift(r.sensorDrift.fired, r.sensorDrift.missing)
          : undefined,
      );
    case "graph-unreadable":
      return s.freshness.graphUnreadable;
    case "stage-graph-missing":
      return s.freshness.stageGraphMissing;
  }
}

/**
 * One line naming every source and how old it is. It replaces nothing: the per-source
 * provenance was always in the model; this is where the page states it, once, instead
 * of badging every number. A stale source is outlined so it is findable without
 * colour, and its reason is the hover text.
 */
export function renderSources(m: DashboardModel, s: Strings): string {
  const parts = SOURCE_ORDER.map((k) => {
    const p = m.provenance[k];
    const name = s.cards.sourceNames[k];
    const age = p.ageSec === undefined ? s.cards.sourceMissing : s.cards.sourceAge(dur(p.ageSec));
    const stale = p.stale ? ` · ${s.cards.sourceStale}` : "";
    const tip = staleText(p, s);
    return `<span class="src${p.stale ? " stale" : ""}${p.ageSec === undefined ? " missing" : ""}"${
      tip ? ` title="${esc(tip)}"` : ""
    }>${esc(name)} · ${esc(age)}${esc(stale)}</span>`;
  });
  return `<div class="sources"><span class="src-l">${esc(s.cards.sourcesLabel)}</span>${parts.join(
    "",
  )}</div>`;
}
