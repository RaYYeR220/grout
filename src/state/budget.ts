export type SpendTags = { role: string; taskId?: string; model: string; agentId: string; candidate?: string };

export class Budget {
  private total = 0;
  private readonly entries: { usd: number; tags: SpendTags }[] = [];

  constructor(
    readonly capUsd: number,
    readonly deadlineMs?: number,
  ) {}

  add(usd: number, tags: SpendTags): void {
    this.total += usd;
    this.entries.push({ usd, tags });
  }

  spent(): number {
    return this.total;
  }

  exceeded(): boolean {
    return this.total >= this.capUsd - 1e-9;
  }

  pastDeadline(now = Date.now()): boolean {
    return this.deadlineMs !== undefined && now >= this.deadlineMs;
  }

  byTask(): Record<string, number> {
    return this.sumBy((t) => t.taskId);
  }

  byRole(): Record<string, number> {
    return this.sumBy((t) => t.role);
  }

  byCandidate(): Record<string, number> {
    return this.sumBy((t) => t.candidate);
  }

  byModel(): Record<string, number> {
    return this.sumBy((t) => t.model);
  }

  private sumBy(key: (t: SpendTags) => string | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const { usd, tags } of this.entries) {
      const k = key(tags);
      if (k !== undefined) out[k] = (out[k] ?? 0) + usd;
    }
    return out;
  }
}
