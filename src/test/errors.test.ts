// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The ERROR_LOGGED reading (model/errors.ts) and its Run Health tab. An engine error
// carries no Stage, Unit or Context field, and nothing in the ledger ever closes one,
// so the reading says only what the clone that logged it recorded next — and never puts
// an error among the things waiting on the reader.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { readErrors } from "../model/errors";
import type { DashboardModel } from "../model/types";
import { renderDiagnostics } from "../render/cards";
import { esc } from "../render/common";
import { strings } from "../render/i18n";
import { renderBanner, renderRunHealth } from "../render/status";
import { type AuditEvent, readAuditLedger } from "../scan/audit";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);
const ko = strings("ko");
const en = strings("en");

const A = "a-aaaaaaaaaaaa.md";
const B = "b-bbbbbbbbbbbb.md";

let pos = 0;
/** A parsed-shape row: a direct `Stage` field when `stage` is given, as the engine writes it. */
function ev(ts: string, event: string, shard = A, stage?: string, unit?: string): AuditEvent {
  const fields: Record<string, string> = stage ? { Stage: stage } : {};
  return { ts, event, shard, pos: pos++, shardIndex: 0, stage, unit, fields };
}
function err(
  ts: string,
  command: string,
  message: string,
  shard = A,
  extra: Record<string, string> = {},
  tool = command.split(" ")[0] ?? "",
): AuditEvent {
  return {
    ts,
    event: "ERROR_LOGGED",
    shard,
    pos: pos++,
    shardIndex: 0,
    fields: { Tool: tool, Command: command, Error: message, ...extra },
  };
}
const DIRECTIVE = {
  Source: "error-directive",
  "Exit Code": "0",
  "Observed By": "aidlc-continue-workflow",
  "Error Fingerprint": "f".repeat(64),
};

describe("errors — reading", () => {
  test("no ERROR_LOGGED row reads as none", () => {
    const r = readErrors([ev("2026-01-01T00:00:00Z", "STAGE_STARTED", A, "s1")], {
      complete: false,
    });
    expect(r).toEqual({ groups: [], total: 0, helpDropped: 0, warn: false });
  });

  test("repeats collapse to one group per clone, tool, subcommand and message", () => {
    const r = readErrors(
      [
        ev("2026-01-01T00:00:00Z", "STAGE_STARTED", A, "requirements"),
        err(
          "2026-01-01T00:01:00Z",
          "aidlc-log answer --stage requirements",
          "Refused: no blank tag",
        ),
        err(
          "2026-01-01T00:01:10Z",
          "aidlc-log answer --stage requirements",
          "Refused: no blank tag",
        ),
        err("2026-01-01T00:02:00Z", "aidlc-log answer --stage requirements", "Refused: other"),
        err("2026-01-01T00:03:00Z", "aidlc-state approve", "Refused: no blank tag"),
        ev("2026-01-01T00:04:00Z", "HUMAN_TURN"),
      ],
      { complete: false },
    );
    expect(r.total).toBe(4);
    expect(r.groups.map((g) => [g.tool, g.sub, g.message, g.count])).toEqual([
      ["aidlc-state", "approve", "Refused: no blank tag", 1],
      ["aidlc-log", "answer", "Refused: other", 1],
      ["aidlc-log", "answer", "Refused: no blank tag", 2],
    ]);
    const twice = r.groups[2]!;
    expect([twice.firstTs, twice.lastTs]).toEqual(["2026-01-01T00:01:00Z", "2026-01-01T00:01:10Z"]);
  });

  test("only unambiguous help calls an older engine logged are dropped, and counted apart", () => {
    const r = readErrors(
      [
        err("2026-01-01T00:01:00Z", "aidlc-log answer --help", "usage: ..."),
        err("2026-01-01T00:01:01Z", "aidlc-state -h", "usage: ..."),
        err("2026-01-01T00:01:02Z", "aidlc-state help", "usage: ..."),
        // `help` after a subcommand can be an argument: this one names a document.
        err("2026-01-01T00:01:03Z", "aidlc-knowledge show help", "no document 'help'"),
        err("2026-01-01T00:02:00Z", "aidlc-state approve", "Refused"),
        ev("2026-01-01T00:03:00Z", "HUMAN_TURN"),
      ],
      { complete: false },
    );
    expect(r.helpDropped).toBe(3);
    expect(r.total).toBe(2);
    expect(r.groups.map((g) => `${g.tool} ${g.sub}`).sort()).toEqual([
      "aidlc-knowledge show",
      "aidlc-state approve",
    ]);
  });

  test("the stop hook's Command has no tool prefix and gives no subcommand", () => {
    const r = readErrors(
      [
        err(
          "2026-01-01T00:01:00Z",
          "next (stop-hook probe)",
          "stopped on a problem",
          A,
          DIRECTIVE,
          "aidlc-orchestrate",
        ),
        err(
          "2026-01-01T00:02:00Z",
          "retained Copilot directive",
          "other problem",
          A,
          DIRECTIVE,
          "aidlc-orchestrate",
        ),
        ev("2026-01-01T00:03:00Z", "HUMAN_TURN"),
      ],
      { complete: false },
    );
    expect(r.groups.map((g) => [g.tool, g.sub, g.command])).toEqual([
      ["aidlc-orchestrate", undefined, "retained Copilot directive"],
      ["aidlc-orchestrate", undefined, "next (stop-hook probe)"],
    ]);
  });

  test("the stage is inferred from the same clone only — another clone's start never claims it", () => {
    const r = readErrors(
      [
        ev("2026-01-01T00:00:00Z", "STAGE_STARTED", A, "functional-design", "u1"),
        ev("2026-01-01T00:00:30Z", "STAGE_STARTED", B, "requirements"),
        err("2026-01-01T00:01:00Z", "aidlc-state unit", "Refused", A),
        ev("2026-01-01T00:02:00Z", "HUMAN_TURN", A),
      ],
      { complete: false },
    );
    expect(r.groups[0]?.stage).toBe("functional-design");
    expect(r.groups[0]?.unit).toBe("u1");
    expect(r.groups[0]?.shard).toBe(A);
  });

  test("an error before any stage-bearing row has no stage", () => {
    const r = readErrors(
      [
        err("2026-01-01T00:01:00Z", "aidlc-state engine", "x"),
        ev("2026-01-01T00:02:00Z", "HUMAN_TURN"),
      ],
      { complete: false },
    );
    expect(r.groups[0]?.stage).toBeUndefined();
  });

  test("what came next is observed per clone: later records, or only errors — which warns", () => {
    const r = readErrors(
      [
        err("2026-01-01T00:01:00Z", "aidlc-log review", "first", A),
        ev("2026-01-01T00:02:00Z", "HUMAN_TURN", A),
        err("2026-01-01T00:03:00Z", "aidlc-log decision", "last", A),
        err("2026-01-01T00:03:05Z", "aidlc-log decision", "after-last", A),
      ],
      { complete: false },
    );
    const by = (m: string) => r.groups.find((g) => g.message === m)!;
    expect(by("first").next).toBe("followed");
    expect(by("first").tone).toBe("mute");
    expect(by("last").next).toBe("errors-only");
    expect(by("after-last").next).toBe("errors-only");
    expect(by("after-last").tone).toBe("warn");
    expect(r.warn).toBe(true);
  });

  test("a clone that ended on an error while another carried on stays muted", () => {
    const r = readErrors(
      [
        err("2026-01-01T00:01:00Z", "aidlc-log decision", "old tail", A),
        ev("2026-01-01T00:04:00Z", "HUMAN_TURN", B),
      ],
      { complete: false },
    );
    expect(r.groups[0]?.next).toBe("errors-only");
    expect(r.groups[0]?.tone).toBe("mute");
    expect(r.warn).toBe(false);
  });

  test("'its stage later completed' needs the clone's own STAGE_COMPLETED naming the stage", () => {
    const r = readErrors(
      [
        ev("2026-01-01T00:00:00Z", "STAGE_STARTED", A, "requirements"),
        err("2026-01-01T00:01:00Z", "aidlc-log answer", "done-later", A),
        ev("2026-01-01T00:02:00Z", "STAGE_COMPLETED", A, "requirements"),
        ev("2026-01-01T00:03:00Z", "STAGE_STARTED", A, "domain-design"),
        err("2026-01-01T00:04:00Z", "aidlc-log answer", "still-open", A),
        ev("2026-01-01T00:05:00Z", "STAGE_COMPLETED", B, "domain-design"),
        ev("2026-01-01T00:06:00Z", "HUMAN_TURN", A),
      ],
      { complete: false },
    );
    const by = (m: string) => r.groups.find((g) => g.message === m)!;
    expect(by("done-later").stageClosedAfter).toBe(true);
    expect(by("still-open").stageClosedAfter).toBe(false);
  });

  test("a Context-only stage may place an error, but cannot close its stage", () => {
    // `stage` set with no `Stage` field: what the parser infers from Context.
    const inferred = (ts: string, event: string): AuditEvent => ({
      ts,
      event,
      shard: A,
      pos: pos++,
      shardIndex: 0,
      stage: "functional-design",
      fields: { Context: "construction > u1 > functional-design > x.md" },
    });
    const r = readErrors(
      [
        inferred("2026-01-01T00:00:00Z", "ARTIFACT_CREATED"),
        err("2026-01-01T00:01:00Z", "aidlc-state unit", "x", A),
        inferred("2026-01-01T00:02:00Z", "STAGE_COMPLETED"),
      ],
      { complete: false },
    );
    expect(r.groups[0]?.stage).toBe("functional-design");
    expect(r.groups[0]?.stageClosedAfter).toBe(false);
  });

  test("the hook's error directive does not warn on its own; its delivery is kept", () => {
    const r = readErrors(
      [
        ev("2026-01-01T00:00:00Z", "STAGE_STARTED", A, "code-generation"),
        err(
          "2026-01-01T00:01:00Z",
          "next (stop-hook probe)",
          "stopped on a problem",
          A,
          DIRECTIVE,
          "aidlc-orchestrate",
        ),
        ev("2026-01-01T00:02:00Z", "HUMAN_TURN"),
      ],
      { complete: false },
    );
    expect(r.groups[0]?.source).toBe("error-directive");
    expect(r.groups[0]?.tone).toBe("mute");
    expect(r.warn).toBe(false);
    const html = renderRunHealth({ ...base, errors: r, generatedAt: "2026-01-01T00:10:00Z" }, ko);
    expect(html).toContain(esc(ko.status.errorsDelivered));
  });

  test("a finished run's errors are all history", () => {
    const r = readErrors([err("2026-01-01T00:01:00Z", "aidlc-log answer", "last row")], {
      complete: true,
    });
    expect(r.groups[0]?.next).toBe("errors-only");
    expect(r.groups[0]?.tone).toBe("mute");
    expect(r.warn).toBe(false);
  });

  test("a group links to its shard only when the viewer can show the whole shard", () => {
    const events = [
      err("2026-01-01T00:01:00Z", "aidlc-log answer", "x", "small-aaaaaaaaaaaa.md"),
      err("2026-01-01T00:01:00Z", "aidlc-log answer", "x", "large-bbbbbbbbbbbb.md"),
    ];
    const r = readErrors(events, { complete: false, viewable: (s) => s.startsWith("small") });
    const by = (s: string) => r.groups.find((g) => g.shard.startsWith(s))!;
    expect(by("small").viewRel).toBe("audit/small-aaaaaaaaaaaa.md");
    expect(by("large").viewRel).toBeUndefined();
  });

  test("the fixture's errors are read through assemble", () => {
    expect(base.errors.total).toBe(3);
    expect(base.errors.groups.length).toBe(2);
    expect(base.errors.warn).toBe(false);
    const repeated = base.errors.groups.find((g) => g.count === 2)!;
    expect(repeated.stage).toBe("functional-design");
    expect(repeated.stageClosedAfter).toBe(true);
    const current = base.errors.groups.find((g) => g.count === 1)!;
    expect(current.stage).toBe("code-generation");
    expect(current.stageClosedAfter).toBe(false);
    expect(current.next).toBe("followed");
    // The fixture's shard is small, a regular file, reached with no link.
    expect(current.viewRel).toBe("audit/demo-host-aabbccdd1122.md");
  });
});

describe("errors — a conflict copy is the same clone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "errors-copy-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const block = (ts: string, event: string, extra = "") =>
    `\n## x\n**Timestamp**: ${ts}\n**Event**: ${event}\n${extra}\n---\n`;

  test("rows only the copy holds count as the clone's later records", () => {
    const audit = path.join(dir, "audit");
    fs.mkdirSync(audit);
    const start = block("2026-01-01T00:00:00Z", "STAGE_STARTED", "**Stage**: requirements");
    const error = block(
      "2026-01-01T00:01:00Z",
      "ERROR_LOGGED",
      "**Tool**: aidlc-log\n**Command**: aidlc-log answer\n**Error**: Refused",
    );
    const done = block("2026-01-01T00:02:00Z", "STAGE_COMPLETED", "**Stage**: requirements");
    fs.writeFileSync(
      path.join(audit, "host-aaaaaaaaaaaa.md"),
      `# AI-DLC Audit Log${start}${error}`,
    );
    fs.writeFileSync(
      path.join(audit, "host-aaaaaaaaaaaa 2.md"),
      `# AI-DLC Audit Log${start}${error}${done}`,
    );
    const ledger = readAuditLedger(dir);
    expect(ledger.copyGroups?.length).toBe(1);
    const r = readErrors(ledger.events, { complete: false, copyGroups: ledger.copyGroups });
    expect(r.total).toBe(1);
    expect(r.groups[0]?.next).toBe("followed");
    expect(r.groups[0]?.stageClosedAfter).toBe(true);
    expect(r.warn).toBe(false);
  });
});

const withErrors = (
  errors: DashboardModel["errors"],
  m: DashboardModel = base,
): DashboardModel => ({
  ...m,
  errors,
});
const group = (over: Partial<DashboardModel["errors"]["groups"][number]>) => ({
  tool: "aidlc-log",
  sub: "answer",
  command: "aidlc-log answer --stage x",
  message: "Refused: synthetic",
  count: 1,
  firstTs: "2026-01-02T09:00:00Z",
  lastTs: "2026-01-02T09:00:00Z",
  shard: "demo-host-aabbccdd1122.md",
  next: "followed" as const,
  stageClosedAfter: false,
  source: "tool-exit" as const,
  tone: "mute" as const,
  ...over,
});

describe("errors — Run Health tab and diagnostics chip", () => {
  test("Run Health carries an Errors tab with the fixture's count, muted", () => {
    const html = renderRunHealth(base, ko);
    expect(html).toContain(`${esc(ko.cards.errorsTab)} <b class="mc-n mute">3</b>`);
    expect(html).toContain("aidlc-log answer");
    expect(html).toContain("×2");
    expect(html).toContain(esc(ko.status.errorsFollowed));
    expect(html).toContain(esc(ko.status.errorsStageClosed));
    expect(html).toContain(esc(ko.status.errorsAfterStage("code-generation", undefined, false)));
    // A repeat group names the latest occurrence's context as such.
    expect(html).toContain(esc(ko.status.errorsAfterStage("functional-design", "PU-B-ui", true)));
  });

  test("no error reads as a plain line, hedged when an audit path was refused", () => {
    const none = { groups: [], total: 0, helpDropped: 0, warn: false };
    expect(renderRunHealth(withErrors(none), ko)).toContain(esc(ko.status.errorsNone));
    const partial = { ...withErrors(none), partialAudit: { notRead: 1 } };
    expect(renderRunHealth(partial, ko)).toContain(esc(ko.status.errorsNonePartial(1)));
  });

  test("the message is escaped and cut in the row, whole in the tooltip with its Command", () => {
    const long = `<b>${"x".repeat(300)}</b>`;
    const html = renderRunHealth(
      withErrors({ groups: [group({ message: long })], total: 1, helpDropped: 0, warn: false }),
      en,
    );
    expect(html).not.toContain("<b>xxx");
    expect(html).toContain("&lt;b&gt;xxx");
    const label =
      html.match(/<span class="mr-l">aidlc-log answer[\s\S]*?<\/span><span class="mr-v">/)?.[0] ??
      "";
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toContain("x".repeat(150));
    expect(html).toContain(`title="${esc(long)}\naidlc-log answer --stage x\n`);
  });

  test("every group stays reachable: past six they sit in a fold, not behind a count", () => {
    const groups = Array.from({ length: 8 }, (_, i) => group({ message: `unique-message-${i}` }));
    const html = renderRunHealth(withErrors({ groups, total: 8, helpDropped: 0, warn: false }), ko);
    for (let i = 0; i < 8; i++) expect(html).toContain(`unique-message-${i}`);
    expect(html).toContain('<details class="mr-fold" data-key="health-errors-more">');
    expect(html).toContain(esc(ko.cards.moreRows(2)));
  });

  test("a group with a viewable shard links to it", () => {
    const html = renderRunHealth(
      withErrors({
        groups: [group({ viewRel: "audit/demo-host-aabbccdd1122.md" })],
        total: 1,
        helpDropped: 0,
        warn: false,
      }),
      ko,
    );
    expect(html).toContain(`/view?rel=${encodeURIComponent("audit/demo-host-aabbccdd1122.md")}`);
  });

  test("dropped help calls are said in the note", () => {
    const html = renderRunHealth(
      withErrors({ groups: [group({})], total: 1, helpDropped: 2, warn: false }),
      ko,
    );
    expect(html).toContain(esc(ko.status.errorsHelpDropped(2)));
  });

  test("a muted chip does not open the fold; a warned one does", () => {
    const calm: DashboardModel = {
      ...base,
      sensors: { ...base.sensors, stages: [], failures: [] },
      provenance: Object.fromEntries(
        Object.entries(base.provenance).map(([k, p]) => [k, { ...p, stale: false }]),
      ) as DashboardModel["provenance"],
      waits: { ...base.waits, hooks: { state: "live" } },
    };
    const quiet = renderDiagnostics(calm, ko);
    expect(quiet).toContain(`<span class="diag-chip mute">${esc(ko.cards.errorsTab)} 3</span>`);
    expect(quiet).toMatch(/<details class="diag card" id="diag" data-key="diag">/);

    const stopped = withErrors(
      {
        groups: [group({ next: "errors-only", tone: "warn" })],
        total: 1,
        helpDropped: 0,
        warn: true,
      },
      calm,
    );
    const loud = renderDiagnostics(stopped, ko);
    expect(loud).toContain(`<span class="diag-chip warn">${esc(ko.cards.errorsTab)} 1</span>`);
    expect(loud).toMatch(/<details class="diag card" id="diag" data-key="diag" open>/);
    expect(loud).toContain(esc(ko.status.errorsErrorsOnly));
  });

  test("an error never reaches the hero card", () => {
    const stopped = withErrors({
      groups: [group({ next: "errors-only", tone: "warn", message: "unique-synthetic-message" })],
      total: 1,
      helpDropped: 0,
      warn: true,
    });
    expect(renderBanner(stopped, ko)).not.toContain("unique-synthetic-message");
    expect(renderBanner(stopped, ko)).toBe(renderBanner(base, ko));
  });
});

describe("errors — a finished run", () => {
  test("shows no errors tab and no chip: all of it is history", () => {
    const done: DashboardModel = { ...base, state: { ...base.state, complete: true } };
    expect(renderRunHealth(done, ko)).not.toContain(esc(ko.cards.errorsTab));
    const summary = renderDiagnostics(done, ko).split("</summary>")[0] ?? "";
    expect(summary).not.toContain(esc(ko.cards.errorsTab));
  });
});
