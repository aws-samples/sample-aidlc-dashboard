// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * PollingScheduler — runs the refresh pipeline automatically, every 5 minutes by default
 * (BR4.1–BR4.4, FR5.1).
 *
 * A port absorbed into the aidlc-dashboard native tree. The pipeline is shared with the manual refresh
 * (FR5.3).
 *
 * Failure isolation: when one period's collection or storage fails, the exception is swallowed and the
 * next period goes on (BR4.2). `Pollable`, `SchedulerDeps` and `DEFAULT_INTERVAL_MS` are u2-owned and
 * defined and exported here.
 */

import type { CaptureSource } from "../types";
import type { RefreshResult } from "./refresh-pipeline";

/** Default polling period: 5 minutes (FR5.1). */
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How many consecutive failures before the polling period widens.
 *
 * **The original reason was cost, and that reason is gone.** This mechanism came in because the old
 * collector called the model on every failure (spending credit to read credit). Since the move to ACP
 * a failed collection is a 2-second `kiro-cli acp` spawn with **no model call**. So a "permanent stop"
 * is no longer justified — it would throw away automatic recovery for good because a transient network
 * or auth outage lasted more than 25 minutes (a person would have to press the button to bring it back).
 *
 * **So it slows down instead of stopping.** When consecutive failures reach the threshold the period
 * widens to `SLOW_INTERVAL_MS`, and one success restores the normal period. It stops hammering a broken
 * upstream every 5 minutes and still heals itself. The screen states the slowdown and the last reason.
 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

/** The slowed period. Keep looking even with upstream broken, but only once every 30 minutes. */
export const SLOW_INTERVAL_MS = 30 * 60 * 1000;

/** The fact that automatic polling slowed down, and why. The screen uses it to answer "why are updates slower". */
export interface PollHalt {
  /** Number of consecutive failures that led to the slowdown. */
  failures: number;
  /** Reason of the last failure (the snapshot's `reason`, or the tick exception string). */
  lastReason?: string;
  /** The retry period in force (ms). Carried so the screen can say it is a slowdown, not a stop. */
  retryEveryMs: number;
}

/** The pipeline's minimal surface (easy to inject in tests). */
export interface Pollable {
  run(source: CaptureSource): Promise<RefreshResult>;
}

export interface SchedulerDeps {
  pipeline: Pollable;
  /** Polling period (ms). Default 5 minutes. */
  intervalMs?: number;
  /** Callback after each successful tick (optional). */
  onTick?: (result: RefreshResult) => void;
  /** Callback for an unexpected error during a tick (optional). */
  onError?: (err: unknown) => void;
  /** Consecutive-failure threshold. Default `DEFAULT_MAX_CONSECUTIVE_FAILURES`. At 0 or below it never slows down. */
  maxConsecutiveFailures?: number;
  /** Slowed period (ms). Default `SLOW_INTERVAL_MS`. */
  slowIntervalMs?: number;
  /** Called once when the threshold is reached and it slows down (optional) — for the operator log. */
  onHalt?: (halt: PollHalt) => void;
}

export class PollingScheduler {
  private readonly pipeline: Pollable;
  private readonly intervalMs: number;
  private readonly onTick: ((result: RefreshResult) => void) | undefined;
  private readonly onError: ((err: unknown) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Whether a tick is in progress. Prevents overlap (in the spirit of BR4.4's duplicate-start guard). */
  private inFlight = false;
  /** The overlap warning is printed once — one line is enough to say the interval is shorter than a collection. */
  private warnedOverlap = false;
  private readonly maxConsecutiveFailures: number;
  private readonly slowIntervalMs: number;
  private readonly onHalt: ((halt: PollHalt) => void) | undefined;
  /** The period the timer uses now. `slowIntervalMs` when slowed, `intervalMs` once recovered. */
  private activeIntervalMs: number;
  private consecutiveFailures = 0;
  private lastFailureReason: string | undefined;
  private haltState: PollHalt | null = null;

  constructor(deps: SchedulerDeps) {
    this.pipeline = deps.pipeline;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onTick = deps.onTick;
    this.onError = deps.onError;
    this.maxConsecutiveFailures = deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.slowIntervalMs = deps.slowIntervalMs ?? SLOW_INTERVAL_MS;
    this.onHalt = deps.onHalt;
    this.activeIntervalMs = this.intervalMs;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Why it slowed after consecutive failures, or null. The timer keeps running. */
  get halt(): PollHalt | null {
    return this.haltState;
  }

  /**
   * Revive a halted poll. The server calls it after a manual refresh succeeds — the only way back to
   * automatic collection without restarting the process once upstream has recovered. Harmless no-op
   * when not halted (`start()`'s duplicate guard keeps a single timer).
   */
  resume(): void {
    this.consecutiveFailures = 0;
    this.lastFailureReason = undefined;
    this.haltState = null;
    this.retime(this.intervalMs);
    this.start(false);
  }

  /** Re-arm the timer with a new period. When not running, only remember the period. */
  private retime(intervalMs: number): void {
    if (this.activeIntervalMs === intervalMs && this.timer !== null) return;
    this.activeIntervalMs = intervalMs;
    if (this.timer === null) return;
    this.stop();
    this.start(false);
  }

  /** Start polling. With runImmediately=true, run once at once and then every period. */
  start(runImmediately = false): void {
    if (this.timer !== null) return; // duplicate-start guard (BR4.4)
    if (runImmediately) void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.activeIntervalMs);
    // unref, so the timer does not keep the process alive (it lives as long as the server).
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one period. Failures are isolated: the exception is swallowed so the next period goes on (BR4.2).
   *
   * **Overlap guard.** `setInterval` does not ask whether the last tick finished, so with an interval
   * shorter than a collection `kiro-cli` spawns pile up without bound — measured: 10 at once with a
   * 20ms interval and 200ms of work. The 5-minute default against a 15-second collection timeout never
   * gets there, but `--interval` accepts smaller values, and `start()`'s duplicate guard (BR4.4) only
   * guarantees one timer; it does not stop ticks overlapping.
   *
   * A skipped tick is silent (warned the first time only). No information is lost: the collection
   * running now answers the same question, and a line logged every 20ms would only bury that fact.
   */
  async tick(): Promise<void> {
    if (this.inFlight) {
      if (!this.warnedOverlap) {
        this.warnedOverlap = true;
        console.warn(
          `[PollingScheduler] skipped a tick: the period came before the last collection finished — interval ${this.intervalMs}ms is shorter than a collection`,
        );
      }
      return;
    }
    this.inFlight = true;
    try {
      const result = await this.pipeline.run("auto");
      // A failed collection arrives not as an exception but as an `ok:false` snapshot (BR1.4's
      // non-destructive record). So the consecutive-failure judgement belongs here, not on the exception
      // path — a tick that completed normally but fetched no value is what a broken upstream looks like.
      //
      // **A storage failure counts as a failure too.** `persisted:false` means it was collected but not
      // written to the DB, and the screen reads stored snapshots, so nothing updates. Counting it as a
      // success would lift the slowdown with the DB unwritable, keep hammering at the normal period,
      // and have the manual refresh report a recovery that did not happen.
      if (result.snapshot.ok && result.persisted) this.noteSuccess();
      else this.noteFailure(result.snapshot.ok ? result.persistError : result.snapshot.reason);
      this.onTick?.(result);
    } catch (err) {
      console.warn(`[PollingScheduler] poll tick error (isolated): ${String(err)}`);
      this.noteFailure(String(err));
      this.onError?.(err);
    } finally {
      this.inFlight = false;
    }
  }

  private noteSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastFailureReason = undefined;
    // One success lifts the slowdown — that is all "heals itself" means.
    if (this.haltState !== null) {
      this.haltState = null;
      this.retime(this.intervalMs);
      console.warn("[PollingScheduler] collection recovered, back to the normal period");
    }
  }

  private noteFailure(reason?: string): void {
    this.consecutiveFailures++;
    if (reason !== undefined && reason.length > 0) this.lastFailureReason = reason;
    if (this.maxConsecutiveFailures <= 0) return;
    if (this.consecutiveFailures < this.maxConsecutiveFailures) return;
    if (this.haltState !== null) return; // already slowed — log once too
    const halt: PollHalt = {
      failures: this.consecutiveFailures,
      retryEveryMs: this.slowIntervalMs,
      ...(this.lastFailureReason === undefined ? {} : { lastReason: this.lastFailureReason }),
    };
    this.haltState = halt;
    // **It does not stop.** It only widens the period — a failed ACP collection calls no model, so a
    // permanent stop would only lose the value, and the slowdown returns on its own the moment upstream heals.
    this.retime(this.slowIntervalMs);
    const why =
      this.lastFailureReason === undefined ? "" : ` (last reason: ${this.lastFailureReason})`;
    console.warn(
      `[PollingScheduler] ${this.consecutiveFailures} consecutive failures: retry period widened to ${this.slowIntervalMs}ms — the manual refresh still works, and one success restores the normal period${why}`,
    );
    this.onHalt?.(halt);
  }
}
