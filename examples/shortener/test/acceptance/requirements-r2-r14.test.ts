import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, tempDir } from "../harness.js";

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer({ cwd: tempDir() });
});

afterAll(async () => {
  await server.stop();
});

function post(body: unknown, raw?: string) {
  return fetch(server.baseUrl + "/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw !== undefined ? raw : JSON.stringify(body),
    redirect: "manual",
  });
}

function isIsoMs(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && new Date(s).toISOString() === s;
}

describe("R2 json shape", () => {
  test("[R2] a 404 for an unknown path is JSON with Content-Type application/json and error body", async () => {
    const res = await fetch(server.baseUrl + "/no/such/path/here/x");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("[R2] a 400 validation error is JSON with Content-Type application/json", async () => {
    const res = await post(null, "[1]");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: "body must be a JSON object" });
  });

  test("[R2] a successful create response is JSON with Content-Type application/json", async () => {
    const res = await post({ url: "https://r2.example/create", code: "r2create" });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const body = await res.json();
    expect(body.code).toBe("r2create");
  });

  test("[R2] a GET of an existing link is JSON with Content-Type application/json", async () => {
    await post({ url: "https://r2.example/get", code: "r2get1" });
    const res = await fetch(server.baseUrl + "/links/r2get1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toMatchObject({ code: "r2get1", url: "https://r2.example/get" });
  });

  test("[R2] a 404 from GET /links/:code is JSON error body with Content-Type application/json", async () => {
    const res = await fetch(server.baseUrl + "/links/r2missing");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("R4 body must be a JSON object", () => {
  test("[R4] body that is a JSON array gives 400 body must be a JSON object", async () => {
    const res = await post(null, "[1]");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be a JSON object" });
  });

  test("[R4] body that is JSON null gives 400 body must be a JSON object", async () => {
    const res = await post(null, "null");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be a JSON object" });
  });

  test("[R4] body that is a JSON string gives 400 body must be a JSON object", async () => {
    const res = await post(null, '"https://a.example"');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be a JSON object" });
  });

  test("[R4] body that is a JSON number gives 400 body must be a JSON object", async () => {
    const res = await post(null, "42");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be a JSON object" });
  });

  test("[R4] body that is invalid JSON gives 400 body must be a JSON object", async () => {
    const res = await post(null, "{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be a JSON object" });
  });

  test("[R4] non-object body is reported before an invalid url would be", async () => {
    const res = await post(null, '["not a url"]');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be a JSON object" });
  });

  test("[R4] non-object body is reported before an invalid code would be", async () => {
    const res = await post(null, '["https://r4.example/x","links"]');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be a JSON object" });
  });
});

describe("R6 code validation", () => {
  const invalid: Array<[string, unknown]> = [
    ["too short (3 chars)", "abc"],
    ["too long (33 chars)", "a".repeat(33)],
    ["contains a space", "ab cd"],
    ["contains a dot", "ab.cd"],
    ["contains a slash", "ab/cd"],
    ["reserved word links", "links"],
    ["not a string (number)", 12345],
  ];

  for (const [label, code] of invalid) {
    test(`[R6] code ${label} gives 400 invalid code`, async () => {
      const res = await post({ url: "https://r6.example/" + label.length, code });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid code" });
    });
  }

  test("[R6] code 'links' is rejected even with a valid url", async () => {
    const res = await post({ url: "https://a.example", code: "links" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid code" });
  });

  test("[R6] code is checked after url: an invalid url with a bad code gives the url error", async () => {
    const res = await post({ url: "ftp://r6.example/x", code: "ab" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "url must be an absolute http(s) URL" });
  });

  test("[R6] a 4-character code using A-Z a-z 0-9 _ - is accepted", async () => {
    const res = await post({ url: "https://r6.example/four", code: "A_z-" });
    expect(res.status).toBe(201);
    expect((await res.json()).code).toBe("A_z-");
  });

  test("[R6] a 32-character code is accepted", async () => {
    const code = "Ab0_-".repeat(7).slice(0, 32);
    expect(code.length).toBe(32);
    const res = await post({ url: "https://r6.example/thirtytwo", code });
    expect(res.status).toBe(201);
    expect((await res.json()).code).toBe(code);
  });

  test("[R6] a code that is 'Links' (different case) is accepted", async () => {
    const res = await post({ url: "https://r6.example/caps", code: "Links" });
    expect(res.status).toBe(201);
    expect((await res.json()).code).toBe("Links");
  });
});

describe("R8 existing code with same url", () => {
  test("[R8] posting an existing code with the same url gives 200 with the existing link", async () => {
    const first = await post({ url: "https://r8.example/a", code: "r8code" });
    expect(first.status).toBe(201);
    const original = await first.json();

    const again = await post({ url: "https://r8.example/a", code: "r8code" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(original);
  });

  test("[R8] the repeated post changes nothing (hits and createdAt kept)", async () => {
    await post({ url: "https://r8.example/b", code: "r8keep" });
    const get1 = await (await fetch(server.baseUrl + "/links/r8keep")).json();
    await post({ url: "https://r8.example/b", code: "r8keep" });
    const get2 = await (await fetch(server.baseUrl + "/links/r8keep")).json();
    expect(get2).toEqual(get1);
    expect(get2.hits).toBe(0);
  });
});

describe("R10 no code", () => {
  test("[R10] a new url without code gives 201 with a 6-char alphanumeric code", async () => {
    const res = await post({ url: "https://r10.example/new-one" });
    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link.url).toBe("https://r10.example/new-one");
    expect(link.hits).toBe(0);
    expect(link.code).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(isIsoMs(link.createdAt)).toBe(true);
  });

  test("[R10] posting the same url without code again gives 200 with the oldest such link", async () => {
    const first = await post({ url: "https://r10.example/dup" });
    expect(first.status).toBe(201);
    const created = await first.json();

    const second = await post({ url: "https://r10.example/dup" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(created);
  });

  test("[R10] a url differing only by trailing slash is a different url and gets a new link", async () => {
    await post({ url: "https://r10.example/slash" });
    const res = await post({ url: "https://r10.example/slash/" });
    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link.url).toBe("https://r10.example/slash/");
  });

  test("[R10] a no-code post for a url that exists under an explicit code returns that oldest link", async () => {
    const created = await (await post({ url: "https://r10.example/explicit", code: "r10expl" })).json();
    const res = await post({ url: "https://r10.example/explicit" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(created);
  });
});

describe("R12 GET /links/:code", () => {
  test("[R12] returns 200 with the link", async () => {
    await post({ url: "https://r12.example/x", code: "r12link" });
    const res = await fetch(server.baseUrl + "/links/r12link");
    expect(res.status).toBe(200);
    const link = await res.json();
    expect(link.code).toBe("r12link");
    expect(link.url).toBe("https://r12.example/x");
    expect(link.hits).toBe(0);
    expect(isIsoMs(link.createdAt)).toBe(true);
  });

  test("[R12] an unknown code gives 404 with error body not found", async () => {
    const res = await fetch(server.baseUrl + "/links/r12nothere");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("[R12] GET /links/:code is not a hit: hits stay at 0 across repeated reads", async () => {
    await post({ url: "https://r12.example/nohit", code: "r12nohit" });
    for (let i = 0; i < 3; i++) {
      await fetch(server.baseUrl + "/links/r12nohit");
    }
    const link = await (await fetch(server.baseUrl + "/links/r12nohit")).json();
    expect(link.hits).toBe(0);
  });
});

describe("R14 DELETE /links/:code", () => {
  test("[R14] deleting an existing link gives 204 with an empty body", async () => {
    await post({ url: "https://r14.example/del", code: "r14del1" });
    const res = await fetch(server.baseUrl + "/links/r14del1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("[R14] after deletion the link is gone", async () => {
    const res = await fetch(server.baseUrl + "/links/r14del1");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("[R14] the freed code can be used again for a different url", async () => {
    const res = await post({ url: "https://r14.example/reused", code: "r14del1" });
    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link.code).toBe("r14del1");
    expect(link.url).toBe("https://r14.example/reused");
    expect(link.hits).toBe(0);
  });

  test("[R14] deleting an unknown code gives 404 with error body not found", async () => {
    const res = await fetch(server.baseUrl + "/links/r14nothere", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
