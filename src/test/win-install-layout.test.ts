// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Where install.ps1 puts things on Windows (2026-11-17, the owner's call): the executable in
// %LOCALAPPDATA%\Programs\aidlc-dashboard with that folder on the user Path — no `.cmd`
// shim in %USERPROFILE%\.local\bin, the Unix layout it had — and an install in the old place
// moved over. The script only runs on Windows (and under pwsh on macOS by hand, how it was
// exercised), so these checks read its text; each pins a rule a later edit could quietly undo.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ps1 = fs
  .readFileSync(path.join(import.meta.dir, "..", "..", "install.ps1"), "latin1")
  .replace(/\r\n/g, "\n");
const code = ps1
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

describe("install.ps1 — the Windows layout", () => {
  test("installs under %LOCALAPPDATA%\\Programs, AIDLC_DIR still first", () => {
    expect(code).toContain("$dir = if ($env:AIDLC_DIR) {");
    expect(code).toContain("Join-Path $env:LOCALAPPDATA 'Programs/aidlc-dashboard'");
  });

  test("puts the install folder itself on the user Path, and writes no shim", () => {
    expect(code).toContain("$wrote = Add-UserPath $dir");
    expect(code).not.toContain("exit /b %ERRORLEVEL%");
    expect(code).not.toMatch(/WriteAllText\(\$bin/);
    // AIDLC_BIN_DIR / AIDLC_NO_BIN are install.sh's: the Windows script does not read them.
    expect(code).not.toMatch(/\$env:AIDLC_(BIN_DIR|NO_BIN)/);
  });

  test("moves the old layout only when AIDLC_DIR does not name a place", () => {
    expect(code).toMatch(/\$migrate = \(-not \$env:AIDLC_DIR\) -and/);
    expect(code).toContain("$legacyDir = Join-Path $HOME '.aidlc-dashboard'");
  });

  test("the old .local\\bin Path entry goes only when that folder is left empty", () => {
    const at = code.indexOf("Remove-UserPath $legacyBin");
    const guard = code.lastIndexOf("if ($binLeft) {", at);
    expect(at).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(code.slice(guard, at)).toContain("} else {");
  });

  test("a running copy stops the install before anything moves", () => {
    const check = code.indexOf("Get-Process -Name 'aidlc-dashboard'");
    const firstMove = code.indexOf("Move-Item -LiteralPath $dir -Destination $old");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(firstMove);
  });
});

describe("install.ps1 — a failure is one line", () => {
  // Seen on Windows PowerShell 5.1 (2026-11-17): `Die` threw a bare string, and the refusal
  // came with the whole error record under it (`At line:96 char:28 … CategoryInfo …
  // FullyQualifiedErrorId`). `exit` is not the way out — under `irm | iex` it would close the
  // user's own window — so Die throws a TAGGED exception and the top level catches exactly
  // that: one red line, the window stays, and $LASTEXITCODE says it failed.
  test("Die throws a tagged exception, not a bare string", () => {
    expect(code).toMatch(
      /function Die\(\[string\]\$m\) \{[^\n]*\.Data\['aidlc\.die'\] = \$true; throw \$e \}/,
    );
    expect(code).not.toContain('function Die([string]$m) { throw "');
  });

  test("the top level catches only that tag, prints one red line, and rethrows anything else", () => {
    expect(code).toMatch(/\} catch \{\n\s+if \(\$_\.Exception\.Data\['aidlc\.die'\]\) \{/);
    expect(code).toContain("Write-Host $_.Exception.Message -ForegroundColor Red");
    expect(code).toMatch(/\$global:LASTEXITCODE = 1\n\s+\} else \{\n\s+throw\n/);
  });

  test("a finished install leaves $LASTEXITCODE at 0", () => {
    expect(code).toMatch(/\$global:LASTEXITCODE = 0\n\} catch \{/);
  });
});
