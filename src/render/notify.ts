// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Desktop notifications: the header switch and the client logic that decides when to
// sound. The server only says WHAT can be announced (`notifyItems` in render/status.ts,
// carried on the banner's `data-notify`); everything about WHEN lives here, because only
// the browser knows whether the reader is looking.
//
// What is announced is the hero card's holds (`humanHolds`, the list `humanTally`
// counts, following the hero's own branches) plus the run finishing — one source, so a
// notification names what the card shows. Errors and quiet stretches are never
// announced: most recorded errors are the engine refusing the agent's own call and are
// already history, and "stalled" would need a threshold no record carries.
//
// This OBSERVES SNAPSHOTS, not transitions. Each poll's items are compared with the last
// poll's, so what it announces is a hold newly SEEN, and a hold that closed and reopened
// between two polls is not seen at all. Within that:
//   - The page's first read is the baseline — what was on screen when it opened is not
//     news — and a switch to another record takes a fresh one. Keys are the hold's
//     identity, not its reading (`NotifyItem`); while a questions file cannot be read,
//     holds missing from the read are kept, so they do not sound again when it reads.
//   - Never while the reader is looking: a visible tab whose document has focus already
//     shows it, and what they saw is consumed, not saved up to sound later.
//   - One notification per poll, the first new hold named and the rest counted, tagged
//     per record so a newer one replaces the older, with renotify so it still shows.
//   - A click focuses the tab and opens the hold's questions file in /view — where the
//     hero's own button goes — or scrolls to the hero card; after a switch to another
//     record it only scrolls, since the same path would name another record's file.
//   - Moving between hold kinds is news by design: answering the last current ask can
//     surface the stage gate it was covering, and that is announced (model/status.ts
//     humanHolds lists a gate only when no current ask carries it).
//
// POLLING WHILE HIDDEN. The page normally skips its poll while the tab is hidden
// (render/page.ts — late, not lossy, catching up on return). That is exactly when a
// notification is worth having, so while notifications are ON the poll keeps running in
// a hidden tab; while OFF nothing changes. With `--poll 0` there is no poll to keep.
// Browsers throttle timers in background tabs (Chrome to about once a minute after a
// few minutes hidden) and may freeze a page altogether, so a hidden tab can hear late or
// not until it is shown — still the same rules, read later.
//
// The browser's Notification API, not an OS integration on the server: it works the
// same on Windows, macOS and Linux, and http://127.0.0.1 counts as a secure context.
// Notifications made this way belong to the page: once the tab navigates away (a click
// opening /view included), it no longer polls and its notifications no longer act. The
// switch is off by default; the preference is held in memory and persisted to
// localStorage (a failed write never stops it turning off), follows other tabs, and the
// button says off / on / blocked (with how to unblock) / unsupported. Turning it on
// sends one confirmation, each time.

import { esc, scriptJson } from "./common";
import type { Strings } from "./i18n";

export const NOTIFY_STORAGE_KEY = "aidlc-dashboard.notify";

/** Same chip as the reload button; the dot and the label carry the state together. */
export const NOTIFY_CSS = `
button.notify { display:inline-flex; align-items:center; gap:6px; }
button.notify .nb-dot { width:7px; height:7px; border-radius:50%; flex:none;
  background:transparent; box-shadow:inset 0 0 0 1.5px var(--mute); }
/* Scoped like the .pickbtn chip rule it overrides, or that rule's specificity wins. */
header.top nav button.notify[data-state="on"] { border-color:var(--accent); color:var(--accent); }
button.notify[data-state="on"] .nb-dot { background:var(--accent); box-shadow:none; }
button.notify[data-state="blocked"] .nb-dot { background:var(--warn-fill); box-shadow:none; }
header.top nav button.notify:disabled { opacity:.55; cursor:default; border-color:var(--line); color:var(--fg); }
`;

/**
 * The switch, rendered off: the script sets the real state on load, and a page with the
 * script off keeps a control that honestly does nothing (`disabled`).
 */
export function notifySwitch(s: Strings): string {
  const p = s.page;
  return `<button id="notify-btn" class="pickbtn notify" type="button" aria-pressed="false" data-state="off" disabled title="${esc(
    p.notifyOffTip,
  )}"><span class="nb-dot" aria-hidden="true"></span><span class="nb-label">${esc(p.notifyOff)}</span></button>`;
}

/**
 * The client half, inlined into the page script's closure (render/page.ts). Defines
 * `notifyOn()`, which the poll timer asks before skipping a hidden tab, and
 * `checkNotify()`, which every swap calls.
 */
export function NOTIFY_SCRIPT(s: Strings): string {
  const p = s.page;
  const j = scriptJson;
  const label = {
    off: p.notifyOff,
    on: p.notifyOn,
    blocked: p.notifyBlocked,
    unsupported: p.notifyUnsupported,
  };
  const tip = {
    off: p.notifyOffTip,
    on: p.notifyOnTip,
    blocked: p.notifyBlockedTip,
    unsupported: p.notifyUnsupportedTip,
  };
  return `
  var NOTIFY_KEY = ${j(NOTIFY_STORAGE_KEY)};
  var notifyLabel = ${j(label)};
  var notifyTip = ${j(tip)};
  var notifyBtn = document.getElementById('notify-btn');
  function notifyPerm() { return 'Notification' in window ? Notification.permission : 'unsupported'; }
  // The preference lives in memory and storage only persists it: a write that fails
  // (quota, a locked-down profile) must not leave the switch unable to turn off.
  var notifyWanted = (function () { try { return localStorage.getItem(NOTIFY_KEY) === 'on'; } catch (e) { return false; } })();
  function notifyStore(on) {
    notifyWanted = on;
    try { localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off'); } catch (e) {}
  }
  // Another tab of this dashboard turned it on or off.
  window.addEventListener('storage', function (e) {
    if (e.key !== NOTIFY_KEY && e.key !== null) return;
    notifyWanted = e.key !== null && e.newValue === 'on';
    notifySync();
  });
  function notifyOn() { return notifyWanted && notifyPerm() === 'granted'; }
  function notifyState() {
    var p = notifyPerm();
    if (p === 'unsupported') return 'unsupported';
    if (p === 'denied') return 'blocked';
    return notifyOn() ? 'on' : 'off';
  }
  var notifyAsking = false;
  function notifySync() {
    if (!notifyBtn) return;
    var st = notifyState();
    notifyBtn.setAttribute('data-state', st);
    notifyBtn.setAttribute('aria-pressed', st === 'on' ? 'true' : 'false');
    notifyBtn.disabled = st === 'unsupported' || notifyAsking;
    notifyBtn.title = notifyTip[st];
    var l = notifyBtn.querySelector('.nb-label');
    if (l) l.textContent = notifyLabel[st];
  }
  // A permission changed in the browser's own settings shows when the reader is back.
  document.addEventListener('visibilitychange', notifySync);
  window.addEventListener('focus', notifySync);
  function notifyRead() {
    var b = document.getElementById('banner');
    try { return JSON.parse(b.getAttribute('data-notify')); } catch (e) { return null; }
  }
  function notifyKeys(d) {
    var k = new Set();
    d.items.forEach(function (i) { k.add(i.key); });
    return k;
  }
  var notifySeen = null;
  (function () { var d = notifyRead(); if (d) notifySeen = { scope: d.scope, keys: notifyKeys(d) }; })();
  function notifySend(title, body, file, scope) {
    // One tag per record: a newer notification replaces the older, and renotify asks
    // the browser to show the replacement rather than swap it in silently.
    var n = new Notification(title, { body: body, tag: 'aidlc-dashboard:' + scope, renotify: true });
    n.onclick = function () {
      try { window.focus(); } catch (e) {}
      n.close();
      var d = notifyRead();
      // A path is only meaningful in the record it came from: after a switch to another
      // record, /view would read the same path there. The tab's own check covers this tab;
      // the scope in the URL lets /view refuse when another tab switched the server.
      if (file && d && d.scope === scope) { location.href = '/view?rel=' + encodeURIComponent(file) + '&scope=' + encodeURIComponent(scope); return; }
      var b = document.getElementById('banner');
      if (b && b.scrollIntoView) b.scrollIntoView({ block: 'start' });
    };
  }
  function checkNotify() {
    var d = notifyRead();
    if (!d) return;
    var keys = notifyKeys(d);
    if (!notifySeen || notifySeen.scope !== d.scope) { notifySeen = { scope: d.scope, keys: keys }; return; }
    var fresh = d.items.filter(function (i) { return !notifySeen.keys.has(i.key); });
    // While a questions file cannot be read, a hold missing from this read is not known
    // to be gone: keep it, or it would sound again when the file reads.
    if (d.incomplete) notifySeen.keys.forEach(function (k) { keys.add(k); });
    notifySeen.keys = keys;
    if (!fresh.length || !notifyOn()) return;
    if (!document.hidden && (!document.hasFocus || document.hasFocus())) return;
    var f = fresh[0];
    // macOS cuts a title at about 30 characters (seen on a real Mac), so the title
    // leads with what arrived and the run's name and the count go to the body.
    if (f.done) {
      notifySend(f.title, d.name + (f.where ? ' — ' + f.where : ''), '', d.scope);
      return;
    }
    var b = document.getElementById('banner');
    var count = (b && b.getAttribute('data-count')) || String(d.items.length);
    var title = (f.kind ? f.kind + ' · ' : '') + f.title;
    var body = ${j(p.jsNotifyWaitBody)}.replace('{name}', d.name).replace('{n}', count);
    if (fresh.length > 1) body += ${j(p.jsNotifyMore)}.replace('{n}', String(fresh.length - 1));
    if (f.where) body = f.where + '\\n' + body;
    notifySend(title, body, f.file || '', d.scope);
  }
  function notifyConfirm() {
    var d = notifyRead();
    var name = d ? d.name : '';
    try {
      new Notification(${j(p.jsNotifyOnTitle)}, { body: ${j(p.jsNotifyOnBody)}.replace('{name}', name), tag: 'aidlc-dashboard:on' });
    } catch (e) {}
  }
  if (notifyBtn) {
    notifyBtn.addEventListener('click', function () {
      var p = notifyPerm();
      if (p === 'unsupported' || notifyAsking) return;
      if (notifyOn()) { notifyStore(false); notifySync(); return; }
      if (p === 'granted') { notifyStore(true); notifySync(); notifyConfirm(); return; }
      if (p === 'denied') { notifySync(); return; }
      // One request at a time: the button stays disabled until the browser answers.
      notifyAsking = true;
      notifySync();
      var answered = false;
      var done = function (r) {
        if (answered) return;
        answered = true;
        notifyAsking = false;
        if (r === 'granted') { notifyStore(true); notifyConfirm(); }
        notifySync();
      };
      // Older Safari takes a callback and returns nothing; others return a promise and
      // may call the callback too, hence the guard.
      try {
        var req = Notification.requestPermission(done);
        if (req && req.then) req.then(done, function () { done(notifyPerm()); });
      } catch (e) {
        done(notifyPerm());
      }
    });
  }
  notifySync();
`;
}
