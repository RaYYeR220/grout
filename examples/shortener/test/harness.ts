// Test harness: starts the built program the way the spec says it is run.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVOCATION = {"command":"node","args":["dist/server.js"]};
const PORT_ENV = "PORT";

export type RunResult = { code: number; stdout: string; stderr: string };

function command(extra: string[]): { cmd: string; args: string[]; shell: boolean } {
  if (INVOCATION.command === "node") {
    return { cmd: process.execPath, args: [resolve(ROOT, INVOCATION.args[0]), ...INVOCATION.args.slice(1), ...extra], shell: false };
  }
  return { cmd: "npm", args: ["--prefix", ROOT, ...INVOCATION.args, ...extra], shell: process.platform === "win32" };
}

/** A fresh empty directory, for programs that read or write files in their working directory. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "case-"));
}

/** Runs the CLI once. Defaults: cwd = project root, no stdin, 10 s timeout. */
export function runCli(args: string[], opts: { stdin?: string; env?: Record<string, string>; cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const { cmd, args: argv, shell } = command(args);
  return new Promise((done) => {
    const child = spawn(cmd, argv, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, shell });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: -1, stdout, stderr: stderr + "\n[harness] timed out" });
    }, opts.timeoutMs ?? 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => done(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), done(true)));
    s.once("error", () => done(false));
  });
}

export type Server = { baseUrl: string; port: number; output(): string; stop(): Promise<void> };

/** Starts the HTTP server on a free port (via the port env var) and waits until it accepts connections. */
export async function startServer(opts: { env?: Record<string, string>; cwd?: string } = {}): Promise<Server> {
  const port = await freePort();
  const { cmd, args, shell } = command([]);
  const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env, [PORT_ENV]: String(port) }, shell });
  let output = "";
  let exited = false;
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.on("exit", () => (exited = true));
  const deadline = Date.now() + 10_000;
  while (!(await canConnect(port))) {
    if (exited) throw new Error(`server exited before listening on ${PORT_ENV}=${port}:\n${output}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`server did not listen on ${PORT_ENV}=${port} within 10 s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    output: () => output,
    stop: () =>
      new Promise<void>((done) => {
        if (exited) return done();
        child.once("exit", () => done());
        child.kill("SIGKILL");
      }),
  };
}
