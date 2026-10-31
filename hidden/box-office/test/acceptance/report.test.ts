import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { makeApi } from "./helpers.js";

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

describe("report", () => {
  test("[R76] [R78] report shape and sold/held/available counts", async () => {
    const c1 = await makeUser("customer");
    const c2 = await makeUser("customer");
    const ev = await createEvent(org.token, {
      tiers: [
        { name: "A", priceCents: 1000, quantity: 10 },
        { name: "B", priceCents: 500, quantity: 5 },
      ],
    });
    const [a, b] = ev.tiers;
    const p = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId: a.id, quantity: 3 }, { tierId: b.id, quantity: 1 }] }, c1.token);
    expect(p.status).toBe(201);
    expect((await req("POST", `/orders/${p.body.id}/pay`, undefined, c1.token)).status).toBe(200);
    const h = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId: a.id, quantity: 2 }] }, c2.token);
    expect(h.status).toBe(201);

    const r = await req("GET", `/events/${ev.id}/report`, undefined, org.token);
    expect(r.status).toBe(200);
    expect(r.body.eventId).toBe(ev.id);
    expect(r.body.tiers).toHaveLength(2);
    const ra = r.body.tiers.find((t: any) => t.tierId === a.id);
    const rb = r.body.tiers.find((t: any) => t.tierId === b.id);
    expect(ra).toEqual({ tierId: a.id, name: "A", sold: 3, held: 2, available: 5 });
    expect(rb).toEqual({ tierId: b.id, name: "B", sold: 1, held: 0, available: 4 });
    expect(ra.available).toBe(await tierAvailable(ev.id, a.id));
    expect(r.body.grossCents).toBe(3500);
    expect(r.body.discountCents).toBe(0);
    expect(r.body.refundedCents).toBe(0);
    expect(r.body.netCents).toBe(3500);
  });

  test("[R76] unknown event gets 404", async () => {
    const r = await req("GET", `/events/no-such-event/report`, undefined, org.token);
    expect(r.status).toBe(404);
    expect(typeof r.body.error).toBe("string");
  });
});
