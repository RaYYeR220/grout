import { describe, expect, test } from "vitest";
import { runCli, type RunResult } from "../helpers.js";

const SEMVER = ["npm", "start"];
const semver = (args: string[], stdin?: string) => runCli(SEMVER, args, { stdin });

/** Runs several invocations at once; each npm start costs about a second. */
const all = (cases: string[][]) => Promise.all(cases.map((args) => semver(args)));

function expectOutput(results: RunResult[], expected: string[]): void {
  results.forEach((r, i) => {
    expect(r.code, `case ${i}: ${r.stderr}`).toBe(0);
    expect(r.stdout, `case ${i}`).toBe(`${expected[i]}\n`);
  });
}

describe("compare", () => {
  test("prints -1, 0 or 1", async () => {
    const results = await all([
      ["compare", "1.2.3", "1.2.4"],
      ["compare", "2.0.0", "1.9.9"],
      ["compare", "1.2.3", "1.2.3"],
    ]);
    expectOutput(results, ["-1", "1", "0"]);
  });

  test("compares numbers numerically, not as text", async () => {
    const results = await all([
      ["compare", "1.10.0", "1.9.0"],
      ["compare", "1.0.9", "1.0.10"],
      ["compare", "10.0.0", "9.99.99"],
    ]);
    expectOutput(results, ["1", "-1", "1"]);
  });

  test("orders prereleases the way SemVer 2.0.0 does", async () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    const pairs = chain.slice(1).map((v, i) => ["compare", chain[i]!, v]);
    const results = await all([...pairs, ["compare", "1.0.0", "1.0.0-rc.1"], ["compare", "1.0.0-rc.1", "1.0.0-rc.1"]]);
    expectOutput(results, [...pairs.map(() => "-1"), "1", "0"]);
  });

  test("ignores build metadata and a leading v", async () => {
    const results = await all([
      ["compare", "1.2.3+build.5", "v1.2.3"],
      ["compare", "v1.0.0-rc.1+a", "1.0.0-rc.1+b"],
      ["compare", "v2.0.0", "1.0.0"],
    ]);
    expectOutput(results, ["0", "0", "1"]);
  });
});

describe("bump", () => {
  test("bumps major, minor and patch", async () => {
    const results = await all([
      ["bump", "major", "1.2.3"],
      ["bump", "minor", "1.2.3"],
      ["bump", "patch", "1.2.3"],
      ["bump", "minor", "0.9.9"],
    ]);
    expectOutput(results, ["2.0.0", "1.3.0", "1.2.4", "0.10.0"]);
  });

  test("drops the prerelease, the build and the v", async () => {
    const results = await all([
      ["bump", "patch", "v1.2.3-rc.1+b7"],
      ["bump", "minor", "1.2.0-rc.1"],
      ["bump", "major", "2.0.0-alpha"],
      ["bump", "patch", "1.2.3+build"],
    ]);
    expectOutput(results, ["1.2.4", "1.3.0", "3.0.0", "1.2.4"]);
  });
});

describe("valid", () => {
  test("exits 0 and prints nothing for valid versions", async () => {
    const versions = ["1.0.0-alpha.1+001", "v0.0.0", "1.2.3-x-y-z.--", "10.20.30+build.2026-10-30", "1.0.0-0A.is.legal"];
    const results = await all(versions.map((v) => ["valid", v]));
    results.forEach((r, i) => {
      expect(r.code, versions[i]).toBe(0);
      expect(r.stdout, versions[i]).toBe("");
    });
  });

  test("exits 1 and prints nothing for invalid versions", async () => {
    const versions = ["1.2", "01.2.3", "1.02.3", "1.2.3-rc.01", "1.2.3-", "1.2.3+", "1.2.3-rc..1", "vv1.2.3", "1.2.3.4", "1.2.3-beta_1", "V1.2.3", "a.b.c"];
    const results = await all(versions.map((v) => ["valid", v]));
    results.forEach((r, i) => {
      expect(r.code, versions[i]).toBe(1);
      expect(r.stdout, versions[i]).toBe("");
    });
  });
});

describe("sort", () => {
  test("prints the versions from stdin in ascending precedence", async () => {
    const r = await semver(["sort"], "1.0.0\n1.0.0-rc.1\n0.9.12\n1.0.0-alpha\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("0.9.12\n1.0.0-alpha\n1.0.0-rc.1\n1.0.0\n");
  });

  test("trims lines, skips empty ones and prints versions as written", async () => {
    const r = await semver(["sort"], "  v2.0.0  \r\n\r\n1.10.0+build.1\r\n\t1.9.0\r\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("1.9.0\n1.10.0+build.1\nv2.0.0\n");
  });

  test("keeps the input order of versions with equal precedence", async () => {
    const r = await semver(["sort"], "1.0.0+b\n1.0.0+a\nv1.0.0\n0.1.0\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("0.1.0\n1.0.0+b\n1.0.0+a\nv1.0.0\n");
  });

  test("reports the first invalid line by number, counting empty lines", async () => {
    const r = await semver(["sort"], "1.0.0\n\n  1.x \nnope\n");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("invalid version on line 3: 1.x\n");
    expect(r.stdout).toBe("");
  });
});

describe("errors", () => {
  test("compare and bump name the first invalid version and exit 1", async () => {
    const results = await all([
      ["compare", "1.0.0", "1.0"],
      ["compare", "1.x", "2.x"],
      ["bump", "patch", "1.0"],
    ]);
    const messages = ["invalid version: 1.0\n", "invalid version: 1.x\n", "invalid version: 1.0\n"];
    results.forEach((r, i) => {
      expect(r.code, `case ${i}`).toBe(1);
      expect(r.stderr, `case ${i}`).toBe(messages[i]);
      expect(r.stdout, `case ${i}`).toBe("");
    });
  });

  test("bump rejects an unknown level with exit 2", async () => {
    const results = await all([
      ["bump", "huge", "1.0.0"],
      ["bump", "Major", "1.0.0"],
      ["bump", "huge", "nope"],
    ]);
    const messages = ["invalid level: huge\n", "invalid level: Major\n", "invalid level: huge\n"];
    results.forEach((r, i) => {
      expect(r.code, `case ${i}`).toBe(2);
      expect(r.stderr, `case ${i}`).toBe(messages[i]);
      expect(r.stdout, `case ${i}`).toBe("");
    });
  });

  test("a missing or unknown command prints the general usage and exits 2", async () => {
    const results = await all([[], ["frobnicate", "1.0.0"]]);
    for (const r of results) {
      expect(r.code).toBe(2);
      expect(r.stderr).toBe("usage: semver <command> [arguments]\n");
      expect(r.stdout).toBe("");
    }
  });

  test("a wrong number of arguments prints the command's usage and exits 2", async () => {
    const cases: [string[], string][] = [
      [["compare", "1.0.0"], "usage: semver compare <a> <b>\n"],
      [["compare", "1.0.0", "1.0.1", "1.0.2"], "usage: semver compare <a> <b>\n"],
      [["bump", "patch"], "usage: semver bump <level> <version>\n"],
      [["bump", "huge"], "usage: semver bump <level> <version>\n"],
      [["valid"], "usage: semver valid <version>\n"],
      [["sort", "extra"], "usage: semver sort\n"],
    ];
    const results = await all(cases.map(([args]) => args));
    results.forEach((r, i) => {
      expect(r.code, cases[i]![0].join(" ")).toBe(2);
      expect(r.stderr, cases[i]![0].join(" ")).toBe(cases[i]![1]);
      expect(r.stdout).toBe("");
    });
  });
});
