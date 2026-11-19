// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * UsageCollector tests — an injectable spawn checks success / timeout / abnormal exit / empty output /
 * launch error / 512KB truncation / exact argv / the env allowlist in isolation. The real kiro-cli is
 * never called (NFR5). A port absorbed into the aidlc-dashboard native tree.
 *
 * Only the `defaultSpawn` block at the bottom starts a real process. What it starts is **the bun running
 * the tests itself** (`process.execPath`), so it depends on no external CLI, network or workspace —
 * whether the native timeout really bites cannot be checked with a stub, and the defect that regressed
 * here (waiting forever on a child that ignores SIGTERM) was exactly on this path.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_STDOUT_BYTES,
  type SpawnFn,
  type SpawnOutcome,
  USAGE_ARGV,
  buildMinimalEnv,
  collectUsage,
  defaultSpawn,
} from "./usage-collector";

/** Stub spawn factory returning a fixed result. Records the call arguments. */
function stubSpawn(outcome: SpawnOutcome): {
  fn: SpawnFn;
  calls: Array<{ argv: string[]; env: Record<string, string> }>;
} {
  const calls: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const fn: SpawnFn = async (argv, opts) => {
    calls.push({ argv, env: opts.env });
    return outcome;
  };
  return { fn, calls };
}

describe("UsageCollector", () => {
  test("normal output → ok:true and the raw output", async () => {
    const { fn } = stubSpawn({
      exitCode: 0,
      stdout: "Plan: Pro\nUsed: 100\n",
      stderr: "",
      timedOut: false,
    });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.raw).toContain("Plan: Pro");
  });

  test("calls with the exact argv and uses no shell interpolation", async () => {
    const { fn, calls } = stubSpawn({
      exitCode: 0,
      stdout: "Used: 1\n",
      stderr: "",
      timedOut: false,
    });
    await collectUsage({ spawn: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual([...USAGE_ARGV]);
    // Check that "/usage" is passed as one argument token (not assembled into a string).
    expect(calls[0]?.argv).toContain("/usage");
    expect(calls[0]?.argv).toContain("--no-interactive");
  });

  test("a timeout is classified as a failure, and the reason says timeout", async () => {
    const { fn } = stubSpawn({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const result = await collectUsage({ spawn: fn, timeoutMs: 5000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("timeout");
  });

  test("an abnormal (non-zero) exit is classified as a failure and stderr is kept as the detail", async () => {
    const { fn } = stubSpawn({
      exitCode: 1,
      stdout: "",
      stderr: "not authenticated",
      timedOut: false,
    });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("abnormal exit");
    expect(result.detail).toContain("not authenticated");
  });

  test("empty output is classified as a failure", async () => {
    const { fn } = stubSpawn({ exitCode: 0, stdout: "   \n", stderr: "", timedOut: false });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("empty output");
  });

  test("stdout empty and the panel on stderr (exit 0) → stderr is used as the raw output", async () => {
    // Some kiro-cli builds render the /usage panel to stderr.
    const { fn } = stubSpawn({
      exitCode: 0,
      stdout: "",
      stderr:
        "Estimated Usage | resets on 9-1-2026 | KIRO POWER\nCredits (1 of 2 covered in plan)\n",
      timedOut: false,
    });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.raw).toContain("KIRO POWER");
  });

  test("a throwing spawn is swallowed and returned as a failure result", async () => {
    const fn: SpawnFn = async () => {
      throw new Error("ENOENT: kiro-cli not found");
    };
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("process launch error");
    expect(result.detail).toContain("ENOENT");
  });

  test("stdout over 512KB is truncated at 512KB (security-design NFR1.4)", async () => {
    // A stub returning 512KB + extra ASCII characters as stdout.
    const oversized = "A".repeat(MAX_STDOUT_BYTES + 4096);
    const { fn } = stubSpawn({ exitCode: 0, stdout: oversized, stderr: "", timedOut: false });
    const result = await collectUsage({ spawn: fn });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // ASCII is 1 byte = 1 character, so the byte cap is the character cap. Truncated at 512KB.
    expect(Buffer.byteLength(result.raw, "utf8")).toBe(MAX_STDOUT_BYTES);
    expect(result.raw.length).toBe(MAX_STDOUT_BYTES);
  });

  test("buildMinimalEnv passes only the allowed keys (least privilege)", () => {
    const env = buildMinimalEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      AWS_SECRET_ACCESS_KEY: "leak-me",
      SOME_TOKEN: "secret",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
  });

  test("env allowlist: even an envSource holding disallowed keys does not pass them on", async () => {
    const { fn, calls } = stubSpawn({
      exitCode: 0,
      stdout: "Used: 1\n",
      stderr: "",
      timedOut: false,
    });
    await collectUsage({
      spawn: fn,
      envSource: {
        PATH: "/usr/bin",
        HOME: "/home/user",
        XDG_CONFIG_HOME: "/home/user/.config",
        AWS_SECRET_ACCESS_KEY: "leak-me",
        GITHUB_TOKEN: "secret",
      },
    });
    const passedEnv = calls[0]?.env ?? {};
    expect(passedEnv.PATH).toBe("/usr/bin");
    expect(passedEnv.HOME).toBe("/home/user");
    expect(passedEnv.XDG_CONFIG_HOME).toBe("/home/user/.config");
    expect(passedEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(passedEnv.GITHUB_TOKEN).toBeUndefined();
  });
});

describe("defaultSpawn (native timeout)", () => {
  /** Starts bun itself with an inline script. An absolute path, so no PATH is needed either (env is empty). */
  function bunScript(source: string): string[] {
    return [process.execPath, "-e", source];
  }

  test("a normal exit returns stdout as is and timedOut=false", async () => {
    const outcome = await defaultSpawn(bunScript('process.stdout.write("Used: 1\\n");'), {
      timeoutMs: 5_000,
      env: {},
    });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("Used: 1\n");
  });

  test("an abnormal exit keeps exitCode and stderr", async () => {
    const outcome = await defaultSpawn(
      bunScript('process.stderr.write("not authenticated\\n"); process.exit(3);'),
      { timeoutMs: 5_000, env: {} },
    );
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderr).toContain("not authenticated");
  });

  test("a child ignoring SIGTERM still ends within the deadline and timedOut=true", async () => {
    // The hand-rolled timeout sent only SIGTERM, so it waited forever on this child (regression guard).
    const started = Date.now();
    const outcome = await defaultSpawn(
      bunScript('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'),
      { timeoutMs: 300, env: {} },
    );
    expect(outcome.timedOut).toBe(true);
    // A signal exit, so exitCode is null per the contract.
    expect(outcome.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("collectUsage promotes defaultSpawn's timeout to the failure reason", async () => {
    const result = await collectUsage({
      spawn: (_argv, opts) =>
        defaultSpawn(bunScript('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'), {
          ...opts,
          timeoutMs: 300,
        }),
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("timeout");
  });
});
