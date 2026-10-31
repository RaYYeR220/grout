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

describe("discount codes", () => {
  test("[R61] only the event's organizer may create discount codes", async () => {
    const org = await a.user("organizer");
    const other = await a.user("organizer");
    const ev = await a.event(org.token);
    expectError(await a.req("POST", `/events/${ev.id}/discounts`, { code: "SAVE10", percentOff: 10 }, other.token), 403);
    const ok = await a.req("POST", `/events/${ev.id}/discounts`, { code: "SAVE10", percentOff: 10 }, org.token);
    expect(ok.status).toBe(201);
    expect(ok.body).toEqual({ code: "SAVE10", percentOff: 10, amountOffCents: null, maxUses: null, expiresAt: null, uses: 0 });
  });

  test("[R63] code must be 3-20 letters and digits", async () => {
    const org = await a.user("organizer");
    const ev = await a.event(org.token);
    for (const code of ["AB", "SAVE-10", "A".repeat(21), "SAVE 10", ""]) {
      expectError(await a.req("POST", `/events/${ev.id}/discounts`, { code, percentOff: 10 }, org.token), 400);
    }
    expect((await a.req("POST", `/events/${ev.id}/discounts`, { code: "AB1", percentOff: 10 }, org.token)).status).toBe(201);
    expect((await a.req("POST", `/events/${ev.id}/discounts`, { code: "Z".repeat(20), amountOffCents: 100 }, org.token)).status).toBe(201);
  });

  test("[R65] codes stored upper case, duplicate in any case is 409, matched case-insensitively", async () => {
    const org = await a.user("organizer");
    const cust = await a.user("customer");
    const ev = await a.event(org.token, { tiers: [{ name: "GA", priceCents: 1000, quantity: 10 }] });
    const c = await a.req("POST", `/events/${ev.id}/discounts`, { code: "save10", percentOff: 10 }, org.token);
    expect(c.status).toBe(201);
    expect(c.body.code).toBe("SAVE10");
    expectError(await a.req("POST", `/events/${ev.id}/discounts`, { code: "SAVE10", percentOff: 20 }, org.token), 409);
    expectError(await a.req("POST", `/events/${ev.id}/discounts`, { code: "Save10", amountOffCents: 5 }, org.token), 409);
    const o = await a.order(cust.token, ev.id, [{ tierId: ev.tiers[0].id, quantity: 2 }], "save10");
    expect(o.status).toBe(201);
    expect(o.body.discountCode).toBe("SAVE10");
    expect(o.body.subtotalCents).toBe(2000);
    expect(o.body.discountCents).toBe(200);
    expect(o.body.totalCents).toBe(1800);
  });

  test("[R67] maxUses 1: cancelled order gives use back so a new order can use the code", async () => {
    const org = await a.user("organizer");
    const c1 = await a.user("customer");
    const c2 = await a.user("customer");
    const ev = await a.event(org.token);
    const tid = ev.tiers[0].id;
    expect((await a.req("POST", `/events/${ev.id}/discounts`, { code: "ONE", amountOffCents: 300, maxUses: 1 }, org.token)).status).toBe(201);
    const o1 = await a.order(c1.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONE");
    expect(o1.status).toBe(201);
    expect(o1.body.discountCents).toBe(300);
    expectError(await a.order(c2.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONE"), 422);
    expect((await a.req("POST", `/orders/${o1.body.id}/cancel`, undefined, c1.token)).status).toBe(200);
    const o2 = await a.order(c2.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONE");
    expect(o2.status).toBe(201);
    expect(o2.body.discountCode).toBe("ONE");
    // paid orders also count as uses
    expect((await a.req("POST", `/orders/${o2.body.id}/pay`, undefined, c2.token)).status).toBe(200);
    expectError(await a.order(c1.token, ev.id, [{ tierId: tid, quantity: 1 }], "ONE"), 422);
  });
});
