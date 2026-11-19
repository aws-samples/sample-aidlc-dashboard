// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Workspace picker: bounded discovery first, then — folded — one cross-platform filesystem
// explorer and explicit path entry.
//
// ORDER IS THE POINT (2026-11-16). Picking a found workspace is what the page is for, so
// the list leads and the two ways to reach somewhere else sit in one fold under it, open
// only when the list cannot answer (nothing found, a listing or a typed path failed, or the
// reader is already browsing). Within the list: the workspace on screen now, then the ones
// with a run, newest state first, then a folded group of those with nothing to show. That
// ordering needs each card's summary, which loads lazily (four at a time, scan/summary.ts),
// so the cards are regrouped ONCE, after every summary has answered — one reflow instead of
// a card jumping under the pointer each time a read lands. Without script the list stays in
// discovery order, every card a plain link.

import type { Locale } from "../model/types";
import type { BrowseResult } from "../scan/browse";
import {
  type ExplorerModel,
  type ExplorerRootKind,
  type ExplorerRootLabel,
  buildExplorer,
} from "../scan/explorer";
import type { WorkspaceDiscovery, WorkspaceMatch } from "../scan/workspaces";
import { esc } from "./common";
import { type Strings, strings } from "./i18n";
import { LANG_TOGGLE_CSS, langToggle } from "./lang-toggle";
import { DEFAULT_LOCALE } from "./locale";
import { FONT_STACK, TOKENS_CSS } from "./tokens";

const PICKER_STYLE = `${TOKENS_CSS}${LANG_TOGGLE_CSS}
* { box-sizing:border-box; }
body {
  margin:0; min-width:280px; background:var(--bg); color:var(--fg);
  font:14px/1.5 ${FONT_STACK}; letter-spacing:0;
}
body::before {
  content:""; position:fixed; inset:0; pointer-events:none; opacity:.22;
  background-image:linear-gradient(var(--line) 1px,transparent 1px),
    linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:32px 32px; mask-image:linear-gradient(to bottom,#000,transparent 70%);
}
a { color:inherit; }
code,.path,input {
  font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; letter-spacing:0;
}
.shell { position:relative; max-width:980px; margin:0 auto; padding:40px 24px 64px; }
.masthead {
  display:grid; grid-template-columns:minmax(0,1fr) auto; gap:24px; align-items:end;
  padding-bottom:22px; border-bottom:1px solid var(--line);
}
.eyebrow { margin:0 0 8px; color:var(--ok); font:600 11px/1.2 inherit; text-transform:uppercase; }
h1 { margin:0; font-size:clamp(25px,5vw,38px); line-height:1.08; font-weight:650; }
.scan-summary { min-width:128px; text-align:right; color:var(--mute); font-size:12px; }
.scan-summary .lang { justify-content:flex-end; }
main { display:grid; gap:0; }
.section { padding:26px 0; border-bottom:1px solid var(--line); }
.section-head {
  display:flex; align-items:center; justify-content:space-between; gap:18px; margin-bottom:14px;
}
h2 { margin:0; font-size:13px; font-weight:650; }
.quiet-link { color:var(--mute); font-size:12px; text-decoration:none; }
.quiet-link:hover { color:var(--accent); }
.rescan-link { display:inline-flex; align-items:center; gap:4px; }
.rescan-icon {
  display:inline-block; width:1em; text-align:center; transform-origin:50% 50%;
}
.rescan-link.scanning { color:var(--accent); cursor:wait; pointer-events:none; }
.rescan-link.scanning .rescan-icon { animation:picker-rescan-spin .7s linear infinite; }
@keyframes picker-rescan-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) {
  .rescan-link.scanning .rescan-icon { animation:none; }
}
.workspace-list {
  display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px;
}
/* The whole card is the one link: no inner control, so a click anywhere opens it. */
.workspace {
  position:relative; min-width:0; min-height:84px; padding:13px 14px; display:grid;
  grid-template-columns:minmax(0,1fr) auto; gap:4px 12px; align-content:start;
  border:1px solid var(--line); border-radius:7px; background:var(--panel); text-decoration:none;
  transition:border-color .15s ease,transform .15s ease;
}
.workspace:hover { border-color:var(--accent); transform:translateY(-1px); }
.workspace:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.workspace[hidden] { display:none; }
.workspace.current { border-color:var(--ok); }
.workspace-name {
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:650;
}
.workspace-go { color:var(--accent); font-size:13px; }
.workspace-path {
  grid-column:1/-1; color:var(--mute); overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; font-size:11px;
}
.group-label { margin:0 0 6px; color:var(--ok); font-size:11px; font-weight:650; }
.group-label.later { margin-top:16px; color:var(--mute); }
.group-label[hidden] { display:none; }
.idle-group { margin-top:14px; }
.idle-group > summary { cursor:pointer; color:var(--mute); font-size:12px; margin-bottom:8px; }
.idle-group[hidden] { display:none; }
.found-tools { display:grid; grid-template-columns:minmax(180px,1fr); margin-bottom:12px; }
.found-meta { color:var(--mute); font-size:11.5px; }
.section-head .head-right { display:flex; align-items:center; gap:14px; }
.other-locations { padding:22px 0 0; }
.other-locations > summary { cursor:pointer; font-size:13px; font-weight:650; }
.other-locations[open] > summary { margin-bottom:4px; }
/* Per-card summary — the server draws labelled empty slots and the script fills in only the numbers. */
.ws-summary {
  grid-column:1/-1; min-height:17px; display:flex; align-items:baseline; gap:12px;
  flex-wrap:wrap; margin-top:2px;
}
.ws-metric { display:inline-flex; align-items:baseline; gap:4px; }
.ws-metric[hidden] { display:none; }
.ws-metric b { color:var(--fg); font-size:13px; font-weight:650; }
.ws-metric i { color:var(--mute); font-size:10.5px; font-style:normal; }
/* Only a blank-answer count turns the warning colour, and only when nonzero — "none" is an ordinary fact, said in muted text. */
.ws-m-blank.has-blank b { color:var(--bad); }
.ws-m-blank.none b { display:none; }
.ws-updated { color:var(--mute); font-size:10.5px; }
.ws-stage {
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--mute); font-size:10.5px;
}
.ws-state { color:var(--mute); font-size:10.5px; }
.launch-mark { grid-column:1/-1; color:var(--accent); font-size:10.5px; font-weight:600; }
.empty {
  margin:0; padding:20px; border:1px dashed var(--line); color:var(--mute); text-align:center;
}
.notice { margin:0 0 14px; padding:9px 11px; border-left:3px solid var(--bad); color:var(--bad); }
.truncated { margin:10px 0 0; color:var(--warn); font-size:11.5px; }
/* A real label, not a placeholder. A placeholder disappears the moment the user
   starts typing, which is exactly when a path field is easiest to lose track of. */
.field-label { display:block; margin:0 0 5px; color:var(--mute); font-size:11.5px; }
/* The toolbar filter keeps its label off-screen: it sits in a tight row next to a
   magnifier glyph, and a visible label there would push the explorer controls apart.
   Screen readers still get it, which is the part the placeholder could not carry. */
.field-label.sr {
  position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
  clip-path:inset(50%); white-space:nowrap; border:0;
}
input {
  width:100%; min-width:0; height:40px; padding:0 11px; border:1px solid var(--line);
  border-radius:6px; background:var(--panel); color:var(--fg); font-size:12px;
}
input:focus { outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent); border-color:var(--accent); }
button,.btn {
  height:40px; padding:0 15px; display:inline-flex; align-items:center; justify-content:center;
  border:1px solid var(--ok); border-radius:6px; background:var(--ok); color:var(--bg);
  font:650 12px/1 inherit; text-decoration:none; cursor:pointer;
}
button:hover,.btn:hover { filter:brightness(1.08); }
.field-note { margin:8px 0 0; color:var(--mute); font-size:11.5px; }
.explorer-panel { border:1px solid var(--line); border-radius:7px; background:var(--panel); overflow:hidden; }
/* One bar: the roots as small buttons, the path field, Open. The field takes the room;
   the roots wrap above it on a narrow screen. */
.path-bar {
  padding:10px 12px; display:flex; flex-wrap:wrap; align-items:center; gap:6px;
  border-bottom:1px solid var(--line); background:var(--raised);
}
.path-bar input {
  flex:1 1 260px; height:34px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px;
}
.path-bar button { height:34px; }
.explorer-roots { display:flex; gap:4px; flex-wrap:wrap; }
.explorer-root {
  flex:none; height:34px; padding:0 9px; display:inline-flex; align-items:center; gap:5px;
  border:1px solid var(--line); border-radius:6px; background:var(--panel);
  color:var(--mute); text-decoration:none; font-size:11px;
}
.explorer-root:hover { color:var(--accent); border-color:var(--accent); }
.explorer-root.active { color:var(--fg); border-color:var(--ok); }
.root-icon { width:16px; color:var(--accent); text-align:center; font:650 12px/1 monospace; }
.explorer-location {
  padding:8px 14px; display:flex; align-items:center; gap:10px; border-bottom:1px solid var(--line);
}
.explorer-location .breadcrumbs { flex:1; min-width:0; }
.hidden-toggle { flex:none; color:var(--mute); font-size:11px; text-decoration:none; }
.hidden-toggle:hover { color:var(--accent); }
.path-status { margin:0; padding:0 14px; color:var(--mute); font-size:11px; }
.path-status:empty { display:none; }
.path-status:not(:empty) { padding:7px 14px; border-bottom:1px solid var(--line); }
.path-status.none { color:var(--warn); }
.field-note kbd {
  padding:0 4px; border:1px solid var(--line); border-radius:3px; font:10.5px ui-monospace,monospace;
}
.breadcrumbs {
  min-height:24px; display:flex; align-items:center; gap:4px; overflow-x:auto; white-space:nowrap;
  scrollbar-width:thin;
}
.breadcrumbs a,.breadcrumbs span {
  min-height:24px; padding:3px 5px; display:inline-flex; align-items:center;
  border-radius:4px; color:var(--mute); font-size:11px; text-decoration:none;
}
.breadcrumbs a:hover { color:var(--accent); background:var(--raised); }
.breadcrumbs span[aria-current="location"] { color:var(--fg); font-weight:650; }
.crumb-separator { flex:none; color:var(--line); font-size:12px; }
.filter-wrap { position:relative; }
.filter-wrap input { height:34px; padding:0 36px 0 30px; background:var(--panel); }
.filter-icon {
  position:absolute; left:10px; top:50%; color:var(--mute); transform:translateY(-50%);
  font-size:13px; pointer-events:none;
}
.directory-viewport { max-height:360px; overflow-y:auto; scrollbar-width:thin; }
.dirs { list-style:none; margin:0; padding:0; }
.dir-row { min-height:41px; display:flex; align-items:center; gap:8px; border-bottom:1px solid var(--line); }
.dir-row:last-child { border-bottom:0; }
.dir-row:hover { background:color-mix(in srgb,var(--accent) 7%,transparent); }
.dir-row[hidden] { display:none; }
.dir-nav {
  min-width:0; flex:1; padding:9px 14px; display:flex; align-items:center; gap:8px;
  text-decoration:none;
}
.dir-icon { width:18px; flex:none; color:var(--accent); text-align:center; }
.dir-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tag {
  flex:none; color:var(--ok); border:1px solid currentColor; border-radius:5px;
  padding:0 5px; font-size:9.5px;
}
.tag.unreadable { color:var(--mute); }
.dir-pick { flex:none; margin-right:14px; color:var(--ok); font-size:11px; text-decoration:none; }
.explorer-empty { margin:0; border:0; border-radius:0; background:var(--panel); }
.footer { padding-top:18px; color:var(--mute); font-size:11.5px; }
.footer a { color:var(--accent); }
@media (max-width:640px) {
  .shell { padding:26px 16px 48px; }
  .masthead { grid-template-columns:1fr; gap:14px; }
  .scan-summary { text-align:left; }
  .workspace-list { grid-template-columns:1fr; }
  .tag { display:none; }
}
`;

/** How the request reached the picker — things the page cannot tell from its data. */
export interface PickerView {
  /** Open the "another location" fold: the reader is browsing (`/browse`, a `dir=`). */
  openOther?: boolean;
  /** The home directory, for `~` in card paths. */
  home?: string;
  /** A hop between folders (`/browse`): put the caret in the path field. */
  focusPath?: boolean;
}

const EMPTY_DISCOVERY: WorkspaceDiscovery = {
  workspaces: [],
  searchedRoots: [],
  scannedDirectories: 0,
  truncated: false,
};

/** `/browse?dir=…` link, with the hidden-files flag carried along. */
function browseHref(dir: string, showHidden: boolean): string {
  const query = new URLSearchParams({ dir });
  if (showHidden) query.set("hidden", "1");
  return `/browse?${query.toString()}`;
}

/**
 * A path as a card shows it: home-relative (`~`), and when long, cut in the MIDDLE so the
 * tail stays — the tail is what tells two same-named workspaces apart (a dozen cards were
 * named `skills`, `kiro` or `claude` on one machine, differing only in their last
 * folders). The full path is the card's tooltip. Splits on both slash families, so a
 * Windows path cuts the same way.
 */
export function displayPath(full: string, home?: string, max = 56): string {
  let p = full;
  if (home && (p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`))) {
    p = `~${p.slice(home.length)}`;
  }
  if (p.length <= max) return p;
  const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
  const parts = p.split(sep);
  const head = parts.slice(0, p.startsWith("~") || parts[0] === "" ? 2 : 1).join(sep);
  const tail: string[] = [];
  for (let i = parts.length - 1; i >= head.split(sep).length; i--) {
    const next = [parts[i], ...tail].join(sep);
    if (head.length + 3 + next.length > max && tail.length > 0) break;
    tail.unshift(parts[i]!);
  }
  return `${head}${sep}…${sep}${tail.join(sep)}`;
}

function workspaceRow(
  workspace: WorkspaceMatch,
  index: number,
  s: Strings,
  home: string | undefined,
  isCurrent = false,
): string {
  const t = s.picker;
  const id = `ws-${index}`;
  // ONE anchor for the whole card: its accessible name is the workspace name alone
  // (aria-labelledby), and the path and figures are its description, so a screen reader
  // hears "word-book, link" and then the rest — not every number run together.
  // The summary slots are EMPTY and labelled. The client fetches `/api/summary` per card and
  // writes only numbers into them, so every word on this card came from the catalogue — the
  // same split that keeps a locale out of the model.
  return `<a class="workspace${isCurrent ? " current" : ""}" id="${id}"
   href="/select?dir=${encodeURIComponent(workspace.path)}"
   aria-labelledby="${id}-n" aria-describedby="${id}-p ${id}-s"
   data-ws-index="${index}" data-ws-match="${esc(
     `${workspace.name}\n${workspace.path}`.toLocaleLowerCase(),
   )}"${workspace.nearLaunch ? ' data-near-launch="1"' : ""}>
    <span class="workspace-name" id="${id}-n">${esc(workspace.name)}</span>
    <span class="workspace-go" aria-hidden="true">›</span>
    <span class="workspace-path" id="${id}-p" title="${esc(workspace.path)}">${esc(
      displayPath(workspace.path, home),
    )}</span>
    ${workspace.nearLaunch ? `<span class="launch-mark">${esc(t.launchMark)}</span>` : ""}
    <span class="ws-summary" id="${id}-s" data-summary-dir="${esc(workspace.path)}" aria-live="polite">
      <span class="ws-metric ws-m-pct" hidden><b></b><i>${esc(t.summaryPctLabel)}</i></span>
      <span class="ws-metric ws-m-blank" hidden><b></b><i></i></span>
      <span class="ws-stage"></span>
      <span class="ws-updated"></span>
      <span class="ws-state"></span>
    </span>
  </a>`;
}

function directoryRow(
  entry: BrowseResult["entries"][number],
  showHidden: boolean,
  s: Strings,
): string {
  const t = s.picker;
  const tag = entry.isWorkspace
    ? `<span class="tag">${esc(t.tagWorkspace)}</span>`
    : entry.isAidlcDir
      ? `<span class="tag">${esc(t.tagAidlcTree)}</span>`
      : entry.unreadable
        ? `<span class="tag unreadable">${esc(t.tagUnreadable)}</span>`
        : "";
  const select =
    entry.isWorkspace || entry.isAidlcDir
      ? `<a class="dir-pick" href="/select?dir=${encodeURIComponent(entry.fullPath)}">${esc(
          t.open,
        )}</a>`
      : "";

  return `<li class="dir-row" data-dir-name="${esc(entry.name.toLocaleLowerCase())}" data-dir-label="${esc(entry.name)}">
  <a class="dir-nav" href="${esc(browseHref(entry.fullPath, showHidden))}">
    <span class="dir-icon" aria-hidden="true">${entry.isWorkspace ? "◆" : "›"}</span>
    <span class="dir-name">${esc(entry.name)}</span>${tag}
  </a>
  ${select}
</li>`;
}

function rootIcon(kind: ExplorerRootKind): string {
  switch (kind) {
    case "home":
      return "⌂";
    case "current":
      return "◆";
    case "cloud":
      return "☁";
    case "drive":
      return "▣";
    case "volume":
      return "◫";
    case "filesystem":
      return "/";
  }
}

/** A root chip's words: the synthesised part from the catalogue, the read part verbatim. */
function rootLabel(label: ExplorerRootLabel, s: Strings): string {
  const t = s.explorer;
  switch (label.key) {
    case "home":
      return t.rootHome;
    case "current":
      return t.rootCurrent;
    case "root":
      return t.rootRoot;
    case "volume":
      return t.volume(label.name);
    case "mount":
      return t.mount(label.name);
    case "media":
      return t.media(label.name);
    case "raw":
      return label.name;
    default: {
      const unhandled: never = label;
      return unhandled;
    }
  }
}

/**
 * The folder being shown, as the path field holds it: home-relative (`~`) and ending in a
 * separator, so what the reader types after it is the filter over this folder's children.
 * `expandHome` on the server turns it back into the absolute directory on submit.
 */
export function pathFieldValue(dir: string, home?: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  let p = dir;
  if (home && (p === home || p.startsWith(`${home}${sep}`))) p = `~${p.slice(home.length)}`;
  return p.endsWith(sep) ? p : `${p}${sep}`;
}

/**
 * ONE control for "somewhere else": the roots, a path field, and the folder's children
 * under it (2026-11-16, the owner's call — the folder browser and the path form were two
 * controls doing one job). The field opens a workspace on Enter, goes to any other folder
 * on Enter (the server redirects a non-workspace folder to `/browse`), and filters this
 * folder by whatever follows its last separator. A `/browse` page renders the field with
 * `autofocus`, which both focuses it and scrolls it into view — with or without script. The
 * links carry NO `#other-locations` fragment: a browser skips autofocus when the URL targets
 * an element (measured: with the fragment the focus stayed on the body, without it on the
 * field), so the fragment that was meant to land the reader here took the caret away.
 */
function renderExplorer(
  browse: BrowseResult,
  showHidden: boolean,
  explorer: ExplorerModel,
  s: Strings,
  home?: string,
  focusPath = false,
): string {
  const t = s.picker;
  const roots = explorer.roots
    .map(
      (root) =>
        `<a class="explorer-root${root.active ? " active" : ""}" href="${esc(
          browseHref(root.path, showHidden),
        )}"${root.active ? ' aria-current="true"' : ""}>
  <span class="root-icon" aria-hidden="true">${rootIcon(root.kind)}</span>
  <span>${esc(rootLabel(root.label, s))}</span>
</a>`,
    )
    .join("");
  const breadcrumbs = explorer.breadcrumbs
    .map((crumb, index) => {
      const separator =
        index > 0 ? '<span class="crumb-separator" aria-hidden="true">›</span>' : "";
      const content = crumb.current
        ? `<span aria-current="location">${esc(crumb.label)}</span>`
        : `<a href="${esc(browseHref(crumb.path, showHidden))}">${esc(crumb.label)}</a>`;
      return `${separator}${content}`;
    })
    .join("");
  const rows =
    browse.entries.length > 0
      ? `<ul class="dirs">${browse.entries
          .map((entry) => directoryRow(entry, showHidden, s))
          .join("")}</ul>`
      : `<p class="empty explorer-empty">${esc(t.explorerEmpty)}</p>`;
  const value = pathFieldValue(browse.dir, home);
  const abs = pathFieldValue(browse.dir);

  return `<div class="explorer-panel">
    <form class="path-bar" action="/select" method="get">
      <nav class="explorer-roots" aria-label="${esc(t.explorerRootsLabel)}">${roots}</nav>
      <label class="field-label sr" for="path-input">${esc(t.pathLabel)}</label>
      <input id="path-input" name="dir" value="${esc(value)}"
             data-base="${esc(value)}" data-abs="${esc(abs)}"
             aria-describedby="path-note path-status"${focusPath ? " autofocus" : ""}
             autocomplete="off" spellcheck="false">
      ${showHidden ? '<input type="hidden" name="hidden" value="1">' : ""}
      <button type="submit">${esc(t.open)}</button>
    </form>
    <div class="explorer-location">
      <nav class="breadcrumbs" aria-label="${esc(t.breadcrumbLabel)}">${breadcrumbs}</nav>
      <a class="hidden-toggle" href="${esc(browseHref(browse.dir, !showHidden))}">${esc(
        showHidden ? t.hideHidden : t.showHidden,
      )}</a>
    </div>
    <p id="path-status" class="path-status" role="status" aria-live="polite"></p>
    <div class="directory-viewport" id="directory-viewport">
      ${rows}
    </div>
  </div>
  <p class="field-note" id="path-note">${t.pathNote}</p>`;
}

export function renderPicker(
  browse: BrowseResult,
  showHidden: boolean,
  current?: string,
  discovery: WorkspaceDiscovery = EMPTY_DISCOVERY,
  explorer: ExplorerModel = buildExplorer(browse.dir, { activeRoot: current }),
  locale: Locale = DEFAULT_LOCALE,
  view: PickerView = {},
): string {
  const s = strings(locale);
  const t = s.picker;
  const ex = s.explorer;
  // The parameterised tips are catalogue sentences called with PLACEHOLDERS, so the client
  // substitutes values into copy it never composes. JSON.stringify for the same reason
  // page.ts uses it: an apostrophe in English copy must not terminate the JS literal.
  const summaryTextJson = JSON.stringify({
    noRunNone: t.summaryNoRunNone,
    noRunAmbiguous: t.summaryNoRunAmbiguous,
    noRunArchived: t.summaryNoRunArchived("{n}"),
    unreadable: t.summaryUnreadable,
    failed: t.summaryFailed,
    progressTip: t.summaryProgressTip("{done}", "{total}", "{asOf}"),
    blockersTip: t.summaryBlockersTip("{asked}"),
    blockersUnreadableTip: t.summaryBlockersUnreadableTip("{n}"),
    blank: t.summaryBlankLabel,
    blankNone: t.summaryBlankNone,
    updated: t.summaryUpdated("{rel}"),
    agoNow: t.agoNow,
    agoMinutes: t.agoMinutes("{n}"),
    agoHours: t.agoHours("{n}"),
    agoDays: t.agoDays("{n}"),
    idleGroup: t.idleGroup("{n}"),
  });
  const pathTextJson = JSON.stringify({
    hint: t.pathHint,
    none: t.filterNoMatch,
    one: t.dirMatchCount(1),
    many: t.dirMatchCount(2).replace("2", "{n}"),
  });
  // The workspace on screen leads, marked, whether or not discovery reached it (a root
  // given on the command line can sit outside every scanned location).
  const others = discovery.workspaces.filter((w) => w.path !== current);
  const currentMatch: WorkspaceMatch | undefined = current
    ? (discovery.workspaces.find((w) => w.path === current) ?? {
        name: current.split(/[\\/]/).filter(Boolean).pop() ?? current,
        path: current,
      })
    : undefined;
  const currentBlock = currentMatch
    ? `<p class="group-label">${esc(t.currentMark)}</p>
      <div class="workspace-list" id="ws-current">${workspaceRow(currentMatch, 0, s, view.home, true)}</div>`
    : "";
  const list =
    others.length > 0
      ? `${currentBlock ? `<p class="group-label later" id="ws-run-label" hidden>${esc(t.runGroup)}</p>` : ""}
      <div class="workspace-list" id="ws-run" aria-busy="true">${others
        .map((workspace, i) => workspaceRow(workspace, i + 1, s, view.home))
        .join("")}</div>
      <details class="idle-group" id="ws-idle" hidden><summary></summary>
        <div class="workspace-list" id="ws-idle-list"></div>
      </details>
      <p id="ws-filter-empty" class="empty" hidden>${esc(t.wsFilterNoMatch)}</p>`
      : currentBlock
        ? ""
        : `<p class="empty">${esc(t.noWorkspacesFound)}</p>`;
  const filter =
    others.length > 0
      ? `<div class="found-tools"><div class="filter-wrap">
        <label class="field-label sr" for="workspace-filter">${esc(t.wsFilterLabel)}</label>
        <span class="filter-icon" aria-hidden="true">⌕</span>
        <input id="workspace-filter" type="search"
               placeholder="${esc(t.wsFilterPlaceholder)}" autocomplete="off" spellcheck="false">
      </div></div>`
      : "";
  // The fold opens on its own when the list cannot answer: nothing found, a listing or a
  // typed path failed (the notice is inside), or the reader is already browsing — a
  // `/browse` hop reloads the page, and a fold that closed on every hop would lose them.
  const otherOpen =
    view.openOther || discovery.workspaces.length === 0 || !!browse.error || !!browse.browseFailure;
  const notice = browse.browseFailure
    ? `<p class="notice" role="alert">${esc(
        ex.browseFailed(browse.browseFailure.dir, browse.browseFailure.message),
      )}</p>`
    : browse.error
      ? `<p class="notice" role="alert">${esc(browse.error)}</p>`
      : "";

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.docTitle)}</title>
<style>${PICKER_STYLE}</style>
</head>
<body>
<div class="shell">
  <header class="masthead">
    <div>
      <p class="eyebrow">AI-DLC dashboard</p>
      <h1>${esc(t.heading)}</h1>
    </div>
    <div class="scan-summary">
      ${langToggle(locale, s, { dir: browse.dir, hidden: showHidden ? "1" : undefined })}
    </div>
  </header>

  <main>
    <section class="section" aria-labelledby="found-title">
      ${
        // A listing failure is a code plus the OS message; the sentence is ours. Said at the
        // top, because the form that caused it sits in a fold below.
        notice
      }
      <div class="section-head">
        <h2 id="found-title">${esc(t.foundHeading)}</h2>
        <div class="head-right">
          <span class="found-meta">${esc(
            t.foundCount(
              String(discovery.workspaces.length),
              discovery.scannedDirectories.toLocaleString(locale),
            ),
          )}</span>
          <a id="rescan-link" class="quiet-link rescan-link" href="/pick">
            <span class="rescan-icon" aria-hidden="true">↻</span><span>${esc(t.rescan)}</span>
          </a>
        </div>
      </div>
      ${filter}
      ${currentBlock}
      ${list}
      ${discovery.truncated ? `<p class="truncated">${esc(t.truncated)}</p>` : ""}
    </section>

    <details class="other-locations" id="other-locations"${otherOpen ? " open" : ""}>
    <summary>${esc(t.otherLocations)}</summary>
    ${renderExplorer(browse, showHidden, explorer, s, view.home, view.focusPath)}
    </details>
  </main>

  ${current ? `<footer class="footer">${t.footer(esc(current))}</footer>` : ""}
</div>
<script>
const rescan = document.getElementById("rescan-link");
rescan?.addEventListener("click", (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  rescan.classList.add("scanning");
  rescan.setAttribute("aria-busy", "true");
});

// THE PATH FIELD. What follows its last separator filters this folder's children while the
// part before it is still this folder; once the reader types toward another folder, the
// list stays whole and the status says Enter goes there. Tab completes a single match,
// Esc puts this folder back, and ArrowDown steps into the list.
const pathInput = document.getElementById("path-input");
const pathStatus = document.getElementById("path-status");
const directoryRows = [...document.querySelectorAll(".dir-row")];
const PATH_TEXT = ${pathTextJson};

function splitPath(value) {
  const at = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\\\"));
  return at < 0 ? { base: "", rest: value } : { base: value.slice(0, at + 1), rest: value.slice(at + 1) };
}

function inThisFolder(base) {
  return !!pathInput && (base === pathInput.dataset.base || base === pathInput.dataset.abs);
}

function applyPathFilter() {
  if (!(pathInput instanceof HTMLInputElement)) return;
  const { base, rest } = splitPath(pathInput.value);
  const here = inThisFolder(base);
  const query = here ? rest.trim().toLocaleLowerCase() : "";
  let visible = 0;
  for (const row of directoryRows) {
    const matches = !query || (row.dataset.dirName || "").includes(query);
    row.hidden = !matches;
    if (matches) visible++;
  }
  if (!pathStatus) return;
  pathStatus.textContent = !here
    ? PATH_TEXT.hint
    : query
      ? visible > 0
        ? visible === 1
          ? PATH_TEXT.one
          : PATH_TEXT.many.replace("{n}", String(visible))
        : PATH_TEXT.none
      : "";
  pathStatus.classList.toggle("none", here && !!query && visible === 0);
}

function rowLinks() {
  return directoryRows.filter((row) => !row.hidden).map((row) => row.querySelector(".dir-nav"));
}

pathInput?.addEventListener("input", applyPathFilter);
pathInput?.addEventListener("keydown", (event) => {
  if (!(pathInput instanceof HTMLInputElement)) return;
  if (event.key === "Escape") {
    if (pathInput.value === pathInput.dataset.base) return;
    event.preventDefault();
    pathInput.value = pathInput.dataset.base || "";
    applyPathFilter();
    return;
  }
  if (event.key === "ArrowDown") {
    const first = rowLinks()[0];
    if (!first) return;
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.key !== "Tab" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
  const { base, rest } = splitPath(pathInput.value);
  if (!inThisFolder(base) || !rest) return;
  const want = rest.toLocaleLowerCase();
  const name = (row) => row.dataset.dirLabel || "";
  let hits = directoryRows.filter((row) => name(row).toLocaleLowerCase().startsWith(want));
  if (hits.length === 0) hits = directoryRows.filter((row) => (row.dataset.dirName || "").includes(want));
  if (hits.length !== 1) return; // Tab keeps moving focus when there is nothing single to complete.
  event.preventDefault();
  const sep = base.endsWith("\\\\") ? "\\\\" : "/";
  pathInput.value = base + name(hits[0]) + sep;
  applyPathFilter();
});
document.getElementById("directory-viewport")?.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const links = rowLinks();
  const at = links.indexOf(document.activeElement);
  if (at < 0) return;
  event.preventDefault();
  if (event.key === "ArrowUp" && at === 0) pathInput?.focus();
  else links[Math.min(links.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
});
// A hop between folders renders the field with \`autofocus\`; keep the caret at its end, so the
// next keystroke filters this folder.
pathInput?.addEventListener("focus", () => {
  if (pathInput instanceof HTMLInputElement) {
    pathInput.setSelectionRange(pathInput.value.length, pathInput.value.length);
  }
});
// The field states the folder on screen. A browser restores typed form values on a reload or
// a back/forward visit (seen in a real browser despite autocomplete="off"), which would
// show one folder's list under another folder's path — so put it back whenever the page
// is shown.
function resetPathField() {
  if (pathInput instanceof HTMLInputElement) pathInput.value = pathInput.dataset.base || "";
  applyPathFilter();
}
resetPathField();
window.addEventListener("pageshow", resetPathField);

// Per-card summaries, fetched after paint. Discovery already walked up to 5,000
// directories to draw this list, so nothing here may delay it further — the labels are
// on screen from the first byte and the numbers arrive as they land.
const SUMMARY_TEXT = ${summaryTextJson};
const summarySlots = [...document.querySelectorAll(".ws-summary")];
/** What each card's summary said, for the one regroup after they have all answered. */
const summaryOf = new Map();

function ago(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const min = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (min < 1) return SUMMARY_TEXT.agoNow;
  if (min < 60) return SUMMARY_TEXT.agoMinutes.replace("{n}", min);
  const h = Math.round(min / 60);
  if (h < 48) return SUMMARY_TEXT.agoHours.replace("{n}", h);
  return SUMMARY_TEXT.agoDays.replace("{n}", Math.round(h / 24));
}

function fillSummary(slot, data) {
  summaryOf.set(slot.closest(".workspace"), data);
  const pct = slot.querySelector(".ws-m-pct");
  const blank = slot.querySelector(".ws-m-blank");
  const stage = slot.querySelector(".ws-stage");
  const updated = slot.querySelector(".ws-updated");
  const state = slot.querySelector(".ws-state");
  if (data.kind === "no-run") {
    // Each reason keeps its own sentence: they need different actions from the reader.
    state.textContent =
      data.reason === "ambiguous"
        ? SUMMARY_TEXT.noRunAmbiguous
        : data.reason === "archived"
          ? SUMMARY_TEXT.noRunArchived.replace("{n}", data.archived)
          : SUMMARY_TEXT.noRunNone;
    return;
  }
  if (data.kind !== "ok") {
    state.textContent = data.kind === "unreadable" ? SUMMARY_TEXT.unreadable : SUMMARY_TEXT.failed;
    return;
  }
  const p = data.progress;
  const b = data.blockers;
  pct.querySelector("b").textContent = p.pct + "%";
  // The two numbers come from different sources with different freshness, so each says
  // where it came from rather than letting the card average them into one figure.
  pct.title = SUMMARY_TEXT.progressTip
    .replace("{done}", p.done)
    .replace("{total}", p.total)
    .replace("{asOf}", p.asOf || "—");
  pct.hidden = false;
  // A questions file that could not be read may hold a blank answer: the count is a
  // floor then, and never reads as a clean zero.
  const floor = b.unreadable > 0;
  const none = b.count === 0 && !floor;
  blank.querySelector("b").textContent = String(b.count) + (floor ? "+" : "");
  blank.querySelector("i").textContent = none ? SUMMARY_TEXT.blankNone : SUMMARY_TEXT.blank;
  blank.title =
    SUMMARY_TEXT.blockersTip.replace("{asked}", b.asked) +
    (floor ? " · " + SUMMARY_TEXT.blockersUnreadableTip.replace("{n}", b.unreadable) : "");
  blank.classList.toggle("has-blank", !none);
  blank.classList.toggle("none", none);
  blank.hidden = false;
  stage.textContent = p.currentStageDisplay || p.currentStage;
  // The state file's own Last Updated, said as that — it is stamped at transitions.
  const rel = p.asOf ? ago(p.asOf) : "";
  updated.textContent = rel ? SUMMARY_TEXT.updated.replace("{rel}", rel) : "";
  if (p.asOf) updated.title = p.asOf;
}

/**
 * The one regroup: workspaces with a run, newest state first (a launch-dir match ahead on
 * a tie, then discovery order); those with no run to show move into the folded group.
 * A failed or unreadable summary stays in the main list — that is an error to see, not a
 * workspace with nothing in it.
 */
function regroup() {
  const run = document.getElementById("ws-run");
  const idle = document.getElementById("ws-idle");
  const idleList = document.getElementById("ws-idle-list");
  if (!run || !idle || !idleList) return;
  const cards = [...run.querySelectorAll(".workspace")];
  const idleCards = cards.filter((c) => summaryOf.get(c)?.kind === "no-run");
  const time = (c) => {
    const d = summaryOf.get(c);
    const at = d?.kind === "ok" && d.progress.asOf ? Date.parse(d.progress.asOf) : NaN;
    return Number.isFinite(at) ? at : -Infinity;
  };
  const rest = cards
    .filter((c) => !idleCards.includes(c))
    .sort(
      (a, b) =>
        time(b) - time(a) ||
        (b.dataset.nearLaunch ? 1 : 0) - (a.dataset.nearLaunch ? 1 : 0) ||
        Number(a.dataset.wsIndex) - Number(b.dataset.wsIndex),
    );
  for (const c of rest) run.appendChild(c);
  for (const c of idleCards) idleList.appendChild(c);
  idle.querySelector("summary").textContent = SUMMARY_TEXT.idleGroup.replace(
    "{n}",
    idleCards.length,
  );
  idle.hidden = idleCards.length === 0;
  // The label claims an order, so it shows only once the order is real.
  const runLabel = document.getElementById("ws-run-label");
  if (runLabel) runLabel.hidden = rest.length === 0;
  run.removeAttribute("aria-busy");
  applyWorkspaceFilter();
}

const workspaceFilter = document.getElementById("workspace-filter");
const workspaceFilterEmpty = document.getElementById("ws-filter-empty");
function applyWorkspaceFilter() {
  if (!(workspaceFilter instanceof HTMLInputElement)) return;
  const query = workspaceFilter.value.trim().toLocaleLowerCase();
  let visible = 0;
  let idleVisible = 0;
  for (const card of document.querySelectorAll(".workspace")) {
    const matches = !query || (card.dataset.wsMatch || "").includes(query);
    card.hidden = !matches;
    if (matches) {
      visible++;
      if (card.closest("#ws-idle")) idleVisible++;
    }
  }
  // A match folded away is no match to the reader: open the group while filtering.
  const idle = document.getElementById("ws-idle");
  if (idle instanceof HTMLDetailsElement && query && idleVisible > 0) idle.open = true;
  if (workspaceFilterEmpty) workspaceFilterEmpty.hidden = !query || visible > 0;
}
workspaceFilter?.addEventListener("input", applyWorkspaceFilter);
workspaceFilter?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !(workspaceFilter instanceof HTMLInputElement)) return;
  workspaceFilter.value = "";
  applyWorkspaceFilter();
});

async function loadSummaries() {
  const queue = summarySlots.slice();
  // Four at a time: each read is bounded (see scan/summary.ts) but they are synchronous on
  // one event loop, so an unbounded fan-out would make the server answer the LAST card no
  // sooner while delaying everything else on the page.
  const lanes = Math.min(4, queue.length);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (queue.length > 0) {
        const slot = queue.shift();
        try {
          const res = await fetch(
            "/api/summary?dir=" + encodeURIComponent(slot.dataset.summaryDir),
            { cache: "no-store" },
          );
          fillSummary(slot, res.ok ? await res.json() : { kind: "failed" });
        } catch {
          fillSummary(slot, { kind: "failed" });
        }
      }
    }),
  );
  regroup();
}

loadSummaries();
</script>
</body>
</html>`;
}

/** Shown when no workspace has been chosen yet and none was given on the CLI. */
export function renderNoRoot(
  browse: BrowseResult,
  showHidden: boolean,
  discovery?: WorkspaceDiscovery,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return renderPicker(browse, showHidden, undefined, discovery, undefined, locale);
}
