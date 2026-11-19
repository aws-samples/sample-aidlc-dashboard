// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The source viewer dresses each line by what it is, and still shows the SOURCE: every
// byte of the file, in order, escaped. These tests hold both halves.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Window } from "happy-dom";
import { strings } from "../render/i18n";
import { renderViewPage } from "../render/view-page";
import { parseQuestionsFile } from "../scan/questions";
import type { ViewResult } from "../scan/view-file";
import { codeSpans } from "../scan/visible-lines";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");

function view(
  text: string,
  rel = "inception/x/x-questions.md",
  locale: "ko" | "en" = "ko",
  truncated = false,
): string {
  const bytes = Buffer.byteLength(text);
  const result: ViewResult = {
    ok: true,
    source: { rel, text, truncated, sizeBytes: truncated ? bytes * 2 : bytes, shownBytes: bytes },
  };
  return renderViewPage(result, rel, locale);
}

/** What a browser holds as the source: the <pre>'s text after a real HTML parse. */
function domSource(html: string): string {
  const w = new Window();
  w.document.write(html);
  return w.document.querySelector("pre.src")?.textContent ?? "<no pre>";
}

/** The class of line `n`'s element. */
function lineClass(html: string, n: number): string {
  return new RegExp(`<span class="([^"]*)" id="L${n}"`).exec(html)?.[1] ?? "";
}

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The source as the markup carries it: each line element's text (its line ending is inside). */
function shownSource(html: string): string {
  const pre = html.slice(html.indexOf('<pre class="src'), html.indexOf("</pre>"));
  return pre
    .split('<span class="l')
    .slice(1)
    .map((chunk) =>
      unesc(chunk.slice(chunk.indexOf(">") + 1).replace(/<[^>]*>/g, "")).replace(/&#13;/g, "\r"),
    )
    .join("");
}

const HOSTILE = [
  "# Q <script>alert(1)</script>",
  "",
  "## Q1. Pick one </pre><b>bold</b>",
  "",
  "A. \"quoted\" & 'single' (권장: keep)",
  "X. Other",
  "",
  "[Answer]:",
  "<img src=x onerror=alert(2)>",
].join("\n");

describe("source viewer", () => {
  test("hostile text arrives escaped: no live tag from the file reaches the page", () => {
    const html = view(HOSTILE);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    // The file's </pre> is text, so the page's own <pre> closes exactly once.
    expect(html.split("</pre>").length).toBe(2);
  });

  test("every byte of the file is on the page, in order", () => {
    const text = [
      "# Requirements Analysis 질문",
      "",
      "> Stage: `requirements-analysis` · **bold** and `code` and ``a`b``",
      "",
      "## Q1. [제품 관리자] 버튼",
      "A. 숨긴다 (권장: 일관됨)",
      "B. 보인다",
      "X. Other (please specify)",
      "",
      "[Answer]: A",
      "",
      "```md",
      "[Answer]: example only",
      "```",
      "<!-- a comment",
      "   spanning lines -->",
      "- a bullet with **two** words\r",
      "",
    ].join("\n");
    expect(shownSource(view(text))).toBe(text);
    expect(shownSource(view(HOSTILE))).toBe(HOSTILE);
  });

  // The parse a browser does, not our own reassembly: line endings are text too, and an
  // HTML parser turns a literal CR into LF (found in review: the first cut dropped every LF
  // from the DOM and a split-and-rejoin test hid it).
  test("the browser's text of the page is the file, line endings included", () => {
    for (const text of [
      "a\nb",
      "a\n",
      "\n\nlead\n\n\ngap\n",
      "crlf\r\n## Q1. x\r\n[Answer]:\r\n",
      "bare\rcr\r",
      HOSTILE,
    ]) {
      expect(domSource(view(text))).toBe(text);
      expect(domSource(view(text, "x/data.json"))).toBe(text);
    }
  });

  test("each line has a numbered anchor", () => {
    const html = view("a\nb\nc");
    for (const n of [1, 2, 3]) expect(html).toContain(`id="L${n}"`);
    expect(html).not.toContain('id="L4"');
  });

  test("blank and answered agree with the questions reader on the fixture's files", () => {
    const root = path.join(FIXTURE, "aidlc");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith("-questions.md")) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = fs.readFileSync(f, "utf-8");
      const qs = parseQuestionsFile(text).questions;
      const html = view(text);
      const blank = qs.filter((q) => !q.answered).length;
      expect(html.match(/class="ol-item blank"/g)?.length ?? 0).toBe(blank);
      expect(html.match(/class="ol-item (blank|answered)"/g)?.length ?? 0).toBe(qs.length);
      expect(html).toContain(strings("ko").viewer.blankCount(blank, qs.length));
    }
  });

  test("an outline item links to its question's line", () => {
    const html = view("intro\n\n## Q1. First\n\n[Answer]:\n\n## Q2. Second\n\n[Answer]: B\n");
    expect(html).toContain('href="#L3"');
    expect(html).toContain('href="#L7"');
    expect(html).toMatch(/class="l k-ans blank"[^>]*id="L5"/);
    expect(html).toMatch(/class="l k-ans filled"[^>]*id="L9"/);
  });

  test("a tag inside a fence is example text, not an answer", () => {
    const html = view("## Q1. One\n\n```\n[Answer]:\n```\n\n[Answer]: A\n");
    expect(html).toMatch(/class="l k-x"[^>]*id="L4"/);
    expect(html.match(/class="ol-item blank"/g)).toBeNull();
  });

  test("a tag's state is the state of the ask that read it, not the heading above", () => {
    // The reader joins the second Q1's tag to the first Q1.
    const q1Blank =
      "## Q1. First\n[Answer]:\n## Q2. Second\n[Answer]: A\n## Q1. Continuation\n[Answer]:";
    expect(lineClass(view(q1Blank), 6)).toBe("l k-ans blank");
    const q1Done =
      "## Q1. First\n[Answer]: A\n## Q2. Second\n[Answer]:\n## Q1. Continuation\n[Answer]:";
    expect(lineClass(view(q1Done), 6)).toBe("l k-ans spent");
    expect(lineClass(view(q1Done), 4)).toBe("l k-ans blank");
  });

  test("a tag no ask read carries no claim", () => {
    // A loose span mixing blank and filled tags is no ask.
    const mixed = "## Q1. One\n[Answer]: A\n\n## Notes\n[Answer]:\n[Answer]: x\n";
    expect(lineClass(view(mixed), 5)).toBe("l k-ans free");
    // A new Plan Approval discards the last one's tags.
    const plans = "## Plan Approval\n[Answer]:\n## Plan Approval\n[Answer]: Approve\n";
    expect(lineClass(view(plans), 2)).toBe("l k-ans free");
    expect(lineClass(view(plans), 4)).toBe("l k-ans filled");
  });

  test("an invalid summary confirmation says invalid, not blank", () => {
    const text = "## Consolidated Summary Confirmation\n[Answer]: yes\n[Answer]: also\n";
    const html = view(text);
    const why = strings("ko").blockers.invalidTags(2);
    expect(lineClass(html, 2)).toBe("l k-ans invalid");
    expect(html).toContain(`data-badge="${why}"`);
    expect(html).toContain(`<span class="ol-why">${why}</span>`);
    expect(html).not.toContain(`data-badge="${strings("ko").viewer.badgeBlank}"`);
  });

  test("anchors are the file's own lines under a bare CR and a heading-less tag", () => {
    const cr = view("intro\r## Q1. Ask\r[Answer]:");
    expect(cr).toContain('href="#L2"');
    expect(cr).toContain('id="L2"');
    expect(parseQuestionsFile("intro\n\n[Answer]:").located[0]?.line).toBe(2);
    expect(view("intro\n\n[Answer]:")).toContain('href="#L3"');
  });

  test("a truncated view states no count: it read only the prefix", () => {
    const text = "## Q1. One\n[Answer]:\n";
    const count = strings("ko").viewer.blankCount(1, 1);
    expect(view(text)).toContain(count);
    expect(view(text, undefined, "ko", true)).not.toContain(count);
  });

  test("code spans are found in linear time on a line of backtick pairs", () => {
    const line = "a`".repeat(40_000);
    const started = performance.now();
    expect(codeSpans(line).length).toBe(20_000);
    view(line);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("a file that is not markdown is a plain numbered listing", () => {
    const text = '{\n  "## not a heading": "[Answer]:"\n}';
    const html = view(text, "construction/x/traceability.json");
    const pre = html.slice(html.indexOf('<pre class="src'), html.indexOf("</pre>"));
    expect(pre).toContain('class="src plain"');
    expect(pre).not.toContain("k-h");
    expect(pre).not.toContain("k-ans");
    expect(html).not.toContain('<nav class="outline"');
    expect(shownSource(html)).toBe(text);
  });

  test("the page needs no script, so the CSP can stay script-free", () => {
    expect(view(HOSTILE)).not.toContain("<script");
    expect(view(HOSTILE, undefined, "en")).toContain(strings("en").viewer.copyPathLabel);
  });
});
