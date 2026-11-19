// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * UsageParser — a pure function that defensively parses the raw `/usage` string (BR2.1–BR2.4).
 *
 * A port absorbed into the aidlc-dashboard native tree. The credit-dashboard parser logic was moved as
 * is (no new parsing or escaping utilities invented). `ParsedUsage` is a u1-owned type, so it is imported
 * from `../types`; the u2-owned fallback-contract type `ParseResult` is defined and exported here.
 *
 * Hard contract:
 * - It does not spawn the CLI (a pure function, string input only).
 * - It never throws. It returns the discriminated union `ParseResult` (BR2.1).
 * - `/usage` is uncontracted text whose format may change at any time. Many label aliases and flexible
 *   number extraction defend against that, and a format change does not crash it.
 *
 * Decision rules:
 * - empty/blank input              → `{ ok: false }` (total failure)
 * - 0 of the 6 fields extracted    → `{ ok: false }` (unrecognised, total failure)
 * - some extracted                 → `{ ok: true, partial: true }` (partial parse, BR2.3)
 * - all 6 extracted                → `{ ok: true, partial: false }` (normal)
 */

import type { ParsedUsage } from "../types";

/** Parser fallback contract: a discriminated union expressing success/failure as a value instead of an exception (BR2.1). u2-owned. */
export type ParseResult =
  | { ok: true; data: ParsedUsage }
  | { ok: false; raw: string; reason: string };

/** Strip ANSI escape sequences (defence against CLI colour codes). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to strip the ANSI escape (\x1b).
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Label aliases per field (Korean/English, case-insensitive). Earlier ones take precedence.
 * The Korean entries are matching keys for kiro-cli's own Korean output, not our wording — they stay Korean.
 */
const FIELD_LABELS = {
  planName: ["플랜명", "플랜", "plan name", "plan", "subscription", "tier"],
  usedAmount: [
    "누적 사용량",
    "누적사용량",
    "사용량",
    "credits used",
    "used credits",
    "used",
    "usage total",
  ],
  remainingAmount: [
    "남은 잔량",
    "잔량",
    "남은",
    "remaining credits",
    "remaining",
    "balance",
    "left",
  ],
  planLimit: ["플랜 한도", "한도", "credit limit", "limit", "quota", "total credits", "total"],
  usageRatio: ["사용률", "usage rate", "usage", "percent used", "percentage"],
  resetDate: [
    "리셋일",
    "리셋",
    "reset date",
    "resets on",
    "resets",
    "reset",
    "renews on",
    "renews",
  ],
} as const;

/**
 * Extract the value token after a label. Tries the `label[:=]\s*<value>` shape first, but also allows a
 * space-separated form with no colon (`label   value`). The value is captured to the end of the line and
 * then cleaned.
 */
function extractRawValue(text: string, labels: readonly string[]): string | null {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A label is recognised only near the start of a line (bullets and spaces allowed). That avoids
    // headers and partial matches inside a word ("usage" inside "Credit Usage", etc.).
    const re = new RegExp(`(?:^|[\\n\\r])[\\t >*•\\-]*${escaped}\\s*[:=]?\\s*([^\\n\\r]+)`, "i");
    const m = text.match(re);
    if (m?.[1] !== undefined) {
      const value = m[1].trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

/**
 * Extract the first number in a string (sign, thousands commas and decimals allowed).
 * null on failure. Very large values, negatives and 0 are all allowed (boundary values).
 */
function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  // Remove the (thousands) commas, then match a signed decimal number.
  const cleaned = raw.replace(/,/g, "");
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Normalise a usage-ratio string ("45.5%" or "0.455") to a 0–1 ratio. */
function parseRatio(raw: string | null): number | null {
  if (raw === null) return null;
  const hasPercent = raw.includes("%");
  const n = parseNumber(raw);
  if (n === null) return null;
  if (hasPercent) return n / 100;
  // With no % and a value above 1, it is taken as a percentage (e.g. "45.5"); otherwise it is already a ratio (0–1).
  return n > 1 ? n / 100 : n;
}

/** Clean a plan-name value: take the first token (up to a space) and drop an excessive tail. */
function cleanPlanName(raw: string | null): string | null {
  if (raw === null) return null;
  // Only the core token before a parenthesis or extra description.
  const token = raw.split(/[()]/)[0]?.trim();
  if (!token) return null;
  // A bare number is not a plan name.
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return null;
  return token;
}

/** Clean a reset-date value: extract a date-like token (YYYY-MM-DD / MM-DD / free text allowed). */
function cleanResetDate(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Extract an ISO or partial date first; otherwise the cleaned source text as is.
  const dateMatch = trimmed.match(
    /\d{4}-\d{2}-\d{2}|\d{1,4}[-/]\d{1,2}[-/]\d{1,4}|\d{1,2}-\d{1,2}/,
  );
  return dateMatch ? dateMatch[0] : trimmed;
}

/**
 * Raw `/usage` string → structured result. Never throws.
 */
export function parseUsage(rawInput: string): ParseResult {
  try {
    if (typeof rawInput !== "string" || rawInput.trim().length === 0) {
      return { ok: false, raw: rawInput ?? "", reason: "Empty output — nothing to parse." };
    }

    const text = rawInput.replace(ANSI_PATTERN, "");

    let planName = cleanPlanName(extractRawValue(text, FIELD_LABELS.planName));
    let usedAmount = parseNumber(extractRawValue(text, FIELD_LABELS.usedAmount));
    let remainingAmount = parseNumber(extractRawValue(text, FIELD_LABELS.remainingAmount));
    let planLimit = parseNumber(extractRawValue(text, FIELD_LABELS.planLimit));
    let usageRatio = parseRatio(extractRawValue(text, FIELD_LABELS.usageRatio));
    let resetDate = cleanResetDate(extractRawValue(text, FIELD_LABELS.resetDate));

    // ── Per-format heuristics: defensively cover the real CLI panel format, which is not a label:value pattern.
    // e.g. "Credits (4553 of 10000 covered in plan)" / "resets on 9-1-2026" /
    //      "Estimated Usage | ... | KIRO POWER" / "45%" after the progress bar.

    // "(X of Y ...)" — used / limit.
    if (usedAmount === null || planLimit === null) {
      const m = text.match(/\(\s*([\d,]+(?:\.\d+)?)\s+of\s+([\d,]+(?:\.\d+)?)/i);
      if (m) {
        if (usedAmount === null) usedAmount = parseNumber(m[1] ?? null);
        if (planLimit === null) planLimit = parseNumber(m[2] ?? null);
      }
    }

    // "resets on <M-D-Y | Y-M-D>" — reset date.
    if (resetDate === null) {
      const m = text.match(/resets?\s+on\s+(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})/i);
      if (m?.[1] !== undefined) resetDate = m[1].trim();
    }

    // "Estimated Usage | ... | <PLAN>" — the last segment of the pipe-separated line is the plan name.
    if (planName === null) {
      for (const line of text.split(/[\n\r]+/)) {
        if (!/estimated usage|usage summary/i.test(line)) continue;
        const segs = line
          .split("|")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const last = segs[segs.length - 1];
        if (last !== undefined && !/estimated usage|usage summary|resets?/i.test(last)) {
          planName = cleanPlanName(last);
        }
        break;
      }
    }

    // The percentage after the progress bar — usage ratio.
    if (usageRatio === null) {
      const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
      const n = parseNumber(m?.[1] ?? null);
      if (n !== null) usageRatio = n / 100;
    }

    // ── Fill in derived values.
    // With the usage ratio still missing, compute it from used/limit.
    if (usageRatio === null && usedAmount !== null && planLimit !== null && planLimit > 0) {
      usageRatio = usedAmount / planLimit;
    }
    // The remaining amount is not stated but used and limit are known: derive it.
    if (remainingAmount === null && usedAmount !== null && planLimit !== null) {
      remainingAmount = planLimit - usedAmount;
    }

    const fields = [planName, usedAmount, remainingAmount, planLimit, usageRatio, resetDate];
    const obtained = fields.filter((v) => v !== null).length;

    if (obtained === 0) {
      return {
        ok: false,
        raw: rawInput,
        reason: "No recognisable credit figures found (the format may have changed).",
      };
    }

    const data: ParsedUsage = {
      planName,
      usedAmount,
      remainingAmount,
      planLimit,
      usageRatio,
      resetDate,
      partial: obtained < fields.length,
    };
    return { ok: true, data };
  } catch (err) {
    // Defence: any unexpected error flows out as a value.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      raw: typeof rawInput === "string" ? rawInput : "",
      reason: `Parser internal error: ${reason}`,
    };
  }
}
