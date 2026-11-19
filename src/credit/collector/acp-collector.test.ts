// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * acp-collector unit tests. `AcpRpc` is injected so the real `kiro-cli` is never called.
 *
 * The response shapes are taken as is from live captures — this extension is undocumented and
 * experimental, so tests only mean something against the observed schema, not one we imagined.
 */

import { describe, expect, test } from "bun:test";
import {
  type AcpResponse,
  type AcpRpc,
  type AcpSessionRef,
  collectUsageViaAcp,
  mapAcpUsage,
  spawnAcpRpc,
} from "./acp-collector";

/** The `data` of a `/usage` response observed live (2026-09-12). */
function liveData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planName: "KIRO POWER",
    billingCycleReset: "2026-10-01",
    overagesEnabled: true,
    isEnterprise: true,
    usageBreakdowns: [
      {
        resourceType: "CREDIT",
        displayName: "Credits",
        used: 7609.69,
        limit: 10000,
        percentage: 76.0969,
        currentOverages: 0,
        overageRate: 0.04,
        overageCharges: 0,
        currency: "USD",
        hasLimit: true,
      },
    ],
    bonusCredits: [],
    addOnCredits: [],
    overageCapable: true,
    ...over,
  };
}

/** RPC stub that records the call order and answers from a script. */
function stubRpc(script: Record<string, AcpResponse | ((p: unknown) => AcpResponse)>): {
  rpc: AcpRpc;
  calls: { method: string; params: unknown }[];
  closed: () => number;
} {
  const calls: { method: string; params: unknown }[] = [];
  let closes = 0;
  return {
    calls,
    closed: () => closes,
    rpc: {
      call(method, params) {
        calls.push({ method, params });
        const entry = script[method];
        if (entry === undefined)
          return Promise.resolve({ error: { message: `no stub: ${method}` } });
        return Promise.resolve(typeof entry === "function" ? entry(params) : entry);
      },
      close() {
        closes++;
      },
    },
  };
}

const OK_SCRIPT = {
  initialize: { result: {} },
  "session/new": { result: { sessionId: "sess-1" } },
  "session/load": { result: {} },
  "_kiro.dev/commands/execute": { result: { success: true, data: liveData() } },
};

describe("mapAcpUsage", () => {
  test("maps the observed response to ParsedUsage", () => {
    const r = mapAcpUsage(liveData());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      planName: "KIRO POWER",
      usedAmount: 7609.69,
      // Digits the subtraction made are dropped — the source has 2 decimals.
      remainingAmount: 2390.31,
      planLimit: 10000,
      // Only moves the percentage Kiro gave to 0–1 (not recomputed from used/limit).
      usageRatio: 0.760969,
      resetDate: "2026-10-01",
      partial: false,
    });
  });

  test("finds the CREDIT breakdown by name — does not take the array's first entry", () => {
    const r = mapAcpUsage(
      liveData({
        usageBreakdowns: [
          { resourceType: "SOMETHING_ELSE", used: 1, limit: 2, percentage: 50, hasLimit: true },
          liveData().usageBreakdowns as never,
        ].flat(),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.usedAmount).toBe(7609.69);
  });

  test("no CREDIT entry fails as a format change", () => {
    const r = mapAcpUsage(liveData({ usageBreakdowns: [{ resourceType: "TOKENS", used: 5 }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("CREDIT");
  });

  test("no used is not called a success — it is the gauge's numerator", () => {
    const r = mapAcpUsage(
      liveData({ usageBreakdowns: [{ resourceType: "CREDIT", limit: 10000, hasLimit: true }] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("format may have changed");
  });

  test("hasLimit=false → limit and remaining are null, and partial is set", () => {
    const r = mapAcpUsage(
      liveData({
        usageBreakdowns: [
          { resourceType: "CREDIT", used: 12.5, limit: 0, percentage: 0, hasLimit: false },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.planLimit).toBeNull();
    expect(r.data.remainingAmount).toBeNull();
    expect(r.data.partial).toBe(true);
  });

  test("a completely different structure fails", () => {
    expect(mapAcpUsage(null).ok).toBe(false);
    expect(mapAcpUsage("Estimated Usage | ...").ok).toBe(false);
    expect(mapAcpUsage({}).ok).toBe(false);
  });
});

describe("collectUsageViaAcp", () => {
  test("calls initialize → session/new → commands/execute in order, then closes", async () => {
    const s = stubRpc(OK_SCRIPT);
    const r = await collectUsageViaAcp({ rpc: s.rpc });
    expect(r.ok).toBe(true);
    expect(s.calls.map((c) => c.method)).toEqual([
      "initialize",
      "session/new",
      "_kiro.dev/commands/execute",
    ]);
    // A doubly nested TuiCommand — serde accepts only this shape.
    expect(s.calls[2]?.params).toMatchObject({
      sessionId: "sess-1",
      command: { command: "usage", args: {} },
    });
    expect(s.closed()).toBe(1);
  });

  test("remembers the session id and reuses it with session/load on the next call", async () => {
    const session: AcpSessionRef = {};
    const first = stubRpc(OK_SCRIPT);
    await collectUsageViaAcp({ rpc: first.rpc, session });
    expect(session.id).toBe("sess-1");

    const second = stubRpc(OK_SCRIPT);
    await collectUsageViaAcp({ rpc: second.rpc, session });
    // session/new is not called again — that is where piling up in `~/.kiro/sessions/cli/` is prevented.
    expect(second.calls.map((c) => c.method)).toEqual([
      "initialize",
      "session/load",
      "_kiro.dev/commands/execute",
    ]);
  });

  test("a failing session/load falls back once to a new session", async () => {
    const session: AcpSessionRef = { id: "stale" };
    const s = stubRpc({ ...OK_SCRIPT, "session/load": { error: { message: "not found" } } });
    const r = await collectUsageViaAcp({ rpc: s.rpc, session });
    expect(r.ok).toBe(true);
    expect(s.calls.map((c) => c.method)).toEqual([
      "initialize",
      "session/load",
      "session/new",
      "_kiro.dev/commands/execute",
    ]);
    expect(session.id).toBe("sess-1");
  });

  test("a JSON-RPC error at each step arrives as a failure naming the reason", async () => {
    for (const [method, needle] of [
      ["initialize", "initialize"],
      ["session/new", "session/new"],
      ["_kiro.dev/commands/execute", "/usage execution refused"],
    ] as const) {
      const s = stubRpc({ ...OK_SCRIPT, [method]: { error: { message: "boom" } } });
      const r = await collectUsageViaAcp({ rpc: s.rpc });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(needle);
      // The connection is closed even on failure.
      expect(s.closed()).toBe(1);
    }
  });

  test("success not true is treated as a failure, keeping message as the raw output", async () => {
    const s = stubRpc({
      ...OK_SCRIPT,
      "_kiro.dev/commands/execute": { result: { success: false, message: "not signed in" } },
    });
    const r = await collectUsageViaAcp({ rpc: s.rpc });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.raw).toBe("not signed in");
      expect(r.reason).toContain("did not report success");
    }
  });

  test("a session/new response with no sessionId fails as a format change", async () => {
    const s = stubRpc({ ...OK_SCRIPT, "session/new": { result: {} } });
    const r = await collectUsageViaAcp({ rpc: s.rpc });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("sessionId");
  });
});

describe("mapAcpUsage: missing vs wrong-typed", () => {
  test("missing is kept as null + partial — the other values are not thrown away", () => {
    // Missing is made by leaving the field out entirely (real absence, not an undefined assignment).
    const { planName: _p, billingCycleReset: _b, ...withoutBoth } = liveData();
    const r = mapAcpUsage(withoutBoth);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.planName).toBeNull();
    expect(r.data.resetDate).toBeNull();
    expect(r.data.usedAmount).toBe(7609.69); // still there
    expect(r.data.partial).toBe(true);
  });

  test("wrong-typed is refused as corrupt — folding it quietly into null could not say the format changed", () => {
    for (const [patch, field] of [
      [{ planName: 7 }, "planName"],
      [{ billingCycleReset: 20261001 }, "billingCycleReset"],
    ] as const) {
      const r = mapAcpUsage(liveData(patch));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(field);
    }
    for (const [key, field] of [
      ["used", "used"],
      ["limit", "limit"],
      ["percentage", "percentage"],
      ["hasLimit", "hasLimit"],
    ] as const) {
      const b = { ...(liveData().usageBreakdowns as Record<string, unknown>[])[0] };
      b[key] = "plenty";
      const r = mapAcpUsage(liveData({ usageBreakdowns: [b] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(field);
    }
  });
});

describe("spawnAcpRpc (real process)", () => {
  /** A fake agent that knows the script. Plugged in through `argv` injection, so no global is touched. */
  const fakeAgent = (script: string): readonly string[] => [process.execPath, "-e", script];
  const ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

  test("pairs responses by id — notifications and non-JSON lines flow past", async () => {
    // It answers on a timer without waiting for stdin. What is checked is framing and id pairing; the
    // stdin round trip is covered by the deadline test and the live e2e respectively.
    const rpc = spawnAcpRpc(
      3_000,
      ENV,
      fakeAgent(`
        const NL = String.fromCharCode(10);
        setTimeout(() => {
          process.stdout.write("this is not JSON" + NL);
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "_kiro.dev/notify", params: {} }) + NL);
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { ok: 1 } }) + NL);
        }, 30);
        setTimeout(() => {}, 5000);
      `),
    );
    const r = await rpc.call("initialize", {});
    rpc.close();
    expect(r.result).toEqual({ ok: 1 });
  });

  test("assembles a line split across several chunks — multi-byte boundaries included", async () => {
    // The payload is Korean on purpose: multi-byte UTF-8 characters must survive a split at a chunk boundary.
    const rpc = spawnAcpRpc(
      3_000,
      ENV,
      fakeAgent(`
        const NL = String.fromCharCode(10);
        const msg = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { 값: "여러 chunk 에 걸친 한글" } });
        setTimeout(() => {
          const mid = Math.floor(msg.length / 2);
          process.stdout.write(msg.slice(0, mid));
          setTimeout(() => process.stdout.write(msg.slice(mid) + NL), 60);
        }, 30);
        setTimeout(() => {}, 5000);
      `),
    );
    const r = await rpc.call("initialize", {});
    rpc.close();
    expect(r.result).toEqual({ 값: "여러 chunk 에 걸친 한글" });
  });

  test("with no response the deadline settles it — it does not wait for stdout EOF", async () => {
    // The most important test in this file: with a grandchild holding stdout no EOF comes, and the old
    // implementation waited here forever, leaving the scheduler's `inFlight` set and silently killing polling.
    const rpc = spawnAcpRpc(600, ENV, fakeAgent("setTimeout(() => {}, 60000);"));
    const t = Date.now();
    const r = await rpc.call("initialize", {});
    const elapsed = Date.now() - t;
    rpc.close();
    expect(r.error?.message).toContain("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(3_000);
  });

  test("close() settles a pending call at once, and later calls answer at once too", async () => {
    const rpc = spawnAcpRpc(30_000, ENV, fakeAgent("setTimeout(() => {}, 60000);"));
    const p = rpc.call("initialize", {});
    rpc.close();
    expect((await p).error?.message).toContain("connection closed");
    expect((await rpc.call("initialize", {})).error?.message).toContain("closed ACP connection");
  });

  test("a child dying with no response settles on that fact — no waiting forever", async () => {
    const rpc = spawnAcpRpc(10_000, ENV, fakeAgent("process.exit(3);"));
    const r = await rpc.call("initialize", {});
    rpc.close();
    expect(r.error?.message).toBeDefined();
  });
});
