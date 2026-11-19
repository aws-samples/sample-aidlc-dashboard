// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The PowerShell scripts must be pure ASCII, and their non-ASCII marks (▸ ✗ — → ⚠) must survive that.
//
// Windows PowerShell 5.1 decoded them wrong. `irm | iex` hands `iex` the body of the
// release asset, which GitHub serves as `application/octet-stream` with no charset, and
// 5.1 decodes such a response as ISO-8859-1 — so every UTF-8 message beyond ASCII printed as
// mojibake (seen on a real Windows machine, 2026-10-16). The launcher `start.ps1`, read
// from disk, fell to the ANSI code page the same way; it is gone since the release became
// a single executable (1.13), and `install.ps1` is the one script left. A BOM would fix a
// disk read but not the `irm` path, where the BOM itself becomes three Latin-1 characters
// in front of the first token. ASCII is the one form both readers agree on, so any character
// beyond ASCII is written as `\uXXXX` and decoded at run time by a helper `T` ([regex]::Unescape).
//
// Two details are load-bearing and easy to undo by hand. A backslash meant literally is
// `\\` (Unescape eats a lone one: `data\ ` became `data `). And inside `"...$(T '...')..."`
// the parentheses are escaped too: PowerShell finds the end of `$( )` in an expandable
// string by counting parentheses even within quotes, so `$(T 'x (')$_)` passed `$_` to
// `T` and dropped it from every download-failure message (reproduced under pwsh 7.6).

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");
const SCRIPTS = ["install.ps1"] as const;

/** `[regex]::Unescape` for the subset `T` arguments use: `\uXXXX` and `\\`. */
function regexUnescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|\\)/g, (_, e: string) =>
    e === "\\" ? "\\" : String.fromCharCode(Number.parseInt(e.slice(1), 16)),
  );
}

/** Every argument of `T '...'`, with `''` restored to `'`. */
function tArgs(body: string): { arg: string; inSubexpr: boolean }[] {
  const out: { arg: string; inSubexpr: boolean }[] = [];
  const re = /(\$?)\(T '((?:[^']|'')*)'\)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    out.push({ arg: (m[2] ?? "").replace(/''/g, "'"), inSubexpr: m[1] === "$" });
  }
  return out;
}

describe("PowerShell scripts stay ASCII (Windows PowerShell 5.1 decodes them as Latin-1 or ANSI)", () => {
  for (const name of SCRIPTS) {
    const bytes = fs.readFileSync(path.join(ROOT, name));
    const body = bytes.toString("latin1");

    test(`${name} has no byte above 0x7F`, () => {
      const at = bytes.findIndex((b) => b > 0x7f);
      expect(at === -1 ? "ascii" : `byte 0x${bytes[at]?.toString(16)} at ${at}`).toBe("ascii");
    });

    test(`${name} defines T before its first use`, () => {
      const lines = body.split(/\r?\n/);
      const def = lines.indexOf("function T([string]$s) { [regex]::Unescape($s) }");
      // The header comment names `$(T '...')` too; only code counts as a use.
      const use = lines.findIndex((l) => !l.trimStart().startsWith("#") && /\$?\(T '/.test(l));
      expect(def).toBeGreaterThan(-1);
      expect(use).toBeGreaterThan(def);
    });

    test(`${name}: every T argument decodes cleanly, to English text and its marks`, () => {
      const args = tArgs(body);
      expect(args.length).toBeGreaterThan(5);
      for (const { arg } of args) {
        // Only \uXXXX and \\ — anything else is a backslash Unescape would eat.
        expect(arg.replace(/\\(u[0-9a-fA-F]{4}|\\)/g, "")).not.toContain("\\");
      }
      const decoded = args.map((a) => regexUnescape(a.arg)).join("\n");
      // The messages are English; the escapes carry only the marks, dashes and arrows.
      expect(decoded).toMatch(/[▸✗—]/);
      expect(decoded).not.toMatch(/[\uAC00-\uD7A3]/);
    });

    test(`${name}: no parenthesis inside a $(T '...') in an expandable string`, () => {
      for (const { arg, inSubexpr } of tArgs(body)) {
        if (inSubexpr) expect(arg).not.toMatch(/[()]/);
      }
    });
  }

  test("the decoder above is [regex]::Unescape's reading of the subset", () => {
    expect(regexUnescape("\\u25b8 Installed: data\\\\ \\u0028x\\u0029")).toBe(
      "▸ Installed: data\\ (x)",
    );
  });
});

describe("every installer setting is documented", () => {
  // A knob the installers read but the README does not name is one nobody can find —
  // `AIDLC_BIN_DIR` sat in both scripts undocumented until `AIDLC_NO_PATH` was added.
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf-8");
  for (const name of ["install.ps1", "install.sh"]) {
    test(name, () => {
      const body = fs.readFileSync(path.join(ROOT, name), "latin1");
      const vars = [...new Set(body.match(/AIDLC_[A-Z_]+/g) ?? [])].sort();
      expect(vars.length).toBeGreaterThan(3);
      expect(vars.filter((v) => !readme.includes(`\`${v}`))).toEqual([]);
    });
  }
});
