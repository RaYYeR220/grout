import type { Blueprint } from "../state/blueprint.js";
import type { Interface, Ledger } from "../state/ledger.js";

/** Versions the sandbox image and our own test suite are verified against. */
export const TOOLING = { typescript: "5.9.3", vitest: "3.2.7", "@types/node": "22.20.5" } as const;

export type Invocation = { command: "node" | "npm"; args: string[] };

export function distOf(entry: string): string {
  return entry.replace(/^src\//, "dist/").replace(/\.[cm]?tsx?$/, ".js");
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "project"
  );
}

/** How the black-box tests start the program: the spec's own invocation when it states one. */
export function harnessInvocation(iface: Interface): Invocation {
  const [first, second, third] = iface.invocation.trim().split(/\s+/);
  if (first === "npm" && second === "start") return { command: "npm", args: ["start", "--silent", "--"] };
  if (first === "npm" && second === "run" && third) return { command: "npm", args: ["run", third, "--silent", "--"] };
  if (first === "node" && second && /\.[cm]?js$/.test(second)) return { command: "node", args: [second] };
  return { command: "node", args: [distOf(iface.entry)] };
}

export function scaffold(ledger: Ledger, blueprint: Blueprint, title: string): Map<string, string> {
  const iface = ledger.interface;
  const name = slugify(title);
  const entry = distOf(iface.entry);
  const pkg = {
    name,
    version: "1.0.0",
    private: true,
    type: "module",
    ...(iface.kind === "cli" ? { bin: { [iface.binName ?? name]: entry } } : {}),
    main: entry,
    engines: { node: ">=20" },
    scripts: { build: "tsc -p tsconfig.json", start: `node ${entry}`, test: "vitest run" },
    dependencies: blueprint.dependencies,
    devDependencies: { ...TOOLING, ...blueprint.devDependencies },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      rootDir: "src",
      outDir: "dist",
      types: ["node"],
    },
    include: ["src"],
  };
  return new Map([
    ["package.json", `${JSON.stringify(pkg, null, 2)}\n`],
    ["tsconfig.json", `${JSON.stringify(tsconfig, null, 2)}\n`],
    ["vitest.config.ts", VITEST_CONFIG],
    ["test/global-setup.ts", GLOBAL_SETUP],
    ["test/harness.ts", harness(iface)],
    [".gitignore", "node_modules/\n"],
  ]);
}

const VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
`;

const GLOBAL_SETUP = `// Builds the project once before the tests, so they exercise the compiled program like a user would.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: root, stdio: "pipe" });
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(\`build failed before tests:\\n\${e.stdout?.toString() ?? ""}\${e.stderr?.toString() ?? ""}\`);
  }
}
`;

function harness(iface: Interface): string {
  const invocation = JSON.stringify(harnessInvocation(iface));
  const portEnv = JSON.stringify(iface.port?.env ?? "PORT");
  return `// Test harness: starts the built program the way the spec says it is run.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVOCATION = ${invocation};
const PORT_ENV = ${portEnv};

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
      done({ code: -1, stdout, stderr: stderr + "\\n[harness] timed out" });
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
    if (exited) throw new Error(\`server exited before listening on \${PORT_ENV}=\${port}:\\n\${output}\`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(\`server did not listen on \${PORT_ENV}=\${port} within 10 s:\\n\${output}\`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    baseUrl: \`http://127.0.0.1:\${port}\`,
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
`;
}
