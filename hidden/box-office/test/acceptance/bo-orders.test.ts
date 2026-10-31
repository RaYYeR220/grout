import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { api, expectError, uniq, pause } from "./bo-helpers.js";

let server: Server;
const a = api(() => server.baseUrl);

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.stop();
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function checkOrderShape(o: any) {
  expect(Object.keys(o).sort()).toEqual(
    ["id", "eventId", "customerId", "status", "items", "subtotalCents", "discountCode", "discountCents", "totalCents", "createdAt", "expiresAt", "paidAt"].sort(),
  );
  expect(typeof o.id).toBe("string");
  expect(typeof o.eventId).toBe("string");
  expect(typeof o.customerId).toBe("string");
  expect(["held", "paid", "expired", "cancelled", "refunded"]).toContain(o.status);
  for (const it of o.items) {
    expect(Object.keys(it).sort()).toEqual(["quantity", "tierId", "unitPriceCents"]);
    expect(typeof it.tierId).toBe("string");
    expect(Number.isInteger(it.quantity)).toBe(true);
    expect(Number.isInteger(it.unitPriceCents)).toBe(true);
  }
  for (const k of ["subtotalCents", "discountCents", "totalCents"]) expect(Number.isInteger(o[k])).toBe(true);
  expect(o.createdAt).toMatch(ISO_RE);
  expect(o.expiresAt).toMatch(ISO_RE);
}

describe("orders", () => {
  test("[R43] [R7] order shape, held status, null discountCode/paidAt, subtotal from tier prices", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token, {
      tiers: [
        { name: "GA", priceCents: 1250, quantity: 10 },
        { name: "VIP", priceCents: 4999, quantity: 10 },
      ],
    });
    const ga = ev.tiers.find((t: any) => t.name === "GA");
    const vip = ev.tiers.find((t: any) => t.name === "VIP");
    const r = await a.order(cust.token, ev.id, [
      { tierId: ga.id, quantity: 2 },
      { tierId: vip.id, quantity: 1 },
    ]);
    expect(r.status).toBe(201);
    checkOrderShape(r.body);
    expect(r.body.status).toBe("held");
    expect(r.body.eventId).toBe(ev.id);
    expect(r.body.customerId).toBe(cust.id);
    expect(r.body.discountCode).toBeNull();
    expect(r.body.paidAt).toBeNull();
    const items = [...r.body.items].sort((x: any, y: any) => x.unitPriceCents - y.unitPriceCents);
    expect(items).toEqual([
      { tierId: ga.id, quantity: 2, unitPriceCents: 1250 },
      { tierId: vip.id, quantity: 1, unitPriceCents: 4999 },
    ]);
    expect(r.body.subtotalCents).toBe(2 * 1250 + 4999);
    expect(r.body.discountCents).toBe(0);
    expect(r.body.totalCents).toBe(2 * 1250 + 4999);
  });

  test("[R2] [R51] default HOLD_SECONDS is 600: expiresAt = createdAt + 600s", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token);
    const before = Date.now();
    const r = await a.order(cust.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }]);
    const after = Date.now();
    expect(r.status).toBe(201);
    const created = Date.parse(r.body.createdAt);
    expect(created).toBeGreaterThanOrEqual(before - 1000);
    expect(created).toBeLessThanOrEqual(after + 1000);
    expect(Date.parse(r.body.expiresAt) - created).toBe(600_000);
  });

  test("[R45] invalid items are 400", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token);
    const tid = ev.tiers[0].id;
    expectError(await a.order(cust.token, ev.id, []), 400);
    expectError(await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 1 }, { tierId: tid, quantity: 1 }]), 400);
    expectError(await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 0 }]), 400);
    expectError(await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 1.5 }]), 400);
    expectError(await a.req("POST", "/orders", { eventId: ev.id }, cust.token), 400);
    expect(await a.available(ev.id, tid)).toBe(10);
  });

  test("[R47] ordering for a cancelled event is 409", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token);
    expect((await a.req("POST", `/events/${ev.id}/cancel`, undefined, org.token)).status).toBe(200);
    expectError(await a.order(cust.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }]), 409);
  });

  test("[R47] ordering for an event that has already started is 409", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token, { startsAt: new Date(Date.now() + 2500).toISOString() });
    await pause(3500);
    expectError(await a.order(cust.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }]), 409);
  });

  test("[R49] at most 6 tickets per customer per event (held + paid + new)", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 100, quantity: 50 }] });
    const tid = ev.tiers[0].id;
    expectError(await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 7 }]), 422);
    const o = await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 4 }]);
    expect(o.status).toBe(201);
    expect((await a.req("POST", `/orders/${o.body.id}/pay`, undefined, cust.token)).status).toBe(200);
    expectError(await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 3 }]), 422);
    const ok = await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 2 }]);
    expect(ok.status).toBe(201);
    // now 4 paid + 2 held = 6
    expectError(await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 1 }]), 422);
  });

  test("[R53] pay returns 200 with status paid and paidAt ISO time", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token);
    const o = await a.order(cust.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 2 }]);
    expect(o.status).toBe(201);
    const before = Date.now();
    const p = await a.req("POST", `/orders/${o.body.id}/pay`, undefined, cust.token);
    const after = Date.now();
    expect(p.status).toBe(200);
    checkOrderShape(p.body);
    expect(p.body.id).toBe(o.body.id);
    expect(p.body.status).toBe("paid");
    expect(p.body.paidAt).toMatch(ISO_RE);
    const t = Date.parse(p.body.paidAt);
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(after + 1000);
  });

  test("[R55] cancelling a held order returns 200 cancelled and releases tickets", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token);
    const tid = ev.tiers[0].id;
    const o = await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 3 }]);
    expect(o.status).toBe(201);
    expect(await a.available(ev.id, tid)).toBe(7);
    const c = await a.req("POST", `/orders/${o.body.id}/cancel`, undefined, cust.token);
    expect(c.status).toBe(200);
    expect(c.body.id).toBe(o.body.id);
    expect(c.body.status).toBe("cancelled");
    expect(await a.available(ev.id, tid)).toBe(10);
  });

  test("[R55] cancelling a held order gives its discount use back", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const cust2 = await a.user("customer");
    const ev = await a.event(org.token);
    const tid = ev.tiers[0].id;
    const d = await a.req("POST", `/events/${ev.id}/discounts`, { code: "ONCE1", percentOff: 10, maxUses: 1 }, org.token);
    expect(d.status).toBe(201);
    const o = await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONCE1");
    expect(o.status).toBe(201);
    expectError(await a.order(cust2.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONCE1"), 422);
    expect((await a.req("POST", `/orders/${o.body.id}/cancel`, undefined, cust.token)).status).toBe(200);
    const o2 = await a.order(cust2.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONCE1");
    expect(o2.status).toBe(201);
  });

  test("[R57] cancel on cancelled or refunded order is 409; other's or unknown order is 404", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const other = await a.user("customer");
    const ev = await a.event(org.token);
    const tid = ev.tiers[0].id;
    const o = await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 1 }]);
    expectError(await a.req("POST", `/orders/${o.body.id}/cancel`, undefined, other.token), 404);
    expectError(await a.req("POST", `/orders/unknown-${uniq()}/cancel`, undefined, cust.token), 404);
    expect((await a.req("POST", `/orders/${o.body.id}/cancel`, undefined, cust.token)).status).toBe(200);
    expectError(await a.req("POST", `/orders/${o.body.id}/cancel`, undefined, cust.token), 409);
    const p = await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 1 }]);
    expect((await a.req("POST", `/orders/${p.body.id}/pay`, undefined, cust.token)).status).toBe(200);
    const ref = await a.req("POST", `/orders/${p.body.id}/cancel`, undefined, cust.token);
    expect(ref.status).toBe(200);
    expect(ref.body.status).toBe("refunded");
    expectError(await a.req("POST", `/orders/${p.body.id}/cancel`, undefined, cust.token), 409);
  });

  test("[R59] GET /me/orders returns caller's orders newest first", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const other = await a.user("customer");
    const ev = await a.event(org.token);
    const tid = ev.tiers[0].id;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const o = await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 1 }]);
      expect(o.status).toBe(201);
      ids.push(o.body.id);
      await pause(20);
    }
    await a.order(other.token, ev.id, [{ tierId: tid, quantity: 1 }]);
    const r = await a.req("GET", "/me/orders", undefined, cust.token);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.map((o: any) => o.id)).toEqual([...ids].reverse());
    for (const o of r.body) {
      checkOrderShape(o);
      expect(o.customerId).toBe(cust.id);
    }
  });
});
