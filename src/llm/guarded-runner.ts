import {
  FunctionCallItem,
  ModelMessageItem,
  SemanticEvent,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
} from "@mozaik-ai/core";

export type CallInfo = { model: string; ms: number; attempts: number; ok: boolean; error?: string };

export type GuardOptions = {
  timeoutMs: number;
  retries: number;
  backoffMs?: number;
  onCall?: (info: CallInfo) => void;
};

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`no response within ${ms} ms`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hasAnswer(out: InferenceOutput): boolean {
  return out.items.some((i) => i instanceof FunctionCallItem || i instanceof ModelMessageItem);
}

function synthesized(text: string): InferenceOutput {
  return { items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse: { synthesized: true } };
}

/**
 * Mozaik 4.2 runs each agent loop un-awaited, so an exception inside inference becomes an
 * unhandled rejection and kills the process. This runner never throws: it adds a timeout,
 * retries with backoff, retries an empty turn once, and as a last resort answers with an
 * ERROR message so the loop ends cleanly and the supervisor can respawn the task.
 */
export class GuardedRunner implements InferenceRunner {
  constructor(
    private readonly inner: InferenceRunner,
    private readonly opts: GuardOptions,
  ) {}

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const started = Date.now();
    const backoff = this.opts.backoffMs ?? 1000;
    let attempts = 0;
    let failures = 0;
    let emptyRetried = false;
    let lastError = "";
    while (failures <= this.opts.retries) {
      attempts += 1;
      try {
        const out = await this.withTimeout(this.inner.run(input));
        if (hasAnswer(out)) {
          this.report(input, started, attempts, true);
          return out;
        }
        if (!emptyRetried) {
          emptyRetried = true;
          continue;
        }
        this.report(input, started, attempts, true);
        return synthesized("(empty model turn)");
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        failures += 1;
        if (failures <= this.opts.retries) await sleep(backoff * 3 ** (failures - 1));
      }
    }
    this.report(input, started, attempts, false, lastError);
    return synthesized(`ERROR: inference failed: ${lastError}`);
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    yield SemanticEvent.create("inference.output", "runner", await this.run(input));
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(this.opts.timeoutMs)), this.opts.timeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private report(input: InferenceInput, started: number, attempts: number, ok: boolean, error?: string): void {
    this.opts.onCall?.({ model: input.model, ms: Date.now() - started, attempts, ok, ...(error ? { error } : {}) });
  }
}
