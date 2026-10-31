import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { api, expectError, pause } from "./bo-helpers.js";

let server: Server;
const a = api(() => server.baseUrl);

beforeAll(async () => {
  server = await startServer({ env: { HOLD_SECONDS: "2" } });
});
afterAll(async () => {
  await server?.stop();
});

describe("HOLD_SECONDS=2", () => {
  test("[R2] [R51] expiresAt = createdAt + HOLD_SECONDS; order expires and tickets return", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token);
    const tid = ev.tiers[0].id;
    const o = await a.order(cust.token, ev.id, [{ tierId: tid, quantity: 3 }]);
    expect(o.status).toBe(201);
    expect(Date.parse(o.body.expiresAt) - Date.parse(o.body.createdAt)).toBe(2000);
    expect(await a.available(ev.id, tid)).toBe(7);
    await pause(3000);
    expect(await a.available(ev.id, tid)).toBe(10);
    const mine = await a.req("GET", "/me/orders", undefined, cust.token);
    expect(mine.body[0].id).toBe(o.body.id);
    expect(mine.body[0].status).toBe("expired");
    expectError(await a.req("POST", `/orders/${o.body.id}/pay`, undefined, cust.token), 409);
  });

  test("[R57] cancel on an expired order is 409", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token);
    const o = await a.order(cust.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 1 }]);
    expect(o.status).toBe(201);
    await pause(3000);
    expectError(await a.req("POST", `/orders/${o.body.id}/cancel`, undefined, cust.token), 409);
  });

  test("[R67] an expired order gives its discount use back", async () => {
    const org = await a.user("organizer");
    const c1 = await a.user("customer");
    const c2 = await a.user("customer");
    const ev = await a.event(org.token);
    const tid = ev.tiers[0].id;
    expect((await a.req("POST", `/events/${ev.id}/discounts`, { code: "ONCE", percentOff: 50, maxUses: 1 }, org.token)).status).toBe(201);
    expect((await a.order(c1.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONCE")).status).toBe(201);
    expectError(await a.order(c2.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONCE"), 422);
    await pause(3000);
    const o2 = await a.order(c2.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONCE");
    expect(o2.status).toBe(201);
    expect(o2.body.discountCode).toBe("ONCE");
  });

  test("[R73] an expired order serves the waitlist with a held order", async () => {
    const org = await a.user("organizer");
    const x = await a.user("customer");
    const w = await a.user("customer");
    const ev = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 300, quantity: 2 }] });
    const tid = ev.tiers[0].id;
    expect((await a.order(x.token, ev.id, [{ tierId: tid, quantity: 2 }])).status).toBe(201);
    expect((await a.req("POST", `/events/${ev.id}/waitlist`, { tierId: tid, quantity: 2 }, w.token)).status).toBe(201);
    await pause(2600);
    // trigger lazy evaluation
    await a.req("GET", `/events/${ev.id}`);
    const wo = await a.req("GET", "/me/orders", undefined, w.token);
    expect(wo.status).toBe(200);
    expect(wo.body.length).toBeGreaterThanOrEqual(1);
    const served = wo.body[wo.body.length - 1];
    expect(served.items).toEqual([{ tierId: tid, quantity: 2, unitPriceCents: 300 }]);
    expect(served.discountCode).toBeNull();
    expect(Date.parse(served.expiresAt) - Date.parse(served.createdAt)).toBe(2000);
    expect((await a.req("GET", "/me/waitlist", undefined, w.token)).body).toEqual([]);
  });
});
