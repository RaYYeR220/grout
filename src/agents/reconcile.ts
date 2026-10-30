import type { Blueprint } from "../state/blueprint.js";
import type { Ledger } from "../state/ledger.js";

export type Reconciliation = {
  ok: boolean;
  uncoveredRequirements: string[];
  unknownRequirementRefs: string[];
  overlappingSurfaces: string[];
  missingEntry?: string;
  badDependencies?: string[];
};

/** Unknown, self and circular dependencies would leave tasks pending forever. */
function dependencyProblems(blueprint: Blueprint): string[] {
  const ids = new Set(blueprint.tasks.map((t) => t.id));
  const deps = new Map(blueprint.tasks.map((t) => [t.id, t.dependsOn]));
  const problems: string[] = [];
  for (const t of blueprint.tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) problems.push(`${t.id} depends on itself`);
      else if (!ids.has(d)) problems.push(`${t.id} depends on unknown task ${d}`);
    }
  }
  if (problems.length) return problems;
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): string | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id].join(" → ");
    state.set(id, "visiting");
    for (const d of deps.get(id) ?? []) {
      const cycle = visit(d, [...path, id]);
      if (cycle) return cycle;
    }
    state.set(id, "done");
    return undefined;
  };
  for (const t of blueprint.tasks) {
    const cycle = visit(t.id, []);
    if (cycle) return [`circular dependency: ${cycle}`];
  }
  return [];
}

/** Every testable requirement must be owned by some task; tasks may only cite requirements that exist. */
export function reconcile(ledger: Ledger, blueprint: Blueprint): Reconciliation {
  const known = new Set(ledger.requirements.map((r) => r.id));
  const cited = new Set(blueprint.tasks.flatMap((t) => t.requirements));
  const uncoveredRequirements = ledger.requirements.filter((r) => r.kind !== "non-functional" && !cited.has(r.id)).map((r) => r.id);
  const unknownRequirementRefs = [...cited].filter((id) => !known.has(id));
  const seen = new Map<string, number>();
  for (const t of blueprint.tasks) for (const p of t.writeSurface) seen.set(p, (seen.get(p) ?? 0) + 1);
  const overlappingSurfaces = [...seen].filter(([, n]) => n > 1).map(([p]) => p);
  const entry = ledger.interface.entry;
  const missingEntry = blueprint.tasks.some((t) => t.writeSurface.includes(entry)) ? undefined : entry;
  const badDependencies = dependencyProblems(blueprint);
  return {
    ok: uncoveredRequirements.length === 0 && unknownRequirementRefs.length === 0 && !missingEntry && badDependencies.length === 0,
    uncoveredRequirements,
    unknownRequirementRefs,
    overlappingSurfaces,
    ...(missingEntry ? { missingEntry } : {}),
    ...(badDependencies.length ? { badDependencies } : {}),
  };
}
