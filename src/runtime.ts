// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// How this process was started: `bun run` on a source tree, or a single executable built
// with `bun build --compile` (the release since 2026-11 — no bun on the user's machine).
//
// The two differ in exactly the places a source tree used to be relied on:
//
//   - WHERE `data/` LIVES. The launchers `cd` into the install dir before `bun run`, so
//     `./data` was the install's own `data/`. A binary is run from wherever the user is,
//     so cwd-relative would scatter a `data/` into every folder it was started from —
//     measured: a spike run from /tmp wrote /tmp/data/usage.db. A compiled build keeps
//     it beside the executable instead, which is the same `<install>/data/` an existing
//     install already has, so an upgrade finds its history where it left it.
//   - WHO OPENS THE BROWSER. The launchers did; a binary has no launcher (see cli.ts).
//
// Detection reads ONE deterministic marker: a compiled binary serves its modules from
// Bun's embedded filesystem, whose URLs carry `$bunfs` (POSIX) or `~BUN` (Windows) —
// the marker AI-DLC's own runtime uses. Its second heuristic (an executable whose name
// does not start with "bun") is left out: a renamed or wrapped bun would trip it.

import * as path from "node:path";
import { isWorkspaceDir, workspaceKey } from "./scan/browse";

/** Env override for the data dir — tests and unusual installs; absent means the default. */
export const ENV_DATA_DIR = "AIDLC_DASHBOARD_DATA_DIR";

export function isCompiledModuleUrl(url: string): boolean {
  return /\/(?:\$bunfs|%7ebun|~bun)\//i.test(url.replace(/\\/g, "/"));
}

/** True when this module was loaded from a `bun build --compile` executable. */
export function isCompiled(moduleUrl: string = import.meta.url): boolean {
  return isCompiledModuleUrl(moduleUrl);
}

/**
 * The directory `usage.db` lives in: the env override, else `<executable dir>/data` for a
 * compiled build, else `./data` (the source tree, which the launchers run from).
 */
export function dataDir(
  env: Record<string, string | undefined> = process.env,
  compiled: boolean = isCompiled(),
  execPath: string = process.execPath,
): string {
  const override = env[ENV_DATA_DIR]?.trim();
  if (override) return override;
  return compiled ? path.join(path.dirname(execPath), "data") : "data";
}

/**
 * The workspace `dir` sits in, if any: `root` (the `--root` given) when `dir` is at or under
 * it, else the nearest of `dir` and its ancestors holding `aidlc/spaces/` — the picker's
 * workspace predicate. The server asks it of the data dir before the credit store opens,
 * because the dashboard never writes to a workspace and `./data` is wherever a source run
 * was started (the security review, 2026-11-19). Warned, not refused: the history is the
 * operator's own file, and a refusal would stop the dashboard over where they put it.
 */
export function workspaceHoldingDir(
  dir: string,
  root?: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const rootKey = root === undefined ? undefined : workspaceKey(root, platform);
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (workspaceKey(cur, platform) === rootKey || isWorkspaceDir(cur)) return cur;
    if (path.dirname(cur) === cur) return undefined;
  }
}
