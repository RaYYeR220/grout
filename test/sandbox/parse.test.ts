import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseTsc, parseVitestJson } from "../../src/sandbox/parse.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

describe("parseTsc", () => {
  test("parses real tsc diagnostics", () => {
    expect(parseTsc(fixture("tsc-output.txt"))).toEqual([
      { file: "src/add.ts", line: 2, col: 14, code: "TS2322", message: "Type 'string' is not assignable to type 'number'." },
      { file: "test/broken.test.ts", line: 2, col: 22, code: "TS2307", message: "Cannot find module '../src/missing.js' or its corresponding type declarations." },
    ]);
  });

  test("keeps indented continuation lines with their diagnostic", () => {
    const out = "src/a.ts(1,1): error TS2345: Argument of type 'X' is not assignable.\n  Property 'y' is missing in type 'X'.\nsrc/b.ts(4,2): error TS1005: ';' expected.\n";
    const parsed = parseTsc(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].message).toBe("Argument of type 'X' is not assignable.\nProperty 'y' is missing in type 'X'.");
  });

  test("empty output means no errors", () => {
    expect(parseTsc("")).toEqual([]);
  });
});

describe("parseVitestJson", () => {
  const results = parseVitestJson(fixture("vitest-report.json"), "/runs/7");

  test("maps assertions to relative files, titles and statuses", () => {
    expect(results.filter((r) => r.file === "test/add.test.ts").map((r) => [r.title, r.status])).toEqual([
      ["[R1] adds", "fail"],
      ["[R2,R3] zero", "pass"],
    ]);
  });

  test("keeps the failure message and the workspace files in its stack", () => {
    const fail = results.find((r) => r.title === "[R1] adds")!;
    expect(fail.failure).toContain("expected -1 to be 5");
    expect(fail.stackFiles).toEqual(["test/add.test.ts"]);
  });

  test("a test file that fails to load becomes one error result", () => {
    const broken = results.filter((r) => r.file === "test/broken.test.ts");
    expect(broken).toEqual([
      expect.objectContaining({ title: "(file failed to load)", status: "error", failure: expect.stringContaining("Cannot find module '../src/missing.js'") }),
    ]);
  });

  test("garbage input is reported, not thrown", () => {
    expect(parseVitestJson("not json", "/x")).toEqual([
      expect.objectContaining({ title: "(no test report)", status: "error" }),
    ]);
  });
});
