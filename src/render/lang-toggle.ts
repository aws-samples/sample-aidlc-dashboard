// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The page-language chips, shared by every page a reader can land on: the dashboard
// header, the folder picker and the no-run page. The last two are where a run that has
// just started lands — before its first intent exists — so a reader there must be able
// to switch language without editing the URL (owner, 2026-11-15).
//
// `?lang=` is a plain link, so this works with JavaScript off, and the server persists
// the choice in a cookie — every other link therefore needs no `lang` param. A page whose
// own state lives in its query (the picker's `dir` and `hidden`) passes `keep` so the
// switch does not send the reader back to their home folder.

import type { Locale } from "../model/types";
import { esc } from "./common";
import type { Strings } from "./i18n";

const LOCALES: readonly Locale[] = ["ko", "en"];

export function langToggle(
  current: Locale,
  s: Strings,
  keep: Readonly<Record<string, string | undefined>> = {},
): string {
  const href = (l: Locale) => {
    const q = new URLSearchParams({ lang: l });
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) q.set(k, v);
    return `?${q.toString()}`;
  };
  const label = (l: Locale) => (l === "ko" ? s.page.langKo : s.page.langEn);
  return `<span class="window-toggle lang" role="radiogroup" aria-label="${esc(
    s.page.langGroupLabel,
  )}">${LOCALES.map(
    (l) =>
      `<a role="radio" aria-checked="${l === current ? "true" : "false"}" href="${esc(href(l))}">${esc(
        label(l),
      )}</a>`,
  ).join("")}</span>`;
}

/*
 * Chips rather than a dropdown, because the trend window picker has the same SHAPE — two
 * or three short mutually-exclusive choices in a radiogroup — and the dashboard reuses
 * `.window-toggle` for both. Each label gets its own outline, and the selected chip is
 * filled and bolder rather than merely recoloured, so which one is active survives a
 * colour-blind read. `.lang` only tightens the padding for a header's denser row. The
 * rules read the shared colour tokens (`tokens.ts`), so a page that includes them needs
 * TOKENS_CSS too; the type-scale and radius tokens live in the dashboard's own sheet, so
 * each carries that sheet's value as its fallback for the picker and the no-run page.
 */
export const LANG_TOGGLE_CSS = `
.window-toggle { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.window-toggle a { text-decoration:none; color:var(--fg); font-size:var(--fs-2, 12px); line-height:1.4;
  border:1px solid var(--line); border-radius:var(--r-pill, 999px); padding:3px 11px; white-space:nowrap; }
.window-toggle a:hover { border-color:var(--accent); color:var(--accent); }
.window-toggle a[aria-checked="true"] { border-color:var(--accent); background:var(--accent);
  color:var(--bg); font-weight:600; }
.window-toggle.lang a { padding:2px 9px; font-size:var(--fs-1, 11px); }
`;
