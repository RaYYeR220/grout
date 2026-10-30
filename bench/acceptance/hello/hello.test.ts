import { describe, expect, test } from "vitest";
import { bin, runCli } from "../helpers.js";

const hello = (...args: string[]) => runCli(bin("hello"), args);

describe("hello", () => {
  test("greets by name", async () => {
    const r = await hello("Ada");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Hello, Ada!\n");
  });

  test("uses the name it is given", async () => {
    const r = await hello("Linus");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Hello, Linus!\n");
  });

  test("--shout upper-cases the whole greeting", async () => {
    const r = await hello("Ada", "--shout");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("HELLO, ADA!\n");
  });

  test("--shout upper-cases a lower-case name too", async () => {
    const r = await hello("grace", "--shout");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("HELLO, GRACE!\n");
  });

  test("without a name prints the usage to stderr and exits 2", async () => {
    const r = await hello();
    expect(r.code).toBe(2);
    expect(r.stderr.trimEnd()).toBe("usage: hello <name> [--shout]");
  });

  test("--shout on its own is still missing a name", async () => {
    const r = await hello("--shout");
    expect(r.code).toBe(2);
    expect(r.stderr.trimEnd()).toBe("usage: hello <name> [--shout]");
  });

  test("an unknown flag is rejected with exit 2", async () => {
    const r = await hello("Ada", "--loud");
    expect(r.code).toBe(2);
    expect(r.stderr.trimEnd()).toBe("unknown option: --loud");
  });

  test("the message names the flag that was given", async () => {
    const r = await hello("Ada", "--whisper");
    expect(r.code).toBe(2);
    expect(r.stderr.trimEnd()).toBe("unknown option: --whisper");
  });
});
