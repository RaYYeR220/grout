import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { api, expectError } from "./bo-helpers.js";

let server: Server;
const a = api(() => server.baseUrl);

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.stop();
});

describe("report", () => {
  test("[R77] only the event's organizer may see the report; others 403", async () => {
    const org = await a.user("organizer");
    const other = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token);
    expectError(await a.req("GET", `/events/${ev.id}/report`, undefined, other.token), 403);
    expectError(await a.req("GET", `/events/${ev.id}/report`, undefined, cust.token), 403);
    const ok = await a.req("GET", `/events/${ev.id}/report`, undefined, org.token);
    expect(ok.status).toBe(200);
    expect(ok.body.eventId).toBe(ev.id);
  });

  test("[R79] [R7] gross/discount/net over paid orders, refunded over refunded orders", async () => {
    const org = await a.user("organizer");
    const c1 = await a.user("customer");
    const c2 = await a.user("customer");
    const c3 = await a.user("customer");
    const ev = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 1999, quantity: 50 }] });
    const tid = ev.tiers[0].id;
    expect((await a.req("POST", `/events/${ev.id}/discounts`, { code: "PCT15", percentOff: 15 }, org.token)).status).toBe(201);
    expect((await a.req("POST", `/events/${ev.id}/discounts`, { code: "FLAT", amountOffCents: 500 }, org.token)).status).toBe(201);

    // paid with 15%: subtotal 3*1999=5997, discount floor(899.55)=899, total 5098
    const p1 = await a.order(c1.token, ev.id, [{ tierId: tid, quantity: 3 }], "PCT15");
    expect(p1.status).toBe(201);
    expect(p1.body.discountCents).toBe(899);
    expect(p1.body.totalCents).toBe(5098);
    expect((await a.req("POST", `/orders/${p1.body.id}/pay`, undefined, c1.token)).status).toBe(200);
    // paid without code: 2*1999=3998
    const p2 = await a.order(c2.token, ev.id, [{ tierId: tid, quantity: 2 }]);
    expect((await a.req("POST", `/orders/${p2.body.id}/pay`, undefined, c2.token)).status).toBe(200);
    // refunded with FLAT: 1999-500=1499
    const r1 = await a.order(c3.token, ev.id, [{ tierId: tid, quantity: 1 }], "FLAT");
    expect(r1.body.totalCents).toBe(1499);
    expect((await a.req("POST", `/orders/${r1.body.id}/pay`, undefined, c3.token)).status).toBe(200);
    const ref = await a.req("POST", `/orders/${r1.body.id}/cancel`, undefined, c3.token);
    expect(ref.body.status).toBe("refunded");
    // held order not counted
    expect((await a.order(c3.token, ev.id, [{ tierId: tid, quantity: 1 }])).status).toBe(201);

    const rep = await a.req("GET", `/events/${ev.id}/report`, undefined, org.token);
    expect(rep.status).toBe(200);
    expect(rep.body.grossCents).toBe(5997 + 3998);
    expect(rep.body.discountCents).toBe(899);
    expect(rep.body.netCents).toBe(5098 + 3998);
    expect(rep.body.refundedCents).toBe(1499);
    for (const k of ["grossCents", "discountCents", "netCents", "refundedCents"]) expect(Number.isInteger(rep.body[k])).toBe(true);
  });
});
