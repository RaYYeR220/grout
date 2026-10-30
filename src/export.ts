import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CandidateState, FactoryState, ReleaseStatus } from "./state/factory-state.js";
import { harnessInvocation } from "./template/scaffold.js";

export type RunSummary = {
  runId: string;
  title: string;
  candidate: string;
  status: ReleaseStatus;
  reason: string;
  wallMs: number;
  costUsd: number;
  agents: number;
  mode: string;
  cloudUrl?: string;
};

const fmtUsd = (n: number) => `$${n.toFixed(4)}`;

export function runMarkdown(state: FactoryState, cand: CandidateState, s: RunSummary): string {
  const ledger = state.ledger;
  const rows = (ledger?.requirements ?? []).map((r) => {
    const tests = cand.matrix.all().filter((t) => t.requirementIds.includes(r.id));
    const st = r.kind === "non-functional" ? "not testable" : tests.length === 0 ? "no test" : tests.every((t) => t.status === "pass") ? "pass" : "FAIL";
    return `| ${r.id} | ${r.statement.replace(/\|/g, "\\|")} | ${tests.length} | ${st} |`;
  });
  const blockers = [
    ...s.status.failingTests.map((t) => `- failing test: ${t}`),
    ...s.status.uncovered.map((r) => `- no test for ${r}`),
    ...s.status.failingRequirements.map((r) => `- requirement ${r} has failing or skipped tests`),
    ...s.status.unapproved.map((t) => `- task not approved: ${t}`),
    ...(s.status.cleanRoom && !s.status.cleanRoom.ok ? [`- clean-room check failed at: ${s.status.cleanRoom.step}`] : []),
  ];
  const inv = ledger ? harnessInvocation(ledger.interface) : undefined;
  return `# ${s.title}

Built by grout, run \`${s.runId}\`, candidate ${s.candidate}, mode ${s.mode}.

- **Status: ${s.status.green ? "GREEN" : "INCOMPLETE"}**: ${s.reason}
- Wall time: ${(s.wallMs / 1000).toFixed(1)} s · model cost: ${fmtUsd(s.costUsd)} · agents spawned: ${s.agents}
- Human steps: ${state.humanSteps.length} (see HUMAN_STEPS.md)${s.cloudUrl ? `
- Live session in Mozaik Cloud: ${s.cloudUrl}` : ""}
${blockers.length ? `\n## What blocks a green release\n\n${blockers.join("\n")}\n` : ""}
## Requirements

| id | requirement | tests | status |
|---|---|---|---|
${rows.join("\n")}

## Run it

\`\`\`
npm ci
npm run build
npm test
\`\`\`
${ledger ? `\nThe program is invoked as: \`${ledger.interface.invocation}\`${inv ? ` (tests run \`${inv.command} ${inv.args.join(" ")}\`)` : ""}.\n` : ""}
The full trace of the run is in \`grout-run/trace.jsonl\`, the report in \`grout-run/report.html\`.
`;
}

export function humanStepsMarkdown(state: FactoryState): string {
  if (state.humanSteps.length === 0) return "# Human steps\n\nNo human steps: nobody intervened during this run.\n";
  return `# Human steps\n\n${state.humanSteps.map((h) => `- ${new Date(h.at).toISOString()} · ${h.kind} · ${h.text}`).join("\n")}\n`;
}

/** Writes the candidate's project, its build, the run notes and the trace to outDir. */
export function exportRun(
  state: FactoryState,
  cand: CandidateState,
  outDir: string,
  summary: RunSummary,
  dist: Record<string, string>,
  artifacts: { trace?: string; report?: string },
  files: Map<string, string> = cand.workspace.snapshot(),
): void {
  // A re-run replaces the previous output entirely (leftover modules or tests would change the build);
  // anything that is not a previous output is never touched.
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    if (!existsSync(join(outDir, "RUN.md"))) throw new Error(`${outDir} is not empty and is not a previous output of this factory; choose another --out`);
    for (const entry of readdirSync(outDir)) if (entry !== ".git") rmSync(join(outDir, entry), { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  const write = (rel: string, content: string) => {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [path, content] of files) if (!path.startsWith(".grout/")) write(path, content);
  for (const [path, content] of Object.entries(dist)) write(path, content);
  write("RUN.md", runMarkdown(state, cand, summary));
  write("HUMAN_STEPS.md", humanStepsMarkdown(state));
  if (artifacts.trace && existsSync(artifacts.trace)) {
    mkdirSync(join(outDir, "grout-run"), { recursive: true });
    copyFileSync(artifacts.trace, join(outDir, "grout-run", "trace.jsonl"));
  }
  if (artifacts.report && existsSync(artifacts.report)) copyFileSync(artifacts.report, join(outDir, "grout-run", "report.html"));
}

export function commitOutput(outDir: string, message: string): boolean {
  const add = spawnSync("git", ["add", "--", "."], { cwd: outDir });
  if (add.status !== 0) return false;
  return spawnSync("git", ["commit", "-m", message, "--", "."], { cwd: outDir }).status === 0;
}
