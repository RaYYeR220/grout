import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { call, sleep, startServer, type Env, type Server } from "../helpers.js";

const SERVER = ["node", "dist/index.js"];

function serverPerSuite(env: Env): () => Server {
  let server: Server | undefined;
  beforeAll(async () => {
    server = await startServer(SERVER, { portEnv: "HTTP_PORT", env });
  });
  afterAll(async () => {
    await server?.stop();
  });
  return () => server!;
}

const hit = (server: Server, name: string, client: string) => call(server, "POST", `/counters/${name}`, undefined, { "X-Client-Id": client });

function limitHeaders(r: { headers: Headers }) {
  return { limit: r.headers.get("x-ratelimit-limit"), remaining: r.headers.get("x-ratelimit-remaining") };
}

describe("counters", () => {
  const server = serverPerSuite({ RATE_LIMIT: "1000", RATE_WINDOW_MS: "60000" });

  test("POST adds one and returns the new value", async () => {
    const first = await hit(server(), "home", "c1");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toMatch(/^application\/json/);
    expect(first.json).toEqual({ name: "home", value: 1 });
    expect((await hit(server(), "home", "c1")).json).toEqual({ name: "home", value: 2 });
  });

  test("GET returns the value, 0 for a counter never incremented", async () => {
    const never = await call(server(), "GET", "/counters/never-touched");
    expect(never.status).toBe(200);
    expect(never.json).toEqual({ name: "never-touched", value: 0 });
    await hit(server(), "about", "c1");
    await hit(server(), "about", "c2");
    expect((await call(server(), "GET", "/counters/about")).json).toEqual({ name: "about", value: 2 });
  });

  test("DELETE sets the counter back to 0", async () => {
    await hit(server(), "reset-me", "c1");
    const r = await call(server(), "DELETE", "/counters/reset-me");
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect((await call(server(), "GET", "/counters/reset-me")).json).toEqual({ name: "reset-me", value: 0 });
    expect((await call(server(), "DELETE", "/counters/untouched")).status).toBe(204);
    expect((await hit(server(), "reset-me", "c1")).json.value).toBe(1);
  });

  test("names are 1 to 64 of a-z, 0-9 and -", async () => {
    expect((await hit(server(), "a", "c1")).status).toBe(200);
    expect((await hit(server(), `x${"-9".repeat(31)}z`, "c1")).status).toBe(200);
    for (const name of ["Home", "under_score", "dot.ted", "a%20b", "y".repeat(65)]) {
      const r = await hit(server(), name, "c1");
      expect(r.status, name).toBe(400);
      expect(r.json).toEqual({ error: "invalid counter name" });
    }
    for (const method of ["GET", "DELETE"]) {
      const r = await call(server(), method, "/counters/Bad");
      expect(r.status, method).toBe(400);
      expect(r.json).toEqual({ error: "invalid counter name" });
    }
  });

  test("an increment without X-Client-Id is a 400, checked before the name", async () => {
    const missing = await call(server(), "POST", "/counters/home");
    expect(missing.status).toBe(400);
    expect(missing.json).toEqual({ error: "missing X-Client-Id" });
    const empty = await call(server(), "POST", "/counters/home", undefined, { "X-Client-Id": "" });
    expect(empty.status).toBe(400);
    expect(empty.json).toEqual({ error: "missing X-Client-Id" });
    const both = await call(server(), "POST", "/counters/BAD");
    expect(both.json).toEqual({ error: "missing X-Client-Id" });
  });

  test("other methods and paths are 404", async () => {
    const cases: [string, string][] = [
      ["GET", "/"],
      ["GET", "/nope"],
      ["POST", "/counters"],
      ["PUT", "/counters/home"],
      ["GET", "/counters/home/extra"],
    ];
    for (const [method, path] of cases) {
      const r = await call(server(), method, path, undefined, { "X-Client-Id": "c1" });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json).toEqual({ error: "not found" });
    }
  });
});

describe("listing", () => {
  const server = serverPerSuite({ RATE_LIMIT: "1000", RATE_WINDOW_MS: "60000" });

  test("GET /counters lists counters above 0, highest first, ties by name", async () => {
    for (const [name, times] of [["b", 2], ["c", 3], ["a", 2], ["d", 1]] as const) {
      for (let i = 0; i < times; i++) await hit(server(), name, "lister");
    }
    await call(server(), "DELETE", "/counters/d");
    await call(server(), "GET", "/counters/zero");
    const r = await call(server(), "GET", "/counters");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      counters: [
        { name: "c", value: 3 },
        { name: "a", value: 2 },
        { name: "b", value: 2 },
      ],
    });
  });
});

describe("rate limit", () => {
  const server = serverPerSuite({ RATE_LIMIT: "3", RATE_WINDOW_MS: "10000" });

  test("a client gets RATE_LIMIT increments per window, then 429", async () => {
    const remaining: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await hit(server(), "limited", "rl-a");
      expect(r.status).toBe(200);
      expect(r.headers.get("x-ratelimit-limit")).toBe("3");
      remaining.push(r.headers.get("x-ratelimit-remaining"));
    }
    expect(remaining).toEqual(["2", "1", "0"]);
    const over = await hit(server(), "limited", "rl-a");
    expect(over.status).toBe(429);
    expect(over.json).toEqual({ error: "rate limit exceeded" });
    expect(limitHeaders(over)).toEqual({ limit: "3", remaining: "0" });
    // The window is 10 s and the requests above take well under a second, so 9.x s are left.
    expect(over.headers.get("retry-after")).toBe("10");
    expect((await call(server(), "GET", "/counters/limited")).json).toEqual({ name: "limited", value: 3 });
  });

  test("the allowance is per client and shared across counters", async () => {
    for (const name of ["x", "y", "z"]) expect((await hit(server(), name, "rl-b")).status).toBe(200);
    expect((await hit(server(), "w", "rl-b")).status).toBe(429);
    const other = await hit(server(), "x", "rl-c");
    expect(other.status).toBe(200);
    expect(limitHeaders(other)).toEqual({ limit: "3", remaining: "2" });
    expect((await call(server(), "GET", "/counters/w")).json.value).toBe(0);
  });

  test("requests rejected with 400 use up nothing", async () => {
    for (let i = 0; i < 4; i++) expect((await hit(server(), "NOT-VALID", "rl-d")).status).toBe(400);
    const remaining: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await hit(server(), "fine", "rl-d");
      expect(r.status).toBe(200);
      remaining.push(r.headers.get("x-ratelimit-remaining"));
    }
    expect(remaining).toEqual(["2", "1", "0"]);
  });
});

describe("rate limit windows", () => {
  const server = serverPerSuite({ RATE_LIMIT: "2", RATE_WINDOW_MS: "1000" });

  test("a new window opens after the old one closes, and rejected requests do not extend it", async () => {
    expect((await hit(server(), "win", "w1")).status).toBe(200);
    expect((await hit(server(), "win", "w1")).status).toBe(200);
    await sleep(500);
    const rejected = await hit(server(), "win", "w1");
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");
    // 1.1 s after the window opened: closed, unless the rejected request had restarted it.
    await sleep(600);
    const fresh = await hit(server(), "win", "w1");
    expect(fresh.status).toBe(200);
    expect(limitHeaders(fresh)).toEqual({ limit: "2", remaining: "1" });
    expect((await call(server(), "GET", "/counters/win")).json.value).toBe(3);
  });
});

describe("defaults", () => {
  const server = serverPerSuite({ RATE_LIMIT: undefined, RATE_WINDOW_MS: undefined });

  test("without configuration a client gets 5 increments per second", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await hit(server(), "default", "d1");
      expect(r.status).toBe(200);
      expect(limitHeaders(r)).toEqual({ limit: "5", remaining: String(4 - i) });
    }
    const over = await hit(server(), "default", "d1");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("1");
  });
});
