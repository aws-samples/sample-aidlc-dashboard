// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Where a per-unit Construction stage writes its artifacts — per unit, or once at stage
// level. A transcription of the 2.11.4 engine's `usesStageLevelPerUnitArtifacts`
// (aidlc-lib.ts) with the readers it stands on, `effectivePlanAction`, `parseCheckboxes`
// and `cursorPastStage`.
//
// 2.11.4 added a third test: an EXECUTE Units Generation whose row exists, is not
// completed, and has the cursor past it (Current Stage later in the stage graph, or
// `none`) is stage level too — a runtime-skipped `[S] units-generation — EXECUTE`, or one
// the run walked past, left no units. It also reads completion from the FIRST
// units-generation row (`.find`), where 2.11.0 accepted any checked row.
//
// The engine's rule: when the approved plan does not EXECUTE Units Generation (the Unit
// DAG's producer), there are no units — a per-unit stage runs once, its artifacts live
// under `construction/<stage>/` (`producesDirsForStage`, the artifact resolver), and
// `unit start/complete` is refused. Units Generation that already COMPLETED keeps its
// units when a later recompose drops it (#1401), so the work carries on per unit.
//
// Six of the 2.11.0 scope grid's eleven scopes skip Units Generation (bugfix, express,
// infra, poc, refactor, security-patch), so this is those scopes' default shape, not an
// edge case. A matrix drawn there has no unit to stand for: with no DAG the page said
// "units-generation has not been reached" — a stage the plan never runs — and with a DAG
// left in the graph by an earlier plan, every cell judged a per-unit path the engine
// does not read.
//
// One deliberate difference: with no readable action and Units Generation not completed,
// the engine's function answers "stage level" (`undefined !== "EXECUTE"`) and most of its
// callers follow it, but the strict artifact resolver refuses that state outright ("Units
// Generation has no effective action"). This reader cannot tell which the run meant, so
// it returns `unknown`: the matrix is drawn as before this module, and says the placement
// was not readable. A completed Units Generation is per-unit with or without an action,
// as in the engine.
//
// The grid is the harness's compiled `scope-grid.json` as-is. The engine's
// `loadScopeMapping` also joins scope metadata and honours an `AIDLC_SCOPE_MAPPING`
// override; neither is reproduced, so a grid-only scope or an overridden mapping can read
// differently. On a matched install the two agree.

import type { ScopeGrid } from "./parser";

export type UnitArtifactMode = "per-unit" | "stage-level" | "unknown";

const UNITS_GENERATION = "units-generation";

/** `getField`: the first `- **<name>**: <value>` line, trimmed. */
export function stateField(text: string, name: string): string | undefined {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^- \\*\\*${esc}\\*\\*:[ \\t]*(.*)$`, "m").exec(text);
  return m?.[1]?.trim();
}

/**
 * `parseStateStageSuffixes(content).get(slug)`: every matching row in the file, the LAST
 * one winning (a Map set in order) — the engine does not confine the scan to Stage
 * Progress, so neither does this.
 */
function stateSuffix(text: string, slug: string): "EXECUTE" | "SKIP" | undefined {
  const re = /^- \[[ xSR?-]\] (\S+)\s*—\s*(EXECUTE|SKIP)\b/gm;
  let out: "EXECUTE" | "SKIP" | undefined;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1] === slug) out = m[2] as "EXECUTE" | "SKIP";
  }
  return out;
}

/** `parseCheckboxes(content).find(c => c.slug === slug)?.state` as its raw glyph. */
function firstBox(text: string, slug: string): string | undefined {
  const re = /^- \[([ xSR?-])\] (\S+)\s*—\s*(.*)$/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[2] === slug) return m[1];
  }
  return undefined;
}

/**
 * `cursorPastStage(state, "units-generation")` over the stage graph's order. With no order
 * the answer is known only where it does not depend on one: no cursor, `none` (every
 * engine graph holds Units Generation), or the cursor on Units Generation itself.
 */
function cursorPastUnitsGeneration(
  text: string,
  order: readonly string[] | undefined,
): boolean | undefined {
  const current = stateField(text, "Current Stage") ?? "";
  if (current === "") return false;
  if (order === undefined) {
    if (current === "none") return true;
    return current === UNITS_GENERATION ? false : undefined;
  }
  const at = order.indexOf(UNITS_GENERATION);
  if (at < 0) return false;
  if (current === "none") return true;
  const now = order.indexOf(current);
  return now >= 0 && now > at;
}

/**
 * The run's per-unit artifact placement, read from the state text, the compiled scope
 * grid and the stage graph's slug order. Never throws.
 */
export function unitArtifactMode(
  stateText: string,
  scopeGrid?: ScopeGrid,
  stageOrder?: readonly string[],
): UnitArtifactMode {
  const box = firstBox(stateText, UNITS_GENERATION);
  // Completion keeps the units whatever the action reads.
  if (box === "x") return "per-unit";
  const scope = stateField(stateText, "Scope");
  // `effectivePlanAction`: the state's suffix (recompose and project-type overrides),
  // else the stock scope grid.
  const action =
    stateSuffix(stateText, UNITS_GENERATION) ??
    (scope ? scopeGrid?.[scope]?.[UNITS_GENERATION] : undefined);
  if (action === undefined) return "unknown";
  if (action !== "EXECUTE") return "stage-level";
  if (box === undefined) return "per-unit";
  const past = cursorPastUnitsGeneration(stateText, stageOrder);
  if (past === undefined) return "unknown";
  return past ? "stage-level" : "per-unit";
}
