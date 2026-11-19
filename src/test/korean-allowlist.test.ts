// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The repository is written in English. Korean appears only where the product needs it: the
// Korean page locale, the patterns that match records and kiro-cli output written in Korean, and
// the tests and test data that exercise those. Every file that may hold Hangul is named below with
// its reason, so a Korean comment or message added anywhere else fails here, and an entry whose
// file no longer holds any Hangul fails too, so the list cannot go stale.
//
// The walk reads the directories directly rather than asking git (as license-headers.test.ts
// does), skipping what .gitignore and .git/info/exclude keep out of the repository.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");
const HANGUL = /[가-힣]/;

/** Top-level names that are not part of the repository (gitignored or excluded). */
const SKIP_TOP = new Set([
  ".git",
  ".claude",
  ".kiro",
  ".worktrees",
  "node_modules",
  "__backup",
  "data",
  "dist",
  "AGENTS.md",
  "CLAUDE.md",
  "MIGRATION.md",
]);
const SKIP_ANY = new Set(["node_modules", "__backup", ".git"]);

/** Exact files, or a prefix ending in "/" for a whole tree, each with why it holds Korean. */
const ALLOW: Record<string, string> = {
  // The product's Korean.
  "src/render/i18n-ko.ts": "the Korean page locale",
  "src/render/i18n-en.ts": "the language switcher names Korean in Korean",
  // Matching data: AI-DLC records and kiro-cli output are written in Korean too.
  "src/scan/deferrals.ts": "matches Korean 'none' and 'next cycle' in deferral ledgers",
  "src/scan/declared-open-questions.ts": "matches Korean 'none' and table headers",
  "src/scan/memory-diary.ts": "matches Korean 'none', 'resolved' and follow-up phrasings",
  "src/render/source-view.ts": "matches the Korean 'recommended' marker in a record",
  "src/credit/parser/usage-parser.ts": "matches kiro-cli's Korean /usage labels",
  "src/credit/parser/fixtures/normal-ko.txt": "kiro-cli /usage output in Korean",
  "src/credit/parser/fixtures/zero-credits.txt": "kiro-cli /usage output in Korean",
  "fixtures/reference/": "a synthetic AI-DLC record written in Korean, as real runs are",
  // Tests of the Korean locale, of Korean record input, or that the English page holds no Hangul.
  "src/render/i18n.test.ts": "checks both locales and that English holds no Hangul",
  "src/render/warnings.test.ts": "expected Korean warning text",
  "src/test/agents.test.ts": "asserts the English page holds no Hangul",
  "src/test/cards.test.ts": "expected Korean card text",
  "src/test/customer-names.test.ts": "a Korean name in the audit's name list format",
  "src/test/decisions.test.ts": "Korean decision text from a record",
  "src/test/journey.test.ts": "expected Korean journey text",
  "src/test/kpi.test.ts": "asserts the English page holds no Hangul",
  "src/test/model.test.ts": "expected Korean page text and Korean record input",
  "src/test/notify.test.ts": "Korean question headings and expected Korean status",
  "src/test/page-script.test.ts": "expected Korean page text",
  "src/test/picker.test.ts": "expected Korean picker text",
  "src/test/position.test.ts": "expected Korean run line text",
  "src/test/resolve.test.ts": "expected Korean picker and body text",
  "src/test/scan.test.ts": "Korean record input the readers must parse",
  "src/test/server.test.ts": "expected Korean page text",
  "src/test/status.test.ts": "expected Korean status text, and English holds no Hangul",
  "src/test/time-summary.test.ts": "expected Korean summary text",
  "src/test/view-page.test.ts": "a Korean questions file shown as source",
  "src/test/workspace-menu.test.ts": "asserts the English page holds no Hangul",
  "src/test/korean-allowlist.test.ts": "the Hangul pattern this test checks for",
};

/** The credit subsystem's tests that keep Korean on purpose. */
const CREDIT_TESTS: Record<string, string> = {
  "src/credit/claude/transcript-reader.test.ts":
    "a measured Korean path in projectSlug data, and multi-byte padding across chunk boundaries",
  "src/credit/claude/token-view.test.ts": "asserts the Korean locale's token panel text",
  "src/credit/view/credit-view.test.ts": "asserts the Korean locale's credit panel text",
  "src/credit/view/svg-chart.test.ts": "asserts the Korean locale's chart text",
  "src/credit/collector/acp-collector.test.ts": "a Korean payload split across chunk boundaries",
};

const LIST = { ...ALLOW, ...CREDIT_TESTS };

function walk(dir: string, rel: string, top: boolean): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if ((top && SKIP_TOP.has(e.name)) || SKIP_ANY.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(abs, r, false));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function holdsHangul(rel: string): boolean {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  if (buf.includes(0)) return false; // binary
  return HANGUL.test(buf.toString("utf-8"));
}

const allowed = (rel: string) =>
  Object.keys(LIST).some((k) => (k.endsWith("/") ? rel.startsWith(k) : rel === k));

const files = walk(ROOT, "", true);
const withHangul = files.filter(holdsHangul);

describe("Korean only where the product needs it", () => {
  test("the walk found the tree", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  test("no file outside the list holds Hangul", () => {
    expect(withHangul.filter((f) => !allowed(f))).toEqual([]);
  });

  test("every listed entry still holds Hangul", () => {
    const stale = Object.keys(LIST).filter((k) =>
      k.endsWith("/") ? !withHangul.some((f) => f.startsWith(k)) : !withHangul.includes(k),
    );
    expect(stale).toEqual([]);
  });
});
