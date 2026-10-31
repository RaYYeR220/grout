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

const join = (token: string, eventId: string, tierId: string, quantity: number) =>
  a.req("POST", `/events/${eventId}/waitlist`, { tierId, quantity }, token);

describe("waitlist", () => {
  test("[R69] POST /events/:id/waitlist returns 201 {id,eventId,tierId,quantity,position}; unknown event 404", async () => {
    const org = await a.user("organizer");
    const x = await a.user("customer");
    const c = await a.user("customer");
    const ev = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 100, quantity: 2 }] });
    const tid = ev.tiers[0].id;
    expect((await a.order(x.token, ev.id, [{ tierId: tid, quantity: 2 }])).status).toBe(201);
    const r = await join(c.token, ev.id, tid, 1);
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(["eventId", "id", "position", "quantity", "tierId"]);
    expect(typeof r.body.id).toBe("string");
    expect(r.body).toMatchObject({ eventId: ev.id, tierId: tid, quantity: 1, position: 1 });
    expectError(await join(c.token, `unknown-${uniq()}`, tid, 1), 404);
  });

  test("[R71] join only when available < quantity; duplicate entry is 409", async () => {
    const org = await a.user("organizer");
    const x = await a.user("customer");
    const c = await a.user("customer");
    const ev = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 100, quantity: 5 }] });
    const tid = ev.tiers[0].id;
    expect((await a.order(x.token, ev.id, [{ tierId: tid, quantity: 3 }])).status).toBe(201);
    expect(await a.available(ev.id, tid)).toBe(2);
    expectError(await join(c.token, ev.id, tid, 2), 409);
    expectError(await join(c.token, ev.id, tid, 1), 409);
    const ok = await join(c.token, ev.id, tid, 3);
    expect(ok.status).toBe(201);
    expectError(await join(c.token, ev.id, tid, 4), 409);
  });

  test("[R73] [R75] head that doesn't fit blocks everyone behind it; then served in order", async () => {
    const org = await a.user("organizer");
    const x = await a.user("customer");
    const y = await a.user("customer");
    const A = await a.user("customer");
    const B = await a.user("customer");
    const ev = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 700, quantity: 4 }] });
    const tid = ev.tiers[0].id;
    const ox = await a.order(x.token, ev.id, [{ tierId: tid, quantity: 2 }]);
    const oy = await a.order(y.token, ev.id, [{ tierId: tid, quantity: 2 }]);
    expect(ox.status).toBe(201);
    expect(oy.status).toBe(201);
    const wa = await join(A.token, ev.id, tid, 3);
    const wb = await join(B.token, ev.id, tid, 1);
    expect(wa.status).toBe(201);
    expect(wb.status).toBe(201);
    expect(wa.body.position).toBe(1);
    expect(wb.body.position).toBe(2);

    expect((await a.req("POST", `/orders/${ox.body.id}/cancel`, undefined, x.token)).status).toBe(200);
    expect(await a.available(ev.id, tid)).toBe(2);
    const bOrders = await a.req("GET", "/me/orders", undefined, B.token);
    expect(bOrders.status).toBe(200);
    expect(bOrders.body).toEqual([]);
    const aOrders = await a.req("GET", "/me/orders", undefined, A.token);
    expect(aOrders.body).toEqual([]);
    const bw = await a.req("GET", "/me/waitlist", undefined, B.token);
    expect(bw.status).toBe(200);
    expect(bw.body).toHaveLength(1);
    expect(bw.body[0]).toMatchObject({ id: wb.body.id, eventId: ev.id, tierId: tid, quantity: 1, position: 2 });

    expect((await a.req("POST", `/orders/${oy.body.id}/cancel`, undefined, y.token)).status).toBe(200);
    expect(await a.available(ev.id, tid)).toBe(0);
    const ao = await a.req("GET", "/me/orders", undefined, A.token);
    expect(ao.body).toHaveLength(1);
    expect(ao.body[0]).toMatchObject({ eventId: ev.id, customerId: A.id, status: "held", discountCode: null, paidAt: null });
    expect(ao.body[0].items).toEqual([{ tierId: tid, quantity: 3, unitPriceCents: 700 }]);
    expect(ao.body[0].subtotalCents).toBe(2100);
    const bo = await a.req("GET", "/me/orders", undefined, B.token);
    expect(bo.body).toHaveLength(1);
    expect(bo.body[0].items).toEqual([{ tierId: tid, quantity: 1, unitPriceCents: 700 }]);
    expect(bo.body[0].status).toBe("held");
    expect((await a.req("GET", "/me/waitlist", undefined, A.token)).body).toEqual([]);
    expect((await a.req("GET", "/me/waitlist", undefined, B.token)).body).toEqual([]);
  });

  test("[R73] [R59] [R51] 3 freed for [A qty 2, B qty 1]: both get held orders with normal expiresAt", async () => {
    const org = await a.user("organizer");
    const x = await a.user("customer");
    const A = await a.user("customer");
    const B = await a.user("customer");
    const ev = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 500, quantity: 3 }] });
    const tid = ev.tiers[0].id;
    const ox = await a.order(x.token, ev.id, [{ tierId: tid, quantity: 3 }]);
    expect(ox.status).toBe(201);
    expect((await join(A.token, ev.id, tid, 2)).status).toBe(201);
    expect((await join(B.token, ev.id, tid, 1)).status).toBe(201);
    expect((await a.req("POST", `/orders/${ox.body.id}/cancel`, undefined, x.token)).status).toBe(200);
    const ao = await a.req("GET", "/me/orders", undefined, A.token);
    const bo = await a.req("GET", "/me/orders", undefined, B.token);
    expect(ao.body).toHaveLength(1);
    expect(bo.body).toHaveLength(1);
    for (const [o, q] of [[ao.body[0], 2], [bo.body[0], 1]] as const) {
      expect(o.status).toBe("held");
      expect(o.discountCode).toBeNull();
      expect(o.items).toEqual([{ tierId: tid, quantity: q, unitPriceCents: 500 }]);
      expect(Date.parse(o.expiresAt) - Date.parse(o.createdAt)).toBe(600_000);
    }
    expect(await a.available(ev.id, tid)).toBe(0);
  });

  test("[R75] GET /me/waitlist positions update as earlier entries leave", async () => {
    const org = await a.user("organizer");
    const x = await a.user("customer");
    const A = await a.user("customer");
    const B = await a.user("customer");
    const ev = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 500, quantity: 2 }] });
    const tid = ev.tiers[0].id;
    const ox = await a.order(x.token, ev.id, [{ tierId: tid, quantity: 2 }]);
    const wa = await join(A.token, ev.id, tid, 2);
    const wb = await join(B.token, ev.id, tid, 2);
    expect(wa.body.position).toBe(1);
    expect(wb.body.position).toBe(2);
    let bw = await a.req("GET", "/me/waitlist", undefined, B.token);
    expect(bw.status).toBe(200);
    expect(bw.body).toEqual([{ id: wb.body.id, eventId: ev.id, tierId: tid, quantity: 2, position: 2 }]);
    expect((await a.req("POST", `/orders/${ox.body.id}/cancel`, undefined, x.token)).status).toBe(200);
    bw = await a.req("GET", "/me/waitlist", undefined, B.token);
    expect(bw.body).toEqual([{ id: wb.body.id, eventId: ev.id, tierId: tid, quantity: 2, position: 1 }]);
    expect((await a.req("GET", "/me/waitlist", undefined, A.token)).body).toEqual([]);
  });

  test("[R9] ids are strings and unique across users, events, tiers, orders, waitlist entries", async () => {
    const org = await a.user("organizer");
    const c1 = await a.user("customer");
    const c2 = await a.user("customer");
    const ev1 = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 100, quantity: 1 }, { name: "VIP", priceCents: 200, quantity: 5 }] });
    const ev2 = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 100, quantity: 3 }] });
    const o1 = await a.order(c1.token, ev1.id, [{ tierId: ev1.tiers[0].id, quantity: 1 }]);
    const o2 = await a.order(c1.token, ev2.id, [{ tierId: ev2.tiers[0].id, quantity: 1 }]);
    const w = await join(c2.token, ev1.id, ev1.tiers[0].id, 1);
    expect(w.status).toBe(201);
    const ids = [
      org.id, c1.id, c2.id,
      ev1.id, ev2.id,
      ...ev1.tiers.map((t: any) => t.id), ...ev2.tiers.map((t: any) => t.id),
      o1.body.id, o2.body.id, w.body.id,
    ];
    for (const id of ids) expect(typeof id).toBe("string");
    expect(new Set(ids).size).toBe(ids.length);
  });
});
