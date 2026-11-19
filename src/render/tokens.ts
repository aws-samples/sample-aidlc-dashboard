// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The colour tokens every page of this server shares — the dashboard, the folder picker
// and the source viewer used to carry three slightly different sets.
//
// Two families, because the two jobs pull apart and no single value does both:
//
//   ink (--fg, --mute, --ok, --warn, --bad, --accent, --accent2) is TEXT as often as it
//   is a mark — status rides on 11–12px pills, which is normal text, not large — so each
//   one clears WCAG AA 4.5:1 against BOTH surfaces of its mode. Measured:
//     light on #fcfcfb / #f9f9f7: fg 19.2/18.7, mute 5.28/5.15, ok 4.88/4.75,
//       warn 5.38/5.24, bad 5.15/5.01, accent 5.48/5.34, accent2 5.29/5.15
//     dark on #1a1a19 / #0d0d0d: fg 15.2/16.9, mute 6.57/7.33, ok 6.36/7.10,
//       warn 9.49/10.6, bad 5.76/6.43, accent 6.24/6.97, accent2 6.92/7.72
//
//   status fills (--ok-fill, --warn-fill) are the dataviz status steps, fixed across
//   modes: a dot or a tint wants the signal's own hue, and the text-safe light amber is
//   brown. Never text — on the light surface warning is 1.79:1 — and always beside an
//   icon or a label, never carrying a meaning alone.
//
//   series (--s1 work, --s2 waiting on the person, --s3 conversation, --s-park parked)
//   only ever FILLS a chart mark, so it follows the dataviz palette instead: its first
//   three categorical slots, the ones that validate on every pair in both modes (CVD ΔE
//   9.2 light / 9.4 dark). Dark text-safe ink sits above that palette's lightness band
//   and light text-safe aqua below its chroma floor, which is why the two families are
//   separate rather than one compromise. Aqua is under 3:1 on the light surface, so a
//   chart using it labels its parts in text (the time legend does).
//
// Surfaces and ink are the dataviz chrome: a warm near-white / near-black plane, a card
// one step off it, hairline borders. Dark is the default and light follows the OS, as
// before; the values are picked per mode, never one mode flipped.

export const TOKENS_CSS = `
:root {
  color-scheme: light dark;
  --bg:#0d0d0d; --card:#1a1a19; --panel:#1a1a19; --raised:#222220; --line:#2f2f2c;
  --fg:#f0efec; --mute:#a19f97;
  --ok:#2fb34a; --warn:#fab219; --bad:#ec6d66; --accent:#5b9df0; --accent2:#2fb88a;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s-park:#3a3a37;
  --ok-fill:#0ca30c; --warn-fill:#fab219;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg:#f9f9f7; --card:#fcfcfb; --panel:#fcfcfb; --raised:#f3f3f0; --line:#e3e2db;
    --fg:#0b0b0b; --mute:#6b6a64;
    --ok:#17803f; --warn:#8f5f00; --bad:#c23b37; --accent:#2266c0; --accent2:#16785a;
    --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s-park:#dedcd4;
  }
}
`;

/** The UI sans the three pages share — system faces only, no webfont (offline use). */
export const FONT_STACK = `system-ui,-apple-system,"Apple SD Gothic Neo","Segoe UI",sans-serif`;
