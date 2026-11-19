// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The audit ledger as the 2.11.4 engine reads it: turns a HOST_TURN takes back, turns
// sent while another engine question was open, engine questions that ask without a
// row of their own (QUESTION_ASKED), one clone's record split across files (a
// conflict copy, a claimed team unit's local record).

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AuditEvent, type AuditLedger, parseAuditShard, readAuditLedger } from "../scan/audit";
import { buildTiming, classifyGaps } from "../scan/timing";

/** One shard's text from `[ts, event, fields]` rows, in the engine's block format. */
function shard(rows: [string, string, Record<string, string>?][]): string {
  return `# AI-DLC Audit Log\n\n${rows
    .map(
      ([ts, event, fields = {}]) =>
        `## ${event}\n**Timestamp**: ${ts}\n**Event**: ${event}\n${Object.entries(fields)
          .map(([k, v]) => `**${k}**: ${v}`)
          .join("\n")}\n`,
    )
    .join("\n---\n\n")}\n---\n`;
}

const ev = (
  ts: string,
  event: string,
  fields: Record<string, string> = {},
  shardName = "s",
): AuditEvent => ({ ts, event, fields, shard: shardName });

function withDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-ledger-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("a HUMAN_TURN a later HOST_TURN takes back is no turn (withdrawnTurnPositions)", () => {
  const text = shard([
    ["2026-01-01T00:00:00Z", "HOST_TURN", { "Message Id": "m2" }],
    ["2026-01-01T00:01:00Z", "HUMAN_TURN", { "Message Id": "m1" }],
    ["2026-01-01T00:02:00Z", "HUMAN_TURN", { "Message Id": "m2" }],
    ["2026-01-01T00:03:00Z", "HUMAN_TURN", { "Message Id": "m3" }],
    ["2026-01-01T00:04:00Z", "HOST_TURN", { "Message Id": "m1" }],
  ]);

  test("only a turn BEFORE the HOST_TURN naming it is withdrawn", () => {
    const turns = parseAuditShard(text, "s.md").filter((e) => e.event === "HUMAN_TURN");
    // m1 is taken back by the later HOST_TURN; m2's HOST_TURN came first, so m2 stands.
    expect(turns.map((e) => e.fields["Message Id"])).toEqual(["m2", "m3"]);
  });

  test("positions are the file's own, never renumbered", () => {
    const rows = parseAuditShard(text, "s.md");
    expect(rows.map((e) => e.pos)).toEqual([0, 2, 3, 4]);
  });

  test("a withdrawn turn closes no wait; the HOST_TURN keeps the ask open", () => {
    const rows = parseAuditShard(
      shard([
        ["2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", { Stage: "rv" }],
        ["2026-01-01T01:00:00Z", "HUMAN_TURN", { "Message Id": "m1" }],
        ["2026-01-01T01:00:05Z", "HOST_TURN", { "Message Id": "m1" }],
        ["2026-01-01T02:00:05Z", "GATE_APPROVED", { Stage: "rv" }],
      ]),
      "s.md",
    );
    const g = classifyGaps(rows);
    // Read as the person's turn, the first hour was the wait. Withdrawn, it was not their
    // turn: the ask stays open across the host's prompt and its last gap is the wait.
    expect(g.humanWaitSec).toBe(3600);
    expect(g.unknownSec).toBe(3605);
  });
});

describe("a turn sent while another engine question was open is not a reply (isReplyTurn)", () => {
  test("it closes no wait", () => {
    const ask = ev("2026-01-01T00:00:00Z", "DECISION_RECORDED", { Stage: "rv" });
    const plain = classifyGaps([ask, ev("2026-01-01T01:00:00Z", "HUMAN_TURN")]);
    expect(plain.humanWaitSec).toBe(3600);
    const other = classifyGaps([
      ask,
      ev("2026-01-01T01:00:00Z", "HUMAN_TURN", { "Open Question": "intent-pick" }),
    ]);
    expect(other.humanWaitSec).toBe(0);
  });
});

describe("QUESTION_ASKED opens a wait (a dashboard reading)", () => {
  const asked = (fields: Record<string, string>) =>
    ev("2026-01-01T00:00:00Z", "QUESTION_ASKED", { "Question Id": "q1", ...fields });

  test("answered by a reply turn of the same clone", () => {
    const g = classifyGaps([
      asked({ "Question Type": "construction-staffing", Stage: "units-generation" }),
      ev("2026-01-01T00:00:02Z", "ARTIFACT_CREATED"),
      ev("2026-01-01T00:30:02Z", "HUMAN_TURN"),
    ]);
    expect(g.humanWaitSec).toBe(1800);
  });

  test("answered by the receipt the engine's question ledger closes it with", () => {
    const plan = { "Question Type": "plan-approval", Stage: "code-generation", Unit: "u1" };
    const wait = (answer: AuditEvent) => classifyGaps([asked(plan), answer]).humanWaitSec;
    const at = "2026-01-01T00:20:00Z";
    expect(wait(ev(at, "PLAN_APPROVAL_RECORDED", { Stage: "code-generation", Unit: "u1" }))).toBe(
      1200,
    );
    expect(wait(ev(at, "PLAN_APPROVAL_SKIPPED", { Stage: "code-generation" }))).toBe(1200);
    expect(wait(ev(at, "PLAN_APPROVAL_OVERRIDDEN", { Stage: "code-generation" }))).toBe(1200);
    expect(
      wait(ev(at, "GATE_APPROVED", { Checkpoint: "Code Generation Plan Approval", Unit: "u1" })),
    ).toBe(1200);
    // Another stage's, another unit's checkpoint, another kind's receipt: no answer.
    expect(wait(ev(at, "PLAN_APPROVAL_RECORDED", { Stage: "functional-design" }))).toBe(0);
    expect(
      wait(ev(at, "GATE_APPROVED", { Checkpoint: "Code Generation Plan Approval", Unit: "u2" })),
    ).toBe(0);
    expect(wait(ev(at, "SYSTEM_INSTALL_ALLOWED"))).toBe(0);
    // An engine ask is answered by the routed request; a system install by its go-ahead.
    expect(
      classifyGaps([asked({ "Question Type": "scope-confirm" }), ev(at, "REQUEST_ROUTED")])
        .humanWaitSec,
    ).toBe(1200);
    expect(
      classifyGaps([asked({ "Question Type": "system-install" }), ev(at, "SYSTEM_INSTALL_ALLOWED")])
        .humanWaitSec,
    ).toBe(1200);
  });

  test("a turn naming this question as the one on screen answers it", () => {
    // The hook writes `Open Question: <ask type>` when the engine question was on screen:
    // that turn answers it, and is kept from the questions beneath (isReplyTurn).
    const wait = (turn: Record<string, string>) =>
      classifyGaps([
        asked({ "Question Type": "scope-confirm" }),
        ev("2026-01-01T00:30:00Z", "HUMAN_TURN", turn),
      ]).humanWaitSec;
    expect(wait({ "Open Question": "scope-confirm" })).toBe(1800);
    expect(wait({ "Open Question": "repo-scope" })).toBe(0);
    expect(wait({ "Open Question": "scope-confirm", Reply: "command" })).toBe(0);
    // A gate beneath an open engine question is not answered by that turn.
    expect(
      classifyGaps([
        ev("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", { Stage: "rv" }),
        ev("2026-01-01T00:30:00Z", "HUMAN_TURN", { "Open Question": "scope-confirm" }),
      ]).humanWaitSec,
    ).toBe(0);
  });

  test("QUESTION_SHOWN between keeps it open", () => {
    const g = classifyGaps([
      asked({ "Question Type": "scope-confirm" }),
      ev("2026-01-01T00:01:00Z", "QUESTION_SHOWN", { "Question Id": "q1" }),
      ev("2026-01-01T00:31:00Z", "HUMAN_TURN"),
    ]);
    expect(g.humanWaitSec).toBe(1800);
  });

  test("the SYSTEM_INSTALL_BLOCKED written beside a system-install ask keeps it open", () => {
    const g = classifyGaps([
      asked({ "Question Type": "system-install" }),
      ev("2026-01-01T00:00:01Z", "SYSTEM_INSTALL_BLOCKED"),
      ev("2026-01-01T00:20:01Z", "SYSTEM_INSTALL_ALLOWED"),
    ]);
    expect(g.humanWaitSec).toBe(1200);
  });
});

describe("one clone's record split across files is one clone", () => {
  test("a conflict copy's own rows pair with the original's (copyGroups)", () => {
    // The copy holds the continuation: the ask is in both, the answer only in the copy.
    // Read as two clones, the answer is another developer's and the wait disappears.
    const base: [string, string, Record<string, string>?][] = [
      ["2026-01-01T00:00:00Z", "WORKFLOW_STARTED"],
      ["2026-01-01T00:01:00Z", "DECISION_RECORDED", { Stage: "rv" }],
    ];
    withDir((dir) => {
      fs.mkdirSync(path.join(dir, "audit"));
      fs.writeFileSync(path.join(dir, "audit", "host-aabbccdd1122.md"), shard(base));
      fs.writeFileSync(
        path.join(dir, "audit", "host-aabbccdd1122 2.md"),
        shard([...base, ["2026-01-01T00:31:00Z", "HUMAN_TURN"]]),
      );
      const ledger = readAuditLedger(dir);
      expect(ledger.copyGroups?.length).toBe(1);
      const t = buildTiming(ledger, "2026-01-01T00:31:00Z");
      expect(t.total.humanWaitSec).toBe(1800);
      expect(t.workers.length).toBe(1);
      expect(t.clones).toBe(1);
    });
  });
});

describe("timing reads a copy group as one clone but reduces unit rows per file", () => {
  test("a pause in the copy and a completion in the original, same second: the pause wins", () => {
    // The engine reduces one candidate per FILE and ranks PAUSED over COMPLETED across
    // files (`currentUnitLifecycleRows`); the clone key must not merge the two files first.
    const fd = { Stage: "functional-design", Unit: "u1", "Run floor": "F" };
    const base: [string, string, Record<string, string>?][] = [
      ["2026-01-01T00:00:00Z", "WORKFLOW_STARTED"],
      ["2026-01-01T00:01:00Z", "UNIT_STARTED", fd],
    ];
    withDir((dir) => {
      fs.mkdirSync(path.join(dir, "audit"));
      fs.writeFileSync(
        path.join(dir, "audit", "host-aabbccdd1122.md"),
        shard([...base, ["2026-01-01T00:10:00Z", "UNIT_COMPLETED", fd]]),
      );
      fs.writeFileSync(
        path.join(dir, "audit", "host-aabbccdd1122 2.md"),
        shard([...base, ["2026-01-01T00:10:00Z", "UNIT_PAUSED", fd]]),
      );
      const ledger = readAuditLedger(dir);
      expect(ledger.copyGroups?.length).toBe(1);
      const t = buildTiming(ledger, "2026-01-01T00:20:00Z");
      const kinds = t.units.flatMap((u) => u.segments.map((g) => g.endKind));
      expect(kinds).not.toContain("completed");
      expect(t.clones).toBe(1);
    });
  });

  test("a unit segment classifies its gaps on the clone, so a wait answered in the copy stays a wait", () => {
    // Only the lifecycle reduction is per file. The answer to the gate is in the copy; the
    // segment was started in the original. Read per file, the segment lost the answer.
    const fd = { Stage: "functional-design", Unit: "u1", "Run floor": "F" };
    const base: [string, string, Record<string, string>?][] = [
      ["2026-01-01T00:00:00Z", "WORKFLOW_STARTED"],
      ["2026-01-01T00:05:00Z", "UNIT_STARTED", fd],
      [
        "2026-01-01T00:10:00Z",
        "STAGE_AWAITING_APPROVAL",
        { Stage: "functional-design", Unit: "u1" },
      ],
    ];
    withDir((dir) => {
      fs.mkdirSync(path.join(dir, "audit"));
      fs.writeFileSync(
        path.join(dir, "audit", "host-aabbccdd1122.md"),
        shard([...base, ["2026-01-01T00:50:00Z", "UNIT_COMPLETED", fd]]),
      );
      fs.writeFileSync(
        path.join(dir, "audit", "host-aabbccdd1122 2.md"),
        shard([...base, ["2026-01-01T00:40:00Z", "HUMAN_TURN"]]),
      );
      const ledger = readAuditLedger(dir);
      expect(ledger.copyGroups?.length).toBe(1);
      const t = buildTiming(ledger, "2026-01-01T00:50:00Z");
      expect(t.total.humanWaitSec).toBe(1800);
      const [u] = t.units;
      expect(u?.segments.map((g) => g.endKind)).toEqual(["completed"]);
      expect(u?.humanWaitSec).toBe(1800);
    });
  });
});

describe("a claimed team unit's local record is read with the tracked shards (auditShards)", () => {
  const name = "host-aabbccdd1122.md";
  const pinned: [string, string, Record<string, string>?] = [
    "2026-01-01T00:01:00Z",
    "UNIT_STARTED",
    { Stage: "code-generation", Unit: "u1", "Run floor": "x" },
  ];
  const tracked = shard([
    ["2026-01-01T00:00:00Z", "WORKFLOW_STARTED"],
    pinned,
    ["2026-01-01T01:00:00Z", "UNIT_MERGED", { Unit: "u1" }],
  ]);
  const local = shard([
    pinned,
    [
      "2026-01-01T00:02:00Z",
      "ARTIFACT_CREATED",
      { Context: "construction > u1 > code-generation > x.md" },
    ],
    [
      "2026-01-01T00:50:00Z",
      "UNIT_COMPLETED",
      { Stage: "code-generation", Unit: "u1", "Run floor": "x" },
    ],
  ]);

  function ledgerOf(dir: string): AuditLedger {
    fs.mkdirSync(path.join(dir, "audit"));
    fs.mkdirSync(path.join(dir, ".aidlc-engine", "audit"), { recursive: true });
    fs.writeFileSync(path.join(dir, "audit", name), tracked);
    fs.writeFileSync(path.join(dir, ".aidlc-engine", "audit", name), local);
    return readAuditLedger(dir);
  }

  test("every row is read, a row both hold once — from the local record", () => {
    withDir((dir) => {
      const ledger = ledgerOf(dir);
      expect(ledger.events.map((e) => e.event)).toEqual([
        "WORKFLOW_STARTED",
        "UNIT_STARTED",
        "ARTIFACT_CREATED",
        "UNIT_COMPLETED",
        "UNIT_MERGED",
      ]);
      const started = ledger.events.find((e) => e.event === "UNIT_STARTED")!;
      expect(started.shard).toBe(`.aidlc-engine/audit/${name}`);
      // Two files are two shards to the receipt reader (the engine's shard is the path),
      // and one clone to every reader that asks who did it.
      expect(new Set(ledger.events.map((e) => e.shardIndex)).size).toBe(2);
      expect(ledger.copyGroups).toEqual([[name, `.aidlc-engine/audit/${name}`]]);
      const t = buildTiming(ledger, "2026-01-01T01:00:00Z");
      expect(t.workers.length).toBe(1);
      expect(t.clones).toBe(1);
    });
  });

  test("a link in the chain to the local record refuses it, as the tracked dir is refused", () => {
    withDir((dir) => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-ledger-x-"));
      try {
        fs.mkdirSync(path.join(dir, "audit"));
        fs.writeFileSync(path.join(dir, "audit", name), tracked);
        fs.mkdirSync(path.join(elsewhere, "audit"));
        fs.writeFileSync(path.join(elsewhere, "audit", name), local);
        fs.symlinkSync(elsewhere, path.join(dir, ".aidlc-engine"));
        const ledger = readAuditLedger(dir);
        expect(ledger.refused).toEqual([path.join(".aidlc-engine", "audit")]);
        expect(ledger.events.map((e) => e.event)).not.toContain("UNIT_COMPLETED");
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });

  test("the local record never joins a copy group by its first block", () => {
    withDir((dir) => {
      // Two tracked shards that start alike, and a local record of one of them that
      // starts alike too: the local record is no sync tool's copy.
      fs.mkdirSync(path.join(dir, "audit"));
      fs.mkdirSync(path.join(dir, ".aidlc-engine", "audit"), { recursive: true });
      const head: [string, string, Record<string, string>?] = [
        "2026-01-01T00:00:00Z",
        "WORKFLOW_STARTED",
      ];
      fs.writeFileSync(path.join(dir, "audit", "zz-112233445566.md"), shard([head]));
      fs.writeFileSync(
        path.join(dir, ".aidlc-engine", "audit", name),
        shard([head, ["2026-01-01T00:05:00Z", "HUMAN_TURN"]]),
      );
      const ledger = readAuditLedger(dir);
      expect(ledger.events.filter((e) => e.event === "WORKFLOW_STARTED").length).toBe(2);
    });
  });
});
