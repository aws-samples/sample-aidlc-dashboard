// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Running as a compiled single executable (`bun build --compile`) versus `bun run` on a
// source tree — src/runtime.ts, and the three places it changes behaviour: where data/
// lives, who opens the browser, and how the command line reads without a launcher.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { parseArgs } from "../cli";
import {
  ENV_DATA_DIR,
  dataDir,
  isCompiled,
  isCompiledModuleUrl,
  workspaceHoldingDir,
} from "../runtime";
import { VERSION } from "../version";

describe("compiled detection", () => {
  test("reads Bun's embedded-filesystem marker on both platforms' URL forms", () => {
    expect(isCompiledModuleUrl("file:///$bunfs/root/aidlc-dashboard")).toBe(true);
    expect(isCompiledModuleUrl("file:///B:/~BUN/root/aidlc-dashboard.exe")).toBe(true);
    expect(isCompiledModuleUrl("file:///B:/%7EBUN/root/aidlc-dashboard.exe")).toBe(true);
    expect(isCompiledModuleUrl("file:///home/user/aidlc-dashboard/src/runtime.ts")).toBe(false);
  });

  test("the test run itself is a source tree", () => {
    expect(isCompiled()).toBe(false);
  });
});

describe("data dir", () => {
  test("source tree: ./data, as the launchers always ran it", () => {
    expect(dataDir({}, false, "/usr/local/bin/bun")).toBe("data");
  });

  test("compiled: beside the executable — never wherever it was started from", () => {
    expect(dataDir({}, true, "/home/user/.aidlc-dashboard/aidlc-dashboard")).toBe(
      path.join("/home/user/.aidlc-dashboard", "data"),
    );
  });

  test("the env override wins either way; blank is ignored", () => {
    expect(dataDir({ [ENV_DATA_DIR]: "/tmp/x" }, true, "/a/b")).toBe("/tmp/x");
    expect(dataDir({ [ENV_DATA_DIR]: "  " }, false, "/a/b")).toBe("data");
  });
});

describe("a data dir inside a workspace", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-rt-d-")));
  const ws = path.join(base, "ws");
  fs.mkdirSync(path.join(ws, "aidlc", "spaces"), { recursive: true });
  const bare = path.join(base, "bare");
  fs.mkdirSync(path.join(bare, "aidlc"), { recursive: true });

  test("a source run started in a workspace: ./data is inside it, created or not", () => {
    expect(workspaceHoldingDir(path.join(ws, "data"))).toBe(ws);
    expect(workspaceHoldingDir(path.join(ws, "deep", "data"))).toBe(ws);
  });

  test("the --root counts even before it holds aidlc/spaces/", () => {
    expect(workspaceHoldingDir(path.join(bare, "data"))).toBeUndefined();
    expect(workspaceHoldingDir(path.join(bare, "data"), bare)).toBe(bare);
  });

  test("a data dir beside the workspace is not in it", () => {
    expect(workspaceHoldingDir(path.join(base, "install", "data"), ws)).toBeUndefined();
  });
});

describe("version", () => {
  test("is package.json's, baked into the build rather than read from beside it", () => {
    expect(VERSION).toBe(packageJson.version);
  });
});

describe("command line without a launcher", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-rt-"));
  fs.mkdirSync(path.join(ws, "aidlc"));

  test("the browser opens by default only in a compiled build", () => {
    expect(parseArgs([], {}, true, ws).open).toBe(true);
    expect(parseArgs([], {}, false, ws).open).toBe(false);
    expect(parseArgs(["--no-open"], {}, true, ws).open).toBe(false);
    expect(parseArgs(["--open"], {}, false, ws).open).toBe(true);
  });

  test("a bare path is the workspace, as `start.sh ~/ws` took it", () => {
    expect(parseArgs([ws], {}, true, ws).root).toBe(ws);
    expect(() => parseArgs([ws, ws], {}, true, ws)).toThrow();
    expect(() => parseArgs(["--bogus"], {}, true, ws)).toThrow();
  });

  test("compiled: the launch dir is where it was started; a launcher's env still wins", () => {
    expect(parseArgs([], {}, true, ws).launchDir).toBe(path.resolve(ws));
    expect(parseArgs([], {}, false, ws).launchDir).toBeUndefined();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-rt-l-"));
    expect(parseArgs([], { AIDLC_DASHBOARD_LAUNCH_DIR: other }, true, ws).launchDir).toBe(
      path.resolve(other),
    );
  });
});
