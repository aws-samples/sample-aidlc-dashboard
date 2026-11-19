// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The page's own poll script, run in a DOM (happy-dom), against a stubbed server.
//
// The string tests elsewhere prove the script CONTAINS the restore code; they would
// pass if that code never ran or restored the wrong thing. This runs it: the reader
// picks tabs and opens a tile's panel, the server then sends a body whose default tab
// has moved, and the swap must keep exactly what the READER chose — and nothing the
// server chose, because a server-picked default (Run Health opens on its first
// problem) has to be free to move when the run changes.
//
// JavaScript evaluation is enabled for this window only, and only ever runs markup
// this repository renders itself.

import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Window } from "happy-dom";
import { assemble } from "../model/assemble";
import type { DashboardModel } from "../model/types";
import { renderBody, renderPage } from "../render/page";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const before = assemble(FIXTURE);
// No asks and no block → Run Health's first problem, and so its default tab, moves
// from "answers" (0) to "failed checks" (2). The same variant status.test.ts uses.
const after: DashboardModel = {
  ...before,
  blockers: [],
  health: { ...before.health, stopGuard: { signature: "code-generation::40", count: 0 } },
};

let win: Window | undefined;
afterEach(async () => {
  await win?.happyDOM.close();
  win = undefined;
});

/** Load the page with its script running and `fetch` answered by `body`. */
async function load(
  body: () => string,
  bodyStatus = 200,
  url = "http://127.0.0.1/",
): Promise<Window> {
  const w = new Window({
    url,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  win = w;
  const fetches: string[] = [];
  (w as unknown as { fetch: unknown }).fetch = async (url: string) => {
    fetches.push(url);
    return url.startsWith("/api/body")
      ? new w.Response(body(), { status: bodyStatus })
      : new w.Response("{}", { status: 200 });
  };
  (w as unknown as { fetches: string[] }).fetches = fetches;
  // pollMs 0: no timer — the test drives the one refresh path through the button.
  w.document.write(renderPage(before, 0, "ko"));
  await w.happyDOM.waitUntilComplete();
  return w;
}

/**
 * The checked radio's value, read from the PROPERTY. happy-dom's `:checked` can still
 * match a radio whose `checked` attribute the server rendered after a script moved the
 * pick, so a selector would report the server's default instead of the reader's.
 */
const checked = (w: Window, group: string) =>
  (
    [...w.document.querySelectorAll(`input.mc-r[name="${group}"]`)] as unknown as {
      checked: boolean;
      value: string;
    }[]
  ).find((r) => r.checked)?.value;

function pick(w: Window, group: string, value: string): void {
  const r = w.document.querySelector(
    `input.mc-r[name="${group}"][value="${value}"]`,
  ) as unknown as {
    checked: boolean;
    dispatchEvent(e: unknown): void;
  };
  r.checked = true;
  r.dispatchEvent(new w.Event("change", { bubbles: true }));
}

/** Click an element the way a reader does. */
const click = (w: Window, selector: string) =>
  (w.document.querySelector(selector) as unknown as { click(): void }).click();

/** Click reload and wait until the swap has landed. */
async function refresh(w: Window): Promise<void> {
  (w.document.getElementById("reload-btn") as unknown as { click(): void }).click();
  const state = w.document.getElementById("poll-state");
  for (let i = 0; i < 100 && !state?.textContent?.startsWith("갱신"); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("poll swap in a real DOM", () => {
  test("the reader's tab picks and open tile panel survive; the server's defaults move", async () => {
    const w = await load(() => renderBody(after, "ko"));
    expect(checked(w, "mc-health")).toBe("0");
    expect(w.document.getElementById("card-health")?.innerHTML).toContain(
      '<label for="mc-health-0">내 답변 <b class="mc-n warn">1</b></label>',
    );
    const stageDefault = checked(w, "mc-stage");

    pick(w, "mc-kpi", "2");
    // The server opened the diagnostics fold (the fixture flags a failed check); the
    // reader folds it away.
    const diag = () => w.document.getElementById("diag") as unknown as { open: boolean };
    expect(diag().open).toBe(true);
    diag().open = false;

    await refresh(w);
    const fetches = (w as unknown as { fetches: string[] }).fetches;
    expect(fetches.some((u) => u.startsWith("/api/body"))).toBe(true);
    // The body really was swapped: Run Health's answers count went from 1 to 0.
    const health = () => w.document.getElementById("card-health")?.innerHTML ?? "";
    expect(health()).toContain('<label for="mc-health-0">내 답변 <b class="mc-n ok">0</b></label>');

    // Restored: what the reader chose.
    expect(diag().open).toBe(false);
    expect(checked(w, "mc-kpi")).toBe("2");
    // Not restored: what the server chose. Run Health follows the run.
    expect(checked(w, "mc-health")).toBe("2");
    expect(checked(w, "mc-stage")).toBe(stageDefault);
  });

  test("a fold the reader closed stays closed even when nothing else is open", async () => {
    const w = await load(() => renderBody(before, "ko"));
    const diag = () => w.document.getElementById("diag") as unknown as { open: boolean };
    expect(diag().open).toBe(true); // the server opened it: the fixture flags a failed check
    click(w, "#diag > summary");
    expect(diag().open).toBe(false);
    await new Promise((r) => setTimeout(r, 1)); // the script reads the state after the click
    await refresh(w);
    expect(diag().open).toBe(false);
  });

  test("the tab title carries the waiting count and follows the swap", async () => {
    const w = await load(() => renderBody(after, "ko"));
    const base = `AI-DLC · ${before.identity.slug ?? before.identity.record}`;
    expect(w.document.title).toBe(`(1) ${base}`);
    await refresh(w);
    expect(w.document.title).toBe(base);
  });

  test("copy path writes the hero's workspace path and says so, after a swap too", async () => {
    const w = await load(() => renderBody(before, "ko"));
    const copied: string[] = [];
    Object.defineProperty(w.navigator, "clipboard", {
      value: { writeText: async (t: string) => void copied.push(t) },
      configurable: true,
    });
    await refresh(w); // the button the handler sees is the poll's, not the first render's
    const btn = w.document.querySelector("[data-copy]") as unknown as {
      click(): void;
      textContent: string;
      getAttribute(n: string): string;
    };
    btn.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(copied).toEqual([btn.getAttribute("data-copy")]);
    expect(btn.textContent).toBe("복사했어요");
  });

  test("the journey's out-of-scope box survives the poll swap", async () => {
    const w = await load(() => renderBody(after, "ko"));
    const box = () =>
      w.document.getElementById("jr-show-out") as unknown as {
        checked: boolean;
        dispatchEvent(e: unknown): void;
      } | null;
    // The fixture has out-of-scope rows, so the box is there; a fixture change that
    // dropped them would otherwise turn this into a silent pass.
    expect(box()).not.toBeNull();
    box()!.checked = true;
    box()!.dispatchEvent(new w.Event("change", { bubbles: true }));
    await refresh(w);
    expect(box()!.checked).toBe(true);
  });

  test("with nothing picked, every group takes the new body's defaults", async () => {
    const w = await load(() => renderBody(after, "ko"));
    await refresh(w);
    expect(checked(w, "mc-health")).toBe("2");
    expect(checked(w, "mc-kpi")).toBe("0");
  });
});

/** Which of the four full panels the cascade actually shows. */
const shown = (w: Window) =>
  ["drill-overview", "drill-usage", "drill-timeline", "drill-agents"].map(
    (id) => w.getComputedStyle(w.document.getElementById(id) as never).display !== "none",
  );

// Each test reads the computed styles ONCE, after its last state change: happy-dom
// caches computed style and does not treat a radio's `checked` property as a mutation,
// so a read before a click returned the stale cascade after it (measured, 2026-11-14 —
// the old fold tests only passed because toggling `open` was an attribute change).
// The real-browser behaviour was checked by hand in a browser.
describe("a Details tab shows its full panel — nothing folds", () => {
  test("on load the first panel is shown, and the wrapper is no <details>", async () => {
    const w = await load(() => renderBody(before, "ko"));
    expect(checked(w, "mc-kpi")).toBe("0");
    expect(shown(w)).toEqual([true, false, false, false]);
    expect(w.document.querySelector("details#kpi-more")).toBeNull();
  });

  test("a tab shows its panel and hides the others — the cascade, not just the markup", async () => {
    // .drill-body (the panels' inner layout) sets display AFTER the hide rule; at equal
    // specificity it won and all three panels showed at once in a real browser.
    const w = await load(() => renderBody(before, "ko"));
    click(w, 'label[for="mc-kpi-2"]');
    expect(shown(w)).toEqual([false, false, true, false]);
  });

  test("the fourth tab shows the agents panel alone", async () => {
    // The CSS is generated per position; a TABS left at 3 would show no panel here.
    const w = await load(() => renderBody(before, "ko"));
    click(w, 'label[for="mc-kpi-3"]');
    expect(shown(w)).toEqual([false, false, false, true]);
  });

  test("the chosen tab clicked again keeps its panel — there is no fold to close", async () => {
    const w = await load(() => renderBody(before, "ko"));
    click(w, 'label[for="mc-kpi-1"]');
    click(w, 'label[for="mc-kpi-1"]');
    expect(shown(w)).toEqual([false, true, false, false]);
  });

  test("Run Health's link picks the timing tab", async () => {
    const w = await load(() => renderBody(before, "ko"));
    click(w, "#card-health a.mc-more");
    expect(checked(w, "mc-kpi")).toBe("2");
    expect(shown(w)).toEqual([false, false, true, false]);
  });

  test("the journey's matrix link picks the progress tab, and the poll keeps a pick", async () => {
    const w = await load(() => renderBody(before, "ko"));
    click(w, 'label[for="mc-kpi-2"]');
    click(w, '#journey a[data-drill="matrix"]');
    expect(checked(w, "mc-kpi")).toBe("0");
    await refresh(w);
    expect(checked(w, "mc-kpi")).toBe("0");
    expect(shown(w)).toEqual([true, false, false, false]);
  });

  test("a usage window reload (?cw=) lands on the usage panel", async () => {
    const w = await load(() => renderBody(before, "ko"), 200, "http://127.0.0.1/?cw=30d");
    expect(checked(w, "mc-kpi")).toBe("1");
    expect(shown(w)).toEqual([false, true, false, false]);
  });
});

describe("a body that is gone reloads the page", () => {
  /** Click reload and wait until the refresh settled one way or the other. */
  async function settle(w: Window, reloaded: () => boolean): Promise<void> {
    (w.document.getElementById("reload-btn") as unknown as { click(): void }).click();
    const state = w.document.getElementById("poll-state");
    for (let i = 0; i < 100 && !reloaded() && !state?.classList.contains("err"); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  test("404 — the run is gone (e.g. its last intent archived): reload for the server's own page", async () => {
    const w = await load(() => "<p>not found</p>", 404);
    let reloads = 0;
    Object.defineProperty(w.location, "reload", { value: () => reloads++, configurable: true });
    await settle(w, () => reloads > 0);
    expect(reloads).toBe(1);
  });

  test("500 — still a failed refresh, not a reload", async () => {
    const w = await load(() => "boom", 500);
    let reloads = 0;
    Object.defineProperty(w.location, "reload", { value: () => reloads++, configurable: true });
    await settle(w, () => reloads > 0);
    expect(reloads).toBe(0);
    expect(w.document.getElementById("poll-state")?.classList.contains("err")).toBe(true);
  });
});
