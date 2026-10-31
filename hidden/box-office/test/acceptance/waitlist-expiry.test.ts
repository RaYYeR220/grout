import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type Server } from "../harness.js";
import { makeApi, sleep } from "./helpers.js";

let server: Server;
const { req, makeUser, createEvent, tierAvailable } = makeApi(() => server.baseUrl);
let org: { id: string; token: string };

beforeAll(async () => {
  server = await startServer({ env: { HOLD_SECONDS: "2" } });
  org = await makeUser("organizer");
}, 30000);
afterAll(async () => {
  await server?.stop();
});

describe("expiry", () => {
  test("[R52] held order past expiresAt is expired and tickets return", async () => {
    const c = await makeUser("customer");
    const ev = await createEvent(org.token, { tiers: [{ name: "A", priceCents: 100, quantity: 10 }] });
    const tierId = ev.tiers[0].id;
    const o = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId, quantity: 4 }] }, c.token);
    expect(o.status).toBe(201);
    expect(Date.parse(o.body.expiresAt) - Date.parse(o.body.createdAt)).toBe(2000);
    expect(await tierAvailable(ev.id, tierId)).toBe(6);
    await sleep(3000);
    const g = await req("GET", `/orders/${o.body.id}`, undefined, c.token);
    expect(g.status).toBe(200);
    expect(g.body.status).toBe("expired");
    expect(await tierAvailable(ev.id, tierId)).toBe(10);
    const mine = await req("GET", "/me/orders", undefined, c.token);
    expect(mine.body.find((x: any) => x.id === o.body.id).status).toBe("expired");
    // [R54] expired order cannot be paid
    expect((await req("POST", `/orders/${o.body.id}/pay`, undefined, c.token)).status).toBe(409);
  }, 15000);

  test("[R52] expiry triggers waitlist serving", async () => {
    const c1 = await makeUser("customer");
    const c2 = await makeUser("customer");
    const ev = await createEvent(org.token, { tiers: [{ name: "A", priceCents: 100, quantity: 3 }] });
    const tierId = ev.tiers[0].id;
    const o = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId, quantity: 3 }] }, c1.token);
    expect(o.status).toBe(201);
    const w = await req("POST", `/events/${ev.id}/waitlist`, { tierId, quantity: 2 }, c2.token);
    expect(w.status).toBe(201);
    await sleep(3000);
    // trigger any lazy computation
    await req("GET", `/events/${ev.id}`);
    const mine = await req("GET", "/me/orders", undefined, c2.token);
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBe(1);
    expect(mine.body[0].items[0].tierId).toBe(tierId);
    expect(mine.body[0].items[0].quantity).toBe(2);
    expect(["held", "expired"]).toContain(mine.body[0].status);
    const wl = await req("GET", "/me/waitlist", undefined, c2.token);
    expect(wl.body).toEqual([]);
  }, 15000);
});

describe("waitlist", () => {
  test("[R70] quantity 7 and 0 get 400", async () => {
    const c = await makeUser("customer");
    const ev = await createEvent(org.token, { tiers: [{ name: "A", priceCents: 100, quantity: 1 }] });
    const tierId = ev.tiers[0].id;
    expect((await req("POST", `/events/${ev.id}/waitlist`, { tierId, quantity: 7 }, c.token)).status).toBe(400);
    expect((await req("POST", `/events/${ev.id}/waitlist`, { tierId, quantity: 0 }, c.token)).status).toBe(400);
    expect((await req("POST", `/events/${ev.id}/waitlist`, { tierId, quantity: 1.5 }, c.token)).status).toBe(400);
    expect((await req("POST", `/events/${ev.id}/waitlist`, { tierId, quantity: 6 }, c.token)).status).toBe(201);
  });

  test("[R72] positions are 1-based per tier", async () => {
    const c1 = await makeUser("customer");
    const c2 = await makeUser("customer");
    const ev = await createEvent(org.token, {
      tiers: [
        { name: "A", priceCents: 100, quantity: 1 },
        { name: "B", priceCents: 100, quantity: 1 },
      ],
    });
    const [a, b] = ev.tiers;
    const w1 = await req("POST", `/events/${ev.id}/waitlist`, { tierId: a.id, quantity: 2 }, c1.token);
    expect(w1.status).toBe(201);
    expect(w1.body.position).toBe(1);
    expect(w1.body.eventId).toBe(ev.id);
    expect(w1.body.tierId).toBe(a.id);
    expect(w1.body.quantity).toBe(2);
    const w2 = await req("POST", `/events/${ev.id}/waitlist`, { tierId: a.id, quantity: 3 }, c2.token);
    expect(w2.body.position).toBe(2);
    const w3 = await req("POST", `/events/${ev.id}/waitlist`, { tierId: b.id, quantity: 2 }, c2.token);
    expect(w3.body.position).toBe(1);
    const l = await req("GET", "/me/waitlist", undefined, c2.token);
    const ea = l.body.find((e: any) => e.tierId === a.id);
    expect(ea.position).toBe(2);
  });

  test("[R74] entry exceeding 6 tickets is removed without order and serving continues", async () => {
    const holder = await makeUser("customer");
    const x = await makeUser("customer");
    const y = await makeUser("customer");
    const ev = await createEvent(org.token, {
      tiers: [
        { name: "A", priceCents: 100, quantity: 4 },
        { name: "B", priceCents: 100, quantity: 10 },
      ],
    });
    const [a, b] = ev.tiers;
    const xo = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId: b.id, quantity: 5 }] }, x.token);
    expect(xo.status).toBe(201);
    expect((await req("POST", `/orders/${xo.body.id}/pay`, undefined, x.token)).status).toBe(200);
    const ho = await req("POST", "/orders", { eventId: ev.id, items: [{ tierId: a.id, quantity: 4 }] }, holder.token);
    expect(ho.status).toBe(201);
    expect((await req("POST", `/orders/${ho.body.id}/pay`, undefined, holder.token)).status).toBe(200);
    expect((await req("POST", `/events/${ev.id}/waitlist`, { tierId: a.id, quantity: 2 }, x.token)).status).toBe(201);
    expect((await req("POST", `/events/${ev.id}/waitlist`, { tierId: a.id, quantity: 2 }, y.token)).status).toBe(201);
    const c = await req("POST", `/orders/${ho.body.id}/cancel`, undefined, holder.token);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("refunded");
    const xw = await req("GET", "/me/waitlist", undefined, x.token);
    expect(xw.body).toEqual([]);
    const xorders = await req("GET", "/me/orders", undefined, x.token);
    expect(xorders.body.length).toBe(1);
    const yorders = await req("GET", "/me/orders", undefined, y.token);
    expect(yorders.body.length).toBe(1);
    expect(yorders.body[0].status).toBe("held");
    expect(yorders.body[0].items[0].tierId).toBe(a.id);
    expect(yorders.body[0].items[0].quantity).toBe(2);
    expect(await tierAvailable(ev.id, a.id)).toBe(2);
  });
});
