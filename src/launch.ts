// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// What a second launch does when the port is already taken.
//
// MEASURED (Windows Server 2025, 2026-11-17): the first launch was still holding
// 127.0.0.1:4321 when the same executable was double-clicked again. `Bun.serve` threw,
// the process exited at once, and the console window it had been given closed before a
// word of the error could be read — the person saw nothing at all, and only found out by
// closing the old terminal. Two answers, one per cause:
//
//   - THE PORT IS HELD BY ANOTHER aidlc-dashboard. Starting a second server is not what
//     anyone wanted; they wanted the dashboard. So the launch asks `/healthz` first and,
//     when the answer is ours, opens the running one and exits 0. A `--root` that differs
//     from the running server's is handed to it through `/select` (the process speaks
//     plain HTTP and sends neither `Origin` nor `Sec-Fetch-Site`, which the server's
//     state-changing check reads as "not a browser" — the same as curl). The probe and
//     the select talk to `127.0.0.1` only: the bind address, never a name.
//   - THE PORT IS HELD BY SOMETHING ELSE (or the probe lost a race). The serve error is
//     said in the operator's language with `--port` named, and on a Windows console the
//     window waits for Enter — see `shouldPause`.
//
// The probe runs before the credit subsystem boots, so a launch that only opens the
// running dashboard spawns no `kiro-cli` and writes nothing.

import { HOST } from "./cli";

export type Probe =
  /** Something answered `/healthz` in our shape: `{ ok: true, root: string | null }`. */
  | { kind: "dashboard"; root: string | null }
  /** Something holds the port but is not an aidlc-dashboard, or did not answer in time. */
  | { kind: "other" }
  /** Nothing is listening: start as usual. */
  | { kind: "free" };

export type Plan =
  | { action: "serve" }
  /** Open the running server; `select` is the `--root` to hand it, when it differs. */
  | { action: "reuse"; url: string; select?: string };

const PROBE_TIMEOUT_MS = 700;

/** Ask `127.0.0.1:<port>/healthz` who is there. Never throws. */
export async function probePort(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  let res: Response;
  try {
    res = await fetch(`http://${HOST}:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
  } catch (err) {
    // Refused is the one "nothing there"; a timeout or a non-HTTP listener is "other".
    const code = (err as { code?: string } | undefined)?.code;
    return code === "ConnectionRefused" || code === "ECONNREFUSED"
      ? { kind: "free" }
      : { kind: "other" };
  }
  if (res.status !== 200) return { kind: "other" };
  try {
    const body = (await res.json()) as { ok?: unknown; root?: unknown };
    if (
      body?.ok === true &&
      "root" in body &&
      (body.root === null || typeof body.root === "string")
    ) {
      return { kind: "dashboard", root: body.root };
    }
  } catch {
    // Not JSON — not ours.
  }
  return { kind: "other" };
}

/** The decision, without sockets: start, or open the dashboard that is already running. */
export function startupPlan(probe: Probe, opts: { port: number; root?: string }): Plan {
  if (probe.kind !== "dashboard") return { action: "serve" };
  const url = `http://${HOST}:${opts.port}/`;
  return opts.root !== undefined && opts.root !== probe.root
    ? { action: "reuse", url, select: opts.root }
    : { action: "reuse", url };
}

/**
 * Hand `root` to the running server. `/select` answers 303 to `/` when it took the
 * workspace; anything else (303 to `/browse` for a plain folder, 400, a network error)
 * means the running server kept what it had.
 */
export async function selectOn(
  port: number,
  root: string,
): Promise<"selected" | number | "failed"> {
  try {
    const res = await fetch(`http://${HOST}:${port}/select?dir=${encodeURIComponent(root)}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 303 && res.headers.get("location") === "/" ? "selected" : res.status;
  } catch {
    return "failed";
  }
}

/**
 * Keep the window open after a fatal startup error? Only the installed executable on
 * Windows with a console on stdin — the double-click case, where the console closes with
 * the process. A source run, a pipe or a test (no TTY) must never wait for input.
 */
export function shouldPause(compiled: boolean, platform: string, stdinIsTTY: boolean): boolean {
  return compiled && platform === "win32" && stdinIsTTY;
}

/** Print `prompt` and wait for one line on stdin. */
export async function waitForEnter(prompt: string): Promise<void> {
  process.stdout.write(`${prompt}\n`);
  for await (const _ of console) break;
}

/** Bun's error for a taken port. */
export function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  return e?.code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(e?.message ?? "");
}
