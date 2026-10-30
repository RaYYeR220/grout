import { z } from "zod";
import type { Tier } from "../llm/presets.js";
import type { Role } from "../state/factory-state.js";

export const ROLE_LIMITS: Record<Role, { tier: Tier; maxSteps: number }> = {
  analyst: { tier: "planner", maxSteps: 8 },
  architect: { tier: "planner", maxSteps: 30 },
  builder: { tier: "builder", maxSteps: 45 },
  "test-author": { tier: "builder", maxSteps: 35 },
  reviewer: { tier: "planner", maxSteps: 10 },
  arbiter: { tier: "planner", maxSteps: 10 },
  utility: { tier: "utility", maxSteps: 6 },
};

export const ReviewSchema = z.object({
  verdict: z.enum(["approve", "reopen"]),
  findings: z.array(z.string()).describe("each finding names the requirement id, the file and what to change"),
});

export const VerdictSchema = z.object({
  ruling: z.enum(["test-wrong", "code-wrong", "ambiguous"]),
  reasoning: z.string(),
  interpretation: z.string().optional(),
});

export const TestsDoneSchema = z.object({ summary: z.string() });

export type Review = z.infer<typeof ReviewSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
