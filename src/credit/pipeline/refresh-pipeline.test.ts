// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * RefreshPipeline tests — check the assembly rules of the single collect→parse→store entry point.
 * collect is injected so no real CLI runs, and storage round-trips through u1's synchronous
 * SnapshotStore (":memory:"). A port absorbed into the aidlc-dashboard native tree (key adjustment: a
 * synchronous store).
 */

import { describe, expect, test } from "bun:test";
import type { CollectResult } from "../collector/usage-collector";
import { SnapshotStore } from "../storage/snapshot-store";
import type { CreditSnapshot } from "../types";
import { type PipelineStore, RefreshPipeline } from "./refresh-pipeline";

/** An in-memory store, already through init. */
function memStore(): SnapshotStore {
  const store = new SnapshotStore(":memory:");
  store.init();
  return store;
}

const constCollect = (r: CollectResult) => async () => r;

describe("RefreshPipeline", () => {
  test("collect + parse succeed → a success snapshot is stored, the raw output is not kept (volatile)", async () => {
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({ ok: true, raw: "Plan: Pro\nUsed: 100\nLimit: 200\n" }),
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    pipeline.init();
    const result = await pipeline.run("manual");

    expect(result.persisted).toBe(true);
    expect(result.snapshot.ok).toBe(true);
    expect(result.snapshot.source).toBe("manual");
    // A success snapshot has no raw field.
    expect((result.snapshot as unknown as Record<string, unknown>).raw).toBeUndefined();

    const stored = store.readAll();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.ok).toBe(true);
  });

  test("collection failure → the failure snapshot keeps the diagnostic detail as its raw output", async () => {
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({
        ok: false,
        reason: "collection failed: timeout (over 15000ms)",
        detail: "stderr blob",
      }),
    });
    pipeline.init();
    const result = await pipeline.run("auto");

    expect(result.snapshot.ok).toBe(false);
    if (result.snapshot.ok === false) {
      expect(result.snapshot.reason).toContain("timeout");
      expect(result.snapshot.raw).toBe("stderr blob");
    }
  });

  test("parse failure → the failure snapshot keeps the raw output and the reason", async () => {
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({ ok: true, raw: "a completely unknown format" }),
    });
    pipeline.init();
    const result = await pipeline.run("auto");

    expect(result.snapshot.ok).toBe(false);
    if (result.snapshot.ok === false) {
      expect(result.snapshot.raw).toBe("a completely unknown format");
      expect(result.snapshot.reason.length).toBeGreaterThan(0);
    }
  });

  test("an append exception is not swallowed: surfaced as persisted:false and persistError (no throw)", async () => {
    // A minimal stub store whose synchronous append throws.
    const throwingStore: PipelineStore = {
      maxSequence: () => 0,
      append: () => {
        throw new Error("disk full");
      },
    };
    const pipeline = new RefreshPipeline({
      store: throwingStore,
      collect: constCollect({ ok: true, raw: "Used: 1\nLimit: 2\n" }),
    });
    pipeline.init();
    // run itself does not reject (no throw).
    const result = await pipeline.run("auto");
    expect(result.persisted).toBe(false);
    expect(result.persistError).toContain("disk full");
    // The snapshot itself is still assembled and returned.
    expect(result.snapshot.ok).toBe(true);
  });

  test("init(): seeded from u1's maxSequence, so the next run's sequence continues", async () => {
    const store = memStore();
    // Store an existing snapshot first (sequence 4) to check the seed.
    store.append({
      capturedAt: "2026-07-01T00:00:00.000Z",
      sequence: 4,
      source: "auto",
      ok: false,
      raw: "x",
      reason: "seed",
    });
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({ ok: true, raw: "Used: 1\nLimit: 2\n" }),
    });
    pipeline.init();
    const r1 = await pipeline.run("auto");
    const r2 = await pipeline.run("manual");
    expect(r1.snapshot.sequence).toBe(5);
    expect(r2.snapshot.sequence).toBe(6);
  });

  test("pre-await sequence: simultaneous runs (auto + manual) get different sequences", async () => {
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      collect: constCollect({ ok: true, raw: "Used: 1\nLimit: 2\n" }),
    });
    pipeline.init();
    const [a, b] = await Promise.all([pipeline.run("auto"), pipeline.run("manual")]);
    expect(a.snapshot.sequence).not.toBe(b.snapshot.sequence);
  });

  test("run is the single entry point auto and manual share (source passed through)", async () => {
    const seen: CreditSnapshot["source"][] = [];
    const recordingStore: PipelineStore = {
      maxSequence: () => 0,
      append: (snap) => seen.push(snap.source),
    };
    const pipeline = new RefreshPipeline({
      store: recordingStore,
      collect: constCollect({ ok: true, raw: "Used: 1\nLimit: 2\n" }),
    });
    pipeline.init();
    await pipeline.run("auto");
    await pipeline.run("manual");
    expect(seen).toEqual(["auto", "manual"]);
  });

  test("given acquire, text collection and parsing are skipped and its result becomes the snapshot", async () => {
    // The ACP path: collection and mapping are one step, so collect/parseUsage must not be called.
    let collectCalls = 0;
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      collect: async () => {
        collectCalls++;
        return { ok: true, raw: "raw output that must not be used" };
      },
      acquire: async () => ({
        ok: true,
        data: {
          planName: "KIRO POWER",
          usedAmount: 7609.69,
          remainingAmount: 2390.31,
          planLimit: 10000,
          usageRatio: 0.760969,
          resetDate: "2026-10-01",
          partial: false,
        },
      }),
    });
    pipeline.init();
    const r = await pipeline.run("auto");
    expect(collectCalls).toBe(0);
    expect(r.snapshot.ok).toBe(true);
    if (r.snapshot.ok) expect(r.snapshot.data.usedAmount).toBe(7609.69);
  });

  test("an acquire failure becomes a failure snapshot that keeps raw and reason", async () => {
    const store = memStore();
    const pipeline = new RefreshPipeline({
      store,
      acquire: async () => ({ ok: false, raw: "{}", reason: "the format may have changed." }),
    });
    pipeline.init();
    const r = await pipeline.run("manual");
    expect(r.snapshot.ok).toBe(false);
    if (!r.snapshot.ok) {
      expect(r.snapshot.raw).toBe("{}");
      expect(r.snapshot.reason).toContain("format may have changed");
    }
  });
});
