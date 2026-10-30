import { z } from "zod";

export const REQUIREMENT_KINDS = [
  "cli-command",
  "cli-flag",
  "output-format",
  "exit-code",
  "http-route",
  "http-status",
  "json-shape",
  "validation",
  "error-message",
  "persistence",
  "env-config",
  "behavior",
  "non-functional",
] as const;

const nonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");

export const RequirementSchema = z.object({
  id: z.string().regex(/^R\d+$/, "ids look like R1, R2, …"),
  kind: z.enum(REQUIREMENT_KINDS),
  statement: nonBlank,
  specQuote: nonBlank,
  examples: z.array(z.object({ input: z.string(), expected: z.string() })),
  interpretation: z.string().optional(),
});

export const InterfaceSchema = z
  .object({
    kind: z.enum(["cli", "http"]),
    entry: nonBlank,
    binName: z.string().optional(),
    invocation: nonBlank,
    port: z.object({ env: nonBlank, default: z.number().int().positive() }).optional(),
    notes: z.array(z.string()),
  })
  .refine((i) => i.kind !== "http" || i.port !== undefined, {
    message: "an http interface must say which env var holds the port and its default",
    path: ["port"],
  });

export const LedgerSchema = z
  .object({
    requirements: z.array(RequirementSchema).min(1),
    interface: InterfaceSchema,
    ambiguities: z.array(z.object({ question: z.string(), chosen: z.string(), specQuote: z.string().optional() })),
  })
  .refine((l) => new Set(l.requirements.map((r) => r.id)).size === l.requirements.length, {
    message: "requirement ids must be unique",
    path: ["requirements"],
  });

export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];
export type Requirement = z.infer<typeof RequirementSchema>;
export type Interface = z.infer<typeof InterfaceSchema>;
export type Ledger = z.infer<typeof LedgerSchema>;
