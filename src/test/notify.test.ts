// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Desktop notifications (render/notify.ts), run in a DOM against a stubbed server and a
// stubbed `Notification`.
//
// What must hold, each pinned below: the notified set is the hero card's holds and
// nothing else, keyed so a re-read of the same hold never fires twice; what was on screen
// when the page opened never fires; nothing fires while the reader is looking at the tab;
// one notification per poll, naming the first new hold and how many more; a click lands
// on the hold's file; a hidden tab keeps polling only while notifications are on; and the
// switch says which permission state the browser is in.
//
// JavaScript evaluation is enabled for these windows only, and only ever runs markup this
// repository renders itself.

import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Window } from "happy-dom";
import { assemble } from "../model/assemble";
import { humanHolds } from "../model/status";
import type { Blocker, DashboardModel } from "../model/types";
import { strings } from "../render/i18n";
import { renderBody, renderPage } from "../render/page";
import { notifyItems, notifyScope } from "../render/status";
import { parseQuestions } from "../scan/questions";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);
const ask = base.blockers.find((b) => b.isCurrentStage) as Blocker;

/** The fixture with one more current ask — a hold that was not there before. */
const withAsks = (...extra: Partial<Blocker>[]): DashboardModel => ({
  ...base,
  blockers: [...base.blockers, ...extra.map((e) => ({ ...ask, ...e }))],
});
/** The browser permission states (no DOM lib in this tsconfig). */
type Permission = "default" | "granted" | "denied";

const done: DashboardModel = { ...base, state: { ...base.state, complete: true } };

interface Sent {
  title: string;
  body?: string;
  tag?: string;
  renotify?: boolean;
  onclick?: (() => void) | null;
  closed: boolean;
}

interface Harness {
  w: Window;
  sent: Sent[];
  fetches: string[];
  setBody(m: DashboardModel): void;
  setHidden(v: boolean): void;
  setFocus(v: boolean): void;
}

let win: Window | undefined;
afterEach(async () => {
  await win?.happyDOM.close();
  win = undefined;
});

/**
 * Load the page with its script running. `permission` is the stubbed browser state
 * (`unsupported` removes `Notification` altogether); `stored` seeds the switch.
 */
async function load(
  first: DashboardModel,
  opts: {
    permission?: Permission | "unsupported";
    grantOnRequest?: boolean;
    /** Answer the request later, through BOTH the callback and the promise (Chrome does). */
    slowRequest?: boolean;
    stored?: "on" | "off";
    /** A storage that reads but throws on every write (quota, a locked-down profile). */
    storageRefusesWrites?: boolean;
    pollMs?: number;
  } = {},
): Promise<Harness> {
  const w = new Window({
    url: "http://127.0.0.1/",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  win = w;
  let body = renderBody(first, "ko");
  const fetches: string[] = [];
  (w as unknown as { fetch: unknown }).fetch = async (url: string) => {
    fetches.push(url);
    return url.startsWith("/api/body")
      ? new w.Response(body, { status: 200 })
      : new w.Response("{}", { status: 200 });
  };
  let hidden = false;
  let focus = true;
  Object.defineProperty(w.document, "hidden", { configurable: true, get: () => hidden });
  (w.document as unknown as { hasFocus: () => boolean }).hasFocus = () => focus;
  const sent: Sent[] = [];
  const perm = opts.permission ?? "granted";
  if (perm !== "unsupported") {
    const initial: Permission = perm;
    class FakeNotification {
      static permission: Permission = initial;
      static requests = 0;
      static requestPermission(cb?: (p: Permission) => void): Promise<Permission> {
        FakeNotification.requests++;
        const decide = (): Permission => {
          FakeNotification.permission = opts.grantOnRequest ? "granted" : "denied";
          return FakeNotification.permission;
        };
        if (!opts.slowRequest) return Promise.resolve().then(decide);
        // The slow one answers through the callback AND the promise, as Chrome may.
        return new Promise((r) =>
          setTimeout(() => {
            const p = decide();
            cb?.(p);
            r(p);
          }, 5),
        );
      }
      private rec: Sent;
      constructor(title: string, o: { body?: string; tag?: string; renotify?: boolean } = {}) {
        this.rec = { title, body: o.body, tag: o.tag, renotify: o.renotify, closed: false };
        sent.push(this.rec);
      }
      get onclick(): (() => void) | null {
        return this.rec.onclick ?? null;
      }
      set onclick(f: (() => void) | null) {
        this.rec.onclick = f;
      }
      close() {
        this.rec.closed = true;
      }
    }
    (w as unknown as { Notification: unknown }).Notification = FakeNotification;
  }
  if (opts.stored) w.localStorage.setItem("aidlc-dashboard.notify", opts.stored);
  if (opts.storageRefusesWrites) {
    const held = new Map<string, string>(
      opts.stored ? [["aidlc-dashboard.notify", opts.stored]] : [],
    );
    Object.defineProperty(w, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => held.get(k) ?? null,
        setItem: () => {
          throw new Error("quota");
        },
      },
    });
  }
  w.document.write(renderPage(first, opts.pollMs ?? 0, "ko"));
  // A running poll timer never completes, so `waitUntilComplete` would wait forever.
  if (opts.pollMs) await new Promise((r) => setTimeout(r, 20));
  else await w.happyDOM.waitUntilComplete();
  return {
    w,
    sent,
    fetches,
    setBody: (m) => {
      body = renderBody(m, "ko");
    },
    setHidden: (v) => {
      hidden = v;
    },
    setFocus: (v) => {
      focus = v;
    },
  };
}

/** Click reload and wait until the swap has landed. */
async function refresh(w: Window): Promise<void> {
  const state = w.document.getElementById("poll-state");
  const reload = w.document.getElementById("reload-btn") as unknown as {
    click(): void;
    disabled: boolean;
  };
  // A manual refresh keeps the button disabled for a beat after it lands.
  for (let i = 0; i < 3000 && reload.disabled; i++) await new Promise((r) => setTimeout(r, 1));
  if (state) state.textContent = "";
  reload.click();
  for (let i = 0; i < 3000 && !state?.textContent?.startsWith("갱신"); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

const btn = (w: Window) =>
  w.document.getElementById("notify-btn") as unknown as {
    click(): void;
    disabled: boolean;
    textContent: string;
    title: string;
    getAttribute(n: string): string | null;
  };

describe("notification items (server side)", () => {
  const s = strings("ko");

  test("are exactly the hero card's holds while the run is live", () => {
    const items = notifyItems(base, s);
    expect(items.length).toBe(humanHolds(base).length);
    expect(items[0]?.file).toBe(ask.rel);
  });

  test("keys do not move when only the clock or the file's mtime moves", () => {
    const later: DashboardModel = {
      ...base,
      generatedAt: "2099-01-01T00:00:00Z",
      blockers: base.blockers.map((b) => ({ ...b, since: "2099-01-01T00:00:00Z", waitingSec: 9 })),
    };
    expect(notifyItems(later, s).map((i) => i.key)).toEqual(notifyItems(base, s).map((i) => i.key));
  });

  test("a different ask has a different key", () => {
    const keys = notifyItems(withAsks({ heading: "Q9 — another" }), s).map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a finished run is one item, and no hold", () => {
    const items = notifyItems(done, s);
    expect(items.length).toBe(1);
    expect(items[0]?.done).toBe(true);
  });

  test("the banner carries them for the client", () => {
    expect(renderBody(base, "ko")).toContain('data-notify="');
  });
});

describe("notifications in a real DOM", () => {
  test("what was on screen at load never fires; a new hold does, once", async () => {
    const h = await load(base, { stored: "on" });
    h.setHidden(true);
    await refresh(h.w);
    expect(h.sent.length).toBe(0);

    h.setBody(withAsks({ heading: "Q9 — 배포 방식" }));
    await refresh(h.w);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]?.title).toContain("Q9 — 배포 방식");

    // Re-reading the same hold is not news.
    await refresh(h.w);
    expect(h.sent.length).toBe(1);
  });

  // macOS cuts a notification title at about 30 characters, so the title leads with
  // what arrived and the run name and count go to the body (seen on a real Mac).
  test("the title says what arrived; the run and the count are in the body", async () => {
    const h = await load(base, { stored: "on" });
    h.setHidden(true);
    await refresh(h.w);
    h.setBody(withAsks({ heading: "Q9 — 배포 방식" }));
    await refresh(h.w);
    const sent = h.sent[0];
    expect(sent?.title.startsWith("질문 · Q9 — 배포 방식")).toBe(true);
    expect(sent?.body).toContain("기다리는 것");
    expect(sent?.body).not.toContain("Q9 — 배포 방식");
  });

  test("a hold that closes and comes back is new again", async () => {
    const h = await load(base, { stored: "on" });
    h.setHidden(true);
    h.setBody(withAsks({ heading: "Q9" }));
    await refresh(h.w);
    h.setBody(base);
    await refresh(h.w);
    h.setBody(withAsks({ heading: "Q9" }));
    await refresh(h.w);
    expect(h.sent.length).toBe(2);
  });

  test("nothing fires while the reader is looking at the tab", async () => {
    const h = await load(base, { stored: "on" });
    h.setBody(withAsks({ heading: "Q9" }));
    await refresh(h.w);
    expect(h.sent.length).toBe(0);
    // And it is not saved up to fire later: the reader saw it.
    h.setHidden(true);
    await refresh(h.w);
    expect(h.sent.length).toBe(0);
  });

  test("a visible but unfocused window counts as not looking", async () => {
    const h = await load(base, { stored: "on" });
    h.setFocus(false);
    h.setBody(withAsks({ heading: "Q9" }));
    await refresh(h.w);
    expect(h.sent.length).toBe(1);
  });

  test("several new holds in one poll are one notification", async () => {
    const h = await load(base, { stored: "on" });
    h.setHidden(true);
    h.setBody(withAsks({ heading: "Q8" }, { heading: "Q9" }));
    await refresh(h.w);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]?.body).toContain("외 1건");
    expect(h.sent[0]?.tag).toContain(base.identity.record);
  });

  test("off means silent, and turning it on does not replay what came before", async () => {
    const h = await load(base, { stored: "off" });
    h.setHidden(true);
    h.setBody(withAsks({ heading: "Q9" }));
    await refresh(h.w);
    expect(h.sent.length).toBe(0);
    btn(h.w).click(); // on; sends only the confirmation
    await new Promise((r) => setTimeout(r, 5));
    expect(h.sent.length).toBe(1);
    await refresh(h.w);
    expect(h.sent.length).toBe(1);
  });

  test("a finished run notifies", async () => {
    const h = await load(base, { stored: "on" });
    h.setHidden(true);
    h.setBody(done);
    await refresh(h.w);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]?.title).toContain("끝났어요");
  });

  test("a click opens the hold's file", async () => {
    const h = await load(base, { stored: "on" });
    h.setHidden(true);
    h.setBody(withAsks({ heading: "Q9", rel: "inception/x/x-questions.md" }));
    await refresh(h.w);
    h.sent[0]?.onclick?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.w.location.href).toContain(
      `/view?rel=${encodeURIComponent("inception/x/x-questions.md")}`,
    );
    // …and names the record that raised it, so /view can refuse after a switch in another tab.
    expect(h.w.location.href).toContain(`&scope=${encodeURIComponent(notifyScope(base))}`);
  });
});

describe("hidden-tab polling", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const bodies = (h: Harness) => h.fetches.filter((u) => u.startsWith("/api/body")).length;

  test("off: a hidden tab does not poll, as before", async () => {
    const h = await load(base, { stored: "off", pollMs: 10 });
    h.setHidden(true);
    await wait(15);
    const before = bodies(h);
    await wait(60);
    expect(bodies(h)).toBe(before);
  });

  test("on: a hidden tab keeps polling", async () => {
    const h = await load(base, { stored: "on", pollMs: 10 });
    h.setHidden(true);
    await wait(15);
    const before = bodies(h);
    await wait(60);
    expect(bodies(h)).toBeGreaterThan(before);
  });
});

describe("the switch", () => {
  test("off by default", async () => {
    const h = await load(base);
    expect(btn(h.w).getAttribute("aria-pressed")).toBe("false");
    expect(btn(h.w).getAttribute("data-state")).toBe("off");
  });

  test("remembers on across loads", async () => {
    const h = await load(base, { stored: "on" });
    expect(btn(h.w).getAttribute("aria-pressed")).toBe("true");
  });

  test("asks the browser first, then confirms once", async () => {
    const h = await load(base, { permission: "default", grantOnRequest: true });
    btn(h.w).click();
    await new Promise((r) => setTimeout(r, 5));
    expect(btn(h.w).getAttribute("data-state")).toBe("on");
    expect(h.sent.length).toBe(1);
    expect(h.w.localStorage.getItem("aidlc-dashboard.notify")).toBe("on");
    btn(h.w).click();
    expect(btn(h.w).getAttribute("data-state")).toBe("off");
    expect(h.w.localStorage.getItem("aidlc-dashboard.notify")).toBe("off");
  });

  test("a refused request reads as blocked, with how to unblock", async () => {
    const h = await load(base, { permission: "default", grantOnRequest: false });
    btn(h.w).click();
    await new Promise((r) => setTimeout(r, 5));
    expect(btn(h.w).getAttribute("data-state")).toBe("blocked");
    expect(btn(h.w).title).toBe(strings("ko").page.notifyBlockedTip);
  });

  test("blocked by the browser even when stored on", async () => {
    const h = await load(base, { permission: "denied", stored: "on" });
    expect(btn(h.w).getAttribute("data-state")).toBe("blocked");
    expect(btn(h.w).getAttribute("aria-pressed")).toBe("false");
  });

  test("a browser without notifications disables it", async () => {
    const h = await load(base, { permission: "unsupported" });
    expect(btn(h.w).getAttribute("data-state")).toBe("unsupported");
    expect(btn(h.w).disabled).toBe(true);
  });
});

describe("review round 1 (each reproduced before the fix)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const bodies = (h: Harness) => h.fetches.filter((u) => u.startsWith("/api/body")).length;
  type Fake = { permission: Permission; requests: number };
  const fake = (w: Window) => (w as unknown as { Notification: Fake }).Notification;

  test("turning it off works even when storage refuses the write", async () => {
    const h = await load(base, { stored: "on", pollMs: 10, storageRefusesWrites: true });
    btn(h.w).click();
    expect(btn(h.w).getAttribute("data-state")).toBe("off");
    h.setHidden(true);
    await wait(15);
    const before = bodies(h);
    await wait(60);
    expect(bodies(h)).toBe(before);
  });

  test("a replacing notification asks to be shown again", async () => {
    const h = await load(base, { stored: "on" });
    h.setHidden(true);
    h.setBody(withAsks({ heading: "Q9" }));
    await refresh(h.w);
    expect(h.sent[0]?.renotify).toBe(true);
  });

  test("an appended section sharing a title is a new hold", () => {
    const s = strings("ko");
    const one = notifyItems(base, s).map((i) => i.key);
    const two = notifyItems(withAsks({ occurrence: 1 }), s).map((i) => i.key);
    expect(two.length).toBe(one.length + 1);
    expect(new Set(two).size).toBe(two.length);
  });

  test("a click after the page moved to another record does not open a file by its path", async () => {
    const h = await load(base, { stored: "on" });
    h.setHidden(true);
    h.setBody(withAsks({ heading: "Q9" }));
    await refresh(h.w);
    const other: DashboardModel = {
      ...base,
      identity: { ...base.identity, record: "260202-other" },
    };
    h.setBody(other);
    await refresh(h.w);
    h.sent[0]?.onclick?.();
    await wait(5);
    expect(h.w.location.href).not.toContain("/view");
  });

  test("a second click while the browser is asking does not ask twice", async () => {
    const h = await load(base, { permission: "default", grantOnRequest: true, slowRequest: true });
    btn(h.w).click();
    btn(h.w).click();
    await wait(20);
    expect(fake(h.w).requests).toBe(1);
    expect(h.sent.length).toBe(1);
  });

  test("a permission revoked while on shows as blocked when the reader comes back", async () => {
    const h = await load(base, { stored: "on" });
    expect(btn(h.w).getAttribute("data-state")).toBe("on");
    fake(h.w).permission = "denied";
    h.w.document.dispatchEvent(new h.w.Event("visibilitychange"));
    expect(btn(h.w).getAttribute("data-state")).toBe("blocked");
  });

  test("a hold hidden by an unreadable file does not sound again when the file reads", async () => {
    const h = await load(base, { stored: "on" });
    h.setHidden(true);
    const unread: DashboardModel = {
      ...base,
      blockers: [],
      questions: { ...base.questions, unreadable: [ask.rel] },
    };
    h.setBody(unread);
    await refresh(h.w);
    h.setBody(base);
    await refresh(h.w);
    expect(h.sent.length).toBe(0);
  });

  test("nothing is announced that the hero does not show", () => {
    const unknown: DashboardModel = {
      ...base,
      state: { ...base.state, currentStage: "" },
      waits: { ...base.waits, position: { ...base.waits.position, stage: undefined } },
    };
    expect(notifyItems(unknown, strings("ko"))).toEqual([]);
  });
});

describe("which same-titled section an ask is", () => {
  test("appended siblings are numbered, answered ones counted", () => {
    const q = parseQuestions(
      [
        "## Requested Changes Feedback",
        "[Answer]: done",
        "## Requested Changes Feedback",
        "[Answer]:",
        "## Requested Changes Feedback",
        "[Answer]:",
      ].join("\n"),
    );
    expect(q.map((e) => e.occurrence)).toEqual([undefined, 1, 2]);
  });

  test("a Plan Approval that replaced an earlier one is not the earlier one", () => {
    const q = parseQuestions(
      ["## Plan Approval", "[Answer]: changes", "## Plan Approval", "[Answer]:"].join("\n"),
    );
    expect(q.length).toBe(1);
    expect(q[0]?.occurrence).toBe(1);
  });
});
