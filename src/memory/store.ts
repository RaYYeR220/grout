import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What the factory learned in earlier runs: short, actionable lessons recalled into later runs. */
export interface MemoryStore {
  readonly kind: "mem0" | "local";
  recall(query: string, k: number): Promise<string[]>;
  remember(lesson: string, meta: Record<string, string>): Promise<void>;
}

const USER_ID = "grout-factory";
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9.]{3,}/g) ?? []);

export class LocalJsonStore implements MemoryStore {
  readonly kind = "local" as const;

  constructor(private readonly file = join(homedir(), ".grout", "lessons.json")) {}

  private load(): { lesson: string; meta: Record<string, string>; at: number }[] {
    try {
      return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : [];
    } catch {
      return [];
    }
  }

  async recall(query: string, k: number): Promise<string[]> {
    const q = words(query);
    return this.load()
      .map((e) => ({ e, score: [...words(e.lesson)].filter((w) => q.has(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.e.at - a.e.at)
      .slice(0, k)
      .map((x) => x.e.lesson);
  }

  async remember(lesson: string, meta: Record<string, string>): Promise<void> {
    const all = this.load();
    if (all.some((e) => e.lesson === lesson)) return;
    all.push({ lesson, meta, at: Date.now() });
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(all, null, 2));
  }
}

/** mem0's hosted memory (the event sponsor): lessons stored verbatim, searched with hybrid retrieval. */
export class Mem0Store implements MemoryStore {
  readonly kind = "mem0" as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly base = "https://api.mem0.ai",
  ) {}

  private async post(path: string, body: unknown): Promise<any> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`mem0 ${path} answered ${res.status}`);
    return res.json();
  }

  async recall(query: string, k: number): Promise<string[]> {
    try {
      const r = await this.post("/v3/memories/search/", { query, filters: { user_id: USER_ID }, top_k: k });
      return (r?.results ?? []).map((m: { memory?: string }) => m.memory).filter(Boolean);
    } catch {
      return [];
    }
  }

  async remember(lesson: string, meta: Record<string, string>): Promise<void> {
    try {
      await this.post("/v3/memories/add/", { messages: [{ role: "user", content: lesson }], user_id: USER_ID, metadata: meta, infer: false });
    } catch {
      /* memory is an aid, never a reason for a run to fail */
    }
  }
}

export function createMemoryStore(env: Record<string, string | undefined>): MemoryStore {
  return env.MEM0_API_KEY ? new Mem0Store(env.MEM0_API_KEY) : new LocalJsonStore(env.GROUT_LESSONS_FILE);
}
