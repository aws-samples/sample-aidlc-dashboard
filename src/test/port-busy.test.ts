// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

// A second launch on a taken port (src/launch.ts): an aidlc-dashboard already there is
// opened instead of failing, anything else is named with `--port`, and a Windows console
// waits for Enter. The integration cases spawn the bun running this test on the server's
// own entry point against a fake listener on 127.0.0.1; `PATH` is narrowed to bun's own
// directory so the credit boot in the failing case cannot find a real `kiro-cli`, and the
// data dir is a temp dir.

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isAddrInUse, probePort, shouldPause, startupPlan } from "../launch";
import { strings } from "../render/i18n";

const SERVER = path.join(import.meta.dir, "..", "server.ts");
const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
// The spawned server runs with the default language, English.
const CLI = strings("en").cli;

const fakes: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop(true);
});

function fake(handler: (req: Request) => Response): { port: number } {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  fakes.push(s);
  if (s.port === undefined) throw new Error("fake listener has no port");
  return { port: s.port };
}

function dashboardFake(root: string | null, selects: string[]) {
  return fake((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, root });
    if (url.pathname === "/select") {
      selects.push(url.searchParams.get("dir") ?? "");
      return new Response(null, { status: 303, headers: { location: "/" } });
    }
    return new Response("not found", { status: 404 });
  });
}

async function launch(...args: string[]) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-port-busy-"));
  const p = Bun.spawn([process.execPath, SERVER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      PATH: path.dirname(process.execPath),
      HOME: data,
      AIDLC_DASHBOARD_DATA_DIR: data,
    },
  });
  const timer = setTimeout(() => p.kill(), 15_000);
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  clearTimeout(timer);
  // Did credit boot? It opens the store, which creates the DB file in the data dir.
  const creditBooted = fs
    .readdirSync(data, { recursive: true })
    .some((f) => String(f).endsWith(".db"));
  fs.rmSync(data, { recursive: true, force: true });
  return { code, out, err, creditBooted };
}

describe("startupPlan", () => {
  test("nothing listening, or someone else: serve", () => {
    expect(startupPlan({ kind: "free" }, { port: 4321 })).toEqual({ action: "serve" });
    expect(startupPlan({ kind: "other" }, { port: 4321, root: "/w" })).toEqual({ action: "serve" });
  });

  test("a dashboard: reuse it, handing over a --root only when it differs", () => {
    const url = "http://127.0.0.1:4321/";
    expect(startupPlan({ kind: "dashboard", root: null }, { port: 4321 })).toEqual({
      action: "reuse",
      url,
    });
    expect(startupPlan({ kind: "dashboard", root: "/w" }, { port: 4321, root: "/w" })).toEqual({
      action: "reuse",
      url,
    });
    expect(startupPlan({ kind: "dashboard", root: "/a" }, { port: 4321, root: "/b" })).toEqual({
      action: "reuse",
      url,
      select: "/b",
    });
  });

  test("the pause is the installed executable on a Windows console only", () => {
    expect(shouldPause(true, "win32", true)).toBe(true);
    expect(shouldPause(false, "win32", true)).toBe(false);
    expect(shouldPause(true, "darwin", true)).toBe(false);
    expect(shouldPause(true, "win32", false)).toBe(false);
  });

  test("Bun's taken-port error is recognised", () => {
    expect(
      isAddrInUse(Object.assign(new Error("Failed to start server"), { code: "EADDRINUSE" })),
    ).toBe(true);
    expect(isAddrInUse(new Error("Failed to start server. Is port 4321 in use?"))).toBe(false);
    expect(isAddrInUse(new Error("EADDRINUSE: address already in use"))).toBe(true);
  });
});

describe("probePort", () => {
  test("tells a dashboard, another listener and a free port apart", async () => {
    expect(await probePort(dashboardFake("/w", []).port)).toEqual({
      kind: "dashboard",
      root: "/w",
    });
    expect(await probePort(fake(() => new Response("hello")).port)).toEqual({ kind: "other" });
    expect(await probePort(fake(() => Response.json({ ok: true })).port)).toEqual({
      kind: "other",
    });
    expect(await probePort(fake(() => new Response("x", { status: 404 })).port)).toEqual({
      kind: "other",
    });
    const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = gone.port;
    gone.stop(true);
    expect(await probePort(port ?? 0)).toEqual({ kind: "free" });
  });
});

describe("a second launch on a taken port", () => {
  test("an aidlc-dashboard there is opened instead, and handed the --root", async () => {
    const selects: string[] = [];
    const port = dashboardFake(null, selects).port;
    const r = await launch("--port", String(port), "--no-open", "--root", FIXTURE);
    expect(r.code).toBe(0);
    expect(r.out).toContain(CLI.alreadyRunning(`http://127.0.0.1:${port}/`));
    expect(r.out).toContain(CLI.switchedTo(path.resolve(FIXTURE)));
    expect(selects).toEqual([path.resolve(FIXTURE)]);
  });

  test("with no --root, it opens the running one and selects nothing", async () => {
    const selects: string[] = [];
    const port = dashboardFake("/somewhere", selects).port;
    const r = await launch("--port", String(port), "--no-open");
    expect(r.code).toBe(0);
    expect(r.out).toContain(CLI.alreadyRunning(`http://127.0.0.1:${port}/`));
    expect(selects).toEqual([]);
  });

  test("anything else on the port is named, with --port, and the process exits 1", async () => {
    const port = fake(() => new Response("someone else")).port;
    const r = await launch("--port", String(port), "--no-open");
    expect(r.code).toBe(1);
    expect(r.err).toContain(CLI.portBusy(port));
    // No console on stdin, so no pause: the process did not wait for Enter.
    expect(r.out).not.toContain(CLI.pressEnterToClose);
    // The bind comes before credit: a held port costs no store and no kiro-cli spawn (seen on
    // Windows: with credit first, the in-flight collection hit the closed store).
    expect(r.creditBooted).toBe(false);
  });
});
