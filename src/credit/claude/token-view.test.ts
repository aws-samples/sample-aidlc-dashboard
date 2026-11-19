// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * token-view unit tests. A string renderer, so only the output string is checked, with no DOM.
 *
 * The escaping checks are the core — model names, paths and notes are external text from the
 * transcripts, and this card is the only place that puts them on screen (the same position as Kiro's
 * `warning.raw`).
 */

import { strings } from "../../render/i18n";

/** The tests assert the Korean locale's output (those strings stay Korean on purpose) — the existing expected strings stay valid. */
const KO = strings("ko");
import { describe, expect, test } from "bun:test";
import type { TokenViewModel } from "./token-model";
import { renderTokens } from "./token-view";

function vm(over: Partial<TokenViewModel> = {}): TokenViewModel {
  return {
    status: "ok",
    totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
    grandTotal: 1160,
    cachedPromptRatio: 1000 / 1060,
    sessionTime: null,
    byModel: [
      {
        model: "claude-opus-5",
        totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
        messages: 1,
      },
    ],
    messages: 1,
    sidechainMessages: 0,
    sessions: 1,
    trend: {
      window: "30d",
      points: [{ ts: "2026-08-25T00:00:00", value: 1160, ok: true }],
      summary: { latest: 1160, min: 1160, max: 1160, count: 1 },
    },
    lastActivityAt: "2026-08-25T10:00:00Z",
    firstActivityAt: "2026-08-25T09:00:00Z",
    dir: "/home/user/.claude/projects/-ws",
    triedPath: "/home/user/.claude/projects/-ws",
    notes: [],
    ...over,
  };
}

describe("renderTokens", () => {
  test("renders the five token buckets and sessions/messages as a table", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).toContain("토큰 사용량");
    expect(html).toContain("총 토큰");
    expect(html).toContain("1,160");
    expect(html).toContain("캐시 읽기");
    // The label must say that thinking is a value included in output.
    expect(html).toContain("출력 내 포함");
  });

  test("prints the cache hit ratio as a percentage and states the denominator in a tooltip", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).toContain("프롬프트 캐시 적중");
    expect(html).toContain("94.3%");
    // Without the denominator on screen it is an unlabelled ratio.
    expect(html).toContain("캐시 읽기 ÷ (입력 + 캐시 읽기 + 캐시 생성)");
  });

  test("with no prompt tokens the hit-ratio cell is —", () => {
    const html = renderTokens(vm({ cachedPromptRatio: null }), "30d", KO);
    expect(html).toContain("프롬프트 캐시 적중");
    expect(html).not.toContain("94.3%");
  });

  test("the English catalogue gives the same row — guards against a row added to one side only", () => {
    const html = renderTokens(vm(), "30d", strings("en"));
    expect(html).toContain("prompt cache hit");
    expect(html).toContain("cache read ÷ (input + cache read + cache create)");
    expect(html).toContain("94.3%");
  });

  test("with no session times the block is not drawn at all", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).not.toContain("세션 벽시계");
  });

  test("session times render in hours + the API share, and the screen says they carry no authority", () => {
    const html = renderTokens(
      vm({
        sessionTime: {
          sessions: 3,
          straddling: 0,
          totalSec: 7200,
          apiSec: 1800,
          toolSec: 600,
          apiRatio: 0.25,
        },
      }),
      "30d",
      KO,
    );
    expect(html).toContain("세션 벽시계");
    expect(html).toContain("2.0h");
    expect(html).toContain("25.0%");
    // When the two figures differ the reader must know which to trust.
    expect(html).toContain("감사 원장이 권위 있는 값");
    expect(html).toContain("stage 에 귀속되지 않아");
    // The token-based `sessions` and the checkpoint-based session count can differ (7 vs 6, measured).
    // Side by side, the reader asks which is right, so the label and the wording must explain the gap.
    expect(html).toContain("체크포인트 있는 세션");
    expect(html).toContain("진행 중인 세션은 아직 남기지 않았을 수 있습니다");
  });

  test("straddling sessions are stated plainly and not painted warn", () => {
    const html = renderTokens(
      vm({
        sessionTime: {
          sessions: 1,
          straddling: 4,
          totalSec: 60,
          apiSec: 6,
          toolSec: 0,
          apiRatio: 0.1,
        },
      }),
      "30d",
      KO,
    );
    expect(html).toContain("세션 4개는 창 경계를 걸쳐");
    // A note, but not note warn — it is normal, and a warning colour would overstate it.
    expect(html).toContain('<p class="note">세션 4개');
  });

  test("with no session wholly inside the window, it states just that fact, with no numbers", () => {
    const html = renderTokens(
      vm({
        sessionTime: {
          sessions: 0,
          straddling: 2,
          totalSec: 0,
          apiSec: 0,
          toolSec: 0,
          apiRatio: null,
        },
      }),
      "30d",
      KO,
    );
    expect(html).not.toContain("세션 벽시계");
    expect(html).toContain("온전히 든 세션이 없습니다");
  });

  test("the English catalogue gives the session block too", () => {
    const html = renderTokens(
      vm({
        sessionTime: {
          sessions: 2,
          straddling: 0,
          totalSec: 3600,
          apiSec: 900,
          toolSec: 0,
          apiRatio: 0.25,
        },
      }),
      "30d",
      strings("en"),
    );
    expect(html).toContain("session wall clock");
    expect(html).toContain("audit ledger is authoritative");
  });

  test("renders the per-model breakdown table and shares", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("100.0%");
  });

  test("escapes a hostile model name", () => {
    const html = renderTokens(
      vm({
        byModel: [
          {
            model: '<script>alert("x")</script>',
            totals: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0, thinking: 0 },
            messages: 1,
          },
        ],
      }),
      "30d",
      KO,
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes a hostile note (path) too", () => {
    // A note is a code + facts now, so the only external string to escape is `triedPath`.
    const html = renderTokens(
      vm({ notes: [{ code: "no-transcripts", triedPath: '<img src=x onerror="alert(1)">' }] }),
      "30d",
      KO,
    );
    expect(html).not.toContain("<img src=x");
  });

  test("the no-data state gives a badge and a note — no table is drawn", () => {
    const html = renderTokens(
      vm({ status: "none", messages: 0, byModel: [], grandTotal: 0 }),
      "7d",
      KO,
    );
    expect(html).toContain("데이터 없음");
    expect(html).not.toContain("총 토큰");
  });

  test("a partial aggregate shows as a badge", () => {
    expect(renderTokens(vm({ status: "partial" }), "30d", KO)).toContain("부분 집계");
  });

  test("capped down to 0 does not show the 'no usage' note", () => {
    // That note advises "try a wider window", but under the cap a wider window makes things worse.
    // So it must not appear for partial.
    const html = renderTokens(
      vm({
        status: "partial",
        messages: 0,
        byModel: [],
        grandTotal: 0,
        notes: [{ code: "files-capped", count: 1 }],
      }),
      "30d",
      KO,
    );
    expect(html).not.toContain("기간을 넓혀 보세요");
    expect(html).toContain("빠짐없다고 볼 수 없습니다");
  });

  test("the window toggle marks only the current window aria-checked", () => {
    const html = renderTokens(vm(), "7d", KO);
    expect(html).toContain('aria-checked="true" href="?cw=7d"');
    expect(html).toContain('aria-checked="false" href="?cw=30d"');
  });

  test("the chart's accessible label uses the token wording (not the cumulative-usage wording)", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).toContain("일별 토큰 추이");
    expect(html).not.toContain("누적 사용량 추이");
  });

  test("with subagent responses it says the total includes them", () => {
    expect(renderTokens(vm({ sidechainMessages: 4 }), "30d", KO)).toContain("서브에이전트 응답 4");
  });
});
