// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The minimum Bun a SOURCE run accepts, pinned to ONE number.
//
// Since 1.13 the release is a single executable per platform with Bun inside it
// (scripts/package.ts), and the start scripts that needed bun are gone. The floor guards
// `bun run src/server.ts` from a checkout — `package.json`'s `engines.bun` is that number,
// and the server reads it at run time (`src/version.ts`) — and, since 2026-11-19, the
// build `install.sh` runs from the clone, because the executable embeds the Bun that
// built it. That check imports the server's comparator rather than copying the number.
// This file keeps the manifest, the server and the README's one mention of it agreed,
// and keeps the installers from installing bun.
//
// What this does NOT prove is that the floor still runs the code. 1.4.0 was measured
// (the full suite passes on it, 2026-10-14), but typecheck runs against the PINNED types
// (`@types/bun` is an exact version, matching the dev's Bun), so a later-only API would
// pass every gate here. The checks below keep every devDependency an exact version (the
// lock file is not the only pin, 2026-11-17) and keep the runtime floor from claiming a
// Bun newer than the types the code is checked against.
//
// The comparator is RUN over one table, not pattern-matched: a check that compares
// strings would pass `1.10.0 < 1.4.0`.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUN_FLOOR, belowFloor } from "../version";

const ROOT = path.join(import.meta.dir, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const manifest = JSON.parse(read("package.json")) as {
  engines?: { bun?: string };
  devDependencies?: Record<string, string>;
};

const floorOf = (range: string | undefined): string => {
  const m = /^>=(\d+\.\d+\.\d+)$/.exec(range ?? "");
  if (!m?.[1]) throw new Error(`not a plain ">=X.Y.Z" floor: ${String(range)}`);
  return m[1];
};

const FLOOR = floorOf(manifest.engines?.bun);

describe("one Bun floor, for source runs", () => {
  test("every devDependency is an exact version", () => {
    const loose = Object.entries(manifest.devDependencies ?? {}).filter(
      ([, v]) => !/^\d+\.\d+\.\d+$/.test(v),
    );
    expect(loose).toEqual([]);
  });

  test("engines.bun is not newer than the pinned @types/bun", () => {
    const types = manifest.devDependencies?.["@types/bun"] ?? "";
    expect(belowFloor(types, FLOOR)).toBe(false);
  });

  test("the server reads the same floor", () => {
    expect(BUN_FLOOR).toBe(FLOOR);
  });

  test("the Bun running this suite is not below it", () => {
    expect(belowFloor(Bun.version, FLOOR)).toBe(false);
  });

  test("README states the same floor wherever it names one — once, for the source run", () => {
    const named = [...read("README.md").matchAll(/Bun (\d+\.\d+\.\d+) or (?:later|newer)/gi)].map(
      (m) => m[1],
    );
    expect(named).toEqual([FLOOR]);
  });
});

describe("the installers never install bun", () => {
  for (const rel of ["install.sh", "install.ps1"]) {
    test(`${rel} installs no bun and keeps no copy of the floor`, () => {
      const text = read(rel);
      expect(text).not.toMatch(/bun\.sh\/install|brew install bun|npm (?:i|install) (?:-g )?bun/);
      expect(text).not.toMatch(/MIN_BUN|\$minBun|AIDLC_NO_BUN/);
      expect(text).not.toContain(FLOOR);
    });
  }
  test("install.sh checks the floor with the server's own comparator", () => {
    const text = read("install.sh");
    expect(text).toContain('import { BUN_FLOOR, belowFloor } from "./src/version.ts"');
  });
  test("no start script is left to need it", () => {
    for (const rel of ["start.sh", "start.cmd", "start.ps1"]) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(false);
    }
  });
});

/** [floor, version, below] — `undefined` is "not a version", never "too old". */
const CASES: [floor: string, version: string, below: boolean | undefined][] = [
  ["1.4.0", "1.4.0", false],
  ["1.4.0", "1.4.3", false],
  ["1.4.0", "2.0.0", false],
  ["1.4.0", "v1.4.0", false],
  ["1.4.0", "1.3.14", true],
  ["1.4.0", "0.9.99", true],
  // Numeric, not lexical: "1.10.0" sorts before "1.4.0" as a string.
  ["1.4.0", "1.10.0", false],
  ["1.10.0", "1.9.9", true],
  // A canary of a later release reads as that release; one of the floor itself is
  // below it, as semver orders a prerelease. Build metadata does not order.
  ["1.4.0", "1.4.3-canary.1+abc123", false],
  ["1.4.0", "1.3.99-canary.7", true],
  ["1.4.0", "1.4.0-canary.1", true],
  ["1.4.0", "1.4.0+abc123", false],
  ["1.4.0", "", undefined],
  ["1.4.0", "garbage", undefined],
  ["1.4.0", "1.4", undefined],
  ["1.4.0", "bun 1.4.3", undefined],
];

describe("the server's comparator on one table", () => {
  for (const [floor, version, below] of CASES) {
    test(`floor ${floor}, bun ${JSON.stringify(version)} → ${String(below)}`, () => {
      expect(belowFloor(version, floor)).toBe(below);
    });
  }
});
