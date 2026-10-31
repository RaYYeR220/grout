import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { makeApi, inDays, inHours, ISO_RE, sleep } from "./helpers.js";

let server: Server;
const { req, makeUser, createEvent, tierAvailable } = makeApi(() => server.baseUrl);
let org: { id: string; token: string };

beforeAll(async () => {
  server = await startServer();
  org = await makeUser("organizer");
}, 30000);
afterAll(async () => {
  await server?.stop();
});

const order = (token: string, eventId: string, items: any[], discountCode?: string) =>
  req("POST", "/orders", discountCode === undefined ? { eventId, items } : { eventId, items, discountCode }, token);

describe("orders", () => {
  test("[R44] customer creates held order; tickets stop counting as available", async () => {
    const c = await makeUser("customer");
    const ev = await createEvent(org.token, { tiers: [{ name: "A", priceCents: 250, quantity: 10 }] });
    const tierId = ev.tiers[0].id;
    const r = await order(c.token, ev.id, [{ tierId, quantity: 3 }]);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("held");
    expect(r.body.customerId).toBe(c.id);
    expect(r.body.eventId).toBe(ev.id);
    expect(typeof r.body.id).toBe("string");
    expect(r.body.createdAt).toMatch(ISO_RE);
    expect(r.body.expiresAt).toMatch(ISO_RE);
    expect(r.body.paidAt).toBeNull();
    expect(r.body.discountCode).toBeNull();
    expect(await tierAvailable(ev.id, tierId)).toBe(7);
  });

  test("[R46] unknown eventId 404; tier from another event 400", async () => {
    const c = await makeUser("customer");
    const ev1 = await createEvent(org.token);
    const ev2 = await createEvent(org.token);
    expect((await order(c.token, "no-such-event", [{ tierId: ev1.tiers[0].id, quantity: 1 }])).status).toBe(404);
    expect((await order(c.token, ev1.id, [{ tierId: ev2.tiers[0].id, quantity: 1 }])).status).toBe(400);
  });

  test("[R48] not enough in one tier: 409 and nothing held", async () => {
    const c0 = await makeUser("customer");
    const c = await makeUser("customer");
    const ev = await createEvent(org.token, {
      tiers: [
        { name: "A", priceCents: 100, quantity: 5 },
        { name: "B", priceCents: 100, quantity: 2 },
      ],
    });
    const [a, b] = ev.tiers;
    expect((await order(c0.token, ev.id, [{ tierId: b.id, quantity: 1 }])).status).toBe(201);
    const r = await order(c.token, ev.id, [
      { tierId: a.id, quantity: 2 },
      { tierId: b.id, quantity: 2 },
    ]);
    expect(r.status).toBe(409);
    expect(await tierAvailable(ev.id, a.id)).toBe(5);
    expect(await tierAvailable(ev.id, b.id)).toBe(1);
  });

  test("[R54] pay: other customer's order 404, unknown 404, not held 409", async () => {
    const c1 = await makeUser("customer");
    const c2 = await makeUser("customer");
    const ev = await createEvent(org.token);
    const o = await order(c1.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }]);
    expect((await req("POST", `/orders/${o.body.id}/pay`, undefined, c2.token)).status).toBe(404);
    expect((await req("POST", `/orders/no-such-order/pay`, undefined, c1.token)).status).toBe(404);
    const p = await req("POST", `/orders/${o.body.id}/pay`, undefined, c1.token);
    expect(p.status).toBe(200);
    expect(p.body.status).toBe("paid");
    expect(p.body.paidAt).toMatch(ISO_RE);
    expect((await req("POST", `/orders/${o.body.id}/pay`, undefined, c1.token)).status).toBe(409);
    const o2 = await order(c1.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }]);
    await req("POST", `/orders/${o2.body.id}/cancel`, undefined, c1.token);
    expect((await req("POST", `/orders/${o2.body.id}/pay`, undefined, c1.token)).status).toBe(409);
  });

  test("[R56] paid order cancel >24h before start gives refunded", async () => {
    const c = await makeUser("customer");
    const ev = await createEvent(org.token, { startsAt: inHours(48) });
    const o = await order(c.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }]);
    await req("POST", `/orders/${o.body.id}/pay`, undefined, c.token);
    const r = await req("POST", `/orders/${o.body.id}/cancel`, undefined, c.token);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("refunded");
  });

  test("[R56] paid order cancel within 24h of start gives 409", async () => {
    const c = await makeUser("customer");
    const ev = await createEvent(org.token, { startsAt: inHours(12) });
    const o = await order(c.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }]);
    await req("POST", `/orders/${o.body.id}/pay`, undefined, c.token);
    const r = await req("POST", `/orders/${o.body.id}/cancel`, undefined, c.token);
    expect(r.status).toBe(409);
    expect((await req("GET", `/orders/${o.body.id}`, undefined, c.token)).body.status).toBe("paid");
  });

  test("[R58] GET /orders/:id visible to owner and event organizer only", async () => {
    const c1 = await makeUser("customer");
    const c2 = await makeUser("customer");
    const org2 = await makeUser("organizer");
    const ev = await createEvent(org.token);
    const o = await order(c1.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }]);
    const a = await req("GET", `/orders/${o.body.id}`, undefined, c1.token);
    expect(a.status).toBe(200);
    expect(a.body.id).toBe(o.body.id);
    const b = await req("GET", `/orders/${o.body.id}`, undefined, org.token);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(o.body.id);
    expect((await req("GET", `/orders/${o.body.id}`, undefined, c2.token)).status).toBe(404);
    expect((await req("GET", `/orders/${o.body.id}`, undefined, org2.token)).status).toBe(404);
    expect((await req("GET", `/orders/no-such-order`, undefined, c1.token)).status).toBe(404);
  });
});

describe("discounts", () => {
  test("[R60] create discount with defaults null, code upper case", async () => {
    const ev = await createEvent(org.token);
    const r = await req("POST", `/events/${ev.id}/discounts`, { code: "save10", percentOff: 10 }, org.token);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ code: "SAVE10", percentOff: 10, amountOffCents: null, maxUses: null, expiresAt: null, uses: 0 });
  });

  test("[R60] [R8] expiresAt is returned as ISO string; unknown event 404", async () => {
    const ev = await createEvent(org.token);
    const r = await req(
      "POST",
      `/events/${ev.id}/discounts`,
      { code: "LATER5", amountOffCents: 500, maxUses: 3, expiresAt: "2099-11-02T19:00:00+01:00" },
      org.token,
    );
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ code: "LATER5", percentOff: null, amountOffCents: 500, maxUses: 3, expiresAt: "2099-11-02T18:00:00.000Z", uses: 0 });
    expect((await req("POST", `/events/no-such/discounts`, { code: "ABC", percentOff: 5 }, org.token)).status).toBe(404);
  });

  test("[R62] exactly one of percentOff/amountOffCents in range", async () => {
    const ev = await createEvent(org.token);
    const bad = [
      { code: "AAA1", percentOff: 10, amountOffCents: 100 },
      { code: "AAA2" },
      { code: "AAA3", percentOff: 101 },
      { code: "AAA4", percentOff: 0 },
      { code: "AAA5", percentOff: 10.5 },
      { code: "AAA6", amountOffCents: 0 },
    ];
    for (const b of bad) {
      expect((await req("POST", `/events/${ev.id}/discounts`, b, org.token)).status).toBe(400);
    }
    expect((await req("POST", `/events/${ev.id}/discounts`, { code: "OK100", percentOff: 100 }, org.token)).status).toBe(201);
    expect((await req("POST", `/events/${ev.id}/discounts`, { code: "OK1", amountOffCents: 1 }, org.token)).status).toBe(201);
  });

  test("[R64] maxUses 0 or non-integer gets 400; unparseable expiresAt gets 400", async () => {
    const ev = await createEvent(org.token);
    expect((await req("POST", `/events/${ev.id}/discounts`, { code: "MU0", percentOff: 5, maxUses: 0 }, org.token)).status).toBe(400);
    expect((await req("POST", `/events/${ev.id}/discounts`, { code: "MU1", percentOff: 5, maxUses: 1.5 }, org.token)).status).toBe(400);
    expect((await req("POST", `/events/${ev.id}/discounts`, { code: "EXP1", percentOff: 5, expiresAt: "not a date" }, org.token)).status).toBe(400);
    expect((await req("POST", `/events/${ev.id}/discounts`, { code: "MU2", percentOff: 5, maxUses: 1 }, org.token)).status).toBe(201);
  });

  test("[R50] [R66] maxUses reached gives 422", async () => {
    const c1 = await makeUser("customer");
    const c2 = await makeUser("customer");
    const ev = await createEvent(org.token);
    await req("POST", `/events/${ev.id}/discounts`, { code: "ONCE", percentOff: 10, maxUses: 1 }, org.token);
    const tierId = ev.tiers[0].id;
    const a = await order(c1.token, ev.id, [{ tierId, quantity: 1 }], "once");
    expect(a.status).toBe(201);
    expect(a.body.discountCode).toBe("ONCE");
    const b = await order(c2.token, ev.id, [{ tierId, quantity: 1 }], "ONCE");
    expect(b.status).toBe(422);
    expect(await tierAvailable(ev.id, tierId)).toBe(99);
  });

  test("[R50] [R66] code of another event or unknown code gives 422", async () => {
    const c = await makeUser("customer");
    const ev1 = await createEvent(org.token);
    const ev2 = await createEvent(org.token);
    await req("POST", `/events/${ev2.id}/discounts`, { code: "OTHER", percentOff: 10 }, org.token);
    expect((await order(c.token, ev1.id, [{ tierId: ev1.tiers[0].id, quantity: 1 }], "OTHER")).status).toBe(422);
    expect((await order(c.token, ev1.id, [{ tierId: ev1.tiers[0].id, quantity: 1 }], "NOPE123")).status).toBe(422);
  });

  test("[R66] expired code gives 422", async () => {
    const c = await makeUser("customer");
    const ev = await createEvent(org.token);
    const d = await req(
      "POST",
      `/events/${ev.id}/discounts`,
      { code: "SOON", percentOff: 10, expiresAt: new Date(Date.now() + 1000).toISOString() },
      org.token,
    );
    expect(d.status).toBe(201);
    await sleep(1500);
    expect((await order(c.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }], "SOON")).status).toBe(422);
  });

  test("[R68] percent discount floors; amount discount capped at subtotal; none = 0", async () => {
    const c = await makeUser("customer");
    const ev = await createEvent(org.token, {
      tiers: [
        { name: "P", priceCents: 333, quantity: 10 },
        { name: "Q", priceCents: 500, quantity: 10 },
      ],
    });
    const [p, q] = ev.tiers;
    await req("POST", `/events/${ev.id}/discounts`, { code: "TEN", percentOff: 10 }, org.token);
    await req("POST", `/events/${ev.id}/discounts`, { code: "BIG", amountOffCents: 1000 }, org.token);
    const a = await order(c.token, ev.id, [{ tierId: p.id, quantity: 3 }], "TEN");
    expect(a.status).toBe(201);
    expect(a.body.subtotalCents).toBe(999);
    expect(a.body.discountCents).toBe(99);
    expect(a.body.totalCents).toBe(900);
    expect(a.body.items).toEqual([{ tierId: p.id, quantity: 3, unitPriceCents: 333 }]);
    const b = await order(c.token, ev.id, [{ tierId: q.id, quantity: 1 }], "BIG");
    expect(b.status).toBe(201);
    expect(b.body.subtotalCents).toBe(500);
    expect(b.body.discountCents).toBe(500);
    expect(b.body.totalCents).toBe(0);
    const c2 = await makeUser("customer");
    const n = await order(c2.token, ev.id, [{ tierId: q.id, quantity: 2 }]);
    expect(n.body.subtotalCents).toBe(1000);
    expect(n.body.discountCents).toBe(0);
    expect(n.body.totalCents).toBe(1000);
    expect(n.body.discountCode).toBeNull();
  });
});
