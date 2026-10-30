import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const ignored = (path: string) => spawnSync("git", ["check-ignore", "-q", path]).status === 0;

describe("repository ignore rules", () => {
  test("the factory's own build output is ignored", () => {
    expect(ignored("dist/cli.js")).toBe(true);
  });

  test("a factory output keeps its built dist/ when committed", () => {
    expect(ignored("hidden/some-spec/dist/cli.js")).toBe(false);
    expect(ignored("examples/shortener/dist/server.js")).toBe(false);
  });
});
