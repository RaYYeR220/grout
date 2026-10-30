import { describe, expect, test } from "vitest";
import { FunctionCallItem, ModelContext, ModelMessageItem, type InferenceInput, type InferenceOutput, type InferenceRunner } from "@mozaik-ai/core";
import { GuardedRunner } from "../../src/llm/guarded-runner.js";
import { callCost } from "../../src/llm/pricing.js";
import { pickPreset } from "../../src/llm/presets.js";

const input = (): InferenceInput => ({ model: "m", context: ModelContext.create() });
const message = (text: string): InferenceOutput => ({ items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: {} });

function fake(steps: (() => Promise<InferenceOutput>)[]): InferenceRunner & { calls: number } {
  const r = {
    calls: 0,
    async run() {
      const step = steps[Math.min(r.calls, steps.length - 1)];
      r.calls += 1;
      return step();
    },
    async *stream() {
      throw new Error("not used");
    },
  };
  return r;
}

const textOf = (out: InferenceOutput) => (out.items[0] as ModelMessageItem).content.text;

describe("GuardedRunner", () => {
  test("retries after a timeout and returns the next answer", async () => {
    const inner = fake([() => new Promise(() => {}), async () => message("ok")]);
    const out = await new GuardedRunner(inner, { timeoutMs: 20, retries: 2, backoffMs: 1 }).run(input());
    expect(textOf(out)).toBe("ok");
    expect(inner.calls).toBe(2);
  });

  test("turns repeated failures into a model message instead of throwing", async () => {
    const inner = fake([async () => { throw new Error("502 bad gateway"); }]);
    const out = await new GuardedRunner(inner, { timeoutMs: 50, retries: 2, backoffMs: 1 }).run(input());
    expect(textOf(out)).toContain("ERROR: inference failed: 502 bad gateway");
    expect(inner.calls).toBe(3);
  });

  test("an empty model turn is retried once, then replaced by a placeholder message", async () => {
    const empty = async (): Promise<InferenceOutput> => ({ items: [], tokenUsage: undefined, rowResponse: {} });
    const inner = fake([empty]);
    const out = await new GuardedRunner(inner, { timeoutMs: 50, retries: 0, backoffMs: 1 }).run(input());
    expect(inner.calls).toBe(2);
    expect(textOf(out)).toBe("(empty model turn)");
  });

  test("a turn with a function call passes through untouched", async () => {
    const call = FunctionCallItem.rehydrate({ callId: "c1", name: "read_file", args: "{}" });
    const inner = fake([async () => ({ items: [call], tokenUsage: undefined, rowResponse: { cost: { usd: 0.01 } } })]);
    const out = await new GuardedRunner(inner, { timeoutMs: 50, retries: 0, backoffMs: 1 }).run(input());
    expect(out.items[0]).toBe(call);
  });

  test("reports each call to onCall", async () => {
    const infos: unknown[] = [];
    const inner = fake([async () => { throw new Error("x"); }, async () => message("ok")]);
    await new GuardedRunner(inner, { timeoutMs: 50, retries: 1, backoffMs: 1, onCall: (i) => infos.push(i) }).run(input());
    expect(infos).toEqual([expect.objectContaining({ model: "m", ok: true, attempts: 2 })]);
  });
});

describe("callCost", () => {
  test("prefers the provider-reported cost", () => {
    expect(callCost("claude-haiku-5-5", undefined, { cost: { usd: 0.0123 } })).toEqual({ usd: 0.0123, source: "provider" });
  });

  test("falls back to the price table", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 } as never;
    expect(callCost("claude-haiku-5-5", usage, {})).toEqual({ usd: 0.6, source: "table" });
  });

  test("unknown model without a reported cost is zero and says so", () => {
    expect(callCost("mystery", undefined, {})).toEqual({ usd: 0, source: "unknown" });
  });
});

describe("pickPreset", () => {
  test("Venice wins when its key is present; GROUT_PROVIDER overrides", () => {
    expect(pickPreset({ VENICE_API_KEY: "x", OPENROUTER_API_KEY: "y" }).name).toBe("venice");
    expect(pickPreset({ OPENROUTER_API_KEY: "y" }).name).toBe("openrouter");
    expect(pickPreset({ VENICE_API_KEY: "x", OPENROUTER_API_KEY: "y", GROUT_PROVIDER: "openrouter" }).name).toBe("openrouter");
  });

  test("quality tier swaps in stronger models; env overrides a single role", () => {
    const q = pickPreset({ VENICE_API_KEY: "x" }, "quality");
    expect(q.models.planner).toBe("claude-opus-5-5");
    expect(q.models.builder).toBe("claude-sonnet-5-5");
    expect(pickPreset({ VENICE_API_KEY: "x", GROUT_BUILDER_MODEL: "custom-model" }).models.builder).toBe("custom-model");
  });

  test("no key at all is a clear error", () => {
    expect(() => pickPreset({})).toThrow(/VENICE_API_KEY/);
  });
});
