import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli, tempDir, type RunOptions } from "../helpers.js";

const WORDFREQ = ["node", "dist/wordfreq.js"];
const wordfreq = (args: string[], opts: RunOptions = {}) => runCli(WORDFREQ, args, opts);

/** A temp dir holding the given files, to run wordfreq in. */
function dirWith(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const SAMPLE = "The cat saw the other cat. THE END";

describe("counting", () => {
  test("counts the words of a file, most frequent first, as count<TAB>word lines", async () => {
    const cwd = dirWith({ "notes.txt": "the cat saw the other cat the end\n" });
    const r = await wordfreq(["notes.txt"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("3\tthe\n2\tcat\n1\tend\n1\tother\n1\tsaw\n");
  });

  test("breaks ties by character-code order of the word", async () => {
    const r = await wordfreq([], { stdin: "banana apple 2nd cherry apple banana" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\tapple\n2\tbanana\n1\t2nd\n1\tcherry\n");
  });

  test("is case-insensitive and prints words in lower case", async () => {
    const r = await wordfreq([], { stdin: "Go GO go gO stop" });
    expect(r.stdout).toBe("4\tgo\n1\tstop\n");
  });

  test("splits on every character other than letters, digits and apostrophes", async () => {
    const r = await wordfreq([], { stdin: "state-of-the-art, v2.0; e-mail_address!x" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      ["0", "address", "art", "e", "mail", "of", "state", "the", "v2", "x"].map((w) => `1\t${w}\n`).join(""),
    );
  });

  test("keeps apostrophes inside a word and strips them at the edges", async () => {
    const r = await wordfreq([], { stdin: "don't 'tis dogs' rock'n'roll '' DON'T" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\tdon't\n1\tdogs\n1\trock'n'roll\n1\ttis\n");
  });

  test("an input without words prints nothing and succeeds", async () => {
    const r = await wordfreq([], { stdin: "-- ... !!! ''" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("input", () => {
  test("reads standard input when no file is given", async () => {
    const r = await wordfreq([], { stdin: "b a b" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\tb\n1\ta\n");
  });

  test("reads standard input when the file argument is -", async () => {
    const r = await wordfreq(["-"], { stdin: "x y x" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("2\tx\n1\ty\n");
  });

  test("resolves a relative file against the working directory", async () => {
    const cwd = dirWith({ "words.txt": "one two two" });
    const r = await wordfreq(["words.txt"], { cwd, stdin: "ignored ignored ignored" });
    expect(r.stdout).toBe("2\ttwo\n1\tone\n");
  });
});

describe("--top", () => {
  test("--top N keeps the first N entries", async () => {
    const r = await wordfreq(["--top", "2"], { stdin: "a a a b b c d" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("3\ta\n2\tb\n");
  });

  test("--top=N works and options may follow the file", async () => {
    const cwd = dirWith({ "words.txt": "a a a b b c d" });
    const r = await wordfreq(["words.txt", "--top=1"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("3\ta\n");
  });

  test("--top larger than the number of distinct words prints them all", async () => {
    const r = await wordfreq(["--top", "10"], { stdin: "x y" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("1\tx\n1\ty\n");
  });

  test.each([["0"], ["-1"], ["2.5"], ["three"], ["+3"]])("--top %s is rejected with exit 2", async (value) => {
    const r = await wordfreq(["--top", value], { stdin: "a b" });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("wordfreq: --top must be a positive integer\n");
    expect(r.stdout).toBe("");
  });

  test("--top without a value is rejected, in both forms", async () => {
    for (const args of [["--top"], ["--top="]]) {
      const r = await wordfreq(args, { stdin: "a b" });
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toBe("wordfreq: --top must be a positive integer\n");
      expect(r.stdout).toBe("");
    }
  });
});

describe("--json", () => {
  test("prints one line with totals over the whole input, before --top", async () => {
    const r = await wordfreq(["--top", "2", "--json"], { stdin: SAMPLE });
    expect(r.code).toBe(0);
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(r.stdout)).toEqual({
      total: 8,
      unique: 5,
      words: [
        { word: "the", count: 3 },
        { word: "cat", count: 2 },
      ],
    });
  });

  test("without --top lists every word in order", async () => {
    const r = await wordfreq(["--json"], { stdin: "b a b" });
    expect(JSON.parse(r.stdout)).toEqual({
      total: 3,
      unique: 2,
      words: [
        { word: "b", count: 2 },
        { word: "a", count: 1 },
      ],
    });
  });

  test("an input without words gives zero totals and an empty list", async () => {
    const r = await wordfreq(["--json"], { stdin: "  ...  " });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ total: 0, unique: 0, words: [] });
  });
});

describe("errors", () => {
  test("a file that cannot be read exits 1 and names the argument as given", async () => {
    const r = await wordfreq(["missing.txt"], { cwd: tempDir() });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("wordfreq: cannot read missing.txt\n");
    expect(r.stdout).toBe("");
  });

  test("an unknown option exits 2", async () => {
    for (const option of ["--reverse", "-n"]) {
      const r = await wordfreq([option], { stdin: "a" });
      expect(r.code, option).toBe(2);
      expect(r.stderr).toBe(`wordfreq: unknown option ${option}\n`);
      expect(r.stdout).toBe("");
    }
  });

  test("more than one file argument exits 2", async () => {
    const cwd = dirWith({ "a.txt": "a", "b.txt": "b" });
    const r = await wordfreq(["a.txt", "b.txt"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("wordfreq: too many arguments\n");
    expect(r.stdout).toBe("");
  });

  test("arguments are checked before the file is read", async () => {
    const r = await wordfreq(["missing.txt", "--bogus"], { cwd: tempDir() });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("wordfreq: unknown option --bogus\n");
  });
});
