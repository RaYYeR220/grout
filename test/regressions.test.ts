import { describe, expect, test } from "vitest";
import { markRegressions } from "../src/participants/verifier.js";

describe("markRegressions", () => {
  test("a test that passed in the previous run and fails now is flagged as a regression", () => {
    const previous = new Map([["f > [R1] a", "pass"], ["f > [R2] b", "fail"]] as const);
    const results = [
      { file: "f", title: "[R1] a", status: "fail" as const, failure: "boom", stackFiles: [] },
      { file: "f", title: "[R2] b", status: "fail" as const, failure: "still", stackFiles: [] },
      { file: "f", title: "[R3] c", status: "pass" as const, stackFiles: [] },
    ];
    const marked = markRegressions(previous, results, 7);
    expect(marked[0].failure).toMatch(/^REGRESSION: this test passed at rev 7/);
    expect(marked[0].failure).toContain("boom");
    expect(marked[1].failure).toBe("still");
    expect(marked[2]).toEqual(results[2]);
  });
});
