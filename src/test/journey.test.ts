// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The journey board (render/journey.ts). It replaced the Stage and Unit cards, so the
// readings those cards' tests protected are pinned here against the new markup, beside
// the board's own: three kinds of "not run", one current position, out-of-scope hidden.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import type { DashboardModel } from "../model/types";
import { esc, hours } from "../render/common";
import { strings } from "../render/i18n";
import { foldStage, renderJourney } from "../render/journey";
import { renderPage } from "../render/page";
import type { MatrixCell } from "../scan/matrix";
import type { StageInfo, StageStatus } from "../scan/parser";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);
const ko = strings("ko");
const en = strings("en");

/** The `<li>` of one stage, by its display name. */
function stageRow(html: string, display: string): string {
  const at = html.indexOf(`<span class="jr-n">${esc(display)}</span>`);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = html.lastIndexOf("<li", at);
  return html.slice(start, html.indexOf("</li>", at));
}

const copy = (status: StageStatus, execute = true): StageInfo => ({
  slug: "functional-design",
  display: "Functional Design",
  status,
  execute,
});

describe("journey — the fold, one row per slug", () => {
  test("done only when every executed copy is; partly done and idle is not active", () => {
    expect(foldStage([copy("done"), copy("done")])).toBe("done");
    expect(foldStage([copy("done"), copy("pending")])).toBe("todo");
  });

  test("a copy at its gate outranks one that is working", () => {
    expect(foldStage([copy("active"), copy("awaiting")])).toBe("awaiting");
    expect(foldStage([copy("active"), copy("revising")])).toBe("revising");
  });

  test("out of scope and skipped at runtime are different kinds", () => {
    expect(foldStage([copy("skipped", false)])).toBe("out");
    expect(foldStage([copy("skipped", true)])).toBe("skip");
    expect(foldStage([copy("pending", false), copy("done")])).toBe("done");
  });

  test("repeated copies of a slug draw one row", () => {
    const phase = base.state.phases.find((p) =>
      p.stages.some((s) => s.slug === "functional-design"),
    )!;
    const fd = phase.stages.find((s) => s.slug === "functional-design")!;
    const m: DashboardModel = {
      ...base,
      state: {
        ...base.state,
        phases: base.state.phases.map((p) =>
          p !== phase
            ? p
            : {
                ...p,
                stages: [
                  { ...fd, status: "done" },
                  { ...fd, status: "pending" },
                  ...p.stages.filter((s) => s !== fd),
                ],
              },
        ),
      },
    };
    const html = renderJourney(m, ko);
    expect(html.split(`<span class="jr-n">Functional Design</span>`).length - 1).toBe(1);
    expect(stageRow(html, "Functional Design")).toContain('class="jr-s jk-todo"');
  });
});

describe("journey — time and position", () => {
  test("stage time is work + conversation, never elapsed wall time", () => {
    const sp = base.timing.stages.find((t) => t.stage === "code-generation")!;
    expect(sp.elapsedSec).toBeGreaterThan(sp.observedSec + sp.conversationSec);
    const row = stageRow(renderJourney(base, ko), "Code Generation");
    // hours() of observed + conversation, not the wall span; the figure's own tip says
    // what it counts and what it leaves out.
    expect(row).toContain(
      `<span class="jr-t" title="${esc(ko.cards.workChatTip)}">${hours(sp.observedSec + sp.conversationSec)}</span>`,
    );
    expect(row).toContain("작업+대화");
  });

  test("a stage with no audit span states no time", () => {
    expect(base.timing.stages.some((t) => t.stage === "infrastructure-design")).toBe(false);
    const html = renderJourney(base, ko);
    const display = base.state.phases
      .flatMap((p) => p.stages)
      .find((s) => s.slug === "infrastructure-design")!.display;
    expect(stageRow(html, display)).not.toContain('class="jr-t"');
  });

  test("one current position, amber when something waits on the reader", () => {
    const html = renderJourney(base, ko);
    expect(html.match(/ here (you|agent)"/g)?.length).toBe(1);
    expect(stageRow(html, "Code Generation")).toContain(" here you");
    expect(html).toContain("내 차례");
  });

  test("with nothing waiting the position is blue, and a finished run has none", () => {
    const clear = renderJourney({ ...base, blockers: [] }, ko);
    expect(clear).toContain(" here agent");
    const done = renderJourney({ ...base, state: { ...base.state, complete: true } }, ko);
    expect(done).not.toMatch(/ here (you|agent)"/);
  });

  test("a position the reader could not confirm says so", () => {
    const m: DashboardModel = {
      ...base,
      waits: { ...base.waits, position: { ...base.waits.position, verified: false } },
    };
    expect(renderJourney(m, ko)).toContain("위치 미확인");
  });
});

describe("journey — out of scope", () => {
  test("every stage row is on the board, and the summary counts both", () => {
    const html = renderJourney(base, ko);
    const slugs = new Set(base.state.phases.flatMap((p) => p.stages.map((s) => s.slug)));
    expect(html.match(/<li class="jr-s /g)?.length).toBe(slugs.size + 6); // + the legend's six
    const out = [...slugs].filter((slug) =>
      base.state.phases
        .flatMap((p) => p.stages)
        .filter((s) => s.slug === slug)
        .every((s) => !s.execute),
    ).length;
    expect(html).toContain(ko.journey.summary(slugs.size, slugs.size - out));
    if (out > 0) expect(html).toContain(`id="jr-show-out"> ${esc(ko.journey.showOut(out))}`);
  });

  test("hidden by default, shown by the box — in CSS, so the poll can restore it", () => {
    const page = renderPage(base, 0, "ko");
    expect(page).toContain(".jr-track > .jr-s.jk-out { display:none; }");
    expect(page).toContain(
      ".journey:has(#jr-show-out:checked) .jr-track > .jr-s.jk-out { display:flex; }",
    );
    expect(page).toContain("jrShowOut");
  });
});

describe("journey — units", () => {
  test("a row per unit, a cell per stage that ran, the matrix's own tip and fraction", () => {
    const html = renderJourney(base, ko);
    const units = html.slice(html.indexOf('class="jr-units"'));
    for (const u of base.matrix!.units)
      expect(units).toContain(`<span class="jr-un">${esc(u.name)}</span>`);
    expect(units).toContain('class="jr-c done"');
    expect(units).toContain('class="jr-c part"');
    expect(units).toContain("(1/2)");
    expect(units).toContain("미완: code-summary");
    expect(units).toContain('<a href="#matrix" data-drill="matrix">');
  });

  test("the fraction counts REQUIRED artifacts; with none it is the file count", () => {
    const withCell = (cell: Partial<MatrixCell>) => {
      const matrix = base.matrix!;
      const m: DashboardModel = {
        ...base,
        matrix: {
          ...matrix,
          stages: matrix.stages.map((st) =>
            st.slug !== "code-generation"
              ? st
              : { ...st, cells: [{ ...(st.cells[0] as MatrixCell), ...cell }] },
          ),
        },
      };
      const html = renderJourney(m, ko);
      return html.slice(html.indexOf('class="jr-units"'));
    };
    const expected = ["plan", "code-summary", "optional-notes"];
    const required = ["plan", "code-summary"];
    expect(
      withCell({
        state: "complete",
        present: ["plan.md", "code-summary.md"],
        expected,
        required,
        missing: [],
      }),
    ).toContain("(2/2)");
    expect(
      withCell({
        state: "partial",
        present: ["plan.md"],
        expected,
        required,
        missing: ["code-summary"],
      }),
    ).toContain("(1/2)");
    expect(
      withCell({
        state: "complete",
        present: ["a.md", "b.md"],
        expected: [],
        required: [],
        missing: [],
      }),
    ).toContain("(2)");
  });

  test("with no matrix it says why rather than drawing an empty grid", () => {
    expect(renderJourney({ ...base, matrix: undefined }, ko)).toContain(esc(ko.overview.noUnits));
  });

  test("the legend names only the cell states on screen", () => {
    const html = renderJourney(base, ko);
    const legend = html.slice(html.indexOf('class="jr-ulg"'));
    expect(legend).toContain(esc(ko.cards.cellLabel.complete));
    expect(legend).not.toContain(esc(ko.cards.cellLabel.unverified));
  });
});

describe("journey — accessibility", () => {
  test("each stage row says its state in words, not only by shape and colour", () => {
    const html = renderJourney(base, ko);
    const fd = stageRow(html, "Functional Design");
    expect(fd).toMatch(/<span class="vh">, [^<]+<\/span>/);
    // The board only — the legend lists every kind whether or not a row has it.
    const board = html.slice(0, html.indexOf('class="jr-lg"'));
    for (const k of ["done", "active", "todo", "out"] as const) {
      // `jk-<kind>"` closes the class on a row that is not the current one.
      if (board.includes(`jk-${k}"`)) {
        expect(board).toContain(`<span class="vh">, ${esc(ko.journey.kind[k])}</span>`);
      }
    }
    // Every row but the current one, whose visible tag already says what it is.
    const rows = board.match(/<li class="jr-s /g)?.length ?? 0;
    const here = board.match(/ here (?:you|agent)"/g)?.length ?? 0;
    expect(board.match(/<span class="vh">/g)?.length).toBe(rows - here);
    const cur = board.slice(board.lastIndexOf("<li", board.search(/ here (?:you|agent)"/)));
    expect(cur.slice(0, cur.indexOf("</li>"))).not.toContain('class="vh"');
  });

  test("each unit cell carries an aria-label naming the stage and the state", () => {
    const units = renderJourney(base, ko).slice(
      renderJourney(base, ko).indexOf('class="jr-units"'),
    );
    const cells = units.match(/<i class="jr-c [^"]+" role="img" aria-label="[^"]+"/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]).toContain(esc(ko.cards.cellLabel.complete));
  });
});

test("English renders the journey with no Hangul outside tree text", () => {
  let html = renderJourney(base, en);
  const tree = [
    ...base.state.phases.flatMap((p) => [p.display, ...p.stages.map((s) => s.display)]),
    ...(base.matrix?.units.map((u) => u.name) ?? []),
  ];
  for (const t of tree) html = html.split(esc(t)).join("");
  expect(html.match(/[가-힣]+/g) ?? []).toEqual([]);
});
