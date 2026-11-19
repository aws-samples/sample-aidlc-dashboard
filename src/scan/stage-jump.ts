// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Does a `STAGE_JUMPED` row reach a stage — the 2.11.4 engine's `stageJumpReaches`
// (aidlc-lib.ts), transcribed once for every reader that bounds an attempt by it (unit
// receipts, the team unit gate, the open decision). Three copies of the 2.11.0 rule had
// drifted into scan/unit-receipts.ts, scan/team-gate.ts and scan/decision-wait.ts.
//
// The rule: a jump with no `Target`, or one naming the stage, reaches it; otherwise it
// reaches every stage at or after its target in stage order, and an unknown slug on
// either side reaches. 2.11.4 adds one exception: a jump that KEPT the unit work
// (`Unit Work: kept`, a backward jump that leaves the units' finished work standing) does
// not reach a per-unit stage other than its own target — its units' receipts survive it.
//
// "Per-unit" is `isPerUnitStage`: the stage's `for_each: unit-of-work`, or one of the
// engine's five known per-unit stages. With no catalogue the engine still has its own
// graph, so the known five stand in for it here.

/** A stage's position in the catalogue's order, -1 when unknown, and its per-unit flag. */
export interface StageIndex {
  (slug: string): number;
  /** `isPerUnitStage` for a slug the catalogue holds. */
  perUnit?: (slug: string) => boolean;
}

/** The engine's `KNOWN_PER_UNIT_STAGES`. */
export const KNOWN_PER_UNIT_STAGES: ReadonlySet<string> = new Set([
  "nfr-requirements",
  "nfr-design",
  "functional-design",
  "infrastructure-design",
  "code-generation",
]);

/** `stageJumpReaches(block, slug)` over a row's fields. */
export function stageJumpReaches(
  fields: Readonly<Record<string, string>>,
  slug: string,
  stageIndex?: StageIndex,
): boolean {
  const name = fields.Target;
  if (!name || name === slug) return true;
  try {
    const target = stageIndex?.(name) ?? -1;
    const at = stageIndex?.(slug) ?? -1;
    if (fields["Unit Work"] === "kept") {
      const perUnit =
        stageIndex === undefined
          ? KNOWN_PER_UNIT_STAGES.has(slug)
          : at !== -1 && (stageIndex.perUnit?.(slug) ?? KNOWN_PER_UNIT_STAGES.has(slug));
      if (perUnit) return false;
    }
    return target === -1 || at === -1 || at >= target;
  } catch {
    return true;
  }
}
