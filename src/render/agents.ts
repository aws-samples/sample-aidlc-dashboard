// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The Agents panel: the question a reader brings is "who did the delegated work, and is
// anyone still on it?" — answered from the ledger (model/agents.ts), in this order:
//
//   1. Open now — a review request with no completion yet, where the run is. One line
//      when nothing is open, carrying how long ago the last delegation finished, so a
//      quiet run reads as quiet rather than blank.
//   2. Reviewers — the measured part: reviews, verdicts, extra passes, request →
//      completion time (the bar), and where each ran.
//   3. Requests left unanswered after the run moved on — dashed, never "working".
//   4. Helpers — sent / finished per type, and why there is no time.
//   5. The declared crew, FOLDED and labelled as a declaration: it is what the stage
//      graph names, and on 29 of 33 stages the main session plays that part inline.
//
// The rows are card-kit's rows (tone dot, hairline, neutral share line), so the panel
// reads like the rest of the page. A dot's tone here only says "appears in the record";
// a verdict is never coloured — NOT-READY is a reviewer doing its job, not a fault.

import type { DashboardModel, DeclaredAgent, PendingReview } from "../model/types";
import { type Row, rowList, share } from "./card-kit";
import { dur, esc, hours, section } from "./common";
import type { Strings } from "./i18n";

/** Rows each list shows before folding into "+N more". */
const LIST_ROWS = 8;
/** Places a reviewer ran, listed before "+N more". */
const WHERE_SHOWN = 3;

function nameOf(m: DashboardModel, slug: string): string {
  return m.agents.names[slug] ?? slug;
}

function pendingRows(m: DashboardModel, list: PendingReview[], s: Strings, stale: boolean): Row[] {
  const a = s.agents;
  return list.map((p) => {
    const where = [
      a.place(p.stage, p.unit),
      p.iteration > 1 ? a.pass(p.iteration) : "",
      p.workflow ? a.isolated(p.workflow) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      label: `${esc(nameOf(m, p.reviewer))} <span class="mr-sub">· ${esc(where)}</span>`,
      value: a.openSince(dur(p.sinceSec)),
      // Open is the one live thing here (the page's "neither done nor waiting" tone);
      // an unanswered request the run left behind is outlined, never live.
      tone: stale ? "none" : "alt",
      dashed: stale,
      tip: `${p.reviewer} · ${p.since}`,
    };
  });
}

function crewRow(d: DeclaredAgent, s: Strings): Row {
  const a = s.agents;
  const roles = a.roles(d.lead, d.support, d.reviews);
  return {
    label: `${esc(d.displayName ?? d.slug)}${roles ? ` <span class="mr-sub">· ${esc(roles)}</span>` : ""}`,
    value: d.tier ? a.tier[d.tier] : "",
    tone: d.recorded ? "accent" : "none",
    tip: d.recorded ? `${d.slug} · ${a.recordedMark}` : d.slug,
  };
}

function body(m: DashboardModel, s: Strings): string {
  const a = s.agents;
  const r = m.agents;
  const nothing =
    r.open.length === 0 &&
    r.pending.length === 0 &&
    r.reviewers.length === 0 &&
    r.helpers.length === 0 &&
    r.unpaired.completions === 0 &&
    r.unpaired.legacyRequests === 0;
  const parts: string[] = [];
  // A refused audit path: every figure below is of the records read, and "none open" or
  // "no completion found" could be explained by the shard that was not read.
  if (!nothing && m.partialAudit) {
    parts.push(`<p class="note warn">${esc(a.partialNote(m.partialAudit.notRead))}</p>`);
  }

  if (nothing) {
    parts.push(
      `<p class="note">${esc(m.partialAudit ? a.quietPartial(m.partialAudit.notRead) : a.quiet)}</p>`,
    );
  } else if (r.open.length > 0) {
    parts.push(
      `<div class="ag-block">${rowList(pendingRows(m, r.open, s, false), {
        head: [a.openTitle, a.colSince],
        headTip: a.openTip,
      })}</div>`,
    );
  } else if (r.lastFinished) {
    const ago = (Date.parse(m.generatedAt) - Date.parse(r.lastFinished)) / 1000;
    const line = r.positionVerified ? a.noneOpen(dur(ago)) : a.noneOpenUnverified(dur(ago));
    parts.push(`<p class="note" title="${esc(a.openTip)}">${esc(line)}</p>`);
  }

  if (r.reviewers.length > 0) {
    const max = Math.max(...r.reviewers.map((x) => x.pairedSec));
    const rows: Row[] = r.reviewers.map((x) => {
      const where = x.where.slice(0, WHERE_SHOWN).map((w) => a.where(w.stage, w.unit, w.count));
      if (x.where.length > WHERE_SHOWN) where.push(a.moreWhere(x.where.length - WHERE_SHOWN));
      return {
        label: `${esc(nameOf(m, x.reviewer))} <span class="mr-sub">· ${esc(where.join(" · "))}</span>`,
        value: a.reviewerValue(
          x.reviews,
          x.ready,
          x.notReady,
          x.rePasses,
          x.unfinished,
          hours(x.pairedSec),
        ),
        pct: share(x.pairedSec, max),
        tone: "accent",
        tip: x.reviewer,
      };
    });
    parts.push(
      `<h3 class="ag-h">${esc(a.reviewersTitle)}</h3><div class="ag-block">${rowList(rows, {
        head: [a.colAgent, a.colReviews],
        headTip: a.reviewersTip,
        max: LIST_ROWS,
        moreText: a.more,
      })}</div>`,
    );
  }

  if (r.unpaired.completions > 0 || r.unpaired.legacyRequests > 0) {
    parts.push(
      `<p class="note">${esc(a.unpairedNote(r.unpaired.completions, r.unpaired.legacyRequests))}</p>`,
    );
  }

  if (r.pending.length > 0) {
    parts.push(
      `<h3 class="ag-h">${esc(a.pendingTitle)}</h3><div class="ag-block">${rowList(
        pendingRows(m, r.pending, s, true),
        { max: LIST_ROWS, moreText: a.more, note: a.pendingNote },
      )}</div>`,
    );
  }

  if (r.helpers.length > 0) {
    const rows: Row[] = r.helpers.map((h) => ({
      label: esc(h.agentType === "unknown" ? a.unnamedHelper : nameOf(m, h.agentType)),
      // With no dispatch row anywhere, "sent 0" on every row would repeat the note below.
      value: r.helpersDispatchRecorded
        ? a.helperValue(h.sent, h.finished)
        : a.helperFinished(h.finished),
      tone: "accent",
      tip: h.agentType,
    }));
    parts.push(
      `<h3 class="ag-h">${esc(a.helpersTitle)}</h3><div class="ag-block">${rowList(rows, {
        head: [a.colHelper, r.helpersDispatchRecorded ? a.colHelperCount : a.colHelperFinished],
        max: LIST_ROWS,
        moreText: a.more,
        note: a.helpersNote,
      })}${
        r.helpersDispatchRecorded ? "" : `<div class="mr-note">${esc(a.helpersNoDispatch)}</div>`
      }</div>`,
    );
  }

  if (r.declared.length > 0) {
    const inline =
      r.inline.total > 0
        ? `<p class="note">${esc(a.inlineNote(r.inline.inline, r.inline.total))}</p>`
        : "";
    const tiered = r.declared.some((d) => d.tier);
    parts.push(
      `<details class="ag-crew"><summary>${esc(a.declaredSummary(r.declared.length))}</summary>
<p class="note">${esc(a.declaredNote)}</p>${inline}
<div class="ag-block">${rowList(
        r.declared.map((d) => crewRow(d, s)),
        // A tier column only when the harness ships tiers: 12 of 46 harness dirs do not.
        tiered ? { head: [a.colAgent, a.colTier], headTip: a.tierTip } : { head: [a.colAgent, ""] },
      )}<div class="mr-note"><span class="ag-dot" aria-hidden="true"></span>${esc(
        a.recordedLegend,
      )}</div></div>
</details>`,
    );
  }
  return parts.join("\n");
}

export function renderAgents(m: DashboardModel, s: Strings): string {
  return section(s.agents.section, body(m, s), "agents");
}
