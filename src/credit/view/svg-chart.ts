// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Dependency-free inline SVG renderer (BR2.1, BR3.1, BR3.3, NFR7). A pure string builder: it never
 * touches the DOM, so it is deterministic and testable. No chart library is introduced (no dependencies).
 *
 * Ported from credit-dashboard's `src/ui/svg-chart.ts`. The colour tokens are aliased to the host CSS
 * tokens (BR2.4): `--color-accent`→`--accent`, `--color-track`→`--line`, `--color-muted`→
 * `--mute`, `--color-fg`→`--fg`. SVG-context escaping stays `escapeXml` (distinct from the host's
 * `esc()` for the HTML context; not a newly invented escape function).
 */

import type { Strings } from "../../render/i18n";
import type { TrendSeries, TrendWindow } from "../trend/trend";

/** Window names belong to the catalogue (`render/i18n`). */
function windowLabelOf(w: TrendWindow, s: Strings): string {
  return w === "7d"
    ? s.usage.windowLong7d
    : w === "30d"
      ? s.usage.windowLong30d
      : s.usage.windowLongAll;
}

/** XML/SVG text escape (safe for attributes and body). SVG context only. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

export interface ChartOptions {
  width?: number;
  height?: number;
  /**
   * Accessible-label override. The default (`buildAriaLabel`) uses the "cumulative usage trend"
   * wording, so set this when the same chart is reused for another measure (e.g. daily token total).
   */
  ariaLabel?: string;
}

/** Render the trend line chart as an SVG string. A missing value (value=null) breaks the line. */
export function renderLineChart(series: TrendSeries, s: Strings, opts: ChartOptions = {}): string {
  // The default size matches the KPI chart (render/kpi.ts). At 720 wide it floated small in the middle
  // of a wide card with both sides empty, and as the viewBox grew, 11-unit text grew nearly twice as
  // large, so it looked like a different object from the other charts on the same page.
  const width = opts.width ?? 1160;
  const height = opts.height ?? 200;
  const pad = { top: 12, right: 12, bottom: 24, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const windowLabel = windowLabelOf(series.window, s);
  const valued = series.points.filter((p) => p.value !== null);

  const ariaLabel = opts.ariaLabel ?? buildAriaLabel(series, windowLabel, s);

  if (valued.length === 0) {
    // No point with a value: draw only the axes and a note.
    return wrapSvg(
      width,
      height,
      ariaLabel,
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--mute)" font-size="13">${escapeXml(s.usage.chartNoData)}</text>`,
    );
  }

  const times = valued.map((p) => Date.parse(p.ts)).filter((t) => !Number.isNaN(t));
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const values = valued.map((p) => p.value as number);
  let vMin = Math.min(...values);
  let vMax = Math.max(...values);
  if (vMin === vMax) {
    // A flat series: give it margin above and below.
    vMin -= 1;
    vMax += 1;
  }

  const xOf = (ts: string): number => {
    const t = Date.parse(ts);
    if (tMax === tMin) return pad.left + plotW / 2;
    return pad.left + ((t - tMin) / (tMax - tMin)) * plotW;
  };
  const yOf = (v: number): number => pad.top + plotH - ((v - vMin) / (vMax - vMin)) * plotH;

  // Break the line at missing values, one polyline per continuous run.
  const segments: string[] = [];
  let current: string[] = [];
  for (const p of series.points) {
    if (p.value === null) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(`${xOf(p.ts).toFixed(1)},${yOf(p.value).toFixed(1)}`);
  }
  if (current.length > 0) segments.push(current.join(" "));

  const polylines = segments
    .map(
      (pts) => `<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${pts}" />`,
    )
    .join("");

  // Point markers (normal = filled). Dense points (5-minute polling is 288 a day) would cover the line
  // and read as a blob, so markers are drawn only for sparse series the line alone cannot convey.
  const markers =
    valued.length > 60
      ? ""
      : series.points
          .map((p) => {
            if (p.value === null) return "";
            return `<circle cx="${xOf(p.ts).toFixed(1)}" cy="${yOf(p.value).toFixed(1)}" r="2" fill="var(--accent)" />`;
          })
          .join("");

  // y-axis min/max tick labels.
  const axis =
    `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="var(--line)" stroke-width="1" />` +
    `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="var(--line)" stroke-width="1" />` +
    `<text x="${pad.left - 6}" y="${pad.top + 4}" text-anchor="end" fill="var(--mute)" font-size="11">${escapeXml(fmt(vMax))}</text>` +
    `<text x="${pad.left - 6}" y="${pad.top + plotH}" text-anchor="end" fill="var(--mute)" font-size="11">${escapeXml(fmt(vMin))}</text>`;

  return wrapSvg(width, height, ariaLabel, axis + polylines + markers);
}

/** Accessible text summary (the chart's text alternative). */
export function buildAriaLabel(series: TrendSeries, windowLabel: string, s: Strings): string {
  const { summary } = series;
  if (summary.count === 0) {
    return s.usage.chartEmpty(windowLabel);
  }
  return s.usage.chartSummary(windowLabel, fmt(summary.min), fmt(summary.max), fmt(summary.latest));
}

function wrapSvg(width: number, height: number, ariaLabel: string, inner: string): string {
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" ` +
    `aria-label="${escapeXml(ariaLabel)}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`
  );
}
