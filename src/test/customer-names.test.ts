// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The leak audit's customer names come from a list the person keeps outside every
// repository, one name per line. A missing list is a blind pass that says so; a list
// that exists and cannot be read is not the same as no list, and must not read as one.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { customerNames, customerNamesFile, customerPattern } from "../../scripts/leak-patterns";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "customer-names-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("customer names list", () => {
  test("lives under ~/.config, not under any one machine's work trees", () => {
    expect(customerNamesFile("/h")).toBe(
      path.join("/h", ".config", "aidlc-dashboard", "customer-names"),
    );
  });

  test("a missing file is a blind pass, not a failure", () => {
    const src = customerNames(path.join(tmp, "absent"));
    expect(src.state).toBe("missing");
    expect(src.names).toEqual([]);
  });

  test("one name per line; comments, blanks, case and repeats are dropped", () => {
    const file = path.join(tmp, "names");
    fs.writeFileSync(
      file,
      "# header\nAcme Widgets\r\n\n  globex  # trailing note\nacme widgets\n이니테크\n",
    );
    const src = customerNames(file);
    expect(src.state).toBe("read");
    expect(src.names).toEqual(["acme widgets", "globex", "이니테크"]);
  });

  test("a path that exists and cannot be read is unreadable, never missing", () => {
    const dir = path.join(tmp, "a-dir");
    fs.mkdirSync(dir);
    const src = customerNames(dir);
    expect(src.state).toBe("unreadable");
    expect(src.error).toBe("EISDIR");
  });

  test("a name matches whole, in any case, beside Korean text", () => {
    const { pattern } = customerPattern("globex");
    expect(pattern.test("Globex 프로젝트")).toBe(true);
    expect(pattern.test("globex-web")).toBe(true);
    expect(pattern.test("globexian")).toBe(false);
    expect(customerPattern("a.b").pattern.test("axb")).toBe(false);
  });
});
