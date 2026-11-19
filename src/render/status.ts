// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The banner at the top of the body (with the run line inside it), and the Run Health
// card — see model/status.ts for what each reading is and why there is no combined
// verdict. This module only turns those readings into markup.
//
// The banner names the first hold in the answers tab's own wording (humanGate,
// humanDecision, …) and prints the answers tab's own count (humanTally), so the headline
// and the tab never describe or count the same hold two ways.
//
// Run Health is a tabbed card, one tab per signal (your answers, stuck, failed
// checks), and each tab's COUNT carries the signal at a glance: coloured when there is
// something to act on, green when the source was read and is clear, and a muted dash
// when there is no record at all — "no record" must never read as healthy. The card
// opens on the first tab with a problem, so a reader who only glances at it lands on
// the thing that needs them.
//
// Deliberately NOT `role="status"`: the body is swapped on every poll, and a live region
// would re-announce the whole card each minute.

import {
  type ChecksReading,
  type Hold,
  type HumanReading,
  type StuckReading,
  buildStatus,
  defaultStopCap,
  humanHolds,
  humanTally,
} from "../model/status";
import type { Blocker, DashboardModel } from "../model/types";
import {
  type CountTone,
  DRILL,
  type Row,
  type Tab,
  rowList,
  share,
  tabbedCard,
  viewLink,
} from "./card-kit";
import { dur, esc } from "./common";
import type { Strings } from "./i18n";

// ── Run line ─────────────────────────────────────────────────────────────────

/**
 * "Is it moving": the phase and stage the run is on, and how long since the audit last
 * recorded anything. Lives in the refreshed body, not the static header, because the
 * age is the one number on it that changes every poll.
 */
export function renderRunLine(m: DashboardModel, s: Strings): string {
  const x = s.status;
  const st = buildStatus(m);
  if (st.run.state === "complete") {
    return `<div class="runline"><span class="rl-dot ok"></span><b>${esc(x.runComplete)}</b><span class="rl-sub">${esc(
      x.runSource,
    )}</span></div>`;
  }
  if (st.run.state === "unknown") {
    return `<div class="runline"><span class="rl-dot mute"></span><b>${esc(x.runUnknown)}</b><span class="rl-sub">${esc(
      x.runSource,
    )}</span></div>`;
  }
  const phase = m.state.lifecyclePhase;
  const stage = st.run.unit
    ? `${st.run.stageDisplay} · ${x.runningUnit(st.run.unit)}`
    : st.run.stageDisplay;
  const where = phase ? `${phase} › ${stage}` : stage;
  // Said, not implied: a Current Stage that can lag is not where the engine is, and a
  // unit cache the current directive contradicts is not either.
  const conflict = m.waits.position.conflict;
  const unverified = st.run.verified
    ? ""
    : conflict
      ? ` <span class="rl-sub" title="${esc(x.runConflictTip)}">· ${esc(
          x.runConflict(conflict.unit ? `${conflict.stage} · ${conflict.unit}` : conflict.stage),
        )}</span>`
      : m.waits.position.offRoster && m.waits.position.unit
        ? ` <span class="rl-sub" title="${esc(x.runOffRosterTip)}">· ${esc(
            x.runOffRoster(m.waits.position.unit, m.waits.position.offRoster),
          )}</span>`
        : ` <span class="rl-sub" title="${esc(x.runUnverifiedTip)}">· ${esc(x.runUnverified)}</span>`;
  const tip = m.partialAudit ? x.runTipPartial(m.partialAudit.notRead) : x.runTip;
  return `<div class="runline" title="${esc(tip)}"><span class="rl-dot run"></span><b>${esc(
    x.running,
  )}</b><span class="rl-sub">${esc(x.runningSub(where, dur(st.run.lastEventAgeSec)))}</span>${unverified}</div>`;
}

// ── Banner ───────────────────────────────────────────────────────────────────

/**
 * The tab-title count: the same number the answers tab prints (`humanTally`), `N?` when
 * a questions file could not be read, and nothing when nothing is waiting. A finished
 * run has no count — its unanswered asks are loose ends, not waits (model/status.ts).
 */
export function waitCountText(m: DashboardModel): string {
  const st = buildStatus(m);
  if (st.run.state === "complete") return "";
  const t = humanTally(st.human);
  if (t.incomplete) return `${t.open}?`;
  return t.open > 0 ? String(t.open) : "";
}

/** How long a hold has waited, from an ISO timestamp, against the read clock. */
function waitedSec(m: DashboardModel, iso: string | undefined): number | undefined {
  const t = iso ? (Date.parse(m.generatedAt) - Date.parse(iso)) / 1000 : Number.NaN;
  return Number.isFinite(t) && t >= 0 ? t : undefined;
}

/** One hold as the hero shows it — wording from the answers tab's own strings. */
interface HoldView {
  kind: string;
  title: string;
  where: string;
  sec?: number;
  file?: string;
}

function holdView(h: Hold, m: DashboardModel, s: Strings): HoldView {
  const x = s.status;
  const k = x.heroKind;
  const at = (unit: string | undefined, stage: string | undefined) =>
    [unit, stage].filter(Boolean).join(" · ");
  switch (h.kind) {
    case "parked":
      return {
        kind: k.parked,
        title: x.humanParked(h.stage, h.byPerson),
        where: x.humanParkedTip,
        sec: waitedSec(m, h.since),
      };
    case "unit-paused":
      return {
        kind: k.unitPaused,
        title: x.humanUnitPaused(h.unit, h.reason),
        where: h.nextAction ? x.humanUnitNext(h.nextAction) : at(h.unit, h.stage),
      };
    case "ask": {
      const b = h.blocker;
      return {
        kind:
          b.kind === "confirmation" ? k.confirmation : b.kind === "loose" ? k.loose : k.question,
        title: b.heading || s.blockers.untitled,
        where: at(b.unit, b.stage),
        sec: b.waitingSec,
        file: b.rel,
      };
    }
    case "gate":
      return {
        kind: k.gate,
        title: x.humanGate(h.stage),
        where: x.humanGateSource,
        sec: waitedSec(m, h.since),
      };
    case "team-gate":
      return {
        kind: k.gate,
        title: x.humanTeamGate(h.unit, h.stage),
        where: x.humanTeamGateSource,
      };
    case "decision": {
      const d = h.decision;
      return {
        kind: k.decision,
        title: d.decision || d.checkpoint || x.humanDecision(undefined, undefined),
        where: [
          d.checkpoint && d.decision ? d.checkpoint : undefined,
          at(d.unit, d.stage),
          d.unlessUnattended ? x.humanDecisionUnlessUnattended : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        sec: waitedSec(m, d.since),
      };
    }
    case "engine-ask":
      return {
        kind: k.engineAsk,
        title: x.humanEngineAsk(h.askType, at(h.unit, h.stage)),
        where: [
          x.humanEngineAskSource,
          h.unlessUnattended ? x.humanDecisionUnlessUnattended : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      };
  }
}

/**
 * One thing a desktop notification can announce (render/notify.ts): a hold from
 * `humanHolds` — the same list the hero card shows and `humanTally` counts, so the card,
 * the tab title and a notification can never disagree — or the run finishing.
 *
 * `key` is the hold's IDENTITY, not its reading: built from what names the hold (an
 * ask's file, heading and which same-titled section it is; a decision's audit row; a
 * gate's stage and unit) and never from a clock, a file mtime or wording that can be
 * filled in later, so a poll that re-reads the same hold produces the same key and fires
 * nothing. A hold that closes drops out of the next poll's set, so if it comes back it
 * is new again — which is why values that can move under a live hold are left out: an
 * ask's file is rewritten as the person answers its siblings, a gate's audit `since` can
 * arrive a poll after its `[?]` row, a park read from a marker has no `since` until the
 * state records one, and a pause's stage and reason can be filled in or reworded.
 */
export interface NotifyItem {
  key: string;
  /** The hero's kind label ("question", "approval", …); empty for `done`. */
  kind: string;
  title: string;
  where: string;
  /** Record-relative questions file to open on click, when the hold has one. */
  file?: string;
  /** The run finished — announced once, when it happens. */
  done?: true;
}

function holdKey(h: Hold): string {
  const id = (...parts: (string | undefined)[]) => JSON.stringify(parts.map((p) => p ?? ""));
  switch (h.kind) {
    // A park read from a marker has no `since` until the state records one, and a
    // pause's stage and reason can be filled in or reworded while it holds: identity
    // only, or the same hold would sound twice.
    case "parked":
      return id(h.kind, h.stage);
    case "unit-paused":
      return id(h.kind, h.unit);
    case "ask":
      return id(
        h.kind,
        h.blocker.rel,
        h.blocker.heading,
        h.blocker.kind,
        String(h.blocker.occurrence ?? 0),
      );
    case "gate":
      return id(h.kind, h.stage);
    case "team-gate":
      return id(h.kind, h.unit, h.stage);
    case "decision": {
      const d = h.decision;
      return d.row !== undefined
        ? id(h.kind, d.row)
        : id(h.kind, d.stage, d.unit, (d.units ?? []).join(","), d.checkpoint, d.since);
    }
    case "engine-ask":
      return id(h.kind, h.askType, h.stage, h.unit);
  }
}

/**
 * What the page can announce right now — see `NotifyItem`. Follows `renderBanner`'s own
 * branches, so nothing is announced that the hero does not show: a run whose position
 * cannot be read gets the hero's "unknown" card and no holds, so it announces none.
 */
export function notifyItems(m: DashboardModel, s: Strings): NotifyItem[] {
  const run = buildStatus(m).run.state;
  if (run === "unknown") return [];
  if (run === "complete") {
    const loose = m.blockers.length;
    return [
      {
        key: JSON.stringify(["done"]),
        kind: "",
        title: s.status.bannerDone,
        where: loose > 0 ? s.status.bannerDoneLoose(loose) : "",
        done: true,
      },
    ];
  }
  return humanHolds(m).map((h) => {
    const v = holdView(h, m, s);
    return { key: holdKey(h), kind: v.kind, title: v.title, where: v.where, file: v.file };
  });
}

/**
 * The record the notifications belong to. A switch to another workspace or record
 * changes it, and the client takes a fresh baseline rather than announcing every hold
 * of the run it just switched to.
 */
export function notifyScope(m: DashboardModel): string {
  return JSON.stringify([m.identity.root, m.identity.space, m.identity.record]);
}

/**
 * The same identity from a workspace root and its state file's path, for a route that does not
 * assemble a model: `/view` compares it with the scope a notification click carries.
 * `stateRel` is `aidlc/spaces/<space>/intents/<record>/aidlc-state.md` (scan/resolve.ts).
 */
export function recordScope(root: string, stateRel: string): string {
  const parts = stateRel.split("/");
  return JSON.stringify([root, parts[2] ?? "default", parts[4] ?? ""]);
}

/** The workspace-relative path of a record file — what a reader pastes into the chat. */
function workspacePath(m: DashboardModel, rel: string): string {
  const dir = m.identity.stateRel.split("/").slice(0, -1).join("/");
  return dir ? `${dir}/${rel}` : rel;
}

function holdActions(v: HoldView, m: DashboardModel, s: Strings): string {
  const x = s.status;
  if (!v.file) return `<span class="ask-hint">${esc(x.heroAnswerInChat)}</span>`;
  return `<a class="ask-btn primary" href="/view?rel=${encodeURIComponent(v.file)}" title="${esc(
    s.blockers.viewTip(v.file),
  )}">${esc(x.bannerOpenFile)} <span aria-hidden="true">→</span></a><button class="ask-btn" type="button" data-copy="${esc(
    workspacePath(m, v.file),
  )}" data-copied="${esc(x.heroCopied)}">${esc(x.heroCopyPath)}</button>`;
}

/**
 * The first thing on the page answers the reader's first question — "is anything waiting
 * for me?" — with the hold itself, not just a count: what it is, where, how long it has
 * waited, and the file to open. The run line sits under it.
 *
 * This is NOT a combined verdict (model/status.ts rule 1): it states one signal, the
 * person's holds, through `humanHolds` — the list `humanTally` counts, so the card, the
 * answers tab and the tab title cannot disagree — and leaves stuck and checks to their
 * own tabs. Nor does it classify a quiet run as stalled — that would need a threshold no
 * record carries (rule 3) — so "nothing is waiting" sits beside the run line, which
 * already says how long since the run last wrote anything.
 */
export function renderBanner(m: DashboardModel, s: Strings): string {
  const x = s.status;
  const st = buildStatus(m);
  const count = waitCountText(m);
  const line = renderRunLine(m, s);
  const notify = esc(
    JSON.stringify({
      scope: notifyScope(m),
      name: m.identity.slug ?? m.identity.record,
      items: notifyItems(m, s),
      // A questions file that could not be read: what it held is not known to be gone.
      incomplete: count.endsWith("?"),
    }),
  );
  const box = (tone: string, eyebrow: string, head: string, body = "") =>
    `<section class="banner ${tone}" id="banner" data-count="${esc(count)}" data-notify="${notify}"><p class="hero-eye"><span class="hero-dot"></span>${esc(
      eyebrow,
    )}</p><h2 class="hero-h">${esc(head)}</h2>${body}${line}</section>`;
  const lede = (text: string) => `<p class="hero-lede">${esc(text)}</p>`;

  if (st.run.state === "complete") {
    const loose = m.blockers.length;
    return box(
      "done",
      x.heroEyeDone,
      x.bannerDone,
      loose > 0 ? lede(x.bannerDoneLoose(loose)) : "",
    );
  }
  if (st.run.state === "unknown") return box("unknown", x.heroEyeNow, x.bannerUnknown);

  const t = humanTally(st.human);
  const holds = t.open > 0 ? humanHolds(m).map((h) => holdView(h, m, s)) : [];
  const lead = holds[0];
  if (lead) {
    const age =
      lead.sec !== undefined
        ? `<div class="ask-age"><b>${esc(x.heroAge(lead.sec))}</b><span>${esc(x.heroAgeCap)}</span></div>`
        : "";
    const card = `<article class="ask"><div class="ask-main"><span class="ask-kind">${esc(
      lead.kind,
    )}</span><h3 class="ask-t">${esc(lead.title)}</h3>${lead.where ? `<p class="ask-where">${esc(lead.where)}</p>` : ""}<div class="ask-act">${holdActions(
      lead,
      m,
      s,
    )}</div></div>${age}</article>`;
    const rest = holds.slice(1);
    const more = rest.length
      ? `<details class="ask-rest" data-key="hero-rest"><summary>${esc(x.bannerMore(rest.length))}</summary><ul>${rest
          .map(
            (v) =>
              `<li><span class="ask-kind">${esc(v.kind)}</span><span class="ar-t">${esc(v.title)}</span><span class="ar-w">${esc(
                v.where,
              )}</span><span class="ar-a">${v.sec !== undefined ? esc(x.heroAge(v.sec)) : ""}</span>${
                v.file
                  ? `<a href="/view?rel=${encodeURIComponent(v.file)}">${esc(x.heroOpen)}</a>`
                  : "<span></span>"
              }</li>`,
          )
          .join("")}</ul></details>`
      : "";
    const note = t.incomplete ? lede(x.bannerIncompleteNote) : "";
    return box("wait", x.heroEyeYou, x.bannerWaiting, `${card}${more}${note}`);
  }
  if (t.incomplete)
    return box("wait", x.heroEyeNow, x.bannerIncomplete, lede(x.bannerIncompleteSub));
  return box(
    "clear",
    x.heroEyeNow,
    x.bannerClear,
    m.waits.revising ? lede(x.humanRevising(m.waits.revising)) : "",
  );
}

// ── Run Health ───────────────────────────────────────────────────────────────

/**
 * One unanswered ask. `parked` overrides the blocker's own `isCurrentStage`: on a
 * finished run every ask is a loose end (model/status.ts), even one in the stage
 * `state.md` still names as current.
 */
function askRow(b: Blocker, s: Strings, maxWait: number, parked = !b.isCurrentStage): Row {
  const where = b.unit ? `${b.unit} · ${b.stage}` : b.stage;
  const file = b.rel.split("/").pop() ?? b.rel;
  const gate =
    b.invalidTags !== undefined
      ? ` · ${s.blockers.invalidTags(b.invalidTags)}`
      : b.kind === "confirmation"
        ? ` · ${s.blockers.confirmation}`
        : b.kind === "loose"
          ? ` · ${s.blockers.loose}`
          : "";
  const tip =
    b.invalidTags !== undefined
      ? s.blockers.invalidTagsTip
      : b.kind === "confirmation"
        ? s.blockers.confirmationTip
        : b.kind === "loose"
          ? s.blockers.looseTip
          : undefined;
  const earlier = parked ? `${s.blockers.staleStage} · ` : "";
  return {
    label: `${esc(earlier)}${esc(where)} · ${esc(b.heading || s.blockers.untitled)}<span class="mr-sub">${esc(gate)} · ${viewLink(
      b.rel,
      file,
      s.blockers.viewTip(b.rel),
    )}</span>`,
    value: dur(b.waitingSec),
    pct: b.waitingSec === undefined ? undefined : share(b.waitingSec, maxWait),
    tone: parked ? "none" : "warn",
    dim: parked,
    tip,
  };
}

function unreadRow(unread: number, s: Strings): Row {
  return {
    label: esc(s.status.humanUnreadable(unread)),
    value: "—",
    dashed: true,
    tone: "warn",
    tip: s.status.humanUnreadableTip,
  };
}

function answersTab(h: HumanReading | undefined, m: DashboardModel, s: Strings): Tab {
  const x = s.status;
  const maxWait = Math.max(0, ...m.blockers.map((b) => b.waitingSec ?? 0));
  const rows: Row[] = [];
  const w = h?.waits;
  const now = Date.parse(m.generatedAt);
  const age = (iso: string | undefined) => {
    const t = iso ? (now - Date.parse(iso)) / 1000 : Number.NaN;
    return Number.isFinite(t) && t >= 0 ? dur(t) : "";
  };
  const sub = (text: string) => `<span class="mr-sub"> · ${esc(text)}</span>`;
  // The run's own holds first — each is something only the person can release.
  if (w?.parked) {
    rows.push({
      label: `${esc(x.humanParked(w.parked.stage, w.parked.byPerson))}${sub(x.humanStateSource)}`,
      value: age(w.parked.since),
      pct: 100,
      tone: "warn",
      tip: x.humanParkedTip,
    });
  }
  if (w?.unitPaused) {
    const next = w.unitPaused.nextAction ? ` · ${x.humanUnitNext(w.unitPaused.nextAction)}` : "";
    rows.push({
      label: `${esc(x.humanUnitPaused(w.unitPaused.unit, w.unitPaused.reason))}${sub(`${x.humanStateSource}${next}`)}`,
      value: "",
      pct: 100,
      tone: "warn",
    });
  }
  if (w?.unitCacheLeftover) {
    const l = w.unitCacheLeftover;
    rows.push({
      label: `${esc(x.humanUnitCacheLeftover(l.unit, l.stage, l.paused))}${sub(x.humanStateSource)}`,
      value: "",
      tone: "none",
      dim: true,
      tip: x.humanUnitCacheLeftoverTip,
    });
  }
  if (w?.engineAsk) {
    const where = w.engineAsk.unit
      ? `${w.engineAsk.unit} · ${w.engineAsk.stage}`
      : w.engineAsk.stage;
    rows.push({
      label: `${esc(x.humanEngineAsk(w.engineAsk.askType, where))}${sub(
        [
          x.humanEngineAskSource,
          w.engineAsk.unlessUnattended ? x.humanDecisionUnlessUnattended : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      )}`,
      value: "",
      pct: 100,
      tone: "warn",
      tip: x.humanEngineAskTip,
    });
  }
  if (w?.decision) {
    rows.push({
      label: `${esc(x.humanDecision(w.decision.checkpoint, w.decision.decision))}${sub(
        [
          x.humanDecisionSource,
          w.decision.scopeVerified === false ? x.humanDecisionUnscoped : undefined,
          w.decision.unlessUnattended ? x.humanDecisionUnlessUnattended : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      )}`,
      value: age(w.decision.since),
      pct: 100,
      tone: "warn",
      tip: x.humanDecisionTip,
    });
  }
  if (w?.gateReplied) {
    rows.push({
      label: `${esc(x.humanGateReplied(w.gateReplied.stage, w.gateReplied.unit))}${sub(
        w.gateReplied.unit ? x.humanTeamGateSource : x.humanGateSource,
      )}`,
      value: "",
      tone: "none",
      tip: x.humanGateRepliedTip,
    });
  }
  if (h?.awaitingGate) {
    rows.push({
      label: `${esc(x.humanGate(h.awaitingGate))}${sub(x.humanGateSource)}`,
      value: age(w?.gate?.since),
      pct: 100,
      tone: "warn",
    });
  }
  if (w?.teamGate) {
    const g = w.teamGate;
    const source =
      g.scopeVerified === false
        ? `${x.humanTeamGateSource} · ${x.humanDecisionUnscoped}`
        : x.humanTeamGateSource;
    rows.push(
      g.status === "awaiting-approval"
        ? {
            label: `${esc(x.humanTeamGate(g.unit, g.stage))}${sub(source)}`,
            value: "",
            pct: 100,
            tone: "warn",
            tip: x.humanTeamGateTip,
          }
        : {
            label: `${esc(x.humanTeamGateRevising(g.unit, g.stage))}${sub(source)}`,
            value: "",
            tone: "none",
            tip: x.humanTeamGateTip,
          },
    );
  }
  if (w?.teamGateUnread) {
    const at = w.teamGateUnreadAt;
    const where = at
      ? sub(
          at.scopeVerified
            ? `${at.unit} · ${at.stage}`
            : `${at.unit} · ${at.stage} · ${x.humanDecisionUnscoped}`,
        )
      : "";
    rows.push({
      label: `${esc(x.humanTeamGateUnread)}${where}`,
      value: "—",
      dashed: true,
      tip: x.humanTeamGateUnreadTip,
    });
  }
  if (w?.checkoutPark) {
    rows.push({
      label: esc(x.humanCheckoutPark),
      value: "",
      tone: "none",
      tip: x.humanCheckoutParkTip,
    });
  }
  if (w?.revising) {
    rows.push({
      label: esc(x.humanRevising(w.revising)),
      value: "",
      tone: "none",
      tip: x.humanRevisingTip,
    });
  }
  // buildBlockers already sorts current-stage asks first; parked ones follow, dimmed.
  for (const b of m.blockers) rows.push(askRow(b, s, maxWait));
  // A questions file that exists and could not be read may hold a blank answer, so
  // its absence from the list above is not "nothing awaiting you" (HumanReading.unread).
  const unread = h?.unread ?? 0;
  if (unread > 0) rows.push(unreadRow(unread, s));
  for (const rel of w?.engineOnly ?? []) {
    rows.push({
      label: `${esc(x.humanEngineOnly(rel.split("/").pop() ?? rel))}<span class="mr-sub"> · ${viewLink(
        rel,
        rel.split("/").pop() ?? rel,
        s.blockers.viewTip(rel),
      )}</span>`,
      value: "",
      tone: "none",
      dim: true,
      tip: x.humanEngineOnlyTip,
    });
  }
  if (w?.turnEnded && !w.engineAsk) {
    rows.push({ label: esc(x.humanTurnEnded), value: "", tone: "none", tip: x.humanTurnEndedTip });
  }
  if (w?.hooks.state === "stale" || w?.hooks.state === "never") {
    rows.push({
      label: esc(
        w.hooks.state === "stale"
          ? x.humanHooksStale(age(w.hooks.heartbeat), age(w.hooks.event))
          : x.humanHooksNever,
      ),
      value: "",
      tone: "warn",
      tip: w.hooks.state === "stale" ? x.humanHooksStaleTip : x.humanHooksNeverTip,
    });
  }
  if (w?.autonomous) {
    rows.push({
      label: esc(x.humanAutonomous),
      value: "",
      tone: "none",
      tip: x.humanAutonomousTip,
    });
  }
  // The same count the banner and the tab title print (model/status.ts humanTally).
  const { open, incomplete } = humanTally(h);
  return {
    label: s.cards.answersTab,
    count: {
      text: incomplete ? `${open}?` : String(open),
      tone: open > 0 || incomplete ? "warn" : "ok",
    },
    // Not capped. This card is the only place the asks are listed — the "see all" link
    // goes to the timeline, which does not list them — so a "+N more" here would make
    // the rest unreachable. The list the old blockers card showed was never capped.
    body: rowList(rows, {
      head: [s.cards.colAsk, s.cards.colWait],
      empty: x.humanNone,
      note: x.humanSource,
    }),
  };
}

function stuckTab(r: StuckReading, s: Strings, autonomous: boolean): Tab {
  const x = s.status;
  let row: Row;
  let count: { text: string; tone: CountTone };
  switch (r.state) {
    case "no-record":
      row = { label: esc(x.stuckNoRecord), value: "—", dashed: true };
      count = { text: "–", tone: "mute" };
      break;
    case "clear":
      row = { label: esc(x.stuckClear), value: "0", tone: "ok" };
      count = { text: "0", tone: "ok" };
      break;
    case "earlier-stage":
      row = {
        label: `${esc(x.stuckClear)}<span class="mr-sub"> · ${esc(x.stuckEarlier(r.stage))}</span>`,
        value: "0",
        tone: "ok",
      };
      count = { text: "0", tone: "ok" };
      break;
    case "state-changed":
      row = {
        label: `${esc(x.stuckStateChanged)}<span class="mr-sub"> · ${esc(r.stage)}</span>`,
        value: "0",
        tone: "ok",
      };
      count = { text: "0", tone: "ok" };
      break;
    case "nudged":
      row = {
        label: `${esc(x.stuckNudged)}<span class="mr-sub"> · ${esc(r.stage)}</span>`,
        value: "1",
        tone: "ok",
      };
      count = { text: "1", tone: "ok" };
      break;
    case "blocked":
      row = {
        label: `${esc(x.stuckBlocked(r.count, r.cap))}<span class="mr-sub"> · ${esc(r.stage)}</span>`,
        value: String(r.count),
        pct: share(r.count, r.cap),
        tone: "warn",
      };
      count = { text: String(r.count), tone: "warn" };
      break;
    case "released":
      row = {
        label: `${esc(x.stuckReleased(r.count, r.cap))}<span class="mr-sub"> · ${esc(r.stage)}</span>`,
        value: String(r.count),
        pct: 100,
        tone: "warn",
      };
      count = { text: String(r.count), tone: "warn" };
      break;
  }
  return {
    label: s.cards.stuckTab,
    count,
    body: rowList([{ ...row, tip: x.stuckTip(defaultStopCap(autonomous), autonomous) }], {
      head: [s.cards.colGuard, s.cards.colCount],
      note: x.stuckSource,
    }),
  };
}

function checksTab(r: ChecksReading, m: DashboardModel, s: Strings): Tab {
  const x = s.status;
  const stage = m.state.currentStage;
  const now = Date.parse(m.generatedAt);
  const failures = m.sensors.failures.filter((f) => f.stage === stage && !f.supersededAt);
  const rows: Row[] = failures.map((f) => {
    const age = (now - Date.parse(f.ts)) / 1000;
    const findings = f.findingsCount !== undefined ? ` · ${f.findingsCount}` : "";
    return {
      label: `✗ ${esc(f.id)}<span class="mr-sub"> · ${esc(f.stage)}${esc(findings)}</span>`,
      value: Number.isFinite(age) && age >= 0 ? dur(age) : "—",
      pct: 100,
      tone: "bad",
      tip: x.checksFailedTip,
    };
  });
  let count: { text: string; tone: CountTone };
  switch (r.state) {
    case "none":
      // Sensor rows come from the audit, so with a shard refused "none" and "passed" are
      // readings of the shards read (DashboardModel.partialAudit).
      rows.push({
        label: esc(m.partialAudit ? x.checksNonePartial(m.partialAudit.notRead) : x.checksNone),
        value: "—",
        dashed: true,
      });
      count = { text: "–", tone: "mute" };
      break;
    case "in-flight":
      rows.push({ label: esc(x.checksInFlight(r.pending)), value: "", dashed: true });
      count = r.failed > 0 ? { text: String(r.failed), tone: "bad" } : { text: "…", tone: "mute" };
      break;
    case "failed":
      // The roll-up counted a failure whose firing is not in the failure list (no
      // terminal record read) — still say it happened rather than show nothing.
      if (failures.length === 0) {
        rows.push({ label: esc(x.checksFailed(r.failed)), value: "", pct: 100, tone: "bad" });
      }
      count = { text: String(r.failed), tone: "bad" };
      break;
    case "unverified":
      rows.push({
        label: esc(x.checksUnverified(r.unverified)),
        value: "",
        pct: 100,
        tone: "warn",
        tip: x.checksUnverifiedTip,
      });
      count = { text: "?", tone: "warn" };
      break;
    case "passed":
      rows.push({
        label: esc(
          m.partialAudit
            ? x.checksPassedPartial(r.passed, m.partialAudit.notRead)
            : x.checksPassed(r.passed),
        ),
        value: "",
        tone: "ok",
      });
      count = { text: "0", tone: "ok" };
      break;
  }
  return {
    label: s.cards.checksTab,
    count,
    body: rowList(rows, {
      head: [s.cards.colCheck, s.cards.colWhen],
      max: 6,
      moreText: s.cards.moreRows,
      note: x.checksSource(m.state.currentStage),
    }),
  };
}

/** Characters of an error message kept in its row; the tooltip carries it whole. */
const ERROR_TEXT_MAX = 100;
/** Error rows shown before the rest fold away — folded, never dropped. */
const ERROR_ROWS_SHOWN = 6;

/**
 * The engine's failed commands (model/errors.ts), one row per repeated failure. What a
 * row says is what the clone that logged it wrote next, as observed — never
 * "unresolved", "fixed" or "moved on", because nothing in the ledger records any of
 * them. Only the shape the reading warns on gets a dot; an error whose stage that clone
 * later completed is dimmed as history. Every group stays reachable: past the first six
 * they sit in a fold, since a "+N more" line alone would hide the seventh failure.
 */
function errorsTab(m: DashboardModel, s: Strings): Tab {
  const x = s.status;
  const r = m.errors;
  const now = Date.parse(m.generatedAt);
  const rows: Row[] = r.groups.map((g) => {
    const name = g.sub ? `${g.tool} ${g.sub}` : g.tool;
    const cmd = g.viewRel ? viewLink(g.viewRel, name, x.errorsViewTip(g.lastTs)) : esc(name);
    const times = g.count > 1 ? ` ×${g.count}` : "";
    // The stage first, so "its stage later completed" follows the stage it names.
    const where = g.stage ? [x.errorsAfterStage(g.stage, g.unit, g.count > 1)] : [];
    const next = [
      g.next === "errors-only" ? x.errorsErrorsOnly : x.errorsFollowed,
      ...(g.stageClosedAfter ? [x.errorsStageClosed] : []),
      ...(g.source === "error-directive" ? [x.errorsDelivered] : []),
    ];
    // The engine escapes a line break as a literal `\n`; a row is one line.
    const flat = g.message.replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
    const text = flat.length > ERROR_TEXT_MAX ? `${flat.slice(0, ERROR_TEXT_MAX)}…` : flat;
    const age = (now - Date.parse(g.lastTs)) / 1000;
    return {
      label: `${cmd}${esc(times)}<span class="mr-sub"> · ${esc(
        [...where, ...next, ...(text ? [text] : [])].join(" · "),
      )}</span>`,
      value: Number.isFinite(age) && age >= 0 ? dur(age) : "—",
      tone: g.tone === "warn" ? "warn" : "none",
      dim: g.tone !== "warn" && g.stageClosedAfter,
      tip: [
        g.message.replace(/\\n/g, "\n"),
        g.command,
        x.errorsTip(g.count, g.firstTs, g.lastTs, g.shard),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });
  const count: { text: string; tone: CountTone } =
    r.total === 0
      ? { text: "0", tone: m.partialAudit ? "mute" : "ok" }
      : { text: String(r.total), tone: r.warn ? "warn" : "mute" };
  const note =
    r.helpDropped > 0
      ? `${x.errorsSource} · ${x.errorsHelpDropped(r.helpDropped)}`
      : x.errorsSource;
  const shown = rows.slice(0, ERROR_ROWS_SHOWN);
  const rest = rows.slice(ERROR_ROWS_SHOWN);
  const fold =
    rest.length > 0
      ? `<details class="mr-fold" data-key="health-errors-more"><summary class="mr-rest">${esc(
          s.cards.moreRows(rest.length),
        )}</summary>${rowList(rest)}</details>`
      : "";
  return {
    label: s.cards.errorsTab,
    count,
    body: `${rowList(shown, {
      head: [s.cards.colErrCmd, s.cards.colWhen],
      empty: m.partialAudit ? x.errorsNonePartial(m.partialAudit.notRead) : x.errorsNone,
    })}${fold}<div class="mr-note">${esc(note)}</div>`,
  };
}

export function renderRunHealth(m: DashboardModel, s: Strings): string {
  const st = buildStatus(m);
  const more = { href: `#${DRILL.timeline}`, label: s.cards.moreWaits };

  if (st.run.state === "complete") {
    // A finished run: past blocks and failed checks are history (model/status.ts). What
    // is left to show is that it finished, and any ask it left unanswered.
    const maxWait = Math.max(0, ...m.blockers.map((b) => b.waitingSec ?? 0));
    const rows: Row[] = [
      { label: esc(s.status.runComplete), value: "", tone: "ok" },
      ...m.blockers.map((b) => askRow(b, s, maxWait, true)),
    ];
    if (st.human?.unread) rows.push(unreadRow(st.human.unread, s));
    return tabbedCard({
      id: "health",
      title: s.cards.healthTitle,
      tabs: [{ label: s.cards.summaryTab, body: rowList(rows, { note: s.status.runSource }) }],
      more,
    });
  }

  const tabs = [
    answersTab(st.human, m, s),
    stuckTab(st.stuck ?? { state: "no-record" }, s, m.waits.autonomous),
    checksTab(st.checks ?? { state: "none" }, m, s),
    errorsTab(m, s),
  ];
  const problem = tabs.findIndex((t) => t.count?.tone === "warn" || t.count?.tone === "bad");
  return tabbedCard({
    id: "health",
    title: s.cards.healthTitle,
    tabs,
    selected: problem < 0 ? 0 : problem,
    more,
  });
}
