// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// `--help` is an answer, not an error: the usage text goes to stdout and the exit code is 0.
// It went to stderr, and Windows PowerShell 5.1 turns a native command's stderr line into a
// terminating NativeCommandError once stderr is redirected under `$ErrorActionPreference =
// 'Stop'` — so install.ps1's smoke check (`& $exe --help *> $null`) stopped the install on
// a working executable (seen on a real Windows Server 2025 box, 2026-11-17). A usage ERROR
// still goes to stderr with exit 2.
//
// Spawns the bun running this test on the server's own entry point; with `--help` or a bad
// flag the entry point exits before it binds, reads or spawns anything.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const SERVER = path.join(import.meta.dir, "..", "server.ts");
const run = (...args: string[]) => {
  const r = Bun.spawnSync([process.execPath, SERVER, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

describe("the usage text", () => {
  test("--help prints it to stdout, nothing to stderr, and exits 0", () => {
    const r = run("--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage:");
    expect(r.err).toBe("");
  });

  test("a usage error still goes to stderr with exit 2", () => {
    const r = run("--port", "0");
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage:");
    expect(r.out).toBe("");
  });
});
