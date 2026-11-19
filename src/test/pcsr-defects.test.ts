// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Regression tests for the defects found while writing the public content security review's
// threat model (D-1 to D-4, and R-8 found while updating it). Each one fed text from the workspace tree — which this reader treats
// as hostile input — into a place that trusted it.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { strings } from "../render/i18n";
import { renderOverview } from "../render/overview";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");

describe("D-1: the unit matrix header escapes everything it puts in its title", () => {
  test("a unit kind or dependency name cannot break out of the title attribute", () => {
    const m = assemble(FIXTURE);
    expect(m.matrix?.units.length).toBeGreaterThan(0);
    const unit = m.matrix!.units[0]!;
    unit.kind = 'x" onmouseover="alert(1)//';
    unit.dependsOn = ['dep"><img src=x onerror=alert(2)>'];
    const html = renderOverview(m, strings("en"));
    expect(html).not.toContain('onmouseover="alert(1)');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("x&quot; onmouseover=&quot;alert(1)//");
  });
});

describe("D-2: the jail checks the extension of the file a link points at, too", () => {
  // Creating a symlink needs a privilege on Windows; the rule is the same there.
  const linkTest = process.platform === "win32" ? test.skip : test;
  linkTest("a .md link to an executable is refused through both readers", async () => {
    const { resolveArtifact, openArtifact } = await import("../scan/open-file");
    const record = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-d2-"));
    try {
      fs.writeFileSync(path.join(record, "payload.exe"), "MZ");
      fs.symlinkSync("payload.exe", path.join(record, "report.md"));
      fs.writeFileSync(path.join(record, "real.md"), "# fine\n");
      fs.symlinkSync("real.md", path.join(record, "alias.md"));
      // /view's reader
      const viewed = resolveArtifact(record, "report.md");
      expect(viewed.ok).toBe(false);
      if (!viewed.ok) expect(viewed.refusal.code).toBe("extension");
      // /open's reader refuses before anything is launched
      const opened = openArtifact(record, "report.md", strings("en"));
      expect(opened.ok).toBe(false);
      // A link to an allowed kind inside the record still resolves.
      expect(resolveArtifact(record, "alias.md").ok).toBe(true);
    } finally {
      fs.rmSync(record, { recursive: true, force: true });
    }
  });
});

describe("D-3: the active-intent cursor cannot move the record outside the intents folder", () => {
  test("a cursor with .. is not followed; a plain or ./ name still is", async () => {
    const { resolveState } = await import("../scan/resolve");
    const top = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-d3-"));
    try {
      const root = path.join(top, "workspace");
      const intents = path.join(root, "aidlc", "spaces", "default", "intents");
      fs.mkdirSync(intents, { recursive: true });
      // A state file outside the workspace, reachable only by climbing out of the intents folder.
      fs.mkdirSync(path.join(top, "elsewhere"), { recursive: true });
      fs.writeFileSync(path.join(top, "elsewhere", "aidlc-state.md"), "# state\n");
      const cursor = path.join(intents, "active-intent");
      fs.writeFileSync(cursor, "../../../../../elsewhere\n");
      expect(resolveState(root).kind).not.toBe("ok");

      fs.mkdirSync(path.join(intents, "260101-demo"), { recursive: true });
      fs.writeFileSync(path.join(intents, "260101-demo", "aidlc-state.md"), "# state\n");
      fs.writeFileSync(path.join(intents, "260101-other"), "not a dir");
      for (const name of ["260101-demo", "./260101-demo"]) {
        fs.writeFileSync(cursor, `${name}\n`);
        expect(resolveState(root)).toEqual({
          kind: "ok",
          rel: "aidlc/spaces/default/intents/260101-demo/aidlc-state.md",
        });
      }
    } finally {
      fs.rmSync(top, { recursive: true, force: true });
    }
  });
});

describe("R-8: a record folder that is a link out of the workspace does not carry the jail with it", () => {
  // Creating a symlink needs a privilege on Windows; the rule is the same there.
  const linkTest = process.platform === "win32" ? test.skip : test;
  linkTest("the jail refuses a record whose real folder is outside the workspace", async () => {
    const { resolveArtifact, openArtifact } = await import("../scan/open-file");
    const { readArtifactSource } = await import("../scan/view-file");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-r8-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-r8-outside-"));
    try {
      const intents = path.join(root, "aidlc", "spaces", "default", "intents");
      fs.mkdirSync(intents, { recursive: true });
      fs.writeFileSync(path.join(outside, "aidlc-state.md"), "# State\n");
      fs.writeFileSync(path.join(outside, "note.md"), "outside the workspace\n");
      const record = path.join(intents, "260101-linked");
      fs.symlinkSync(outside, record);
      // The record root is checked against the workspace root as well as the file against the record.
      expect(resolveArtifact(record, "note.md", root)).toMatchObject({
        ok: false,
        refusal: { code: "symlink-escape" },
        status: 403,
      });
      expect(readArtifactSource(record, "note.md", root)).toMatchObject({ ok: false, status: 403 });
      expect(openArtifact(record, "note.md", strings("en"), root)).toMatchObject({
        ok: false,
        status: 403,
      });
      // A record folder inside the workspace still resolves.
      const inner = path.join(intents, "260102-real");
      fs.mkdirSync(inner);
      fs.writeFileSync(path.join(inner, "note.md"), "inside\n");
      expect(resolveArtifact(inner, "note.md", root)).toMatchObject({ ok: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  linkTest("/view and /open refuse it for the selected workspace", async () => {
    const { handle } = await import("../server");
    const { parseArgs } = await import("../cli");
    const opts = parseArgs(["--root", FIXTURE, "--lang", "en"]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-r8-srv-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-r8-srv-out-"));
    try {
      const intents = path.join(root, "aidlc", "spaces", "default", "intents");
      fs.mkdirSync(intents, { recursive: true });
      fs.writeFileSync(path.join(outside, "aidlc-state.md"), "# State\n");
      fs.writeFileSync(path.join(outside, "note.md"), "outside the workspace\n");
      fs.symlinkSync(outside, path.join(intents, "260101-linked"));
      await handle(new Request(`http://127.0.0.1/select?dir=${encodeURIComponent(root)}`), opts);
      expect((await handle(new Request("http://127.0.0.1/view?rel=note.md"), opts)).status).toBe(
        403,
      );
      expect((await handle(new Request("http://127.0.0.1/open?rel=note.md"), opts)).status).toBe(
        403,
      );
    } finally {
      await handle(new Request(`http://127.0.0.1/select?dir=${encodeURIComponent(FIXTURE)}`), opts);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
