// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// The harness's agent definitions: who the engine COULD send, never who it did.
//
// WHICH FILE. Every 2.11.4 harness ships `<harness>/agents/aidlc-*.md` with YAML
// frontmatter (`name`, `display_name`, `description`); only Kiro CLI adds a `.json` per
// agent and only Codex a `.toml`. Measured over the local trees: 42 of 46 harness dirs
// carry the `.md`, 4 the `.json`. A reader of the `.json` alone shows an empty roster on
// every harness but one, so the `.md` frontmatter is read, from whichever harness dir the
// stage catalogue was found in — the same open set scan/stage-catalog.ts discovers.
//
// TIERS. `<harness>/tools/data/agent-tiers.json` maps an agent's short name (`architect`
// for `aidlc-architect-agent`) to `judgment` | `balanced` | `templated` — the kind of work
// the engine projects onto a model and effort (`tools/aidlc-tiers.ts`). Shown as the
// agent's declared tier; nothing here says which model actually ran.
//
// A missing or unreadable file is no definition, not an error: the Agents tab is built
// from the ledger, and the catalogue only names what the ledger records.

import * as fs from "node:fs";
import * as path from "node:path";

export type AgentTier = "judgment" | "balanced" | "templated";

export interface AgentDefinition {
  /** Frontmatter `name` (else the file stem), e.g. `aidlc-architect-agent` — the value the ledger records. */
  slug: string;
  displayName?: string;
  description?: string;
  tier?: AgentTier;
}

export interface AgentCatalog {
  agents: Map<string, AgentDefinition>;
  /** Short name → tier, for an agent the stage graph names but no `.md` describes. */
  tiers: Map<string, AgentTier>;
  /** Newest mtime among the files read — this source's age on the sources line. */
  asOf?: string;
}

const TIERS = new Set<string>(["judgment", "balanced", "templated"]);

/** `aidlc-architect-agent` → `architect`, the key `agent-tiers.json` uses. */
export function agentShortName(slug: string): string {
  return slug.replace(/^aidlc-/, "").replace(/-agent$/, "");
}

/**
 * The top-level scalars of a leading `---` frontmatter block. Enough YAML for these
 * files: `key: value`, quoted values, and `>` / `|` block scalars (folded with spaces,
 * literal with newlines). Nested keys and lists are skipped.
 */
export function frontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const out: Record<string, string> = {};
  let i = 1;
  while (i < lines.length && lines[i]?.trim() !== "---") {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i] ?? "");
    i++;
    if (!m) continue;
    const key = m[1]!;
    const raw = m[2]!.trim();
    const block = /^([>|])[+-]?$/.exec(raw);
    if (block) {
      const body: string[] = [];
      while (i < lines.length && lines[i]?.trim() !== "---" && /^(\s+|$)/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").trim());
        i++;
      }
      const kept = body.filter((l, k) => l !== "" || k < body.length - 1);
      out[key] = (block[1] === ">" ? kept.join(" ") : kept.join("\n")).trim();
      continue;
    }
    out[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function mtimeIso(p: string): string | undefined {
  try {
    return fs
      .statSync(p)
      .mtime.toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  } catch {
    return undefined;
  }
}

function readTiers(file: string): Map<string, AgentTier> | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const tiers = new Map<string, AgentTier>();
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v === "string" && TIERS.has(v)) tiers.set(k, v as AgentTier);
  }
  return tiers;
}

/** The agent definitions in `<root>/<harnessDir>`, or undefined when it ships none. */
export function readAgentCatalog(root: string, harnessDir: string): AgentCatalog | undefined {
  const base = path.join(root, harnessDir);
  const agentsDir = path.join(base, "agents");
  const tiersFile = path.join(base, "tools", "data", "agent-tiers.json");
  const agents = new Map<string, AgentDefinition>();
  const stamps: string[] = [];

  let names: string[] = [];
  try {
    names = fs.readdirSync(agentsDir).filter((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    const file = path.join(agentsDir, name);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    // The engine's agent identity is the frontmatter `name`; the stem only stands in when
    // a file has none (they are equal in every shipped harness, not by any rule).
    const slug = fm.name || name.replace(/\.md$/, "");
    agents.set(slug, {
      slug,
      ...(fm.display_name ? { displayName: fm.display_name } : {}),
      ...(fm.description ? { description: fm.description } : {}),
    });
    const t = mtimeIso(file);
    if (t) stamps.push(t);
  }

  const tiers = readTiers(tiersFile);
  if (tiers) {
    const t = mtimeIso(tiersFile);
    if (t) stamps.push(t);
    for (const def of agents.values()) {
      const tier = tiers.get(agentShortName(def.slug));
      if (tier) def.tier = tier;
    }
  }

  if (agents.size === 0 && !tiers) return undefined;
  const asOf = stamps.sort().at(-1);
  return { agents, tiers: tiers ?? new Map(), ...(asOf ? { asOf } : {}) };
}
