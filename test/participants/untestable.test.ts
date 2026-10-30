import { describe, expect, test } from "vitest";
import { Board } from "../../src/state/board.js";
import { Broker } from "../../src/participants/broker.js";
import { ReviewDesk } from "../../src/participants/review.js";
import { createFactory } from "../../src/runtime.js";
import { FactoryState } from "../../src/state/factory-state.js";
import { ScriptedRunner, developerText, say, toolCall } from "../../src/llm/scripted-runner.js";
import type { Ledger } from "../../src/state/ledger.js";

describe("a requirement no black-box test can check", () => {
  test("is reclassified as not testable when the arbiter agrees, and stops blocking the release", async () => {
    const ledger: Ledger = {
      requirements: [{ id: "R1", kind: "behavior", statement: "the code is well structured", specQuote: "Keep the code well structured.", examples: [] }],
      interface: { kind: "cli", entry: "src/cli.ts", invocation: "node dist/cli.js", notes: [] },
      ambiguities: [],
    };
    const state = new FactoryState({ runId: "t", spec: "Keep the code well structured.", budgetUsd: 5 });
    state.ledger = ledger;
    const fc = createFactory({
      state,
      runner: new ScriptedRunner((input, turn) => {
        expect(developerText(input)).toContain("untestable");
        return turn === 0 ? toolCall("submit_verdict", { ruling: "untestable", reasoning: "code structure is not observable from outside" }) : say("done");
      }),
      models: { planner: "m", builder: "m", utility: "m" },
    });
    state.candidate("A").board = new Board([{ id: "T1", title: "t", writeSurface: ["src/cli.ts"], requirements: ["R1"], dependsOn: [], notes: "" }]);
    const broker = new Broker(fc, { candidate: "A", builders: 1, testAuthors: 1, sequential: false });
    fc.rt.join(new ReviewDesk(fc, "A", broker));
    fc.bus.emit("test.disputed", "x", { candidate: "A", testId: "requirement R1", reason: "not observable", by: "test-author-1" });
    await new Promise((r) => setTimeout(r, 80));
    expect(state.ledger.requirements[0]).toMatchObject({ kind: "non-functional", interpretation: expect.stringContaining("not observable") });
  });
});
