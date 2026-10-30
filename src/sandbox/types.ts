export type CmdResult = {
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Files read back after the command: exact paths, or every file under a "dir/" prefix. */
  outputs: Record<string, string>;
};

export type ExecOptions = { timeoutMs?: number; env?: Record<string, string>; collect?: string[] };

export interface Sandbox {
  readonly kind: "docker" | "local";
  init(runId: string): Promise<void>;
  /** Installs the project's dependencies once; every later exec links to them. */
  installDeps(packageJson: string): Promise<CmdResult & { lockfile?: string }>;
  /** Runs one command in a fresh snapshot of `files` with the shared dependencies linked in. */
  exec(files: Map<string, string>, cmd: string, opts?: ExecOptions): Promise<CmdResult>;
  /** A from-scratch check: fresh directory, real `npm ci`, nothing shared. Stops at the first failure. */
  cleanRoom(files: Map<string, string>, cmds: string[], opts?: ExecOptions): Promise<CmdResult[]>;
  dispose(): Promise<void>;
}

export const ALLOWED_COMMANDS = ["npm", "npx", "node", "tsc", "vitest"] as const;

export const DEFAULT_TIMEOUT_MS = 120_000;

export function firstToken(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? "";
}

export function notAllowed(cmd: string): CmdResult {
  return {
    cmd,
    exitCode: 126,
    stdout: "",
    stderr: `command not allowed: ${firstToken(cmd)} (allowed: ${ALLOWED_COMMANDS.join(", ")})`,
    durationMs: 0,
    timedOut: false,
    outputs: {},
  };
}

export function portFor(n: number): number {
  return 40000 + (n % 20000);
}
