import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ISO_UTC_MS, call, startServer, type Server } from "../helpers.js";

const SERVER = ["node", "dist/server.js"];
const NOT_FOUND = { error: "not found" };

function serverPerSuite(): () => Server {
  let server: Server | undefined;
  beforeAll(async () => {
    server = await startServer(SERVER, { portEnv: "PORT" });
  });
  afterAll(async () => {
    await server?.stop();
  });
  return () => server!;
}

describe("creating links", () => {
  const server = serverPerSuite();
  const post = (body: unknown) => call(server(), "POST", "/links", body);

  test("a free custom code gives 201 with the link", async () => {
    const before = Date.now();
    const r = await post({ url: "https://example.com/docs?page=2", code: "docs" });
    expect(r.status).toBe(201);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.json).toEqual({ code: "docs", url: "https://example.com/docs?page=2", hits: 0, createdAt: expect.stringMatching(ISO_UTC_MS) });
    const created = Date.parse(r.json.createdAt);
    expect(created).toBeGreaterThanOrEqual(before - 1000);
    expect(created).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("without a code it makes up a random six-character code", async () => {
    const r = await post({ url: "https://example.com/a/very/long/path?x=1" });
    expect(r.status).toBe(201);
    expect(r.json.code).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(r.json).toMatchObject({ url: "https://example.com/a/very/long/path?x=1", hits: 0 });
  });

  test("the same url without a code returns the existing link with 200", async () => {
    const first = await post({ url: "https://example.com/again" });
    expect(first.status).toBe(201);
    const second = await post({ url: "https://example.com/again" });
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
  });

  test("without a code the oldest link for that url is returned, custom codes included", async () => {
    expect((await post({ url: "https://example.com/y", code: "first-y" })).status).toBe(201);
    expect((await post({ url: "https://example.com/y", code: "second-y" })).status).toBe(201);
    const r = await post({ url: "https://example.com/y" });
    expect(r.status).toBe(200);
    expect(r.json.code).toBe("first-y");
  });

  test("urls are compared as exact strings", async () => {
    const a = await post({ url: "https://exact.example" });
    const b = await post({ url: "https://exact.example/" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.code).not.toBe(a.json.code);
  });

  test("repeating a code with the same url is idempotent", async () => {
    const first = await post({ url: "https://example.com/same", code: "same1" });
    expect(first.status).toBe(201);
    const second = await post({ url: "https://example.com/same", code: "same1" });
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
  });

  test("a code taken by another url is a 409", async () => {
    expect((await post({ url: "https://example.com/one", code: "taken" })).status).toBe(201);
    const r = await post({ url: "https://example.com/two", code: "taken" });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "code already in use" });
  });

  test("codes of 4 and 32 characters with _ and - are accepted", async () => {
    const short = await post({ url: "https://example.com/s", code: "a_-1" });
    expect(short.status).toBe(201);
    const long = await post({ url: "https://example.com/l", code: "Z".repeat(32) });
    expect(long.status).toBe(201);
    expect(long.json.code).toBe("Z".repeat(32));
  });

  test("a body that is not a JSON object is a 400", async () => {
    for (const body of ["not json", "[1,2]", '"https://example.com"', "null"]) {
      const r = await post(body);
      expect(r.status, body).toBe(400);
      expect(r.json).toEqual({ error: "body must be a JSON object" });
    }
  });

  test("a url that is not an absolute http(s) URL is a 400", async () => {
    for (const body of [{ url: "ftp://example.com/file" }, { url: "example.com" }, { url: "/relative/path" }, { url: 42 }, {}, { url: "javascript:alert(1)" }]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json).toEqual({ error: "url must be an absolute http(s) URL" });
    }
  });

  test("an invalid code is a 400", async () => {
    for (const code of ["abc", "x".repeat(33), "has space", "dot.dot", "links", 1234, "ünï"]) {
      const r = await post({ url: "https://example.com/c", code });
      expect(r.status, String(code)).toBe(400);
      expect(r.json).toEqual({ error: "invalid code" });
    }
  });

  test("the url is checked before the code", async () => {
    const r = await post({ url: "nope", code: "x" });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "url must be an absolute http(s) URL" });
  });
});

describe("redirects, stats and deletion", () => {
  const server = serverPerSuite();
  const create = async (url: string, code: string) => {
    const r = await call(server(), "POST", "/links", { url, code });
    expect(r.status).toBe(201);
  };

  test("GET /:code redirects with 302 to the url", async () => {
    await create("https://example.com/landing?ref=a&b=2", "home");
    const r = await call(server(), "GET", "/home");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://example.com/landing?ref=a&b=2");
  });

  test("every redirect is a hit; reading the stats is not", async () => {
    await create("https://example.com/counted", "count");
    await call(server(), "GET", "/count");
    await call(server(), "GET", "/count");
    const stats = await call(server(), "GET", "/links/count");
    expect(stats.status).toBe(200);
    expect(stats.json).toEqual({ code: "count", url: "https://example.com/counted", hits: 2, createdAt: expect.stringMatching(ISO_UTC_MS) });
    const again = await call(server(), "GET", "/links/count");
    expect(again.json.hits).toBe(2);
  });

  test("unknown codes are 404 for redirects and stats", async () => {
    for (const path of ["/nope404", "/links/nope404"]) {
      const r = await call(server(), "GET", path);
      expect(r.status, path).toBe(404);
      expect(r.headers.get("content-type")).toMatch(/^application\/json/);
      expect(r.json).toEqual(NOT_FOUND);
    }
  });

  test("DELETE gives 204 and frees the code", async () => {
    await create("https://example.com/old", "gone");
    const del = await call(server(), "DELETE", "/links/gone");
    expect(del.status).toBe(204);
    expect(del.text).toBe("");
    expect((await call(server(), "GET", "/gone")).status).toBe(404);
    expect((await call(server(), "GET", "/links/gone")).status).toBe(404);
    const reuse = await call(server(), "POST", "/links", { url: "https://example.com/new", code: "gone" });
    expect(reuse.status).toBe(201);
    expect(reuse.json).toMatchObject({ code: "gone", url: "https://example.com/new", hits: 0 });
  });

  test("DELETE of an unknown code is a 404", async () => {
    const r = await call(server(), "DELETE", "/links/never-was");
    expect(r.status).toBe(404);
    expect(r.json).toEqual(NOT_FOUND);
  });

  test("other methods and paths are 404", async () => {
    const cases: [string, string][] = [
      ["GET", "/links"],
      ["GET", "/"],
      ["GET", "/a/b/c"],
      ["PUT", "/links/home"],
      ["POST", "/elsewhere"],
    ];
    for (const [method, path] of cases) {
      const r = await call(server(), method, path);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json).toEqual(NOT_FOUND);
    }
  });
});
