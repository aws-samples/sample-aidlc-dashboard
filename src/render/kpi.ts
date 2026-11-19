// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The "Details" area at the foot of the summaries: the full panels, one at a time.
//
// It used to be a KPI strip — three tiles with a big figure and a chart each — that
// doubled as the switch for these panels. The summaries above now carry those figures
// (progress in the journey, time and usage in render/time-summary.ts) with the caveats
// the tiles could not fit, so the tiles were a second copy of the same numbers and the
// charts a fourth copy of the time split. What is left is the switch: a tab per panel,
// each naming it — progress (phases, stages, the unit matrix), usage (credit or tokens,
// with its own trend chart now that no tile draws it), time (the timing analysis), and
// agents (who did the delegated work, render/agents.ts).
//
// SELECTION IS STILL A RADIO GROUP, like the card tabs (render/card-kit.ts): the inputs
// carry the `mc-r` class, so page.ts's poll restores the reader's pick with no code of
// its own, and the same `mc-kpi-<n>` ids keep `openDrill` and every link that lands in
// a panel working. CSS shows the panel matching the checked radio, and the panels are
// NOT folded (since 2026-11-14): the summaries already lead the page, so a
// fold over the full panels only hid the first one until a second click.

import type { DashboardModel } from "../model/types";
import { esc } from "./common";
import type { Strings } from "./i18n";

/** Number of panels; KPI_CSS is generated for exactly this many positions. */
const TABS = 4;

/** Locale-independent compact count: 12,345,678 → 12.3M. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function windowLong(w: "7d" | "30d" | "all", s: Strings): string {
  return w === "7d"
    ? s.usage.windowLong7d
    : w === "30d"
      ? s.usage.windowLong30d
      : s.usage.windowLongAll;
}

/** Marks the checked tab and shows its panel. One rule set per position. */
export const KPI_CSS = Array.from({ length: TABS }, (_, i) => {
  const n = i + 1;
  return `.kpi-r:nth-of-type(${n}):checked ~ .kpi-tiles > label:nth-of-type(${n}) { color:var(--fg); border-color:var(--fg); }
.kpi-r:nth-of-type(${n}):focus-visible ~ .kpi-tiles > label:nth-of-type(${n}) { outline:2px solid var(--accent); outline-offset:2px; }
.kpi-r:nth-of-type(${n}):checked ~ .kpi-more > .kpi-panels > .kpi-p:nth-child(${n}) { display:flex; }`;
}).join("\n");

/** In-page id of the box holding every full panel. */
export const KPI_MORE = "kpi-more";

/** A full panel: the id links target, its tab and summary title, and the markup. */
export interface KpiPanel {
  id: string;
  title: string;
  html: string;
}

/** The Details area: a tab per panel, in panel order (progress, usage, time, agents). */
export function renderKpis(_m: DashboardModel, s: Strings, panels: readonly KpiPanel[]): string {
  const group = "mc-kpi";
  const radios = panels
    .map(
      (_, i) =>
        `<input class="mc-r kpi-r" type="radio" name="${group}" id="${group}-${i}" value="${i}"${
          i === 0 ? " checked" : ""
        }>`,
    )
    .join("");
  const labels = panels
    .map(
      (p, i) =>
        `<label for="${group}-${i}" class="kpi" aria-controls="${KPI_MORE}">${esc(p.title)}</label>`,
    )
    .join("");
  return `<section class="kpis card" aria-label="${esc(s.kpi.heading)}">
<h2 class="kpi-h">${esc(s.kpi.detailsTitle)}</h2>${radios}<div class="kpi-tiles">${labels}</div>
<div class="kpi-more" id="${KPI_MORE}">
<div class="kpi-panels">${panels
    .map((p) => `<div class="kpi-p drill-body" id="${esc(p.id)}">\n${p.html}\n</div>`)
    .join("")}</div>
</div>
</section>`;
}
