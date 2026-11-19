// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The `/view` page: one record artifact's source text, escaped.
//
// WHY THE SOURCE AND NOT RENDERED MARKDOWN. What this page is for is letting the reader
// see the thing a panel just named — the blank `[Answer]:` under a question heading,
// the `**Feedback**` a human wrote at a rejected gate. That is served by the source,
// and a markdown renderer would mean standing up an HTML generator over text this
// repo treats as hostile input, to buy typography. So every byte of the file is shown,
// escaped, in order. Since 2026-11-15 each LINE is dressed by what it is — headings,
// questions, answer tags, options — with an outline of the file's questions and line
// anchors; render/source-view.ts says where that stops (a class name per line, never
// markup from the file) and why it is still the source.
//
// THAT IS ALSO WHY `.html` IS NOT REFUSED. An artifact `.html` (the visual-mockups
// stages write them) is escaped here like every other artifact, so its `<script>` is
// text on the page, not script in our origin. Refusing it — the first design — was
// answering a threat the escaping had already removed, while dropping a real
// deliverable the artifact list and `/open` both already carry. The response still
// ships a script-free CSP and `nosniff` (see server.ts) as defence in depth: an escaping
// bug could not run script, load anything, rebase relative links or post a form. It is
// not a sandbox — leaked markup could still draw a same-origin link (found in review) — so
// the escaping is the line, and the header narrows what a slip could do.

import type { Locale } from "../model/types";
import type { ViewResult } from "../scan/view-file";
import { esc } from "./common";
import { type Strings, strings } from "./i18n";
import { DEFAULT_LOCALE } from "./locale";
import { SOURCE_CSS, renderSource } from "./source-view";
import { FONT_STACK, TOKENS_CSS } from "./tokens";
import { refusalText } from "./warnings";

const MONO = `"SFMono-Regular",Consolas,"Liberation Mono",monospace`;

const VIEW_STYLE = `${TOKENS_CSS}
:root { --sans:${FONT_STACK}; --mono:${MONO}; }
* { box-sizing:border-box; }
body {
  margin:0; background:var(--bg); color:var(--fg);
  font:14px/1.6 var(--sans);
}
.shell { max-width:1180px; margin:0 auto; padding:28px 22px 64px; }
.crumbs { margin:0 0 16px; }
.crumbs a { color:var(--accent); font-size:12px; text-decoration:none; }
.crumbs a:hover { text-decoration:underline; }
.head { padding:0 0 16px; margin:0 0 18px; border-bottom:1px solid var(--line); }
h1 { margin:0 0 10px; font:650 15px/1.45 var(--mono); overflow-wrap:anywhere; }
.meta { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; margin:0; color:var(--mute); font-size:12px; }
.pill { display:inline-flex; align-items:center; gap:6px; padding:2px 10px; border:1px solid var(--line);
  border-radius:999px; font-weight:600; color:var(--fg); }
.pill::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--mute); }
.pill.warn { color:var(--warn); border-color:currentColor; }
.pill.warn::before { background:var(--warn); }
.pill.ok { color:var(--ok); border-color:currentColor; }
.pill.ok::before { background:var(--ok); }
.btn { padding:3px 11px; border:1px solid var(--line); border-radius:999px; color:var(--fg);
  text-decoration:none; font-weight:600; }
.btn:hover { border-color:var(--accent); color:var(--accent); }
.copy { display:inline-flex; align-items:center; gap:6px; flex:1 1 260px; min-width:0; }
/* No script runs on this page, so there is no copy button: the path is text that selects
   whole on one click (user-select:all on an element, not on an input, where it does not
   promise that), and the tip says to copy it. */
.copy code { flex:1; min-width:0; padding:3px 9px; border:1px solid var(--line); border-radius:6px;
  background:var(--raised); color:var(--fg); font:12px/1.5 var(--mono); overflow-wrap:anywhere;
  user-select:all; -webkit-user-select:all; cursor:text; }
.note { margin:0 0 16px; padding:9px 12px; border-left:3px solid var(--warn); color:var(--warn); }
.body { display:grid; grid-template-columns:minmax(0,1fr); gap:22px; }
.body.has-outline { grid-template-columns:230px minmax(0,1fr); }
.body.has-outline .outline { position:sticky; top:16px; align-self:start; max-height:calc(100vh - 32px); overflow:auto; }
@media (max-width:900px) {
  .body.has-outline { grid-template-columns:minmax(0,1fr); }
  .body.has-outline .outline { position:static; max-height:none; }
}
.empty { margin:0; color:var(--mute); }
${SOURCE_CSS}
`;

/** Bytes as a short human figure. Not locale-split: `toLocaleString`'s thousands
 *  separator is identical for ko-KR and en-US (measured), and the
 *  unit letters are the same in both catalogues. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shell(locale: Locale, s: Strings, rel: string, body: string): string {
  const t = s.viewer;
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.docTitle(rel))}</title>
<style>${VIEW_STYLE}</style>
</head>
<body>
<div class="shell">
  <p class="crumbs"><a href="/">${esc(t.back)}</a></p>
  ${body}
</div>
</body>
</html>`;
}

/**
 * Render the source page for `rel`, or the refusal that stopped it.
 *
 * `rel` is passed separately from `result` because the failure branch has no source to
 * take it from, and the page should still say which path it was asked for.
 */
export function renderViewPage(
  result: ViewResult,
  rel: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const s = strings(locale);
  const t = s.viewer;

  if (!result.ok) {
    return shell(
      locale,
      s,
      rel,
      `<h1>${esc(rel)}</h1>
  <p class="note" role="alert">${esc(t.refusalHeading)} — ${esc(refusalText(result.refusal, s))}</p>`,
    );
  }

  const src = result.source;
  const view = src.text.length > 0 ? renderSource(src.text, rel, s) : undefined;
  const meta: string[] = [`<span>${esc(t.size(fmtBytes(src.sizeBytes)))}</span>`];
  // A truncated view read only the prefix it shows, so its count is not the file's.
  if (view && view.total > 0 && !src.truncated) {
    meta.push(
      `<span class="pill ${view.blank > 0 ? "warn" : "ok"}">${esc(t.blankCount(view.blank, view.total))}</span>`,
    );
  }
  meta.push(
    `<a class="btn" href="/open?rel=${encodeURIComponent(rel)}">${esc(t.openInEditor)}</a>`,
  );
  meta.push(
    `<span class="copy"><span>${esc(t.copyPathLabel)}</span><code title="${esc(t.copyPathTip)}">${esc(
      rel,
    )}</code></span>`,
  );
  const parts: string[] = [
    `<div class="head"><h1>${esc(rel)}</h1><p class="meta">${meta.join("")}</p></div>`,
  ];
  if (src.truncated) {
    parts.push(
      `<p class="note">${esc(t.truncated(fmtBytes(src.shownBytes), fmtBytes(src.sizeBytes)))}</p>`,
    );
  }
  if (view?.unclosed) parts.push(`<p class="note">${esc(t.unclosedNote)}</p>`);
  parts.push(
    view
      ? `<div class="body${view.outline ? " has-outline" : ""}">${view.outline}${view.pre}</div>`
      : `<p class="empty">${esc(t.empty)}</p>`,
  );

  return shell(locale, s, rel, parts.join("\n  "));
}
