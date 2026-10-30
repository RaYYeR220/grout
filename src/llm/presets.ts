export type Tier = "planner" | "builder" | "utility";
export type Quality = "economy" | "quality";

export type Preset = {
  name: "venice" | "openrouter" | "openai-compatible" | "anthropic" | "openai";
  /** OpenAI-compatible chat-completions base URL; native presets use the runtime's own endpoints. */
  baseURL?: string;
  apiKeyEnv: string;
  models: Record<Tier, string>;
  extraBody?: Record<string, unknown>;
};

type Env = Record<string, string | undefined>;

const MODELS: Record<Preset["name"], Record<Quality, Record<Tier, string>>> = {
  venice: {
    economy: { planner: "claude-sonnet-5-5", builder: "claude-haiku-5-5", utility: "claude-haiku-5-5" },
    quality: { planner: "claude-opus-5-5", builder: "claude-sonnet-5-5", utility: "claude-haiku-5-5" },
  },
  openrouter: {
    economy: { planner: "anthropic/claude-sonnet-5.5", builder: "anthropic/claude-haiku-5.5", utility: "anthropic/claude-haiku-5.5" },
    quality: { planner: "anthropic/claude-opus-5.5", builder: "anthropic/claude-sonnet-5.5", utility: "anthropic/claude-haiku-5.5" },
  },
  anthropic: {
    economy: { planner: "claude-sonnet-5-5", builder: "claude-haiku-4-5", utility: "claude-haiku-4-5" },
    quality: { planner: "claude-opus-5-5", builder: "claude-sonnet-5-5", utility: "claude-haiku-4-5" },
  },
  openai: {
    economy: { planner: "gpt-6-sol", builder: "gpt-6-luna", utility: "gpt-6-luna" },
    quality: { planner: "gpt-6-astra", builder: "gpt-6-sol", utility: "gpt-6-luna" },
  },
  "openai-compatible": {
    economy: { planner: "", builder: "", utility: "" },
    quality: { planner: "", builder: "", utility: "" },
  },
};

const ORDER: { name: Preset["name"]; key: string }[] = [
  { name: "venice", key: "VENICE_API_KEY" },
  { name: "openrouter", key: "OPENROUTER_API_KEY" },
  { name: "anthropic", key: "ANTHROPIC_API_KEY" },
  { name: "openai", key: "OPENAI_API_KEY" },
  { name: "openai-compatible", key: "GROUT_API_KEY" },
];

const BASE_URLS: Partial<Record<Preset["name"], string>> = {
  venice: "https://api.venice.ai/api/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/** The first provider whose key is present (Venice first); GROUT_PROVIDER forces one. */
export function pickPreset(env: Env, quality: Quality = "economy"): Preset {
  const forced = env.GROUT_PROVIDER;
  const entry = forced ? ORDER.find((o) => o.name === forced) : ORDER.find((o) => env[o.key]);
  if (!entry) {
    throw new Error(`no model provider configured: set one of ${ORDER.map((o) => o.key).join(", ")} (see README)`);
  }
  const models = { ...MODELS[entry.name][quality] };
  for (const tier of ["planner", "builder", "utility"] as const) {
    const override = env[`GROUT_${tier.toUpperCase()}_MODEL`];
    if (override) models[tier] = override;
  }
  if (entry.name === "openai-compatible" && (!env.GROUT_BASE_URL || Object.values(models).some((m) => !m))) {
    throw new Error("openai-compatible provider needs GROUT_BASE_URL and GROUT_PLANNER_MODEL / GROUT_BUILDER_MODEL / GROUT_UTILITY_MODEL");
  }
  return {
    name: entry.name,
    apiKeyEnv: entry.key,
    baseURL: entry.name === "openai-compatible" ? env.GROUT_BASE_URL : BASE_URLS[entry.name],
    models,
    extraBody: entry.name === "venice" ? { venice_parameters: { include_venice_system_prompt: false } } : undefined,
  };
}

/** USD per million tokens, used only when the provider does not report a cost itself. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-6-sol": { input: 2, output: 10 },
  "gpt-6-astra": { input: 10, output: 50 },
};
