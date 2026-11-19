// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// svg-chart unit tests — u3-credit-view (Step 3).
//
// Runner: bun:test. A pure string builder, so it is checked by string assertions with no DOM. Covers
// the gauge (ratio, null), the line chart (break at a missing value, empty state), host tokens and escapeXml.

import { strings } from "../../render/i18n";

/** The tests assert the Korean locale's output (kept in Korean on purpose) — the existing expected strings stay valid. */
const KO = strings("ko");
import { describe, expect, test } from "bun:test";
import type { TrendSeries } from "../trend/trend";
import { escapeXml, renderLineChart } from "./svg-chart";

function series(points: TrendSeries["points"]): TrendSeries {
  const values = points.filter((p) => p.value !== null).map((p) => p.value as number);
  return {
    window: "30d",
    points,
    summary: {
      latest: values.length > 0 ? (values[values.length - 1] ?? null) : null,
      min: values.length > 0 ? Math.min(...values) : null,
      max: values.length > 0 ? Math.max(...values) : null,
      count: values.length,
    },
  };
}

describe("renderLineChart", () => {
  test("breaks the line at a missing point (polyline split)", () => {
    const s = series([
      { ts: "2026-08-14T00:00:00.000Z", value: 100, ok: true },
      { ts: "2026-08-15T00:00:00.000Z", value: null, ok: false },
      { ts: "2026-08-16T00:00:00.000Z", value: 300, ok: true },
    ]);
    const svg = renderLineChart(s, KO);
    // Two points carry values, but a missing one splits them into two polylines (one point each).
    const polylines = svg.match(/<polyline/g) ?? [];
    expect(polylines.length).toBe(2);
  });

  test("no values → the empty-state text + role/aria", () => {
    const s = series([{ ts: "2026-08-16T00:00:00.000Z", value: null, ok: false }]);
    const svg = renderLineChart(s, KO);
    expect(svg).toContain("표시할 데이터가 없습니다");
    expect(svg).toContain('role="img"');
    expect(svg).toContain("aria-label=");
  });

  test("uses host tokens (--accent/--line/--mute), no hard-coded --color-*", () => {
    const s = series([
      { ts: "2026-08-15T00:00:00.000Z", value: 100, ok: true },
      { ts: "2026-08-16T00:00:00.000Z", value: 200, ok: true },
    ]);
    const svg = renderLineChart(s, KO);
    expect(svg).toContain("var(--accent)");
    expect(svg).toContain("var(--line)");
    expect(svg).not.toContain("--color-");
  });
});

describe("escapeXml", () => {
  test("escapes dangerous characters", () => {
    expect(escapeXml("<script>\"&'")).toBe("&lt;script&gt;&quot;&amp;&#39;");
  });

  test("the empty-state label uses the mute token", () => {
    const s = series([]);
    const svg = renderLineChart(s, KO);
    expect(svg).toContain("var(--mute)");
  });
});
