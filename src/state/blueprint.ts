import { z } from "zod";
import { normalizePath } from "../paths.js";

const workspacePath = z.string().transform((p, ctx) => {
  try {
    return normalizePath(p);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

export const TaskSpecSchema = z.object({
  id: z.string().regex(/^T\d+$/, "ids look like T1, T2, …"),
  title: z.string().min(1),
  writeSurface: z.array(workspacePath).min(1, "a task must own at least one file"),
  requirements: z.array(z.string()),
  dependsOn: z.array(z.string()),
  notes: z.string(),
});

export const BlueprintSchema = z.object({
  files: z.array(z.object({ path: workspacePath, purpose: z.string(), owner: z.string() })),
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
  tasks: z.array(TaskSpecSchema).min(1),
});

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type Blueprint = z.infer<typeof BlueprintSchema>;
