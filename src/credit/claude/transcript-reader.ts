// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * ClaudeTranscriptReader — aggregates token usage from Claude Code's local transcripts.
 *
 * This module exists because its data differs in kind from the Kiro path (u2 UsageCollector).
 * `kiro-cli chat --no-interactive /usage` fetches a **quota** (plan, limit, remaining, reset date)
 * remotely, but Claude Code has no matching non-interactive command (`/usage` is interactive only).
 * Instead, **measured tokens** per message are left in `~/.claude/projects/<slug>/*.jsonl`. So this side
 * is a token table rather than a quota table, and the properties below are the opposite of the Kiro path.
 *
 * - **No spawn, no network.** It reads local files only (NFR1.1's argv rule does not apply at all).
 * - **No storage.** No sqlite snapshots or polling are needed. The transcripts carry their own
 *   timestamps, so the daily trend comes straight from the source (history more exact than u1's store).
 * - **Never writes to the workspace.** Read-only, and it looks only at the home directory.
 *
 * It never throws: missing or broken transcripts degrade to an empty aggregate + counters (the same
 * no-throw rule as the scan layer). How many lines of which file were broken is kept in counters and shown.
 *
 * Measured performance (this machine, cold = no memo / warm = memo):
 *
 *   small tree    2 files    493 msg  7d 20ms  30d  6ms  all   5ms  cold  →  warm all 0ms
 *   real run      8 files    720 msg  7d 23ms  30d 10ms  all   9ms  cold  →  warm all 0ms
 *   worst tree   41 files 19,203 msg  7d 66ms  30d 268ms all 196ms  cold  →  warm all 0ms
 *
 * The table above was measured **before** per-response deduplication and subagent reading. After
 * (2026-10-12, same machine):
 *
 *   this repo    16 files (9 subagent) 2,204 responses  7d 53ms  30d 63ms  all 57ms  →  warm 1–2ms
 *   largest      14 files 271MB (main) 1,380 responses  7d 55ms  30d 91ms  all 83ms  →  warm 1–2ms
 *
 * Warm going from 0ms to 1–2ms is the cost of merging over thousands of responses instead of date
 * buckets — removing duplicates across files means holding the responses. Cold is within ±20ms of the
 * old reader on the same trees.
 *
 * **What polling really pays is the warm side.** Cold is only the process's first read, and the first
 * call mixes in JIT warm-up, so on the same tree 7d sometimes comes out slower than 30d. Hence (1) the
 * window filters files by mtime first so old files are not opened, (2) `MAX_TOTAL_BYTES` caps the pass,
 * and (3) per-file aggregates are memoised.
 *
 * **No whole-file reads.** `readFileSync(f, "utf-8")` uses RSS proportional to file size because of the
 * UTF-16 string (measured: a 105MB file → +101MB). The `MAX_TOTAL_BYTES` cap is a *sum*, so it does not
 * control a single file's peak. So `readLines()` reads chunks into a fixed buffer and hands over lines —
 * the same 105MB file goes down to +71MB.
 *
 * The gain matters only for large files. On a 26MB file it is +78MB → +73MB, just 7%. What remains is
 * not the chunk buffer but the aggregate structures kept (date buckets, session Sets) and pages not yet
 * returned to the OS. So what this change removed is **the peak rising linearly with file size**; the
 * constant overhead stays. Per-directory wall clock is nearly unchanged — most of the time is
 * `JSON.parse`, not reading.
 *
 * Why `fs.readSync`: `Bun.file().stream()` and `.slice().text()` are more idiomatic but async.
 * `assemble` is synchronous and every render path stands on it, so this one module does not turn the
 * whole thing async.
 *
 * **Each API response is counted once.** Claude Code writes one line per content block of a response,
 * and those lines repeat the same `message.id`, `requestId` and usage (mid-stream lines have only a
 * smaller output). Adding per line nearly doubles everything — measured over all 68 project directories
 * on this machine: a per-line sum of 34.0B against a per-response sum of 17.2B, **+97.4%** (median
 * +90% per directory, max +160%). This repository's main transcripts alone: 1,294.5M against 660.1M.
 * So lines are grouped by `message.id` and **the usage of the line with the largest total** is used.
 * Why `requestId` is not added to the key: no id ever carried two different requestIds, and if only one
 * copy had a requestId the same response would split in two. Within one key, the only fields measured
 * to change were output/thinking (6,727) and cache_creation (2), never in opposite directions — a
 * per-field max could invent a combination that never existed, so one line is chosen. The same key also
 * appears across files (86 in 2 directories — a resumed session re-writes the earlier conversation into
 * a new file) — so deduplication happens at merge time, not per file. Lines with no id are counted one
 * by one (the old behaviour; 0 measured).
 *
 * Three things go apart from the response choice (found in review, reproduced, then applied):
 * - **The time is that of the latest line observed for the response.** With equal usage the first line
 *   seen stays, and using its time would drop a response re-written right after the window edge out of
 *   the window entirely.
 * - **The session count comes from lines, not responses.** A resumed session re-writes old responses
 *   under its own sessionId (75 measured) — counting only the chosen line's sessionId would make that
 *   session vanish. The old definition (sessionIds observed in usage lines inside the window) stays.
 * - **`model: "<synthetic>"` is not an API response.** It is a record Claude Code makes to leave an error
 *   in the conversation (27 measured, all `isApiErrorMessage`, 0 tokens) and must not mix into the
 *   response count, the model table or sessions. It is not filtered by the error flag or by zero tokens,
 *   because that would also erase error responses that did leave real usage.
 *
 * **Subagent transcripts are read too.** Subagent conversations are left not in the main transcript but
 * separately in `<slug>/<sessionId>/subagents/agent-*.jsonl` (the `*.meta.json` in the same folder is not
 * read). Their lines carry `isSidechain: true` and **the parent session's `sessionId`** — so the session
 * count does not grow. They share 0 message ids or uuids with the main transcripts, so there is no
 * double counting, and leaving them out loses all of it: measured on this repository, 9 files of
 * 16.6MB, 90.8M tokens per response (cache reads alone in the hundreds of millions).
 *
 * Why the memo does not conflict with the host's "no cache" invariant: its key is file identity, not a
 * clock. Transcripts are append-only, so any content change moves size and mtime together — so this memo
 * cannot return a stale value; it only skips recomputing the same input. It is not a time-based TTL cache.
 * Directory resolution is memoised under the same rule (see the `TranscriptMemo` comment).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TrendWindow } from "../trend/trend";

/** The five token buckets. `thinking` is a subset of `output`, so it is not added to the total. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** output_tokens_details.thinking_tokens — a value already included in output. */
  thinking: number;
}

/** Per-model breakdown. Each model has its own price, so the total alone cannot be interpreted. */
export interface ModelBreakdown {
  model: string;
  totals: TokenTotals;
  messages: number;
}

/** Daily token total (= input + output + cacheRead + cacheCreate). */
export interface DailyPoint {
  /** `YYYY-MM-DD` (local time zone). */
  date: string;
  total: number;
}

/** Transcript aggregate. Failures surface as counters, not exceptions. */
/**
 * From a `type:"cost-state"` record, **only the fields this panel uses**. Cumulative totals Claude Code
 * writes as a checkpoint per session.
 *
 * **`totalCostUSD` and `totalLinesAdded/Removed` are left out on purpose** — out of the type, not just a
 * comment, for a reason. The cost is not measured but **a local price-table product**, and measurement
 * settled it: backing the input rate out of 114 records with the standard ratios (cacheRead 0.1x,
 * cacheCreate 1.25x, output 5x) gives **$5.000/MTok with 0.0% spread** for every Opus record and
 * **$1.000/MTok with 0.0% spread** for 95 Haiku ones. A billed amount does not land on list price with no
 * spread across 114 sessions. The record's own `hasUnknownModelCost` flag is decisive — a field that
 * exists only because the local table can fail to find a model. Besides, for a subscription user that
 * amount is not money that changed hands. Line counts are **per session**, so they do not map onto
 * stages or units and cannot answer the matrix's question (20 of 114 records also sum to 0 lines).
 */
export interface SessionCost {
  sessionId: string;
  /** epoch ms. The record carries a number, not an ISO string. */
  startTimeMs: number;
  /** Session wall clock (cumulative). The whole of it, API and tool time included. */
  totalMs: number;
  apiMs: number;
  toolMs: number;
}

/** Time totals of the sessions wholly inside the window. A cross-check figure independent of the audit ledger. */
export interface SessionTimeAggregate {
  /** Number of sessions in the total. */
  sessions: number;
  /**
   * Number of sessions **left out** because they straddle the window edge.
   *
   * A record is a session's cumulative total, but sessions run for days (measured: 27 sessions over 24
   * hours, the longest 144.6h). So cutting by `startTime` would pile 144 hours of work onto one moment,
   * and including straddling sessions would mix time outside the window into the figure inside it. The
   * choice is to add only sessions wholly inside and state how many were left out — 12 fall here in a
   * 7d window, measured. The same treatment as the rule that a cap must not read as completeness.
   */
  straddling: number;
  totalMs: number;
  apiMs: number;
  toolMs: number;
}

export interface TranscriptAggregate {
  /** The transcript directory read (absolute path). null when not found. */
  dir: string | null;
  /** The slug candidate path used to look for the directory — when not found, the screen says what it looked for. */
  triedPath: string;
  totals: TokenTotals;
  byModel: ModelBreakdown[];
  daily: DailyPoint[];
  /** Number of API responses carrying usage — not lines (the header's "each API response is counted once"). */
  messages: number;
  /** Of those, the number of subagent (isSidechain) responses. Their tokens are in the total. */
  sidechainMessages: number;
  /** Number of distinct sessionIds. */
  sessions: number;
  firstAt: string | null;
  lastAt: string | null;
  filesRead: number;
  /** Number of files not opened because they are outside the window (mtime). */
  filesSkipped: number;
  /** Number of files not read because of the byte cap (non-zero means the aggregate is incomplete). */
  filesCapped: number;
  /** Number of lines that failed JSON parsing. */
  malformedLines: number;
  /** Number of files that could not be opened (permissions, deletion races, etc.). */
  unreadableFiles: number;
  /**
   * Session time aggregate. null when no `cost-state` record was seen at all.
   *
   * That null is the normal case matters — measured, **only 31 of 61** project directories have this
   * record (old sessions lack the field). So when it is absent the panel draws nothing.
   */
  sessionTime: SessionTimeAggregate | null;
}

/** One API response. Its usage is that of the key's line with the largest total, its time that of the latest line. */
interface Response {
  /** ISO timestamp — the latest line observed for this response. */
  ts: string;
  /** `YYYY-MM-DD` (local, from `ts`). */
  day: string;
  model: string;
  totals: TokenTotals;
  sidechain: boolean;
}

/** One file's aggregate (the memo unit). Per-response deduplication and the window filter apply at merge time. */
interface FileAggregate {
  /**
   * Key → response. The key is `message.id` + `requestId`, or this file's line number when there is no id.
   * It holds responses rather than date buckets **because the same response also appears in other files**
   * — folded into buckets, the merge could no longer tell which share is a duplicate.
   */
  responses: Map<string, Response>;
  /** Date → the sessionIds observed in that date's usage lines. The session count comes from lines, not responses. */
  sessionsByDay: Map<string, Set<string>>;
  /** The `cost-state` checkpoints this file holds. 1–3 per file measured, so an array. The window filter and
   *  sessionId deduplication happen **at merge time** — one session can span several files. */
  costStates: SessionCost[];
  malformedLines: number;
}

/**
 * Process-lifetime memo. All three maps carry file identity in their keys, so none can return a stale value.
 *
 * - `files`: key `path|size|mtimeMs` → per-file aggregate.
 * - `keyByPath`: path → that path's current `files` key. An append-only transcript makes a new key on every
 *   poll, so this reverse index removes the same path's old entry in O(1) (no pile of dead keys).
 * - `dirs`: key `root|projectsMtimeMs` → the resolved directory, **or `null` meaning not found**.
 *   Memoising the miss is the point — a slug miss is the normal case, not an exception (Claude Code was
 *   never run in that workspace), and scanning every directory each time would repeat wasted work on
 *   every poll.
 */
export interface TranscriptMemo {
  files: Map<string, FileAggregate>;
  keyByPath: Map<string, string>;
  dirs: Map<string, string | null>;
}

/** Make an empty memo. A factory so `FileAggregate` is not exposed. */
export function createMemo(): TranscriptMemo {
  return { files: new Map(), keyByPath: new Map(), dirs: new Map() };
}

export interface ReaderDeps {
  /** Home directory (test injection). Default os.homedir(). */
  home?: string;
  /** Reference time (test injection — decides the window edge). */
  now?: Date;
  /** Per-file aggregate memo (the caller reuses it for the life of the process). */
  memo?: TranscriptMemo;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const WINDOW_MS: Record<Exclude<TrendWindow, "all">, number> = {
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

/**
 * Maximum bytes read in one aggregation. Newest files are read first, so hitting the cap drops old files.
 * The worst tree's 30-day window, where this cap bites, measured 268ms (41 files read, 18 dropped), so it
 * is budgeted as the process's one first read — later polls hit the memo at 0ms. The number of capped
 * files is exposed as `filesCapped` so nothing is cut silently.
 */
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

/** Memo cap (entry count). Beyond it, the oldest entries are dropped first. */
const MAX_MEMO_ENTRIES = 512;

/** `readLines`'s chunk size. A line averages 12KB, so 1MB holds a few dozen lines per chunk. */
const CHUNK_BYTES = 1024 * 1024;

/** The head size `firstCwd` reads. Only the first record is needed. */
const HEAD_BYTES = 16 * 1024;

/**
 * Turn a workspace path into the name of its Claude Code transcript directory.
 *
 * The rule was checked by measurement (2026-10-17, running Claude Code on Windows with varied paths):
 * every UTF-16 code unit that is not alphanumeric becomes a `-` on its own. Upper case is kept.
 *   /home/user/Development/ai-dlc/_work/AcmeCorp/x
 *   → -home-user-Development-ai-dlc--work-AcmeCorp-x
 *   C:\Temp\slug check (x)\a.b_c-d~e → C--Temp-slug-check--x--a-b-c-d-e
 *   (the measured path also held two non-Latin letters there, each of which became a `-`)
 * A result over 200 characters becomes its first 200, a `-`, and a hash of the original path
 * (`hashSlugSource`). 200 characters stayed as is; from 201 it was cut.
 *
 * It used to replace only `/`, `.` and `_` (later adding `\` and `:`). A path with a space, non-Latin
 * letters or parentheses missed the slug and fell to the second (cwd) search, which scans every project
 * directory (expensive) and looks only at the newest file's first cwd, so a session in a subdirectory
 * made it show no data.
 */
export function projectSlug(root: string): string {
  const slug = root.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= MAX_SLUG) return slug;
  return `${slug.slice(0, MAX_SLUG)}-${hashSlugSource(root)}`;
}

/** The length at which Claude Code cuts a slug (measured). */
const MAX_SLUG = 200;

/**
 * The hash appended to a cut slug: the absolute value of a 32-bit hash identical to Java's
 * `String.hashCode`, written in base 36. It matches the suffixes of the two measured paths (`qhz8u3`,
 * `b1r6e`). The original path is hashed, not the slug.
 */
function hashSlugSource(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Whether the `cwd` a transcript recorded is the same directory as `root`. Windows paths are
 * case-insensitive and the drive letter can be recorded as `c:` or `C:`, so the comparison ignores case.
 */
function sameDir(cwd: string | undefined, root: string): boolean {
  if (cwd === undefined) return false;
  if (process.platform !== "win32") return cwd === root;
  return path.resolve(cwd).toLowerCase() === path.resolve(root).toLowerCase();
}

/**
 * Read a file in chunks into a fixed buffer and hand it over line by line. The whole file never becomes a
 * string, so peak memory is bounded by the chunk + the longest single line. Never throws; returns only
 * whether it succeeded.
 *
 * Why decode with `TextDecoder({stream:true})`: a chunk boundary can split a UTF-8 multi-byte sequence,
 * and stream mode holds the cut tail until the next call.
 */
function readLines(file: string, onLine: (line: string) => void): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return false;
  }
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let carry = "";
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n === 0) break;
      carry += decoder.decode(buf.subarray(0, n), { stream: true });
      // Scan by moving an index and slice only once per chunk (re-slicing per line would be O(n²)).
      let start = 0;
      let nl = carry.indexOf("\n", start);
      while (nl !== -1) {
        onLine(carry.slice(start, nl));
        start = nl + 1;
        nl = carry.indexOf("\n", start);
      }
      if (start > 0) carry = carry.slice(start);
    }
    carry += decoder.decode();
    if (carry.length > 0) onLine(carry);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed or cannot be closed: nothing to do.
    }
  }
}

/**
 * Read the `cwd` the transcript recorded itself. **Reads only the head** — only the first record is
 * needed, and reading whole files would turn tens of MB into strings in one directory scan (measured:
 * 102 directories, 64MB).
 *
 * When the first line is longer than `HEAD_BYTES` and gets cut, `JSON.parse` fails, so then the `cwd`
 * field is scraped from the head with a regular expression — a fallback to get the value even from a cut record.
 */
function firstCwd(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  let head: string;
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    if (n === 0) return undefined;
    head = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, n));
  } catch {
    return undefined;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // As above.
    }
  }

  for (const line of head.split("\n")) {
    if (line.length === 0) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } catch {
      // Possibly a cut line — fall back to the regular expression.
    }
  }
  const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  if (m?.[1] === undefined) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function jsonlFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Find the transcript directory for `root`.
 *
 * First the slug rule (one stat). On failure, scan the project directories for one whose transcripts
 * recorded a `cwd` field equal to `root` — if the slug rule changes in the future, this second path
 * absorbs it (the same reason the harness search is an open set rather than a fixed list).
 */
export function findTranscriptDir(
  root: string,
  home: string,
  memo?: TranscriptMemo,
): string | undefined {
  const base = path.join(home, ".claude", "projects");
  const bySlug = path.join(base, projectSlug(root));
  try {
    if (fs.statSync(bySlug).isDirectory()) return bySlug;
  } catch {
    // On to the second search.
  }

  // From here on is the expensive path (measured: scanning 102 directories of 64MB → 121ms). The result is
  // memoised with the projects directory's mtime in the key, so it invalidates itself when a project
  // directory appears or disappears.
  let baseMtime: number;
  try {
    baseMtime = fs.statSync(base).mtimeMs;
  } catch {
    return undefined;
  }
  const dirKey = `${root}|${baseMtime}`;
  if (memo?.dirs.has(dirKey)) return memo.dirs.get(dirKey) ?? undefined;

  const resolved = scanForCwdMatch(base, root);
  if (memo !== undefined) {
    if (memo.dirs.size >= MAX_MEMO_ENTRIES) {
      const oldest = memo.dirs.keys().next();
      if (!oldest.done) memo.dirs.delete(oldest.value);
    }
    // A miss (`null`) is stored too — that is why this memo exists.
    memo.dirs.set(dirKey, resolved ?? null);
  }
  return resolved;
}

/** Scan the project directories for one whose transcripts recorded a `cwd` equal to `root`. */
function scanForCwdMatch(base: string, root: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    const files = jsonlFiles(dir);
    if (files.length === 0) continue;
    // Check only the most recent file (one file per directory).
    let newest = files[0] as string;
    let newestMs = -1;
    for (const f of files) {
      try {
        const ms = fs.statSync(f).mtimeMs;
        if (ms > newestMs) {
          newestMs = ms;
          newest = f;
        }
      } catch {
        // Skip it.
      }
    }
    if (sameDir(firstCwd(newest), root)) return dir;
  }
  return undefined;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, thinking: 0 };
}

function addTotals(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreate += from.cacheCreate;
  into.thinking += from.thinking;
}

/** Token total = tokens actually moved. thinking is a subset of output, so it is left out. */
export function totalOf(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheCreate;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** ISO timestamp → local `YYYY-MM-DD`. undefined when it cannot be parsed. */
function dayKey(ts: string): string | undefined {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return undefined;
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Aggregate one file into date buckets. Never throws. undefined when it cannot be opened. */
function parseFile(file: string): FileAggregate | undefined {
  const agg: FileAggregate = {
    responses: new Map(),
    sessionsByDay: new Map(),
    costStates: [],
    malformedLines: 0,
  };
  let lineNo = 0;

  const ok = readLines(file, (line) => {
    lineNo++;
    // A cheap pre-filter — lines with neither marker (user messages, summaries, etc.) never reach JSON.parse.
    // `"modelUsage"` does not contain `"usage"` (the preceding character is `l`), so cost-state was never
    // caught by the old filter. So this record has never been mixed into the token total.
    if (line.length === 0) return;
    const mightBeCost = line.includes('"cost-state"');
    if (!mightBeCost && !line.includes('"usage"')) return;

    let rec: {
      type?: unknown;
      timestamp?: unknown;
      sessionId?: unknown;
      isSidechain?: unknown;
      startTime?: unknown;
      totalDuration?: unknown;
      totalAPIDuration?: unknown;
      totalToolDuration?: unknown;
      message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> };
    };
    try {
      rec = JSON.parse(line);
    } catch {
      agg.malformedLines++;
      return;
    }

    // The marker is only a pre-filter; `type` decides. Conversation text can quote this string (the
    // transcript of the session that discussed this feature does exactly that), so trusting the string
    // alone would create fake sessions.
    if (rec.type === "cost-state") {
      if (typeof rec.sessionId !== "string" || typeof rec.startTime !== "number") return;
      agg.costStates.push({
        sessionId: rec.sessionId,
        startTimeMs: rec.startTime,
        totalMs: num(rec.totalDuration),
        apiMs: num(rec.totalAPIDuration),
        toolMs: num(rec.totalToolDuration),
      });
      return;
    }
    const usage = rec.message?.usage;
    if (typeof usage !== "object" || usage === null) return;
    if (typeof rec.timestamp !== "string") return;
    const day = dayKey(rec.timestamp);
    if (day === undefined) return;

    const details = usage.output_tokens_details;
    const totals: TokenTotals = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
      thinking:
        typeof details === "object" && details !== null
          ? num((details as Record<string, unknown>).thinking_tokens)
          : 0,
    };

    const model = typeof rec.message?.model === "string" ? rec.message.model : "(unknown)";
    if (model === "<synthetic>") return;
    const id = rec.message?.id;
    const key = typeof id === "string" && id.length > 0 ? id : `${file}\0${lineNo}`;
    merge(agg.responses, key, {
      ts: rec.timestamp,
      day,
      model,
      totals,
      sidechain: rec.isSidechain === true,
    });

    if (typeof rec.sessionId === "string") {
      let seen = agg.sessionsByDay.get(day);
      if (seen === undefined) {
        seen = new Set();
        agg.sessionsByDay.set(day, seen);
      }
      seen.add(rec.sessionId);
    }
  });

  return ok ? agg : undefined;
}

/**
 * Merge the lines of one key into one. The usage is that of the line with the larger total (mid-stream
 * lines have a smaller output/thinking), the time the later of the two — see the header's "the time is
 * that of the latest line". The received objects are not modified (a merge changing the memoised file
 * aggregates would poison the next poll).
 */
function merge(into: Map<string, Response>, key: string, r: Response): void {
  const prev = into.get(key);
  if (prev === undefined) {
    into.set(key, r);
    return;
  }
  const usage = totalOf(r.totals) > totalOf(prev.totals) ? r : prev;
  const late = r.ts > prev.ts ? r : prev;
  if (usage === prev && late === prev) return;
  into.set(key, { ...usage, ts: late.ts, day: late.day });
}

function memoGet(memo: TranscriptMemo | undefined, key: string): FileAggregate | undefined {
  return memo?.files.get(key);
}

/**
 * Memoise an aggregate. The same path's old key is removed first — an append-only transcript makes a new
 * key on every poll, so without this dead entries would pile up to the cap and push out live ones.
 */
function memoSet(
  memo: TranscriptMemo | undefined,
  path: string,
  key: string,
  value: FileAggregate,
): void {
  if (memo === undefined) return;
  const previous = memo.keyByPath.get(path);
  if (previous !== undefined && previous !== key) memo.files.delete(previous);
  if (memo.files.size >= MAX_MEMO_ENTRIES) {
    const oldest = memo.files.keys().next();
    if (!oldest.done) memo.files.delete(oldest.value);
  }
  memo.files.set(key, value);
  memo.keyByPath.set(path, key);
}

/**
 * The main transcripts (`<dir>/*.jsonl`) and the subagent transcripts (`<dir>/<sessionId>/subagents/*.jsonl`).
 * Subdirectories are not only session folders (`tool-results/`, etc.), so one without `subagents/` is
 * passed over quietly.
 */
function transcriptFiles(dir: string): string[] {
  const out = jsonlFiles(dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    for (const f of jsonlFiles(path.join(dir, e.name, "subagents"))) out.push(f);
  }
  return out;
}

/**
 * Aggregate the workspace's Claude Code token usage for a window.
 *
 * @param root   absolute path of the workspace the dashboard is showing.
 * @param window aggregation window (7d/30d/all).
 */
export function readTranscripts(
  root: string,
  window: TrendWindow = "30d",
  deps: ReaderDeps = {},
): TranscriptAggregate {
  const home = deps.home ?? os.homedir();
  const now = deps.now ?? new Date();
  const triedPath = path.join(home, ".claude", "projects", projectSlug(root));

  const empty: TranscriptAggregate = {
    dir: null,
    triedPath,
    totals: emptyTotals(),
    byModel: [],
    daily: [],
    messages: 0,
    sidechainMessages: 0,
    sessions: 0,
    firstAt: null,
    lastAt: null,
    filesRead: 0,
    filesSkipped: 0,
    filesCapped: 0,
    malformedLines: 0,
    unreadableFiles: 0,
    sessionTime: null,
  };

  const dir = findTranscriptDir(root, home, deps.memo);
  if (dir === undefined) return empty;

  const cutoffMs = window === "all" ? Number.NEGATIVE_INFINITY : now.getTime() - WINDOW_MS[window];

  // Newest files first — if the byte cap bites, the old ones must be the ones dropped.
  const stated: { file: string; size: number; mtimeMs: number }[] = [];
  let unreadableFiles = 0;
  for (const file of transcriptFiles(dir)) {
    try {
      const st = fs.statSync(file);
      stated.push({ file, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      unreadableFiles++;
    }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const merged: TranscriptAggregate = { ...empty, dir, totals: emptyTotals(), unreadableFiles };
  const dayTotals = new Map<string, number>();
  const modelTotals = new Map<string, ModelBreakdown>();
  const sessions = new Set<string>();
  // Deduplicate responses across files (see the header). The window filter applies per date once everything is gathered.
  const responses = new Map<string, Response>();
  const sessionsByDay = new Map<string, Set<string>>();
  // sessionId → that session's latest checkpoint. The cumulative total only grows, so the record with the
  // largest `totalMs` is the latest. File order is not relied on because one session can span several
  // files (resume), and then the last file may be read first. Leaving this out double counts sessions.
  const costBySession = new Map<string, SessionCost>();
  let bytes = 0;

  for (const { file, size, mtimeMs } of stated) {
    // mtime is the last append time, so every line of an older file is outside the window.
    if (mtimeMs < cutoffMs) {
      merged.filesSkipped++;
      continue;
    }
    if (bytes + size > MAX_TOTAL_BYTES) {
      merged.filesCapped++;
      continue;
    }

    const key = `${file}|${size}|${mtimeMs}`;
    let agg = memoGet(deps.memo, key);
    if (agg === undefined) {
      const parsed = parseFile(file);
      if (parsed === undefined) {
        merged.unreadableFiles++;
        continue;
      }
      agg = parsed;
      memoSet(deps.memo, file, key, agg);
    }
    bytes += size;
    merged.filesRead++;
    merged.malformedLines += agg.malformedLines;

    for (const cs of agg.costStates) {
      const prev = costBySession.get(cs.sessionId);
      if (prev === undefined || cs.totalMs > prev.totalMs) costBySession.set(cs.sessionId, cs);
    }

    for (const [id, r] of agg.responses) merge(responses, id, r);
    for (const [day, ids] of agg.sessionsByDay) {
      const seen = sessionsByDay.get(day);
      if (seen === undefined) sessionsByDay.set(day, new Set(ids));
      else for (const s of ids) seen.add(s);
    }
  }

  // A second filter finer than file mtime. The boundary is per date — if that day's last response is
  // inside the window, the whole day is included. Chosen so a daily bar is not cut in half, so the value
  // of the window's boundary day can include a few hours before the window starts.
  const dayLast = new Map<string, string>();
  for (const r of responses.values()) {
    const last = dayLast.get(r.day);
    if (last === undefined || r.ts > last) dayLast.set(r.day, r.ts);
  }
  for (const r of responses.values()) {
    if (Date.parse(dayLast.get(r.day) ?? r.ts) < cutoffMs) continue;
    let row = modelTotals.get(r.model);
    if (row === undefined) {
      row = { model: r.model, totals: emptyTotals(), messages: 0 };
      modelTotals.set(r.model, row);
    }
    addTotals(row.totals, r.totals);
    row.messages++;
    addTotals(merged.totals, r.totals);
    merged.messages++;
    if (r.sidechain) merged.sidechainMessages++;
    dayTotals.set(r.day, (dayTotals.get(r.day) ?? 0) + totalOf(r.totals));
    if (merged.firstAt === null || r.ts < merged.firstAt) merged.firstAt = r.ts;
    if (merged.lastAt === null || r.ts > merged.lastAt) merged.lastAt = r.ts;
  }
  for (const [day, ids] of sessionsByDay) {
    const last = dayLast.get(day);
    if (last !== undefined && Date.parse(last) < cutoffMs) continue;
    for (const id of ids) sessions.add(id);
  }

  // Session time: add only sessions **wholly inside** the window, and count and state the straddling ones
  // (the `straddling` comment above). A start after the window start means the end is inside too, so the
  // inclusion test needs only the start time.
  if (costBySession.size > 0) {
    const st: SessionTimeAggregate = {
      sessions: 0,
      straddling: 0,
      totalMs: 0,
      apiMs: 0,
      toolMs: 0,
    };
    for (const cs of costBySession.values()) {
      if (cs.startTimeMs < cutoffMs) {
        // A session that started before the window. If it ran on into the window it is stated as
        // "straddling"; if it is wholly outside, it drops out quietly, like the tokens.
        if (cs.startTimeMs + cs.totalMs >= cutoffMs) st.straddling++;
        continue;
      }
      st.sessions++;
      st.totalMs += cs.totalMs;
      st.apiMs += cs.apiMs;
      st.toolMs += cs.toolMs;
    }
    merged.sessionTime = st;
  }

  merged.sessions = sessions.size;
  merged.byModel = [...modelTotals.values()].sort((a, b) => totalOf(b.totals) - totalOf(a.totals));
  merged.daily = [...dayTotals.entries()]
    .map(([date, total]) => ({ date, total }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return merged;
}
