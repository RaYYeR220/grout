import { describe, expect, test } from "vitest";
import { raceHarness } from "../src/race.js";

describe("race harness (zero tokens)", () => {
  test("without compare-and-swap, concurrent builders lose updates", async () => {
    const r = await raceHarness({ mode: "naive", runs: 20, builders: 3, seed: 1 });
    expect(r.trialsWithLoss).toBeGreaterThan(0);
    expect(r.lostUpdates).toBeGreaterThan(0);
    expect(r.missingLines).toBeGreaterThan(0);
  });

  test("with the interlock, every registration survives and conflicts become stale refusals", async () => {
    const r = await raceHarness({ mode: "interlocked", runs: 20, builders: 3, seed: 1 });
    expect(r.lostUpdates).toBe(0);
    expect(r.missingLines).toBe(0);
    expect(r.staleRefusals).toBeGreaterThan(0);
  });

  test("sequential builders never conflict but take longer", async () => {
    const seq = await raceHarness({ mode: "sequential", runs: 5, builders: 3, seed: 1 });
    const par = await raceHarness({ mode: "interlocked", runs: 5, builders: 3, seed: 1 });
    expect(seq.lostUpdates + seq.staleRefusals + seq.missingLines).toBe(0);
    expect(seq.meanWallMs).toBeGreaterThan(par.meanWallMs);
  });
});
