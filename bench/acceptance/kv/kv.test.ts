import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ISO_UTC_MS, call, sleep, startServer, type Server } from "../helpers.js";

const SERVER = ["node", "dist/kv.js"];

function serverPerSuite(): () => Server {
  let server: Server | undefined;
  beforeAll(async () => {
    server = await startServer(SERVER, { portEnv: "APP_PORT" });
  });
  afterAll(async () => {
    await server?.stop();
  });
  return () => server!;
}

describe("values", () => {
  const server = serverPerSuite();
  const put = (key: string, body: unknown) => call(server(), "PUT", `/keys/${key}`, body);
  const get = (key: string) => call(server(), "GET", `/keys/${key}`);

  test("PUT of a new key gives 201 with the entry", async () => {
    const r = await put("greeting", { value: "hello" });
    expect(r.status).toBe(201);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.json).toEqual({ key: "greeting", value: "hello", expiresAt: null });
  });

  test("PUT of an existing key replaces it with 200", async () => {
    await put("color", { value: "red" });
    const r = await put("color", { value: "blue" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ key: "color", value: "blue", expiresAt: null });
    const read = await get("color");
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ key: "color", value: "blue", expiresAt: null });
  });

  test("GET of a key that was never set is a 404", async () => {
    const r = await get("never-set");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "key not found" });
  });

  test("keys are percent-decoded and may use . _ : -", async () => {
    const r = await put("user%3A42", { value: "ada" });
    expect(r.status).toBe(201);
    expect(r.json.key).toBe("user:42");
    expect((await get("user:42")).json).toEqual({ key: "user:42", value: "ada", expiresAt: null });
    expect((await put("a.b_c:d-E9", { value: "" })).status).toBe(201);
    expect((await get("a.b_c%3Ad-E9")).json).toEqual({ key: "a.b_c:d-E9", value: "", expiresAt: null });
  });

  test("keys of 1 and 128 characters are fine; anything else is a 400", async () => {
    expect((await put("k", { value: "1" })).status).toBe(201);
    expect((await put("k".repeat(128), { value: "1" })).status).toBe(201);
    for (const key of ["k".repeat(129), "has%20space", "bang%21", "slash%2Fkey", "%C3%BC"]) {
      const r = await put(key, { value: "1" });
      expect(r.status, key).toBe(400);
      expect(r.json).toEqual({ error: "invalid key" });
    }
    const read = await get("bang%21");
    expect(read.status).toBe(400);
    expect(read.json).toEqual({ error: "invalid key" });
  });

  test("DELETE gives 204 whether or not the key existed", async () => {
    await put("doomed", { value: "x" });
    const first = await call(server(), "DELETE", "/keys/doomed");
    expect(first.status).toBe(204);
    expect(first.text).toBe("");
    expect((await get("doomed")).status).toBe(404);
    const second = await call(server(), "DELETE", "/keys/doomed");
    expect(second.status).toBe(204);
  });

  test("PUT bodies are checked in order", async () => {
    const cases: [unknown, string][] = [
      ["not json", "invalid JSON body"],
      ["[]", "invalid JSON body"],
      ['"text"', "invalid JSON body"],
      [{}, "value must be a string"],
      [{ value: 5 }, "value must be a string"],
      [{ value: 5, ttl: -1 }, "value must be a string"],
      [{ value: "x", ttl: 0 }, "ttl must be a positive integer"],
      [{ value: "x", ttl: 1.5 }, "ttl must be a positive integer"],
      [{ value: "x", ttl: "100" }, "ttl must be a positive integer"],
    ];
    for (const [body, error] of cases) {
      const r = await put("checked", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json).toEqual({ error });
    }
    expect((await get("checked")).status).toBe(404);
  });

  test("the key is checked before the body", async () => {
    const r = await put("bad%20key", "not json");
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "invalid key" });
  });

  test("other methods and paths are 404", async () => {
    const cases: [string, string][] = [
      ["GET", "/"],
      ["GET", "/nothing"],
      ["POST", "/keys/x"],
      ["PATCH", "/keys/x"],
      ["POST", "/keys/x/decr"],
    ];
    for (const [method, path] of cases) {
      const r = await call(server(), method, path);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json).toEqual({ error: "not found" });
    }
  });
});

describe("expiry", () => {
  const server = serverPerSuite();
  const put = (key: string, body: unknown) => call(server(), "PUT", `/keys/${key}`, body);
  const get = (key: string) => call(server(), "GET", `/keys/${key}`);

  test("ttl sets expiresAt that many milliseconds ahead", async () => {
    const before = Date.now();
    const r = await put("session", { value: "alice", ttl: 60_000 });
    expect(r.status).toBe(201);
    expect(r.json.expiresAt).toMatch(ISO_UTC_MS);
    const expires = Date.parse(r.json.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000 + 1000);
    expect((await get("session")).json).toEqual(r.json);
  });

  test("an expired key is gone everywhere and can be created again", async () => {
    expect((await put("brief", { value: "v", ttl: 400 })).status).toBe(201);
    expect((await get("brief")).status).toBe(200);
    await sleep(700);
    const read = await get("brief");
    expect(read.status).toBe(404);
    expect(read.json).toEqual({ error: "key not found" });
    expect((await call(server(), "GET", "/keys")).json.keys).not.toContain("brief");
    const again = await put("brief", { value: "w" });
    expect(again.status).toBe(201);
    expect(again.json).toEqual({ key: "brief", value: "w", expiresAt: null });
  });

  test("a PUT without ttl drops the previous expiry", async () => {
    await put("sticky", { value: "a", ttl: 300 });
    const r = await put("sticky", { value: "b" });
    expect(r.status).toBe(200);
    expect(r.json.expiresAt).toBeNull();
    await sleep(600);
    expect((await get("sticky")).json).toEqual({ key: "sticky", value: "b", expiresAt: null });
  });
});

describe("incr", () => {
  const server = serverPerSuite();
  const put = (key: string, body: unknown) => call(server(), "PUT", `/keys/${key}`, body);
  const incr = (key: string, body?: unknown) => call(server(), "POST", `/keys/${key}/incr`, body);

  test("a missing key counts as 0 and the body is optional", async () => {
    const first = await incr("visits");
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ key: "visits", value: "1", expiresAt: null });
    expect((await incr("visits")).json.value).toBe("2");
  });

  test("by is added and may be negative", async () => {
    await put("stock", { value: "10" });
    expect((await incr("stock", { by: 5 })).json.value).toBe("15");
    const r = await incr("stock", { by: -20 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ key: "stock", value: "-5", expiresAt: null });
    await put("padded", { value: "007" });
    expect((await incr("padded")).json.value).toBe("8");
  });

  test("the key keeps its expiry", async () => {
    const set = await put("timed", { value: "1", ttl: 60_000 });
    const r = await incr("timed");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ key: "timed", value: "2", expiresAt: set.json.expiresAt });
  });

  test("a value that is not an integer is a 409 and stays as it was", async () => {
    for (const value of ["abc", "1.5", "12abc", "", " 5", "+5"]) {
      await put("text", { value });
      const r = await incr("text");
      expect(r.status, JSON.stringify(value)).toBe(409);
      expect(r.json).toEqual({ error: "value is not an integer" });
      expect((await call(server(), "GET", "/keys/text")).json.value).toBe(value);
    }
  });

  test("a bad body or a by that is not an integer is a 400", async () => {
    await put("num", { value: "1" });
    for (const body of [{ by: 1.5 }, { by: "2" }]) {
      const r = await incr("num", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json).toEqual({ error: "by must be an integer" });
    }
    const bad = await incr("num", "[1]");
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: "invalid JSON body" });
    expect((await call(server(), "GET", "/keys/num")).json.value).toBe("1");
  });
});

describe("listing", () => {
  const server = serverPerSuite();

  test("GET /keys lists live keys in character-code order, with an optional prefix", async () => {
    for (const key of ["b", "a", "B", "a%3A2", "a%3A1", "z"]) {
      await call(server(), "PUT", `/keys/${key}`, { value: "1" });
    }
    await call(server(), "PUT", "/keys/a%3A3", { value: "1", ttl: 200 });
    await sleep(400);
    const all = await call(server(), "GET", "/keys");
    expect(all.status).toBe(200);
    expect(all.json).toEqual({ keys: ["B", "a", "a:1", "a:2", "b", "z"] });
    expect((await call(server(), "GET", "/keys?prefix=a%3A")).json).toEqual({ keys: ["a:1", "a:2"] });
    expect((await call(server(), "GET", "/keys?prefix=A")).json).toEqual({ keys: [] });
  });
});
