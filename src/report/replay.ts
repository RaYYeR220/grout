import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceLine } from "../participants/tracer.js";
import { formatEvent } from "./live.js";

export function readTrace(path: string): TraceLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceLine);
}

/** Re-plays a recorded run in the terminal at `speed`× real time. Needs no key and no network. */
export async function replay(runDir: string, speed = 20, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<void> {
  const file = runDir.endsWith(".jsonl") ? runDir : join(runDir, "trace.jsonl");
  const lines = readTrace(file);
  if (lines.length === 0) return;
  const t0 = Math.min(...lines.map((l) => l.t));
  let cost = 0;
  let prev = t0;
  for (const l of lines) {
    if (l.type === "llm.call") cost += (l.payload as { costUsd?: number }).costUsd ?? 0;
    const who = l.slot ? `${l.slot}${l.taskId ? `(${l.taskId})` : ""}` : l.producer;
    const text = formatEvent(l.type, who, (l.payload ?? {}) as Record<string, unknown>);
    if (!text) continue;
    const wait = Math.min(1500, (l.t - prev) / speed);
    if (wait > 5) await new Promise((r) => setTimeout(r, wait));
    prev = l.t;
    const s = Math.max(0, Math.floor((l.t - t0) / 1000));
    write(`[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")} $${cost.toFixed(3)}] ${text}\n`);
  }
}
