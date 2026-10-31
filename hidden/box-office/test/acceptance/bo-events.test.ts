import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { api, expectError, uniq, futureIso } from "./bo-helpers.js";

let server: Server;
const a = api(() => server.baseUrl);

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.stop();
});

function checkEventShape(e: any) {
  expect(Object.keys(e).sort()).toEqual(["id", "organizerId", "startsAt", "status", "tiers", "title", "venue"].sort());
  expect(typeof e.id).toBe("string");
  expect(typeof e.title).toBe("string");
  expect(typeof e.venue).toBe("string");
  expect(typeof e.startsAt).toBe("string");
  expect(["on_sale", "cancelled"]).toContain(e.status);
  expect(typeof e.organizerId).toBe("string");
  expect(Array.isArray(e.tiers)).toBe(true);
  for (const t of e.tiers) {
    expect(Object.keys(t).sort()).toEqual(["available", "id", "name", "priceCents", "quantity"].sort());
    expect(typeof t.id).toBe("string");
    expect(typeof t.name).toBe("string");
    expect(Number.isInteger(t.priceCents)).toBe(true);
    expect(Number.isInteger(t.quantity)).toBe(true);
    expect(Number.isInteger(t.available)).toBe(true);
  }
}

const evBody = (over: Record<string, unknown> = {}) => ({
  title: "Concert",
  venue: "Arena",
  startsAt: futureIso(),
  tiers: [{ name: "GA", priceCents: 2500, quantity: 100 }],
  ...over,
});

describe("events", () => {
  test("[R25] [R23] organizer POST /events returns 201 on_sale event with tier ids and available=quantity", async () => {
    const org = await a.user("organizer");
    const startsAt = "2099-11-02T18:00:00.000Z";
    const r = await a.req(
      "POST",
      "/events",
      {
        title: "Big Show",
        venue: "Arena",
        startsAt,
        tiers: [
          { name: "GA", priceCents: 2500, quantity: 100 },
          { name: "VIP", priceCents: 9900, quantity: 10 },
        ],
      },
      org.token,
    );
    expect(r.status).toBe(201);
    checkEventShape(r.body);
    expect(r.body.title).toBe("Big Show");
    expect(r.body.venue).toBe("Arena");
    expect(r.body.startsAt).toBe(startsAt);
    expect(r.body.status).toBe("on_sale");
    expect(r.body.organizerId).toBe(org.id);
    expect(r.body.tiers).toHaveLength(2);
    const ga = r.body.tiers.find((t: any) => t.name === "GA");
    const vip = r.body.tiers.find((t: any) => t.name === "VIP");
    expect(ga).toMatchObject({ name: "GA", priceCents: 2500, quantity: 100, available: 100 });
    expect(vip).toMatchObject({ name: "VIP", priceCents: 9900, quantity: 10, available: 10 });
    expect(ga.id).not.toBe(vip.id);
  });

  test("[R27] startsAt in the past or unparseable is 400", async () => {
    const org = await a.user("organizer");
    expectError(await a.req("POST", "/events", evBody({ startsAt: "2000-01-01T00:00:00Z" }), org.token), 400);
    expectError(await a.req("POST", "/events", evBody({ startsAt: "nope" }), org.token), 400);
    const ok = await a.req("POST", "/events", evBody({ startsAt: "2099-01-01T00:00:00Z" }), org.token);
    expect(ok.status).toBe(201);
    expect(ok.body.startsAt).toBe("2099-01-01T00:00:00.000Z");
  });

  test("[R29] repeated tier name is 400", async () => {
    const org = await a.user("organizer");
    const r = await a.req(
      "POST",
      "/events",
      evBody({ tiers: [{ name: "GA", priceCents: 100, quantity: 5 }, { name: "GA", priceCents: 200, quantity: 5 }] }),
      org.token,
    );
    expectError(r, 400);
  });

  test("[R31] tier quantity must be integer 1..10000", async () => {
    const org = await a.user("organizer");
    for (const q of [0, 10001, 1.5, -1]) {
      expectError(await a.req("POST", "/events", evBody({ tiers: [{ name: "GA", priceCents: 100, quantity: q }] }), org.token), 400);
    }
    const ok = await a.req("POST", "/events", evBody({ tiers: [{ name: "GA", priceCents: 100, quantity: 10000 }] }), org.token);
    expect(ok.status).toBe(201);
    expect(ok.body.tiers[0].available).toBe(10000);
    const ok1 = await a.req("POST", "/events", evBody({ tiers: [{ name: "GA", priceCents: 100, quantity: 1 }] }), org.token);
    expect(ok1.status).toBe(201);
  });

  test("[R33] GET /events lists only on_sale events sorted by startsAt then title", async () => {
    const org = await a.user("organizer");
    const tag = "srt" + uniq();
    const t1 = "2099-03-01T10:00:00.000Z";
    const t2 = "2099-02-01T10:00:00.000Z";
    const e1 = await a.event(org.token, { title: `B ${tag}`, startsAt: t1 });
    const e2 = await a.event(org.token, { title: `A ${tag}`, startsAt: t1 });
    const e3 = await a.event(org.token, { title: `Z ${tag}`, startsAt: t2 });
    const e4 = await a.event(org.token, { title: `C ${tag}`, startsAt: t2 });
    const cancelled = await a.event(org.token, { title: `AA ${tag}`, startsAt: t2 });
    expect((await a.req("POST", `/events/${cancelled.id}/cancel`, undefined, org.token)).status).toBe(200);
    const r = await a.req("GET", `/events?q=${tag}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((e: any) => e.id)).toEqual([e4.id, e3.id, e2.id, e1.id]);
    expect(r.body.total).toBe(4);
    for (const e of r.body.items) expect(e.status).toBe("on_sale");
  });

  test("[R35] q filters by case-insensitive substring of title or venue", async () => {
    const org = await a.user("organizer");
    const tag = "qq" + uniq();
    const byTitle = await a.event(org.token, { title: `Jazz ${tag.toUpperCase()} Night`, venue: "Club" });
    const byVenue = await a.event(org.token, { title: "Rock", venue: `The ${tag} Room` });
    await a.event(org.token, { title: "Other", venue: "Elsewhere" });
    const r = await a.req("GET", `/events?q=${encodeURIComponent(tag.toLowerCase())}`);
    expect(r.status).toBe(200);
    const ids = r.body.items.map((e: any) => e.id).sort();
    expect(ids).toEqual([byTitle.id, byVenue.id].sort());
    const r2 = await a.req("GET", `/events?q=${encodeURIComponent(tag.toUpperCase())}`);
    expect(r2.body.items.map((e: any) => e.id).sort()).toEqual([byTitle.id, byVenue.id].sort());
  });

  test("[R37] invalid GET /events query values are 400", async () => {
    expectError(await a.req("GET", "/events?pageSize=51"), 400);
    expectError(await a.req("GET", "/events?pageSize=0"), 400);
    expectError(await a.req("GET", "/events?page=0"), 400);
    expectError(await a.req("GET", "/events?page=abc"), 400);
    expectError(await a.req("GET", "/events?from=garbage"), 400);
    expectError(await a.req("GET", "/events?to=garbage"), 400);
    expect((await a.req("GET", "/events?pageSize=50")).status).toBe(200);
  });

  test("[R39] GET /events/:id returns event incl. cancelled; unknown is 404", async () => {
    const org = await a.user("organizer");
    const ev = await a.event(org.token);
    const r = await a.req("GET", `/events/${ev.id}`);
    expect(r.status).toBe(200);
    checkEventShape(r.body);
    expect(r.body).toEqual(ev);
    expect((await a.req("POST", `/events/${ev.id}/cancel`, undefined, org.token)).status).toBe(200);
    const r2 = await a.req("GET", `/events/${ev.id}`);
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe("cancelled");
    expectError(await a.req("GET", `/events/unknown-${uniq()}`), 404);
  });

  test("[R41] only creating organizer may cancel (403); already cancelled is 409", async () => {
    const org = await a.user("organizer");
    const other = await a.user("organizer");
    const ev = await a.event(org.token);
    expectError(await a.req("POST", `/events/${ev.id}/cancel`, undefined, other.token), 403);
    const ok = await a.req("POST", `/events/${ev.id}/cancel`, undefined, org.token);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("cancelled");
    expect(ok.body.id).toBe(ev.id);
    expectError(await a.req("POST", `/events/${ev.id}/cancel`, undefined, org.token), 409);
  });

  test("[R23] event status is on_sale or cancelled in list and detail", async () => {
    const org = await a.user("organizer");
    const tag = "shp" + uniq();
    await a.event(org.token, { title: tag });
    const r = await a.req("GET", `/events?q=${tag}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    checkEventShape(r.body.items[0]);
  });
});
