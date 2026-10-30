export type TestStatus = "pass" | "fail" | "skip" | "error";

export type TestRecord = {
  id: string;
  file: string;
  title: string;
  requirementIds: string[];
  status: TestStatus;
  failure?: string;
  rev: number;
};

/** Requirement ids live in test titles: "[R3] ..." or "[R3,R7] ...". */
export function requirementIdsOf(title: string): string[] {
  const m = title.match(/\[(R\d+(?:\s*,\s*R\d+)*)\]/);
  return m ? m[1].split(",").map((s) => s.trim()) : [];
}

export class TestMatrix {
  private records = new Map<string, TestRecord>();

  /** Each verifier run reports the whole suite, so a run replaces the previous one. */
  update(results: TestRecord[]): void {
    this.records = new Map(results.map((r) => [r.id, r]));
  }

  get(id: string): TestRecord | undefined {
    return this.records.get(id);
  }

  all(): TestRecord[] {
    return [...this.records.values()];
  }

  coverage(reqIds: string[]): { covered: string[]; uncovered: string[]; failing: string[] } {
    const covered: string[] = [];
    const uncovered: string[] = [];
    const failing: string[] = [];
    for (const id of reqIds) {
      const tests = this.all().filter((r) => r.requirementIds.includes(id));
      if (tests.length === 0) uncovered.push(id);
      else if (tests.some((r) => r.status !== "pass")) failing.push(id);
      else covered.push(id);
    }
    return { covered, uncovered, failing };
  }
}
