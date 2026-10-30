import { describe, expect, test } from "vitest";
import { Supervisor } from "../../src/participants/supervisor.js";
import { withEnvDoctor } from "../../src/participants/env-doctor.js";
import { createFactory } from "../../src/runtime.js";
import { FactoryState } from "../../src/state/factory-state.js";
import { ScriptedRunner, say } from "../../src/llm/scripted-runner.js";
import type { CmdResult, Sandbox } from "../../src/sandbox/types.js";

const ok = (cmd: string, extra: Partial<CmdResult> = {}): CmdResult => ({ cmd, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, outputs: {}, ...extra });

describe("Supervisor", () => {
  test("stops an agent that has been silent longer than its role allows", () => {
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 1 });
    const fc = createFactory({ state, runner: new ScriptedRunner(() => say("x")), models: { planner: "m", builder: "m", utility: "m" } });
    const stalled: string[] = [];
    fc.bus.emit = ((type: string, _p: string, payload: { agentId: string }) => {
      if (type === "agent.stalled") stalled.push(payload.agentId);
    }) as never;
    state.agents.set("b1", { agentId: "b1", role: "builder", slot: "builder-1", candidate: "A", taskId: "T1", model: "m", spawnedAt: 0 });
    state.agents.set("r1", { agentId: "r1", role: "reviewer", slot: "reviewer", candidate: "A", model: "m", spawnedAt: 0 });
    const sup = new Supervisor(fc, { stallMs: { builder: 1000, planner: 5000 } });
    sup.check(500);
    expect(state.stopped.size).toBe(0);
    sup.check(2000);
    expect(state.stopped.get("b1")).toMatch(/no activity for 2 s/);
    expect(state.stopped.has("r1")).toBe(false);
    expect(stalled).toEqual(["b1"]);
  });
});

describe("withEnvDoctor", () => {
  function fakeSandbox(results: CmdResult[]): Sandbox & { calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    const next = (cmd: string) => {
      calls.push(cmd);
      return results[Math.min(i++, results.length - 1)];
    };
    return {
      kind: "local",
      calls,
      init: async () => {},
      installDeps: async () => next("install"),
      exec: async (_f, cmd) => (cmd.startsWith("npm cache") ? (calls.push(cmd), ok(cmd)) : next(cmd)),
      cleanRoom: async (_f, cmds) => [next(cmds[0])],
      dispose: async () => {},
    };
  }

  test("network failures during install are retried; each retry is reported", async () => {
    const inner = fakeSandbox([ok("i", { exitCode: 1, stderr: "npm ERR! code ECONNRESET" }), ok("i", { exitCode: 1, stderr: "npm ERR! network socket hang up" }), ok("i")]);
    const fixes: string[] = [];
    const sb = withEnvDoctor(inner, (pattern, action) => fixes.push(`${pattern}:${action}`), 1);
    const r = await sb.installDeps("{}");
    expect(r.exitCode).toBe(0);
    expect(fixes).toEqual(["network:retry", "network:retry"]);
  });

  test("a corrupted npm cache is cleaned before retrying", async () => {
    const inner = fakeSandbox([ok("i", { exitCode: 1, stderr: "npm ERR! code EINTEGRITY" }), ok("i")]);
    const fixes: string[] = [];
    const sb = withEnvDoctor(inner, (pattern, action) => fixes.push(`${pattern}:${action}`), 1);
    expect((await sb.installDeps("{}")).exitCode).toBe(0);
    expect(inner.calls).toContain("npm cache clean --force");
    expect(fixes).toEqual(["npm-cache:npm cache clean --force, retry"]);
  });

  test("code errors are never retried", async () => {
    const inner = fakeSandbox([ok("t", { exitCode: 1, stdout: "error TS2322" })]);
    const fixes: string[] = [];
    const r = await withEnvDoctor(inner, (p) => fixes.push(p), 1).exec(new Map(), "npx tsc --noEmit -p .");
    expect(r.exitCode).toBe(1);
    expect(inner.calls).toHaveLength(1);
    expect(fixes).toEqual([]);
  });

  test("a port collision reruns the command once in a fresh snapshot", async () => {
    const inner = fakeSandbox([ok("t", { exitCode: 1, stderr: "Error: listen EADDRINUSE: address already in use" }), ok("t")]);
    const fixes: string[] = [];
    const r = await withEnvDoctor(inner, (p, a) => fixes.push(`${p}:${a}`), 1).exec(new Map(), "npx vitest run");
    expect(r.exitCode).toBe(0);
    expect(fixes).toEqual(["port-in-use:rerun on a new port"]);
  });
});
