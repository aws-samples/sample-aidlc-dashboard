// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// README's command blocks are pasted, not read (the owner's call, 2026-11-19): install is
// "paste the block, then type aidlc-dashboard". So no block may hold a placeholder the
// reader has to fill in (`<version>`, `<this repository's clone URL>`), and no shell block
// may carry a trailing `# comment` — macOS's default zsh has `interactive_comments` off,
// so `aidlc-dashboard   # folder picker` pastes as three extra arguments.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const README = fs.readFileSync(path.join(import.meta.dir, "..", "..", "README.md"), "utf-8");

/** Every fenced block of the given languages, with the line it starts on. */
function blocks(langs: readonly string[]): { lang: string; line: number; body: string }[] {
  const out: { lang: string; line: number; body: string }[] = [];
  const lines = README.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\w+)\s*$/.exec(lines[i] ?? "");
    if (!open?.[1] || !langs.includes(open[1])) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end] !== "```") end++;
    out.push({ lang: open[1], line: start + 1, body: lines.slice(start, end).join("\n") });
    i = end;
  }
  return out;
}

const COMMAND_BLOCKS = blocks(["bash", "sh", "powershell"]);

describe("README command blocks paste as they are", () => {
  test("there are command blocks to check", () => {
    expect(COMMAND_BLOCKS.length).toBeGreaterThan(0);
  });
  for (const b of COMMAND_BLOCKS) {
    test(`${b.lang} block at line ${b.line} holds no placeholder`, () => {
      expect(b.body).not.toMatch(/<[^<>\n]+>/);
    });
    if (b.lang !== "powershell") {
      test(`${b.lang} block at line ${b.line} holds no # comment`, () => {
        for (const line of b.body.split("\n")) expect(line).not.toMatch(/(^|\s)#/);
      });
    }
  }
  test("the install block ends by putting the launcher on this terminal's PATH", () => {
    const install = COMMAND_BLOCKS.find(
      (b) => b.body.includes("install.sh") && b.body.includes("git clone"),
    );
    expect(install?.body.trim().split("\n").at(-1)).toBe('export PATH="$HOME/.local/bin:$PATH"');
  });
});
