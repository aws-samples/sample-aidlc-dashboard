// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// CreditView unit tests — u3-credit-view (Step 7).
//
// Runner: bun:test. Server-side string rendering, so it is checked by string assertions with no DOM.
// Per the team norm (team.md ## Testing Posture) it must include per-state rendering, escaping of hostile
// input and no placeholder leaks. Also covers the window-toggle radiogroup, the resolveWindow fallback
// and the no-JS controls.

import { strings } from "../../render/i18n";

/** The tests assert the Korean locale's output (those strings stay Korean on purpose) — the existing expected strings stay valid. */
const KO = strings("ko");
import { describe, expect, test } from "bun:test";
import type { TrendSeries } from "../trend/trend";
import type { ParsedUsage } from "../types";
import type { CreditStatus, CreditViewModel } from "./credit-model";
import { renderCredit, resolveWindow } from "./credit-view";

function usage(overrides: Partial<ParsedUsage> = {}): ParsedUsage {
  return {
    planName: "Pro",
    usedAmount: 120,
    remainingAmount: 380,
    planLimit: 500,
    usageRatio: 0.24,
    resetDate: "2026-09-01",
    partial: false,
    ...overrides,
  };
}

function emptyTrend(): TrendSeries {
  return { window: "30d", points: [], summary: { latest: null, min: null, max: null, count: 0 } };
}

function filledTrend(): TrendSeries {
  return {
    window: "30d",
    points: [
      { ts: "2026-08-15T00:00:00.000Z", value: 100, ok: true },
      { ts: "2026-08-16T00:00:00.000Z", value: 200, ok: true },
    ],
    summary: { latest: 200, min: 100, max: 200, count: 2 },
  };
}

function model(status: CreditStatus, overrides: Partial<CreditViewModel> = {}): CreditViewModel {
  const base: CreditViewModel = {
    status,
    current: status === "none" || status === "loading" ? null : usage(),
    lastSuccessAt: status === "none" || status === "loading" ? null : "2026-08-16T11:57:00.000Z",
    freshness: {
      stale: false,
      lastSuccessAt: status === "none" || status === "loading" ? null : "2026-08-16T11:57:00.000Z",
    },
    trend: status === "none" || status === "loading" ? emptyTrend() : filledTrend(),
    warning: null,
    pollHalt: null,
  };
  return { ...base, ...overrides };
}

describe("renderCredit per-state rendering", () => {
  test("loading: announces that the first collection is running", () => {
    const html = renderCredit(model("loading"), "30d", KO);
    expect(html).toContain("수집 중");
    expect(html).toContain('role="status"');
  });

  test("none: the 'no data' placeholder, no gauge, no warning banner", () => {
    const html = renderCredit(model("none"), "30d", KO);
    expect(html).toContain("아직 수집된 크레딧 데이터가 없습니다");
    expect(html).not.toContain("최신 데이터를 가져오지 못했습니다");
  });

  test("ok: renders plan name and usage ratio, no gauge, no warning banner", () => {
    const html = renderCredit(model("ok"), "30d", KO);
    // The table and the bar state the ratio — no donut gauge (stroke-dasharray ring) is drawn.
    expect(html).not.toContain("stroke-dasharray");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("Pro");
    expect(html).toContain("24.0%");
    expect(html).not.toContain("최신 데이터를 가져오지 못했습니다");
  });

  test("partial: partial-data badge + missing '—'", () => {
    const partial = model("partial", {
      current: usage({ remainingAmount: null, usageRatio: null, partial: true }),
    });
    const html = renderCredit(partial, "30d", KO);
    expect(html).toContain("부분 데이터");
    expect(html).toContain("—");
  });

  test("stale: a badge independent of the state + the last success value kept", () => {
    const html = renderCredit(
      model("ok", {
        freshness: {
          stale: true,
          lastSuccessAt: "2026-08-16T11:30:00.000Z",
        },
      }),
      "30d",
      KO,
    );
    expect(html).toContain("오래된 데이터");
    expect(html).toContain("Pro");
  });

  test("failure: warning banner + reason shown + the last success value kept", () => {
    const failure = model("failure", {
      warning: { raw: "raw usage dump", reason: "timeout" },
    });
    const html = renderCredit(failure, "30d", KO);
    expect(html).toContain("최신 데이터를 가져오지 못했습니다");
    expect(html).toContain("timeout");
    expect(html).toContain("Pro");
  });

  test("failure + stale: shows the failure banner and the stale-value warning together", () => {
    const html = renderCredit(
      model("failure", {
        warning: { raw: "raw usage dump", reason: "timeout" },
        freshness: {
          stale: true,
          lastSuccessAt: "2026-08-16T11:30:00.000Z",
        },
      }),
      "30d",
      KO,
    );
    expect(html).toContain("최신 데이터를 가져오지 못했습니다");
    expect(html).toContain("10분 이상 경과");
  });

  test("the polling slowdown says, apart from the failure banner, why it slowed and how it recovers", () => {
    const html = renderCredit(
      model("failure", {
        pollHalt: {
          failures: 5,
          retryEveryMs: 1_800_000,
          lastReason: "collection failed: timeout (over 15000ms)",
        },
      }),
      "30d",
      KO,
    );
    // "The last attempt failed" and "so it no longer tries" are different facts.
    expect(html).toContain("자동 수집 주기를 30분으로 늘렸습니다");
    expect(html).toContain("5분마다 두드리지 않기 위해서");
    expect(html).toContain("한 번이라도 성공하면 원래 주기로 돌아옵니다");
    expect(html).toContain("마지막 실패 사유: collection failed: timeout (over 15000ms)");
  });

  test("no slowdown, no notice", () => {
    expect(renderCredit(model("ok"), "30d", KO)).not.toContain("자동 수집 주기를");
  });

  test("the English catalogue gives the slowdown notice too", () => {
    const html = renderCredit(
      model("failure", { pollHalt: { failures: 5, retryEveryMs: 1_800_000 } }),
      "30d",
      strings("en"),
    );
    expect(html).toContain("After 5 consecutive failures");
    expect(html).toContain("not polled every five minutes");
  });
});

describe("renderCredit escapes hostile input (NFR1.1)", () => {
  test("planName's <script>, quotes and angle brackets are escaped (no raw markup injected)", () => {
    const evil = '<script>alert("x")</script>';
    const html = renderCredit(model("ok", { current: usage({ planName: evil }) }), "30d", KO);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("markup in warning.raw/warning.reason is escaped", () => {
    const html = renderCredit(
      model("failure", {
        warning: { raw: '<img src=x onerror="alert(1)">', reason: "<b>parse failed</b>" },
      }),
      "30d",
      KO,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>parse failed</b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("renderCredit leaks no placeholders (NFR1.2)", () => {
  test("no undefined/NaN/[object Object] in the none render", () => {
    const html = renderCredit(model("none"), "30d", KO);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("[object Object]");
  });

  test("no undefined/NaN/[object Object] in the partial (many missing) render", () => {
    const partial = model("partial", {
      current: usage({
        planName: null,
        usedAmount: null,
        remainingAmount: null,
        planLimit: null,
        usageRatio: null,
        resetDate: null,
        partial: true,
      }),
    });
    const html = renderCredit(partial, "30d", KO);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("[object Object]");
  });
});

describe("renderCredit window toggle, controls, accessibility", () => {
  test("window toggle: ?cw=7d|30d|all links + aria-checked='true' on the current window", () => {
    const html = renderCredit(model("ok"), "7d", KO);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("?cw=7d");
    expect(html).toContain("?cw=30d");
    expect(html).toContain("?cw=all");
    // The current window (7d) is aria-checked=true, the rest false.
    expect(html).toMatch(/aria-checked="true" href="\?cw=7d"/);
    expect(html).toMatch(/aria-checked="false" href="\?cw=30d"/);
  });

  test("the credit card renders no duplicate refresh control", () => {
    const html = renderCredit(model("ok"), "30d", KO);
    expect(html).not.toContain("새로고침");
    expect(html).not.toContain("/api/credit/refresh");
  });

  test("host look and feel: section(.card) wrapper, host tokens", () => {
    const html = renderCredit(model("ok"), "30d", KO);
    expect(html).toContain('class="card"');
    expect(html).toContain("var(--accent)");
  });
});

describe("resolveWindow allowlist (NFR1.3)", () => {
  test("valid values are accepted as is", () => {
    expect(resolveWindow("7d")).toBe("7d");
    expect(resolveWindow("30d")).toBe("30d");
    expect(resolveWindow("all")).toBe("all");
  });

  test("invalid/injected/absent → 30d fallback", () => {
    expect(resolveWindow(undefined)).toBe("30d");
    expect(resolveWindow(null)).toBe("30d");
    expect(resolveWindow("")).toBe("30d");
    expect(resolveWindow("90d")).toBe("30d");
    expect(resolveWindow("7d'; DROP TABLE--")).toBe("30d");
    expect(resolveWindow("<script>")).toBe("30d");
  });
});
