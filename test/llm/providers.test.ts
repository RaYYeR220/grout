import { describe, expect, test } from "vitest";
import { ModelContext, DeveloperMessageItem, FunctionCallItem, ModelMessageItem } from "@mozaik-ai/core";
import { buildModels } from "../../src/llm/providers.js";
import { pickPreset } from "../../src/llm/presets.js";
import { ScriptedRunner, developerText, say, toolCall } from "../../src/llm/scripted-runner.js";

describe("buildModels", () => {
  test("one chat-completions model per distinct id, max tokens = largest tier using it", () => {
    const preset = pickPreset({ VENICE_API_KEY: "k" });
    const models = buildModels(preset, { planner: 16000, builder: 12000, utility: 4000 }, { VENICE_API_KEY: "k" });
    const specs = models.map((m) => m.specification);
    expect(specs.map((s) => s.name).sort()).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(specs.find((s) => s.name === "claude-haiku-5-5")?.maxOutputTokens).toBe(12000);
    expect(specs.every((s) => s.supportsFunctionCalling && !s.supportsStreaming)).toBe(true);
    expect(specs[0].supportedContextItemTypes).toContain("developer_message");
  });

  test("native anthropic preset reuses the runtime's bundled models", () => {
    const preset = pickPreset({ ANTHROPIC_API_KEY: "k" });
    const names = buildModels(preset, { planner: 1, builder: 1, utility: 1 }, { ANTHROPIC_API_KEY: "k" }).map((m) => m.specification.name);
    expect(names.sort()).toEqual(["claude-haiku-4-5", "claude-sonnet-5-5"]);
  });
});

describe("ScriptedRunner", () => {
  test("counts turns per context and exposes the developer instruction", async () => {
    const seen: string[] = [];
    const runner = new ScriptedRunner((input, turn) => {
      seen.push(`${developerText(input)}#${turn}`);
      return turn === 0 ? toolCall("read_file", { path: "a.ts" }) : say("done");
    });
    const a = ModelContext.create().addContextItem(DeveloperMessageItem.create("builder"));
    const b = ModelContext.create().addContextItem(DeveloperMessageItem.create("reviewer"));
    const first = await runner.run({ model: "m", context: a });
    await runner.run({ model: "m", context: b });
    const second = await runner.run({ model: "m", context: a });
    expect(first.items[0]).toBeInstanceOf(FunctionCallItem);
    expect(second.items[0]).toBeInstanceOf(ModelMessageItem);
    expect(seen).toEqual(["builder#0", "reviewer#0", "builder#1"]);
  });
});
