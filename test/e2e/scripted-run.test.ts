import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FunctionCallOutputItem, type InferenceInput } from "@mozaik-ai/core";
import { runFactory } from "../../src/run.js";
import { ScriptedRunner, developerText, say, toolCall, type Script } from "../../src/llm/scripted-runner.js";
import { LocalSandbox } from "../../src/sandbox/local.js";

const slow = process.env.GROUT_SLOW_TESTS === "1";

const SPEC = `# Hello

A command-line greeter.

Run it as \`hello <name>\`. It prints \`Hello, <name>!\` followed by a newline and exits with code 0.
Without a name it prints \`usage: hello <name>\` to stderr and exits with code 2.
`;

const STUB = `#!/usr/bin/env node\nthrow new Error("not implemented");\n`;
const IMPL = `#!/usr/bin/env node
const name = process.argv[2];
if (!name) {
  process.stderr.write("usage: hello <name>\\n");
  process.exit(2);
}
process.stdout.write(\`Hello, \${name}!\\n\`);
`;
const TESTS = `import { expect, test } from "vitest";
import { runCli } from "../harness.js";

test("[R1] greets by name", async () => {
  const r = await runCli(["Ada"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("Hello, Ada!\\n");
});

test("[R2] prints usage and exits 2 without a name", async () => {
  const r = await runCli([]);
  expect(r.code).toBe(2);
  expect(r.stderr).toBe("usage: hello <name>\\n");
});
`;

const lastOutput = (input: InferenceInput) =>
  (input.context.getItems().filter((i) => i instanceof FunctionCallOutputItem).at(-1) as FunctionCallOutputItem | undefined)?.output.text ?? "";

const script: Script = (input, turn) => {
  const role = developerText(input);
  const done = say("done");
  if (role.startsWith("You are the Analyst")) {
    return turn === 0
      ? toolCall("submit_ledger", {
          requirements: [
            { id: "R1", kind: "output-format", statement: "prints Hello, <name>! and a newline, exit 0", specQuote: "It prints `Hello, <name>!` followed by a newline and exits with code 0.", examples: [{ input: "hello Ada", expected: "Hello, Ada!" }] },
            { id: "R2", kind: "exit-code", statement: "without a name: usage on stderr, exit 2", specQuote: "Without a name it prints `usage: hello <name>` to stderr and exits with code 2.", examples: [] },
          ],
          interface: { kind: "cli", entry: "src/cli.ts", binName: "hello", invocation: "hello <name>", notes: [] },
          ambiguities: [],
        })
      : done;
  }
  if (role.startsWith("You are the Architect")) {
    if (turn === 0) return toolCall("write_file", { path: "src/cli.ts", content: STUB });
    if (turn === 1)
      return toolCall("submit_blueprint", {
        files: [{ path: "src/cli.ts", purpose: "the command", owner: "T1" }],
        dependencies: {},
        devDependencies: {},
        tasks: [{ id: "T1", title: "hello command", writeSurface: ["src/cli.ts"], requirements: ["R1", "R2"], dependsOn: [], notes: "" }],
      });
    if (lastOutput(input).startsWith("ERROR")) throw new Error(`blueprint refused: ${lastOutput(input)}`);
    return done;
  }
  if (role.startsWith("You are a Builder")) {
    return [toolCall("read_file", { path: "src/cli.ts" }), toolCall("write_file", { path: "src/cli.ts", content: IMPL }), toolCall("run_check", { kind: "typecheck" }), toolCall("finish_task", { summary: "implemented" })][turn] ?? done;
  }
  if (role.startsWith("You are a Test Author")) {
    return [toolCall("write_file", { path: "test/acceptance/hello.test.ts", content: TESTS }), toolCall("submit_tests", { summary: "2 tests" })][turn] ?? done;
  }
  if (role.startsWith("You are the Reviewer")) return turn === 0 ? toolCall("submit_review", { verdict: "approve", findings: [] }) : done;
  return done;
};

describe.skipIf(!slow)("scripted end-to-end run (GROUT_SLOW_TESTS=1)", () => {
  test("a hello spec goes from ledger to a green, exported project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grout-e2e-"));
    const specPath = join(dir, "hello.md");
    writeFileSync(specPath, SPEC);
    const result = await runFactory({
      specPath,
      outDir: join(dir, "out"),
      runsDir: join(dir, "runs"),
      runnerOverride: new ScriptedRunner(script),
      sandboxOverride: new LocalSandbox(),
      verifierDebounceMs: 300,
    });
    expect(result.reason).toMatch(/clean-room check passed/);
    expect(result.status.green).toBe(true);
    for (const f of ["RUN.md", "HUMAN_STEPS.md", "dist/cli.js", "package-lock.json", "test/harness.ts", "grout-run/trace.jsonl"]) expect(existsSync(join(dir, "out", f)), f).toBe(true);
    expect(readFileSync(join(dir, "out", "RUN.md"), "utf8")).toContain("**Status: GREEN**");
    const types = new Set(readFileSync(join(dir, "out", "grout-run", "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).type));
    for (const t of ["run.started", "ledger.ready", "board.opened", "task.done", "task.approved", "tests.ran", "llm.call", "release.checked"]) expect(types.has(t), t).toBe(true);
  }, 300_000);
});
