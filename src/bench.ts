import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildReportModel } from "./report/model.js";
import { readTrace } from "./report/replay.js";
import { parseVitestJson } from "./sandbox/parse.js";

export type BenchRow = {
  spec: string;
  kind: string;
  hiddenPass: number;
  hiddenTotal: number;
  releaseGreen: boolean | null;
  humanSteps: number;
  wallS: number;
  costUsd: number;
  agents: number;
  peakConcurrency: number;
  staleRefusals: number;
  gateRefusals: number;
  reopens: number;
};

/** Runs a spec's hidden acceptance suite (which the factory never sees) against a finished output directory. */
export function hiddenSuite(repo: string, spec: string, target: string): { pass: number; total: number } {
  const report = join(mkdtempSync(join(tmpdir(), "bench-")), "report.json");
  spawnSync(process.execPath, [join(repo, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "bench/vitest.config.ts", `bench/acceptance/${spec}`, "--reporter=json", `--outputFile=${report}`], {
    cwd: repo,
    env: { ...process.env, TARGET_DIR: target },
    stdio: "ignore",
    timeout: 600_000,
  });
  if (!existsSync(report)) return { pass: 0, total: 0 };
  const results = parseVitestJson(readFileSync(report, "utf8"), repo);
  return { pass: results.filter((r) => r.status === "pass").length, total: results.length };
}

export function benchRow(repo: string, spec: string, outDir: string): BenchRow {
  const hidden = hiddenSuite(repo, spec, outDir);
  const tracePath = join(outDir, "grout-run", "trace.jsonl");
  const m = existsSync(tracePath) ? buildReportModel(readTrace(tracePath)) : undefined;
  const steps = existsSync(join(outDir, "HUMAN_STEPS.md")) ? (readFileSync(join(outDir, "HUMAN_STEPS.md"), "utf8").match(/^- /gm) ?? []).length : 0;
  const kind = existsSync(join(outDir, "package.json")) && JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")).bin ? "CLI" : "HTTP";
  return {
    spec,
    kind,
    hiddenPass: hidden.pass,
    hiddenTotal: hidden.total,
    releaseGreen: m?.run.green ?? null,
    humanSteps: steps,
    wallS: m ? Math.round(m.run.wallMs / 1000) : 0,
    costUsd: m?.run.costUsd ?? 0,
    agents: m?.run.agents ?? 0,
    peakConcurrency: m?.run.peakConcurrency ?? 0,
    staleRefusals: m?.run.staleRefusals ?? 0,
    gateRefusals: m?.run.gateRefusals ?? 0,
    reopens: m?.tasks.reduce((n, t) => n + t.reopens.length, 0) ?? 0,
  };
}

export function benchSpecs(repo: string): string[] {
  return readdirSync(join(repo, "bench", "specs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .sort();
}

export function benchTable(rows: BenchRow[]): string {
  const head = "| spec | kind | hidden tests | release | human steps | time | cost | agents | peak concurrent | stale writes caught | gate refusals | tasks sent back |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map(
    (r) =>
      `| ${r.spec} | ${r.kind} | ${r.hiddenPass}/${r.hiddenTotal} | ${r.releaseGreen === null ? "—" : r.releaseGreen ? "green" : "incomplete"} | ${r.humanSteps} | ${r.wallS} s | $${r.costUsd.toFixed(3)} | ${r.agents} | ${r.peakConcurrency} | ${r.staleRefusals} | ${r.gateRefusals} | ${r.reopens} |`,
  );
  const pass = rows.reduce((n, r) => n + r.hiddenPass, 0);
  const total = rows.reduce((n, r) => n + r.hiddenTotal, 0);
  const cost = rows.reduce((n, r) => n + r.costUsd, 0);
  return `${head}\n${body.join("\n")}\n| **total** | | **${pass}/${total}** | ${rows.filter((r) => r.releaseGreen).length}/${rows.length} green | ${rows.reduce((n, r) => n + r.humanSteps, 0)} | | **$${cost.toFixed(3)}** | | | ${rows.reduce((n, r) => n + r.staleRefusals, 0)} | ${rows.reduce((n, r) => n + r.gateRefusals, 0)} | ${rows.reduce((n, r) => n + r.reopens, 0)} |`;
}

export const repoRoot = () => resolve(".");
