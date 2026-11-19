// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// What must never appear in anything this repository publishes.
//
// ⚠️ THIS FILE IS EXEMPT FROM THE AUDIT THAT USES IT. A denylist of the things you
// are hiding is itself the secret, so `audit-repo.ts` skips this path by name — and
// skips itself too, since it names the exemption. Those two are the files no automated
// check reads; a human has to, and the audit prints both names on every run so the
// obligation is visible. Never put a real customer name, hostname, repo owner or token
// in here as a literal — not even in a comment explaining a pattern, which is a
// mistake this file has already had to correct once. Everything below is either a
// shape (`AKIA…`) or derived at runtime from the machine (`operatorNames()`,
// `siblingRemoteOwners()`, `customerNames()` — none hardcodes a name).
//
// WHY THIS EXISTS SEPARATELY FROM THE ARCHIVE AUDIT. `package.ts` inspects the staged
// zip, which by design excludes `*.test.ts` and `fixtures/`. That is correct for the
// archive and wrong for the repository: the repo is a second exposure surface and had
// nothing checking it. Measured cost of the gap — a real customer name once survived
// in `transcript-reader.test.ts` after being removed from the module beside it, and
// four run-specific strings (a retail domain noun, a registry id, a team name, a
// project name) reached test fixtures and this module's own header comments before
// anyone looked. The archive audit passed every time, and passing was read as clean.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sourceRepo } from "./set-repo";

export interface LeakPattern {
  pattern: RegExp;
  why: string;
}

/**
 * Strings that would leak the operator's machine.
 *
 * The user name `me` under `/Users/` is exempt because it is this codebase's documented
 * placeholder (the
 * picker's input hint, the slug example). Exempting it matters: an audit that cries
 * wolf on every intended example gets silenced wholesale, and then it catches
 * nothing. It earned its keep by flagging a real customer name sitting in a slug
 * example — so read every hit, never blanket-suppress one.
 */
export const MACHINE: readonly LeakPattern[] = [
  {
    pattern: /\/Users\/(?!me\/)[a-z0-9._-]+\/(Development|Desktop|Documents)\//i,
    why: "another person's home path",
  },
  ...siblingRemoteOwners().map((n) => ({
    pattern: new RegExp(
      `(^|[^a-z0-9\\uAC00-\\uD7A3])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
      "i",
    ),
    why: "owner of a private sibling repository",
  })),
  ...operatorNames().map((n) => ({
    // Same boundary as the customer patterns: a hyphen COUNTS as a boundary, because
    // the shape that actually leaks is the hyphenated slug
    // (`-Users-<name>-Development-…`) and an earlier version excluded `-`, which made
    // the pattern silently miss it. Probed both forms after fixing.
    pattern: new RegExp(
      `(^|[^a-z0-9\\uAC00-\\uD7A3])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
      "i",
    ),
    why: "operator account name",
  })),
];

/**
 * `owner/repo` the code is PUBLISHED under — `package.json`'s `repository.url`, the one
 * place `scripts/set-repo.ts` writes it — and never written here.
 *
 * WHY THIS EXISTS. The published owner is public by definition, and
 * `siblingRemoteOwners()` excludes it for that reason. But the same string is usually
 * also the operator's local account name, so `operatorNames()` flags it — and that
 * collision only became visible when something had to NAME the published repo:
 * `install.sh` and the README carried `github.com/<owner>/<repo>` install URLs, which
 * cannot work without it. The audit failed on its own installer.
 *
 * It used to be read from `origin`, which was the published remote until the canonical
 * copy moved to an internal mirror (2026-11). From then `origin` names where the code is
 * KEPT, not where it is published, and the installers' URLs read as the operator's name.
 * The manifest says where it is published, and it is the same value every other copy is
 * held to (`src/test/repo-address.test.ts`).
 *
 * So the exception is as narrow as the fact justifying it: only that exact
 * `<owner>/<repo>` is excused, and only where it appears verbatim. The operator's name
 * anywhere ELSE — a home path, a hyphenated slug, a stray mention — still hits, which is
 * what the pattern is for. With no readable `repository.url` the mask is empty and
 * nothing is excused.
 */
export function publicRepoSlug(): string | undefined {
  try {
    return sourceRepo(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Blank out the published `owner/repo` so the patterns do not fire on it. Callers run
 * this per line BEFORE matching; the replacement keeps the line's length so reported
 * column/line numbers stay truthful.
 */
export function maskPublicSlug(line: string): string {
  const slug = SLUG;
  if (slug === undefined) return line;
  return line.split(slug).join("\u0000".repeat(slug.length));
}

/** Resolved once — one `git` call per process, not per line. */
const SLUG: string | undefined = publicRepoSlug();

/**
 * The operator's own account name, derived at runtime — never written here.
 *
 * It used to be a literal, which meant this file published the very string the audit
 * was looking for. That was not a leak (21 commit author lines carry the same name),
 * but it was incoherent: the check flagged its own repository. Deriving it also makes
 * the audit correct on someone else's machine instead of only on one.
 *
 * The generic home-path pattern above already catches `/Users/<anyone>/Development/`
 * regardless of name; these add the BARE name, which is how a username reaches a
 * comment or a slug without a slash in front of it.
 */
function operatorNames(): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    const n = (v ?? "").trim().toLowerCase();
    // 4 chars is the floor that keeps `ci`, `me` and `dev` out of the pattern set.
    if (n.length >= 4 && /^[a-z0-9][a-z0-9._-]*$/.test(n) && n !== "user" && n !== "root")
      out.add(n);
  };
  try {
    add(os.userInfo().username);
  } catch {
    // No passwd entry (some containers). The home-path pattern still applies.
  }
  for (const key of ["user.name", "user.email"]) {
    const r = spawnSync("git", ["config", "--get", key], { encoding: "utf-8" });
    const v = r.status === 0 ? r.stdout : "";
    add(key === "user.email" ? v.split("@")[0] : v);
  }
  return [...out].sort();
}

/**
 * Owners of every remote EXCEPT the published one — the private siblings and internal
 * mirrors this public repository must not name. Derived, never written here, for the same reason the
 * operator name is: a literal would publish the string the audit looks for.
 *
 * The published owner (`publicRepoSlug()`) is public by definition and is excluded (it
 * is also already covered by `operatorNames()` when the two coincide). Every OTHER
 * remote's owner is a sibling — a private archive, a fork, an internal mirror,
 * `origin` included when `origin` is the mirror — and naming it in a public file
 * discloses a repository the reader was not meant to know exists.
 *
 * This gap was found by a note file, not by the audit: an untracked `MIGRATION.md` at
 * the root recorded the private archive remote as its origin and the audit passed it,
 * although a private sibling repository's name is itself sensitive. The file is ignored now; this is the pattern that would have caught it.
 * (The owner is deliberately not quoted here — writing it would be the leak.)
 *
 * Blind on a fresh clone with only `origin`, exactly like the customer list — the
 * count printed by `audit-repo.ts` is what says so.
 */
function siblingRemoteOwners(): string[] {
  const r = spawnSync("git", ["remote", "-v"], {
    cwd: path.join(import.meta.dir, ".."),
    encoding: "utf-8",
  });
  if (r.status !== 0) return [];
  // Both SSH (`git@host:owner/repo.git`) and HTTPS (`https://host/owner/repo`).
  const ownerOf = (url: string): string | undefined =>
    /[:/]([a-z0-9][a-z0-9._-]*)\/[^/]+?(?:\.git)?$/i.exec(url)?.[1]?.toLowerCase();
  const published = new Set<string>([(publicRepoSlug() ?? "").split("/")[0]?.toLowerCase() ?? ""]);
  const siblings = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const [, url] = line.trim().split(/\s+/);
    if (!url) continue;
    const owner = ownerOf(url);
    // 4 chars is the same floor operatorNames() uses — keeps a stub owner out.
    if (owner === undefined || owner.length < 4) continue;
    siblings.add(owner);
  }
  for (const o of published) siblings.delete(o);
  return [...siblings].sort();
}

/**
 * Credential SHAPES, not values. Cheap to check and the one class of leak that is
 * immediately exploitable rather than merely embarrassing.
 */
export const CREDENTIALS: readonly LeakPattern[] = [
  { pattern: /\bghp_[A-Za-z0-9]{20,}/, why: "GitHub personal access token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, why: "GitHub fine-grained token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS access key id" },
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, why: "API key" },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, why: "private key" },
];

/**
 * The customer-name list: a file outside every repository, one name per line.
 *
 * It used to be derived from the sub-directory names of one work-tree root, which
 * assumed every customer's work sits under that root and every directory there is a
 * customer. Neither held — customer work is spread across several trees, and a tree
 * mixing customer dirs with ordinary ones turns ordinary words into patterns (the
 * "audit that cries wolf gets silenced" failure the note on the `me` placeholder above warns
 * about). A list the person writes is the one source that says exactly which names
 * matter. The path is generic, not one machine's layout, so it can stand in public code.
 */
export function customerNamesFile(home: string = os.homedir()): string {
  return path.join(home, ".config", "aidlc-dashboard", "customer-names");
}

export interface CustomerSource {
  /** Names read, lower-cased and de-duplicated. NEVER printed. */
  names: string[];
  /** The file read, so the report can say where to write names. */
  file: string;
  /**
   * `missing` and a `read` with no names are a blind pass (static patterns only);
   * `unreadable` is a configured source the audit could not read, which fails it —
   * a read failure is never swallowed.
   */
  state: "read" | "missing" | "unreadable";
  /** Why an `unreadable` file could not be read. */
  error?: string;
}

/**
 * Read the customer names. The list cannot live in this repository: it is public, and
 * an inventory of customer names is precisely the thing being protected. So the audit
 * is only as complete as this file — which is why both callers print the COUNT they
 * loaded and say loudly when it is zero. A blind pass is not a pass.
 *
 * Names are matched whole (see `customerPattern`); no stem or prefix is derived, because
 * stemming a real name onto a common English word once hit **57 lines** of ordinary
 * HTML and CSS. Never cite a real name here as an example — this file is exempt from
 * the static patterns, but not from the customer ones.
 */
export function customerNames(file: string = customerNamesFile()): CustomerSource {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { names: [], file, state: "missing" };
    return { names: [], file, state: "unreadable", error: code ?? String(e) };
  }
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const n = line.replace(/#.*/, "").trim().toLowerCase();
    if (n !== "") names.add(n);
  }
  return { names: [...names].sort(), file, state: "read" };
}

/**
 * One name as a pattern. Word-ish boundary: `acme` must match `Acme` and
 * `acme-web-next` but not a longer unrelated word. Korean text has no `\b`, hence the
 * explicit class on the leading side.
 */
export function customerPattern(name: string): LeakPattern {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    pattern: new RegExp(`(^|[^a-z0-9\\uAC00-\\uD7A3])${escaped}([^a-z0-9]|$)`, "i"),
    why: "customer identifier",
  };
}
