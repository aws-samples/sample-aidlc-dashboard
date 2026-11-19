// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * UsageParser tests — covered by golden fixtures on the five axes of team.md ## Testing Posture:
 *  (1) many variants of the normal format  (2) total parse failure  (3) partial parse
 *  (4) boundary values                     (5) fallback trigger (raw output and reason kept)
 * No CLI is called (a pure function on string input). A port absorbed into the aidlc-dashboard native tree.
 */

import { describe, expect, test } from "bun:test";
import { parseUsage } from "./usage-parser";

const FIXTURE_DIR = `${import.meta.dir}/fixtures`;

async function loadFixture(name: string): Promise<string> {
  return await Bun.file(`${FIXTURE_DIR}/${name}`).text();
}

describe("UsageParser — axis 1: many variants of the normal format", () => {
  test("extracts Korean labels + thousands commas + % correctly", async () => {
    const result = parseUsage(await loadFixture("normal-ko.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("Pro");
    expect(result.data.usedAmount).toBe(4553.86);
    expect(result.data.remainingAmount).toBe(5446.14);
    expect(result.data.planLimit).toBe(10000);
    expect(result.data.usageRatio).toBeCloseTo(0.455, 5);
    expect(result.data.resetDate).toBe("2026-09-01");
    expect(result.data.partial).toBe(false);
  });

  test("extracts the English colon-separated format the same way", async () => {
    const result = parseUsage(await loadFixture("normal-en.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("Pro");
    expect(result.data.usedAmount).toBe(4553.86);
    expect(result.data.planLimit).toBe(10000);
    expect(result.data.partial).toBe(false);
  });

  test("extracts the equals-separated + aligned-spaces + 'Usage rate' alias variant", async () => {
    const result = parseUsage(await loadFixture("normal-spaced.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("Team");
    expect(result.data.usedAmount).toBe(120.5);
    expect(result.data.remainingAmount).toBe(9879.5);
    // "1.205 %" → 0.01205
    expect(result.data.usageRatio).toBeCloseTo(0.01205, 6);
    expect(result.data.resetDate).toBe("2026-12-31");
    expect(result.data.partial).toBe(false);
  });

  test("extracts the real KIRO panel format (pipe header + '(X of Y)' + progress-bar %) heuristically", async () => {
    const result = parseUsage(await loadFixture("kiro-power-panel.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("KIRO POWER");
    expect(result.data.usedAmount).toBe(4553);
    expect(result.data.planLimit).toBe(10000);
    // The progress bar's "45%" takes precedence.
    expect(result.data.usageRatio).toBeCloseTo(0.45, 5);
    // The remaining amount is not stated, so it is derived as limit - used.
    expect(result.data.remainingAmount).toBe(5447);
    expect(result.data.resetDate).toBe("9-1-2026");
    expect(result.data.partial).toBe(false);
  });
});

describe("UsageParser — axis 2: total parse failure", () => {
  test("empty/blank output is a failure carrying a reason", async () => {
    const result = parseUsage(await loadFixture("fail-empty.txt"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("Empty output");
  });

  test("an empty string passed directly also fails", () => {
    const result = parseUsage("");
    expect(result.ok).toBe(false);
  });

  test("a CLI error message has no figures, so it is classified as a failure", async () => {
    const raw = await loadFixture("fail-cli-error.txt");
    const result = parseUsage(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.raw).toBe(raw);
  });

  test("an unexpected header (help text) is classified as a failure", async () => {
    const result = parseUsage(await loadFixture("fail-unexpected-header.txt"));
    expect(result.ok).toBe(false);
  });
});

describe("UsageParser — axis 3: partial parse", () => {
  test("missing plan name and reset date: only the obtained fields are filled, partial=true", async () => {
    const result = parseUsage(await loadFixture("partial-missing-reset-plan.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.usedAmount).toBe(800);
    expect(result.data.remainingAmount).toBe(9200);
    expect(result.data.planLimit).toBe(10000);
    // The usage ratio is filled in from used/limit.
    expect(result.data.usageRatio).toBeCloseTo(0.08, 5);
    expect(result.data.planName).toBeNull();
    expect(result.data.resetDate).toBeNull();
    expect(result.data.partial).toBe(true);
  });
});

describe("UsageParser — axis 4: boundary values", () => {
  test("keeps 0 credits as 0, not null", async () => {
    const result = parseUsage(await loadFixture("zero-credits.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.usedAmount).toBe(0);
    expect(result.data.usageRatio).toBe(0);
    expect(result.data.partial).toBe(false);
  });

  test("extracts a very large value with no precision loss", async () => {
    const result = parseUsage(await loadFixture("large-values.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.usedAmount).toBe(987654321.99);
    expect(result.data.planLimit).toBe(1000000000);
  });

  test("a non-numeric token is null, a negative value is kept as is", async () => {
    const result = parseUsage(await loadFixture("boundary-nonnumeric-negative.txt"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.usedAmount).toBeNull(); // "N/A"
    expect(result.data.remainingAmount).toBe(-50); // the negative value is kept
    expect(result.data.usageRatio).toBeNull(); // "not available" + no used → cannot be filled in
    expect(result.data.resetDate).toBe("unknown");
    expect(result.data.partial).toBe(true);
  });
});

describe("UsageParser — axis 5: fallback trigger (raw output and reason kept) & no throw", () => {
  test("on failure, keeps the raw output and the reason together", () => {
    const raw = "a completely unknown format blah blah";
    const result = parseUsage(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.raw).toBe(raw);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("parses without crashing even with ANSI colour codes mixed in", () => {
    const raw = "\x1b[32mPlan: Pro\x1b[0m\nUsed: 100\nLimit: 200\n";
    const result = parseUsage(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.planName).toBe("Pro");
    expect(result.data.usedAmount).toBe(100);
    expect(result.data.usageRatio).toBeCloseTo(0.5, 5);
  });

  test("never throws, whatever the input (returns values only)", () => {
    // @ts-expect-error a deliberately wrong type is injected — checks the defence.
    expect(() => parseUsage(null)).not.toThrow();
    // @ts-expect-error a deliberately wrong type is injected — checks the defence.
    expect(() => parseUsage(undefined)).not.toThrow();
    // @ts-expect-error a deliberately wrong type is injected — checks the defence.
    expect(() => parseUsage(12345)).not.toThrow();
  });
});
