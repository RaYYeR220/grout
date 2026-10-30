import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, unsafeToken, writeTree } from "./fs-util.js";
import {
  ALLOWED_COMMANDS,
  DEFAULT_TIMEOUT_MS,
  firstToken,
  notAllowed,
  type CmdResult,
  type ExecOptions,
  type Sandbox,
} from "./types.js";

function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function run(cmd: string, cwd: string, opts: ExecOptions): Promise<CmdResult> {
  if (!(ALLOWED_COMMANDS as readonly string[]).includes(firstToken(cmd))) return Promise.resolve(notAllowed(cmd));
  const bad = unsafeToken(cmd);
  if (bad !== undefined) return Promise.resolve({ ...notAllowed(cmd), stderr: `unsafe token in command: ${bad}` });
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    // Every token was checked above, so the shell (needed for npm/npx .cmd shims on Windows) sees plain words only.
    const child = spawn(cmd, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ cmd, exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - started, timedOut, outputs: {} });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ cmd, exitCode: -1, stdout, stderr: stderr + String(err), durationMs: Date.now() - started, timedOut, outputs: {} });
    });
  });
}

/** Temp directories on the host. The fallback when Docker is not available. */
export class LocalSandbox implements Sandbox {
  readonly kind = "local" as const;
  private root = "";
  private seq = 0;
  private depsReady = false;

  async init(runId: string): Promise<void> {
    this.root = join(tmpdir(), `grout-${runId}`);
    await mkdir(join(this.root, "deps"), { recursive: true });
  }

  async installDeps(packageJson: string): Promise<CmdResult & { lockfile?: string }> {
    const dir = join(this.root, "deps");
    await writeFile(join(dir, "package.json"), packageJson);
    const r = await run("npm install --ignore-scripts --no-audit --no-fund --loglevel=error", dir, { timeoutMs: 300_000 });
    this.depsReady = r.exitCode === 0;
    const lockfile = await readFile(join(dir, "package-lock.json"), "utf8").catch(() => undefined);
    return { ...r, lockfile };
  }

  async exec(files: Map<string, string>, cmd: string, opts: ExecOptions = {}): Promise<CmdResult> {
    const n = ++this.seq;
    const dir = join(this.root, "runs", String(n));
    await writeTree(dir, files);
    if (this.depsReady) await symlink(join(this.root, "deps", "node_modules"), join(dir, "node_modules"), "junction");
    const r = await run(cmd, dir, opts);
    return { ...r, outputs: await collectFiles(dir, opts.collect) };
  }

  async cleanRoom(files: Map<string, string>, cmds: string[], opts: ExecOptions = {}): Promise<CmdResult[]> {
    const n = ++this.seq;
    const dir = join(this.root, `clean-${n}`);
    await writeTree(dir, files);
    const results: CmdResult[] = [];
    for (const cmd of cmds) {
      const r = await run(cmd, dir, { timeoutMs: 300_000, ...opts });
      results.push(r);
      if (r.exitCode !== 0) break;
    }
    if (results.length > 0) results[results.length - 1].outputs = await collectFiles(dir, opts.collect);
    return results;
  }

  async dispose(): Promise<void> {
    if (this.root) await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }
}
