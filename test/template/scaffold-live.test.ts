import { afterAll, describe, expect, test } from "vitest";
import { scaffold } from "../../src/template/scaffold.js";
import { LocalSandbox } from "../../src/sandbox/local.js";
import { parseVitestJson } from "../../src/sandbox/parse.js";
import type { Ledger } from "../../src/state/ledger.js";

const slow = process.env.GROUT_SLOW_TESTS === "1";

const CLI = `#!/usr/bin/env node
const name = process.argv[2];
if (!name) {
  process.stderr.write("usage: hello <name>\\n");
  process.exit(2);
}
process.stdout.write(\`Hello, \${name}!\\n\`);
`;

const SERVER = `import { createServer } from "node:http";
const port = Number(process.env.APP_PORT ?? 8080);
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path: req.url }));
}).listen(port, "0.0.0.0");
`;

const CLI_TEST = `import { describe, expect, test } from "vitest";
import { runCli } from "../harness.js";
describe("hello", () => {
  test("[R1] greets", async () => {
    const r = await runCli(["Ada"]);
    expect(r.stdout).toBe("Hello, Ada!\\n");
  });
  test("[R2] exits 2 without a name", async () => {
    expect((await runCli([])).code).toBe(2);
  });
});
`;

const HTTP_TEST = `import { afterAll, beforeAll, expect, test } from "vitest";
import { startServer, type Server } from "../harness.js";
let s: Server;
beforeAll(async () => { s = await startServer(); });
afterAll(() => s.stop());
test("[R1] echoes the path", async () => {
  const r = await fetch(s.baseUrl + "/x");
  expect(await r.json()).toEqual({ path: "/x" });
});
`;

describe.skipIf(!slow)("generated project runs its black-box tests (GROUT_SLOW_TESTS=1)", () => {
  const sb = new LocalSandbox();
  afterAll(() => sb.dispose());

  test("CLI and HTTP projects build in global setup and pass through the harness", async () => {
    await sb.init(`scaffold-${Date.now()}`);
    const base = { files: [], dependencies: {}, devDependencies: {}, tasks: [{ id: "T1", title: "x", writeSurface: ["src/cli.ts"], requirements: ["R1"], dependsOn: [], notes: "" }] };
    const cli: Ledger = {
      requirements: [{ id: "R1", kind: "behavior", statement: "x", specQuote: "x", examples: [] }],
      interface: { kind: "cli", entry: "src/cli.ts", binName: "hello", invocation: "hello <name>", notes: [] },
      ambiguities: [],
    };
    const cliFiles = scaffold(cli, base, "hello");
    expect((await sb.installDeps(cliFiles.get("package.json")!)).exitCode).toBe(0);
    cliFiles.set("src/cli.ts", CLI).set("test/acceptance/hello.test.ts", CLI_TEST);
    const r = await sb.exec(cliFiles, "npx vitest run --reporter=json --outputFile=.grout/vitest.json", { collect: [".grout/vitest.json"] });
    const results = parseVitestJson(r.outputs[".grout/vitest.json"] ?? "", "");
    expect(results.map((x) => [x.title, x.status])).toEqual([["hello > [R1] greets", "pass"], ["hello > [R2] exits 2 without a name", "pass"]]);

    const http: Ledger = { ...cli, interface: { kind: "http", entry: "src/server.ts", invocation: "node dist/server.js", port: { env: "APP_PORT", default: 8080 }, notes: [] } };
    const httpFiles = scaffold(http, base, "api").set("src/server.ts", SERVER).set("test/acceptance/api.test.ts", HTTP_TEST);
    const h = await sb.exec(httpFiles, "npx vitest run --reporter=json --outputFile=.grout/vitest.json", { collect: [".grout/vitest.json"] });
    expect(parseVitestJson(h.outputs[".grout/vitest.json"] ?? "", "").map((x) => x.status)).toEqual(["pass"]);
  }, 240_000);
});
