// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * UsageCollector — runs `kiro-cli chat --no-interactive "/usage"` to obtain its raw output
 * (BR1.1–BR1.5). It contains no parsing logic.
 *
 * A port absorbed into the aidlc-dashboard native tree. `CollectResult`, `SpawnFn`, `buildMinimalEnv`
 * and `USAGE_ARGV` are u2-owned and defined and exported here.
 *
 * Hard contract (security-design NFR1.x / settled rules):
 * - Spawn with an **argument array (argv)**, never shell string interpolation (`shell: true` is
 *   forbidden, NFR1.1).
 * - Pass the child process **only the minimal environment variables** (least privilege, NFR1.2).
 * - Apply a **timeout** (15s), and classify a timeout, an abnormal (non-zero) exit and empty output as
 *   failures, handing them to the defensive parsing fallback path (BR1.3, BR1.4).
 * - Never record the raw `/usage` output to a permanent log or file (volatile) — this module only
 *   returns values and writes to no file.
 * - After reading stdout, **truncate it at 512KB** before handing it to the parser (NFR1.4).
 *
 * The timeout is enforced through `Bun.spawn`'s native `timeout` and `killSignal` (replacing an
 * implementation that called `proc.kill()` from its own setTimeout). The hand-rolled one had two
 * defects — (1) a child ignoring SIGTERM kept the pipe open, so it waited forever regardless of the
 * deadline, and (2) when a normal exit and the timer firing overlapped, complete output could be
 * classified as a timeout.
 *
 * Truncation was deliberately not moved to `maxBuffer` (Bun's native option that kills the process
 * past the cap). The `/usage` panel sits at the head of the output, so **the first 512KB is enough to
 * parse**, and killing at the cap would turn even that head into a failure. Instead, over-cap output
 * is truncated and handed to the parser.
 *
 * Testability: the spawn runner is injectable (SpawnFn), so success / timeout / abnormal exit / empty
 * output / launch error / 512KB truncation are checked in isolation without calling the real CLI (NFR5).
 */

/** Discriminated union of the collection result. On failure it also carries a diagnostic detail. */
export type CollectResult =
  | { ok: true; raw: string }
  | { ok: false; reason: string; detail: string };

/** The low-level result the injectable spawn runner returns. */
export interface SpawnOutcome {
  /** Process exit code. null when undetermined (killed, etc.). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Whether it was killed for a timeout. */
  timedOut: boolean;
}

/** Spawn runner signature. The default implementation uses Bun.spawn. */
export type SpawnFn = (
  argv: string[],
  opts: { timeoutMs: number; env: Record<string, string> },
) => Promise<SpawnOutcome>;

/** Collector dependencies (injected in tests). */
export interface CollectorDeps {
  spawn?: SpawnFn;
  /** Child process timeout (ms). Default 15s (CLI cold start + network headroom). */
  timeoutMs?: number;
  /** Environment variable source (for test injection). Default process.env. */
  envSource?: Record<string, string | undefined>;
}

/** The fixed argv used for the `/usage` query. Never string-interpolated. */
export const USAGE_ARGV: readonly string[] = ["kiro-cli", "chat", "--no-interactive", "/usage"];

const DEFAULT_TIMEOUT_MS = 15_000;
/** Maximum diagnostic detail length (prevents an excessive blob). */
const MAX_DETAIL_LEN = 4_000;
/** Byte cap of the raw stdout handed to the parser (512KB, security-design NFR1.4). */
export const MAX_STDOUT_BYTES = 512 * 1024;

/**
 * Build the minimal environment variable set (least privilege). Only the keys kiro-cli needs to find
 * itself, its settings and its credentials pass through.
 */
export function buildMinimalEnv(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const allow = ["PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/**
 * Truncate a string to maxBytes of UTF-8. At or below the cap, the input is returned as is.
 * Over the cap, the first maxBytes are returned (the decoder handles an incomplete multi-byte tail
 * safely). For ASCII input the byte cap is the character cap.
 */
function truncateBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const sliced = Buffer.from(s, "utf8").subarray(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(sliced);
}

/**
 * Grace period to wait for the pipe to close after the process died. Even with the child dead, a
 * grandchild holding stdout keeps the read from ending, so this cap gives up on that case within the deadline.
 */
const DRAIN_GRACE_MS = 2_000;

/** Default spawn implementation — runs Bun.spawn with argv and sets a native timeout. */
export const defaultSpawn: SpawnFn = async (argv, { timeoutMs, env }) => {
  const [cmd, ...args] = argv;
  if (cmd === undefined) {
    return { exitCode: null, stdout: "", stderr: "empty argv", timedOut: false };
  }
  const proc = Bun.spawn([cmd, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    // SIGKILL, not the default SIGTERM — a child ignoring signals would keep the pipe read below from
    // finishing. The `/usage` query is a read with no state to clean up, so an immediate kill loses nothing.
    killSignal: "SIGKILL",
  });

  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
    new Promise<null>((resolve) => {
      drainTimer = setTimeout(() => resolve(null), timeoutMs + DRAIN_GRACE_MS);
      drainTimer.unref();
    }),
  ]);
  clearTimeout(drainTimer);

  if (drained === null) {
    // The native timeout has already killed the process, but the pipe did not close. Waiting longer here
    // would let poll ticks pile up unfinished, so the output read so far is dropped and it is settled as a
    // timeout.
    //
    // The abandoned read is not cancelled — the stream is locked into a `Response`, so `cancel()` throws.
    // So once this path is taken, the pending reader holds the event loop and the process does not end on
    // its own (measured). The server goes down through `process.exit` on SIGINT/SIGTERM, so it has no effect.
    return { exitCode: null, stdout: "", stderr: "", timedOut: true };
  }

  await proc.exited;
  const [stdout, stderr] = drained;
  return {
    // null for a signal exit (the SpawnOutcome contract). The return value of `await proc.exited` folds a
    // signal into 128+n, so it is not used.
    exitCode: proc.exitCode,
    stdout,
    stderr,
    // SIGKILL only comes from the deadline set above. Even an external SIGKILL leaves the output
    // incomplete, so classifying it as a failure is right.
    timedOut: proc.signalCode === "SIGKILL",
  };
};

function truncateDetail(s: string): string {
  return s.length > MAX_DETAIL_LEN ? `${s.slice(0, MAX_DETAIL_LEN)}…(truncated)` : s;
}

/**
 * Collect `/usage`. Never throws; returns a CollectResult.
 */
export async function collectUsage(deps: CollectorDeps = {}): Promise<CollectResult> {
  const spawn = deps.spawn ?? defaultSpawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = buildMinimalEnv(deps.envSource ?? process.env);

  let outcome: SpawnOutcome;
  try {
    outcome = await spawn([...USAGE_ARGV], { timeoutMs, env });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "collection failed: process launch error",
      detail: truncateDetail(detail),
    };
  }

  if (outcome.timedOut) {
    return {
      ok: false,
      reason: `collection failed: timeout (over ${timeoutMs}ms)`,
      detail: truncateDetail(outcome.stderr || outcome.stdout),
    };
  }

  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      reason: `collection failed: abnormal exit (exit ${outcome.exitCode})`,
      detail: truncateDetail(outcome.stderr || outcome.stdout),
    };
  }

  // Some CLI builds render the /usage panel to stderr (exit 0). With stdout empty, stderr is used as the
  // raw source. Only when both are empty is it classified as an empty-output failure.
  const source = outcome.stdout.trim().length > 0 ? outcome.stdout : outcome.stderr;
  if (source.trim().length === 0) {
    return {
      ok: false,
      reason: "collection failed: empty output",
      detail: "",
    };
  }

  // After reading stdout, truncate it at 512KB before handing it to the parser (NFR1.4).
  const raw = truncateBytes(source, MAX_STDOUT_BYTES);
  return { ok: true, raw };
}
