// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The main checkout of a linked git worktree — the 2.11.4 engine's
// `mainCheckoutOfWorktree` with `gitMetadataDirectory`, `gitCommonDirectory`,
// `boundedGitMetadataText` and `singleGitMetadataLine` (aidlc-locks.ts), transcribed.
//
// 2.11.4 reads a cursor (`aidlc/active-space`, a space's `active-intent`) from the main
// checkout when the worktree has none of its own: both cursors are gitignored, so a
// fresh `git worktree add` never has them, and the worktree would otherwise resolve by
// its registry alone — ambiguous, or another record. The record itself still has to
// exist in the worktree. This reader follows it.
//
// This is the one place WORKSPACE RESOLUTION reads outside the workspace root (the
// owner's call, 2026-11-16) — the Claude token reader reads `~/.claude/projects` too, but
// that is not the workspace: the `.git` file, the worktree's `commondir`, and the main
// checkout's two cursor files. It reads only; no git is run. Each metadata file is read
// as the engine reads it: a regular file (not a link) of at most 8 KiB, one line.

import * as fs from "node:fs";
import * as path from "node:path";

const MAX_METADATA_BYTES = 8192;

/** `boundedGitMetadataText`: a regular file's text, bounded and stable, else null. */
function boundedText(file: string): string | null {
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.size > MAX_METADATA_BYTES) return null;
    const text = fs.readFileSync(file);
    const after = fs.lstatSync(file);
    if (
      text.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      return null;
    }
    return text.toString("utf-8");
  } catch {
    return null;
  }
}

/** `singleGitMetadataLine`: the text as one line, one trailing newline allowed. */
function singleLine(raw: string): string | null {
  const line = raw.replace(/\r?\n$/, "");
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) return null;
  return line;
}

/** The directory `pointer` names, relative to `base`, resolved through links; else null. */
function directoryAt(base: string, pointer: string): string | null {
  const target = path.isAbsolute(pointer) ? pointer : path.resolve(base, pointer);
  try {
    if (!fs.lstatSync(target).isDirectory()) return null;
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** `gitMetadataDirectory`: a `.git` dir, or the dir a `.git` file's `gitdir:` names. */
function gitMetadataDirectory(worktreeDir: string): string | null {
  const marker = path.join(worktreeDir, ".git");
  try {
    const stat = fs.lstatSync(marker);
    if (stat.isDirectory()) return fs.realpathSync(marker);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  const raw = boundedText(marker);
  const line = raw === null ? null : singleLine(raw);
  if (line === null || !line.startsWith("gitdir: ")) return null;
  const pointer = line.slice("gitdir: ".length);
  if (pointer.length === 0 || pointer.includes("\0")) return null;
  return directoryAt(worktreeDir, pointer);
}

/** `gitCommonDirectory`: what `commondir` names, the git dir itself when there is none. */
function gitCommonDirectory(gitDir: string): string | null {
  const marker = path.join(gitDir, "commondir");
  try {
    if (!fs.lstatSync(marker).isFile()) return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? gitDir : null;
  }
  const raw = boundedText(marker);
  const line = raw === null ? null : singleLine(raw);
  if (line === null || line.includes("\0")) return null;
  return directoryAt(gitDir, line);
}

/** `mainCheckoutOfWorktree`: the main checkout's dir when `root` is a linked worktree. */
export function mainCheckoutOfWorktree(root: string): string | null {
  const gitDir = gitMetadataDirectory(root);
  if (gitDir === null) return null;
  const common = gitCommonDirectory(gitDir);
  if (common === null || common === gitDir || path.basename(common) !== ".git") return null;
  return path.dirname(common);
}

/**
 * A cursor file's raw text as 2.11.4 reads it: the worktree's own when it can be read,
 * else the main checkout's at the same path under its root, else undefined. `rel` is
 * relative to the root (`aidlc/active-space`, `aidlc/spaces/<s>/intents/active-intent`).
 */
export function readCursorText(root: string, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, rel), "utf-8");
  } catch {
    // Fall through to the main checkout.
  }
  const main = mainCheckoutOfWorktree(root);
  if (main === null) return undefined;
  try {
    return fs.readFileSync(path.join(main, rel), "utf-8");
  } catch {
    return undefined;
  }
}
