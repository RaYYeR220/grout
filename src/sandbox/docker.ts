import { spawn } from "node:child_process";
import { unsafeToken } from "./fs-util.js";
import { tarFiles } from "./tar.js";
import {
  ALLOWED_COMMANDS,
  DEFAULT_TIMEOUT_MS,
  firstToken,
  notAllowed,
  portFor,
  type CmdResult,
  type ExecOptions,
  type Sandbox,
} from "./types.js";

export const IMAGE = "node:24-slim";

type Raw = { code: number; stdout: string; stderr: string };

/** Runs the docker CLI with an argument array: no host shell is ever involved. */
export function docker(args: string[], input?: Buffer, timeoutMs = 600_000): Promise<Raw> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function dockerAvailable(): Promise<boolean> {
  return (await docker(["info", "--format", "{{.ServerVersion}}"], undefined, 15_000)).code === 0;
}

function decodeCollected(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^@@FILE (.+)$/);
    if (m) out[m[1]] = Buffer.from(lines[i + 1] ?? "", "base64").toString("utf8");
  }
  return out;
}

/** One long-lived node:24-slim container per run; dependencies once in /deps; each exec in /runs/<n>. */
export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  private container = "";
  private runId = "";
  private seq = 0;
  private depsReady = false;
  private readonly extra: string[] = [];

  async init(runId: string): Promise<void> {
    this.runId = runId.replace(/[^\w.-]/g, "-");
    if ((await docker(["image", "inspect", IMAGE], undefined, 30_000)).code !== 0) {
      const pull = await docker(["pull", IMAGE]);
      if (pull.code !== 0) throw new Error(`docker pull ${IMAGE} failed: ${pull.stderr}`);
    }
    this.container = await this.start(`grout-${this.runId}`);
    await docker(["exec", this.container, "mkdir", "-p", "/deps", "/runs"]);
  }

  async installDeps(packageJson: string): Promise<CmdResult & { lockfile?: string }> {
    await this.put(this.container, "/deps", new Map([["package.json", packageJson]]));
    const r = await this.sh(this.container, "/deps", "npm install --ignore-scripts --no-audit --no-fund --loglevel=error", { timeoutMs: 300_000 }, portFor(0));
    this.depsReady = r.exitCode === 0;
    const lock = await docker(["exec", this.container, "cat", "/deps/package-lock.json"]);
    return { ...r, lockfile: lock.code === 0 ? lock.stdout : undefined };
  }

  async exec(files: Map<string, string>, cmd: string, opts: ExecOptions = {}): Promise<CmdResult> {
    const refused = this.refuse(cmd);
    if (refused) return refused;
    const n = ++this.seq;
    const dir = `/runs/${n}`;
    await this.put(this.container, dir, files);
    if (this.depsReady) await docker(["exec", this.container, "ln", "-s", "/deps/node_modules", `${dir}/node_modules`]);
    const r = await this.sh(this.container, dir, cmd, opts, portFor(n));
    return { ...r, outputs: await this.collect(this.container, dir, opts.collect) };
  }

  async cleanRoom(files: Map<string, string>, cmds: string[], opts: ExecOptions = {}): Promise<CmdResult[]> {
    const n = ++this.seq;
    const box = await this.start(`grout-${this.runId}-clean-${n}`);
    try {
      await this.put(box, "/work", files);
      const results: CmdResult[] = [];
      for (const cmd of cmds) {
        const r = this.refuse(cmd) ?? (await this.sh(box, "/work", cmd, { timeoutMs: 300_000, ...opts }, portFor(n)));
        results.push(r);
        if (r.exitCode !== 0) break;
      }
      if (results.length > 0) results[results.length - 1].outputs = await this.collect(box, "/work", opts.collect);
      return results;
    } finally {
      await docker(["rm", "-f", box]);
    }
  }

  async dispose(): Promise<void> {
    for (const c of [this.container, ...this.extra]) if (c) await docker(["rm", "-f", c]);
  }

  private async start(name: string): Promise<string> {
    await docker(["rm", "-f", name]);
    const r = await docker(["run", "-d", "--name", name, IMAGE, "sleep", "infinity"]);
    if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr}`);
    if (name !== `grout-${this.runId}`) this.extra.push(name);
    return name;
  }

  private refuse(cmd: string): CmdResult | undefined {
    if (!(ALLOWED_COMMANDS as readonly string[]).includes(firstToken(cmd))) return notAllowed(cmd);
    const bad = unsafeToken(cmd);
    return bad === undefined ? undefined : { ...notAllowed(cmd), stderr: `unsafe token in command: ${bad}` };
  }

  private async put(container: string, dir: string, files: Map<string, string>): Promise<void> {
    const r = await docker(["exec", "-i", container, "sh", "-c", `mkdir -p ${dir} && tar -xf - -C ${dir}`], tarFiles(files));
    if (r.code !== 0) throw new Error(`copying files into ${container}:${dir} failed: ${r.stderr}`);
  }

  private async sh(container: string, dir: string, cmd: string, opts: ExecOptions, port: number): Promise<CmdResult> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = Object.entries({ PORT: String(port), CI: "1", FORCE_COLOR: "0", ...opts.env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
    const r = await docker(["exec", "-w", dir, ...env, container, "timeout", "-s", "KILL", String(secs), "sh", "-c", cmd], undefined, timeoutMs + 30_000);
    const durationMs = Date.now() - started;
    return { cmd, exitCode: r.code, stdout: r.stdout, stderr: r.stderr, durationMs, timedOut: r.code === 137 && durationMs >= timeoutMs * 0.9, outputs: {} };
  }

  private async collect(container: string, dir: string, collect: string[] = []): Promise<Record<string, string>> {
    const paths = collect.filter((c) => unsafeToken(c) === undefined);
    if (paths.length === 0) return {};
    const script = paths
      .map((p) =>
        p.endsWith("/")
          ? `[ -d '${p}' ] && find '${p}' -type f | while read -r f; do echo "@@FILE $f"; base64 -w0 "$f"; echo; done`
          : `[ -f '${p}' ] && { echo "@@FILE ${p}"; base64 -w0 '${p}'; echo; }`,
      )
      .join("; ");
    const r = await docker(["exec", "-w", dir, container, "sh", "-c", `${script}; true`]);
    return decodeCollected(r.stdout);
  }
}
