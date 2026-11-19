// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Build the release: one single executable per platform, `bun run package [outDir] [--only <target>]`.
//
// WHY EXECUTABLES (since 1.13). The release used to be a source zip
// that needed bun on the user's machine — the installers detected it, offered to
// install it, and enforced a version floor. Each archive now carries a binary built
// with `bun build --compile`, which embeds the Bun runtime, so the user installs
// nothing. AI-DLC itself ships its engine the same way (an ad-hoc-signed Mach-O with
// Bun embedded), which is the precedent this follows.
//
// WHY THIS IS A SCRIPT AND NOT A CHECKLIST. The first archive was assembled by hand and
// shipped `data/usage.db` — a smoke test had been run inside the staging dir and left
// the operator's real credit history there. The version was typed twice too. Both
// failures are the kind a script removes and a checklist does not. The version comes
// from package.json and nowhere else: it names every archive, and `src/version.ts`
// imports the same field, so the footer of each binary agrees with its filename.
//
// THE LEAK AUDIT RUNS ON THE BUNDLE, NOT THE BINARY. The code is bundled once to a
// single JS file, that file (and the README that ships beside it) is audited, and the
// SAME file is compiled for every target — so what was audited is byte-for-byte what
// ships. Scanning the binary instead would also scan Bun's own runtime, whose strings
// are not ours and would trip the machine patterns. Refuses to write any archive if
// the audit fails; that check is the point of the script, so it is not skippable.
//
// Two build flags are load-bearing. `--no-compile-autoload-dotenv` and
// `--no-compile-autoload-bunfig`: a compiled binary otherwise loads `.env` and
// `bunfig.toml` from the folder it runs in, and the dashboard runs in the user's
// project — a cloned repository's `.env` could then set AIDLC_DASHBOARD_DATA_DIR or the
// port. AI-DLC builds its engine with the same autoload off for the same reason.
//
// macOS builds are RE-SIGNED ad hoc and verified. A cross-compiled darwin-x64 binary is
// Bun's own runtime with our code appended, and Bun's Developer ID signature no longer
// matches it — `codesign --verify` said "invalid signature (code or signature have been
// modified)" (measured, 2026-11-14). The native arm64 build came out ad-hoc signed and
// valid; both now end up that way, which is also how AI-DLC's engine ships. Needs
// macOS `codesign`, so the full release is built on a Mac; elsewhere the script refuses
// the darwin targets rather than shipping a broken signature.
//
// Where each `bun build` runs is load-bearing too, in opposite directions. The BUNDLE
// runs in the repo root: the bundler writes each module's path as a comment relative
// to its cwd, and from anywhere else that path climbed to `/Users/<account>/…` — the
// audit below caught exactly that on the first run. The COMPILE runs in a throwaway
// cwd: it leaves a `.<hash>.bun-build` temp file in its working directory even on
// success (measured, 2026-11-14), and one left in the repo root is untracked public
// surface. The script checks the root for one afterwards and fails if it finds it.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
 * Release targets, as `bun build --target` names them. The x64 builds for Linux and
 * Windows use Bun's `baseline` runtime, which runs on CPUs without AVX2; macOS x64 needs
 * no such fallback. `os`/`arch` are what the installers detect and the asset is named by.
 */
const TARGETS = [
  { os: "darwin", arch: "arm64", bun: "bun-darwin-arm64", exe: "aidlc-dashboard" },
  { os: "darwin", arch: "x64", bun: "bun-darwin-x64", exe: "aidlc-dashboard" },
  { os: "linux", arch: "x64", bun: "bun-linux-x64-baseline", exe: "aidlc-dashboard" },
  { os: "linux", arch: "arm64", bun: "bun-linux-arm64", exe: "aidlc-dashboard" },
  { os: "windows", arch: "x64", bun: "bun-windows-x64-baseline", exe: "aidlc-dashboard.exe" },
] as const;

/**
 * Anything matching these must NOT appear in an archive. Named rather than inferred so
 * a new leak has to be added here deliberately.
 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /(^|\/)data\//, why: "collected credit DB — the operator's real usage history" },
  { pattern: /\.db(-wal|-shm)?$/, why: "SQLite file" },
  { pattern: /(^|\/)\.git\//, why: "commit history and author details" },
  { pattern: /\.bun-build$/, why: "bun build scratch output" },
  { pattern: /(^|\/)CLAUDE\.md$|(^|\/)AGENTS\.md$/, why: "internal design notes" },
  { pattern: /\.DS_Store$/, why: "macOS leftover" },
];

/**
 * Content patterns come from `leak-patterns.ts`, shared with the repository-wide audit
 * (`bun run audit`). One definition, two callers. The customer names are read from
 * outside the repository at build time, so this check is only as good as the machine
 * it runs on — hence the count in the summary line and the warning when none loaded.
 */
const customers = customerNames();
if (customers.state === "unreadable") {
  fail(`could not read the customer-name list (${customers.error}): ${customers.file}`);
}
const SECRETS: readonly { pattern: RegExp; why: string }[] = [
  ...MACHINE,
  ...CREDENTIALS,
  ...customers.names.map(customerPattern),
];

function read(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

function fail(message: string, work?: string): never {
  if (work) fs.rmSync(work, { recursive: true, force: true });
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Every file under `dir`, as paths relative to `dir`. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs));
  }
  return out.sort();
}

/**
 * Run `bun` and fail loudly on a non-zero exit. `cwd` defaults to a throwaway dir (see
 * the header); the bundle step passes the repo root.
 */
function bun(args: string[], work: string, what: string, inRoot = false): void {
  const cwd = inRoot ? ROOT : fs.mkdtempSync(path.join(work, "cwd-"));
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf-8" });
  if (!inRoot) fs.rmSync(cwd, { recursive: true, force: true });
  if (r.status !== 0)
    fail(`${what} failed:\n${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`, work);
}

// ---- inputs -----------------------------------------------------------------

const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith("--") && (onlyAt < 0 || i !== onlyAt + 1));
const targets = only ? TARGETS.filter((t) => `${t.os}-${t.arch}` === only) : TARGETS;
if (targets.length === 0) {
  fail(`--only ${only}: unknown target — ${TARGETS.map((t) => `${t.os}-${t.arch}`).join(", ")}`);
}

const manifest = JSON.parse(read(path.join(ROOT, "package.json"))) as Record<string, unknown>;
const version = manifest.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  fail(`package.json version is not valid: ${String(version)}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pkg-"));

// ---- bundle once, audit what will ship --------------------------------------

const bundleDir = path.join(work, "bundle");
bun(["build", "src/server.ts", "--target=bun", "--outdir", bundleDir], work, "bundle", true);
const bundled = walk(bundleDir);
if (bundled.length !== 1 || !bundled[0]?.endsWith(".js")) {
  fail(`the bundle is not one file: ${bundled.join(", ")}`, work);
}
const bundle = path.join(bundleDir, bundled[0] as string);
const readme = read(path.join(ROOT, "README.md"));

const violations: string[] = [];
for (const [label, body] of [
  ["bundle.js", read(bundle)],
  ["README.md", readme],
] as const) {
  // Masked exactly as the repository audit masks it: the published slug (package.json `repository`) is
  // public by definition, and the README carries the install URL that cannot omit it.
  const text = maskPublicSlug(body);
  // The reason is named; the match is redacted to three characters. A build log that
  // prints the secret in full to prove it found one has published it again.
  for (const { pattern, why } of SECRETS) {
    const m = pattern.exec(text);
    if (m) violations.push(`${label} — ${why} [${(m[0] ?? "").trim().slice(0, 3)}…]`);
  }
}
if (violations.length > 0) {
  console.error("✗ Leak audit failed — no archive was made:");
  for (const v of violations) console.error(`    ${v}`);
  fail("audit failed", work);
}

// ---- compile and archive, per target ----------------------------------------

const outDir = positional[0] ? path.resolve(positional[0]) : path.join(ROOT, "dist");
fs.mkdirSync(outDir, { recursive: true });
const written: string[] = [];
for (const t of targets) {
  const stage = path.join(work, `${t.os}-${t.arch}`, "aidlc-dashboard");
  fs.mkdirSync(stage, { recursive: true });
  bun(
    [
      "build",
      bundle,
      "--compile",
      `--target=${t.bun}`,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      path.join(stage, t.exe),
    ],
    work,
    `${t.os}-${t.arch} compile`,
  );
  fs.writeFileSync(path.join(stage, "README.md"), readme);
  if (t.os !== "windows") fs.chmodSync(path.join(stage, t.exe), 0o755);
  if (t.os === "darwin") {
    const exe = path.join(stage, t.exe);
    if (process.platform !== "darwin") {
      fail(
        `${t.os}-${t.arch}: signing needs macOS codesign — build on a Mac, or pick other targets with --only`,
        work,
      );
    }
    const sign = spawnSync("codesign", ["--force", "--sign", "-", exe], { encoding: "utf-8" });
    const check = spawnSync("codesign", ["--verify", "--strict", exe], { encoding: "utf-8" });
    if (sign.status !== 0 || check.status !== 0) {
      fail(
        `${t.os}-${t.arch}: ad-hoc signing failed — ${(check.stderr || sign.stderr || "").trim()}`,
        work,
      );
    }
  }

  const staged = walk(stage).map((rel) => rel.split(path.sep).join("/"));
  for (const rel of staged) {
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(rel)) violations.push(`${t.os}-${t.arch}/${rel} — ${why}`);
    }
  }
  if (violations.length > 0) {
    console.error("✗ Forbidden files — no archive was made:");
    for (const v of violations) console.error(`    ${v}`);
    fail("audit failed", work);
  }
  if (JSON.stringify(staged) !== JSON.stringify(["README.md", t.exe].sort())) {
    fail(`${t.os}-${t.arch}: unexpected contents — ${staged.join(", ")}`, work);
  }

  const out = path.join(outDir, `aidlc-dashboard-${version}-${t.os}-${t.arch}.zip`);
  fs.rmSync(out, { force: true });
  const zip = spawnSync("zip", ["-rq", out, "aidlc-dashboard"], { cwd: path.dirname(stage) });
  if (zip.status !== 0)
    fail(`zip failed (${t.os}-${t.arch}): ${zip.stderr?.toString() ?? ""}`, work);
  written.push(out);
}
fs.rmSync(work, { recursive: true, force: true });
const stray = fs.readdirSync(ROOT).filter((n) => n.endsWith(".bun-build"));
if (stray.length > 0) fail(`bun build left scratch files in the repo root: ${stray.join(", ")}`);

for (const out of written) {
  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`✓ ${path.basename(out)} · ${mb}MB`);
}
console.log(`  v${version} · ${written.length} target(s) → ${outDir}`);
console.log(
  `  leak audit (bundle, README): ${FORBIDDEN.length} path + ${SECRETS.length} content patterns passed${customers.names.length === 0 ? ` ⚠ no customer-name list (${customers.file}) — names not checked` : ""}`,
);
console.log("  the whole-repository audit is separate — `bun run audit`");
