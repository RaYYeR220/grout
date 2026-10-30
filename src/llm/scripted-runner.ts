import {
  DeveloperMessageItem,
  FunctionCallItem,
  ModelMessageItem,
  SemanticEvent,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
} from "@mozaik-ai/core";

export type Script = (input: InferenceInput, turn: number) => InferenceOutput | Promise<InferenceOutput>;

let callSeq = 0;

export function toolCall(name: string, args: unknown): InferenceOutput {
  callSeq += 1;
  const raw = typeof args === "string" ? args : JSON.stringify(args);
  return { items: [FunctionCallItem.rehydrate({ callId: `call_${callSeq}`, name, args: raw })], tokenUsage: undefined, rowResponse: { cost: { usd: 0 } } };
}

export function say(text: string): InferenceOutput {
  return { items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: { cost: { usd: 0 } } };
}

export function developerText(input: InferenceInput): string {
  const dev = input.context.getItems().find((i) => i instanceof DeveloperMessageItem) as DeveloperMessageItem | undefined;
  return dev?.content.text ?? "";
}

/** A zero-token inference runner: tests and the race harness script every turn. */
export class ScriptedRunner implements InferenceRunner {
  private readonly turns = new Map<string, number>();

  constructor(private readonly script: Script) {}

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const turn = this.turns.get(input.context.id) ?? 0;
    this.turns.set(input.context.id, turn + 1);
    return this.script(input, turn);
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    yield SemanticEvent.create("inference.output", "scripted", await this.run(input));
  }
}
