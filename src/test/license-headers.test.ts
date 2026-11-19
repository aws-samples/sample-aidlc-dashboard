// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The licence is MIT-0 under Amazon's copyright, and every source file says so in its
// first lines — the aws-samples publishing checklist asks for both, and a header is the
// kind of thing a new file silently goes without. The walk reads the directories
// directly rather than asking git, so a fresh copy without `.git` is checked the same.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");
const COPYRIGHT = "Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.";
const SPDX = "SPDX-License-Identifier: MIT-0";
const SOURCE = /\.(ts|sh|ps1)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else if (SOURCE.test(e.name)) out.push(abs);
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, "src")),
  ...walk(path.join(ROOT, "scripts")),
  path.join(ROOT, "install.sh"),
  path.join(ROOT, "install.ps1"),
];

describe("licence", () => {
  test("LICENSE is MIT-0 under Amazon's copyright", () => {
    const text = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf-8");
    expect(text.startsWith("MIT No Attribution\n")).toBe(true);
    expect(text).toContain(COPYRIGHT);
  });

  test("package.json declares the same licence", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(pkg.license).toBe("MIT-0");
  });
});

describe("every source file carries the header in its first lines", () => {
  test("the walk found the tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  const missing = files.filter((f) => {
    const head = fs.readFileSync(f, "utf-8").split(/\r?\n/).slice(0, 4).join("\n");
    return !head.includes(COPYRIGHT) || !head.includes(SPDX);
  });
  test("none without it", () => {
    expect(missing.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
