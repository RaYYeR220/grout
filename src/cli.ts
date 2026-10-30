#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dockerAvailable } from "./sandbox/docker.js";
import { pickPreset } from "./llm/presets.js";

const HELP = `grout — a software factory: concurrent agents turn a one-page spec into a tested TypeScript project.

Usage:
  grout run <spec.md> [options]      build the spec
  grout replay <runDir> [--speed N]  replay a recorded run in the terminal (no API key needed)
  grout report <runDir>              (re)build the HTML report of a run from its trace
  grout nudge <runDir> "<message>"   send a message to a running factory (logged as a human step)
  grout race [--runs N] [--builders K] [--seed S]   zero-token race: lost updates with and without the interlock
  grout doctor                       check Node, Docker and provider configuration

run options:
  --out <dir>          where the project is written (default: out/<spec name>)
  --candidates 1|2     two independent teams, cross-checked by each other's tests (default 1)
  --builders <n>       concurrent builders (default 3)
  --test-authors <n>   concurrent test authors (default 2)
  --budget <usd>       model spend cap; the run stops when it is reached (default 2, or 4 with 2 candidates)
  --deadline <HH:MM>   local time by which the best result so far is exported
  --sandbox docker|local|auto   where commands run (default auto: docker when available)
  --mode interlocked|naive|sequential   naive = no compare-and-swap; sequential = one builder, tests after
  --quality economy|quality     model tier preset (default economy)
  --note "<text>"      record a factory change made between runs (logged as a human step)
  --commit             git-commit the output directory when done
`;

function loadDotenv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

function deadlineAt(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  loadDotenv();

  if (command === "doctor") {
    const docker = await dockerAvailable();
    let provider = "none";
    try {
      const p = pickPreset(process.env);
      provider = `${p.name} (planner ${p.models.planner}, builder ${p.models.builder})`;
    } catch (e) {
      provider = (e as Error).message;
    }
    process.stdout.write(
      [
        `node      ${process.version}`,
        `docker    ${docker ? "available (commands run in node:24-slim)" : "not available (commands run locally)"}`,
        `provider  ${provider}`,
        `memory    ${process.env.MEM0_API_KEY ? "mem0" : "local lessons file"}`,
        `cloud     ${process.env.GROUT_MOZAIK_KEY ? "Mozaik Cloud export on" : "off"}`,
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (command === "nudge") {
    const [runDir, message] = rest;
    if (!runDir || !message) throw new Error('usage: grout nudge <runDir> "<message>"');
    appendFileSync(join(runDir, "nudges.jsonl"), `${JSON.stringify({ at: Date.now(), text: message })}\n`);
    process.stdout.write("nudge queued; it is delivered to the running agents and logged in HUMAN_STEPS.md\n");
    return 0;
  }

  if (command === "report") {
    const runDir = rest[0];
    if (!runDir) throw new Error("usage: grout report <runDir>");
    const { writeFileSync } = await import("node:fs");
    const { readTrace } = await import("./report/replay.js");
    const { buildReportModel } = await import("./report/model.js");
    const { renderHtml } = await import("./report/html.js");
    const out = join(runDir, "report.html");
    writeFileSync(out, renderHtml(buildReportModel(readTrace(join(runDir, "trace.jsonl")))));
    process.stdout.write(`${out}\n`);
    return 0;
  }

  if (command === "race") {
    const { values } = parseArgs({ args: rest, options: { runs: { type: "string" }, builders: { type: "string" }, seed: { type: "string" }, json: { type: "string" } } });
    const { raceHarness } = await import("./race.js");
    const opts = { runs: Number(values.runs ?? 500), builders: Number(values.builders ?? 3), seed: Number(values.seed ?? 1) };
    const rows = [];
    for (const mode of ["naive", "interlocked", "sequential"] as const) rows.push(await raceHarness({ ...opts, mode }));
    process.stdout.write(`mode         trials  lost updates  trials with a lost line  stale refusals  mean wall\n`);
    for (const r of rows) {
      process.stdout.write(`${r.mode.padEnd(12)} ${String(r.runs).padStart(6)}  ${String(r.lostUpdates).padStart(12)}  ${String(r.trialsWithLoss).padStart(23)}  ${String(r.staleRefusals).padStart(14)}  ${String(r.meanWallMs).padStart(6)} ms\n`);
    }
    if (values.json) (await import("node:fs")).writeFileSync(values.json, `${JSON.stringify({ ...opts, rows }, null, 2)}\n`);
    return 0;
  }

  if (command === "replay") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { speed: { type: "string" } } });
    const { replay } = await import("./report/replay.js");
    await replay(positionals[0], Number(values.speed ?? 20));
    return 0;
  }

  if (command === "run") {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: "string" },
        candidates: { type: "string" },
        builders: { type: "string" },
        "test-authors": { type: "string" },
        budget: { type: "string" },
        deadline: { type: "string" },
        sandbox: { type: "string" },
        mode: { type: "string" },
        quality: { type: "string" },
        note: { type: "string" },
        commit: { type: "boolean" },
      },
    });
    const specPath = positionals[0];
    if (!specPath) throw new Error("usage: grout run <spec.md> [options]");
    const { runFactory, specTitle } = await import("./run.js");
    const { liveLogger } = await import("./report/live.js");
    const { readFileSync } = await import("node:fs");
    const name = specTitle(readFileSync(specPath, "utf8"), specPath).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const result = await runFactory({
      specPath,
      outDir: values.out ?? join("out", name),
      candidates: values.candidates === "2" ? 2 : 1,
      builders: values.builders ? Number(values.builders) : undefined,
      testAuthors: values["test-authors"] ? Number(values["test-authors"]) : undefined,
      budgetUsd: values.budget ? Number(values.budget) : undefined,
      deadline: values.deadline ? deadlineAt(values.deadline) : undefined,
      sandbox: (values.sandbox as "docker" | "local" | "auto" | undefined) ?? "auto",
      mode: (values.mode as "interlocked" | "naive" | "sequential" | undefined) ?? "interlocked",
      quality: values.quality === "quality" ? "quality" : "economy",
      note: values.note,
      commit: values.commit,
      observe: (fc) => fc.rt.join(liveLogger(fc)),
    });
    process.stdout.write(
      `\n${result.status.green ? "GREEN" : "INCOMPLETE"}: ${result.reason}\n` +
        `output   ${result.outDir}\ntrace    ${join(result.runDir, "trace.jsonl")}\n` +
        `time     ${(result.wallMs / 1000).toFixed(1)} s\ncost     $${result.costUsd.toFixed(4)}\n`,
    );
    return result.status.green ? 0 : 1;
  }

  process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
  return 2;
}

// The runtime's own telemetry warns once per agent loop when no cloud key is set; that is noise here.
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("mozaik cloud")) return;
  warn(...args);
};
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[grout] unhandled rejection (the run continues): ${err instanceof Error ? err.stack : String(err)}\n`);
});

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`grout: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
