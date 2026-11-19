// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * transcript-reader unit tests.
 *
 * The real `~/.claude/projects` is never read — `home` is injected so synthetic transcripts are made in a
 * temporary directory, and `now` is injected to pin the window edge deterministically.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMemo,
  findTranscriptDir,
  projectSlug,
  readTranscripts,
  totalOf,
} from "./transcript-reader";

const NOW = new Date("2026-08-26T12:00:00Z");

interface LineOpts {
  ts: string;
  session?: string;
  model?: string;
  sidechain?: boolean;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  thinking?: number;
  cwd?: string;
  /** `message.id` — shared by the lines of one API response. */
  id?: string;
  requestId?: string;
}

/** One assistant line carrying usage. */
function line(o: LineOpts): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: o.ts,
    sessionId: o.session ?? "s1",
    cwd: o.cwd ?? "/ws",
    isSidechain: o.sidechain ?? false,
    ...(o.requestId ? { requestId: o.requestId } : {}),
    message: {
      ...(o.id ? { id: o.id } : {}),
      model: o.model ?? "claude-opus-5",
      usage: {
        input_tokens: o.input ?? 10,
        output_tokens: o.output ?? 100,
        cache_read_input_tokens: o.cacheRead ?? 1000,
        cache_creation_input_tokens: o.cacheCreate ?? 50,
        output_tokens_details: { thinking_tokens: o.thinking ?? 40 },
      },
    },
  });
}

/** A line with no usage (a user message, etc.) — the pre-filter must drop it. */
function userLine(ts: string): string {
  return JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: "hi" } });
}

interface CostOpts {
  session?: string;
  startMs: number;
  totalMs: number;
  apiMs?: number;
  toolMs?: number;
}

/** One `type:"cost-state"` checkpoint line. Carries a real record's fields as they are — the cost and
 *  line-count fields included, so the tests confirm the reader does **not read** them. */
function costLine(o: CostOpts): string {
  return JSON.stringify({
    type: "cost-state",
    sessionId: o.session ?? "s1",
    startTime: o.startMs,
    totalDuration: o.totalMs,
    totalAPIDuration: o.apiMs ?? 0,
    totalAPIDurationWithoutRetries: o.apiMs ?? 0,
    totalToolDuration: o.toolMs ?? 0,
    totalCostUSD: 12.34,
    totalLinesAdded: 999,
    totalLinesRemoved: 111,
    hasUnknownModelCost: false,
    modelUsage: {
      "claude-opus-5": {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 1,
        thinkingTokens: 0,
        costUSD: 12.34,
        webSearchRequests: 0,
      },
    },
  });
}

interface Tree {
  home: string;
  root: string;
  dir: string;
  /** Write the file and pin its mtime. */
  write(name: string, lines: string[], mtime?: Date): string;
}

/** Temporary home + workspace root + the matching transcript directory. */
function tree(rootName = "ws"): Tree {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-tr-"));
  const home = path.join(base, "home");
  const root = path.join(base, rootName);
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(home, ".claude", "projects", projectSlug(root));
  fs.mkdirSync(dir, { recursive: true });
  return {
    home,
    root,
    dir,
    write(name, lines, mtime) {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${lines.join("\n")}\n`);
      if (mtime) fs.utimesSync(p, mtime, mtime);
      return p;
    },
  };
}

describe("projectSlug", () => {
  test("turns `/`, `.` and `_` into `-` and keeps upper case", () => {
    expect(projectSlug("/home/user/Development/aidlc-dashboard")).toBe(
      "-home-user-Development-aidlc-dashboard",
    );
    // An underscore folds to `-` like any other non-alphanumeric: `_work` becomes `--work`.
    expect(projectSlug("/home/user/Development/ai-dlc/_work/AcmeCorp/x")).toBe(
      "-home-user-Development-ai-dlc--work-AcmeCorp-x",
    );
    expect(projectSlug("/a/.hidden/b")).toBe("-a--hidden-b");
  });

  test("turns a Windows path's `\\` and `:` into `-` too", () => {
    // Measured: on Windows, `~/.claude/projects` holds `C:\aidlc-dashboard` under this name.
    expect(projectSlug("C:\\aidlc-dashboard")).toBe("C--aidlc-dashboard");
    expect(projectSlug("C:\\Users\\me\\_ws")).toBe("C--Users-me--ws");
  });

  // The three below are directory names made by actually running Claude Code at those paths (2026-10-17).
  test("every non-alphanumeric character becomes one `-` each, spaces, Hangul and parentheses too", () => {
    // The Korean letters are the measured input on purpose: non-Latin letters are not alphanumeric either.
    expect(projectSlug("C:\\Temp\\slug 검증 (x)\\a.b_c-d~e")).toBe("C--Temp-slug-----x--a-b-c-d-e");
  });

  test("200 characters stay as is; beyond that, the first 200 get a hash of the original path", () => {
    const at = (n: number) => `C:\\Temp\\sb\\${"z".repeat(n - 11)}`;
    expect(projectSlug(at(200))).toBe(`C--Temp-sb-${"z".repeat(189)}`);
    expect(projectSlug(at(201))).toBe(`C--Temp-sb-${"z".repeat(189)}-b1r6e`);
    const long = `C:\\Temp\\slug-long\\${"abcdefghij".repeat(20)}`;
    expect(projectSlug(long)).toBe(
      `C--Temp-slug-long-${"abcdefghij".repeat(20).slice(0, 182)}-qhz8u3`,
    );
  });
});

describe("findTranscriptDir", () => {
  test("found first through the slug rule", () => {
    const t = tree();
    t.write("a.jsonl", [line({ ts: "2026-08-25T10:00:00Z" })]);
    expect(findTranscriptDir(t.root, t.home)).toBe(t.dir);
  });

  test("found second through the transcript's cwd when the slug misses", () => {
    const t = tree();
    // Move the slug directory to a wrong name so the first search fails.
    const renamed = path.join(path.dirname(t.dir), "-totally-different-name");
    fs.renameSync(t.dir, renamed);
    fs.writeFileSync(
      path.join(renamed, "a.jsonl"),
      `${line({ ts: "2026-08-25T10:00:00Z", cwd: t.root })}\n`,
    );
    expect(findTranscriptDir(t.root, t.home)).toBe(renamed);
  });

  test("undefined when it is nowhere", () => {
    const t = tree();
    fs.rmSync(t.dir, { recursive: true, force: true });
    expect(findTranscriptDir(t.root, t.home)).toBeUndefined();
  });
});

describe("readTranscripts", () => {
  test("aggregates tokens, sessions and messages", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [
        userLine("2026-08-25T09:00:00Z"),
        line({ ts: "2026-08-25T10:00:00Z", session: "s1" }),
        line({ ts: "2026-08-25T11:00:00Z", session: "s2" }),
      ],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });

    expect(agg.dir).toBe(t.dir);
    expect(agg.messages).toBe(2);
    expect(agg.sessions).toBe(2);
    expect(agg.totals).toEqual({
      input: 20,
      output: 200,
      cacheRead: 2000,
      cacheCreate: 100,
      thinking: 80,
    });
    // thinking is a subset of output, so it is not added to the total.
    expect(totalOf(agg.totals)).toBe(2320);
    expect(agg.filesRead).toBe(1);
    expect(agg.malformedLines).toBe(0);
  });

  test("breaks down by model, sorted by total descending", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [
        line({ ts: "2026-08-25T10:00:00Z", model: "claude-haiku-4-5", output: 10, cacheRead: 0 }),
        line({ ts: "2026-08-25T10:05:00Z", model: "claude-opus-5", output: 900, cacheRead: 5000 }),
      ],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.byModel.map((m) => m.model)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
    expect(agg.byModel[0]?.totals.output).toBe(900);
    expect(agg.byModel[1]?.messages).toBe(1);
  });

  test("builds the daily series in ascending date order", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [
        line({ ts: "2026-08-24T10:00:00Z", output: 100 }),
        line({ ts: "2026-08-25T10:00:00Z", output: 200 }),
        line({ ts: "2026-08-25T12:00:00Z", output: 300 }),
      ],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.daily.length).toBe(2);
    expect((agg.daily[0]?.date ?? "") < (agg.daily[1]?.date ?? "")).toBe(true);
    // The total is input + output + cacheRead + cacheCreate.
    expect(agg.daily.reduce((s, d) => s + d.total, 0)).toBe(totalOf(agg.totals));
  });

  test("counts subagent messages separately while including them in the total", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [line({ ts: "2026-08-25T10:00:00Z" }), line({ ts: "2026-08-25T10:01:00Z", sidechain: true })],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.messages).toBe(2);
    expect(agg.sidechainMessages).toBe(1);
    expect(agg.totals.output).toBe(200);
  });

  test("files outside the window (mtime) are not opened", () => {
    const t = tree();
    t.write("recent.jsonl", [line({ ts: "2026-08-25T10:00:00Z" })], NOW);
    t.write("old.jsonl", [line({ ts: "2026-01-01T10:00:00Z" })], new Date("2026-01-01T10:00:00Z"));

    const win7 = readTranscripts(t.root, "7d", { home: t.home, now: NOW });
    expect(win7.filesRead).toBe(1);
    expect(win7.filesSkipped).toBe(1);
    expect(win7.messages).toBe(1);

    const all = readTranscripts(t.root, "all", { home: t.home, now: NOW });
    expect(all.filesRead).toBe(2);
    expect(all.filesSkipped).toBe(0);
    expect(all.messages).toBe(2);
  });

  test("broken lines are counted and skipped — it does not throw", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      ['{"usage": broken json', line({ ts: "2026-08-25T10:00:00Z" }), '{"usage":'],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.malformedLines).toBe(2);
    expect(agg.messages).toBe(1);
  });

  test("no transcript directory → an empty aggregate + the path tried", () => {
    const t = tree();
    fs.rmSync(t.dir, { recursive: true, force: true });
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.dir).toBeNull();
    expect(agg.messages).toBe(0);
    expect(agg.triedPath).toContain(projectSlug(t.root));
  });

  test("negative and abnormal token values are sanitised to 0", () => {
    const t = tree();
    t.write(
      "a.jsonl",
      [line({ ts: "2026-08-25T10:00:00Z", input: -5, output: Number.NaN, cacheRead: 7 })],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.totals.input).toBe(0);
    expect(agg.totals.output).toBe(0);
    expect(agg.totals.cacheRead).toBe(7);
  });

  test("the memo does not re-parse a file with the same (path, size, mtime)", () => {
    const t = tree();
    const p = t.write("a.jsonl", [line({ ts: "2026-08-25T10:00:00Z", output: 100 })], NOW);
    const memo = createMemo();

    const first = readTranscripts(t.root, "30d", { home: t.home, now: NOW, memo });
    expect(first.totals.output).toBe(100);
    expect(memo.files.size).toBe(1);

    // Change the content but restore the byte length and mtime — the memo key is the same, so the earlier
    // aggregate must be reused. That is the evidence this memo is not a "clock-based cache".
    const before = fs.statSync(p);
    const replaced = line({ ts: "2026-08-25T10:00:00Z", output: 999 });
    fs.writeFileSync(p, `${replaced.padEnd(before.size - 1, " ")}\n`);
    fs.utimesSync(p, before.mtime, before.mtime);
    expect(fs.statSync(p).size).toBe(before.size);

    const second = readTranscripts(t.root, "30d", { home: t.home, now: NOW, memo });
    expect(second.totals.output).toBe(100);
    expect(memo.files.size).toBe(1);

    // Once mtime moves, the memo is bypassed and the new content is read.
    const later = new Date(before.mtimeMs + 60_000);
    fs.utimesSync(p, later, later);
    const third = readTranscripts(t.root, "30d", { home: t.home, now: NOW, memo });
    expect(third.totals.output).toBe(999);
    // And the same path's old entry is removed — otherwise every append piles up a dead key until the cap
    // fills and live entries are pushed out.
    expect(memo.files.size).toBe(1);
  });

  test("a directory miss is memoised too — a miss is the normal case", () => {
    const t = tree();
    fs.rmSync(t.dir, { recursive: true, force: true });
    // There must be something to scan for the fallback path to really run.
    const decoy = path.join(t.home, ".claude", "projects", "-somewhere-else");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(
      path.join(decoy, "a.jsonl"),
      `${line({ ts: "2026-08-25T10:00:00Z", cwd: "/other/ws" })}\n`,
    );

    const memo = createMemo();
    expect(findTranscriptDir(t.root, t.home, memo)).toBeUndefined();
    expect(memo.dirs.size).toBe(1);
    expect([...memo.dirs.values()]).toEqual([null]); // the miss is remembered as null
    // The second call is answered from the memo (same result).
    expect(findTranscriptDir(t.root, t.home, memo)).toBeUndefined();
    expect(memo.dirs.size).toBe(1);
  });

  test("reads multi-byte characters and long lines across chunk boundaries exactly", () => {
    const t = tree();
    // A large Hangul padding (Korean on purpose: 3-byte UTF-8 characters) makes the line cross the 1MB
    // chunk several times. If a boundary splits a UTF-8 sequence without streaming decode, characters break
    // and JSON.parse fails.
    const padding = "한글패딩".repeat(90_000); // about 1.4MB (UTF-8, 3 bytes per character)
    const fat = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-25T10:00:00Z",
      sessionId: "s1",
      cwd: t.root,
      note: padding,
      message: { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 7 } },
    });
    t.write("big.jsonl", [fat, line({ ts: "2026-08-25T11:00:00Z", output: 3 })], NOW);

    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.messages).toBe(2);
    expect(agg.malformedLines).toBe(0);
    expect(agg.totals.output).toBe(10); // 7 + 3 — both lines parsed whole
  });

  test("no cost-state → sessionTime is null — half the projects are like that", () => {
    const t = tree();
    t.write("a.jsonl", [line({ ts: "2026-08-25T10:00:00Z" })], NOW);
    expect(readTranscripts(t.root, "30d", { home: t.home, now: NOW }).sessionTime).toBeNull();
  });

  test("cost-state does not mix into the token total, and cost and line counts are not read", () => {
    const t = tree();
    const start = NOW.getTime() - 3_600_000;
    t.write(
      "a.jsonl",
      [line({ ts: "2026-08-26T10:00:00Z" }), costLine({ startMs: start, totalMs: 3_600_000 })],
      NOW,
    );
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    // Tokens come only from the one assistant line — adding cost-state's modelUsage would change this value.
    expect(agg.messages).toBe(1);
    expect(totalOf(agg.totals)).toBe(1160);
    // No cost or line count is carried anywhere in the aggregate (structurally impossible: not in the type).
    expect(JSON.stringify(agg)).not.toContain("12.34");
    expect(JSON.stringify(agg)).not.toContain("999");
  });

  test("several checkpoints of one session count only the latest — no double counting", () => {
    const t = tree();
    const start = NOW.getTime() - 7_200_000;
    t.write(
      "a.jsonl",
      [
        costLine({ startMs: start, totalMs: 1_000_000, apiMs: 100_000 }),
        costLine({ startMs: start, totalMs: 7_200_000, apiMs: 1_800_000 }),
      ],
      NOW,
    );
    const st = readTranscripts(t.root, "30d", { home: t.home, now: NOW }).sessionTime;
    expect(st).toEqual({
      sessions: 1,
      straddling: 0,
      totalMs: 7_200_000,
      apiMs: 1_800_000,
      toolMs: 0,
    });
  });

  test("a session spanning two files counts once (not relying on file order)", () => {
    const t = tree();
    const start = NOW.getTime() - 7_200_000;
    // Newest files are read first, so b comes first — the larger one must still win.
    t.write("a.jsonl", [costLine({ startMs: start, totalMs: 7_200_000 })], NOW);
    t.write(
      "b.jsonl",
      [costLine({ startMs: start, totalMs: 1_000_000 })],
      new Date(NOW.getTime() + 1000),
    );
    const st = readTranscripts(t.root, "30d", { home: t.home, now: NOW }).sessionTime;
    expect(st?.sessions).toBe(1);
    expect(st?.totalMs).toBe(7_200_000);
  });

  test("a session straddling the window edge is left out of the total and counted separately", () => {
    const t = tree();
    const day = 86_400_000;
    t.write(
      "a.jsonl",
      [
        // Starts inside the window — included.
        costLine({ session: "inside", startMs: NOW.getTime() - 2 * day, totalMs: 3_600_000 }),
        // Starts outside 7d and runs into the window — straddling.
        costLine({ session: "straddle", startMs: NOW.getTime() - 9 * day, totalMs: 4 * day }),
        // Starts outside 7d and ends before the window — drops out quietly.
        costLine({ session: "outside", startMs: NOW.getTime() - 20 * day, totalMs: 3_600_000 }),
      ],
      NOW,
    );
    const st = readTranscripts(t.root, "7d", { home: t.home, now: NOW }).sessionTime;
    expect(st).toEqual({
      sessions: 1,
      straddling: 1,
      totalMs: 3_600_000,
      apiMs: 0,
      toolMs: 0,
    });
    // In the all window, all three fall wholly inside.
    const all = readTranscripts(t.root, "all", { home: t.home, now: NOW }).sessionTime;
    expect(all?.sessions).toBe(3);
    expect(all?.straddling).toBe(0);
  });

  test("text quoting cost-state does not create a fake session — type decides", () => {
    const t = tree();
    // The transcript of the session that discussed this feature looks exactly like this: a person writes that string.
    const quoting = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-26T10:00:00Z",
      sessionId: "s1",
      cwd: "/ws",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: 'should we read type:"cost-state"?',
      },
    });
    t.write("a.jsonl", [quoting], NOW);
    const agg = readTranscripts(t.root, "30d", { home: t.home, now: NOW });
    expect(agg.sessionTime).toBeNull();
    expect(agg.messages).toBe(1); // it is handled normally on the usage path too
  });

  test("finds cwd even when the first record is longer than the head (regex fallback)", () => {
    const t = tree();
    const renamed = path.join(path.dirname(t.dir), "-slug-does-not-match");
    fs.renameSync(t.dir, renamed);
    // Put cwd near the front and append over 16KB of text so the first line is cut at the head.
    const huge = JSON.stringify({
      cwd: t.root,
      type: "assistant",
      timestamp: "2026-08-25T10:00:00Z",
      body: "x".repeat(40_000),
    });
    fs.writeFileSync(path.join(renamed, "a.jsonl"), `${huge}\n`);
    expect(findTranscriptDir(t.root, t.home)).toBe(renamed);
  });
});

describe("aggregation per API response", () => {
  // Claude Code writes one line per content block of a response and repeats the usage. Adding per line
  // nearly doubles everything (+97.4% measured).
  test("lines sharing message.id and requestId are one response, and only the line with the largest total counts", () => {
    const t = tree();
    t.write("a.jsonl", [
      line({ ts: "2026-08-25T10:00:00Z", id: "msg_1", requestId: "req_1", output: 3 }),
      line({ ts: "2026-08-25T10:00:01Z", id: "msg_1", requestId: "req_1", output: 439 }),
      line({ ts: "2026-08-25T10:00:01Z", id: "msg_1", requestId: "req_1", output: 439 }),
      line({ ts: "2026-08-25T10:00:05Z", id: "msg_2", requestId: "req_2" }),
    ]);
    const a = readTranscripts(t.root, "7d", { home: t.home, now: NOW });
    expect(a.messages).toBe(2);
    expect(a.totals.output).toBe(439 + 100);
    expect(a.totals.cacheRead).toBe(2000);
  });

  // A resumed session re-writes the earlier conversation into a new file (86 in 2 directories, measured).
  test("the same response across files counts once", () => {
    const t = tree();
    const dup = line({ ts: "2026-08-25T10:00:00Z", id: "msg_1", requestId: "req_1" });
    t.write("a.jsonl", [dup]);
    t.write("b.jsonl", [
      dup,
      line({ ts: "2026-08-25T11:00:00Z", id: "msg_2", requestId: "req_2" }),
    ]);
    const memo = createMemo();
    for (let i = 0; i < 2; i++) {
      // The second comes from the memo — the memo must not bypass deduplication.
      const a = readTranscripts(t.root, "7d", { home: t.home, now: NOW, memo });
      expect(a.messages).toBe(2);
      expect(a.totals.input).toBe(20);
    }
  });

  // With equal usage the first line seen stays — using its time would drop a response re-written right
  // after the window edge out of the window entirely.
  test("a response's time is the latest line observed", () => {
    const t = tree();
    t.write("a.jsonl", [
      line({ ts: "2026-08-19T11:59:59Z", id: "msg_1" }),
      line({ ts: "2026-08-19T12:00:01Z", id: "msg_1" }),
    ]);
    // The 7d window starts at 2026-08-19T12:00:00Z. Inclusion is per date, so the day's last line inside the window brings it in.
    const a = readTranscripts(t.root, "7d", { home: t.home, now: NOW });
    expect(a.messages).toBe(1);
    expect(a.lastAt).toBe("2026-08-19T12:00:01Z");
  });

  // Even with a requestId on one copy only, it is the same response (0 measured cases of one id with different requestIds).
  test("a requestId on one copy only is still one response", () => {
    const t = tree();
    t.write("a.jsonl", [
      line({ ts: "2026-08-25T10:00:00Z", id: "msg_1", requestId: "req_1" }),
      line({ ts: "2026-08-25T10:00:00Z", id: "msg_1" }),
    ]);
    expect(readTranscripts(t.root, "7d", { home: t.home, now: NOW }).messages).toBe(1);
  });

  test("a <synthetic> record is not an API response", () => {
    const t = tree();
    t.write("a.jsonl", [
      line({
        ts: "2026-08-25T10:00:00Z",
        id: "syn_1",
        model: "<synthetic>",
        session: "s-err",
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        thinking: 0,
      }),
      line({ ts: "2026-08-25T10:01:00Z", id: "msg_1" }),
    ]);
    const a = readTranscripts(t.root, "7d", { home: t.home, now: NOW });
    expect(a.messages).toBe(1);
    expect(a.byModel.map((m) => m.model)).toEqual(["claude-opus-5"]);
    expect(a.sessions).toBe(1);
  });

  // A resumed session re-writes old responses under its own sessionId — counting only the chosen line's session would make it vanish.
  test("the session count comes from lines, not responses", () => {
    const t = tree();
    const replayed = (session: string) =>
      line({ ts: "2026-08-25T10:00:00Z", id: "msg_1", session });
    t.write("a.jsonl", [replayed("s1")]);
    t.write("b.jsonl", [replayed("s2")]);
    const a = readTranscripts(t.root, "7d", { home: t.home, now: NOW });
    expect(a.messages).toBe(1);
    expect(a.sessions).toBe(2);
  });

  test("lines with no id are counted per line, as before", () => {
    const t = tree();
    t.write("a.jsonl", [
      line({ ts: "2026-08-25T10:00:00Z" }),
      line({ ts: "2026-08-25T10:00:00Z" }),
    ]);
    expect(readTranscripts(t.root, "7d", { home: t.home, now: NOW }).messages).toBe(2);
  });
});

describe("subagent transcripts", () => {
  test("reads <sessionId>/subagents/*.jsonl, and as the parent session the session count does not grow", () => {
    const t = tree();
    t.write("s1.jsonl", [line({ ts: "2026-08-25T10:00:00Z", id: "m1", requestId: "r1" })]);
    t.write("s1/subagents/agent-abc.jsonl", [
      line({ ts: "2026-08-25T10:01:00Z", id: "m2", requestId: "r2", sidechain: true }),
      line({ ts: "2026-08-25T10:02:00Z", id: "m3", requestId: "r3", sidechain: true }),
    ]);
    // meta files and other subdirectories are not read.
    t.write("s1/subagents/agent-abc.meta.json", ['{"agentType":"x"}']);
    t.write("s1/tool-results/out.jsonl", [line({ ts: "2026-08-25T10:03:00Z", id: "m4" })]);
    const a = readTranscripts(t.root, "7d", { home: t.home, now: NOW });
    expect(a.messages).toBe(3);
    expect(a.sidechainMessages).toBe(2);
    expect(a.sessions).toBe(1);
    expect(a.filesRead).toBe(2);
  });

  test("subagent files follow the same mtime window", () => {
    const t = tree();
    t.write("s1.jsonl", [line({ ts: "2026-08-25T10:00:00Z", id: "m1" })]);
    t.write(
      "s1/subagents/agent-old.jsonl",
      [line({ ts: "2026-07-01T10:00:00Z", id: "m2", sidechain: true })],
      new Date("2026-07-01T10:00:00Z"),
    );
    const a = readTranscripts(t.root, "7d", { home: t.home, now: NOW });
    expect(a.filesSkipped).toBe(1);
    expect(a.messages).toBe(1);
  });
});
