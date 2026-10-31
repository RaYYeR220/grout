import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { makeApi, inDays, ISO_RE } from "./helpers.js";

let server: Server;
const { req, makeUser, createEvent, tierAvailable } = makeApi(() => server.baseUrl);
let org: { id: string; token: string };
let cust: { id: string; token: string };

beforeAll(async () => {
  server = await startServer();
  org = await makeUser("organizer");
  cust = await makeUser("customer");
}, 30000);
afterAll(async () => {
  await server?.stop();
});

const tiers = [{ name: "GA", priceCents: 1000, quantity: 10 }];
const valid = (o: Record<string, unknown> = {}) => ({ title: "T", venue: "V", startsAt: inDays(30), tiers, ...o });

describe("times", () => {
  test("[R8] startsAt with offset is returned as UTC toISOString", async () => {
    const r = await req("POST", "/events", valid({ startsAt: "2099-11-02T19:00:00+01:00" }), org.token);
    expect(r.status).toBe(201);
    expect(r.body.startsAt).toBe("2099-11-02T18:00:00.000Z");
    const g = await req("GET", `/events/${r.body.id}`);
    expect(g.body.startsAt).toBe("2099-11-02T18:00:00.000Z");
  });

  test("[R8] other Date.parse-readable formats are accepted", async () => {
    const r = await req("POST", "/events", valid({ startsAt: "2099-11-02" }), org.token);
    expect(r.status).toBe(201);
    expect(r.body.startsAt).toBe(new Date(Date.parse("2099-11-02")).toISOString());
    expect(r.body.startsAt).toMatch(ISO_RE);
  });
});

describe("event validation", () => {
  test("[R26] empty title gets 400", async () => {
    const r = await req("POST", "/events", valid({ title: "" }), org.token);
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe("string");
  });
  test("[R26] venue of 101 chars gets 400, 100 chars ok", async () => {
    expect((await req("POST", "/events", valid({ venue: "v".repeat(101) }), org.token)).status).toBe(400);
    expect((await req("POST", "/events", valid({ venue: "v".repeat(100) }), org.token)).status).toBe(201);
  });
  test("[R26] title of 101 chars gets 400, non-string title gets 400, missing venue 400", async () => {
    expect((await req("POST", "/events", valid({ title: "t".repeat(101) }), org.token)).status).toBe(400);
    expect((await req("POST", "/events", valid({ title: 5 }), org.token)).status).toBe(400);
    const b: any = valid();
    delete b.venue;
    expect((await req("POST", "/events", b, org.token)).status).toBe(400);
  });
  test("[R28] tiers [] gets 400", async () => {
    expect((await req("POST", "/events", valid({ tiers: [] }), org.token)).status).toBe(400);
  });
  test("[R28] 6 tiers gets 400, 5 tiers ok", async () => {
    const mk = (k: number) => Array.from({ length: k }, (_, i) => ({ name: "T" + i, priceCents: 100, quantity: 1 }));
    expect((await req("POST", "/events", valid({ tiers: mk(6) }), org.token)).status).toBe(400);
    expect((await req("POST", "/events", valid({ tiers: mk(5) }), org.token)).status).toBe(201);
  });
  test("[R28] missing tiers gets 400", async () => {
    const b: any = valid();
    delete b.tiers;
    expect((await req("POST", "/events", b, org.token)).status).toBe(400);
  });
  test("[R30] priceCents -1, 10.5, and string get 400; 0 gets 201", async () => {
    for (const p of [-1, 10.5, "100"]) {
      const r = await req("POST", "/events", valid({ tiers: [{ name: "A", priceCents: p, quantity: 1 }] }), org.token);
      expect(r.status).toBe(400);
    }
    const ok = await req("POST", "/events", valid({ tiers: [{ name: "A", priceCents: 0, quantity: 1 }] }), org.token);
    expect(ok.status).toBe(201);
    expect(ok.body.tiers[0].priceCents).toBe(0);
  });
});

describe("listing", () => {
  test("[R32] GET /events is public and returns items/page/pageSize/total", async () => {
    await createEvent(org.token);
    const r = await req("GET", "/events");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(typeof r.body.page).toBe("number");
    expect(typeof r.body.pageSize).toBe("number");
    expect(typeof r.body.total).toBe("number");
    const e = r.body.items[0];
    expect(typeof e.id).toBe("string");
    expect(e.status).toBe("on_sale");
    expect(Array.isArray(e.tiers)).toBe(true);
  });

  test("[R36] defaults page 1 and pageSize 10", async () => {
    const r = await req("GET", "/events");
    expect(r.body.page).toBe(1);
    expect(r.body.pageSize).toBe(10);
  });

  test("[R34] from/to filter inclusive at both ends, either alone", async () => {
    const tag = "range" + Date.now();
    const t1 = "2098-01-10T10:00:00.000Z";
    const t2 = "2098-01-20T10:00:00.000Z";
    const t3 = "2098-01-30T10:00:00.000Z";
    const e1 = await createEvent(org.token, { title: tag + " a", startsAt: t1 });
    const e2 = await createEvent(org.token, { title: tag + " b", startsAt: t2 });
    const e3 = await createEvent(org.token, { title: tag + " c", startsAt: t3 });
    const q = (s: string) => req("GET", `/events?q=${tag}&${s}`);
    const ids = (r: any) => r.body.items.map((e: any) => e.id);
    let r = await q(`from=${encodeURIComponent(t1)}&to=${encodeURIComponent(t2)}`);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([e1.id, e2.id]);
    r = await q(`from=${encodeURIComponent(t2)}`);
    expect(ids(r)).toEqual([e2.id, e3.id]);
    r = await q(`to=${encodeURIComponent(t2)}`);
    expect(ids(r)).toEqual([e1.id, e2.id]);
    r = await q(`from=${encodeURIComponent(t3)}&to=${encodeURIComponent(t3)}`);
    expect(ids(r)).toEqual([e3.id]);
  });

  test("[R36] [R38] pagination slices sorted results; total counts all matches", async () => {
    const tag = "pg" + Date.now();
    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(await createEvent(org.token, { title: `${tag} ${i}`, startsAt: `2097-03-0${i + 1}T10:00:00.000Z` }));
    }
    const p1 = await req("GET", `/events?q=${tag}&page=1&pageSize=2`);
    expect(p1.status).toBe(200);
    expect(p1.body.page).toBe(1);
    expect(p1.body.pageSize).toBe(2);
    expect(p1.body.total).toBe(5);
    expect(p1.body.items.map((e: any) => e.id)).toEqual([created[0].id, created[1].id]);
    const p3 = await req("GET", `/events?q=${tag}&page=3&pageSize=2`);
    expect(p3.body.page).toBe(3);
    expect(p3.body.total).toBe(5);
    expect(p3.body.items.map((e: any) => e.id)).toEqual([created[4].id]);
    const all = await req("GET", `/events?q=${tag}`);
    expect(all.body.total).toBe(5);
    expect(all.body.items.length).toBe(5);
  });

  test("[R36] pageSize 50 ok, 51 gets 400", async () => {
    const ok = await req("GET", "/events?pageSize=50");
    expect(ok.status).toBe(200);
    expect(ok.body.pageSize).toBe(50);
    expect((await req("GET", "/events?pageSize=51")).status).toBe(400);
  });
});

describe("cancel event", () => {
  test("[R40] organizer cancels own event: 200 with status cancelled", async () => {
    const ev = await createEvent(org.token);
    const r = await req("POST", `/events/${ev.id}/cancel`, undefined, org.token);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(ev.id);
    expect(r.body.status).toBe("cancelled");
  });
  test("[R40] unknown event 404, customer 403", async () => {
    expect((await req("POST", `/events/nope-id/cancel`, undefined, org.token)).status).toBe(404);
    const ev = await createEvent(org.token);
    expect((await req("POST", `/events/${ev.id}/cancel`, undefined, cust.token)).status).toBe(403);
  });

  test("[R42] cancelling refunds paid, cancels held, empties waitlist", async () => {
    const ev = await createEvent(org.token, { tiers: [{ name: "Small", priceCents: 500, quantity: 3 }] });
    const tierId = ev.tiers[0].id;
    const c1 = await makeUser("customer");
    const c2 = await makeUser("customer");
    const c3 = await makeUser("customer");
    const paid = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId, quantity: 2 }] }, c1.token);
    expect(paid.status).toBe(201);
    expect((await req("POST", `/orders/${paid.body.id}/pay`, undefined, c1.token)).status).toBe(200);
    const held = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId, quantity: 1 }] }, c2.token);
    expect(held.status).toBe(201);
    const wl = await req("POST", `/events/${ev.id}/waitlist`, { tierId, quantity: 2 }, c3.token);
    expect(wl.status).toBe(201);
    expect((await req("GET", "/me/waitlist", undefined, c3.token)).body.length).toBe(1);

    expect((await req("POST", `/events/${ev.id}/cancel`, undefined, org.token)).status).toBe(200);
    expect((await req("GET", `/orders/${paid.body.id}`, undefined, c1.token)).body.status).toBe("refunded");
    expect((await req("GET", `/orders/${held.body.id}`, undefined, c2.token)).body.status).toBe("cancelled");
    const w = await req("GET", "/me/waitlist", undefined, c3.token);
    expect(w.status).toBe(200);
    expect(w.body).toEqual([]);
    // no order created for waitlisted customer
    const mo = await req("GET", "/me/orders", undefined, c3.token);
    expect(mo.body).toEqual([]);
  });
});

describe("availability", () => {
  test("[R24] available = quantity minus held and paid tickets", async () => {
    const ev = await createEvent(org.token, { tiers: [{ name: "A", priceCents: 100, quantity: 10 }] });
    const tierId = ev.tiers[0].id;
    expect(ev.tiers[0].available).toBe(10);
    const c1 = await makeUser("customer");
    const c2 = await makeUser("customer");
    const h = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId, quantity: 2 }] }, c1.token);
    expect(h.status).toBe(201);
    const p = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId, quantity: 3 }] }, c2.token);
    await req("POST", `/orders/${p.body.id}/pay`, undefined, c2.token);
    expect(await tierAvailable(ev.id, tierId)).toBe(5);
  });
});
