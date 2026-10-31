import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { api, expectError, uniq } from "./bo-helpers.js";

let server: Server;
const a = api(() => server.baseUrl);

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.stop();
});

const body = (over: Record<string, unknown> = {}) => ({
  email: `a${uniq()}@b.co`,
  password: "password1",
  name: "Ann",
  role: "customer",
  ...over,
});

describe("accounts", () => {
  test("[R11] POST /users creates a user and returns 201 {id,email,name,role}", async () => {
    const email = `a${uniq()}@b.co`;
    const r = await a.req("POST", "/users", { email, password: "password1", name: "Ann", role: "customer" });
    expect(r.status).toBe(201);
    expect(typeof r.body.id).toBe("string");
    expect(r.body.email).toBe(email);
    expect(r.body.name).toBe("Ann");
    expect(r.body.role).toBe("customer");
    const r2 = await a.req("POST", "/users", { email: `o${uniq()}@b.co`, password: "password1", name: "Org", role: "organizer" });
    expect(r2.status).toBe(201);
    expect(r2.body.role).toBe("organizer");
  });

  test("[R13] email must contain @ with a . after it", async () => {
    expectError(await a.req("POST", "/users", body({ email: "ab.co" })), 400);
    expectError(await a.req("POST", "/users", body({ email: "a.b@co" })), 400);
    expectError(await a.req("POST", "/users", body({ email: 12345 })), 400);
    const ok = await a.req("POST", "/users", body({ email: `a${uniq()}@b.co` }));
    expect(ok.status).toBe(201);
  });

  test("[R15] name must be 1-100 characters", async () => {
    expectError(await a.req("POST", "/users", body({ name: "" })), 400);
    expectError(await a.req("POST", "/users", body({ name: "x".repeat(101) })), 400);
    const missing = body();
    delete (missing as any).name;
    expectError(await a.req("POST", "/users", missing), 400);
    expectError(await a.req("POST", "/users", body({ name: 42 })), 400);
    const ok = await a.req("POST", "/users", body({ name: "x".repeat(100) }));
    expect(ok.status).toBe(201);
    expect(ok.body.name).toBe("x".repeat(100));
  });

  test("[R17] password is never returned by POST /users, POST /sessions or GET /me", async () => {
    const b = body();
    const c = await a.req("POST", "/users", b);
    expect(c.status).toBe(201);
    expect(c.text).not.toContain("password1");
    expect(c.text.toLowerCase()).not.toContain("password");
    const s = await a.req("POST", "/sessions", { email: b.email, password: b.password });
    expect(s.status).toBe(200);
    expect(s.text).not.toContain("password1");
    expect(s.text.toLowerCase()).not.toContain("password");
    const me = await a.req("GET", "/me", undefined, s.body.token);
    expect(me.status).toBe(200);
    expect(me.text.toLowerCase()).not.toContain("password");
  });

  test("[R19] POST /sessions with unknown email or wrong password is 401", async () => {
    const b = body();
    expect((await a.req("POST", "/users", b)).status).toBe(201);
    expectError(await a.req("POST", "/sessions", { email: b.email, password: "wrongpass1" }), 401);
    expectError(await a.req("POST", "/sessions", { email: `nobody${uniq()}@b.co`, password: "password1" }), 401);
  });

  test("[R21] customer POST /events is 403, organizer POST /orders is 403", async () => {
    const cust = await a.user("customer");
    const org = await a.user("organizer");
    const ev = await a.req(
      "POST",
      "/events",
      { title: "T", venue: "V", startsAt: new Date(Date.now() + 30 * 86400000).toISOString(), tiers: [{ name: "GA", priceCents: 100, quantity: 5 }] },
      cust.token,
    );
    expectError(ev, 403);
    const real = await a.event(org.token);
    const o = await a.req("POST", "/orders", { eventId: real.id, items: [{ tierId: real.tiers[0].id, quantity: 1 }] }, org.token);
    expectError(o, 403);
  });

  test("[R5] errors have non-2xx status and JSON {error: string}", async () => {
    const r1 = await a.req("POST", "/users", body({ email: "bad" }));
    expectError(r1, 400);
    const r2 = await a.req("GET", "/me");
    expectError(r2, 401);
    const r3 = await a.req("GET", "/events/does-not-exist-" + uniq());
    expectError(r3, 404);
    const r4 = await a.req("POST", "/users", undefined, undefined, "{not json");
    expectError(r4, 400);
    const b = body();
    await a.req("POST", "/users", b);
    const r5 = await a.req("POST", "/users", { ...b, email: b.email.toUpperCase() });
    expectError(r5, 409);
  });
});
