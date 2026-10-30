import { renderRequirement } from "./agents/prompts.js";
import type { TscError, VitestResult } from "./sandbox/parse.js";
import type { CandidateState } from "./state/factory-state.js";
import type { Ledger } from "./state/ledger.js";
import { requirementIdsOf } from "./state/test-matrix.js";

export type Destination = { kind: "task"; taskId: string } | { kind: "test-author"; slot: string };
export type Routed = { to: Destination; testIds: string[]; requirementIds: string[]; message: string };

const MESSAGE_LIMIT = 3000;

function tasksOwning(cand: CandidateState, file: string): string[] {
  const board = cand.board;
  if (!board) return [];
  const owner = board.ownerOf(file);
  if (owner === undefined) return [];
  if (owner !== "shared") return [owner];
  return board.tasks().filter((t) => t.writeSurface.includes(file)).map((t) => t.id);
}

function tasksCovering(cand: CandidateState, reqIds: string[]): string[] {
  return (cand.board?.tasks() ?? []).filter((t) => t.requirements.some((r) => reqIds.includes(r))).map((t) => t.id);
}

/** Sends each failure to whoever can fix it: the task owning the file, the task owning the requirement, or the test's author. */
export function triage(
  failures: { tsc: TscError[]; tests: VitestResult[] },
  cand: CandidateState,
  ledger: Ledger,
  ownerOfTest: (testFile: string) => Destination | undefined,
): Routed[] {
  const routes = new Map<string, Routed & { lines: string[] }>();
  const add = (to: Destination, line: string, reqIds: string[] = [], testId?: string) => {
    const key = to.kind === "task" ? `task:${to.taskId}` : `author:${to.slot}`;
    const r = routes.get(key) ?? { to, testIds: [], requirementIds: [], message: "", lines: [] };
    r.lines.push(line);
    for (const id of reqIds) if (!r.requirementIds.includes(id)) r.requirementIds.push(id);
    if (testId && !r.testIds.includes(testId)) r.testIds.push(testId);
    routes.set(key, r);
  };

  for (const e of failures.tsc) {
    const line = `type error ${e.file}(${e.line},${e.col}) ${e.code}: ${e.message}`;
    if (e.file.startsWith("test/")) {
      const owner = ownerOfTest(e.file);
      if (owner) add(owner, line);
      continue;
    }
    const owners = tasksOwning(cand, e.file);
    for (const t of owners.length ? owners : (cand.board?.tasks() ?? []).map((x) => x.id)) add({ kind: "task", taskId: t }, line);
  }

  for (const t of failures.tests) {
    if (t.status === "pass" || t.status === "skip") continue;
    const testId = `${t.file} > ${t.title}`;
    const excerpt = (t.failure ?? "").split("\n").slice(0, 8).join("\n").slice(0, 700);
    const line = `test "${t.title}" (${t.file}) failed:\n${excerpt}`;
    const reqIds = requirementIdsOf(t.title);
    const owner = ownerOfTest(t.file);
    if (t.status === "error" && t.title.startsWith("(suite did not run")) {
      // A hook failed: usually the program did not start, sometimes the test's own setup is wrong.
      for (const o of tasksCovering(cand, reqIds)) add({ kind: "task", taskId: o }, line, reqIds, testId);
      if (owner) add(owner, line, reqIds, testId);
      continue;
    }
    if (t.status === "error" || reqIds.length === 0) {
      // Acceptance tests carry [R#] ids; a builder's own unit test goes back to the task that wrote it.
      const note = reqIds.length || owner?.kind === "task" ? line : `${line}\n(this test has no [R#] requirement id in its title)`;
      if (owner) add(owner, note, reqIds, testId);
      continue;
    }
    const fromStack = t.stackFiles.filter((f) => f.startsWith("src/")).flatMap((f) => tasksOwning(cand, f));
    const owners = [...new Set(fromStack.length ? fromStack : tasksCovering(cand, reqIds))];
    for (const o of owners) add({ kind: "task", taskId: o }, line, reqIds, testId);
  }

  return [...routes.values()].map(({ lines, ...r }) => {
    const quotes = ledger.requirements.filter((q) => r.requirementIds.includes(q.id)).map(renderRequirement);
    const body = `${lines.join("\n\n")}${quotes.length ? `\n\nRequirements involved:\n${quotes.join("\n")}` : ""}`;
    return { ...r, message: body.length > MESSAGE_LIMIT ? `${body.slice(0, MESSAGE_LIMIT)}\n…` : body };
  });
}
