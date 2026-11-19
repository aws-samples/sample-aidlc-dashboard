// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// Which audit rows belong to the team claim attempt this checkout is on — a
// transcription of the 2.11.4 engine's `eventMatchesClaimAttempt` (aidlc-lib.ts) with
// the readers it stands on: `isTeamUnitOwnership`, `applicableTeamUnitScopeStamp` /
// `readUnitScopeStamp`, `readClaimGenerations` / `claimGenerationKey`, and
// `activeIntentUuid` over `listIntents`.
//
// Under team ownership the engine runs the same floor and reduction over a unit's
// lifecycle rows as everywhere else, plus this one filter on those rows only. Two
// checkout-local files decide it, both under the workspace roof `aidlc/`:
//
//   - `.aidlc-unit-scope.json`, the unit scope stamp. When it is well-formed AND names
//     the active space and the active intent's uuid, it is APPLICABLE: only rows of its
//     own unit pass, and only with `Attempt Generation` equal to its generation.
//   - `.aidlc-claim-generations.json`, `{"<space>/<intent uuid|legacy>/<unit>": n}`.
//     With no applicable stamp, a row carrying `Attempt Generation` passes only when it
//     equals the unit's recorded generation; a row with none, or a unit with none
//     recorded, passes.
//
// Both readers are total in the engine: an absent, unreadable or malformed file reads
// as no stamp / no generations, and so it does here — that is the engine's own answer
// in this checkout, not a guess. What the engine can THROW on is the intent
// identity, and each throw is an `unknown` here, not a verdict:
//
//   - the record's own resolution (`activeIntent`, under `readStateFile`): with no
//     cursor, every registry row is joined (`recordDirMatches`) and its `status` read
//     (`isArchivedIntent`), so a `null` row or a status that is not a string raises. The
//     filter's own catch then returns TRUE, but every engine reader around it — the
//     audit, the state, the gate rhythm — fails the same way, so there is no engine
//     verdict for this record to match, and none is claimed;
//   - the intent's uuid (`activeIntentUuid` over `listIntents`), which joins every row
//     again; and the generation key, whose template literal throws on a uuid that is
//     not stringable (`{"toString": null}`). Only a path that REACHES one is unknown.
//
// The active intent is read as the engine reads it, from the raw cursor string: a cursor
// of `./<dir>` names the same state file, but `activeIntentUuid` compares it with the
// record's dir name exactly, finds no row, and reads no uuid — so the stamp does not apply
// and generations are keyed `legacy`. The record dir's own name would apply them.
//
// The stamp's own claim check (`liveClaimPayload` against the claim refs in git) belongs
// to the commands that act on a claim, not to this filter, and is not read.
//
// Two 2.11.4 changes. Under an applicable stamp, a row of ANOTHER unit is no longer
// dropped: it passes by that unit's own generation entry, as with no stamp. And a stamp
// stops applying once its claim has landed (`scopeStampLanded`): its unit's `## Unit
// Progress` row is Merged `[x]`, its `claim_oid` is a hex object id, and `git merge-base
// --is-ancestor <claim_oid> HEAD` succeeds. This reader runs no git (the owner's call,
// 2026-11-16), so when the first two hold it judges each row both ways — the stamp
// applying and not — and only a row the two readings disagree on is `landing-unknown`.

import * as fs from "node:fs";
import * as path from "node:path";
import { readRegistryRows } from "./intent-registry";
import { readCursorText } from "./main-checkout";
import { ACTIVE_INTENT_POINTER, activeSpace } from "./resolve";
import { stateField } from "./unit-artifact-mode";

/**
 * A row passes, is dropped, reaches a read the engine would throw on (`unknown`), or
 * turns on whether the stamp's claim has landed in git, which this reader does not run
 * (`landing-unknown`).
 */
export type ClaimVerdict = boolean | "unknown" | "landing-unknown";

/** `eventMatchesClaimAttempt(projectDir, block, unit)` over a parsed row's fields. */
export type ClaimFilter = (
  fields: Record<string, string>,
  unit: string | undefined,
) => ClaimVerdict;

/** The fields of a well-formed stamp this reader uses (`UnitScopeStamp`). */
export interface ScopeStamp {
  space: string;
  intent_uuid: string;
  unit: string;
  generation: number;
  gate_rhythm: "per-stage" | "unit-end";
  /** The claimed commit, for `scopeStampLanded`. */
  claim_oid: string;
}

/** The active intent's uuid as `activeIntentUuid` returns it, or a registry it throws on. */
export type IntentUuid = { ok: true; value: unknown } | { ok: false };

/** Everything the filter reads, so the rule can be exercised without a checkout. */
export interface ClaimInputs {
  /** `isTeamUnitOwnership(state)`. */
  team: boolean;
  /** `readUnitScopeStamp`: a well-formed stamp, or null. */
  stamp: ScopeStamp | null;
  /** `readClaimGenerations`: positive-integer entries only. */
  generations: Record<string, number>;
  /** `activeSpace`. */
  space: string;
  /** `activeIntentUuid` — read lazily by the engine, so only reached paths can fail. */
  uuid: () => IntentUuid;
  /** `activeIntent` resolves without throwing (`readStateFile` would). Default true. */
  resolves?: () => boolean;
  /** The state text, for `scopeStampLanded`'s `unitRowMerged`. Absent: nothing merged. */
  stateText?: string;
}

/** `isTeamUnitOwnership`: `getField(state, "Unit Ownership")?.trim() === "team"`. */
export function isTeamUnitOwnership(stateText: string): boolean {
  return stateField(stateText, "Unit Ownership") === "team";
}

/** `readUnitScopeStamp`'s validation, field for field; anything else is no stamp. */
export function parseScopeStamp(text: string): ScopeStamp | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const s = parsed as Record<string, unknown>;
  const str = (k: string) => typeof s[k] === "string";
  const generation = s.generation;
  if (
    s.version !== 1 ||
    !str("space") ||
    !str("intent_uuid") ||
    !str("intent_id8") ||
    !str("unit") ||
    !str("owner") ||
    !Number.isInteger(generation) ||
    ((generation as number | undefined) ?? 0) < 1 ||
    !str("nonce") ||
    !str("claim_ref") ||
    !str("claim_oid") ||
    !str("claimed_from_oid") ||
    !str("integration_ref") ||
    (s.gate_rhythm !== "per-stage" && s.gate_rhythm !== "unit-end") ||
    (s.audit_shard !== undefined &&
      (typeof s.audit_shard !== "string" || !/^[A-Za-z0-9._-]+\.md$/.test(s.audit_shard)))
  ) {
    return null;
  }
  return {
    space: s.space as string,
    intent_uuid: s.intent_uuid as string,
    unit: s.unit as string,
    generation: generation as number,
    gate_rhythm: s.gate_rhythm,
    claim_oid: s.claim_oid as string,
  };
}

/** `readClaimGenerations`: the entries whose value is a positive integer; else `{}`. */
export function parseClaimGenerations(text: string): Record<string, number> {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          Number.isInteger(entry[1]) && (entry[1] as number) > 0,
      ),
    );
  } catch {
    return {};
  }
}

/**
 * `recordDirMatches` as the engine runs it on an unvalidated registry row — including the
 * dereferences that throw. Kept literal on purpose: an emulation of the coercions is where
 * a transcription goes wrong.
 */
// biome-ignore lint/suspicious/noExplicitAny: the engine's own unchecked row access
function engineRecordDirMatches(entry: any, dirName: string): boolean {
  if (entry.dirName) return entry.dirName === dirName;
  if (!dirName.startsWith(`${entry.slug}-`)) return false;
  const suffix = dirName.slice(entry.slug.length + 1);
  return (
    /^[0-9a-f]+$/.test(suffix) && entry.uuid.replace(/-/g, "").slice(-suffix.length) === suffix
  );
}

/**
 * `activeIntentUuid(projectDir, space)` for the record this page reads: `listIntents` maps
 * EVERY registry row to its first matching record dir (so any row can throw), appends the
 * orphan dirs with an empty uuid, and the first entry on the active dir gives a truthy uuid
 * or null.
 */
export function activeIntentUuid(
  registry: readonly unknown[],
  recordDirs: readonly string[],
  activeDir: string | null,
): IntentUuid {
  try {
    const claimed = new Set<string>();
    const infos: { uuid: unknown; dirName: string | null }[] = registry.map((entry) => {
      const dirName = recordDirs.find((d) => engineRecordDirMatches(entry, d)) ?? null;
      if (dirName) claimed.add(dirName);
      // biome-ignore lint/suspicious/noExplicitAny: the engine's own unchecked row access
      return { uuid: (entry as any).uuid, dirName };
    });
    for (const d of recordDirs) if (!claimed.has(d)) infos.push({ uuid: "", dirName: d });
    if (activeDir === null) return { ok: true, value: null };
    const match = infos.find((i) => i.dirName === activeDir);
    return { ok: true, value: match?.uuid ? match.uuid : null };
  } catch {
    return { ok: false };
  }
}

/** The active intent dir as `activeIntent` returns it, or a registry it throws on. */
export type ActiveIntent = { ok: true; dir: string | null } | { ok: false };

/**
 * `activeIntent(projectDir, space)` with no explicit intent: the raw `active-intent`
 * cursor (trimmed) when it names a dir holding `aidlc-state.md`, else the one record
 * whose registry row (if any) is not archived — `isArchivedIntent` trims the status,
 * which throws on a status that is not a string.
 */
export function activeIntent(
  cursor: string | undefined,
  registry: readonly unknown[],
  recordDirs: readonly string[],
  hasState: (dir: string) => boolean,
): ActiveIntent {
  const raw = (cursor ?? "").trim();
  if (raw.length > 0 && hasState(raw)) return { ok: true, dir: raw };
  try {
    const live = recordDirs.filter((d) => {
      const row = registry.find((entry) => engineRecordDirMatches(entry, d));
      // biome-ignore lint/suspicious/noExplicitAny: the engine's own unchecked row access
      return row === undefined || (row as any).status.trim().toLowerCase() !== "archived";
    });
    return { ok: true, dir: live.length === 1 ? (live[0] ?? null) : null };
  } catch {
    return { ok: false };
  }
}

/**
 * `unitRowMerged`: the unit's one `## Unit Progress` row (a row with the header's cell
 * count) carries `[x]` in the `Merged` column.
 */
export function unitRowMerged(stateText: string, unit: string): boolean {
  const heading = /^## Unit Progress\s*$/m.exec(stateText);
  if (!heading) return false;
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(stateText.slice(after));
  const rows = stateText
    .slice(after, next ? after + next.index : stateText.length)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const header = rows.find((cells) => cells[0]?.toLowerCase() === "unit");
  const mergedIndex = header?.findIndex((cell) => cell.toLowerCase() === "merged") ?? -1;
  if (!header || mergedIndex < 0) return false;
  const own = rows.filter((cells) => cells.length === header.length && cells[0] === unit);
  return own.length === 1 && own[0]?.[mergedIndex] === "[x]";
}

/** What the stamp is for this checkout: absent, unknowable, applying, or applying unless landed. */
type StampState =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "applies"; stamp: ScopeStamp }
  | { kind: "unless-landed"; stamp: ScopeStamp };

function stampState(c: ClaimInputs): StampState {
  if (!c.team) return { kind: "none" };
  if (c.resolves && !c.resolves()) return { kind: "unknown" };
  if (!c.stamp) return { kind: "none" };
  const uuid = c.uuid();
  if (!uuid.ok) return { kind: "unknown" };
  if (!uuid.value || c.stamp.space !== c.space || c.stamp.intent_uuid !== uuid.value) {
    return { kind: "none" };
  }
  // `scopeStampLanded`'s two readable conditions; the third is a git ancestry check.
  const mayHaveLanded =
    unitRowMerged(c.stateText ?? "", c.stamp.unit) && /^[0-9a-f]{40,64}$/.test(c.stamp.claim_oid);
  return { kind: mayHaveLanded ? "unless-landed" : "applies", stamp: c.stamp };
}

/**
 * `applicableTeamUnitScopeStamp`: the stamp when team-owned, it names this intent and it
 * has not landed; `unknown` when the engine would throw or when landing needs git.
 */
export function applicableStamp(c: ClaimInputs): ScopeStamp | null | "unknown" {
  const st = stampState(c);
  if (st.kind === "none") return null;
  if (st.kind === "applies") return st.stamp;
  return "unknown";
}

/** The generation rule for a row of `unit` with no stamp over it. */
function byGeneration(c: ClaimInputs, fields: Record<string, string>, unit: string): ClaimVerdict {
  const eventGeneration = fields["Attempt Generation"];
  if (eventGeneration === undefined) return true;
  const uuid = c.uuid();
  if (!uuid.ok) return "unknown";
  let key: string;
  try {
    key = `${c.space}/${String(uuid.value ?? "legacy")}/${unit}`;
  } catch {
    // `claimGenerationKey`'s template literal throws on an unstringable uuid too.
    return "unknown";
  }
  const generation = Object.hasOwn(c.generations, key) ? c.generations[key] : undefined;
  return generation === undefined ? true : eventGeneration === String(generation);
}

/** `eventMatchesClaimAttempt` with no applicable stamp. */
function withoutStamp(
  c: ClaimInputs,
  fields: Record<string, string>,
  unit: string | undefined,
): ClaimVerdict {
  return unit ? byGeneration(c, fields, unit) : true;
}

/** `eventMatchesClaimAttempt` under an applicable stamp (2.11.4). */
function withStamp(
  c: ClaimInputs,
  stamp: ScopeStamp,
  fields: Record<string, string>,
  unit: string | undefined,
): ClaimVerdict {
  const eventUnit = fields.Unit;
  const other =
    unit !== undefined && unit !== stamp.unit
      ? unit
      : unit === undefined && eventUnit !== undefined && eventUnit !== stamp.unit
        ? eventUnit
        : null;
  if (other !== null) return byGeneration(c, fields, other);
  if (eventUnit !== undefined && eventUnit !== stamp.unit) return false;
  return fields["Attempt Generation"] === String(stamp.generation);
}

/** `eventMatchesClaimAttempt`, given the record's readers. */
export function claimFilter(c: ClaimInputs): ClaimFilter {
  return (fields, unit) => {
    const st = stampState(c);
    if (st.kind === "unknown") return "unknown";
    if (st.kind === "none") return c.team ? withoutStamp(c, fields, unit) : true;
    const applied = withStamp(c, st.stamp, fields, unit);
    if (st.kind === "applies") return applied;
    const landed = withoutStamp(c, fields, unit);
    if (applied === landed) return applied;
    return applied === "unknown" || landed === "unknown" ? "unknown" : "landing-unknown";
  };
}

/**
 * `effectiveUnitGateRhythm`: an applicable stamp's `gate_rhythm`, else the state's
 * `Unit Gate Rhythm` (`unit-end` only under team ownership, else `per-stage`).
 */
export function unitGateRhythm(
  c: ClaimInputs,
  stateText: string,
): "per-stage" | "unit-end" | "unknown" {
  const st = stampState(c);
  if (st.kind === "unknown") return "unknown";
  if (st.kind === "applies") return st.stamp.gate_rhythm;
  const fromState = !c.team
    ? "per-stage"
    : stateField(stateText, "Unit Gate Rhythm") === "unit-end"
      ? "unit-end"
      : "per-stage";
  if (st.kind === "none") return fromState;
  return st.stamp.gate_rhythm === fromState ? fromState : "unknown";
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** Record dirs as `listIntentDirs` lists them: those holding `aidlc-state.md`, sorted. */
function recordDirsOf(intentsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(intentsDir);
  } catch {
    return [];
  }
  return names.filter((n) => fs.existsSync(path.join(intentsDir, n, "aidlc-state.md"))).sort();
}

/** The engine's `readIntentRegistry`: the raw rows, unvalidated, or `[]`. */
function rawRegistry(intentsDir: string): unknown[] {
  return readRegistryRows(intentsDir);
}

/**
 * The checkout's claim inputs under `root`, for the state text the page reads. Reads only;
 * the cursor, registry and record list are read once, and only if the filter reaches them.
 */
export function readClaimInputs(root: string, stateText: string): ClaimInputs {
  const roof = path.join(root, "aidlc");
  const space = activeSpace(root);
  const intentsDir = path.join(roof, "spaces", space, "intents");
  const stampText = readText(path.join(roof, ".aidlc-unit-scope.json"));
  const generationsText = readText(path.join(roof, ".aidlc-claim-generations.json"));
  let identity: { active: ActiveIntent; uuid: IntentUuid } | undefined;
  const read = () => {
    if (identity) return identity;
    const registry = rawRegistry(intentsDir);
    const dirs = recordDirsOf(intentsDir);
    const active = activeIntent(
      readCursorText(
        root,
        path.posix.join("aidlc", "spaces", space, "intents", ACTIVE_INTENT_POINTER),
      ),
      registry,
      dirs,
      (d) => fs.existsSync(path.join(intentsDir, d, "aidlc-state.md")),
    );
    // `listIntents` calls `activeIntent` again, so a throw there is a throw here too.
    const uuid: IntentUuid = active.ok
      ? activeIntentUuid(registry, dirs, active.dir)
      : { ok: false };
    identity = { active, uuid };
    return identity;
  };
  return {
    team: isTeamUnitOwnership(stateText),
    stamp: stampText === undefined ? null : parseScopeStamp(stampText),
    generations: generationsText === undefined ? {} : parseClaimGenerations(generationsText),
    space,
    uuid: () => read().uuid,
    resolves: () => read().active.ok,
    stateText,
  };
}
