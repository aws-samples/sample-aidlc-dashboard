// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The Details area (render/kpi.ts): a tab per full panel, the panels in one closed
// <details>. The figures and charts the old KPI tiles drew now live in the summaries
// above (render/journey.ts, render/time-summary.ts) and are tested there.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { kpiPanels } from "../render/cards";
import { esc } from "../render/common";
import { strings } from "../render/i18n";
import { KPI_CSS, renderKpis } from "../render/kpi";
import { renderBody, renderPage } from "../render/page";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);
const ko = strings("ko");
const en = strings("en");

describe("Details", () => {
  test("a tab per panel, named for its panel; one radio group the poll restores", () => {
    const html = renderKpis(base, ko, kpiPanels(base, ko));
    expect(html.match(/<input class="mc-r kpi-r" type="radio" name="mc-kpi"/g)?.length).toBe(4);
    expect(html.match(/ checked>/g)?.length).toBe(1);
    const tabs = [...html.matchAll(/<label for="mc-kpi-(\d)" class="kpi"[^>]*>([^<]+)<\/label>/g)];
    expect(tabs.map((t) => t[2])).toEqual([
      ko.overview.sectionProgress,
      ko.usage.creditSection,
      ko.timeline.section,
      ko.agents.section,
    ]);
    expect(html).toContain(`<h2 class="kpi-h">${esc(ko.kpi.detailsTitle)}</h2>`);
  });

  test("no figures and no charts — the summaries above carry them", () => {
    const html = renderKpis(base, ko, kpiPanels(base, ko));
    expect(html).not.toContain("kpi-v");
    expect(html).not.toContain('class="kpi-c"');
    expect(html).not.toContain("kpi-svg");
  });

  test("the panels sit in one plain box — no fold — in tab order, switched by CSS", () => {
    const html = renderKpis(base, ko, kpiPanels(base, ko));
    expect(html).toContain('<div class="kpi-more" id="kpi-more">');
    // The wrapper only — the panels inside keep their own folds (e.g. the rework list).
    expect(html).not.toMatch(/<details[^>]*id="kpi-more"/);
    expect(html).not.toContain('<span class="kpi-st">');
    const ids = [...html.matchAll(/<div class="kpi-p drill-body" id="([^"]+)">/g)].map((x) => x[1]);
    expect(ids).toEqual(["drill-overview", "drill-usage", "drill-timeline", "drill-agents"]);
    for (let n = 1; n <= 4; n++) {
      expect(KPI_CSS).toContain(
        `.kpi-r:nth-of-type(${n}):checked ~ .kpi-more > .kpi-panels > .kpi-p:nth-child(${n})`,
      );
    }
  });

  test("the usage panel draws its own trend again — no tile above draws it", () => {
    const page = renderPage(base, 0, "ko");
    expect(page).not.toContain(".kpi-p .credit-chart { display:none; }");
  });

  test("comes last, under the summaries it details", () => {
    const body = renderBody(base, "ko");
    const at = [
      "runline",
      'id="journey"',
      'class="ts-row"',
      'id="card-unresolved"',
      'id="diag"',
      'class="kpis card"',
    ].map((k) => body.indexOf(k));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("English renders with no Hangul", () => {
    expect(
      /[가-힣]/.test(
        renderKpis(base, en, kpiPanels(base, en)).replace(/<div class="kpi-panels">[\s\S]*/, ""),
      ),
    ).toBe(false);
  });
});
