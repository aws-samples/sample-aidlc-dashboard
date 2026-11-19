// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Every copy of the repository address agrees with `package.json`'s — one left behind
// after a move points readers at a repository that is gone. `scripts/set-repo.ts` rewrites
// them; this keeps them rewritten. And the installers download nothing (the security
// review, 2026-11-19): a network fetch with no checksum check is not to come back unnoticed.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO_FILES, repoMentions, rewriteRepo, sourceRepo } from "../../scripts/set-repo";

const ROOT = path.join(import.meta.dir, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "latin1");
const SOURCE = sourceRepo(read("package.json"));

describe("one repository address", () => {
  for (const rel of REPO_FILES) {
    test(`${rel} names only ${SOURCE}`, () => {
      const mentions = repoMentions(read(rel));
      expect(mentions.length).toBeGreaterThan(0);
      expect([...new Set(mentions)]).toEqual([SOURCE]);
    });
  }
});

describe("the installers download nothing", () => {
  for (const rel of ["install.sh", "install.ps1"]) {
    test(`${rel} names no URL and calls no downloader`, () => {
      const text = read(rel);
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(
        /\b(?:curl|wget)\s+-|Invoke-WebRequest|Invoke-RestMethod|\birm\s+\S+\s*\|/,
      );
      expect(text).toContain("AIDLC_ARCHIVE is required");
    });
  }
});

describe("the rewrite", () => {
  test("moves every mention and keeps line endings", () => {
    const text = "a github.com/x/y/releases\r\nb https://github.com/x/y.git\r\n";
    const out = rewriteRepo(text, "x/y", "aws-samples/sample-y");
    expect(repoMentions(out)).toEqual(["aws-samples/sample-y", "aws-samples/sample-y"]);
    expect(out.split("\r\n").length).toBe(3);
  });

  test("refuses a repository.url that is not on github.com", () => {
    expect(() => sourceRepo('{"repository":{"url":"https://example.com/x/y"}}')).toThrow();
    expect(sourceRepo('{"repository":{"url":"https://github.com/x/y.git"}}')).toBe("x/y");
  });
});
