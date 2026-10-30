import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bin, runCli, tempDir, type Env } from "../helpers.js";

const USAGE = "usage: todo <command> [arguments]\n";

/** A todo list in a fresh working directory, using the default data file. */
function freshList(env: Env = {}) {
  const dir = tempDir();
  const run = (...args: string[]) => runCli(bin("todo"), args, { cwd: dir, env: { TODO_FILE: undefined, ...env } });
  return { dir, file: join(dir, "todo.json"), run };
}

describe("adding and listing", () => {
  test("add prints the new id, starting at 1", async () => {
    const { run } = freshList();
    const first = await run("add", "buy", "oat", "milk");
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("added #1\n");
    const second = await run("add", "call", "the", "plumber");
    expect(second.code).toBe(0);
    expect(second.stdout).toBe("added #2\n");
  });

  test("list shows every item in id order with its state", async () => {
    const { run } = freshList();
    await run("add", "buy", "oat", "milk");
    await run("add", "call", "the", "plumber");
    await run("done", "1");
    const r = await run("list");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("[x] #1 buy oat milk\n[ ] #2 call the plumber\n");
  });

  test("the text is trimmed", async () => {
    const { run } = freshList();
    await run("add", "  fix the sink  ");
    expect((await run("list")).stdout).toBe("[ ] #1 fix the sink\n");
  });

  test("list --open and list --done filter by state", async () => {
    const { run } = freshList();
    await run("add", "a");
    await run("add", "b");
    await run("add", "c");
    await run("done", "2");
    const open = await run("list", "--open");
    expect(open.code).toBe(0);
    expect(open.stdout).toBe("[ ] #1 a\n[ ] #3 c\n");
    const done = await run("list", "--done");
    expect(done.code).toBe(0);
    expect(done.stdout).toBe("[x] #2 b\n");
  });

  test("an empty list prints no items and does not create the file", async () => {
    const { run, file } = freshList();
    const r = await run("list");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("no items\n");
    expect(existsSync(file)).toBe(false);
  });

  test("a filter that matches nothing prints no items", async () => {
    const { run } = freshList();
    await run("add", "a");
    expect((await run("list", "--done")).stdout).toBe("no items\n");
  });
});

describe("storage", () => {
  test("items are kept in todo.json in the working directory", async () => {
    const { run, file } = freshList();
    await run("add", "water", "the", "plants");
    expect(existsSync(file)).toBe(true);
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
    expect((await run("list")).stdout).toBe("[ ] #1 water the plants\n");
  });

  test("TODO_FILE names the data file instead", async () => {
    const elsewhere = join(tempDir(), "mine.json");
    const a = freshList({ TODO_FILE: elsewhere });
    expect((await a.run("add", "renew", "passport")).stdout).toBe("added #1\n");
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(a.file)).toBe(false);
    const b = freshList({ TODO_FILE: elsewhere });
    expect((await b.run("list")).stdout).toBe("[ ] #1 renew passport\n");
  });

  test("a data file that is not valid JSON is reported and left alone", async () => {
    const { run, file } = freshList();
    writeFileSync(file, "{not json");
    for (const args of [["list"], ["add", "x"]]) {
      const r = await run(...args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr).toBe("error: cannot read data file\n");
      expect(r.stdout).toBe("");
    }
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });
});

describe("done, remove and clear", () => {
  test("done accepts an id with or without # and can be repeated", async () => {
    const { run } = freshList();
    await run("add", "a");
    const first = await run("done", "#1");
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("done #1\n");
    const again = await run("done", "1");
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("done #1\n");
    expect((await run("list")).stdout).toBe("[x] #1 a\n");
  });

  test("remove deletes the item", async () => {
    const { run } = freshList();
    await run("add", "a");
    await run("add", "b");
    const r = await run("remove", "1");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("removed #1\n");
    expect((await run("list")).stdout).toBe("[ ] #2 b\n");
  });

  test("ids are never reused after removals", async () => {
    const { run } = freshList();
    await run("add", "a");
    await run("add", "b");
    await run("remove", "#2");
    expect((await run("add", "c")).stdout).toBe("added #3\n");
    await run("remove", "1");
    await run("remove", "3");
    expect((await run("add", "d")).stdout).toBe("added #4\n");
  });

  test("clear deletes the done items and says how many", async () => {
    const { run } = freshList();
    await run("add", "a");
    await run("add", "b");
    await run("add", "c");
    await run("done", "1");
    await run("done", "3");
    const r = await run("clear");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("cleared 2\n");
    expect((await run("list")).stdout).toBe("[ ] #2 b\n");
    expect((await run("clear")).stdout).toBe("cleared 0\n");
  });
});

describe("errors", () => {
  test("an id no item has exits 1 and changes nothing", async () => {
    const { run, file } = freshList();
    await run("add", "a");
    const before = readFileSync(file, "utf8");
    for (const command of ["done", "remove"]) {
      const r = await run(command, "5");
      expect(r.code, command).toBe(1);
      expect(r.stderr).toBe("error: no item #5\n");
      expect(r.stdout).toBe("");
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("a missing or malformed id exits 2", async () => {
    const { run } = freshList();
    await run("add", "a");
    for (const args of [["done"], ["remove"], ["done", "abc"], ["done", "0"], ["remove", "-1"], ["done", "1.5"]]) {
      const r = await run(...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toBe("error: invalid id\n");
      expect(r.stdout).toBe("");
    }
  });

  test("add without text exits 2 and does not create the file", async () => {
    const { run, file } = freshList();
    for (const args of [["add"], ["add", "   "]]) {
      const r = await run(...args);
      expect(r.code, JSON.stringify(args)).toBe(2);
      expect(r.stderr).toBe("error: text is required\n");
      expect(r.stdout).toBe("");
    }
    expect(existsSync(file)).toBe(false);
  });

  test("no command or an unknown command prints the usage and exits 2", async () => {
    const { run } = freshList();
    for (const args of [[], ["finish", "1"]]) {
      const r = await run(...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toBe(USAGE);
      expect(r.stdout).toBe("");
    }
  });

  test("list with an unknown option prints the usage and exits 2", async () => {
    const { run } = freshList();
    const r = await run("list", "--all");
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(USAGE);
    expect(r.stdout).toBe("");
  });
});
