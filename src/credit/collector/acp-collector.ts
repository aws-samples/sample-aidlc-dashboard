// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * AcpUsageCollector — reads the Kiro credit balance over ACP (Agent Client Protocol).
 *
 * **Why `chat --no-interactive /usage` was dropped.** The Kiro documentation states the combination is
 * unsupported — `reference/slash-commands.md`: *"Slash commands are only available in interactive
 * chat mode"*, `cli/headless.md` Limitations: *"Interactive slash commands are not available"*.
 * It only worked by accident for a while, and in `kiro-cli 2.21.4` (KAS 0.63.3) `/usage` is handed **to
 * the model as a prompt** (measured: a prose reply "I don't have a direct meter to report", 9.4s, exit 0).
 * So the old path spent credit to read credit.
 *
 * **ACP is the documented path.** `cli/acp.md` — `kiro-cli acp` comes up as a JSON-RPC 2.0 server on
 * stdin/stdout, and the Kiro extension `_kiro.dev/commands/execute` runs a slash command. `/usage` is in
 * the `_kiro.dev/commands/available` list (one of 25, `inputType: "panel"`), and running it returns
 * **structured data** — prose parsing disappears.
 *
 * Measured comparison (2026-09-12):
 *
 *   | | old path | ACP |
 *   |---|---|---|
 *   | model call | every time | none |
 *   | response | 9.4s+ / timeout | 2.1s (cold) · 0.9s (reused session) |
 *   | output | prose | JSON |
 *
 * **The call shape is undocumented and was recovered from serde errors.** `command` is the adjacently
 * tagged enum `TuiCommand`, with tag field `command` and content field `args`. So it nests twice:
 *
 *   params = { sessionId, command: { command: "usage", args: {} } }
 *
 * `args: null` is refused (*"invalid type: null, expected struct UsageArgs"*) — it must be an empty object.
 *
 * **The session is reused.** `session/new` leaves two files at the top of `~/.kiro/sessions/cli/`
 * (`<id>.json` + `<id>.jsonl`). Pinned by measurement — three collections cost **+2 files with a shared
 * session, +6 without**. So with no reuse, 5-minute polling piles up 576 a day; with reuse it is **2 per
 * server restart**. `session/load` reopens the same id (measured OK: load + exec 932ms against a cold
 * 2.1s), and then nothing grows. We do not clean Kiro's directory — it is another tool's state, and
 * making less of it is the honest share we control.
 *
 * **CLI V3 is a second server generation, read through a second adapter.** In kiro-cli 3.x `kiro-cli
 * acp` can start either harness — the `--agent-engine` flag, then the `acp.agentEngine` setting, then a
 * launch default (`cli/agent-harness.md` "ACP clients"; `cli/v3/acp-migration.md`). V3 removes
 * `_kiro.dev/commands/execute` and replaces `/usage` with `_kiro/account/getUsage`. Measured on kiro-cli
 * 3.5.0 (2026-11-19):
 *
 *   | launch | `commands/execute` | `account/getUsage` |
 *   |---|---|---|
 *   | `kiro-cli acp` (nothing set) | V2 — works | -32601 Method not found |
 *   | `--agent-engine=v3` | -32603 Internal error | works, with no session and `{}` params |
 *
 * So the argv names no engine: pinning one would break kiro-cli before 2.36 (no flag) or a Linux machine
 * that cannot run V3. Instead the generation is read from `initialize` (`isCliV3Server`) — never from
 * `protocolVersion`, which is 1 on both. V3's `data` has the same schema as V2's, with one measured
 * difference: `percentage` arrives as a whole number (195 where V2 sent 195.9594). `getUsage` is NOT in
 * the advertised `extensionMethods` list on 3.5.0, so the call cannot be gated on it the way the
 * migration guide asks; a refusal is reported as one, loudly. And V3 needs no session at all for it, so
 * the V3 path writes no session files.
 *
 * Hard contract (same as the old collector): argument-array spawn (`shell: true` forbidden, NFR1.1),
 * minimal environment variables (NFR1.2), a timeout (BR1.3), and no raw output left in files
 * (volatile, BR3.3).
 *
 * **Do not forget these methods have moved once already.** `cli/acp.md` used to call the `_kiro.dev/`
 * extensions *"experimental and subject to change"*; it now says they *"apply to the CLI v2 ACP server
 * only"*, and V3 replaced the one this module used. So a schema change must fail **loudly** — that is
 * exactly why the old path's failure mode was bad: it received prose without knowing it had failed and was
 * misdiagnosed as a timeout. But "loudly" means, as the `mapAcpUsage` comment says, **telling missing
 * apart from wrong-typed**, not lumping both together and refusing everything.
 */

import type { ParseResult } from "../parser/usage-parser";
import type { ParsedUsage } from "../types";

/** ACP server launch argv. This module owns it, under the same rules as the old `USAGE_ARGV`. */
export const ACP_ARGV: readonly string[] = ["kiro-cli", "acp"];

/** Whole round-trip timeout. A measured 2.1s cold start + headroom for MCP server initialisation. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Maximum diagnostic detail length (prevents an excessive blob) — the same cap as the old collector. */
const MAX_DETAIL_LEN = 4_000;

/** Holder of the session id reused for the life of the process. The caller (bootCredit) keeps it. */
export interface AcpSessionRef {
  id?: string;
}

export interface AcpCollectorDeps {
  timeoutMs?: number;
  envSource?: Record<string, string | undefined>;
  /** Session reuse holder. Without it every call makes a new session (a test convenience). */
  session?: AcpSessionRef;
  /** Injection point standing in for the JSON-RPC round trip — keeps tests from calling the real CLI. */
  rpc?: AcpRpc;
  /** The cwd passed to `session/new`. Default the process cwd. */
  cwd?: string;
}

/** The minimal surface exposing only the round trips one ACP session needs. */
export interface AcpRpc {
  call(method: string, params?: unknown): Promise<AcpResponse>;
  close(): void;
}

export interface AcpResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Minimal environment variables (NFR1.2). The same allowlist as the old collector. */
function buildMinimalEnv(src: Record<string, string | undefined>): Record<string, string> {
  const allow = ["PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const v = src[key];
    if (typeof v === "string" && v.length > 0) env[key] = v;
  }
  return env;
}

function clip(s: string): string {
  return s.length > MAX_DETAIL_LEN ? `${s.slice(0, MAX_DETAIL_LEN)}…` : s;
}

/** stdout buffer cap. Stops output with no newline from piling up forever (treated as a protocol error). */
const MAX_LINE_BYTES = 1024 * 1024;

/**
 * The real JSON-RPC client. One line = one message (JSON Lines).
 *
 * **Pending calls settle on a wall-clock deadline, not on stdout EOF.** This is the most important line
 * of this function, and it was wrong at first: releasing `pending` was tied only to the end of the
 * stdout loop. But EOF follows the life of **the grandchild holding the FD, not the direct child** —
 * `kiro-cli acp` starts KAS (node), so in a measurement the child died by SIGKILL at 1,512ms and the
 * stdout loop ended only at 1,923ms (34ms against 1,025ms in another observation). With the grandchild
 * alive, EOF may never come, and then `call()` waits forever → `collectUsageViaAcp` never returns →
 * `PollingScheduler`'s `inFlight` stays set for good and **polling dies silently** (never even reaching
 * the consecutive-failure counter). That is exactly why the old collector kept a separate `DRAIN_GRACE_MS`.
 *
 * **The reader's errors must be swallowed.** At first it was thrown away as `void (async () => …)()`;
 * when the stream loop throws, that promise becomes an unhandled rejection and **Bun terminates the
 * process** (measured: exit 1, a timer set after it never ran). A direct violation of the contract that
 * a credit failure never takes the dashboard down — the same class of thing the spawn `error` listener
 * on `/open` prevents.
 */
export function spawnAcpRpc(
  timeoutMs: number,
  env: Record<string, string>,
  /** Launch argv. Default `ACP_ARGV`; left open so tests can plug in a fake agent that knows the script
   *  (better than monkey-patching the global `Bun.spawn`). */
  argv: readonly string[] = ACP_ARGV,
): AcpRpc {
  const proc = Bun.spawn([...argv], {
    stdin: "pipe",
    stdout: "pipe",
    // stderr is discarded: KAS pours INFO logs into it, and we read only the JSON on stdout.
    stderr: "ignore",
    env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });

  const enc = new TextEncoder();
  let nextId = 0;
  const pending = new Map<number, (r: AcpResponse) => void>();
  let closed = false;

  const settleAll = (message: string) => {
    for (const [, resolve] of pending) resolve({ error: { message } });
    pending.clear();
  };

  const killChild = () => {
    try {
      proc.stdin.end();
    } catch {
      // Already closed: nothing to do.
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead: nothing to do.
    }
  };

  // Deadline: settled at this point no matter what state the child and grandchild are in.
  const deadline = setTimeout(() => {
    settleAll(`ACP response timeout (over ${timeoutMs}ms)`);
    killChild();
  }, timeoutMs);
  // So this timer does not hold up the process exit (it lives as long as the server).
  if (typeof deadline === "object" && deadline !== null && "unref" in deadline) {
    (deadline as unknown as { unref: () => void }).unref();
  }

  // Own the reader promise and turn **every** error into a settlement — no discarded rejection.
  const reader = (async () => {
    // `{ stream: true }` — a multi-byte character split at a chunk boundary would break into U+FFFD
    // with a plain decode. The final flush happens once after the loop.
    const dec = new TextDecoder("utf-8");
    let buf = "";
    const drain = () => {
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.length === 0) continue;
        try {
          const msg = JSON.parse(line) as { id?: number } & AcpResponse;
          // Notifications (no id) are discarded — this collector only uses request responses.
          if (typeof msg.id !== "number") continue;
          const resolve = pending.get(msg.id);
          if (resolve !== undefined) {
            pending.delete(msg.id);
            resolve(msg);
          }
        } catch {
          // Lines that are not JSON are ignored (logs leaking onto stdout).
        }
      }
    };
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      drain();
      if (buf.length > MAX_LINE_BYTES) {
        // Past the cap with no newline = not JSON Lines. No reason to hold on to it.
        settleAll("ACP output passed the line cap (protocol error)");
        killChild();
        return;
      }
    }
    buf += dec.decode();
    drain();
  })()
    .catch((err) => {
      // A stream error is just a failed round trip too — the process is not allowed to die.
      settleAll(`ACP output read failed: ${String(err)}`);
    })
    .finally(() => {
      settleAll("the ACP process ended before responding");
    });

  return {
    call(method, params) {
      if (closed) {
        return Promise.resolve({ error: { message: "called on a closed ACP connection" } });
      }
      const id = nextId++;
      return new Promise<AcpResponse>((resolve) => {
        pending.set(id, resolve);
        try {
          proc.stdin.write(
            enc.encode(
              `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
            ),
          );
          proc.stdin.flush();
        } catch (err) {
          pending.delete(id);
          resolve({ error: { message: `stdin write failed: ${String(err)}` } });
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      // Settle pending calls **at once** — the caller is released even with a grandchild holding stdout.
      settleAll("the ACP connection closed");
      killChild();
      // The reader ends on its own and swallows every error above. It is not awaited because that wait
      // would hang on the grandchild's life, which is exactly the coupling this function avoids.
      void reader;
    },
  };
}

/** ACP `initialize` parameters. File and terminal capabilities are all false — we call one command only. */
const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  clientInfo: { name: "aidlc-dashboard", version: "1" },
} as const;

/**
 * Whether an `initialize` result came from the CLI V3 server. V3 advertises its optional methods in
 * `agentCapabilities._meta.kiro.extensionMethods`; the V2 server sends no `_meta` there at all
 * (measured, kiro-cli 3.5.0). Anything unreadable is V2 — the path that worked before this check.
 */
export function isCliV3Server(initResult: unknown): boolean {
  const field = (v: unknown, key: string): unknown =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
  const kiro = field(field(field(initResult, "agentCapabilities"), "_meta"), "kiro");
  return Array.isArray(field(kiro, "extensionMethods"));
}

function errText(e: AcpResponse["error"]): string {
  if (e === undefined) return "unknown error";
  const detail = e.data === undefined ? "" : ` ${JSON.stringify(e.data)}`;
  return clip(`${e.message ?? "error"}${detail}`);
}

/**
 * `/usage` response `data` → `ParsedUsage`.
 *
 * **Missing and wrong-typed are handled differently.** This header once said "a missing or wrong-typed
 * field fails loudly", while the code handled only `used` that way — the comment claimed more than the
 * code, which in this repository is a defect. Now it follows the rule `normalizeUsage` already set:
 *
 *   - **Missing → null + `partial`.** The screen says partial data, and the other values survive.
 *   - **Wrong-typed → refused as a corrupt response.** A string where a number belongs means the schema
 *     changed, and folding it quietly into null loses the chance to say "the format changed".
 *
 * The `CREDIT` breakdown is found by name for the same reason: taking the array's first entry would, on
 * the day Kiro adds an entry, insist another resource's figures are the credit.
 */
export function mapAcpUsage(data: unknown): ParseResult {
  const raw = clip(JSON.stringify(data ?? null));
  if (typeof data !== "object" || data === null) {
    return {
      ok: false,
      raw,
      reason: "No recognisable credit figures found (the format may have changed).",
    };
  }
  const d = data as Record<string, unknown>;
  const breakdowns = d.usageBreakdowns;
  if (!Array.isArray(breakdowns)) {
    return {
      ok: false,
      raw,
      reason: "No recognisable credit figures found (the format may have changed).",
    };
  }
  const credit = breakdowns.find(
    (b): b is Record<string, unknown> =>
      typeof b === "object" &&
      b !== null &&
      (b as Record<string, unknown>).resourceType === "CREDIT",
  );
  if (credit === undefined) {
    return {
      ok: false,
      raw,
      reason: "No CREDIT entry in usageBreakdowns (the format may have changed).",
    };
  }

  // Missing (undefined/null) is null; **wrong-typed is an exceptional signal** — refused below as corrupt.
  const BAD = Symbol("wrong-type");
  const num = (v: unknown): number | null | typeof BAD => {
    if (v === undefined || v === null) return null;
    return typeof v === "number" && Number.isFinite(v) ? v : BAD;
  };
  const str = (v: unknown): string | null | typeof BAD => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return BAD;
    return v.length > 0 ? v : null;
  };
  const malformed = (field: string): ParseResult => ({
    ok: false,
    raw,
    reason: `${field} has an unexpected type (the format may have changed).`,
  });

  // `hasLimit` must be a boolean. The old code used `!== false`, so `"false"` and `0` read as "has a
  // limit" too, and then a gauge was drawn against a limit that does not exist.
  const hasLimitRaw = credit.hasLimit;
  if (hasLimitRaw !== undefined && typeof hasLimitRaw !== "boolean") {
    return malformed("hasLimit");
  }
  const hasLimit = hasLimitRaw !== false;

  const used = num(credit.used);
  if (used === BAD) return malformed("used");
  const limitRead = num(credit.limit);
  if (limitRead === BAD) return malformed("limit");
  const limit = hasLimit ? limitRead : null;
  // The usage ratio uses the percentage Kiro gives (0–100 → 0–1). Recomputing it from used/limit could
  // disagree with Kiro's own arithmetic, which mixes in overage and add-ons. Dividing by 100 and keeping
  // 6 decimals is for the same reason as `remainingAmount` — `76.5006 / 100` gives `0.7650060000000001`,
  // and that tail is a digit the source never had (percentage has 4 decimals).
  const pct = num(credit.percentage);
  if (pct === BAD) return malformed("percentage");
  const planName = str(d.planName);
  if (planName === BAD) return malformed("planName");
  const resetDate = str(d.billingCycleReset);
  if (resetDate === BAD) return malformed("billingCycleReset");

  // The remaining amount is the difference of two measured values — the old parser read it from the raw
  // output, but ACP does not send it. Keeping 2 decimals **drops** precision: Kiro gives `7609.69`, so the
  // subtraction's `2390.3100000000004` holds digits the source never had, and printing it would claim
  // precision that does not exist.
  const remaining = used !== null && limit !== null ? Math.round((limit - used) * 100) / 100 : null;

  const parsed: ParsedUsage = {
    planName,
    usedAmount: used,
    remainingAmount: remaining,
    planLimit: limit,
    usageRatio: pct === null ? null : Math.round((pct / 100) * 1e6) / 1e6,
    resetDate,
    partial: false,
  };
  parsed.partial = Object.entries(parsed).some(([k, v]) => k !== "partial" && v === null);

  // If usage itself could not be read, it is not called a success — it is the gauge's numerator.
  if (used === null) {
    return {
      ok: false,
      raw,
      reason: "No recognisable credit figures found (the format may have changed).",
    };
  }
  return { ok: true, data: parsed };
}

/**
 * Run `/usage` once over ACP and return a `ParseResult`. Never throws.
 *
 * On a V2 server the session reuses the id cached in `deps.session` through `session/load`, and on
 * failure (deleted, stale id) falls back once to `session/new`. A V3 server needs no session.
 */
export async function collectUsageViaAcp(deps: AcpCollectorDeps = {}): Promise<ParseResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = buildMinimalEnv(deps.envSource ?? process.env);
  const cwd = deps.cwd ?? process.cwd();
  const sessionRef = deps.session;

  let rpc: AcpRpc;
  try {
    rpc = deps.rpc ?? spawnAcpRpc(timeoutMs, env);
  } catch (err) {
    return {
      ok: false,
      raw: "",
      reason: `collection failed: ACP could not start (${clip(String(err))})`,
    };
  }

  try {
    const init = await rpc.call("initialize", INIT_PARAMS);
    if (init.error !== undefined) {
      return {
        ok: false,
        raw: "",
        reason: `collection failed: initialize (${errText(init.error)})`,
      };
    }

    if (isCliV3Server(init.result)) {
      // V3: one typed call, no session — see the generation table in the header.
      const usage = await rpc.call("_kiro/account/getUsage", {});
      if (usage.error !== undefined) {
        return {
          ok: false,
          raw: "",
          reason: `collection failed: /usage (_kiro/account/getUsage) refused (${errText(usage.error)})`,
        };
      }
      return readUsageResult(usage.result);
    }

    let sessionId: string | undefined;
    const cached = sessionRef?.id;
    if (cached !== undefined) {
      const loaded = await rpc.call("session/load", { sessionId: cached, cwd, mcpServers: [] });
      if (loaded.error === undefined) sessionId = cached;
    }
    if (sessionId === undefined) {
      const created = await rpc.call("session/new", { cwd, mcpServers: [] });
      if (created.error !== undefined) {
        return {
          ok: false,
          raw: "",
          reason: `collection failed: session/new (${errText(created.error)})`,
        };
      }
      const r = created.result;
      const id =
        typeof r === "object" && r !== null ? (r as Record<string, unknown>).sessionId : undefined;
      if (typeof id !== "string" || id.length === 0) {
        return {
          ok: false,
          raw: clip(JSON.stringify(r ?? null)),
          reason: "No sessionId in the session/new response (the format may have changed).",
        };
      }
      sessionId = id;
      if (sessionRef !== undefined) sessionRef.id = id;
    }

    const exec = await rpc.call("_kiro.dev/commands/execute", {
      sessionId,
      // The double nesting is right — see the TuiCommand note in the header above. `args: {}`, not null.
      command: { command: "usage", args: {} },
    });
    if (exec.error !== undefined) {
      // A changed method or schema lands here — this method already changed once (see the V3 note above).
      return {
        ok: false,
        raw: "",
        reason: `collection failed: /usage execution refused (${errText(exec.error)})`,
      };
    }
    return readUsageResult(exec.result);
  } finally {
    rpc.close();
  }
}

/** The `{success, message, data}` envelope both generations answer `/usage` with (measured on both). */
function readUsageResult(res: unknown): ParseResult {
  if (typeof res !== "object" || res === null) {
    return {
      ok: false,
      raw: clip(JSON.stringify(res ?? null)),
      reason: "No recognisable credit figures found (the format may have changed).",
    };
  }
  const r = res as Record<string, unknown>;
  // `!== false` is not enough — a vanished field or a `"false"` string would pass.
  // Observed responses always carry `success: true`, so anything else is not called a success.
  if (r.success !== true) {
    return {
      ok: false,
      raw: clip(typeof r.message === "string" ? r.message : JSON.stringify(r)),
      reason: "collection failed: /usage did not report success.",
    };
  }
  return mapAcpUsage(r.data);
}
