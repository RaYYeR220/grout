import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { makeApi, inDays } from "./helpers.js";

let server: Server;
const api = makeApi(() => server.baseUrl);
const { req, makeUser, createEvent } = api;

beforeAll(async () => {
  server = await startServer();
}, 30000);
afterAll(async () => {
  await server?.stop();
});

let n = 0;
const email = () => `acc${Date.now()}_${n++}@example.com`;

describe("conventions", () => {
  test("[R1] server listens on the PORT environment variable", async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/events`);
    expect(r.status).toBe(200);
  });

  test("[R4] invalid JSON body gets 400 with error string, JSON response", async () => {
    const r = await req("POST", "/users", undefined, undefined, "not json");
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe("string");
    expect(r.contentType ?? "").toContain("application/json");
  });

  test("[R4] successful responses are application/json", async () => {
    const r = await req("POST", "/users", { email: email(), password: "password123", name: "A", role: "customer" });
    expect(r.status).toBe(201);
    expect(r.contentType ?? "").toContain("application/json");
  });

  test("[R6] unknown path gets 404 with error body", async () => {
    const r = await req("GET", "/nope");
    expect(r.status).toBe(404);
    expect(typeof r.body.error).toBe("string");
  });

  test("[R6] unknown method on known path gets 404", async () => {
    const r = await req("DELETE", "/users");
    expect(r.status).toBe(404);
    expect(typeof r.body.error).toBe("string");
  });
});

describe("accounts", () => {
  test("[R12] role admin gets 400", async () => {
    const r = await req("POST", "/users", { email: email(), password: "password123", name: "A", role: "admin" });
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe("string");
  });

  test("[R12] missing role gets 400", async () => {
    const r = await req("POST", "/users", { email: email(), password: "password123", name: "A" });
    expect(r.status).toBe(400);
  });

  test("[R12] organizer and customer roles are accepted", async () => {
    for (const role of ["organizer", "customer"]) {
      const e = email();
      const r = await req("POST", "/users", { email: e, password: "password123", name: "A", role });
      expect(r.status).toBe(201);
      expect(r.body.role).toBe(role);
      expect(typeof r.body.id).toBe("string");
      expect(r.body.email).toBe(e);
      expect(r.body.name).toBe("A");
      expect(r.body.password).toBeUndefined();
    }
  });

  test("[R14] password of 7 chars gets 400, 8 chars gets 201", async () => {
    const a = await req("POST", "/users", { email: email(), password: "1234567", name: "A", role: "customer" });
    expect(a.status).toBe(400);
    const b = await req("POST", "/users", { email: email(), password: "12345678", name: "A", role: "customer" });
    expect(b.status).toBe(201);
  });

  test("[R14] non-string password gets 400", async () => {
    const a = await req("POST", "/users", { email: email(), password: 123456789, name: "A", role: "customer" });
    expect(a.status).toBe(400);
  });

  test("[R16] duplicate email compared case-insensitively gets 409", async () => {
    const base = `dup${Date.now()}@b.co`;
    const a = await req("POST", "/users", { email: base, password: "password123", name: "A", role: "customer" });
    expect(a.status).toBe(201);
    const b = await req("POST", "/users", { email: base.toUpperCase(), password: "password123", name: "B", role: "customer" });
    expect(b.status).toBe(409);
    expect(typeof b.body.error).toBe("string");
  });

  test("[R18] POST /sessions returns 200 with a string token", async () => {
    const e = email();
    await req("POST", "/users", { email: e, password: "password123", name: "A", role: "customer" });
    const s = await req("POST", "/sessions", { email: e, password: "password123" });
    expect(s.status).toBe(200);
    expect(typeof s.body.token).toBe("string");
  });

  test("[R20] GET /me without Authorization gets 401", async () => {
    const r = await req("GET", "/me");
    expect(r.status).toBe(401);
    expect(typeof r.body.error).toBe("string");
  });

  test("[R20] GET /me with Bearer garbage gets 401", async () => {
    const r = await req("GET", "/me", undefined, "garbage");
    expect(r.status).toBe(401);
  });

  test("[R20] malformed Authorization header gets 401", async () => {
    const u = await makeUser("customer");
    const r = await fetch(server.baseUrl + "/me", { headers: { Authorization: `Token ${u.token}` } });
    expect(r.status).toBe(401);
  });

  test("[R22] GET /me returns the caller's user for any role", async () => {
    for (const role of ["organizer", "customer"] as const) {
      const u = await makeUser(role);
      const r = await req("GET", "/me", undefined, u.token);
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(u.id);
      expect(r.body.email).toBe(u.email);
      expect(r.body.role).toBe(role);
      expect(typeof r.body.name).toBe("string");
      expect(r.body.password).toBeUndefined();
    }
  });
});

describe("check order", () => {
  test("[R10] organizer token POST /orders with invalid body gets 403", async () => {
    const o = await makeUser("organizer");
    const r = await req("POST", "/orders", { items: [] }, o.token);
    expect(r.status).toBe(403);
  });

  test("[R10] no token POST /events with invalid body gets 401", async () => {
    const r = await req("POST", "/events", { title: "" });
    expect(r.status).toBe(401);
  });

  test("[R10] customer POST /events gets 403 even with invalid body", async () => {
    const c = await makeUser("customer");
    const r = await req("POST", "/events", { title: "" }, c.token);
    expect(r.status).toBe(403);
  });

  test("[R10] invalid input (400) beats unknown event (404)", async () => {
    const c = await makeUser("customer");
    const r = await req("POST", "/orders", { eventId: "does-not-exist", items: [] }, c.token);
    expect(r.status).toBe(400);
  });

  test("[R10] unknown event (404) beats ownership (403) on cancel", async () => {
    const o = await makeUser("organizer");
    const r = await req("POST", "/events/does-not-exist/cancel", undefined, o.token);
    expect(r.status).toBe(404);
  });

  test("[R10] ownership (403) beats state (409) on cancel", async () => {
    const o1 = await makeUser("organizer");
    const o2 = await makeUser("organizer");
    const ev = await createEvent(o1.token);
    expect((await req("POST", `/events/${ev.id}/cancel`, undefined, o1.token)).status).toBe(200);
    const r = await req("POST", `/events/${ev.id}/cancel`, undefined, o2.token);
    expect(r.status).toBe(403);
  });

  test("[R10] customer POST /orders for a cancelled event with 7 tickets gets 409", async () => {
    const o = await makeUser("organizer");
    const c = await makeUser("customer");
    const ev = await createEvent(o.token, { startsAt: inDays(10) });
    await req("POST", `/events/${ev.id}/cancel`, undefined, o.token);
    const r = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId: ev.tiers[0].id, quantity: 7 }] }, c.token);
    expect(r.status).toBe(409);
  });
});
