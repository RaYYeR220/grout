import type { Config } from "./types.js";

function num(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** Reads PORT (default 3000) and HOLD_SECONDS (default 600) from env. now() returns Date.now(). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 3000),
    holdSeconds: num(env.HOLD_SECONDS, 600),
    now: () => Date.now(),
  };
}
