// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Locate the active intent's aidlc-state.md inside the AI-DLC workspace layout.
// Each intent owns its own record dir and state file:
//
//   aidlc/spaces/<space>/intents/<YYMMDD>-<label>/aidlc-state.md   (2.9+)
//   aidlc/spaces/<space>/intents/<slug>-<id8>/aidlc-state.md       (earlier)
//
// and which one is "active" is decided by two cursors, not by globbing — a
// workspace can hold several intents at once, so a glob would pick an arbitrary
// (possibly wrong) workflow. The resolution rule here is a transcript of the
// engine's `activeIntent` fallback (2.11 aidlc-lib.ts `activeIntent` /
// `readActiveIntentCursor` / `listIntentDirs` / `recordDirMatches`,
// aidlc-runtime-paths.ts `knownActiveSpace`).
//
// THAT IS THE FALLBACK, NOT EVERY SELECTION. The engine's `resolveWorkflowSelection`
// first honours a delegated worktree, an explicit selector and the conversation's own
// session binding (which can name another space, or `intent: null` with no fallback).
// A workspace root does not say which conversation is asking, so this reader shows
// the intent a conversation with none of those would get — the workspace's cursor
// and records. Two conversations bound to different intents cannot both be shown
// from a root alone. The rules:
//
//   1. The space is the `aidlc/active-space` cursor only when it is a valid space
//      name (`^[a-z][a-z0-9-]*$`) naming a real `spaces/<name>/` dir; anything else
//      is `default`. A cursor holding `../x` or a typo used to send the reader to a
//      space that does not exist and report no run.
//   2. An `active-intent` cursor naming a record that has a state file wins — even an
//      archived one (the engine's `next` then reads `Status: Archived` and says how to
//      unarchive; that explanation is the engine's, not this reader's).
//   3. Otherwise ARCHIVED records never resolve implicitly. A space whose only record
//      was archived has no active intent, and archived records do not make the live
//      one ambiguous. This is the common case, not an edge: the cursor is gitignored,
//      so a fresh clone never has one, and a reader that skipped this rule put the
//      retired record on screen as the run. A record `intents.json` does not list has
//      no status, so it stays live work.
//   4. One live record wins; several → `ambiguous`. With none, `archived` (and how many
//      were set aside) when archived records exist, else `none` — a distinction this
//      reader adds: `activeIntent` returns null for both, and `intent list` is where the
//      engine itself says "N archived".
//
// Node fs only — no vscode import — so it stays unit-testable headless. Never throws.

import * as fs from "node:fs";
import * as path from "node:path";
import { readRegistryRows } from "./intent-registry";
import { readCursorText } from "./main-checkout";

const ACTIVE_SPACE_POINTER = "active-space";
export const ACTIVE_INTENT_POINTER = "active-intent";
const DEFAULT_SPACE = "default";
const STATE_FILE = "aidlc-state.md";
/** The engine's `SPACE_NAME_REGEX`. */
const SPACE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Why no single intent resolves. Three different sentences, because they ask for three
 * different actions: `none` — no record at all; `ambiguous` — several live records and
 * no cursor (pick one); `archived` — only archived records (start new work, or point
 * the cursor at an archived one to read it).
 */
export type NoRunKind = "none" | "ambiguous" | "archived";

export type ResolveResult =
  | { kind: "ok"; rel: string } // POSIX rel path under the root to aidlc-state.md
  | { kind: "ambiguous" }
  | { kind: "none" }
  | { kind: "archived"; count: number };

/** Watcher patterns (POSIX rel) whose change can flip the active intent. */
export const ACTIVE_SPACE_GLOB = `aidlc/${ACTIVE_SPACE_POINTER}`;
export const ACTIVE_INTENT_GLOB = `aidlc/spaces/*/intents/${ACTIVE_INTENT_POINTER}`;

/** A cursor's trimmed text: the worktree's own, else a linked worktree's main checkout's. */
function readCursor(rootFs: string, rel: string): string {
  return (readCursorText(rootFs, rel) ?? "").trim();
}

/**
 * `activeSpace` → `knownActiveSpace`: the cursor when it names a valid space that exists
 * in THIS checkout; else default. A linked worktree with no cursor of its own reads the
 * main checkout's (scan/main-checkout.ts).
 */
export function activeSpace(rootFs: string): string {
  const name = readCursor(rootFs, path.posix.join("aidlc", ACTIVE_SPACE_POINTER));
  if (!SPACE_NAME_RE.test(name)) return DEFAULT_SPACE;
  try {
    return fs.statSync(path.join(rootFs, "aidlc", "spaces", name)).isDirectory()
      ? name
      : DEFAULT_SPACE;
  } catch {
    return DEFAULT_SPACE;
  }
}

function hasState(recordDir: string): boolean {
  try {
    return fs.existsSync(path.join(recordDir, STATE_FILE));
  } catch {
    return false;
  }
}

/** Record dir names (those holding an aidlc-state.md) in an intents dir, sorted. */
function listIntentDirs(intentsDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(intentsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => hasState(path.join(intentsDir, name))).sort();
}

/** The fields of an `intents.json` row this reader uses — as written, types unchecked. */
export interface RegistryRow {
  uuid?: unknown;
  slug: string;
  dirName?: unknown;
  status?: unknown;
  scope?: unknown;
}

/** `intents.json`'s rows with a string slug — the engine's `readIntentRegistry` (scan/intent-registry.ts). */
export function readIntentRegistry(intentsDir: string): RegistryRow[] {
  return readRegistryRows(intentsDir).filter(
    (r): r is RegistryRow =>
      !!r && typeof r === "object" && typeof (r as RegistryRow).slug === "string",
  );
}

/**
 * `recordDirMatches`: a stored `dirName` matches exactly; a row written before the
 * date-prefixed names (no `dirName`) matches `<slug>-<hex>` where the hex is the tail
 * of the uuid's own hex digits.
 */
export function recordDirMatches(
  entry: { slug: string; uuid?: unknown; dirName?: unknown },
  dirName: string,
): boolean {
  if (entry.dirName) return entry.dirName === dirName;
  if (!dirName.startsWith(`${entry.slug}-`)) return false;
  const suffix = dirName.slice(entry.slug.length + 1);
  // Wrong-typed fields are compared as they are, never coerced to "absent": the engine
  // short-circuits on the hex test first, and a numeric uuid must not throw here.
  return (
    /^[0-9a-f]+$/.test(suffix) &&
    typeof entry.uuid === "string" &&
    entry.uuid.replace(/-/g, "").slice(-suffix.length) === suffix
  );
}

/** `isArchivedIntent`: the status, trimmed and lowercased, is `archived`. */
function isArchived(row: RegistryRow | undefined): boolean {
  return typeof row?.status === "string" && row.status.trim().toLowerCase() === "archived";
}

/** Resolve the active intent's state file under `rootFs` — see the header. */
export function resolveState(rootFs: string): ResolveResult {
  const space = activeSpace(rootFs);
  const intentsDir = path.join(rootFs, "aidlc", "spaces", space, "intents");

  const rel = (record: string): string => `aidlc/spaces/${space}/intents/${record}/${STATE_FILE}`;

  const cursor = readCursor(
    rootFs,
    path.posix.join("aidlc", "spaces", space, "intents", ACTIVE_INTENT_POINTER),
  );
  // The cursor is followed only when it names a record directly inside the intents folder
  // (`<dir>` or `./<dir>`). The engine joins it unchecked, so `..` would reach a state file
  // anywhere — and the record root is also the root of the /open and /view jail. Refusing that
  // is this reader's hardening, not the engine's rule; a refused cursor falls through to the
  // registry and the directory listing, as an unreadable one does.
  const target = cursor.length > 0 ? path.resolve(intentsDir, cursor) : "";
  if (target && path.dirname(target) === path.resolve(intentsDir) && hasState(target)) {
    return { kind: "ok", rel: rel(path.basename(target)) };
  }

  const registry = readIntentRegistry(intentsDir);
  const all = listIntentDirs(intentsDir);
  const live = all.filter((dir) => !isArchived(registry.find((r) => recordDirMatches(r, dir))));
  if (live.length === 1) return { kind: "ok", rel: rel(live[0] ?? "") };
  if (live.length > 1) return { kind: "ambiguous" };
  return all.length > 0 ? { kind: "archived", count: all.length } : { kind: "none" };
}
