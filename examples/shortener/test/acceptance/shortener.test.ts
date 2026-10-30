import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { ROOT, runCli, startServer, tempDir, type Server } from "../harness.js";

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function postLink(server: Server, body: unknown): Promise<Response> {
  return fetch(server.baseUrl + "/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
}

describe("[R1] port and in-memory state", () => {
  test("[R1] listens on the port given in PORT", async () => {
    const server = await startServer({ env: {} });
    try {
      const res = await fetch(server.baseUrl + "/links/nothing-here");
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("[R1] without PORT the server listens on 3000 by default", async () => {
    const env = { ...process.env } as Record<string, string>;
    delete env.PORT;
    const child: ChildProcess = spawn(process.execPath, ["dist/server.js"], {
      cwd: ROOT,
      env,
      stdio: "ignore",
    });
    try {
      let ok = false;
      const deadline = Date.now() + 10_000;
      while (!ok && Date.now() < deadline) {
        try {
          const res = await fetch("http://127.0.0.1:3000/links/nothing-here");
          ok = res.status === 404;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(ok).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("[R1] a fresh server has no links (state is in memory, starts empty)", async () => {
    const server = await startServer();
    try {
      const res = await fetch(server.baseUrl + "/links/docs");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    } finally {
      await server.stop();
    }
  });
});

describe("shortener API", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  test("[R3] created link has exactly code, url, hits, createdAt with the right types", async () => {
    const res = await postLink(server, { url: "https://example.com/r3", code: "r3code" });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    const link = await res.json();
    expect(Object.keys(link).sort()).toEqual(["code", "createdAt", "hits", "url"]);
    expect(link.code).toBe("r3code");
    expect(link.url).toBe("https://example.com/r3");
    expect(link.hits).toBe(0);
    expect(typeof link.createdAt).toBe("string");
    expect(link.createdAt).toMatch(ISO_MS);
    expect(new Date(link.createdAt).toISOString()).toBe(link.createdAt);
  });

  test("[R3] spec example: POST /links returns the link with hits 0 and ISO createdAt", async () => {
    const res = await postLink(server, { url: "https://example.com/docs?page=2", code: "r3docs" });
    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link.code).toBe("r3docs");
    expect(link.url).toBe("https://example.com/docs?page=2");
    expect(link.hits).toBe(0);
    expect(link.createdAt).toMatch(ISO_MS);
  });

  test("[R5] url that is not a string gives 400 url error", async () => {
    const res = await postLink(server, { url: 42 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "url must be an absolute http(s) URL" });
  });

  test("[R5] ftp url gives 400 url error (spec example)", async () => {
    const res = await postLink(server, { url: "ftp://x.example" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "url must be an absolute http(s) URL" });
  });

  test("[R5] relative url gives 400 url error", async () => {
    const res = await postLink(server, { url: "/just/a/path" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "url must be an absolute http(s) URL" });
  });

  test("[R5] missing url gives 400 url error", async () => {
    const res = await postLink(server, { code: "r5nourl" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "url must be an absolute http(s) URL" });
  });

  test("[R5] url check runs before code check (bad url and bad code gives url error)", async () => {
    const res = await postLink(server, { url: "ftp://x.example", code: "a" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "url must be an absolute http(s) URL" });
  });

  test("[R7] unused code creates the link with 201 and hits 0", async () => {
    const res = await postLink(server, { url: "https://r7.example/a", code: "r7-code" });
    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link).toMatchObject({ code: "r7-code", url: "https://r7.example/a", hits: 0 });
  });

  test("[R9] existing code with a different url gives 409 code in use", async () => {
    const first = await postLink(server, { url: "https://r9.example/one", code: "r9-code" });
    expect(first.status).toBe(201);
    const res = await postLink(server, { url: "https://r9.example/two", code: "r9-code" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "code already in use" });
  });

  test("[R11] https://a.example and https://a.example/ are different urls", async () => {
    const a = await postLink(server, { url: "https://a-r11.example", code: "r11-aaaa" });
    expect(a.status).toBe(201);
    const aj = await a.json();
    expect(aj.url).toBe("https://a-r11.example");

    const b = await postLink(server, { url: "https://a-r11.example/", code: "r11-bbbb" });
    expect(b.status).toBe(201);
    const bj = await b.json();
    expect(bj.url).toBe("https://a-r11.example/");
    expect(bj.code).toBe("r11-bbbb");
  });

  test("[R11] the same code with the url differing only by trailing slash is a conflict", async () => {
    const a = await postLink(server, { url: "https://a-r11c.example", code: "r11-cccc" });
    expect(a.status).toBe(201);
    const b = await postLink(server, { url: "https://a-r11c.example/", code: "r11-cccc" });
    expect(b.status).toBe(409);
    expect(await b.json()).toEqual({ error: "code already in use" });
  });

  test("[R13] GET /:code gives 302 with Location equal to the url and increments hits", async () => {
    const created = await postLink(server, { url: "https://r13.example/docs?page=2", code: "r13-docs" });
    expect(created.status).toBe(201);

    const redirect = await fetch(server.baseUrl + "/r13-docs", { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://r13.example/docs?page=2");

    const link = await (await fetch(server.baseUrl + "/links/r13-docs")).json();
    expect(link.hits).toBe(1);

    await fetch(server.baseUrl + "/r13-docs", { redirect: "manual" });
    const link2 = await (await fetch(server.baseUrl + "/links/r13-docs")).json();
    expect(link2.hits).toBe(2);
  });

  test("[R13] unknown code gives 404 not found", async () => {
    const res = await fetch(server.baseUrl + "/r13-nosuchcode", { redirect: "manual" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("[R15] GET /links gives 404 not found", async () => {
    const res = await fetch(server.baseUrl + "/links");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("[R15] PUT /links/x gives 404 not found", async () => {
    const res = await fetch(server.baseUrl + "/links/x", { method: "PUT", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("[R15] POST /x gives 404 not found", async () => {
    const res = await fetch(server.baseUrl + "/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("[R15] nested path gives 404 not found", async () => {
    const res = await fetch(server.baseUrl + "/a/b/c");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
