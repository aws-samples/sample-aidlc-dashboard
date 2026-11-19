// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The journey: every stage the state lists, as one column per phase read top to bottom,
// with ONE current position and the units beneath it. It replaces the Stage and Unit
// cards — which split "where is the run" across two cards, a tab per phase and a stage
// per unit card — and keeps each rule those cards carried:
//
//   - One row per stage SLUG, folded as the Stage card folded it (`foldStage`): a stage is
//     done only when every executed copy is, and a copy at its gate outranks one that is
//     working, because the one that needs the reader is the one to show.
//   - Stage time is WORK + CONVERSATION, the two buckets the timing panel classifies,
//     never elapsed wall time; a stage with no audit span states no time at all.
//   - A unit cell is judged on REQUIRED artifacts. Optional ones never block coverage, so
//     the fraction in its tip counts only the required set, and with none there is no
//     denominator — the tip gives the file count.
//
// Three kinds of "not run" stay apart because they mean different things to a reader:
// out of this plan's scope (`— SKIP`, `execute` false), skipped at runtime (`[S]`), and
// not reached yet. Out-of-scope rows are hidden by default — on a stock plan they are
// more than half the board — and one checkbox shows them; the poll keeps its state.
//
// The current position is `waits.position` (the engine's own unit-major position), not
// Current Stage, and it is drawn once.
//
// State is never carried by shape and colour alone: each stage row carries its kind as
// visually hidden text after the name, and each unit cell an aria-label with the same
// words as its tooltip — an accessibility-tree read of the first cut found "in progress",
// "not yet" and "out of scope" reading as the bare stage name. When the reader could not confirm it, the tag says
// so instead of claiming a place. Its tone follows the person's holds: amber when
// something waits on them (`humanTally`), blue otherwise.

import { buildStatus, humanTally } from "../model/status";
import type { DashboardModel } from "../model/types";
import type { CellState, MatrixCell, MatrixStage } from "../scan/matrix";
import type { PhaseInfo, StageInfo } from "../scan/parser";
import { DRILL } from "./card-kit";
import { esc, hours } from "./common";
import type { Strings } from "./i18n";
import { cellTip } from "./overview";

/** A folded stage row's kind — the parser's status plus the two "not run" causes. */
export type StageKind = "done" | "active" | "awaiting" | "revising" | "todo" | "skip" | "out";

/**
 * One kind per slug. Copies that were all excluded by scope are `out`; executed copies
 * that were all skipped at runtime are `skip`; otherwise the Stage card's fold — done only
 * when every executed copy is, then awaiting > revising > active, and a mix of finished
 * and not-started with none on it now is `todo`, never "active".
 */
export function foldStage(copies: StageInfo[]): StageKind {
  if (copies.every((c) => !c.execute)) return "out";
  const run = copies.filter((c) => c.execute && c.status !== "skipped");
  if (run.length === 0) return "skip";
  if (run.every((c) => c.status === "done")) return "done";
  for (const st of ["awaiting", "revising", "active"] as const) {
    if (run.some((c) => c.status === st)) return st;
  }
  return "todo";
}

interface StageRow {
  slug: string;
  display: string;
  kind: StageKind;
}

function phaseRows(phase: PhaseInfo): StageRow[] {
  const bySlug = new Map<string, StageInfo[]>();
  for (const st of phase.stages) {
    const list = bySlug.get(st.slug);
    if (list) list.push(st);
    else bySlug.set(st.slug, [st]);
  }
  return [...bySlug.entries()].map(([slug, copies]) => ({
    slug,
    display: (copies[0] as StageInfo).display,
    kind: foldStage(copies),
  }));
}

/** Work + conversation for a stage, or undefined when the audit holds no span for it. */
function stageTime(m: DashboardModel, slug: string): number | undefined {
  const sp = m.timing.stages.find((t) => t.stage === slug);
  return sp ? sp.observedSec + sp.conversationSec : undefined;
}

// ── Units ────────────────────────────────────────────────────────────────────

/** The cell's class: the matrix's seven states, none folded into another. */
const CELL_CLASS: Record<CellState, string> = {
  complete: "done",
  partial: "part",
  unsettled: "unset",
  unverified: "unver",
  skipped: "skip",
  "n/a": "na",
  absent: "todo",
};

/** Required artifacts met, as the Unit card stated it — see the header. */
function cellFigure(c: MatrixCell): string {
  if (c.state === "n/a") return "";
  const total = c.required.length;
  if (total === 0) return String(c.present.length);
  return `${total - c.missing.length}/${total}`;
}

function unitBlock(m: DashboardModel, s: Strings): string {
  const j = s.journey;
  const stages: MatrixStage[] =
    m.matrix?.stages.filter((st) => st.execute && st.status !== "skipped") ?? [];
  const link = `<a href="#${DRILL.matrix}" data-drill="${DRILL.matrix}">${esc(j.matrixLink)}</a>`;
  if (!m.matrix || stages.length === 0 || m.matrix.units.length === 0) {
    const why =
      m.unitArtifactMode === "stage-level"
        ? s.overview.stageLevelUnits
        : m.unitDag.state === "malformed"
          ? s.overview.unitDagMalformed(m.unitDag.reason, m.unitDag.stop)
          : s.overview.noUnits;
    return `<div class="jr-units"><p class="jr-units-h">${esc(j.unitsTitle)}</p><p class="jr-empty">${esc(why)} · ${link}</p></div>`;
  }
  const posUnit = m.waits.position.unit;
  const used = new Set<CellState>();
  const rows = m.matrix.units
    .map((u) => {
      const cells = stages
        .map((st) => {
          const c = st.cells.find((x) => x.unit === u.name);
          const state: CellState = c?.state ?? "absent";
          used.add(state);
          const fig = c ? cellFigure(c) : "";
          const tip = c
            ? cellTip(c.state, c.missing, c.present, s, c.receiptReason, c.skipReason)
            : s.cards.cellLabel.absent;
          const label = `${st.display} — ${s.cards.cellLabel[state]}${fig ? ` (${fig})` : ""} · ${tip}`;
          return `<i class="jr-c ${CELL_CLASS[state]}" role="img" aria-label="${esc(label)}" title="${esc(label)}"></i>`;
        })
        .join("");
      const done = stages.every((st) => {
        const state = st.cells.find((x) => x.unit === u.name)?.state ?? "absent";
        return state === "complete" || state === "skipped" || state === "n/a";
      });
      const here = u.name === posUnit;
      const tag = here ? j.unitHere : done ? j.unitDone : "";
      return `<li class="jr-u${here ? " here" : ""}"><span class="jr-un">${esc(u.name)}</span><span class="jr-cs">${cells}</span><span class="jr-us">${esc(tag)}</span></li>`;
    })
    .join("");
  const order: CellState[] = [
    "complete",
    "partial",
    "unsettled",
    "unverified",
    "skipped",
    "n/a",
    "absent",
  ];
  const legend = order
    .filter((st) => used.has(st))
    .map((st) => `<li><i class="jr-c ${CELL_CLASS[st]}"></i>${esc(s.cards.cellLabel[st])}</li>`)
    .join("");
  return `<div class="jr-units"><p class="jr-units-h">${esc(j.unitsTitle)} <span>${stages
    .map((st) => esc(st.display))
    .join(
      " → ",
    )}</span> · ${link}</p><ul class="jr-ul">${rows}</ul><ul class="jr-ulg">${legend}</ul></div>`;
}

// ── Board ────────────────────────────────────────────────────────────────────

export function renderJourney(m: DashboardModel, s: Strings): string {
  const j = s.journey;
  const st = buildStatus(m);
  const complete = st.run.state === "complete";
  const pos = complete ? "" : (m.waits.position.stage ?? m.state.currentStage);
  const tone = humanTally(st.human).open > 0 ? "you" : "agent";
  const verified = m.waits.position.verified;
  const phases = m.state.phases.filter((p) => p.stages.length > 0);
  const all = phases.flatMap(phaseRows);
  const out = all.filter((r) => r.kind === "out").length;

  const cols = phases
    .map((p) => {
      const rows = phaseRows(p);
      const inScope = rows.some((r) => r.kind !== "out");
      const items = rows
        .map((r) => {
          const here = r.slug === pos;
          const t = stageTime(m, r.slug);
          const tag = here
            ? `<span class="jr-tag">${esc(tone === "you" ? j.hereYou : j.hereNow)}${
                verified ? "" : ` · ${esc(j.hereUnverified)}`
              }</span>`
            : "";
          const time =
            t !== undefined && t > 0
              ? `<span class="jr-t" title="${esc(s.cards.workChatTip)}">${esc(hours(t))}</span>`
              : "";
          const tip = `${r.display} — ${j.kind[r.kind]}${
            t !== undefined ? ` · ${j.workChat(hours(t))}` : ""
          }${here && !verified ? ` · ${s.status.runUnverifiedTip}` : ""}`;
          return `<li class="jr-s jk-${r.kind}${here ? ` here ${tone}` : ""}" title="${esc(tip)}"><span class="jr-pin"></span><span class="jr-n">${esc(
            r.display,
          )}</span>${
            // The current row is drawn as the position, not as its state.md kind, and its
            // visible tag says so; a hidden "not yet" before "your move" would contradict it.
            here ? "" : `<span class="vh">, ${esc(j.kind[r.kind])}</span>`
          }${tag}${time}</li>`;
        })
        .join("");
      const head = inScope
        ? `<span>${p.done}/${p.total}</span>`
        : `<span class="jr-ph-out">${esc(j.phaseOut)}</span>`;
      return `<li class="jr-col${inScope ? "" : " all-out"}"><p class="jr-ph">${esc(p.display)} ${head}</p><ol class="jr-track">${items}</ol></li>`;
    })
    .join("");

  const kinds: StageKind[] = ["done", "active", "awaiting", "todo", "skip", "out"];
  const legend = kinds
    .map((k) => `<li class="jr-s jk-${k}"><span class="jr-pin"></span>${esc(j.kind[k])}</li>`)
    .join("");
  const toggle =
    out > 0
      ? `<label class="jr-tog"><input type="checkbox" id="jr-show-out"> ${esc(j.showOut(out))}</label>`
      : "";
  return `<section class="journey card" id="journey"><header class="jr-head"><h2>${esc(j.title)}</h2><p>${esc(
    j.summary(all.length, all.length - out),
  )}</p>${toggle}</header><ol class="jr-board">${cols}</ol><ul class="jr-lg">${legend}</ul>${unitBlock(
    m,
    s,
  )}</section>`;
}
