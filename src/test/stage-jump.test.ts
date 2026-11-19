// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// scan/stage-jump.ts — the 2.11.4 engine's `stageJumpReaches`, shared by the receipt,
// team-gate and decision readers.

import { describe, expect, test } from "bun:test";
import { openDecisionInAttempt } from "../scan/decision-wait";
import { type StageIndex, stageJumpReaches } from "../scan/stage-jump";
import { unitGateStatus } from "../scan/team-gate";

const ORDER = ["requirements-analysis", "units-generation", "functional-design", "build-and-test"];
const index: StageIndex = Object.assign((s: string) => ORDER.indexOf(s), {
  perUnit: (s: string) => s === "functional-design",
});

describe("stageJumpReaches (2.11.4)", () => {
  test("a kept jump reaches no per-unit stage but its own target", () => {
    const kept = { Target: "requirements-analysis", "Unit Work": "kept" };
    expect(stageJumpReaches(kept, "functional-design", index)).toBe(false);
    expect(stageJumpReaches(kept, "build-and-test", index)).toBe(true);
    expect(
      stageJumpReaches({ ...kept, Target: "functional-design" }, "functional-design", index),
    ).toBe(true);
    expect(stageJumpReaches({ Target: "requirements-analysis" }, "functional-design", index)).toBe(
      true,
    );
  });

  test("a slug the catalogue lacks is not judged per-unit; with no catalogue the known five are", () => {
    const kept = { Target: "requirements-analysis", "Unit Work": "kept" };
    expect(stageJumpReaches(kept, "code-generation", index)).toBe(true);
    expect(stageJumpReaches(kept, "code-generation")).toBe(false);
    expect(stageJumpReaches(kept, "build-and-test")).toBe(true);
  });

  test("the decision and team-gate readers bound their attempt by it", () => {
    const ev = (ts: string, event: string, fields: Record<string, string>) => ({
      ts,
      event,
      fields,
      shard: "s",
    });
    const decision = [
      ev("2026-01-01T00:00:00Z", "DECISION_RECORDED", {
        Stage: "functional-design",
        Checkpoint: "x",
      }),
      ev("2026-01-01T00:01:00Z", "STAGE_JUMPED", {
        Target: "requirements-analysis",
        "Unit Work": "kept",
      }),
    ];
    expect(openDecisionInAttempt(decision, "functional-design", undefined, index)).toBeDefined();
    const gate = [
      ev("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", {
        Stage: "functional-design",
        Unit: "u1",
      }),
      ev("2026-01-01T00:01:00Z", "STAGE_JUMPED", {
        Target: "requirements-analysis",
        "Unit Work": "kept",
      }),
    ];
    expect(unitGateStatus(gate, "functional-design", "u1", "per-stage", () => true, index)).toBe(
      "awaiting-approval",
    );
  });
});
