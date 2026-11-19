// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * PollingScheduler tests — check the immediate first run, tick failure isolation, ignoring a duplicate
 * start, and start/stop cleanup. A pipeline stub and a short intervalMs are injected so no real clock or
 * CLI is used (NFR5). A port absorbed into the aidlc-dashboard native tree.
 */

import { describe, expect, test } from "bun:test";
import type { CaptureSource } from "../types";
import { type Pollable, PollingScheduler } from "./polling-scheduler";
import type { RefreshResult } from "./refresh-pipeline";

function fakeResult(): RefreshResult {
  return {
    snapshot: {
      capturedAt: "2026-08-01T00:00:00.000Z",
      sequence: 0,
      source: "auto",
      ok: false,
      raw: "",
      reason: "x",
    },
    persisted: true,
  };
}

/** A success snapshot result. `fakeResult()` is a failure (ok:false), so this one is the contrast. */
function okResult(): RefreshResult {
  return {
    snapshot: {
      capturedAt: "2026-08-01T00:00:00.000Z",
      sequence: 1,
      source: "auto",
      ok: true,
      data: {} as never,
    },
    persisted: true,
  };
}

/** A short delay to drain the next microtask/timer queue. */
function tickDelay(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PollingScheduler", () => {
  test("tick calls the pipeline with source='auto'", async () => {
    const calls: CaptureSource[] = [];
    const pipeline: Pollable = {
      run: async (source) => {
        calls.push(source);
        return fakeResult();
      },
    };
    const scheduler = new PollingScheduler({ pipeline });
    await scheduler.tick();
    expect(calls).toEqual(["auto"]);
  });

  test("start(runImmediately=true) runs one tick at once", async () => {
    let count = 0;
    const pipeline: Pollable = {
      run: async () => {
        count += 1;
        return fakeResult();
      },
    };
    // A long period, so only the immediate run is observed.
    const scheduler = new PollingScheduler({ pipeline, intervalMs: 60_000 });
    scheduler.start(true);
    await tickDelay();
    scheduler.stop();
    expect(count).toBe(1);
  });

  test("tick isolates a pipeline throw (onError called, the next period continues)", async () => {
    let errored = false;
    const pipeline: Pollable = {
      run: async () => {
        throw new Error("boom");
      },
    };
    const scheduler = new PollingScheduler({
      pipeline,
      onError: () => {
        errored = true;
      },
    });
    // tick itself must not reject.
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(errored).toBe(true);
  });

  test("a duplicate start is ignored (one timer, one stop stops it)", () => {
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({ pipeline, intervalMs: 60_000 });
    scheduler.start();
    scheduler.start(); // must be ignored
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    // No duplicate timer is left, so one stop stops it.
    expect(scheduler.running).toBe(false);
  });

  test("start/stop toggles the running state", () => {
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({ pipeline, intervalMs: 60_000 });
    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  test("the onTick callback receives the success result", async () => {
    let received: RefreshResult | null = null;
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({
      pipeline,
      onTick: (r) => {
        received = r;
      },
    });
    await scheduler.tick();
    expect(received).not.toBeNull();
  });

  // A failed collection is not free — it launches kiro-cli and calls the model (measured, module comment).
  // So with upstream broken it does not retry every 5 minutes forever.
  test("hitting the consecutive-failure threshold slows the poll instead of stopping it — so it can heal itself", async () => {
    const halts: unknown[] = [];
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({
      pipeline,
      intervalMs: 60_000,
      slowIntervalMs: 600_000,
      maxConsecutiveFailures: 3,
      onHalt: (h) => halts.push(h),
    });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.halt).toBeNull();
    await scheduler.tick();
    // An ACP failure calls no model, so a permanent stop would only lose the value — the timer keeps running.
    expect(scheduler.running).toBe(true);
    expect(scheduler.halt).toEqual({
      failures: 3,
      retryEveryMs: 600_000,
      lastReason: "x",
    });
    expect(halts).toHaveLength(1);
    // Further failures after it has slowed down do not call the callback again.
    await scheduler.tick();
    expect(halts).toHaveLength(1);
    scheduler.stop();
  });

  test("one success after slowing down restores the period", async () => {
    let ok = false;
    const pipeline: Pollable = { run: async () => (ok ? okResult() : fakeResult()) };
    const scheduler = new PollingScheduler({
      pipeline,
      intervalMs: 60_000,
      slowIntervalMs: 600_000,
      maxConsecutiveFailures: 2,
    });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.halt?.retryEveryMs).toBe(600_000);
    ok = true;
    await scheduler.tick();
    expect(scheduler.halt).toBeNull();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
  });

  test("a success in between resets the consecutive counter — a transient failure does not stop it", async () => {
    let succeed = false;
    const pipeline: Pollable = { run: async () => (succeed ? okResult() : fakeResult()) };
    const scheduler = new PollingScheduler({ pipeline, maxConsecutiveFailures: 3 });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    succeed = true;
    await scheduler.tick();
    succeed = false;
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.running).toBe(true);
    expect(scheduler.halt).toBeNull();
  });

  test("a tick ending in an exception counts as a consecutive failure — no value was fetched either way", async () => {
    const pipeline: Pollable = {
      run: () => Promise.reject(new Error("boom")),
    };
    const scheduler = new PollingScheduler({ pipeline, maxConsecutiveFailures: 2 });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.halt?.failures).toBe(2);
    scheduler.stop();
  });

  test("a storage failure (persisted:false) does not count as a success", async () => {
    // The screen is not updated, so the collection cannot be called a success. Otherwise, with the DB
    // unwritable, the slowdown would lift and it would keep hammering at the normal period.
    const pipeline: Pollable = {
      run: async () => ({ ...okResult(), persisted: false, persistError: "disk full" }),
    };
    const scheduler = new PollingScheduler({ pipeline, maxConsecutiveFailures: 2 });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.halt?.failures).toBe(2);
    scheduler.stop();
  });

  test("maxConsecutiveFailures<=0 never stops", async () => {
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({ pipeline, maxConsecutiveFailures: 0 });
    scheduler.start();
    for (let i = 0; i < 20; i++) await scheduler.tick();
    expect(scheduler.running).toBe(true);
    expect(scheduler.halt).toBeNull();
    scheduler.stop();
  });
});
