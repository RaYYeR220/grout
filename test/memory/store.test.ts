import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalJsonStore, Mem0Store, createMemoryStore } from "../../src/memory/store.js";

describe("LocalJsonStore", () => {
  test("remembers across instances and recalls by keyword overlap", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "mem-")), "lessons.json");
    const a = new LocalJsonStore(file);
    await a.remember("ESM relative imports need the .js extension under NodeNext", { kind: "lesson" });
    await a.remember("HTTP servers must read the port from the PORT env var", { kind: "lesson" });
    await a.remember("unrelated note about colors", { kind: "lesson" });
    const b = new LocalJsonStore(file);
    expect(await b.recall("ESM imports NodeNext extension", 1)).toEqual(["ESM relative imports need the .js extension under NodeNext"]);
    expect(await b.recall("http server port", 5)).toContain("HTTP servers must read the port from the PORT env var");
  });

  test("does not store the same lesson twice", async () => {
    const s = new LocalJsonStore(join(mkdtempSync(join(tmpdir(), "mem-")), "l.json"));
    await s.remember("same", {});
    await s.remember("same", {});
    expect(await s.recall("same", 10)).toEqual(["same"]);
  });
});

describe("Mem0Store", () => {
  test("adds without inference and searches scoped to the factory's user id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = url.endsWith("/search/") ? { results: [{ memory: "use node:util parseArgs", score: 0.8 }] } : { results: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const s = new Mem0Store("key-123", fetcher as typeof fetch);
    await s.remember("use node:util parseArgs", { kind: "lesson" });
    expect(await s.recall("argument parsing", 3)).toEqual(["use node:util parseArgs"]);
    expect(calls[0].url).toBe("https://api.mem0.ai/v3/memories/add/");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Token key-123");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ user_id: "grout-factory", infer: false, messages: [{ role: "user", content: "use node:util parseArgs" }] });
    expect(calls[1].url).toBe("https://api.mem0.ai/v3/memories/search/");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ query: "argument parsing", filters: { user_id: "grout-factory" }, top_k: 3 });
  });

  test("a failing memory service never throws into the run", async () => {
    const s = new Mem0Store("k", (async () => new Response("down", { status: 503 })) as typeof fetch);
    await expect(s.remember("x", {})).resolves.toBeUndefined();
    await expect(s.recall("x", 3)).resolves.toEqual([]);
  });
});

describe("createMemoryStore", () => {
  test("mem0 when a key is set, otherwise the local file", () => {
    expect(createMemoryStore({ MEM0_API_KEY: "k" }).kind).toBe("mem0");
    expect(createMemoryStore({}).kind).toBe("local");
  });
});
