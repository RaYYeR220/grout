import { normalizePath } from "../paths.js";
import type { Board } from "../state/board.js";
import type { Role } from "../state/factory-state.js";

export type Decision = { allow: true } | { allow: false; rule: RuleId; message: string };

export type PolicyContext = {
  agentId: string;
  role: Role;
  candidate: string;
  taskId?: string;
  surface?: string[];
  board?: Board;
  stopped?: string;
  budgetExceeded: boolean;
  leaseCurrent?: boolean;
};

export type RuleId = "valid-json" | "stopped" | "budget" | "lease-expired" | "path" | "locked" | "write-surface" | "black-box" | "read-only-role";

/** Every rule a gate enforces is also announced to the agents it applies to (tool descriptions quote these). */
export const RULES: Record<RuleId, string> = {
  "valid-json": "Tool arguments must be complete JSON. Very large writes get truncated: write big files in parts with edit_file.",
  stopped: "When the supervisor stops you, every tool call is refused; reply with a short summary.",
  budget: "When the run budget is spent, every tool call is refused.",
  "lease-expired": "If your task is reassigned, your writes are refused; stop and reply.",
  path: "Paths are relative to the project root, with forward slashes, never leaving the root.",
  locked: "package.json, package-lock.json, tsconfig.json, vitest.config.ts and the test harness belong to the architect. Use only the declared dependencies and Node built-ins.",
  "write-surface": "Builders write only the files of their own task (plus unit tests under test/unit/). Test authors write only under test/. To change a file you do not own, call request_change.",
  "black-box": "Test authors never read the implementation (src/): tests come from the spec alone.",
  "read-only-role": "Reviewers, arbiters and analysts read and judge; they never write files.",
};

export const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
export const READ_TOOLS = new Set(["read_file", "list_files"]);

const LOCKED = new Set(["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "test/harness.ts", "test/global-setup.ts"]);

const deny = (rule: RuleId, message: string): Decision => ({ allow: false, rule, message });

function pathArg(tool: string, args: unknown): string | undefined {
  const a = (args ?? {}) as { path?: unknown; prefix?: unknown };
  if (tool === "list_files") return typeof a.prefix === "string" && a.prefix !== "" ? a.prefix : undefined;
  return typeof a.path === "string" ? a.path : undefined;
}

function ownerName(board: Board | undefined, path: string): string | undefined {
  const owner = board?.ownerOf(path);
  if (!owner) return undefined;
  return owner === "shared" ? "several tasks" : `task ${owner}`;
}

export function decide(ctx: PolicyContext, tool: string, args: unknown): Decision {
  if (ctx.stopped) return deny("stopped", `you were stopped (${ctx.stopped}). Reply with a short summary of where you are.`);
  if (ctx.budgetExceeded) return deny("budget", "the run budget is spent. Reply with a short summary of where you are.");

  const isWrite = WRITE_TOOLS.has(tool);
  const isRead = READ_TOOLS.has(tool);
  if (!isWrite && !isRead) return { allow: true };

  const raw = pathArg(tool, args);
  let path: string | undefined;
  if (raw !== undefined) {
    try {
      path = tool === "list_files" ? raw.replace(/\\/g, "/").replace(/^\.\//, "") : normalizePath(raw);
    } catch (e) {
      return deny("path", `${(e as Error).message}. ${RULES.path}`);
    }
  }

  if (isRead) {
    if (ctx.role === "test-author" && path !== undefined && (path === "src" || path.startsWith("src/"))) {
      return deny("black-box", `${RULES["black-box"]} Work from the spec, the requirement ledger and the harness API.`);
    }
    return { allow: true };
  }

  if (ctx.role === "reviewer" || ctx.role === "arbiter" || ctx.role === "analyst" || ctx.role === "utility") {
    return deny("read-only-role", RULES["read-only-role"]);
  }
  if (ctx.leaseCurrent === false) return deny("lease-expired", `your lease on ${ctx.taskId} is no longer current (the task was reassigned). Stop and reply.`);
  if (path === undefined) return { allow: true };
  if (ctx.role === "architect") return { allow: true };
  if (LOCKED.has(path)) return deny("locked", `${path} is locked. ${RULES.locked} If you truly need a change, call request_change.`);

  if (ctx.role === "test-author") {
    return path.startsWith("test/") ? { allow: true } : deny("write-surface", `${path} is outside test/. Test authors write only under test/.`);
  }

  const surface = ctx.surface ?? [];
  if (surface.includes(path) || path.startsWith("test/unit/")) return { allow: true };
  const owner = ownerName(ctx.board, path);
  const yours = surface.length > 0 ? surface.join(", ") : "(none)";
  return deny(
    "write-surface",
    owner
      ? `${path} belongs to ${owner}. Do not edit it: call request_change with the path and the change you need, then continue with your own files (${yours}).`
      : `${path} is not in your write surface. Your files: ${yours}. Put the code there (or unit tests under test/unit/).`,
  );
}
