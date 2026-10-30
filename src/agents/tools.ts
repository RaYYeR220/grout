import type { Tool } from "@mozaik-ai/core";
import { z } from "zod";
import { EV } from "../bus/events.js";
import { RULES } from "../gates/policies.js";
import { labelOf, type FactoryCtx } from "../runtime.js";
import { parseTsc, parseVitestJson } from "../sandbox/parse.js";
import type { Lease } from "../state/board.js";
import type { Role } from "../state/factory-state.js";
import type { AgentSelf } from "./spawn.js";

export type ToolCtx = {
  fc: FactoryCtx;
  self: AgentSelf;
  role: Role;
  candidate: string;
  slot: string;
  taskId?: string;
  lease?: Lease;
  surface?: string[];
};

export const TYPECHECK_CMD = "npx tsc --noEmit -p .";
export const TEST_CMD = "npx vitest run --reporter=json --outputFile=.grout/vitest.json";
export const REPORT_PATH = ".grout/vitest.json";
const SUMMARY_LIMIT = 4000;

export function defineTool<S extends z.ZodType>(name: string, description: string, schema: S, run: (args: z.infer<S>) => Promise<string> | string): Tool {
  const { $schema: _drop, ...parameters } = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    type: "function",
    name,
    description,
    strict: false,
    parameters,
    invoke: async (raw: unknown) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return `ERROR: invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}. Re-send the call with valid arguments.`;
      }
      return run(parsed.data);
    },
  };
}

const clip = (s: string, n = SUMMARY_LIMIT) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

export function fileTools(t: ToolCtx): Tool[] {
  const ws = () => t.fc.state.candidate(t.candidate).workspace;
  const committed = (path: string, version: number, rev: number) =>
    t.fc.bus.emit(EV.workspaceCommitted, t.self.id, { candidate: t.candidate, path, version, rev, author: labelOf(t.fc.state, t.self.id), taskId: t.taskId });
  // A STALE answer hands the agent the current content, so it counts as a read of that version.
  const stale = (path: string, current: number, author: string, content: string) => {
    ws().read(t.self.id, path);
    return `STALE: ${path} changed after you read it (now v${current}, written by ${labelOf(t.fc.state, author)}). Your write was NOT applied. Re-apply your change on top of the current content below, then write again.\n----- current content of ${path} -----\n${content}\n----- end -----`;
  };

  return [
    defineTool("read_file", "Read a file of the project. Returns its version and content. Read a file before you change it.", z.object({ path: z.string() }), ({ path }) => {
      const f = ws().read(t.self.id, path);
      if (!f) return `ERROR: ${path} does not exist. Existing files:\n${ws().list().join("\n")}`;
      return `--- ${f.path} (v${f.version}, last written by ${labelOf(t.fc.state, f.author)}) ---\n${f.content}`;
    }),
    defineTool("list_files", "List project files, optionally under a prefix like 'src/'.", z.object({ prefix: z.string().optional() }), ({ prefix }) => {
      const files = ws().list(prefix ?? "");
      return files.length ? files.map((p) => `${p} (v${ws().peek(p)?.version})`).join("\n") : "(no files)";
    }),
    defineTool(
      "write_file",
      `Write the full content of a file. If someone else changed it after you read it, the write is refused and you get the current content to re-apply your change on. ${RULES["write-surface"]} ${RULES["valid-json"]}`,
      z.object({ path: z.string(), content: z.string() }),
      ({ path, content }) => {
        const r = ws().commit(t.self.id, path, content, t.taskId);
        if (!r.ok) return stale(r.path, r.current, r.currentAuthor, r.currentContent);
        committed(r.path, r.version, r.rev);
        return `OK: wrote ${r.path} (now v${r.version}).`;
      },
    ),
    defineTool(
      "edit_file",
      "Replace exactly one occurrence of old_text with new_text in a file you have read. Prefer this over rewriting a whole file.",
      z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
      ({ path, old_text, new_text }) => {
        const r = ws().edit(t.self.id, path, old_text, new_text, t.taskId);
        if (r.ok) {
          committed(r.path, r.version, r.rev);
          return `OK: edited ${r.path} (now v${r.version}).`;
        }
        if (r.reason === "stale") return stale(r.path, r.current, r.currentAuthor, r.currentContent);
        if (r.reason === "no-match") return `ERROR: old_text was not found in ${r.path}. Read the file again and copy the exact text.`;
        return `ERROR: old_text occurs more than once in ${r.path}; include more surrounding lines so it is unique.`;
      },
    ),
  ];
}

export function runCheckTool(t: ToolCtx): Tool {
  return defineTool(
    "run_check",
    "Run the type checker or the test suite on the current state of the project (everyone's latest files). kind=typecheck|test; pattern optionally limits tests to matching files.",
    z.object({ kind: z.enum(["typecheck", "test"]), pattern: z.string().regex(/^[\w./-]+$/).optional() }),
    async ({ kind, pattern }) => {
      const sandbox = t.fc.sandbox;
      if (!sandbox) return "ERROR: no sandbox is configured for this run.";
      const files = t.fc.state.candidate(t.candidate).workspace.snapshot();
      const cmd = kind === "typecheck" ? TYPECHECK_CMD : `${TEST_CMD}${pattern ? ` ${pattern}` : ""}`;
      const r = await sandbox.exec(files, cmd, { collect: [REPORT_PATH], timeoutMs: 180_000 });
      t.fc.bus.emit(EV.sandboxCommand, t.self.id, { cmd, exitCode: r.exitCode, ms: r.durationMs, timedOut: r.timedOut, candidate: t.candidate });
      if (r.timedOut) return `${kind}: TIMED OUT after ${Math.round(r.durationMs / 1000)} s. A test or the server probably never finishes; check for open handles and unclosed servers.`;
      return kind === "typecheck" ? summarizeTsc(r.stdout + r.stderr, t.surface ?? []) : summarizeTests(r.outputs[REPORT_PATH], r.stdout + r.stderr);
    },
  );
}

export function summarizeTsc(output: string, surface: string[]): string {
  const errors = parseTsc(output);
  if (errors.length === 0) return "typecheck: OK (0 errors)";
  const mine = errors.filter((e) => surface.includes(e.file) || e.file.startsWith("test/unit/"));
  const others = errors.filter((e) => !mine.includes(e));
  const fmt = (e: (typeof errors)[number]) => `${e.file}(${e.line},${e.col}) ${e.code}: ${e.message}`;
  const lines = [`typecheck: ${errors.length} error(s), ${mine.length} in your files`, ...mine.map(fmt)];
  if (others.length) lines.push(`other files (${others.length}):`, ...others.slice(0, 15).map(fmt));
  return clip(lines.join("\n"));
}

export function summarizeTests(report: string | undefined, rawOutput: string): string {
  if (!report) return clip(`tests: no report was produced (the suite probably failed to start). Output:\n${rawOutput.slice(-2500)}`);
  const results = parseVitestJson(report, "");
  const pass = results.filter((r) => r.status === "pass").length;
  const bad = results.filter((r) => r.status === "fail" || r.status === "error");
  const lines = [`tests: ${pass} passed, ${bad.length} failing (of ${results.length})`];
  for (const r of bad) lines.push(`- ${r.title} (${r.file}): ${(r.failure ?? "").split("\n").slice(0, 6).join(" | ").slice(0, 500)}`);
  return clip(lines.join("\n"));
}

export function finishTaskTool(t: ToolCtx): Tool {
  return defineTool("finish_task", "Mark your task done once typecheck passes and your tests pass. A reviewer and the full test suite check it next.", z.object({ summary: z.string() }), ({ summary }) => {
    const board = t.fc.state.candidate(t.candidate).board;
    if (!board || !t.lease || !t.taskId) return "ERROR: you have no task lease.";
    if (!board.complete(t.lease, summary)) return `ERROR: your lease on ${t.taskId} is no longer current; stop.`;
    t.fc.bus.emit(EV.taskDone, t.self.id, { candidate: t.candidate, taskId: t.taskId, worker: t.slot, summary });
    return `OK: ${t.taskId} is done and goes to review. Reply with a one-line summary now.`;
  });
}

export function requestChangeTool(t: ToolCtx): Tool {
  return defineTool(
    "request_change",
    "Ask the owner of a file you may not edit to make a change (another task's file, or a locked project file).",
    z.object({ path: z.string(), change: z.string() }),
    ({ path, change }) => {
      const cand = t.fc.state.candidate(t.candidate);
      const owner = cand.board?.ownerOf(path);
      const from = labelOf(t.fc.state, t.self.id);
      const holder = owner && owner !== "shared" ? t.fc.state.liveAgents({ candidate: t.candidate, taskId: owner, role: "builder" })[0] : undefined;
      if (holder) t.fc.state.deliver(holder.agentId, from, `change request for ${path}: ${change}`);
      else if (owner && owner !== "shared") cand.board?.reopen(owner, `change requested by ${from} for ${path}: ${change}`);
      const to = holder ? labelOf(t.fc.state, holder.agentId) : owner ? `task ${owner}` : "conductor";
      t.fc.bus.emit(EV.changeRequested, t.self.id, { candidate: t.candidate, path, change, from, to });
      return `OK: request sent to ${to}. Continue with your own files.`;
    },
  );
}

export function disputeTestTool(t: ToolCtx): Tool {
  return defineTool(
    "dispute_test",
    "If an acceptance test contradicts the spec, dispute it with the spec quote that proves it. An arbiter rules; do not edit tests yourself.",
    z.object({ test: z.string(), reason: z.string() }),
    ({ test, reason }) => {
      t.fc.bus.emit(EV.testDisputed, t.self.id, { candidate: t.candidate, testId: test, reason, by: labelOf(t.fc.state, t.self.id) });
      return "OK: the arbiter will rule and you will be told. Meanwhile continue with anything else in your task.";
    },
  );
}

/** A structured hand-in (ledger, blueprint, review, verdict, tests): validated, then passed to whoever spawned the agent. */
export function submitTool<S extends z.ZodType>(name: string, description: string, schema: S, accept: (value: z.infer<S>) => string | undefined): Tool {
  return defineTool(name, description, schema, (value) => {
    const problem = accept(value);
    return problem ? `ERROR: ${problem}. Fix it and call ${name} again.` : `OK: ${name} accepted. Reply with a one-line summary now.`;
  });
}
