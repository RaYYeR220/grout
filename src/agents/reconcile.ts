import type { Blueprint } from "../state/blueprint.js";
import type { Ledger } from "../state/ledger.js";

export type Reconciliation = { ok: boolean; uncoveredRequirements: string[]; unknownRequirementRefs: string[]; overlappingSurfaces: string[] };

/** Every testable requirement must be owned by some task; tasks may only cite requirements that exist. */
export function reconcile(ledger: Ledger, blueprint: Blueprint): Reconciliation {
  const known = new Set(ledger.requirements.map((r) => r.id));
  const cited = new Set(blueprint.tasks.flatMap((t) => t.requirements));
  const uncoveredRequirements = ledger.requirements.filter((r) => r.kind !== "non-functional" && !cited.has(r.id)).map((r) => r.id);
  const unknownRequirementRefs = [...cited].filter((id) => !known.has(id));
  const seen = new Map<string, number>();
  for (const t of blueprint.tasks) for (const p of t.writeSurface) seen.set(p, (seen.get(p) ?? 0) + 1);
  const overlappingSurfaces = [...seen].filter(([, n]) => n > 1).map(([p]) => p);
  return { ok: uncoveredRequirements.length === 0 && unknownRequirementRefs.length === 0, uncoveredRequirements, unknownRequirementRefs, overlappingSurfaces };
}
