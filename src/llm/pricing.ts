import type { TokenUsage } from "@mozaik-ai/core";
import { PRICES } from "./presets.js";

export type Cost = { usd: number; source: "provider" | "table" | "unknown" };

function priceKey(model: string): string {
  return model.replace(/^[a-z-]+\//, "").replace(/\./g, "-");
}

/** Cost of one inference call: the provider's own figure when it sends one, else the price table. */
export function callCost(model: string, usage: TokenUsage | undefined, raw: unknown): Cost {
  const reported = (raw as { cost?: { usd?: unknown } } | undefined)?.cost?.usd;
  if (typeof reported === "number") return { usd: reported, source: "provider" };
  const price = PRICES[priceKey(model)];
  if (!price || !usage) return { usd: 0, source: "unknown" };
  const usd = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  return { usd: Math.round(usd * 1e9) / 1e9, source: "table" };
}
