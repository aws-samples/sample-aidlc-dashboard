// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The workspace picker's order, groups, cards and filter (2026-11-16). The server half is
// plain markup; the regroup and the filter are the page's own script, run in happy-dom with
// `/api/summary` stubbed.

import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Window } from "happy-dom";
import { displayPath, renderPicker } from "../render/picker";
import { browse } from "../scan/browse";
import type { WorkspaceDiscovery } from "../scan/workspaces";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");

const found = (names: string[], extra: Partial<WorkspaceDiscovery> = {}): WorkspaceDiscovery => ({
  workspaces: names.map((name) => ({ name, path: `/home/user/work/${name}` })),
  searchedRoots: ["/home/user"],
  scannedDirectories: 40,
  truncated: false,
  ...extra,
});

describe("picker — markup", () => {
  test("each card is one link named by the workspace, its path home-relative", () => {
    const html = renderPicker(
      browse(FIXTURE),
      false,
      undefined,
      found(["alpha"]),
      undefined,
      "ko",
      {
        home: "/home/user",
      },
    );
    const card = html.slice(
      html.indexOf('<a class="workspace"'),
      html.indexOf("</a>", html.indexOf('<a class="workspace"')),
    );
    expect(card).toContain('href="/select?dir=%2Fhome%2Fuser%2Fwork%2Falpha"');
    expect(card).toMatch(/aria-labelledby="ws-1-n"/);
    expect(card).toContain('<span class="workspace-name" id="ws-1-n">alpha</span>');
    expect(card).toContain(">~/work/alpha</span>");
    expect(card).toContain('title="/home/user/work/alpha"');
    // Nothing interactive inside the one link, and no repeated kind label.
    expect(card.slice(2)).not.toMatch(/<a |<button/);
    expect(html).not.toContain("AI-DLC 워크스페이스</span>");
  });

  test("the workspace on screen leads, marked, even when discovery did not reach it", () => {
    const html = renderPicker(browse(FIXTURE), false, "/elsewhere/live", found(["alpha", "beta"]));
    const current = html.indexOf('id="ws-current"');
    expect(current).toBeGreaterThan(-1);
    expect(html.indexOf("지금 보는 중")).toBeLessThan(current);
    expect(current).toBeLessThan(html.indexOf('id="ws-run"'));
    expect(html.slice(current, html.indexOf('id="ws-run"'))).toContain(">live</span>");
    // A discovered current workspace is not listed twice.
    const again = renderPicker(
      browse(FIXTURE),
      false,
      "/home/user/work/alpha",
      found(["alpha", "beta"]),
    );
    expect(again.match(/>alpha<\/span>/g)?.length).toBe(1);
  });

  test("the other-locations fold opens when the list cannot answer, or while browsing", () => {
    const open = '<details class="other-locations" id="other-locations" open>';
    expect(renderPicker(browse(FIXTURE), false, undefined, found([]))).toContain(open);
    expect(renderPicker(browse(FIXTURE), false, undefined, found(["a"]))).not.toContain(open);
    expect(
      renderPicker(browse(FIXTURE), false, undefined, found(["a"]), undefined, "ko", {
        openOther: true,
      }),
    ).toContain(open);
    expect(
      renderPicker({ ...browse(FIXTURE), error: "nope" }, false, undefined, found(["a"])),
    ).toContain(open);
  });

  test("the filesystem root chip is named, not a bare slash", () => {
    if (process.platform === "win32") return;
    expect(
      renderPicker(browse(FIXTURE), false, undefined, found(["a"]), undefined, "ko"),
    ).toContain("<span>루트</span>");
  });
});

describe("displayPath", () => {
  test("keeps the tail and cuts the middle", () => {
    expect(displayPath("/home/user/a/b", "/home/user")).toBe("~/a/b");
    const long = "/home/user/projects/teams/sample-app/harness-copies/runner-classic-one";
    const shown = displayPath(long, "/home/user");
    expect(shown.length).toBeLessThanOrEqual(56);
    expect(shown.startsWith("~/projects/…/")).toBe(true);
    expect(shown.endsWith("/harness-copies/runner-classic-one")).toBe(true);
    expect(displayPath("/home/user-b/x", "/home/user")).toBe("/home/user-b/x");
  });
});

let win: Window | undefined;
afterEach(async () => {
  await win?.happyDOM.close();
  win = undefined;
});

async function load(html: string, answer: (dir: string) => unknown): Promise<Window> {
  const w = new Window({
    url: "http://127.0.0.1/pick",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  win = w;
  (w as unknown as { fetch: unknown }).fetch = async (url: string) => {
    const dir = decodeURIComponent(url.split("dir=")[1] ?? "");
    return new w.Response(JSON.stringify(answer(dir)), { status: 200 });
  };
  w.document.write(html);
  await w.happyDOM.waitUntilComplete();
  // Let the four lanes and the regroup finish.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  return w;
}

const ok = (asOf: string, count = 0) => ({
  kind: "ok",
  progress: {
    pct: 50,
    done: 5,
    total: 10,
    lifecyclePhase: "x",
    currentStage: "s",
    currentStageDisplay: "S",
    asOf,
  },
  blockers: { count, asked: 3, unreadable: 0 },
});

const names = (w: Window, id: string) =>
  [...w.document.querySelectorAll(`#${id} .workspace-name`)].map((n) => n.textContent);

describe("picker — script", () => {
  test("runs newest first, no-run folded, each reason kept, blank answers worded", async () => {
    const w = await load(
      renderPicker(
        browse(FIXTURE),
        false,
        undefined,
        found(["old", "none", "new", "arch", "broken"]),
        undefined,
        "ko",
      ),
      (dir) => {
        const n = path.basename(dir);
        if (n === "old") return ok("2026-01-01T00:00:00Z", 2);
        if (n === "new") return ok("2026-02-01T00:00:00Z");
        if (n === "none") return { kind: "no-run", reason: "none" };
        if (n === "arch") return { kind: "no-run", reason: "archived", archived: 2 };
        return { kind: "unreadable" };
      },
    );
    expect(names(w, "ws-run")).toEqual(["new", "old", "broken"]);
    expect(names(w, "ws-idle-list")).toEqual(["none", "arch"]);
    const idle = w.document.getElementById("ws-idle") as unknown as {
      hidden: boolean;
      open: boolean;
    };
    expect(idle.hidden).toBe(false);
    expect(idle.open).toBe(false);
    expect(w.document.querySelector("#ws-idle summary")?.textContent).toBe(
      "실행 기록 없음·보관 2곳",
    );
    expect(w.document.querySelector("#ws-idle-list")?.textContent).toContain("보관된 인텐트 2개뿐");
    const blank = (n: string) =>
      [...w.document.querySelectorAll(".workspace")]
        .find((c) => c.querySelector(".workspace-name")?.textContent === n)
        ?.querySelector(".ws-m-blank")?.textContent;
    expect(blank("old")).toBe("2빈 답");
    expect(blank("new")).toContain("빈 답 없음");
    expect(w.document.getElementById("ws-run")?.getAttribute("aria-busy")).toBeNull();
    // The order label is shown only once the order is real — and there is no current card
    // here, so there is no label at all.
    expect(w.document.getElementById("ws-run-label")).toBeNull();
  });

  test("the filter matches name or path and opens the folded group when the match is there", async () => {
    const w = await load(
      renderPicker(browse(FIXTURE), false, undefined, found(["alpha", "beta", "idle-one"])),
      (dir) =>
        dir.endsWith("idle-one") ? { kind: "no-run", reason: "none" } : ok("2026-01-01T00:00:00Z"),
    );
    const input = w.document.getElementById("workspace-filter") as unknown as {
      value: string;
      dispatchEvent(e: unknown): void;
    };
    const visible = () =>
      [...w.document.querySelectorAll(".workspace")]
        .filter((c) => !(c as unknown as { hidden: boolean }).hidden)
        .map((c) => c.querySelector(".workspace-name")?.textContent);
    input.value = "ALP";
    input.dispatchEvent(new w.Event("input"));
    expect(visible()).toEqual(["alpha"]);
    input.value = "idle";
    input.dispatchEvent(new w.Event("input"));
    expect(visible()).toEqual(["idle-one"]);
    expect((w.document.getElementById("ws-idle") as unknown as { open: boolean }).open).toBe(true);
    input.value = "/work/";
    input.dispatchEvent(new w.Event("input"));
    expect(visible().length).toBe(3);
    input.value = "zzz";
    input.dispatchEvent(new w.Event("input"));
    expect(
      (w.document.getElementById("ws-filter-empty") as unknown as { hidden: boolean }).hidden,
    ).toBe(false);
  });
});

describe("picker — order label", () => {
  test("the run-group label appears only after the regroup has ordered the cards", async () => {
    const html = renderPicker(
      browse(FIXTURE),
      false,
      "/home/user/work/live",
      found(["live", "a", "b"]),
    );
    expect(html).toContain('id="ws-run-label" hidden');
    const w = await load(html, () => ok("2026-01-01T00:00:00Z"));
    expect(
      (w.document.getElementById("ws-run-label") as unknown as { hidden: boolean }).hidden,
    ).toBe(false);
  });
});

describe("picker — the one path field", () => {
  // A synthetic listing, so the test owns every name in it.
  const listing = {
    dir: "/home/user/work",
    parent: "/home/user",
    isWorkspace: false,
    entries: ["alpha", "alpine", "beta"].map((name) => ({
      name,
      fullPath: `/home/user/work/${name}`,
      isWorkspace: name === "beta",
      isAidlcDir: false,
      unreadable: false,
    })),
  };
  const page = () =>
    load(
      renderPicker(listing, false, undefined, found([]), undefined, "ko", { home: "/home/user" }),
      () => ({ kind: "unreadable" }),
    );
  type Field = {
    value: string;
    dispatchEvent(e: unknown): boolean;
  };
  const field = (w: Window) => w.document.getElementById("path-input") as unknown as Field;
  const shown = (w: Window) =>
    [...w.document.querySelectorAll(".dir-row")]
      .filter((r) => !(r as unknown as { hidden: boolean }).hidden)
      .map((r) => (r as unknown as { dataset: { dirLabel: string } }).dataset.dirLabel);
  const status = (w: Window) => w.document.getElementById("path-status")?.textContent;
  const type = (w: Window, value: string) => {
    field(w).value = value;
    field(w).dispatchEvent(new w.Event("input"));
  };
  const key = (w: Window, k: string) => {
    const e = new w.KeyboardEvent("keydown", { key: k, cancelable: true, bubbles: true });
    field(w).dispatchEvent(e);
    return e.defaultPrevented;
  };

  test("it holds the folder on screen and filters it by what follows the last slash", async () => {
    const w = await page();
    expect(field(w).value).toBe("~/work/");
    expect(shown(w)).toEqual(["alpha", "alpine", "beta"]);
    type(w, "~/work/AL");
    expect(shown(w)).toEqual(["alpha", "alpine"]);
    expect(status(w)).toBe("일치하는 폴더 2개");
    type(w, "/home/user/work/bet");
    expect(shown(w)).toEqual(["beta"]);
    expect(status(w)).toBe("일치하는 폴더 1개");
    type(w, "~/work/zzz");
    expect(shown(w)).toEqual([]);
    expect(status(w)).toBe("일치하는 폴더가 없습니다.");
  });

  test("a path toward another folder keeps the list whole and says Enter goes there", async () => {
    const w = await page();
    type(w, "~/elsewhere/al");
    expect(shown(w)).toEqual(["alpha", "alpine", "beta"]);
    expect(status(w)).toBe("Enter 로 이동");
  });

  test("Tab completes a single match, and only then; Esc puts the folder back", async () => {
    const w = await page();
    type(w, "~/work/al");
    expect(key(w, "Tab")).toBe(false); // two matches: Tab moves focus as usual
    expect(field(w).value).toBe("~/work/al");
    type(w, "~/work/alpi");
    expect(key(w, "Tab")).toBe(true);
    expect(field(w).value).toBe("~/work/alpine/");
    expect(status(w)).toBe("Enter 로 이동");
    expect(key(w, "Escape")).toBe(true);
    expect(field(w).value).toBe("~/work/");
    expect(shown(w)).toEqual(["alpha", "alpine", "beta"]);
    expect(status(w)).toBe("");
  });

  test("every folder link lands on the control, and a hidden flag rides on the form", () => {
    const html = renderPicker(listing, true, undefined, found([]), undefined, "ko", {
      home: "/home/user",
    });
    expect(html).toContain(`href="/browse?dir=%2Fhome%2Fuser%2Fwork%2Falpha&amp;hidden=1"`);
    expect(html).toContain('<input type="hidden" name="hidden" value="1">');
    expect(html).toContain("<summary>다른 위치 열기</summary>");
  });
});

describe("picker — the path field after a restore", () => {
  test("a value the browser restored is put back to the folder on screen", async () => {
    const html = renderPicker(
      {
        dir: "/home/user/work",
        parent: "/home/user",
        isWorkspace: false,
        entries: [],
      },
      false,
      undefined,
      found([]),
      undefined,
      "ko",
      { home: "/home/user" },
    ).replace('value="~/work/"', 'value="~/work/restored/"');
    const w = await load(html, () => ({ kind: "unreadable" }));
    const field = w.document.getElementById("path-input") as unknown as { value: string };
    expect(field.value).toBe("~/work/");
  });
});
