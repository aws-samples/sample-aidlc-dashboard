// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The page shell: CSS, layout, and the poll script.
//
// One self-contained HTML document, no framework and no build step — the whole
// dashboard is a string. Collapsible sections are native <details> and card tabs are
// radio inputs shown by CSS, so the client-side JavaScript is only the refresh poll
// (which restores open sections and picked tabs across the swap), a card link opening
// the panel it targets, the header's workspace menu and copy buttons, the event-stream
// filter, and the desktop notifications (render/notify.ts) — which, while on, keep the
// poll running in a hidden tab.
//
// Refresh model: the browser re-fetches the rendered body every `pollMs` and
// swaps it in. Deliberately NOT a file watcher — the inspected tree is usually a
// synced copy, and sync tools write via atomic rename, which kqueue/FSEvents can
// miss. A poll cannot miss a state that is still there when it reads (it can miss one
// that came and went between two reads); the whole read costs ~10ms.

import type { DashboardModel, Locale } from "../model/types";
import { VERSION } from "../version";
import { DRILL, TAB_CSS } from "./card-kit";
import { kpiPanels, renderDeferralBox, renderDiagnostics, renderUnresolved } from "./cards";
import { esc, scriptJson } from "./common";
import { type Strings, strings } from "./i18n";
import { renderJourney } from "./journey";
import { KPI_CSS, renderKpis } from "./kpi";
import { LANG_TOGGLE_CSS, langToggle } from "./lang-toggle";
import { DEFAULT_LOCALE } from "./locale";
import { NOTIFY_CSS, NOTIFY_SCRIPT, notifySwitch } from "./notify";
import { renderBanner, waitCountText } from "./status";
import { renderTimeSummary } from "./time-summary";
import { FONT_STACK, TOKENS_CSS } from "./tokens";
import { warningTextIn } from "./warnings";
import { WS_SLOT, renderWorkspaceMenuShell } from "./workspace-menu";

const STYLE = `${TOKENS_CSS}
:root {

  /* Type scale. Six steps, floor 11px. Before this there were thirteen sizes
     between 9px and 23px, including 9/9.5/10/10.5/11/11.5 all at once — half-pixel
     steps that cost maintenance without ever reading as hierarchy. 9px also sits
     below any defensible minimum. Body stays 14px; these are the steps around it. */
  --fs-1: 11px;   /* micro: pills, unit tags, legends, table headers */
  --fs-2: 12px;   /* small: notes, stage rows, table cells, diary text */
  --fs-3: 13px;   /* card headings, lead paragraphs, blocker questions */
  --fs-4: 15px;   /* page title, matrix glyphs */
  --fs-5: 19px;   /* stat numbers, phase name */
  --fs-6: 23px;   /* the one hero percentage */

  /* Radius. Three tiers with a stated rule, replacing nine ad-hoc values
     (2/3/4/5/6/7/8/9/10px) where a 3px-vs-4px difference conveyed nothing:
       box  = containers that hold other things
       ctl  = things you click or that label something
       pill = anything whose height is its identity (badges, bars, swatches) */
  --r-box: 8px;
  --r-ctl: 5px;
  --r-pill: 999px;
}
/* Colour tokens live in render/tokens.ts, shared with the picker and the viewer. */
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ${FONT_STACK}; }
code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.92em; }
a { color: var(--accent); }

/* Keyboard focus, stated rather than left to the UA. Nothing here suppressed the
   default ring, so keyboard nav was never broken — but the default ring's contrast
   against the dark surface is not something this page controls, and there is a lot to tab
   through: the refresh button, the window toggles, artifact links, and 16 <details>
   summaries. :focus-visible so a mouse click does not leave a ring behind. */
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

/* The one animation on the page is the refresh spinner, and an infinite loop has to
   collapse under reduced motion. Losing it costs nothing: the spinning state is
   already carried by colour and the disabled/wait cursor, so the button still reads
   as busy without moving. */
@media (prefers-reduced-motion: reduce) {
  button.reload.spin .reload-icon { animation:none; }
}

header.top { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line);
  padding:10px 18px; display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
header.top h1 { font-size:var(--fs-4); margin:0; font-weight:650; }
/* Workspace switcher: the name is the trigger. The list is fetched on first open into
   a slot (render/workspace-menu.ts); the heading and the /pick link are in the markup
   from the start, so the menu still offers a way out with scripts off. */
.ws-menu { position:relative; }
.ws-menu > summary { list-style:none; display:flex; align-items:baseline; gap:6px; cursor:pointer; }
.ws-menu > summary::-webkit-details-marker { display:none; }
.ws-menu > summary:hover h1 { text-decoration:underline; text-underline-offset:3px; }
.ws-caret { color:var(--mute); font-size:var(--fs-2); }
.ws-pop { position:absolute; top:calc(100% + 6px); left:0; z-index:10; min-width:320px;
  max-width:min(560px, 90vw); max-height:60vh; overflow:auto; background:var(--card);
  border:1px solid var(--line); border-radius:var(--r-box); padding:6px;
  box-shadow:0 8px 24px rgba(0,0,0,.25); }
.ws-list { list-style:none; margin:0; padding:0; }
.ws-list li > a, .ws-cur { position:relative; display:flex; flex-direction:column; padding:6px 9px;
  border-radius:var(--r-ctl); text-decoration:none; color:var(--fg); }
.ws-list li > a:hover, .ws-list li > a:focus-visible { background:color-mix(in srgb, var(--accent) 12%, transparent); }
.ws-tag { position:absolute; right:9px; top:7px; font-size:var(--fs-1); color:var(--accent); }
.ws-name { font-weight:600; font-size:var(--fs-2); padding-right:48px; }
.ws-path { color:var(--mute); font-size:var(--fs-1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ws-note { color:var(--mute); font-size:var(--fs-1); margin:6px 9px; }
.ws-note.err { color:var(--bad); }
.ws-h { margin:4px 9px 2px; color:var(--mute); font-size:var(--fs-1); font-weight:600; }
.ws-browse { display:block; border-bottom:1px solid var(--line); margin-bottom:4px; padding:4px 9px 8px;
  font-size:var(--fs-2); text-decoration:none; }
header.top .path { color:var(--mute); font-size:var(--fs-2); }
header.top nav { margin-left:auto; display:flex; gap:12px; align-items:center; font-size:var(--fs-2); }
header.top nav a { text-decoration:none; }
header.top nav a.pickbtn, header.top nav button.pickbtn {
  border:1px solid var(--line); border-radius:var(--r-ctl); padding:2px 9px; color:var(--fg);
  background:transparent; font:inherit; font-size:var(--fs-2); cursor:pointer; }
header.top nav a.pickbtn:hover, header.top nav button.pickbtn:hover {
  border-color:var(--accent); color:var(--accent); }
button.reload { display:inline-flex; align-items:center; justify-content:center; gap:5px; min-width:92px; }
button.reload .reload-icon { display:inline-block; width:1em; height:1em; line-height:1; transform-origin:50% 50%; }
button.reload.spin { border-color:var(--accent2); color:var(--accent2); cursor:wait; }
button.reload.spin .reload-icon { animation:reload-spin .7s linear infinite; }
button.reload:disabled { opacity:.9; }
@keyframes reload-spin { to { transform:rotate(360deg); } }
#poll-state.err { color:var(--bad); }

main { padding:16px 18px 60px; max-width:1500px; margin:0 auto; display:flex;
  flex-direction:column; gap:14px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--r-box); padding:13px 15px;
  min-width:0; overflow:hidden; }
.card h2 { font-size:var(--fs-3); margin:0 0 10px; font-weight:650; letter-spacing:.01em;
  display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.note { color:var(--mute); font-size:var(--fs-2); margin:7px 0 0; }
/* A caveat is flagged by a rule in the warning colour, not by painting the paragraph:
   whole orange paragraphs read as a second, louder page. Still visible, and still
   the same colour as every other warning signal. */
.note.warn { color:var(--fg); border-left:2px solid var(--warn); padding-left:9px; }
.lead { margin:0 0 10px; font-size:var(--fs-3); }
.mute { color:var(--mute); }
.bad { color:var(--bad); }

.hero-top { display:flex; align-items:baseline; justify-content:space-between; }
.hero-phase { font-size:var(--fs-5); font-weight:650; }
.hero-pct { font-size:var(--fs-6); font-weight:700; font-variant-numeric:tabular-nums; }
.hero-meta { color:var(--mute); font-size:var(--fs-2); margin-top:5px; }
.hero-meta.small { font-size:var(--fs-1); }
.hero-now { margin-top:7px; font-size:var(--fs-3); }
.hero-now .k { color:var(--mute); margin-right:5px; }
.hero-count { color:var(--mute); font-size:var(--fs-2); margin-left:7px; }

.bar { height:7px; background:var(--line); border-radius:var(--r-pill); overflow:hidden; margin:7px 0 2px; }
/* Flat, like every other bar on the page. The gradient ran accent → accent2, and
   accent2 is the colour this page reserves for conversation time and unsettled units,
   so a progress bar was borrowing a signal it does not carry. */
.bar-fill { height:100%; background:var(--accent); }
.bar-overall { height:9px; }

details.phase { border-top:1px solid var(--line); padding:7px 0 3px; }
details.phase:first-of-type { border-top:0; }
details.phase summary { cursor:pointer; display:flex; align-items:center; gap:9px; font-size:var(--fs-3); }
.phase-name { font-weight:600; }
.phase-count { color:var(--mute); }
.phase-declared { margin-left:auto; color:var(--mute); font-size:var(--fs-1); }
ul.stages { list-style:none; margin:5px 0 4px; padding:0 0 0 3px;
  display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:1px 10px; }
ul.stages li { font-size:var(--fs-2); color:var(--mute); display:flex; gap:6px; align-items:baseline; }
.glyph { width:11px; display:inline-block; text-align:center; }
li.s-done { color:var(--ok); } li.s-active { color:var(--accent); font-weight:600; }
li.s-awaiting { color:var(--warn); font-weight:600; } li.s-revising { color:var(--warn); }
li.s-skipped { opacity:.45; text-decoration:line-through; }
.skip { font-size:var(--fs-1); background:color-mix(in srgb, var(--mute) 14%, transparent); border-radius:var(--r-ctl); padding:0 5px; }

/* Expandable stage rows. A stage with files gets a <details>; one without stays
   a plain <li> (.no-art) so an empty toggle never invites a dead click. The
   <details> must fill its grid cell, hence the flex:1 1 100% / min-width:0. */
ul.stages li.stage { align-items:flex-start; }
details.art-box { flex:1 1 100%; min-width:0; }
details.art-box > summary { display:flex; gap:6px; align-items:baseline; cursor:pointer;
  list-style:none; }
details.art-box > summary::-webkit-details-marker { display:none; }
details.art-box > summary::after { content:'▾'; font-size:var(--fs-1); opacity:.5; }
details.art-box[open] > summary::after { content:'▴'; }
li.no-art { padding-right:13px; }        /* keep text aligned with toggled rows */
.art-count { font-size:var(--fs-1); color:var(--mute); background:color-mix(in srgb, var(--mute) 14%, transparent);
  border-radius:var(--r-ctl); padding:0 5px; margin-left:auto; }
ul.arts { list-style:none; margin:3px 0 6px; padding:0 0 0 17px;
  display:flex; flex-direction:column; gap:1px; }
ul.arts li.art { display:block; }
a.art-link { display:flex; gap:5px; align-items:baseline; font-size:var(--fs-2);
  color:var(--fg); text-decoration:none; border-radius:var(--r-ctl); padding:1px 4px; }
a.art-link:hover { background:var(--line); }
.art-mark { width:13px; flex:none; font-size:var(--fs-1); }
.art-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.art-unit { font-size:var(--fs-1); color:var(--mute); background:color-mix(in srgb, var(--mute) 14%, transparent);
  border-radius:var(--r-ctl); padding:0 4px; flex:none; max-width:132px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.art-size { margin-left:auto; font-size:var(--fs-1); color:var(--mute); flex:none; }
li.a-questions a.art-link, li.a-diary a.art-link { color:var(--mute); }
a.art-link.busy { opacity:.5; }
a.art-link.opened { background:var(--ok); color:var(--bg); }
a.art-link.failed { color:var(--warn); text-decoration:underline wavy; }

.mx-wrap { overflow-x:auto; }
table.mx { border-collapse:collapse; font-size:var(--fs-2); }
table.mx th, table.mx td { padding:3px 5px; text-align:center; }
table.mx tbody th { text-align:left; white-space:nowrap; font-weight:500; }
/* Vertical unit labels are capped at 96px, and real unit names run past it — the
   engine's own example, PU-1-walking-skeleton, needs ~143px. Without an overflow
   rule the cap only bounds the box, so the text either spills or turns the matrix
   into a vertical scroller. Ellipsis instead; the full name stays in the title
   attribute. (No backticks in this comment: the whole stylesheet is a template
   literal, so one would terminate the string.) */
.mx-unit { writing-mode:vertical-rl; transform:rotate(180deg); font-weight:500;
  color:var(--mute); max-height:96px; overflow:hidden; text-overflow:ellipsis;
  font-size:var(--fs-1); cursor:help; }
.mx-cell { font-size:var(--fs-4); line-height:1; cursor:help; }
/* The journey's unit-cell vocabulary (render/journey.ts): ink is done, blue is begun. */
.c-complete { color:var(--fg); } .c-partial { color:var(--s1); } .c-absent { color:var(--line); }
/* Artifacts met, receipt missing — the engine calls this UNCOVERED, so it must not wear
   the completed colour. --accent2 is its own hue for the same reason conversation has one. */
.c-unsettled { color:var(--accent2); }
/* "cannot be checked here" is not "not done" — its own mute tone, so it never reads as a
   blocker the way .c-unsettled deliberately does. */
.c-unverified { color:var(--mute); }
.c-na { color:var(--mute); }
.mx-n { color:var(--mute); font-variant-numeric:tabular-nums; padding-left:9px !important; }
tr.mx-skip { opacity:.4; } tr.mx-skip td { font-size:var(--fs-1); color:var(--mute); }
.prov-mark { color:var(--warn); margin-left:3px; cursor:help; }

.dag { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin-top:9px; }
.batch { border:1px solid var(--line); border-radius:var(--r-ctl); padding:3px 6px; display:flex; gap:4px; align-items:center; }
.batch-label { color:var(--mute); font-size:var(--fs-1); }
.batch-unit { background:var(--line); border-radius:var(--r-pill); padding:1px 5px; font-size:var(--fs-1); }
.batch-arrow { color:var(--mute); }

/* The window total is a HEADLINE, not a tile. It used to sit in a strip of six equal
   tiles beside the five buckets, which read as six comparable numbers and invited an
   addition that does not work — the five sum to the classified span, not to the window.
   Its parts now live in the bar's legend, where the share is. */
/* Still used by the rework strip (rework / rejections / approvals / revision rounds + two optional tiles).
   auto-fit rather than a fixed 5, because at six tiles a fixed count leaves the last
   one orphaned on a row of its own — the same defect the time buckets just shed. */
/* Same tile as the KPI strip (.kpi): its own rounded box, a gap between tiles. It was a
   ruled band split by vertical lines, a third tile shape on one page. */
.time-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(112px,1fr));
  gap:10px; margin-bottom:10px; }
.time-stats > div { min-width:0; padding:8px 12px; border:1px solid var(--line); border-radius:var(--r-box); }
.time-stat-n { display:block; font-size:var(--fs-5); line-height:1.2; font-weight:680;
  font-variant-numeric:tabular-nums; white-space:nowrap; }
.time-stat-l { display:block; color:var(--mute); font-size:var(--fs-1); margin-top:2px; }
.time-stats .unknown .time-stat-n { color:var(--mute); }

.time-head { display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; margin-bottom:9px;
  padding-bottom:9px; border-bottom:1px solid var(--line); }
.time-head-n { font-size:var(--fs-6); line-height:1.1; font-weight:700;
  font-variant-numeric:tabular-nums; white-space:nowrap; }
.time-head-l { font-size:var(--fs-2); color:var(--mute); }
.time-head-sub { margin-left:auto; font-size:var(--fs-1); color:var(--mute); }
.g-n.wait { color:var(--warn); }
.g-n.parked { color:var(--accent); }
/* Conversation gets --accent2, its own hue: it is neither wait (--warn) nor observed execution
   (--ok) nor unexplained (--mute), and borrowing any of those three would make the
   colour claim the attribution the bucket exists to refuse. */
.g-n.conv { color:var(--accent2); }
.g-n.unknown { color:var(--mute); }
.time-breakdown { display:flex; width:100%; height:8px; overflow:hidden; background:var(--line);
  border-radius:var(--r-pill); }
.time-breakdown > span { display:block; min-width:1px; }
.time-breakdown .wait, .time-legend i.wait { background:var(--s2); }
.time-breakdown .parked, .time-legend i.parked { background:var(--s-park); }
.time-breakdown .observed, .time-legend i.observed { background:var(--s1); }
.time-breakdown .conv, .time-legend i.conv { background:var(--s3); }
.time-breakdown .unknown, .time-legend i.unknown { background:var(--mute); }
/* A GRID, not a flex wrap: the legend now carries hours + label + share per entry, and
   flex-wrapping five of those clipped the last one off the card edge. auto-fill lays
   them out 2–3 per row at any card width with nothing cut. */
.time-legend { display:grid; grid-template-columns:repeat(auto-fill,minmax(158px,1fr));
  gap:3px 13px; margin-top:7px; color:var(--mute); font-size:var(--fs-2); }
.time-legend .lgi { display:flex; align-items:baseline; gap:5px; min-width:0; cursor:help; }
.time-legend i { width:7px; height:7px; border-radius:var(--r-pill); flex:none;
  align-self:center; }
.time-legend b { font-weight:660; font-variant-numeric:tabular-nums; white-space:nowrap; }
.time-legend b.wait { color:var(--warn); }
.time-legend b.parked { color:var(--accent); }
.time-legend b.observed { color:var(--ok); }
.time-legend b.conv { color:var(--accent2); }
.time-legend b.unknown { color:var(--fg); }
.time-legend .mute { margin-left:auto; font-size:var(--fs-1); }
.worker-stats { display:flex; flex-wrap:wrap; gap:4px 14px; margin:8px 0 3px; color:var(--mute);
  font-size:var(--fs-1); }
.worker-stats b { color:var(--fg); font-size:var(--fs-2); font-variant-numeric:tabular-nums; }
.timeline-table-wrap { overflow-x:auto; }

.diary-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-block:1px solid var(--line);
  margin:0 0 13px; }
.diary-stat { min-width:0; padding:8px 10px; border-left:1px solid var(--line); }
.diary-stat:first-child { border-left:0; }
.diary-stat-n { display:block; font-size:var(--fs-5); line-height:1.2; font-weight:680;
  font-variant-numeric:tabular-nums; }
.diary-stat-l { display:block; color:var(--mute); font-size:var(--fs-1); margin-top:2px; }
.diary-stat.ok .diary-stat-n { color:var(--ok); }
.diary-stat.warn .diary-stat-n { color:var(--warn); }
.diary-focus > h3, .diary-group > h3 { margin:0 0 7px; font-size:var(--fs-2); font-weight:650; }
.diary-focus { padding-bottom:12px; }
.diary-columns { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 16px;
  border-top:1px solid var(--line); }
.diary-group { min-width:0; padding-top:11px; }
.diary-group + .diary-group { border-left:1px solid var(--line); padding-left:16px; }
.diary-list { list-style:none; margin:0; padding:0; }
.diary-item { padding:7px 0; border-bottom:1px solid var(--line); min-width:0; }
.diary-item:last-child { border-bottom:0; }
.diary-meta { display:flex; align-items:center; gap:7px; min-width:0; font-size:var(--fs-1); }
.diary-where { color:var(--mute); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.diary-time { color:var(--mute); margin-left:auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
.diary-source { flex:none; font-size:var(--fs-1); text-decoration:none; }
.diary-text { margin-top:4px; font-size:var(--fs-2); line-height:1.45; overflow-wrap:anywhere; }
.diary-more > summary, .diary-resolved > summary, .diary-audit > summary { padding-top:7px; }
.diary-resolved, .diary-audit { border-top:1px solid var(--line); margin-top:11px; padding-top:2px; }
.diary-table-wrap { overflow-x:auto; }
.diary-table { min-width:520px; }
.diary-table .g-name { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:700px) {
  /* The headline's context line drops under the number instead of being pushed right. */
  .time-head-sub { margin-left:0; flex-basis:100%; }
  .diary-stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .diary-stat:nth-child(3) { border-left:0; border-top:1px solid var(--line); }
  .diary-stat:nth-child(4) { border-top:1px solid var(--line); }
  /* The ledger rows already stack; only the big number needs to stop reserving width. */
  .dfr-ledger { gap:9px; }
  .diary-columns { grid-template-columns:1fr; }
  .diary-group + .diary-group { border-left:0; border-top:1px solid var(--line); padding-left:0; }
}

/* Deferred decisions. Reuses the four-tile / list / details rhythm the diary card established
   (render/health.ts, now unmounted — its .diary-* rules stay for that reason). Two
   things here are deliberate: a tile's colour encodes urgency and a ZERO tile goes
   mute, so an empty "past stages" does not shout in red; and every row carries its own
   route — origin stage → assigned stage — which is how the reader judges direction
   without the panel asserting one. */
/* One ROW per ledger, not a tile strip — see ledgerRows() in render/deferrals.ts for
   why (six equal tiles asserted six comparable numbers; only the first four are one
   measurement, and the sixth wrapped alone and took the divider with it). */
.dfr-ledgers { list-style:none; margin:0 0 9px; padding:0;
  border-block:1px solid var(--line); }
.dfr-ledger { display:flex; gap:13px; align-items:baseline; padding:9px 2px; }
.dfr-ledger + .dfr-ledger { border-top:1px solid var(--line); }
.dfr-ledger-n { flex:0 0 auto; min-width:2ch; text-align:right; font-size:var(--fs-5);
  line-height:1.2; font-weight:680; font-variant-numeric:tabular-nums; }
.dfr-ledger-body { min-width:0; }
.dfr-ledger-h { font-size:var(--fs-2); font-weight:600; }
.dfr-ledger-src { color:var(--mute); font-weight:400; font-size:var(--fs-1); }
.dfr-chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:5px; }
.dfr-chip { font-size:var(--fs-1); color:var(--mute); background:color-mix(in srgb, var(--mute) 12%, transparent);
  border-radius:var(--r-ctl); padding:1px 8px; white-space:nowrap; cursor:help; }
.dfr-chip b { font-variant-numeric:tabular-nums; }
.dfr-ledger-n.t-bad, .dfr-chip.t-bad b { color:var(--bad); }
.dfr-ledger-n.t-warn, .dfr-chip.t-warn b { color:var(--warn); }
.dfr-ledger-n.t-ok, .dfr-chip.t-ok b { color:var(--ok); }
.dfr-ledger-n.t-mute, .dfr-chip.t-mute b, .dfr-chip.t-zero b { color:var(--mute); }
.dfr-chip.t-bad { color:var(--fg); background:color-mix(in srgb, var(--bad) 14%, transparent); }
.dfr-chip.t-warn { color:var(--fg); background:color-mix(in srgb, var(--warn) 14%, transparent); }
.dfr-focus > h3 { margin:11px 0 7px; font-size:var(--fs-2); font-weight:650; }
.dfr-focus:first-of-type > h3 { margin-top:0; }
.dfr-list { list-style:none; margin:0; padding:0; }
.dfr-item { padding:7px 0; border-bottom:1px solid var(--line); min-width:0; }
.dfr-item:last-child { border-bottom:0; }
.dfr-meta { display:flex; align-items:center; gap:7px; min-width:0; font-size:var(--fs-1); flex-wrap:wrap; }
.dfr-route { color:var(--mute); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.dfr-route .dfr-to { color:var(--fg); }
.dfr-fan { color:var(--mute); background:color-mix(in srgb, var(--mute) 14%, transparent); border-radius:var(--r-ctl);
  padding:0 5px; flex:none; }
.dfr-age { color:var(--mute); margin-left:auto; white-space:nowrap; font-variant-numeric:tabular-nums;
  cursor:help; }
.dfr-source { flex:none; font-size:var(--fs-1); text-decoration:none; }
.dfr-text { margin-top:4px; font-size:var(--fs-2); line-height:1.45; overflow-wrap:anywhere; }
.dfr-assign { margin-top:3px; font-size:var(--fs-1); color:var(--mute); overflow-wrap:anywhere; }
.dfr-more > summary, .dfr-ahead > summary, .dfr-rest > summary, .dfr-assum > summary,
.dfr-owners > summary { padding-top:7px; }
.dfr-ahead, .dfr-rest, .dfr-assum, .dfr-owners { border-top:1px solid var(--line); margin-top:11px;
  padding-top:2px; }

/* ONE chip shape across the page: a tint of its own colour, no outline — the same
   vocabulary as the cards' bar-backed rows. The outlined pill and the six other
   bordered badges (.skip, .art-count, .art-unit, .dfr-chip, .dfr-fan, .tag-lead) were a
   second visual language sitting inside the first. */
.pill { font-size:var(--fs-1); font-weight:600; border-radius:var(--r-ctl); padding:1px 7px; border:0;
  background:color-mix(in srgb, currentColor 13%, transparent); white-space:nowrap; }
.pill.has-help { cursor:help; text-decoration:underline dotted; text-underline-offset:2px; }
.pill.ok { color:var(--ok); } .pill.warn { color:var(--warn); }
.pill.bad { color:var(--bad); } .pill.mute { color:var(--mute); }

table.tbl { width:100%; border-collapse:collapse; font-size:var(--fs-2); margin-top:8px; }
table.tbl th, table.tbl td { text-align:left; padding:3px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
table.tbl thead th { color:var(--mute); font-weight:600; font-size:var(--fs-1); white-space:nowrap; }
td.ts, .g-n { font-variant-numeric:tabular-nums; white-space:nowrap; }
.g-n { text-align:right; }
.g-n.idle { color:var(--warn); } .g-n.work { color:var(--ok); }
td.out { max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
td.det { color:var(--mute); }
ul.errs { margin:0; padding-left:15px; } ul.errs li { margin:1px 0; }
ul.errs .more { color:var(--mute); list-style:none; }
ul.per-stage { list-style:none; margin:9px 0 0; padding:0; font-size:var(--fs-2); }
ul.per-stage li { padding:2px 0; } .per-stage .st { display:inline-block; min-width:160px; }
details summary { cursor:pointer; font-size:var(--fs-2); color:var(--mute); margin-top:9px; }

.gantt .g-name { white-space:nowrap; font-weight:500; max-width:170px; overflow:hidden; text-overflow:ellipsis; }
.gantt .g-unit { padding-left:14px; }
.gantt tr.g-group > th { text-align:left; font-weight:400; color:var(--mute); padding-top:9px; border-bottom:1px solid var(--line); }
.g-n .g-sub { display:block; font-size:var(--fs-1); color:var(--mute); font-weight:400; }
details.how-read > .note { margin:4px 0; }
.g-track-h { width:44%; }
.g-track { width:44%; padding:4px 6px !important; }
.g-track-line { position:relative; height:11px; min-width:260px; }
/* Bar LENGTH is calendar occupancy; the FILL is that stretch's split, so a long bar
   made of waiting cannot look like a long bar of work. End kind is the outline. */
.g-bar { position:absolute; top:0; height:11px; border-radius:var(--r-pill); background:var(--line);
  min-width:2px; cursor:help; display:flex; overflow:hidden;
  box-shadow:0 0 0 1px var(--mute) inset; }
.g-bar > i { display:block; height:100%; min-width:1px; }
.g-bar > i.wait { background:var(--s2); } .g-bar > i.parked { background:var(--s-park); }
.g-bar > i.observed { background:var(--s1); } .g-bar > i.conv { background:var(--s3); }
.g-bar > i.unknown { background:var(--mute); }
.g-bar.k-done { box-shadow:0 0 0 1px var(--accent2) inset; }
.g-bar.k-skip { box-shadow:0 0 0 1px var(--mute) inset; opacity:.55; }
.g-bar.k-await { box-shadow:0 0 0 1px var(--warn) inset; }
.g-bar.k-live { box-shadow:0 0 0 1px var(--accent) inset; }
/* A superseded attempt is over: dashed outline, dimmed, never the "running" colour. */
.g-bar.k-sup { box-shadow:none; outline:1px dashed var(--mute); outline-offset:-1px; opacity:.6; }
/* A paused unit segment: the unit stopped and will resume — dotted, in the waiting colour. */
.g-bar.k-pause { box-shadow:none; outline:1px dotted var(--warn); outline-offset:-1px; }
/* Track axis: dates under the header, plus the unrecorded tail as a shaded band. */
.g-axis { position:relative; height:14px; min-width:260px; margin-top:3px; font-weight:400; }
.ax-t { position:absolute; top:0; transform:translateX(-50%); color:var(--mute);
  font-size:var(--fs-1); font-variant-numeric:tabular-nums; white-space:nowrap; }
.ax-t:first-of-type { transform:none; } .ax-t:last-of-type { transform:translateX(-100%); }
.ax-gap { position:absolute; top:0; height:14px; background:repeating-linear-gradient(45deg,
  var(--line) 0 3px, transparent 3px 6px); cursor:help; }
/* A 0-second stage: a tick at its instant, never a bar wide enough to read as time. */
.g-tick { position:absolute; top:-1px; width:2px; height:13px; background:var(--mute); cursor:help; }
.g-tick.k-done { background:var(--accent2); } .g-tick.k-live { background:var(--accent); }
.g-tick.k-await { background:var(--warn); } .g-tick.k-pause { background:var(--warn); }
.g-n.attn { color:var(--fg); }
.g-where { color:var(--accent); font-size:var(--fs-1); }
i.lg { display:inline-block; width:9px; height:9px; border-radius:2px; vertical-align:-1px; }
i.lg.wait { background:var(--s2); } i.lg.parked { background:var(--s-park); }
i.lg.observed { background:var(--s1); } i.lg.conv { background:var(--s3); }
i.lg.unknown { background:var(--mute); }
.g-load { color:var(--mute); font-size:var(--fs-1); max-width:150px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
/* The human's rejection reason, in full, BELOW the numeric table rather than inside
   it. One measured rejection is 1042 characters with no line breaks: in a cell beside
   five numeric columns it was clamped by .g-load's 150px nowrap (the clip landing on a
   nested <li>, where text-overflow cannot reach) and sliced at 400 characters on top.
   Full card width is what "shown verbatim" actually requires. */
.why-all { margin-top:9px; }
.why-list { list-style:none; margin:6px 0 0; padding:0; display:grid; gap:9px; }
.why-item { border-left:2px solid var(--line); padding-left:11px; }
.why-head { display:flex; gap:9px; align-items:baseline; font-size:var(--fs-1); }
.why-text { margin:3px 0 0; font-size:var(--fs-2); line-height:1.65;
  white-space:pre-wrap; overflow-wrap:anywhere; }
.tag-lead { font-size:var(--fs-1); font-weight:600; color:var(--accent);
  background:color-mix(in srgb, currentColor 13%, transparent);
  border-radius:var(--r-ctl); padding:0 5px; white-space:nowrap; cursor:help; }
.gantt tbody td, .gantt tbody th { line-height:1.35; }
ul.gaps, ul.oq { margin:6px 0 0; padding-left:17px; font-size:var(--fs-2); }
ul.gaps li, ul.oq li { margin:2px 0; }
table.tbl td code { white-space:nowrap; }
.filter-row { display:flex; gap:11px; align-items:center; font-size:var(--fs-2); margin-top:6px; flex-wrap:wrap; }
.filter-row select { background:var(--card); color:var(--fg); border:1px solid var(--line);
  border-radius:var(--r-ctl); padding:2px 5px; font-size:var(--fs-2); max-width:260px; }
.stream code.ev { font-size:var(--fs-1); }
.warnbox { border:1px solid var(--warn); border-radius:var(--r-ctl); padding:8px 11px; margin-bottom:12px;
  font-size:var(--fs-2); color:var(--warn); grid-column:1/-1; }
.warnbox ul { margin:4px 0 0; padding-left:17px; }

/* Hero: the page's first answer — is anything waiting for the reader, and what. Colours
   are the page's current tokens; the palette itself is replaced separately. */
.banner { --tone:var(--accent); --tone-fill:var(--accent); background:var(--card); border:1px solid var(--line);
  border-radius:var(--r-box); padding:22px 26px 16px; display:flex; flex-direction:column; gap:10px; }
.banner.wait { --tone:var(--warn); --tone-fill:var(--warn-fill);
  background:linear-gradient(180deg, color-mix(in srgb, var(--warn-fill) 10%, var(--card)), var(--card) 75%); }
.banner.done { --tone:var(--ok); --tone-fill:var(--ok-fill); }
.banner.unknown { --tone:var(--mute); border-style:dashed; }
.hero-eye { margin:0; display:flex; align-items:center; gap:8px; font-size:var(--fs-2); font-weight:600; color:var(--mute); }
.hero-dot { width:8px; height:8px; border-radius:50%; background:var(--tone-fill);
  box-shadow:0 0 0 4px color-mix(in srgb, var(--tone-fill) 25%, transparent); }
.hero-h { margin:0; font-size:30px; line-height:1.2; letter-spacing:-.02em; font-weight:750; }
.hero-lede { margin:0; color:var(--mute); font-size:var(--fs-3); }
.ask { display:flex; gap:22px; align-items:stretch; background:var(--card); border:1px solid var(--line);
  border-radius:var(--r-box); padding:16px 20px; }
.ask-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:5px; }
.ask-kind { align-self:flex-start; font-size:var(--fs-1); font-weight:700; white-space:nowrap;
  color:var(--tone); background:color-mix(in srgb, var(--tone-fill) 18%, transparent); border-radius:5px; padding:1px 7px; }
.ask-t { margin:2px 0 0; font-size:19px; letter-spacing:-.01em; overflow-wrap:anywhere; }
.ask-where { margin:0; color:var(--mute); font-size:var(--fs-2); overflow-wrap:anywhere; }
.ask-act { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; align-items:center; }
.ask-btn { font:inherit; font-size:var(--fs-2); font-weight:600; border-radius:var(--r-ctl); padding:6px 13px;
  text-decoration:none; cursor:pointer; background:transparent; color:var(--fg); border:1px solid var(--line); }
.ask-btn.primary { background:var(--fg); color:var(--bg); border-color:transparent; }
.ask-hint { color:var(--mute); font-size:var(--fs-2); }
.ask-age { display:flex; flex-direction:column; justify-content:center; align-items:flex-end; gap:2px;
  padding-left:22px; border-left:1px solid var(--line); min-width:140px; }
.ask-age b { font-size:24px; font-weight:750; letter-spacing:-.02em; white-space:nowrap; font-variant-numeric:tabular-nums; }
.ask-age span { color:var(--mute); font-size:var(--fs-1); }
.ask-rest summary { cursor:pointer; color:var(--mute); font-size:var(--fs-2); }
.ask-rest ul { list-style:none; margin:8px 0 0; padding:0; display:grid; gap:5px; }
.ask-rest li { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto auto; gap:12px; align-items:center;
  font-size:var(--fs-2); padding:7px 12px; border:1px solid var(--line); border-radius:var(--r-ctl); background:var(--card); }
.ar-t { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ar-w, .ar-a { color:var(--mute); font-size:var(--fs-1); white-space:nowrap; }
.banner .runline { font-size:var(--fs-2); padding-top:8px; border-top:1px solid var(--line); }
@media (max-width:700px) { .ask { flex-direction:column; } .ask-age { border-left:0; padding-left:0; align-items:flex-start; }
  .ask-rest li { grid-template-columns:auto minmax(0,1fr); } .hero-h { font-size:24px; } }

/* Visually hidden text: read by assistive tech, not drawn. */
.vh { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }

/* Journey: every stage by phase, one current position, the units beneath. Out-of-scope
   rows are hidden until the reader asks for them (:has keeps it CSS-only; the poll
   restores the box). */
.journey { padding:18px 22px; }
.jr-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:14px; }
.jr-head h2 { margin:0; font-size:var(--fs-4); }
.jr-head p { margin:0; color:var(--mute); font-size:var(--fs-2); }
.jr-tog { margin-left:auto; display:flex; align-items:center; gap:6px; font-size:var(--fs-2); color:var(--mute); cursor:pointer; }
.jr-board { list-style:none; margin:0; padding:0; display:flex; gap:16px 22px; }
.jr-col { flex:1 1 0; min-width:0; }
/* A phase with nothing in scope shrinks to its header while its rows are hidden. */
.jr-col.all-out { flex:0 0 auto; }
.journey:has(#jr-show-out:checked) .jr-col.all-out { flex:1 1 0; }
.jr-ph { margin:0 0 10px; font-size:var(--fs-1); font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--mute); }
.jr-ph span { font-weight:600; margin-left:4px; } .jr-ph-out { text-transform:none; letter-spacing:0; }
.jr-track { list-style:none; margin:0; padding:0; position:relative; }
.jr-track::before { content:""; position:absolute; left:8px; top:10px; bottom:10px; width:2px; background:var(--line); }
.jr-s { display:flex; align-items:center; gap:9px; min-height:28px; position:relative; font-size:var(--fs-2); color:var(--mute); }
.jr-pin { flex:none; width:18px; height:18px; border-radius:50%; background:var(--card); box-shadow:inset 0 0 0 2px var(--line);
  position:relative; z-index:1; display:grid; place-items:center; font-size:10px; font-weight:900; color:var(--card); }
.jr-n { line-height:1.25; min-width:0; overflow-wrap:normal; }
.jr-t { margin-left:auto; padding-left:8px; color:var(--mute); font-size:var(--fs-1); font-variant-numeric:tabular-nums; white-space:nowrap; }
.jr-s.jk-done { color:var(--fg); } .jr-s.jk-done .jr-pin { background:var(--fg); box-shadow:none; } .jr-s.jk-done .jr-pin::after { content:"✓"; }
.jr-s.jk-active .jr-pin { box-shadow:inset 0 0 0 2px var(--s1); }
.jr-s.jk-awaiting .jr-pin, .jr-s.jk-revising .jr-pin { background:var(--warn-fill); box-shadow:none; color:#0b0b0b; }
.jr-s.jk-awaiting .jr-pin::after { content:"!"; } .jr-s.jk-revising .jr-pin::after { content:"↺"; }
.jr-s.jk-skip .jr-pin { box-shadow:inset 0 0 0 2px var(--mute); }
.jr-s.jk-skip .jr-pin::after { content:""; position:absolute; width:11px; height:2px; background:var(--mute); transform:rotate(-45deg); }
.jr-s.jk-skip .jr-n { text-decoration:line-through; text-decoration-color:color-mix(in srgb, var(--mute) 60%, transparent); }
.jr-s.jk-out { opacity:.55; } .jr-s.jk-out .jr-pin { width:10px; height:10px; margin:0 4px; box-shadow:inset 0 0 0 1.5px var(--line); }
.jr-track > .jr-s.jk-out { display:none; }
.journey:has(#jr-show-out:checked) .jr-track > .jr-s.jk-out { display:flex; }
.jr-s.here .jr-pin { --pc:var(--s1); background:var(--pc); box-shadow:none; color:#fff; animation:jr-pulse 2s ease-out infinite; }
.jr-s.here.you .jr-pin { --pc:var(--warn-fill); color:#0b0b0b; } .jr-s.here.you .jr-pin::after { content:"!"; }
.jr-s.here .jr-n { color:var(--fg); font-weight:700; }
.jr-tag { font-size:var(--fs-1); font-weight:700; color:var(--accent); white-space:nowrap; }
.jr-s.here.you .jr-tag { color:var(--warn); }
@keyframes jr-pulse { 0% { box-shadow:0 0 0 0 color-mix(in srgb, var(--pc) 55%, transparent); } 100% { box-shadow:0 0 0 11px transparent; } }
@media (prefers-reduced-motion: reduce) { .jr-s.here .jr-pin { animation:none; } }
.jr-lg { list-style:none; margin:14px 0 0; padding:12px 0 0; border-top:1px solid var(--line); display:flex; flex-wrap:wrap; gap:4px 18px; }
.jr-lg .jr-s { min-height:0; font-size:var(--fs-1); }
.jr-units { margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }
.jr-units-h { margin:0 0 9px; font-size:var(--fs-1); font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--mute); }
.jr-units-h span, .jr-units-h a { text-transform:none; letter-spacing:0; font-weight:500; }
.jr-empty { margin:0; color:var(--mute); font-size:var(--fs-2); }
.jr-ul { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:7px; }
.jr-u { display:flex; align-items:center; gap:10px; padding:8px 11px; border:1px solid var(--line); border-radius:var(--r-ctl); }
.jr-u.here { border-color:var(--accent); }
.jr-un { flex:1; min-width:0; font-size:var(--fs-2); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.jr-cs { display:flex; gap:3px; }
.jr-c { width:13px; height:13px; border-radius:3px; box-shadow:inset 0 0 0 1.5px var(--line); display:inline-block; }
.jr-c.done { background:var(--fg); box-shadow:none; }
.jr-c.part { background:linear-gradient(90deg, var(--s1) 50%, transparent 50%); box-shadow:inset 0 0 0 1.5px var(--s1); }
.jr-c.unset { background:repeating-linear-gradient(45deg, var(--fg) 0 2px, transparent 2px 4px); box-shadow:inset 0 0 0 1.5px var(--fg); }
.jr-c.unver { box-shadow:none; border:1.5px dashed var(--mute); }
.jr-c.skip { background:linear-gradient(135deg, transparent 44%, var(--mute) 44% 56%, transparent 56%); }
.jr-c.na { opacity:.3; }
.jr-us { width:32px; text-align:right; font-size:var(--fs-1); color:var(--mute); } .jr-u.here .jr-us { color:var(--accent); font-weight:700; }
.jr-ulg { list-style:none; margin:9px 0 0; padding:0; display:flex; flex-wrap:wrap; gap:4px 16px; font-size:var(--fs-1); color:var(--mute); }
.jr-ulg li { display:flex; align-items:center; gap:6px; } .jr-ulg .jr-c { width:11px; height:11px; }
@media (max-width:900px) { .jr-board { flex-wrap:wrap; } .jr-col { flex:1 1 calc(50% - 22px); } .jr-col.all-out { flex:0 0 auto; } }

/* The three-ledger panel, and the folded diagnostics (Run Health + sources). */
.unres { padding:18px 22px; }
.un-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
.un-head h2 { margin:0; font-size:var(--fs-4); } .un-head p { margin:0; color:var(--mute); font-size:var(--fs-2); }
.un-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:22px; }
@media (max-width:900px) { .un-grid { grid-template-columns:1fr; } }
.un-h { margin:0 0 8px; display:flex; align-items:baseline; gap:9px; font-size:var(--fs-3); font-weight:600; }
.un-h b { font-size:26px; font-weight:750; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
.un-h b.zero { color:var(--mute); }
.diag { padding:0; }
.diag > summary { cursor:pointer; list-style:none; display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  padding:14px 22px; font-size:var(--fs-3); }
.diag > summary::-webkit-details-marker { display:none; }
.diag > summary::before { content:"▸"; color:var(--mute); } .diag[open] > summary::before { content:"▾"; }
.diag-chip { font-size:var(--fs-1); font-weight:600; padding:1px 8px; border-radius:var(--r-pill); border:1px solid var(--line); color:var(--mute); }
.diag-chip.ok { color:var(--ok); } .diag-chip.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn-fill) 50%, var(--line)); }
.diag-chip.bad { color:var(--bad); border-color:color-mix(in srgb, var(--bad) 45%, var(--line)); }
.diag-body { padding:0 22px 18px; display:flex; flex-direction:column; gap:12px; }
.diag-body .card.mc { border:0; padding:0; background:transparent; }

/* Time and usage summaries under the journey. The split bar reuses .time-breakdown. */
.ts-row { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr); gap:14px; }
@media (max-width:900px) { .ts-row { grid-template-columns:1fr; } }
.ts-time, .ts-usage, .ts-stages { padding:18px 22px; display:flex; flex-direction:column; gap:10px; }
.ts-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
.ts-head h2 { margin:0; font-size:var(--fs-4); }
.ts-head p { margin:0; color:var(--mute); font-size:var(--fs-2); }
.ts-note { margin:0; color:var(--mute); font-size:var(--fs-2); }
.ts-note.warn { color:var(--warn); }
.ts-empty { margin:0; color:var(--mute); font-size:var(--fs-2); }
.ts-big { margin:2px 0 0; font-size:34px; line-height:1; font-weight:750; letter-spacing:-.03em; }
.ts-big span { font-size:.45em; color:var(--mute); margin-left:2px; }
.ts-big.missing, .ts-usage.stale .ts-big { color:var(--mute); }
.ts-sub { margin:0; color:var(--mute); font-size:var(--fs-2); }
.ts-meter { height:8px; border-radius:var(--r-pill); background:var(--s-park); overflow:hidden; }
.ts-meter i { display:block; height:100%; background:var(--fg); border-radius:var(--r-pill); }
.ts-usage.stale .ts-meter i { opacity:.45; }
.ts-meter.over i { background:var(--bad); }
.ts-list { list-style:none; margin:0; padding:0; display:grid; gap:2px; }
.ts-list li { display:grid; grid-template-columns:minmax(120px,220px) minmax(0,1fr) 70px 70px 70px; gap:14px; align-items:center;
  font-size:var(--fs-2); padding:4px 6px; border-radius:var(--r-ctl); }
.ts-list li:not(.ts-lh):hover { background:color-mix(in srgb, var(--fg) 5%, transparent); }
.ts-lh { color:var(--mute); font-size:var(--fs-1) !important; }
.ts-n { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ts-live { margin-left:8px; font-size:var(--fs-1); font-weight:700; color:var(--accent); }
.ts-b { height:12px; display:flex; align-items:center; }
.ts-sb { display:flex; gap:2px; height:12px; }
.ts-sb i { border-radius:3px; min-width:2px; }
.ts-sb i.observed { background:var(--s1); } .ts-sb i.wait { background:var(--s2); } .ts-sb i.conv { background:var(--s3); }
.ts-sb i.parked { background:var(--s-park); } .ts-sb i.unknown { background:repeating-linear-gradient(45deg, var(--s-park) 0 3px, transparent 3px 6px); box-shadow:inset 0 0 0 1px var(--s-park); }
.ts-tick { width:2px; height:12px; background:var(--line); border-radius:1px; }
.ts-w { font-weight:700; text-align:right; font-variant-numeric:tabular-nums; }
/* A per-unit stage under unit-major: the figure is its units' segments summed (time-summary.ts). */
.ts-w.ts-units::before { content:"Σ "; color:var(--mute); font-weight:400; }
.ts-w.ts-none { color:var(--mute); font-weight:400; }
/* Unclassified stands beside observed, never added into it: it is time the ledger does
   not explain (time-summary.ts). Muted so the measured figure reads first. */
.ts-u { color:var(--mute); text-align:right; font-variant-numeric:tabular-nums; }
.ts-u.ts-units::before { content:"Σ "; }
.ts-e { color:var(--mute); text-align:right; font-variant-numeric:tabular-nums; }

/* Run line: the phase/stage the run is on and how long since the audit last wrote. */
.runline { display:flex; align-items:center; gap:9px; flex-wrap:wrap; font-size:var(--fs-3); }
.rl-dot { width:9px; height:9px; border-radius:var(--r-pill); flex:none; }
.rl-dot.run { background:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent); }
.rl-dot.ok { background:var(--ok); }
.rl-dot.mute { border:1px dashed var(--mute); }
.rl-sub { color:var(--mute); font-size:var(--fs-2); }

/* Details: a tab per full panel, the checked one shown inside ONE closed <details>.
   The radios are hidden the same way the card tabs' are (.mc-r). */
.kpis { padding:14px 22px 6px; display:flex; flex-wrap:wrap; align-items:center; gap:6px 14px; }
.kpi-h { margin:0; font-size:var(--fs-4); }
.kpi-tiles { display:flex; gap:6px; flex-wrap:wrap; }
.kpi { cursor:pointer; padding:4px 12px; font-size:var(--fs-2); font-weight:600; color:var(--mute);
  border:1px solid var(--line); border-radius:var(--r-pill); background:transparent; }
.kpi:hover { color:var(--fg); }
.kpis > .kpi-more { flex-basis:100%; }
${KPI_CSS}

/* The 2×2 cards. Two columns down to 900px, then one. */
.cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; align-items:stretch; }
@media (max-width:900px) { .cards { grid-template-columns:1fr; } }
.card.mc { display:flex; flex-direction:column; padding:13px 15px 11px; }
/* The radios are the tab state, not something to look at: visually hidden, still
   focusable, so Tab reaches the group and the arrow keys move the selection. */
.mc-r { position:absolute; width:1px; height:1px; opacity:0; margin:0; pointer-events:none; }
.mc-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
.mc-head h2 { margin:0; font-size:var(--fs-4); }
.mc-tabs { margin-left:auto; display:flex; gap:12px; flex-wrap:wrap; justify-content:flex-end; }
.mc-tabs label { cursor:pointer; font-size:var(--fs-2); color:var(--mute); padding-bottom:2px;
  border-bottom:2px solid transparent; white-space:nowrap; }
.mc-tabs label:hover { color:var(--fg); }
.mc-n { font-weight:700; font-variant-numeric:tabular-nums; }
.mc-n.ok { color:var(--ok); } .mc-n.warn { color:var(--warn); } .mc-n.bad { color:var(--bad); }
.mc-n.mute { color:var(--mute); }
.mc-p { display:none; }
${TAB_CSS}
.mc-more { margin-top:auto; padding-top:9px; font-size:var(--fs-2); text-align:center; text-decoration:none; }
.mc-more:hover { text-decoration:underline; }
/* Rows: a small dot carries the row's tone (the journey's own marks), a hairline divides
   the rows, and the share is a thin neutral line along the row's foot — length stays a
   magnitude, colour stays the tone, and no row is a tinted block. */
.mr-h { display:flex; justify-content:space-between; gap:10px; padding:0 8px 4px; color:var(--mute);
  font-size:var(--fs-1); font-weight:600; }
.mr-h .has-tip { cursor:help; text-decoration:underline dotted; text-underline-offset:2px; }
.mr { position:relative; display:flex; justify-content:space-between; align-items:center; gap:10px;
  min-height:32px; padding:6px 8px 7px 24px; font-size:var(--fs-2); border-bottom:1px solid var(--line); }
.mr::before { content:""; position:absolute; left:8px; top:50%; width:8px; height:8px; margin-top:-4px;
  border-radius:50%; background:var(--tone, transparent); box-shadow:inset 0 0 0 1.5px var(--tone-ring, var(--line)); }
.mr.t-ok { --tone:var(--ok-fill); --tone-ring:transparent; }
.mr.t-warn { --tone:var(--warn-fill); --tone-ring:transparent; }
.mr.t-bad { --tone:var(--bad); --tone-ring:transparent; }
.mr.t-accent { --tone:var(--s1); --tone-ring:transparent; }
.mr.t-alt { --tone:var(--s3); --tone-ring:transparent; }
.mr-b { position:absolute; left:24px; bottom:-1px; height:2px; max-width:calc(100% - 24px);
  border-radius:var(--r-pill); background:color-mix(in srgb, var(--fg) 28%, transparent); }
.mr-l { position:relative; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mr-l > a { color:inherit; text-decoration:none; }
.mr-l > a:hover { text-decoration:underline; }
.mr-sub { color:var(--mute); }
.mr-sub a { text-decoration:none; }
.mr-v { position:relative; flex:none; font-weight:650; font-variant-numeric:tabular-nums; }
/* "No record" is outlined, never tinted green. */
.mr.dashed { border-bottom-style:dashed; border-bottom-color:var(--mute); }
.mr.dim { opacity:.55; }
.mr.empty { color:var(--mute); }
.mr-rest, .mr-note { padding:4px 8px 0; color:var(--mute); font-size:var(--fs-1); }
.mr-fold > summary { cursor:pointer; padding-bottom:4px; }
.mr-fold > summary:hover { color:var(--fg); }
.mr-fold[open] > summary { border-bottom:1px solid var(--line); }

/* The KPI tiles' full panels: ONE closed <details>, the checked tile's panel shown
   (render/kpi.ts generates the per-position rules). The panels inside were written as
   cards of their own, so mounting them unchanged put a card inside a card and repeated
   the title the summary had just given. Inside they lose their chrome and become
   sections split by a rule; the first one's h2 is the summary's own title, so it is not
   shown twice. */
.kpi-more { border:1px solid var(--line); border-radius:var(--r-box); background:var(--card); }
/* Two classes, so this outranks .drill-body's display below — at equal specificity the
   later rule won and every tile's panel showed at once. */
.kpis .kpi-panels > .kpi-p { display:none; }
/* The usage panel draws its own trend again: no tile above draws it any more. */
.drill-body { display:flex; flex-direction:column; padding:0 15px 13px; }
.drill-body > section.card { border:0; border-radius:0; background:none; padding:13px 0 0; overflow:visible; }
.drill-body > section.card + section.card { border-top:1px solid var(--line); margin-top:13px; }
.drill-body > section.card:first-child > h2:first-child { display:none; }
.drill-body > section.card > h2 { font-size:var(--fs-3); color:var(--mute); }

/* Agents panel (render/agents.ts): the same sub-heading the deferrals panel uses, and
   the declared crew folded under a rule like every other fold on the page. */
.ag-h { margin:14px 0 6px; font-size:var(--fs-2); font-weight:650; }
/* A flex item's minimum width is its content's, and these labels are long lists of
   stages: without min-width:0 the panel grew past a 1024px viewport and pushed the
   value column off screen. The lists ARE the content here, so they wrap, not ellipsise. */
.drill-body > #agents { min-width:0; }
#agents .mr-l { white-space:normal; }
#agents > .note:first-of-type { margin-top:0; }
details.ag-crew { margin-top:14px; border-top:1px solid var(--line); }
details.ag-crew > .note { margin-bottom:6px; }
/* The legend's mark is the rows' own dot (.mr.t-accent), not a text glyph in another colour. */
.ag-dot { display:inline-block; width:8px; height:8px; margin-right:6px; border-radius:50%;
  background:var(--s1); vertical-align:baseline; }

/* Sources: every input's age on one line; a stale one is outlined and explains itself. */
.sources { display:flex; flex-wrap:wrap; gap:6px 14px; color:var(--mute); font-size:var(--fs-1); }
.src-l { font-weight:600; }
.src.stale { color:var(--warn); border:1px dashed var(--warn); border-radius:var(--r-ctl); padding:0 5px; cursor:help; }
.src.missing { opacity:.75; }

/* Credit view (u3) — first card in the primary column. Uses host tokens only.
   The u3 view emits .card via section(); these style its inner blocks. */
.credit-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
/* Label and value side by side, not stretched to the card's width: at full width the
   value sat 500px from its label. */
.credit-current table.tbl { max-width:520px; margin-top:0; }
.credit-progress { margin-top:10px; }
.credit-progress .note { margin-top:4px; }
.credit-trend { margin-top:12px; }
.credit-chart { margin:8px 0 4px; overflow-x:auto; }
/* Claude token panel — shares the credit card's layout; only the model
   breakdown table is extra. The share cell stacks a bar over its own number so
   the column reads without relying on the bar's length alone. */
.token-models { margin-top:12px; }
.token-models th, .token-models td { white-space:nowrap; }
.token-share { min-width:110px; }
.token-share .note { margin-top:2px; }
/* The window toggle only ever inherited the plain link colour — .pickbtn's chip
   border is scoped to header.top nav, so the three windows rendered as three bare
   blue words and "7d 30d all" — in Korean, read as a date ("July 30") at a glance. A period
   selector cannot afford that misreading, so each label gets its own outline. The
   selected chip is filled and bolder rather than merely recoloured, so which window
   is active survives a colour-blind read. */
${LANG_TOGGLE_CSS}
footer { color:var(--mute); font-size:var(--fs-1); text-align:center; padding:0 0 26px; }
${NOTIFY_CSS}`;

/** The refresh poll + stream filter. Kept tiny and dependency-free. */
const SCRIPT = (pollMs: number, s: Strings, title: string) => {
  // JSON, not quotes: `Couldn't` would otherwise end the JS literal it lands in — and
  // `<` escaped, or a slug carrying `</script>` would end the script (scriptJson).
  const j = (v: string) => scriptJson(v);
  return `
(function () {
  var wrap = document.getElementById('body-wrap');
  var btn = document.getElementById('reload-btn');
  var state = document.getElementById('poll-state');

  // Copy a record path. Delegated on document: the poll replaces the hero. Loopback is a
  // secure context, so the async clipboard is there; the textarea path covers a browser
  // that withholds it, and the label says what happened either way.
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-copy]');
    if (!b) return;
    var text = b.getAttribute('data-copy');
    var done = function () {
      var label = b.textContent;
      b.textContent = b.getAttribute('data-copied') || label;
      setTimeout(function () { b.textContent = label; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {});
      return;
    }
    var t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); done(); } catch (err) {}
    t.remove();
  });

  // The title carries the banner's waiting count, rewritten after every swap.
  function setTitle() {
    var b = document.getElementById('banner');
    var c = b ? b.getAttribute('data-count') : '';
    document.title = (c ? '(' + c + ') ' : '') + ${j(title)};
  }

  function bindFilter() {
    var sel = document.getElementById('ev-filter');
    if (!sel) return;
    sel.addEventListener('change', function () {
      var v = sel.value;
      document.querySelectorAll('#ev-table tbody tr').forEach(function (tr) {
        tr.style.display = !v || tr.dataset.ev === v ? '' : 'none';
      });
    });
  }
  bindFilter();

  // Card tabs the reader chose, by radio-group name. Delegated on document because the
  // poll replaces every radio.
  var pickedTabs = {};
  // Folds the reader toggled by hand, by data-key. Keyed off the summary's click (the
  // keyboard sends one too), not the toggle event, which also fires for the script's
  // own restores. The state is read AFTER the click has run: whether a <details> flips
  // before or after a document-level click listener differs between engines (happy-dom
  // flips first, browsers after) — the same split the KPI radios hit.
  var readerFolds = {};
  document.addEventListener('click', function (e) {
    var sum = e.target && e.target.closest && e.target.closest('summary');
    var d = sum && sum.parentElement;
    if (!d || d.tagName !== 'DETAILS' || !d.dataset.key) return;
    setTimeout(function () { readerFolds[d.dataset.key] = d.open; }, 0);
  });
  // The journey's "show out of scope" box, which the poll would otherwise reset.
  var jrShowOut = false;
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'jr-show-out') jrShowOut = e.target.checked;
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('mc-r')) pickedTabs[t.name] = t.value;
  });

  // Header workspace switcher: fetch the list the first time it opens, into its slot
  // only — the heading and the /pick link stay put, so focus on the link survives. A
  // failed fetch is retried by reopening.
  var ws = document.getElementById('ws-menu');
  var wsLoaded = false;
  if (ws) {
    ws.addEventListener('toggle', function () {
      if (!ws.open || wsLoaded) return;
      wsLoaded = true;
      var slot = document.getElementById(${j(WS_SLOT)});
      fetch('/api/workspaces', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then(function (h) { slot.innerHTML = h; })
        .catch(function () {
          wsLoaded = false;
          slot.innerHTML = '<p class="ws-note err">' + ${j(esc(s.page.wsLoadFailed))} + '</p>';
        });
    });
    document.addEventListener('click', function (e) {
      if (ws.open && !ws.contains(e.target)) ws.open = false;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ws.open) { ws.open = false; ws.querySelector('summary').focus(); }
    });
  }

  // A card's "see all" link targets a panel under the KPI tiles, or something inside
  // one (the unit matrix): an anchor alone would scroll to a closed <details> without
  // opening it, or to a panel CSS is hiding because another tile is chosen. So pick the
  // panel's tile — through a change event, so the poll keeps the pick — and unfold.
  function openDrill(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    var p = el.closest && el.closest('.kpi-p');
    if (p) {
      var i = Array.prototype.indexOf.call(p.parentNode.children, p);
      var r = document.getElementById('mc-kpi-' + i);
      if (r && !r.checked) {
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (el.tagName === 'DETAILS') {
      if (!el.open) el.open = true;
    }
    else return false;
    el.scrollIntoView({ block: 'start' });
    return true;
  }
  // The Details tabs need no script: the checked radio shows its panel by CSS, and the
  // panels are never folded (since 2026-11-14 — once the summaries lead the
  // page, a fold over the full panels only hid them).
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[data-drill]');
    if (a && openDrill(a.dataset.drill)) e.preventDefault();
  });
  // The usage panel's window toggle and its refresh redirect both land on \`?cw=\`, and
  // that panel is not the default tab — without this, choosing a window would reload
  // onto a page showing another panel.
  if (location.hash) openDrill(location.hash.slice(1));
  else if (/[?&]cw=/.test(location.search)) openDrill(${j(DRILL.usage)});

  // Desktop notifications (render/notify.ts): defines notifyOn() and checkNotify().
${NOTIFY_SCRIPT(s)}
  // One refresh path for every trigger — the button, the timer and the
  // tab-focus handler all call this, so they can never drift apart.
  var busy = false;
  async function refresh(manual) {
    if (busy) return;
    busy = true;
    if (manual && btn) {
      btn.classList.add('spin');
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      var reloadLabel = btn.querySelector('.reload-label');
      if (reloadLabel) reloadLabel.textContent = ${j(s.page.jsReloading)};
    }
    try {
      // The single manual control refreshes both credit usage and the workspace.
      // A degraded credit subsystem (503) must not block the workspace refresh.
      if (manual) {
        var creditRes = await fetch('/api/refresh', { method: 'POST', cache: 'no-store' });
        if (!creditRes.ok && creditRes.status !== 503) throw new Error(creditRes.status);
      }
      var res = await fetch('/api/body' + window.location.search, { cache: 'no-store' });
      // 404 means the run itself is gone (its last live intent archived, the record
      // removed): reload so the server's own no-run page says why, instead of keeping
      // the old run on screen under a generic "refresh failed".
      if (res.status === 404) {
        window.location.reload();
        return;
      }
      if (!res.ok) throw new Error(res.status);
      var html = await res.text();
      // Preserve which <details> the reader had open across the swap.
      var open = new Set();
      document.querySelectorAll('details[data-key]').forEach(function (d) {
        if (d.open) open.add(d.dataset.key);
      });
      var y = window.scrollY;
      wrap.innerHTML = html;
      document.querySelectorAll('details[data-key]').forEach(function (d) {
        if (open.size) d.open = open.has(d.dataset.key);
        // A fold the reader opened or closed by hand keeps that state, even when nothing
        // else is open — otherwise a fold the server opens by default (the diagnostics,
        // when something is flagged) springs back open on every poll.
        if (Object.prototype.hasOwnProperty.call(readerFolds, d.dataset.key)) {
          d.open = readerFolds[d.dataset.key];
        }
      });
      // Re-apply the tabs the reader picked. Only picked ones: a card's default tab
      // is chosen by the server (Run Health opens on its first problem), and that
      // choice must be free to move when the run changes.
      var showOut = document.getElementById('jr-show-out');
      if (showOut) showOut.checked = jrShowOut;
      Object.keys(pickedTabs).forEach(function (name) {
        var r = document.querySelector('input.mc-r[name="' + name + '"][value="' + pickedTabs[name] + '"]');
        if (r) r.checked = true;
      });
      window.scrollTo(0, y);
      bindFilter();
      setTitle();
      checkNotify();
      if (state) {
        state.textContent = ${j(s.page.jsRefreshedPrefix)} + new Date().toLocaleTimeString();
        state.classList.remove('err');
      }
    } catch (e) {
      // Server down, or a sync replacing files mid-read. Say so rather than
      // leaving a stale page that looks current.
      if (state) {
        state.textContent = ${j(s.page.jsRefreshFailed)};
        state.classList.add('err');
      }
    } finally {
      busy = false;
      if (manual && btn) setTimeout(function () {
        btn.classList.remove('spin');
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        var reloadLabel = btn.querySelector('.reload-label');
        if (reloadLabel) reloadLabel.textContent = ${j(s.page.reloadLabel)};
      }, 300);
    }
  }

  // Manual reload. Needed because a change the poll cannot see coming — a stage
  // flipped between SKIP and EXECUTE, a hand-edited state file — should be
  // observable on demand rather than after waiting out the interval.
  if (btn) {
    btn.addEventListener('click', function (e) { e.preventDefault(); refresh(true); });
  }
  // Artifact links open in the user's editor, so the page must NOT navigate.
  // Delegated on document: the refresh swaps innerHTML, and a listener bound to
  // each link would die with the old nodes (the same reason the poll re-renders
  // rather than patches). Also keeps <details> state out of the click path —
  // the toggle is native, this only intercepts the anchors inside it.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a.art-link');
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains('busy')) return;
    a.classList.add('busy');
    fetch(a.getAttribute('href'), { method: 'GET' })
      .then(function (r) {
        if (r.ok) { a.classList.add('opened'); return; }
        return r.json().catch(function () { return {}; }).then(function (j) {
          a.classList.add('failed');
          a.setAttribute('title', (j && j.error) || ${j(s.page.jsOpenFailedStatus)}.replace('{status}', r.status));
        });
      })
      .catch(function () {
        a.classList.add('failed');
        a.setAttribute('title', ${j(s.page.jsOpenFailedUnreachable)});
      })
      .then(function () {
        a.classList.remove('busy');
        setTimeout(function () { a.classList.remove('opened'); }, 1200);
      });
  });

  // r / F5-like shortcut, ignored while typing in the event filter.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'r' || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    e.preventDefault();
    refresh(true);
  });
${
  pollMs > 0
    ? `  setInterval(function () {
    // Don't poll a background tab — unless notifications are on, which are only worth
    // having while the tab is in the background (render/notify.ts).
    if (document.hidden && !notifyOn()) return;
    refresh(false);
  }, ${pollMs});

  // Coming back to the tab refreshes at once. Without this the hidden-tab guard
  // above leaves the page up to one full interval stale on return, which reads
  // as "the dashboard did not notice my change".
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh(false);
  });`
    : "  /* auto-poll disabled (--poll 0) — the reload button still works */"
}
})();
`;
};

function warnings(m: DashboardModel, s: Strings): string {
  if (m.warnings.length === 0) return "";
  return `<div class="warnbox"><b>${esc(s.page.warningsHeading)}</b><ul>${m.warnings
    .map((w) => `<li>${esc(warningTextIn(w, s))}</li>`)
    .join("")}</ul></div>`;
}

/**
 * The refreshable part of the page: everything inside #body-wrap. Served on its
 * own at /api/body so the poll swaps only this.
 *
 * Top to bottom: the banner (is anything waiting for the reader, with the run line —
 * is it moving — under it), the warnings (what this read could not
 * do — degradation stays visible above everything it degrades), the KPI tiles with the
 * full panels they open (closed), the 2×2 cards (the summary), the deferrals box when
 * mounted, and the sources line (how old each input is).
 *
 * The unanswered asks and the deferral ledger are BOTH reachable because they answer
 * different questions from different files: a blank `[Answer]:` in `*-questions.md`
 * stops the run now (Run Health), while `## Assumptions & Open Questions` records debt
 * a later stage owes (Unresolved). Measured on run C — 0 blockers and 230 open items —
 * so neither count implies the other and neither card can stand in for the other.
 */
export function renderBody(m: DashboardModel, locale: Locale = DEFAULT_LOCALE): string {
  const s = strings(locale);
  // Tag details elements so the poll can restore what the reader had open.
  const keyed = (html: string, prefix: string): string => {
    let i = 0;
    return html.replace(/<details/g, () => `<details data-key="${prefix}-${i++}"`);
  };
  return `${renderBanner(m, s)}
${warnings(m, s)}
${renderJourney(m, s)}
${renderTimeSummary(m, s)}
${renderUnresolved(m, s)}
${renderDiagnostics(m, s)}
${keyed(renderKpis(m, s, kpiPanels(m, s)), "x")}
${renderDeferralBox(m, s)}`;
}

/**
 * The full document.
 *
 * `locale` threads through every panel via `strings(locale)` and reaches the markup
 * as `<html lang>` — what a screen reader picks a voice from and what a browser's
 * translate prompt reads. `langToggle` puts the switch in the header, naming each
 * language in its own language so a reader who cannot read this page can find the
 * way out.
 */
export function renderPage(
  m: DashboardModel,
  pollMs: number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const s = strings(locale);
  const title = `AI-DLC · ${m.identity.slug ?? m.identity.record}`;
  // The waiting count leads the title, so a backgrounded tab still says it — the poll
  // rewrites it from the swapped banner's data-count (SCRIPT).
  const count = waitCountText(m);
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(count ? `(${count}) ${title}` : title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <details class="ws-menu" id="ws-menu">
    <summary title="${esc(s.page.wsMenuTip)}"><h1>${esc(
      m.identity.slug ?? m.identity.record,
    )}</h1><span class="ws-caret" aria-hidden="true">▾</span></summary>
    <div class="ws-pop" id="ws-pop">${renderWorkspaceMenuShell(s)}</div>
  </details>
  <span class="path" title="${esc(m.identity.root)}">${esc(
    m.identity.root.split(/[\\/]/).filter(Boolean).pop() ?? m.identity.root,
  )} · space ${esc(m.identity.space)} · harness ${esc(
    m.identity.harnessDir ?? s.page.harnessNotFound,
  )}</span>
  <nav>
    ${langToggle(locale, s)}
    ${notifySwitch(s)}
    <button id="reload-btn" class="pickbtn reload" type="button"
            title="${esc(s.page.reloadTitle)}">
      <span class="reload-icon" aria-hidden="true">⟳</span><span class="reload-label">${esc(
        s.page.reloadLabel,
      )}</span>
    </button>
    <span id="poll-state" class="mute">${esc(m.generatedAt)}</span>
  </nav>
</header>
<main id="body-wrap">
${renderBody(m, locale)}
</main>
<footer>${esc(s.page.footer)} · v${esc(VERSION)}</footer>
<script>${SCRIPT(pollMs, s, title)}</script>
</body>
</html>`;
}
