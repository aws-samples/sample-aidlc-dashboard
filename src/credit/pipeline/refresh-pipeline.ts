// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * RefreshPipeline — the single entry point for collect→parse→store (BR3.1, FR5.3).
 *
 * A port absorbed into the aidlc-dashboard native tree. PollingScheduler (automatic) and the manual
 * refresh both reuse this pipeline, so the two paths cannot drift apart.
 *
 * Key adjustment (u1 alignment): u1's SnapshotStore is a **synchronous API** (`init(): void`,
 * `append(): void`, `maxSequence(): number`). The old async-store assumption was removed: `init()` is
 * synchronous, and `await` was dropped from the `append` and `maxSequence` calls. Collection (collect)
 * is still async, so `run` keeps returning `Promise<RefreshResult>`.
 *
 * Identity (BR3.2): each snapshot gets, besides its capture time (capturedAt), a monotonically
 * increasing sequence and a source (auto/manual). The sequence is assigned synchronously before the
 * collect await, so simultaneous auto + manual runs do not collide (pre-await sequence).
 *
 * Type ownership (producer-owned): `RefreshResult` is u2-owned and defined and exported here.
 * `CreditSnapshot` and `CaptureSource` are imported from u1's `../types`.
 */

import { type CollectResult, type CollectorDeps, collectUsage } from "../collector/usage-collector";
import { type ParseResult, parseUsage } from "../parser/usage-parser";
import type { CaptureSource, CreditSnapshot } from "../types";

/** The minimal store surface the pipeline consumes (u1's SnapshotStore satisfies it structurally). */
export interface PipelineStore {
  /** Highest stored sequence (the seed for continuity across restarts). 0 with no records. */
  maxSequence(): number;
  /** Store one snapshot, append-only. A contract violation or I/O error surfaces as a synchronous throw. */
  append(snapshot: CreditSnapshot): void;
}

/** The result of one refresh. u2-owned type. */
export interface RefreshResult {
  snapshot: CreditSnapshot;
  /** Whether storing succeeded. */
  persisted: boolean;
  /** Why storing failed (if it did). */
  persistError?: string;
}

/** Pipeline dependencies (injectable for tests). */
export interface PipelineDeps {
  store: PipelineStore;
  /**
   * **One-shot figure acquisition (the default)** — runs `/usage` over ACP and returns the structured
   * data directly as a `ParseResult`. Unlike the old path there is no text parsing step: the ACP
   * response is already structured, so label matching has nothing to do, and that label matching is
   * where upstream changes quietly broke things (acp-collector header comment).
   */
  acquire?: () => Promise<ParseResult>;
  /**
   * The old text path (`kiro-cli chat --no-interactive /usage` → `parseUsage`).
   *
   * Unused when `acquire` is given. It stays because the ACP extension is documented as experimental,
   * so the way back is kept open, and going back is one line in `bootCredit`. But this path **calls the
   * model** (= spends credit). Do not make it the default again.
   */
  collect?: (deps?: CollectorDeps) => Promise<CollectResult>;
  /** Collector sub-options (timeout, spawn, etc.). */
  collectorDeps?: CollectorDeps;
  /** Clock source (injected in tests). */
  now?: () => Date;
}

export class RefreshPipeline {
  private readonly store: PipelineStore;
  private readonly acquire: (() => Promise<ParseResult>) | undefined;
  private readonly collect: (deps?: CollectorDeps) => Promise<CollectResult>;
  private readonly collectorDeps: CollectorDeps | undefined;
  private readonly now: () => Date;
  private sequence = -1;

  constructor(deps: PipelineDeps) {
    this.store = deps.store;
    this.acquire = deps.acquire;
    this.collect = deps.collect ?? collectUsage;
    this.collectorDeps = deps.collectorDeps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Seed the monotonic counter from the store's existing highest sequence (continuity after a restart).
   * It consumes u1's synchronous API, so it is a synchronous method (no await).
   */
  init(): void {
    this.sequence = this.store.maxSequence();
  }

  /**
   * Run collect→parse→store once. Never throws (a failure is kept as a snapshot too).
   * The single entry point auto and manual share (BR3.1).
   */
  async run(source: CaptureSource): Promise<RefreshResult> {
    const capturedAt = this.now().toISOString();
    // The sequence is fixed synchronously before the collect await → unique even in simultaneous runs (BR3.2).
    const sequence = ++this.sequence;

    const snapshot = await this.buildSnapshot(capturedAt, sequence, source);

    try {
      // u1's synchronous store — called without await.
      this.store.append(snapshot);
      return { snapshot, persisted: true };
    } catch (err) {
      // An append contract violation or I/O error is not swallowed but surfaced in the result (no throw, BR3.4).
      const persistError = err instanceof Error ? err.message : String(err);
      console.warn(`[RefreshPipeline] snapshot not stored: ${persistError}`);
      return { snapshot, persisted: false, persistError };
    }
  }

  /** Assemble the collect/parse result into a CreditSnapshot. */
  private async buildSnapshot(
    capturedAt: string,
    sequence: number,
    source: CaptureSource,
  ): Promise<CreditSnapshot> {
    if (this.acquire !== undefined) {
      // The ACP path: collection and mapping are one step. A failure arrives as a `ParseResult` too, so
      // the same snapshot rules as the text path below apply (success keeps data only, failure raw + reason).
      const acquired = await this.acquire();
      return acquired.ok
        ? { capturedAt, sequence, source, ok: true, data: acquired.data }
        : { capturedAt, sequence, source, ok: false, raw: acquired.raw, reason: acquired.reason };
    }

    const collected = await this.collect(this.collectorDeps);
    if (!collected.ok) {
      // Collection failure: keep the diagnostic detail as the raw output.
      return {
        capturedAt,
        sequence,
        source,
        ok: false,
        raw: collected.detail,
        reason: collected.reason,
      };
    }

    const parsed = parseUsage(collected.raw);
    if (parsed.ok) {
      // Success: the raw output is not kept (volatile, BR3.3). Only structured data is stored.
      return { capturedAt, sequence, source, ok: true, data: parsed.data };
    }
    // Parse failure: keep the raw output and the reason — used for "show raw output" and to tell missing apart.
    return { capturedAt, sequence, source, ok: false, raw: parsed.raw, reason: parsed.reason };
  }
}
