// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The engine's ERROR_LOGGED rows, read for what they can honestly say.
//
// THE CONTRACT (2.11.4 `audit-format.md`, Error/Recovery Events): required Timestamp,
// Tool, Command, Error; optional Source, Exit Code, Observed By, Error Fingerprint.
// Two writers. `aidlc-lib.ts emitError` runs on every tool's non-zero exit and writes
// Tool/Command/Error only, Command being `<tool> <argv>` — best-effort (a failed audit
// write is swallowed, and nothing is written with no workflow selected), so the count is
// a FLOOR. The stop hook (`aidlc-continue-workflow.ts`) writes `Source: error-directive`
// with Command `next (stop-hook probe)` or `retained Copilot directive` — NO tool prefix —
// when it first delivers a distinct engine error directive, and then blocks the stop:
// it keeps the turn going so the agent handles the problem. A repeat of the same
// fingerprint lets the stop through with no new row, so the row is a delivery, not a
// standing state.
//
// WHAT THE ROWS DO NOT CARRY, and what follows from it:
//
//   - No Stage, Unit or Context — 0 of 560 rows on this machine (2026-11-15). So the
//     stage is INFERRED from the same clone's previous stage-bearing row and always
//     labelled so. Never from the merged ledger: another clone's STAGE_STARTED a second
//     earlier is another developer's work. A Context-derived stage may stand in for that
//     activity; it may NOT stand in for a completion — "its stage later completed" reads
//     only a STAGE_COMPLETED that names the stage in its own `Stage` field.
//   - No closing event. Nothing records that an error was fixed. So the reading never
//     says "unresolved", "fixed" or even "moved on" — a later HUMAN_TURN proves a later
//     record, not that the failed work went anywhere. It says what is observed: the same
//     clone wrote other records after it, or nothing but errors. Measured: 84% of errors
//     sit in a stage the same clone later completed, 47% are the engine refusing the
//     agent's own call, and the agent retries within a median 13s.
//
// "THE SAME CLONE" IS A COPY GROUP, not a file. A conflict copy of a shard is read once
// (`copiedAuditBlocks`): shared rows stay in one file and the copy keeps only what it
// alone holds — often the continuation. So rows from the shard's copy group count as
// that clone's later records (by time, since positions do not compare across files).
//
// WHAT WARNS. One shape: a clone that wrote nothing but errors after its latest error,
// on a run not finished, while no other clone has written anything since. A terminal
// error on a clone that finished its share long ago, while another clone carries on, is
// not evidence about the run now — muted, as a UI priority, never as "resolved". The
// hook's directive does not warn on its own (it kept the turn going); its delivery is
// still said. Nothing here is a wait: errors never reach the hero card, the waits count
// or the tab title, because the next move after an engine error is the agent's.
//
// `--help` CALLS ARE NOT ERRORS. Since the engine's `asksForHelp` (#2449) a help request
// prints usage and exits 0; older engines logged it as a failure. Only the unambiguous
// shapes are dropped — `<tool> --help|-h|help` and `<tool> <sub> --help|-h` — and counted
// apart. A bare `help` after a subcommand can be an argument (`aidlc-knowledge show help`
// names a document), so it is kept.

import type { AuditEvent } from "../scan/audit";

export interface ErrorGroup {
  /** `Tool` as written. */
  tool: string;
  /** The subcommand, when Command is `<tool> <sub> …` (the hook's Command is not). */
  sub?: string;
  /** The latest row's Command as written, for the tooltip. */
  command: string;
  /** `Error` as written (the engine escapes line breaks as a literal `\n`). */
  message: string;
  /** Rows in this group: one clone, one tool, one subcommand, one message. */
  count: number;
  firstTs: string;
  lastTs: string;
  /** The file that holds the latest row. */
  shard: string;
  /** INFERRED from the clone's previous stage-bearing row before the LATEST error. */
  stage?: string;
  unit?: string;
  /** What the same clone recorded after the latest error. */
  next: "followed" | "errors-only";
  /** The same clone later recorded STAGE_COMPLETED naming the inferred stage. */
  stageClosedAfter: boolean;
  source: "tool-exit" | "error-directive";
  tone: "warn" | "mute";
  /** `audit/<shard>` when the source viewer can show the whole shard. */
  viewRel?: string;
}

export interface ErrorReading {
  /** Warned groups first, then newest first. */
  groups: ErrorGroup[];
  /** Rows counted — a floor, since the writer is best-effort. */
  total: number;
  /** `--help` rows an older engine logged, left out of `total`. */
  helpDropped: number;
  /** Any group warns — opens the diagnostics fold. */
  warn: boolean;
}

export interface ErrorOptions {
  /** A finished run: every error is history, none warns. */
  complete: boolean;
  /** Whether the source viewer can show this shard whole. */
  viewable?: (shard: string) => boolean;
  /** `AuditLedger.copyGroups`: files that are one clone's record. */
  copyGroups?: string[][];
}

const HELP = new Set(["--help", "-h", "help"]);
const HELP_FLAG = new Set(["--help", "-h"]);

/** The tool's arguments, when Command is the emitError shape `<tool> <argv>`. */
function argsOf(tool: string, command: string): string[] | undefined {
  const tokens = command.trim().split(/\s+/);
  return tokens[0] === tool ? tokens.slice(1) : undefined;
}

function isHelpCall(args: string[] | undefined): boolean {
  if (!args) return false;
  return HELP.has(args[0] ?? "") || HELP_FLAG.has(args[1] ?? "");
}

/** Rows grouped by file, each in append order. */
function byShard(events: AuditEvent[]): Map<string, AuditEvent[]> {
  const out = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const list = out.get(e.shard) ?? [];
    list.push(e);
    out.set(e.shard, list);
  }
  // The merged ledger is sorted by time; a file's own order is its block position.
  for (const list of out.values()) {
    if (list.every((e) => e.pos !== undefined)) list.sort((a, b) => a.pos! - b.pos!);
  }
  return out;
}

export function readErrors(events: AuditEvent[], o: ErrorOptions): ErrorReading {
  let helpDropped = 0;
  let total = 0;
  const files = byShard(events);
  const clone = new Map<string, string[]>();
  for (const g of o.copyGroups ?? []) for (const s of g) clone.set(s, g);
  const lastTsOf = new Map<string, string>();
  for (const [shard, rows] of files) {
    lastTsOf.set(
      shard,
      rows.reduce((m, e) => (e.ts > m ? e.ts : m), ""),
    );
  }

  type Raw = Omit<ErrorGroup, "tone" | "viewRel">;
  const groups = new Map<string, Raw>();
  for (const [shard, rows] of files) {
    const siblings = (clone.get(shard) ?? [shard]).filter((s) => s !== shard);
    let stage: string | undefined;
    let unit: string | undefined;
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i]!;
      if (e.event !== "ERROR_LOGGED") {
        if (e.stage) {
          stage = e.stage;
          unit = e.unit;
        }
        continue;
      }
      const command = e.fields.Command ?? "";
      const tool = e.fields.Tool ?? "";
      const args = argsOf(tool, command);
      if (isHelpCall(args)) {
        helpDropped++;
        continue;
      }
      total++;
      const sub = args?.[0] || undefined;
      const message = e.fields.Error ?? "";
      const source = e.fields.Source === "error-directive" ? "error-directive" : "tool-exit";
      // Later records of the same clone: this file after the row, and its copies' rows
      // after it in time.
      const later = [
        ...rows.slice(i + 1),
        ...siblings.flatMap((s) => (files.get(s) ?? []).filter((x) => x.ts > e.ts)),
      ];
      const next = later.some((x) => x.event !== "ERROR_LOGGED") ? "followed" : "errors-only";
      const stageClosedAfter =
        stage !== undefined &&
        later.some((x) => x.event === "STAGE_COMPLETED" && x.fields.Stage === stage);
      const key = JSON.stringify([
        siblings.length > 0 ? [shard, ...siblings].sort() : shard,
        tool,
        sub ?? "",
        message,
        source,
      ]);
      const prev = groups.get(key);
      const newer = !prev || e.ts >= prev.lastTs;
      // The group speaks for its LATEST row: that is the one whose aftermath matters.
      groups.set(key, {
        tool,
        sub: newer ? sub : prev.sub,
        command: newer ? command : prev.command,
        message,
        count: (prev?.count ?? 0) + 1,
        firstTs: prev && prev.firstTs < e.ts ? prev.firstTs : e.ts,
        lastTs: newer ? e.ts : prev.lastTs,
        shard: newer ? shard : prev.shard,
        stage: newer ? stage : prev.stage,
        unit: newer ? unit : prev.unit,
        next: newer ? next : prev.next,
        stageClosedAfter: newer ? stageClosedAfter : prev.stageClosedAfter,
        source,
      });
    }
  }

  const list: ErrorGroup[] = [...groups.values()].map((g) => {
    const mine = new Set(clone.get(g.shard) ?? [g.shard]);
    const othersSince = [...lastTsOf].some(([s, ts]) => !mine.has(s) && ts > g.lastTs);
    const warn = !o.complete && g.next === "errors-only" && !othersSince;
    return {
      ...g,
      tone: warn ? "warn" : "mute",
      viewRel: o.viewable?.(g.shard) ? `audit/${g.shard}` : undefined,
    };
  });
  list.sort((a, b) =>
    a.tone !== b.tone ? (a.tone === "warn" ? -1 : 1) : b.lastTs.localeCompare(a.lastTs),
  );
  return { groups: list, total, helpDropped, warn: list.some((g) => g.tone === "warn") };
}
