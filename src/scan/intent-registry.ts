// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// `intents.json` read as the 2.11.4 engine reads it — `readIntentRegistry`,
// `registryList` and `conflictSide` (aidlc-record-core.ts) over `jsoncDocumentValue`
// (aidlc-distribution.ts), transcribed. One reader for every caller here (intent
// resolution, the claim filter, the record's registry metadata), so they cannot read
// the same file differently.
//
// 2.11.0 read the file with `JSON.parse`, and so did this reader. 2.11.4 reads it as the
// person's editor may leave it — a BOM, comments, trailing commas — and, when git left it
// conflicted (two clones started work in one space), as every row of both sides once per
// uuid. A conflicted registry read as `[]` here lost its `archived` rows, so a space the
// engine resolved to its one live record read as ambiguous.
//
// Text after the list makes the whole file unreadable, never read as its first part —
// `Bun.JSONC.parse` alone stops at the first complete value, which is why the engine
// first checks the text is exactly one value (`jsoncTree`).

import * as fs from "node:fs";
import * as path from "node:path";

const BOM = "\uFEFF";
const CONFLICT_START = /^<{7}/m;

/** `skipJsoncTrivia`: past whitespace, BOMs and comments; -1 on an unclosed block comment. */
function skipTrivia(text: string, at: number): number {
  let index = at;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === BOM) {
      index++;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) return -1;
      index = end + 2;
    } else {
      break;
    }
  }
  return index;
}

/** `skipJsoncString`: past a string from its opening quote; -1 when it does not close. */
function skipString(text: string, at: number): number {
  for (let index = at + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index + 1;
    else if (text[index] === "\n") return -1;
  }
  return -1;
}

/** `skipJsoncValue` for a scalar (the only case `parseJsoncNode` hands it). */
function skipScalar(text: string, at: number): number {
  if (text[at] === '"') return skipString(text, at);
  let index = at;
  while (index < text.length && !/[\s,}\]/]/.test(text[index] ?? "")) index++;
  return index > at ? index : -1;
}

/** `parseJsoncNode`, keeping only the end offset: where the value at `at` ends, or -1. */
function valueEnd(text: string, at: number): number {
  const open = text[at];
  if (open !== "{" && open !== "[") return skipScalar(text, at);
  const close = open === "{" ? "}" : "]";
  let index = skipTrivia(text, at + 1);
  while (index >= 0 && index < text.length && text[index] !== close) {
    let start = index;
    if (open === "{") {
      if (text[index] !== '"') return -1;
      const keyEnd = skipString(text, index);
      if (keyEnd < 0) return -1;
      try {
        JSON.parse(text.slice(index, keyEnd));
      } catch {
        return -1;
      }
      index = skipTrivia(text, keyEnd);
      if (index < 0 || text[index] !== ":") return -1;
      start = skipTrivia(text, index + 1);
      if (start < 0 || start >= text.length) return -1;
    }
    const end = valueEnd(text, start);
    if (end < 0) return -1;
    index = skipTrivia(text, end);
    if (index < 0) return -1;
    if (text[index] === ",") {
      index = skipTrivia(text, index + 1);
      if (index < 0) return -1;
    } else if (text[index] !== close) {
      return -1;
    }
  }
  if (index < 0 || text[index] !== close) return -1;
  return index + 1;
}

/** `jsoncDocumentValue`: the text's value when it is exactly one JSONC value, else undefined. */
export function jsoncDocumentValue(text: string): unknown {
  const at = skipTrivia(text, 0);
  if (at < 0 || at >= text.length) return undefined;
  const end = valueEnd(text, at);
  if (end < 0 || skipTrivia(text, end) !== text.length) return undefined;
  try {
    return Bun.JSONC.parse(text.slice(at, end));
  } catch {
    return undefined;
  }
}

/** `registryList`: the list, or null when the text is not one JSONC array. */
function registryList(text: string): unknown[] | null {
  const parsed = jsoncDocumentValue(text.startsWith(BOM) ? text.slice(1) : text);
  return Array.isArray(parsed) ? parsed : null;
}

/** `conflictSide`: the text with one side of every git conflict block kept. */
function conflictSide(text: string, side: "ours" | "theirs"): string {
  const kept: string[] = [];
  let zone: "both" | "ours" | "base" | "theirs" = "both";
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("<<<<<<<")) zone = "ours";
    else if (zone !== "both" && line.startsWith("|||||||")) zone = "base";
    else if (zone !== "both" && line.startsWith("=======")) zone = "theirs";
    else if (zone !== "both" && line.startsWith(">>>>>>>")) zone = "both";
    else if (zone === "both" || zone === side) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * `readIntentRegistry`: the registry's rows as written, unvalidated, or `[]` when the file
 * is absent or nothing can read it. Never throws.
 */
export function readRegistryRows(intentsDir: string): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(intentsDir, "intents.json"), "utf-8");
  } catch {
    return [];
  }
  const whole = registryList(text);
  if (whole !== null) return whole;
  if (!CONFLICT_START.test(text)) return [];
  const rows: unknown[] = [];
  const seen = new Set<string>();
  for (const side of ["ours", "theirs"] as const) {
    for (const entry of registryList(conflictSide(text, side)) ?? []) {
      const uuid = (entry as { uuid?: unknown } | null)?.uuid;
      const key = typeof uuid === "string" ? uuid : JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(entry);
    }
  }
  return rows;
}
