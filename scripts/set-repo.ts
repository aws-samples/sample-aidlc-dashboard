// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Where this project's GitHub repository lives, said in ONE place and copied to the rest.
//
//   bun run set-repo <owner>/<name>
//
// `package.json`'s `repository.url` is the source, and the leak audit's mask reads it
// (`scripts/leak-patterns.ts`). Any other file that names the repository is listed in
// REPO_FILES, `src/test/repo-address.test.ts` holds every copy to the source, and this
// script rewrites them all, so a move (a personal account to aws-samples, say) changes
// every copy at once.
//
// The installers named it too, to download release assets, until 2026-11-19: the security
// review asked for that path to go (no checksum check), so they install a local archive only
// and name no repository. A download path comes back only with checksum verification.

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");

/** The files that name the repository, relative to the root. */
// README.md is not in the list while there is no public repository (2026-11-17, the owner's call):
// the address it named was deleted, so its install section clones and builds instead and names no
// address at all. When the public repository exists, restore README's release install (the one-liners
// and the Releases link) and put README.md back here, so this script and the test hold it again.
export const REPO_FILES = ["package.json"] as const;

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `owner/name` out of `package.json`'s `repository.url`. */
export function sourceRepo(pkgText: string): string {
  const url = (JSON.parse(pkgText) as { repository?: { url?: string } }).repository?.url ?? "";
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!m?.[1]) throw new Error(`repository.url is not a github.com URL: ${JSON.stringify(url)}`);
  return m[1];
}

/** Every `owner/name` a file names the repository by in a github.com URL. */
export function repoMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
    if (m[1]) out.push(m[1].replace(/\.git$/, ""));
  }
  return out;
}

/** `text` with every mention of `from` pointed at `to`. Byte-preserving otherwise (CRLF kept). */
export function rewriteRepo(text: string, from: string, to: string): string {
  return text.split(from).join(to);
}

if (import.meta.main) {
  const to = process.argv[2] ?? "";
  if (!SLUG.test(to)) {
    console.error("usage: bun run set-repo <owner>/<name>");
    process.exit(2);
  }
  const from = sourceRepo(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  if (from === to) {
    console.log(`already ${to}`);
    process.exit(0);
  }
  for (const rel of REPO_FILES) {
    const abs = path.join(ROOT, rel);
    // latin1 round-trips every byte, so a UTF-8 file is rewritten without being decoded.
    const before = fs.readFileSync(abs, "latin1");
    const after = rewriteRepo(before, from, to);
    if (after !== before) fs.writeFileSync(abs, after, "latin1");
    console.log(`${rel}: ${before.split(from).length - 1}`);
  }
  console.log(`${from} → ${to}`);
}
