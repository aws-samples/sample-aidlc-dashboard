// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * token-model unit tests. Pure functions, so they take aggregate literals with no file I/O.
 */

import { describe, expect, test } from "bun:test";
import { assembleTokens } from "./token-model";
import type { TranscriptAggregate } from "./transcript-reader";

function agg(over: Partial<TranscriptAggregate> = {}): TranscriptAggregate {
  return {
    dir: "/home/user/.claude/projects/-ws",
    triedPath: "/home/user/.claude/projects/-ws",
    totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
    byModel: [
      {
        model: "claude-opus-5",
        totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
        messages: 1,
      },
    ],
    daily: [
      { date: "2026-08-24", total: 500 },
      { date: "2026-08-25", total: 660 },
    ],
    messages: 1,
    sidechainMessages: 0,
    sessions: 1,
    firstAt: "2026-08-24T10:00:00Z",
    lastAt: "2026-08-25T10:00:00Z",
    filesRead: 1,
    filesSkipped: 0,
    filesCapped: 0,
    malformedLines: 0,
    unreadableFiles: 0,
    sessionTime: null,
    ...over,
  };
}

describe("assembleTokens", () => {
  test("a normal aggregate → ok, and the total is the four buckets other than thinking", () => {
    const m = assembleTokens(agg(), "30d");
    expect(m.status).toBe("ok");
    expect(m.grandTotal).toBe(1160);
    expect(m.notes).toEqual([]);
    expect(m.lastActivityAt).toBe("2026-08-25T10:00:00Z");
  });

  test("the cache hit ratio's denominator is the three prompt buckets — output is not in it", () => {
    // input 10 + cacheRead 1000 + cacheCreate 50 = 1060; output 100 is outside the denominator.
    const m = assembleTokens(agg(), "30d");
    expect(m.cachedPromptRatio).toBeCloseTo(1000 / 1060, 10);
  });

  test("with only cache creation the hit ratio is 0 — where dropping cacheCreate read 100%", () => {
    const m = assembleTokens(
      agg({ totals: { input: 0, output: 500, cacheRead: 0, cacheCreate: 9000, thinking: 0 } }),
      "30d",
    );
    expect(m.cachedPromptRatio).toBe(0);
  });

  test("no prompt tokens → null, not a claimed 0", () => {
    const m = assembleTokens(
      agg({ totals: { input: 0, output: 120, cacheRead: 0, cacheCreate: 0, thinking: 0 } }),
      "30d",
    );
    expect(m.cachedPromptRatio).toBeNull();
  });

  test("no session times → null, and the state is not made partial", () => {
    const m = assembleTokens(agg(), "30d");
    expect(m.sessionTime).toBeNull();
    expect(m.status).toBe("ok");
  });

  test("session times convert to seconds and carry the API share", () => {
    const m = assembleTokens(
      agg({
        sessionTime: {
          sessions: 3,
          straddling: 0,
          totalMs: 7_200_000,
          apiMs: 1_800_000,
          toolMs: 600_000,
        },
      }),
      "30d",
    );
    expect(m.sessionTime).toEqual({
      sessions: 3,
      straddling: 0,
      totalSec: 7200,
      apiSec: 1800,
      toolSec: 600,
      apiRatio: 0.25,
    });
  });

  test("a straddling session makes neither partial nor a note — it is normal, not a defect", () => {
    const m = assembleTokens(
      agg({
        sessionTime: { sessions: 1, straddling: 4, totalMs: 1000, apiMs: 100, toolMs: 0 },
      }),
      "7d",
    );
    expect(m.status).toBe("ok");
    expect(m.notes).toEqual([]);
    expect(m.sessionTime?.straddling).toBe(4);
  });

  test("a session wall clock of 0 → API share null, not a claimed 0", () => {
    const m = assembleTokens(
      agg({ sessionTime: { sessions: 1, straddling: 0, totalMs: 0, apiMs: 0, toolMs: 0 } }),
      "30d",
    );
    expect(m.sessionTime?.apiRatio).toBeNull();
  });

  test("no messages → none", () => {
    const m = assembleTokens(agg({ messages: 0, daily: [], byModel: [] }), "7d");
    expect(m.status).toBe("none");
    expect(m.trend.summary.count).toBe(0);
  });

  test("directory not found → the note names the path tried", () => {
    const m = assembleTokens(agg({ dir: null, messages: 0, triedPath: "/home/user/x/-ws" }), "30d");
    expect(m.status).toBe("none");
    expect(m.notes).toEqual([{ code: "no-transcripts", triedPath: "/home/user/x/-ws" }]);
  });

  test("hitting the byte cap → partial, and says the count is short", () => {
    const m = assembleTokens(agg({ filesCapped: 3 }), "all");
    expect(m.status).toBe("partial");
    expect(m.notes.map((n) => n.code)).toContain("files-capped");
  });

  test("capped to zero messages is partial, not none", () => {
    // A single file over 128MB leaves filesRead 0 and messages 0. Returning none here would show
    // "no usage — try a wider window", but there is usage, and a wider window hits the cap harder —
    // exactly where the no-silent-truncation rule would break.
    const m = assembleTokens(
      agg({ messages: 0, filesRead: 0, filesCapped: 1, daily: [], byModel: [] }),
      "30d",
    );
    expect(m.status).toBe("partial");
    expect(m.notes.map((n) => n.code)).toContain("files-capped");
  });

  test("only broken lines and zero messages is still partial", () => {
    const m = assembleTokens(
      agg({ messages: 0, malformedLines: 5, daily: [], byModel: [] }),
      "30d",
    );
    expect(m.status).toBe("partial");
  });

  test("broken lines and read failures surface as partial", () => {
    expect(assembleTokens(agg({ malformedLines: 2 }), "30d").status).toBe("partial");
    expect(assembleTokens(agg({ unreadableFiles: 1 }), "30d").status).toBe("partial");
  });

  test("the daily aggregate turns into a TrendSeries for the chart", () => {
    const m = assembleTokens(agg(), "30d");
    expect(m.trend.window).toBe("30d");
    expect(m.trend.points.map((p) => p.value)).toEqual([500, 660]);
    expect(m.trend.summary).toEqual({ latest: 660, min: 500, max: 660, count: 2 });
    // Every point is measured, so there is no missing (ok=false) one.
    expect(m.trend.points.every((p) => p.ok)).toBe(true);
  });
});
