// Black-box helpers: start the project under TARGET_DIR exactly the way its spec says it is run.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** A command prefix as a spec states it: `["node", "dist/cli.js"]`, `["npm", "start"]`, `["npm", "run", "serve"]`. */
export type Command = string[];
export type Env = Record<string, string | undefined>;
export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { stdin?: string; cwd?: string; env?: Env; timeoutMs?: number };

/** The project under test. */
export function target(): string {
  const dir = process.env.TARGET_DIR;
  if (!dir) throw new Error("TARGET_DIR is not set; point it at the project under test");
  return resolve(dir);
}

/** Set by the global setup, which removes the whole directory after the run. */
export const TEMP_ROOT_ENV = "GROUT_BENCH_TMP";

const tempDirs: string[] = [];

/** A fresh empty directory, removed after the run. */
export function tempDir(): string {
  const root = process.env[TEMP_ROOT_ENV];
  if (root) return mkdtempSync(join(root, "case-"));
  const dir = mkdtempSync(join(tmpdir(), "grout-bench-"));
  tempDirs.push(dir);
  return dir;
}

/** The command behind a `bin` entry of the target's package.json, as `["node", <entry>]`. */
export function bin(name: string): Command {
  const pkg = JSON.parse(readFileSync(join(target(), "package.json"), "utf8")) as { name?: string; bin?: unknown };
  let entry: unknown;
  if (typeof pkg.bin === "string") entry = pkg.name?.replace(/^@[^/]+\//, "") === name ? pkg.bin : undefined;
  else if (pkg.bin && typeof pkg.bin === "object") entry = (pkg.bin as Record<string, unknown>)[name];
  if (typeof entry !== "string") throw new Error(`package.json in ${target()} has no bin entry named "${name}"`);
  return ["node", entry];
}

type Spawnable = { file: string; args: string[]; shell: boolean; cwd?: string };

function npmCli(): string | undefined {
  const fromEnv = process.env.npm_execpath;
  const candidates = [
    fromEnv && /npm-cli\.[cm]?js$/.test(fromEnv) ? fromEnv : undefined,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

/**
 * Runs npm through node itself when its entry script can be found: spawning npm.cmd on Windows
 * needs a shell, and the shell would re-split arguments that contain spaces or quotes.
 */
export function npm(args: string[]): Spawnable {
  const cli = npmCli();
  if (cli) return { file: process.execPath, args: [cli, ...args], shell: false };
  if (process.platform === "win32") {
    return { file: "npm.cmd", args: args.map((a) => `"${a.replace(/"/g, '""')}"`), shell: true };
  }
  return { file: "npm", args, shell: false };
}

function resolveCommand(command: Command, extra: string[]): Spawnable {
  const [head, ...rest] = command;
  if (head === "node") {
    const [script, ...more] = rest;
    if (!script) throw new Error("a node command needs a script path");
    return { file: process.execPath, args: [resolve(target(), script), ...more, ...extra], shell: false };
  }
  if (head === "npm") {
    // npm scripts must run from the project directory; --silent keeps npm's banner out of stdout.
    return { ...npm([...rest, "--silent", "--", ...extra]), cwd: target() };
  }
  throw new Error(`unsupported command: ${command.join(" ")}`);
}

function childEnv(overrides: Env = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

// npm starts the program as a grandchild, so stopping it means stopping the whole process tree.
const detached = process.platform !== "win32";

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

const live = new Set<ChildProcess>();
process.once("exit", () => {
  for (const child of live) killTree(child);
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a file still held open on Windows; the OS temp cleaner gets it later
    }
  }
});

function cwdFor(cmd: Spawnable, cwd: string | undefined): string {
  if (cmd.cwd && cwd && resolve(cwd) !== cmd.cwd) throw new Error("npm commands always run in TARGET_DIR; pass state paths via env instead");
  return cmd.cwd ?? cwd ?? tempDir();
}

/**
 * Runs a CLI once and collects its output. `command` is the spec's invocation prefix, `args` go after it.
 * The working directory defaults to a fresh temp dir (npm commands always run in TARGET_DIR).
 */
export function runCli(command: Command, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  const cmd = resolveCommand(command, args);
  const cwd = cwdFor(cmd, opts.cwd);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((done, fail) => {
    const child = spawn(cmd.file, cmd.args, { cwd, env: childEnv(opts.env), shell: cmd.shell, detached, windowsHide: true });
    live.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      live.delete(child);
      fail(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      live.delete(child);
      if (timedOut) fail(new Error(`${[...command, ...args].join(" ")} did not finish within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
      else done({ code: code ?? -1, stdout, stderr });
    });
    // The program may exit without reading its input.
    child.stdin!.on("error", () => {});
    child.stdin!.end(opts.stdin ?? "");
  });
}

export type Server = {
  url: string;
  port: number;
  output(): string;
  stop(): Promise<void>;
};
export type ServerOptions = { portEnv: string; env?: Env; cwd?: string; startTimeoutMs?: number };

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    socket.setTimeout(1000, () => {
      socket.destroy();
      done(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

/**
 * Starts an HTTP server on a free port, passed in the env var the spec names, and waits until it
 * accepts connections. Other usual port variables are removed so a server reading the wrong one
 * does not pass by accident.
 */
export async function startServer(command: Command, opts: ServerOptions): Promise<Server> {
  const port = await freePort();
  const cmd = resolveCommand(command, []);
  const cwd = cwdFor(cmd, opts.cwd);
  const env = childEnv({ PORT: undefined, ...opts.env, [opts.portEnv]: String(port) });
  const child = spawn(cmd.file, cmd.args, { cwd, env, shell: cmd.shell, detached, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  live.add(child);
  let output = "";
  let exited = false;
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (output += d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (output += d));
  const gone = new Promise<void>((done) =>
    child.once("exit", () => {
      exited = true;
      live.delete(child);
      done();
    }),
  );
  child.once("error", (err) => {
    output += `\n[spawn error] ${err.message}`;
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    killTree(child);
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  };

  const deadline = Date.now() + (opts.startTimeoutMs ?? 20_000);
  for (;;) {
    if (exited) throw new Error(`server exited before listening on ${opts.portEnv}=${port}:\n${output}`);
    if (await canConnect("127.0.0.1", port)) return { url: `http://127.0.0.1:${port}`, port, output: () => output, stop };
    if (await canConnect("::1", port)) return { url: `http://[::1]:${port}`, port, output: () => output, stop };
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`server did not listen on ${opts.portEnv}=${port} in time:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export type Reply = { status: number; headers: Headers; text: string; json: any };

/**
 * One HTTP request. An object body is sent as JSON; a string body is sent as is with a JSON
 * content type, which is how the tests send malformed bodies. Redirects are not followed.
 */
export async function call(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const init: RequestInit = { method, headers: { ...headers }, redirect: "manual" };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] ??= "application/json";
  }
  const res = await fetch(server.url + path, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Matches `Date.prototype.toISOString` output. */
export const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
