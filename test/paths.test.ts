import { describe, expect, test } from "vitest";
import { normalizePath, PathError } from "../src/paths.js";

describe("normalizePath", () => {
  test("converts Windows separators", () => {
    expect(normalizePath("src\\cli.ts")).toBe("src/cli.ts");
  });

  test("collapses ./ and duplicate slashes", () => {
    expect(normalizePath("./src//a.ts")).toBe("src/a.ts");
  });

  test.each(["../x", "/etc/passwd", "C:/x", "", "src/../../x", "c:\\windows"])("rejects %j", (p) => {
    expect(() => normalizePath(p)).toThrow(PathError);
  });

  test("keeps inner .. that stays inside the root", () => {
    expect(normalizePath("src/a/../b.ts")).toBe("src/b.ts");
  });
});
