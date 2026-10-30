import type { CandidateState, ReleaseStatus } from "../state/factory-state.js";
import type { Ledger } from "../state/ledger.js";

/**
 * The release gate. Nothing ships as green unless every testable requirement is covered by
 * passing tests, every task is approved, and (when it has run) the clean-room check passed.
 * Non-functional requirements cannot be checked black-box: they are listed, not gated.
 */
export function releaseCheck(cand: CandidateState, ledger: Ledger, cleanRoom?: ReleaseStatus["cleanRoom"]): ReleaseStatus {
  const testable = ledger.requirements.filter((r) => r.kind !== "non-functional").map((r) => r.id);
  const untestable = ledger.requirements.filter((r) => r.kind === "non-functional").map((r) => r.id);
  const { uncovered, failing } = cand.matrix.coverage(testable);
  // A skipped test proves nothing: it blocks a green release like a failing one.
  const failingTests = cand.matrix.all().filter((r) => r.status !== "pass").map((r) => r.title);
  const unapproved = (cand.board?.tasks() ?? []).filter((t) => t.status !== "approved").map((t) => t.id);
  const green =
    failingTests.length === 0 && uncovered.length === 0 && failing.length === 0 && unapproved.length === 0 && cand.board !== undefined && (cleanRoom ? cleanRoom.ok : true);
  return { green, failingTests, uncovered, failingRequirements: failing, unapproved, untestable, ...(cleanRoom ? { cleanRoom } : {}) };
}
