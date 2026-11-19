// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Leak audit for the REPOSITORY, not the archive: `bun run audit` (part of `verify`).
//
// WHY A SECOND AUDIT. `package.ts` inspects the staged zip and refuses to write one
// that fails. That is the right check for the archive, and the archive deliberately
// excludes `*.test.ts` and `fixtures/` — so it never reads them. The repository is
// public and carries both. Nothing checked that, and the gap has been paid for twice:
// a real customer name survived in a test file after being removed from the module
// next to it, and four run-specific strings reached fixtures and header comments.
// Both times the archive audit passed, and passing was read as "clean".
//
// WHAT IT SCANS. Exactly the public surface — `git ls-files` plus untracked files git
// would not ignore. Not the working tree by walk: that would sweep in `data/`,
// `__backup/` and `dist/`, which are gitignored precisely because they never ship,
// and their hits would train the reader to skim past the report.
//
// WHAT IT CANNOT DO. Two limits, both stated in the output rather than left implied:
//
//   1. **The customer list is machine-local.** It is read at runtime from
//      `~/.config/aidlc-dashboard/customer-names`, never from a literal in this repo —
//      an inventory of customer names cannot live in a public repository. Without that
//      file the audit still runs the static patterns but is blind to names, and says
//      so; a file that exists and cannot be read fails it. The count is printed; the
//      names never are, because this output ends up in terminals, CI logs and pasted
//      snippets.
//   2. **History is out of scope by default.** Force-pushing does not purge GitHub's
//      unreachable objects (measured: an old commit stayed readable by SHA after
//      `filter-repo` + force push, and only deleting and recreating the repository
//      returned 404). So a hit in history is a different, heavier problem than a hit in
//      the working tree, and mixing them would blur the remedy. `--history` scans every
//      blob in the object database when you actually want that answer.
//
// Exit 0 clean, 1 on any hit. Non-skippable inside `verify` for the same reason the
// archive audit is not skippable in `package.ts`.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CREDENTIALS,
  MACHINE,
  customerNames,
  customerPattern,
  maskPublicSlug,
} from "./leak-patterns";

const ROOT = path.join(import.meta.dir, "..");

/**
 * The pattern list exempts itself — see the warning at the top of leak-patterns.ts.
 * Also exempt: this file, which names the exemption and would match on the mention.
 *
 * Exempt from the STATIC patterns only. Customer names are never written in either
 * file — they are read at runtime — so nothing here can match a customer pattern by
 * describing it, and both files are checked against those. The full exemption had let
 * real account names sit in two comments, as examples, for six weeks without a hit.
 */
const EXEMPT = new Set(["scripts/leak-patterns.ts", "scripts/audit-repo.ts"]);

/**
 * Every file is read; only a NUL byte (or an absurd size) excuses one.
 *
 * An extension allowlist was tried first and skipped 15 of 122 files — including
 * `fixtures/**\/active-space`, `active-intent` and the hook-health `.last`/`.drops`
 * state files, which have no extension at all and are exactly the kind of place a
 * hostname or a real path hides. A skipped file is an unchecked file, so the filter
 * is on the CONTENT now, not the name.
 */
const MAX_BYTES = 4 * 1024 * 1024;
/**
 * Extensions whose files must be text. Used ONLY to turn a binary-looking one into a
 * failure — never to decide what gets read, which is the mistake the comment above
 * records. A real binary keeps being skipped-and-named; a `.ts` that looks binary is a
 * defect that silently removed a file from this audit's coverage.
 */
const TEXT_EXT = /\.(?:ts|tsx|js|mjs|cjs|json|md|css|html|sh|cmd|ps1|toml|yml|yaml|txt)$/i;

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf-8", maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    console.error(`✗ git ${args.join(" ")} failed: ${r.stderr?.trim() ?? `exit ${r.status}`}`);
    process.exit(1);
  }
  return r.stdout;
}

/** Tracked + untracked-but-not-ignored: the set a push would publish. */
function publicFiles(): string[] {
  const tracked = git("ls-files").split("\n");
  const untracked = git("ls-files", "--others", "--exclude-standard").split("\n");
  return [...new Set([...tracked, ...untracked])].filter((f) => f.length > 0).sort();
}

interface Hit {
  file: string;
  line: number;
  why: string;
  /** The matched text, redacted to its first 3 chars — enough to find, not to leak. */
  redacted: string;
  excerpt: string;
}

function redact(s: string): string {
  return s.length <= 3 ? `${s[0] ?? ""}…` : `${s.slice(0, 3)}…(${s.length} chars)`;
}

function scanText(
  file: string,
  body: string,
  patterns: readonly { pattern: RegExp; why: string }[],
  hits: Hit[],
): void {
  const lines = body.split("\n");
  for (const { pattern, why } of patterns) {
    // Fresh regex per file: a caller-supplied /g would carry lastIndex between files.
    const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    for (let i = 0; i < lines.length; i++) {
      // The published slug (package.json `repository`) is masked before matching — it is public by
      // definition and the install URLs cannot omit it (see maskPublicSlug).
      const line = maskPublicSlug(lines[i] ?? "");
      const m = re.exec(line);
      if (!m) continue;
      hits.push({
        file,
        line: i + 1,
        why,
        redacted: redact(m[0]),
        excerpt: line.trim().slice(0, 110),
      });
    }
  }
}

// ---- build the pattern set --------------------------------------------------

const customers = customerNames();
const customerPatterns = customers.names.map(customerPattern);

const ALL = [...MACHINE, ...CREDENTIALS, ...customerPatterns];

// ---- scan -------------------------------------------------------------------

const wantHistory = process.argv.includes("--history");
const files = publicFiles();
const hits: Hit[] = [];
let scanned = 0;
const skipped: string[] = [];
const exempt: string[] = [];
/** Text files that went unread and were reported as hits — a bucket, so the count closes. */
const unread: string[] = [];

for (const file of files) {
  if (EXEMPT.has(file)) {
    // Counted, not dropped. An exempt file is as unchecked as a skipped one by the
    // static patterns, and folding it into the denominator alone is what made
    // `121/123` unreadable: the gap could equally have meant two files fell out of
    // coverage. The customer patterns still run (see EXEMPT).
    exempt.push(file);
    let exemptBody = "";
    try {
      exemptBody = fs.readFileSync(path.join(ROOT, file), "utf-8");
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      hits.push({
        file,
        line: 1,
        why: "could not read an exempt file — the customer-name check cannot see it",
        redacted: "read failed",
        excerpt: why.slice(0, 110),
      });
    }
    scanText(file, exemptBody, customerPatterns, hits);
    continue;
  }
  const abs = path.join(ROOT, file);
  let body: string;
  try {
    if (fs.statSync(abs).size > MAX_BYTES) {
      skipped.push(`${file} (too large)`);
      continue;
    }
    body = fs.readFileSync(abs, "utf-8");
  } catch (err) {
    // NOT necessarily the benign race the first version assumed — this also catches a
    // permission error, and either way the file went UNREAD with no trace at all. So
    // it is accounted for, and for a text file it FAILS the gate on the same reasoning
    // as the NUL case below: an unchecked source file is a defect, not a skip.
    if (!fs.existsSync(abs)) {
      skipped.push(`${file} (gone after listing)`);
      continue;
    }
    const why = err instanceof Error ? err.message : String(err);
    if (TEXT_EXT.test(file)) {
      hits.push({
        file,
        line: 1,
        why: "could not read a source file — it is not checked",
        redacted: "read failed",
        excerpt: why.slice(0, 110),
      });
      unread.push(file);
      continue;
    }
    skipped.push(`${file} (read failed: ${why})`);
    continue;
  }
  if (body.includes("\u0000")) {
    // A NUL in a SOURCE file is not a legitimate skip, it is a defect: the file goes
    // unchecked and the only trace is one line in a PASSING run's output. That is
    // exactly what happened — a stray NUL in a Map key took `src/scan/deferrals.ts` out
    // of the audit for a commit, the run printed `119/122 checked`, and the number read
    // as normal. So a text-extension file that looks binary FAILS instead of skipping.
    if (TEXT_EXT.test(file)) {
      hits.push({
        file,
        line: 1,
        why: "NUL byte in a source file — it is not checked",
        redacted: "NUL",
        excerpt:
          "replace it with printable characters (the audit treats the file as binary and skips it)",
      });
      unread.push(file);
      continue;
    }
    skipped.push(`${file} (binary)`);
    continue;
  }
  scanned++;
  scanText(file, body, ALL, hits);
}

// ---- history (opt-in) -------------------------------------------------------

let historyHits = 0;
if (wantHistory) {
  const objects = git("rev-list", "--objects", "--all").split("\n");
  // BLOBS ONLY. `rev-list --objects` also yields trees and tag objects, and a tag's
  // `tagger` line carries the author's name and email — as does every commit, by
  // construction. That is not removable without rewriting the entire history, it is
  // public in any git repository, and reporting it on every run is how an audit trains
  // its reader to skim. File CONTENT is the question here.
  const types = new Map<string, string>();
  const shas = objects.map((r) => r.split(" ")[0] ?? "").filter((x) => x.length > 0);
  const check = spawnSync("git", ["cat-file", "--batch-check"], {
    cwd: ROOT,
    input: `${shas.join("\n")}\n`,
    encoding: "utf-8",
    maxBuffer: 1 << 28,
  }).stdout;
  for (const line of (check ?? "").split("\n")) {
    const [sha, type] = line.split(" ");
    if (sha && type) types.set(sha, type);
  }
  for (const row of objects) {
    const sp = row.indexOf(" ");
    if (sp < 0) continue;
    const sha = row.slice(0, sp);
    const name = row.slice(sp + 1);
    if (types.get(sha) !== "blob") continue;
    const body = spawnSync("git", ["cat-file", "-p", sha], {
      cwd: ROOT,
      encoding: "utf-8",
      maxBuffer: 1 << 26,
    }).stdout;
    if (!body || body.includes("\u0000")) continue;
    const found: Hit[] = [];
    scanText(`${name}@${sha.slice(0, 8)}`, body, EXEMPT.has(name) ? customerPatterns : ALL, found);
    if (found.length > 0) {
      historyHits += found.length;
      hits.push(...found);
    }
  }
}

// ---- report -----------------------------------------------------------------

// Every listed file must land in exactly one bucket. This is the guard the output
// itself could not be: a bare `checked 121/123` cannot say whether the gap was two
// deliberate exemptions or two files that fell out of coverage, which is why the
// number read as normal for several runs. If a future `continue` drops a file, the
// sum stops closing and the gate fails instead of printing a plausible figure.
const accounted = scanned + exempt.length + skipped.length + unread.length;
if (accounted !== files.length) {
  hits.push({
    file: "scripts/audit-repo.ts",
    line: 1,
    why: `file count mismatch — only ${accounted} of the ${files.length} listed files were classified`,
    redacted: `${files.length - accounted} files`,
    excerpt: "a file in no bucket is a file nobody checked",
  });
}

if (customers.state === "unreadable") {
  hits.push({
    file: customers.file,
    line: 0,
    why: `could not read the customer-name list (${customers.error})`,
    redacted: "-",
    excerpt:
      "a list that exists but cannot be read is not the same as no list — names were not checked",
  });
}
const blind = customers.names.length === 0;
if (blind && customers.state !== "unreadable") {
  console.warn(
    "⚠ The customer-name list is missing or empty — only the static patterns were checked. A leaked name is not detected by this run.",
  );
  console.warn(`    Write one name per line in ${customers.file} to check names too.`);
}

if (hits.length > 0) {
  console.error("✗ Repository leak audit failed:");
  for (const h of hits) {
    console.error(`    ${h.file}:${h.line} — ${h.why} [${h.redacted}]`);
    console.error(`      ${h.excerpt}`);
  }
  if (historyHits > 0) {
    console.error(
      `\n  ${historyHits} in history. A force push does not remove them — unreachable objects on the\n  remote stay readable by SHA. Only deleting and recreating the repository removes them.`,
    );
  }
  process.exit(1);
}

const scope = wantHistory ? "working tree + history" : "working tree";
console.log(`✓ Repository leak audit passed (${scope})`);
// The buckets are printed as a sum, not as a ratio: `checked 121 + exempt 2` accounts for
// all 123, where `121/123` left the reader to guess what the other two were.
console.log(
  `  ${files.length} files = ${scanned} checked + ${exempt.length} exempt + ${skipped.length} skipped`,
);
console.log(
  `  patterns: ${MACHINE.length} machine + ${CREDENTIALS.length} credential + ` +
    `${customerPatterns.length} customer${blind ? " (no list)" : ""}`,
);
// Exempt and skipped files are both UNCHECKED, so both are named rather than folded
// into a count — and the exempt ones say who has to read them, since no check does.
if (exempt.length > 0) {
  console.log(
    `  exempt: ${[...exempt].sort().join(", ")} — checked for customer names only; a person has to read them for the other patterns`,
  );
}
for (const s of skipped) console.log(`  skipped: ${s}`);
if (!wantHistory) console.log("  history not checked — run `bun run audit -- --history` for that");
