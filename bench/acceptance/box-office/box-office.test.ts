// Box Office API: black-box HTTP acceptance tests, written from specs-hidden/box-office.md only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ISO_UTC_MS, call, sleep, startServer, type Reply, type Server } from "../helpers.js";

const START = ["npm", "start"];
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** One server per describe block, with its own HOLD_SECONDS so state and timing never leak. */
function serverPerSuite(holdSeconds: number): () => Server {
  let server: Server | undefined;
  beforeAll(async () => {
    server = await startServer(START, { portEnv: "PORT", env: { HOLD_SECONDS: String(holdSeconds) } });
  });
  afterAll(async () => {
    await server?.stop();
  });
  return () => server!;
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}x${(seq++).toString(36)}`;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const inDays = (d: number) => at(d * DAY);

type Actor = { user: any; token: string; h: Record<string, string>; email: string; password: string };
type Role = "organizer" | "customer";

function expectError(r: Reply, status: number): void {
  expect({ status: r.status, body: r.json }).toEqual({ status, body: { error: expect.any(String) } });
}

async function signUp(s: Server, role: Role): Promise<Actor> {
  const email = `${role}-${uniq()}@example.com`;
  const password = "correct horse";
  const r = await call(s, "POST", "/users", { email, password, name: `A ${role}`, role });
  expect(r.status).toBe(201);
  const login = await call(s, "POST", "/sessions", { email, password });
  expect(login.status).toBe(200);
  return { user: r.json, token: login.json.token, h: { authorization: `Bearer ${login.json.token}` }, email, password };
}

type TierIn = { name: string; priceCents: number; quantity: number };

async function newEvent(s: Server, org: Actor, over: Record<string, unknown> = {}): Promise<any> {
  const body = { title: `Show ${uniq()}`, venue: "Main Hall", startsAt: inDays(30), tiers: [{ name: "GA", priceCents: 2500, quantity: 100 }], ...over };
  const r = await call(s, "POST", "/events", body, org.h);
  expect(r.status, r.text).toBe(201);
  return r.json;
}

const tierOf = (ev: any, name: string): any => ev.tiers.find((t: any) => t.name === name);

function placeOrder(s: Server, who: Actor, eventId: string, items: { tierId: string; quantity: number }[], discountCode?: string): Promise<Reply> {
  const body: Record<string, unknown> = { eventId, items };
  if (discountCode !== undefined) body.discountCode = discountCode;
  return call(s, "POST", "/orders", body, who.h);
}

async function held(s: Server, who: Actor, eventId: string, items: { tierId: string; quantity: number }[], discountCode?: string): Promise<any> {
  const r = await placeOrder(s, who, eventId, items, discountCode);
  expect(r.status, r.text).toBe(201);
  return r.json;
}

async function paid(s: Server, who: Actor, eventId: string, items: { tierId: string; quantity: number }[], discountCode?: string): Promise<any> {
  const o = await held(s, who, eventId, items, discountCode);
  const r = await call(s, "POST", `/orders/${o.id}/pay`, undefined, who.h);
  expect(r.status, r.text).toBe(200);
  return r.json;
}

async function available(s: Server, eventId: string, tierName: string): Promise<number> {
  const r = await call(s, "GET", `/events/${eventId}`);
  expect(r.status).toBe(200);
  return tierOf(r.json, tierName).available;
}

async function getOrder(s: Server, who: Actor, id: string): Promise<any> {
  const r = await call(s, "GET", `/orders/${id}`, undefined, who.h);
  expect(r.status, r.text).toBe(200);
  return r.json;
}

async function myOrders(s: Server, who: Actor): Promise<any[]> {
  const r = await call(s, "GET", "/me/orders", undefined, who.h);
  expect(r.status, r.text).toBe(200);
  expect(Array.isArray(r.json)).toBe(true);
  return r.json;
}

async function myWaitlist(s: Server, who: Actor): Promise<any[]> {
  const r = await call(s, "GET", "/me/waitlist", undefined, who.h);
  expect(r.status, r.text).toBe(200);
  expect(Array.isArray(r.json)).toBe(true);
  return r.json;
}

function joinWaitlist(s: Server, who: Actor, eventId: string, tierId: string, quantity: number): Promise<Reply> {
  return call(s, "POST", `/events/${eventId}/waitlist`, { tierId, quantity }, who.h);
}

// ---------------------------------------------------------------------------------------------

describe("conventions", () => {
  const server = serverPerSuite(600);

  test("an unknown route is 404 with an error body", async () => {
    expectError(await call(server(), "GET", "/no/such/route"), 404);
    expectError(await call(server(), "POST", "/nothing-here", {}), 404);
  });

  test("a body that is not valid JSON is 400", async () => {
    expectError(await call(server(), "POST", "/users", "{not json"), 400);
    expectError(await call(server(), "POST", "/sessions", "{\"email\":"), 400);
    const org = await signUp(server(), "organizer");
    expectError(await call(server(), "POST", "/events", "{bad", org.h), 400);
  });

  test("ids are strings, unique across the whole API", async () => {
    const s = server();
    const org = await signUp(s, "organizer");
    const cust = await signUp(s, "customer");
    const ev = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 100, quantity: 2 }, { name: "B", priceCents: 200, quantity: 5 }] });
    const o = await held(s, cust, ev.id, [{ tierId: tierOf(ev, "A").id, quantity: 2 }]);
    const waiter = await signUp(s, "customer");
    const w = await joinWaitlist(s, waiter, ev.id, tierOf(ev, "A").id, 1);
    expect(w.status).toBe(201);
    const ids = [org.user.id, cust.user.id, waiter.user.id, ev.id, ...ev.tiers.map((t: any) => t.id), o.id, w.json.id];
    for (const id of ids) expect(typeof id).toBe("string");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("accounts", () => {
  const server = serverPerSuite(600);

  test("POST /users gives 201 with the user and no password", async () => {
    const r = await call(server(), "POST", "/users", { email: "ada@example.com", password: "12345678", name: "Ada", role: "organizer" });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ id: expect.any(String), email: "ada@example.com", name: "Ada", role: "organizer" });
    expect(r.text).not.toContain("12345678");
  });

  test("boundary values are accepted: 8-character password, 100-character name, customer role", async () => {
    const r = await call(server(), "POST", "/users", { email: "b@c.d", password: "abcdefgh", name: "n".repeat(100), role: "customer" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ email: "b@c.d", name: "n".repeat(100), role: "customer" });
  });

  test("invalid fields are 400", async () => {
    const ok = { email: "valid@example.com", password: "longenough", name: "Val", role: "customer" };
    const bad: unknown[] = [
      { ...ok, role: "admin" },
      { ...ok, role: undefined },
      { ...ok, email: "no-at-sign.example.com" },
      { ...ok, email: "dot.before@at" },
      { ...ok, email: 42 },
      { ...ok, password: "1234567" },
      { ...ok, password: undefined },
      { ...ok, name: "" },
      { ...ok, name: "n".repeat(101) },
      { ...ok, name: undefined },
      {},
      [],
    ];
    for (const body of bad) {
      const r = await call(server(), "POST", "/users", body);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
      expect(r.json).toEqual({ error: expect.any(String) });
    }
    // none of them was registered
    expect((await call(server(), "POST", "/users", ok)).status).toBe(201);
  });

  test("an email already registered, in any case, is 409", async () => {
    const first = await call(server(), "POST", "/users", { email: "dup@example.com", password: "password1", name: "One", role: "customer" });
    expect(first.status).toBe(201);
    expectError(await call(server(), "POST", "/users", { email: "DUP@Example.COM", password: "password2", name: "Two", role: "organizer" }), 409);
  });

  test("POST /sessions gives a token; wrong email or password is 401", async () => {
    await call(server(), "POST", "/users", { email: "login@example.com", password: "s3cretpass", name: "Lo", role: "customer" });
    const ok = await call(server(), "POST", "/sessions", { email: "login@example.com", password: "s3cretpass" });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ token: expect.any(String) });
    expect(ok.json.token.length).toBeGreaterThan(0);
    expectError(await call(server(), "POST", "/sessions", { email: "login@example.com", password: "wrongpass" }), 401);
    expectError(await call(server(), "POST", "/sessions", { email: "nobody@example.com", password: "s3cretpass" }), 401);
  });

  test("GET /me returns the caller without a password", async () => {
    const reg = await call(server(), "POST", "/users", { email: "me@example.com", password: "mypassword", name: "Me", role: "customer" });
    const login = await call(server(), "POST", "/sessions", { email: "me@example.com", password: "mypassword" });
    const r = await call(server(), "GET", "/me", undefined, { authorization: `Bearer ${login.json.token}` });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(reg.json);
    expect(r.text).not.toContain("mypassword");
  });

  test("GET /me without a valid token is 401", async () => {
    expectError(await call(server(), "GET", "/me"), 401);
    expectError(await call(server(), "GET", "/me", undefined, { authorization: "Bearer not-a-real-token" }), 401);
    expectError(await call(server(), "GET", "/me", undefined, { authorization: "Basic abc" }), 401);
  });
});

describe("creating and reading events", () => {
  const server = serverPerSuite(600);
  let org: Actor;
  let cust: Actor;
  beforeAll(async () => {
    org = await signUp(server(), "organizer");
    cust = await signUp(server(), "customer");
  });
  const valid = () => ({ title: "Night Market", venue: "Pier 9", startsAt: inDays(10), tiers: [{ name: "GA", priceCents: 1500, quantity: 50 }] });

  test("POST /events gives 201 with the event on sale, times in toISOString form", async () => {
    const startsAt = new Date(Math.floor((Date.now() + 40 * DAY) / 1000) * 1000);
    const r = await call(
      server(),
      "POST",
      "/events",
      { title: "Gala", venue: "Opera House", startsAt: startsAt.toUTCString(), tiers: [{ name: "Stalls", priceCents: 4500, quantity: 120 }, { name: "Balcony", priceCents: 0, quantity: 10000 }] },
      org.h,
    );
    expect(r.status).toBe(201);
    expect(r.json).toEqual({
      id: expect.any(String),
      title: "Gala",
      venue: "Opera House",
      startsAt: startsAt.toISOString(),
      status: "on_sale",
      organizerId: org.user.id,
      tiers: expect.any(Array),
    });
    expect(r.json.startsAt).toMatch(ISO_UTC_MS);
    expect(r.json.tiers).toHaveLength(2);
    expect(tierOf(r.json, "Stalls")).toEqual({ id: expect.any(String), name: "Stalls", priceCents: 4500, quantity: 120, available: 120 });
    expect(tierOf(r.json, "Balcony")).toEqual({ id: expect.any(String), name: "Balcony", priceCents: 0, quantity: 10000, available: 10000 });
  });

  test("a startsAt with an offset is stored in UTC", async () => {
    const r = await call(server(), "POST", "/events", { ...valid(), startsAt: "2030-03-01T19:00:00+01:00" }, org.h);
    expect(r.status).toBe(201);
    expect(r.json.startsAt).toBe("2030-03-01T18:00:00.000Z");
  });

  test("boundaries are accepted: 100-character title and venue, 5 tiers", async () => {
    const tiers = [1, 2, 3, 4, 5].map((i) => ({ name: `T${i}`, priceCents: i, quantity: 1 }));
    const r = await call(server(), "POST", "/events", { ...valid(), title: "t".repeat(100), venue: "v".repeat(100), tiers }, org.h);
    expect(r.status).toBe(201);
    expect(r.json.tiers).toHaveLength(5);
  });

  test("invalid events are 400", async () => {
    const base = valid();
    const tier = base.tiers[0];
    const bad: Record<string, unknown>[] = [
      { ...base, title: "" },
      { ...base, title: "t".repeat(101) },
      { ...base, title: undefined },
      { ...base, venue: "" },
      { ...base, venue: "v".repeat(101) },
      { ...base, startsAt: at(-HOUR) },
      { ...base, startsAt: "not a date" },
      { ...base, startsAt: undefined },
      { ...base, tiers: [] },
      { ...base, tiers: undefined },
      { ...base, tiers: [1, 2, 3, 4, 5, 6].map((i) => ({ name: `T${i}`, priceCents: 1, quantity: 1 })) },
      { ...base, tiers: [tier, { ...tier }] },
      { ...base, tiers: [{ ...tier, priceCents: -1 }] },
      { ...base, tiers: [{ ...tier, priceCents: 9.5 }] },
      { ...base, tiers: [{ ...tier, priceCents: "100" }] },
      { ...base, tiers: [{ ...tier, quantity: 0 }] },
      { ...base, tiers: [{ ...tier, quantity: 10001 }] },
      { ...base, tiers: [{ ...tier, quantity: 2.5 }] },
    ];
    for (const body of bad) {
      const r = await call(server(), "POST", "/events", body, org.h);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
      expect(r.json).toEqual({ error: expect.any(String) });
    }
  });

  test("only organizers create events: no token is 401, a customer is 403", async () => {
    expectError(await call(server(), "POST", "/events", valid()), 401);
    expectError(await call(server(), "POST", "/events", valid(), cust.h), 403);
  });

  test("GET /events/:id is public, shows cancelled events, and 404s unknown ids", async () => {
    const ev = await newEvent(server(), org);
    const r = await call(server(), "GET", `/events/${ev.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual(ev);
    const cancelled = await call(server(), "POST", `/events/${ev.id}/cancel`, undefined, org.h);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toEqual({ ...ev, status: "cancelled" });
    const again = await call(server(), "GET", `/events/${ev.id}`);
    expect(again.status).toBe(200);
    expect(again.json.status).toBe("cancelled");
    expectError(await call(server(), "GET", "/events/no-such-event"), 404);
  });

  test("cancelling: only the creating organizer (403), not twice (409), unknown is 404", async () => {
    const ev = await newEvent(server(), org);
    const other = await signUp(server(), "organizer");
    expectError(await call(server(), "POST", `/events/${ev.id}/cancel`), 401);
    expectError(await call(server(), "POST", `/events/${ev.id}/cancel`, undefined, cust.h), 403);
    expectError(await call(server(), "POST", `/events/${ev.id}/cancel`, undefined, other.h), 403);
    expect((await call(server(), "GET", `/events/${ev.id}`)).json.status).toBe("on_sale");
    expect((await call(server(), "POST", `/events/${ev.id}/cancel`, undefined, org.h)).status).toBe(200);
    expectError(await call(server(), "POST", `/events/${ev.id}/cancel`, undefined, org.h), 409);
    // permission is checked before state
    expectError(await call(server(), "POST", `/events/${ev.id}/cancel`, undefined, other.h), 403);
    expectError(await call(server(), "POST", "/events/no-such-event/cancel", undefined, org.h), 404);
  });

  test("cancelling refunds paid orders, cancels held ones and empties the waitlist", async () => {
    const s = server();
    const ev = await newEvent(s, org, { tiers: [{ name: "Pit", priceCents: 3000, quantity: 3 }] });
    const pit = tierOf(ev, "Pit").id;
    const c1 = await signUp(s, "customer");
    const c2 = await signUp(s, "customer");
    const c3 = await signUp(s, "customer");
    const p = await paid(s, c1, ev.id, [{ tierId: pit, quantity: 2 }]);
    const h = await held(s, c2, ev.id, [{ tierId: pit, quantity: 1 }]);
    expect((await joinWaitlist(s, c3, ev.id, pit, 1)).status).toBe(201);

    const r = await call(s, "POST", `/events/${ev.id}/cancel`, undefined, org.h);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("cancelled");
    expect((await getOrder(s, c1, p.id)).status).toBe("refunded");
    expect((await getOrder(s, c2, h.id)).status).toBe("cancelled");
    expect(await myWaitlist(s, c3)).toEqual([]);
    expect((await myOrders(s, c3)).filter((o) => o.status === "held")).toEqual([]);
    expectError(await call(s, "POST", `/orders/${h.id}/pay`, undefined, c2.h), 409);
    // a cancelled event takes no more orders
    expectError(await placeOrder(s, c3, ev.id, [{ tierId: pit, quantity: 1 }]), 409);
  });
});

describe("listing events", () => {
  const server = serverPerSuite(600);
  const base = Math.floor((Date.now() + 30 * DAY) / 1000) * 1000;
  const day = (n: number) => new Date(base + n * DAY).toISOString();
  const titlesOf = (r: Reply) => r.json.items.map((e: any) => e.title);
  const list = (query = "") => call(server(), "GET", `/events${query}`);

  beforeAll(async () => {
    const s = server();
    const org = await signUp(s, "organizer");
    const seeds: [string, string, number][] = [
      ["Echo Rock", "Harbor Hall", 5],
      ["Bravo Jazz", "Old Mill", 3],
      ["Zulu Night", "Harbor Hall", 1],
      ["Alpha Jazz", "Old Mill", 3],
    ];
    for (let i = 4; i <= 11; i++) seeds.push([`Show ${String(i).padStart(2, "0")}`, "Depot", i + 2]);
    for (const [title, venue, n] of seeds) await newEvent(s, org, { title, venue, startsAt: day(n) });
    const gone = await newEvent(s, org, { title: "Cancelled Gig", venue: "Harbor Hall", startsAt: day(2) });
    expect((await call(s, "POST", `/events/${gone.id}/cancel`, undefined, org.h)).status).toBe(200);
  });

  test("defaults to page 1 of 10, total counts every match", async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["items", "page", "pageSize", "total"]);
    expect(r.json).toMatchObject({ page: 1, pageSize: 10, total: 12 });
    expect(r.json.items).toHaveLength(10);
  });

  test("only events on sale, sorted by startsAt then title", async () => {
    const r = await list("?pageSize=50");
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(12);
    expect(titlesOf(r)).toEqual([
      "Zulu Night",
      "Alpha Jazz",
      "Bravo Jazz",
      "Echo Rock",
      ...[4, 5, 6, 7, 8, 9, 10, 11].map((i) => `Show ${String(i).padStart(2, "0")}`),
    ]);
  });

  test("items are full events", async () => {
    const r = await list("?pageSize=1");
    const ev = r.json.items[0];
    const one = await call(server(), "GET", `/events/${ev.id}`);
    expect(ev).toEqual(one.json);
    expect(ev.tiers[0]).toMatchObject({ name: "GA", priceCents: 2500, quantity: 100, available: 100 });
  });

  test("page and pageSize pick a slice", async () => {
    const p2 = await list("?page=2");
    expect(p2.status).toBe(200);
    expect(p2.json).toMatchObject({ page: 2, pageSize: 10, total: 12 });
    expect(titlesOf(p2)).toEqual(["Show 10", "Show 11"]);
    const p3 = await list("?page=3&pageSize=5");
    expect(p3.json).toMatchObject({ page: 3, pageSize: 5, total: 12 });
    expect(titlesOf(p3)).toEqual(["Show 10", "Show 11"]);
    const p2of5 = await list("?page=2&pageSize=5");
    expect(titlesOf(p2of5)).toEqual(["Show 05", "Show 06", "Show 07", "Show 08", "Show 09"]);
    const beyond = await list("?page=9");
    expect(beyond.status).toBe(200);
    expect(beyond.json).toMatchObject({ items: [], page: 9, total: 12 });
    const max = await list("?pageSize=50");
    expect(max.json.pageSize).toBe(50);
  });

  test("from and to are inclusive", async () => {
    const r = await list(`?from=${encodeURIComponent(day(3))}&to=${encodeURIComponent(day(5))}`);
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(3);
    expect(titlesOf(r)).toEqual(["Alpha Jazz", "Bravo Jazz", "Echo Rock"]);
    const fromOnly = await list(`?from=${encodeURIComponent(day(12))}`);
    expect(titlesOf(fromOnly)).toEqual(["Show 10", "Show 11"]);
    const toOnly = await list(`?to=${encodeURIComponent(day(1))}`);
    expect(titlesOf(toOnly)).toEqual(["Zulu Night"]);
  });

  test("q matches a case-insensitive substring of the title or the venue", async () => {
    expect(titlesOf(await list("?q=JAZZ"))).toEqual(["Alpha Jazz", "Bravo Jazz"]);
    expect(titlesOf(await list("?q=mill"))).toEqual(["Alpha Jazz", "Bravo Jazz"]);
    const harbor = await list("?q=harbor%20HALL");
    expect(titlesOf(harbor)).toEqual(["Zulu Night", "Echo Rock"]);
    expect(harbor.json.total).toBe(2);
    const shows = await list("?q=show&pageSize=3&page=2");
    expect(shows.json).toMatchObject({ page: 2, pageSize: 3, total: 8 });
    expect(titlesOf(shows)).toEqual(["Show 07", "Show 08", "Show 09"]);
    expect((await list("?q=nothing-matches")).json).toMatchObject({ items: [], total: 0 });
  });

  test("invalid query values are 400", async () => {
    for (const q of ["page=0", "page=-1", "page=abc", "page=1.5", "pageSize=0", "pageSize=51", "pageSize=xyz", "from=not-a-date", "to=never"]) {
      const r = await list(`?${q}`);
      expect({ q, status: r.status }).toEqual({ q, status: 400 });
      expect(r.json).toEqual({ error: expect.any(String) });
    }
  });
});

describe("orders", () => {
  const HOLD = 120;
  const server = serverPerSuite(HOLD);
  let org: Actor;
  let cust: Actor;
  let ev: any;
  beforeAll(async () => {
    org = await signUp(server(), "organizer");
    cust = await signUp(server(), "customer");
    ev = await newEvent(server(), org, {
      tiers: [
        { name: "GA", priceCents: 2500, quantity: 100 },
        { name: "VIP", priceCents: 9900, quantity: 20 },
      ],
    });
  });

  test("POST /orders gives 201 with a held order and takes the tickets", async () => {
    const s = server();
    const buyer = await signUp(s, "customer");
    const ga = tierOf(ev, "GA").id;
    const vip = tierOf(ev, "VIP").id;
    const before = Date.now();
    const r = await placeOrder(s, buyer, ev.id, [{ tierId: ga, quantity: 2 }, { tierId: vip, quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(r.json).toEqual({
      id: expect.any(String),
      eventId: ev.id,
      customerId: buyer.user.id,
      status: "held",
      items: expect.any(Array),
      subtotalCents: 2 * 2500 + 9900,
      discountCode: null,
      discountCents: 0,
      totalCents: 2 * 2500 + 9900,
      createdAt: expect.stringMatching(ISO_UTC_MS),
      expiresAt: expect.stringMatching(ISO_UTC_MS),
      paidAt: null,
    });
    expect(r.json.items).toHaveLength(2);
    expect(r.json.items).toEqual(
      expect.arrayContaining([
        { tierId: ga, quantity: 2, unitPriceCents: 2500 },
        { tierId: vip, quantity: 1, unitPriceCents: 9900 },
      ]),
    );
    const created = Date.parse(r.json.createdAt);
    expect(created).toBeGreaterThanOrEqual(before - 1000);
    expect(created).toBeLessThanOrEqual(Date.now() + 1000);
    expect(Date.parse(r.json.expiresAt) - created).toBe(HOLD * 1000);
    expect(await available(s, ev.id, "GA")).toBe(98);
    expect(await available(s, ev.id, "VIP")).toBe(19);
    // undo so the other tests see the full tiers
    expect((await call(s, "POST", `/orders/${r.json.id}/cancel`, undefined, buyer.h)).status).toBe(200);
  });

  test("only customers order: no token is 401, an organizer is 403", async () => {
    const items = [{ tierId: tierOf(ev, "GA").id, quantity: 1 }];
    expectError(await call(server(), "POST", "/orders", { eventId: ev.id, items }), 401);
    expectError(await call(server(), "POST", "/orders", { eventId: ev.id, items }, org.h), 403);
  });

  test("bad items are 400 and an unknown event is 404", async () => {
    const ga = tierOf(ev, "GA").id;
    const vip = tierOf(ev, "VIP").id;
    const other = await newEvent(server(), org);
    const bad: unknown[] = [
      { eventId: ev.id, items: [] },
      { eventId: ev.id },
      { eventId: ev.id, items: [{ tierId: ga, quantity: 1 }, { tierId: ga, quantity: 2 }] },
      { eventId: ev.id, items: [{ tierId: ga, quantity: 0 }] },
      { eventId: ev.id, items: [{ tierId: ga, quantity: -1 }] },
      { eventId: ev.id, items: [{ tierId: ga, quantity: 1.5 }] },
      { eventId: ev.id, items: [{ tierId: ga, quantity: "2" }] },
      { eventId: ev.id, items: [{ tierId: vip, quantity: 1 }, { tierId: tierOf(other, "GA").id, quantity: 1 }] },
      { eventId: ev.id, items: [{ tierId: "no-such-tier", quantity: 1 }] },
      // input is checked before the event is looked up
      { eventId: "no-such-event", items: [] },
    ];
    for (const body of bad) {
      const r = await call(server(), "POST", "/orders", body, cust.h);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
      expect(r.json).toEqual({ error: expect.any(String) });
    }
    expectError(await call(server(), "POST", "/orders", { eventId: "no-such-event", items: [{ tierId: ga, quantity: 1 }] }, cust.h), 404);
    expect(await myOrders(server(), cust)).toEqual([]);
    expect(await available(server(), ev.id, "GA")).toBe(100);
  });

  test("not enough tickets in any one tier is 409 and holds nothing", async () => {
    const s = server();
    const small = await newEvent(s, org, { tiers: [{ name: "Big", priceCents: 100, quantity: 50 }, { name: "Tiny", priceCents: 100, quantity: 1 }] });
    const buyer = await signUp(s, "customer");
    expectError(await placeOrder(s, buyer, small.id, [{ tierId: tierOf(small, "Big").id, quantity: 2 }, { tierId: tierOf(small, "Tiny").id, quantity: 2 }]), 409);
    expect(await available(s, small.id, "Big")).toBe(50);
    expect(await available(s, small.id, "Tiny")).toBe(1);
    expect(await myOrders(s, buyer)).toEqual([]);
  });

  test("an event that has already started is 409", async () => {
    const s = server();
    const soon = await newEvent(s, org, { startsAt: at(1500) });
    await sleep(2000);
    expectError(await placeOrder(s, cust, soon.id, [{ tierId: tierOf(soon, "GA").id, quantity: 1 }]), 409);
  });

  test("at most 6 tickets per customer per event, counting held and paid orders (422)", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1000, quantity: 50 }, { name: "B", priceCents: 500, quantity: 50 }] });
    const a = tierOf(e, "A").id;
    const b = tierOf(e, "B").id;
    const buyer = await signUp(s, "customer");
    expectError(await placeOrder(s, buyer, e.id, [{ tierId: a, quantity: 7 }]), 422);
    expectError(await placeOrder(s, buyer, e.id, [{ tierId: a, quantity: 4 }, { tierId: b, quantity: 3 }]), 422);
    await paid(s, buyer, e.id, [{ tierId: a, quantity: 3 }]);
    const h = await held(s, buyer, e.id, [{ tierId: b, quantity: 2 }]);
    expectError(await placeOrder(s, buyer, e.id, [{ tierId: b, quantity: 2 }]), 422);
    const sixth = await held(s, buyer, e.id, [{ tierId: a, quantity: 1 }]);
    expect(sixth.status).toBe("held");
    expectError(await placeOrder(s, buyer, e.id, [{ tierId: a, quantity: 1 }]), 422);
    // a cancelled order no longer counts
    expect((await call(s, "POST", `/orders/${h.id}/cancel`, undefined, buyer.h)).status).toBe(200);
    expect((await placeOrder(s, buyer, e.id, [{ tierId: b, quantity: 2 }])).status).toBe(201);
    // the limit is per event
    expect((await placeOrder(s, buyer, ev.id, [{ tierId: tierOf(ev, "GA").id, quantity: 6 }])).status).toBe(201);
  });

  test("state (409) is checked before limits (422)", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1000, quantity: 3 }] });
    const buyer = await signUp(s, "customer");
    expectError(await placeOrder(s, buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 7 }]), 409);
    expectError(await placeOrder(s, buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 4 }], "NOSUCHCODE"), 409);
  });

  test("paying gives 200 with paid and paidAt; paying twice is 409", async () => {
    const s = server();
    const buyer = await signUp(s, "customer");
    const o = await held(s, buyer, ev.id, [{ tierId: tierOf(ev, "VIP").id, quantity: 1 }]);
    const before = Date.now();
    const r = await call(s, "POST", `/orders/${o.id}/pay`, undefined, buyer.h);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: o.id, eventId: o.eventId, customerId: o.customerId, items: o.items, totalCents: o.totalCents, createdAt: o.createdAt, status: "paid" });
    expect(r.json.paidAt).toMatch(ISO_UTC_MS);
    expect(Date.parse(r.json.paidAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(r.json.paidAt)).toBeLessThanOrEqual(Date.now() + 1000);
    expectError(await call(s, "POST", `/orders/${o.id}/pay`, undefined, buyer.h), 409);
    expect((await getOrder(s, buyer, o.id)).status).toBe("paid");
  });

  test("paying: someone else's order or an unknown one is 404, an organizer is 403", async () => {
    const s = server();
    const buyer = await signUp(s, "customer");
    const stranger = await signUp(s, "customer");
    const o = await held(s, buyer, ev.id, [{ tierId: tierOf(ev, "GA").id, quantity: 1 }]);
    expectError(await call(s, "POST", `/orders/${o.id}/pay`), 401);
    expectError(await call(s, "POST", `/orders/${o.id}/pay`, undefined, org.h), 403);
    expectError(await call(s, "POST", `/orders/${o.id}/pay`, undefined, stranger.h), 404);
    expectError(await call(s, "POST", "/orders/no-such-order/pay", undefined, buyer.h), 404);
    expect((await getOrder(s, buyer, o.id)).status).toBe("held");
  });

  test("cancelling a held order gives the tickets back; cancelling again is 409", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 700, quantity: 10 }] });
    const buyer = await signUp(s, "customer");
    const o = await held(s, buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 4 }]);
    expect(await available(s, e.id, "A")).toBe(6);
    const r = await call(s, "POST", `/orders/${o.id}/cancel`, undefined, buyer.h);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: o.id, items: o.items, totalCents: o.totalCents, createdAt: o.createdAt, status: "cancelled", paidAt: null });
    expect(await available(s, e.id, "A")).toBe(10);
    expectError(await call(s, "POST", `/orders/${o.id}/cancel`, undefined, buyer.h), 409);
    expectError(await call(s, "POST", `/orders/${o.id}/pay`, undefined, buyer.h), 409);
  });

  test("cancelling a paid order refunds it while the event is more than 24 hours away", async () => {
    const s = server();
    const e = await newEvent(s, org, { startsAt: inDays(3), tiers: [{ name: "A", priceCents: 700, quantity: 10 }] });
    const buyer = await signUp(s, "customer");
    const p = await paid(s, buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 2 }]);
    expect(await available(s, e.id, "A")).toBe(8);
    const r = await call(s, "POST", `/orders/${p.id}/cancel`, undefined, buyer.h);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: p.id, items: p.items, totalCents: p.totalCents, createdAt: p.createdAt, status: "refunded" });
    expect(await available(s, e.id, "A")).toBe(10);
    expectError(await call(s, "POST", `/orders/${p.id}/cancel`, undefined, buyer.h), 409);
  });

  test("a paid order for an event within 24 hours cannot be cancelled (409), a held one can", async () => {
    const s = server();
    const e = await newEvent(s, org, { startsAt: at(2 * HOUR), tiers: [{ name: "A", priceCents: 700, quantity: 10 }] });
    const buyer = await signUp(s, "customer");
    const p = await paid(s, buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 1 }]);
    expectError(await call(s, "POST", `/orders/${p.id}/cancel`, undefined, buyer.h), 409);
    expect((await getOrder(s, buyer, p.id)).status).toBe("paid");
    const h = await held(s, buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 1 }]);
    const r = await call(s, "POST", `/orders/${h.id}/cancel`, undefined, buyer.h);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("cancelled");
  });

  test("cancelling someone else's order is 404, an organizer is 403", async () => {
    const s = server();
    const buyer = await signUp(s, "customer");
    const stranger = await signUp(s, "customer");
    const o = await held(s, buyer, ev.id, [{ tierId: tierOf(ev, "GA").id, quantity: 1 }]);
    expectError(await call(s, "POST", `/orders/${o.id}/cancel`, undefined, stranger.h), 404);
    expectError(await call(s, "POST", `/orders/${o.id}/cancel`, undefined, org.h), 403);
    expectError(await call(s, "POST", "/orders/no-such-order/cancel", undefined, buyer.h), 404);
    expect((await getOrder(s, buyer, o.id)).status).toBe("held");
  });

  test("GET /orders/:id: the customer and the event's organizer see it, anyone else gets 404", async () => {
    const s = server();
    const buyer = await signUp(s, "customer");
    const stranger = await signUp(s, "customer");
    const otherOrg = await signUp(s, "organizer");
    const o = await held(s, buyer, ev.id, [{ tierId: tierOf(ev, "GA").id, quantity: 1 }]);
    expect(await getOrder(s, buyer, o.id)).toEqual(o);
    expect(await getOrder(s, org, o.id)).toEqual(o);
    expectError(await call(s, "GET", `/orders/${o.id}`, undefined, stranger.h), 404);
    expectError(await call(s, "GET", `/orders/${o.id}`, undefined, otherOrg.h), 404);
    expectError(await call(s, "GET", `/orders/${o.id}`), 401);
    expectError(await call(s, "GET", "/orders/no-such-order", undefined, buyer.h), 404);
  });

  test("GET /me/orders lists the caller's orders newest first; organizers get 403", async () => {
    const s = server();
    const buyer = await signUp(s, "customer");
    const other = await signUp(s, "customer");
    const ga = tierOf(ev, "GA").id;
    const o1 = await held(s, buyer, ev.id, [{ tierId: ga, quantity: 1 }]);
    await sleep(15);
    await held(s, other, ev.id, [{ tierId: ga, quantity: 1 }]);
    await sleep(15);
    const o2 = await paid(s, buyer, ev.id, [{ tierId: ga, quantity: 2 }]);
    await sleep(15);
    const o3 = await held(s, buyer, ev.id, [{ tierId: tierOf(ev, "VIP").id, quantity: 1 }]);
    const list = await myOrders(s, buyer);
    expect(list.map((o) => o.id)).toEqual([o3.id, o2.id, o1.id]);
    expect(list[1]).toEqual(o2);
    expectError(await call(s, "GET", "/me/orders", undefined, org.h), 403);
    expectError(await call(s, "GET", "/me/orders"), 401);
  });
});

describe("holds expiring", () => {
  const HOLD = 2;
  const server = serverPerSuite(HOLD);
  const WAIT = HOLD * 1000 + 700;
  let org: Actor;
  beforeAll(async () => {
    org = await signUp(server(), "organizer");
  });

  test("a held order past expiresAt is expired and its tickets are available again", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1000, quantity: 5 }] });
    const buyer = await signUp(s, "customer");
    const o = await held(s, buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 5 }]);
    expect(Date.parse(o.expiresAt) - Date.parse(o.createdAt)).toBe(HOLD * 1000);
    expect(await available(s, e.id, "A")).toBe(0);
    await sleep(WAIT);
    expect(await available(s, e.id, "A")).toBe(5);
    const later = await getOrder(s, buyer, o.id);
    expect(later).toMatchObject({ id: o.id, items: o.items, createdAt: o.createdAt, expiresAt: o.expiresAt, status: "expired", paidAt: null });
    expect((await myOrders(s, buyer))[0].status).toBe("expired");
    const report = await call(s, "GET", `/events/${e.id}/report`, undefined, org.h);
    expect(report.status).toBe(200);
    expect(report.json.tiers[0]).toMatchObject({ sold: 0, held: 0, available: 5 });
  });

  test("an expired order cannot be paid or cancelled (409)", async () => {
    const s = server();
    const e = await newEvent(s, org);
    const buyer = await signUp(s, "customer");
    const o = await held(s, buyer, e.id, [{ tierId: tierOf(e, "GA").id, quantity: 1 }]);
    await sleep(WAIT);
    expectError(await call(s, "POST", `/orders/${o.id}/pay`, undefined, buyer.h), 409);
    expectError(await call(s, "POST", `/orders/${o.id}/cancel`, undefined, buyer.h), 409);
    expect((await getOrder(s, buyer, o.id)).status).toBe("expired");
  });

  test("a paid order does not expire", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1000, quantity: 5 }] });
    const buyer = await signUp(s, "customer");
    const p = await paid(s, buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 2 }]);
    await sleep(WAIT);
    expect((await getOrder(s, buyer, p.id)).status).toBe("paid");
    expect(await available(s, e.id, "A")).toBe(3);
  });

  test("expired orders stop counting toward the 6-ticket limit and give their discount use back", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1000, quantity: 20 }] });
    const a = tierOf(e, "A").id;
    expect((await call(s, "POST", `/events/${e.id}/discounts`, { code: "ONCE1", percentOff: 50, maxUses: 1 }, org.h)).status).toBe(201);
    const buyer = await signUp(s, "customer");
    const other = await signUp(s, "customer");
    await held(s, buyer, e.id, [{ tierId: a, quantity: 6 }], "ONCE1");
    expectError(await placeOrder(s, buyer, e.id, [{ tierId: a, quantity: 1 }]), 422);
    expectError(await placeOrder(s, other, e.id, [{ tierId: a, quantity: 1 }], "ONCE1"), 422);
    await sleep(WAIT);
    const again = await held(s, buyer, e.id, [{ tierId: a, quantity: 6 }]);
    expect(again.status).toBe("held");
    const withCode = await held(s, other, e.id, [{ tierId: a, quantity: 2 }], "once1");
    expect(withCode).toMatchObject({ discountCode: "ONCE1", subtotalCents: 2000, discountCents: 1000, totalCents: 1000 });
  });

  test("an expiring hold serves the tier's waitlist", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1200, quantity: 3 }] });
    const a = tierOf(e, "A").id;
    const buyer = await signUp(s, "customer");
    const waiter = await signUp(s, "customer");
    await held(s, buyer, e.id, [{ tierId: a, quantity: 3 }]);
    expect((await joinWaitlist(s, waiter, e.id, a, 2)).status).toBe(201);
    await sleep(WAIT);
    const orders = await myOrders(s, waiter);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      eventId: e.id,
      customerId: waiter.user.id,
      status: "held",
      items: [{ tierId: a, quantity: 2, unitPriceCents: 1200 }],
      subtotalCents: 2400,
      discountCode: null,
      discountCents: 0,
      totalCents: 2400,
      paidAt: null,
    });
    expect(await myWaitlist(s, waiter)).toEqual([]);
    expect(await available(s, e.id, "A")).toBe(1);
  });
});

describe("discount codes", () => {
  const server = serverPerSuite(300);
  let org: Actor;
  let cust: Actor;
  beforeAll(async () => {
    org = await signUp(server(), "organizer");
    cust = await signUp(server(), "customer");
  });
  const addCode = (eventId: string, body: unknown, who: Actor = org) => call(server(), "POST", `/events/${eventId}/discounts`, body, who.h);

  test("POST /events/:id/discounts gives 201, stores the code in upper case, absent fields null", async () => {
    const e = await newEvent(server(), org);
    const r = await addCode(e.id, { code: "spring25", percentOff: 25 });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ code: "SPRING25", percentOff: 25, amountOffCents: null, maxUses: null, expiresAt: null, uses: 0 });
    const exp = new Date(Math.floor((Date.now() + 5 * DAY) / 1000) * 1000);
    const r2 = await addCode(e.id, { code: "Flat500", amountOffCents: 500, maxUses: 3, expiresAt: exp.toUTCString() });
    expect(r2.status).toBe(201);
    expect(r2.json).toEqual({ code: "FLAT500", percentOff: null, amountOffCents: 500, maxUses: 3, expiresAt: exp.toISOString(), uses: 0 });
  });

  test("invalid discounts are 400", async () => {
    const e = await newEvent(server(), org);
    const bad: unknown[] = [
      { code: "BOTH1", percentOff: 10, amountOffCents: 100 },
      { code: "NEITHER1" },
      { code: "PCT0", percentOff: 0 },
      { code: "PCT101", percentOff: 101 },
      { code: "PCTFRAC", percentOff: 12.5 },
      { code: "AMT0", amountOffCents: 0 },
      { code: "AMTFRAC", amountOffCents: 99.5 },
      { code: "AB", percentOff: 10 },
      { code: "A".repeat(21), percentOff: 10 },
      { code: "AB-12", percentOff: 10 },
      { code: "AB 12", percentOff: 10 },
      { percentOff: 10 },
      { code: "MAXU0", percentOff: 10, maxUses: 0 },
      { code: "MAXUF", percentOff: 10, maxUses: 1.5 },
    ];
    for (const body of bad) {
      const r = await addCode(e.id, body);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
      expect(r.json).toEqual({ error: expect.any(String) });
    }
    // boundaries
    expect((await addCode(e.id, { code: "ABC", percentOff: 100 })).status).toBe(201);
    expect((await addCode(e.id, { code: "A".repeat(20), amountOffCents: 1, maxUses: 1 })).status).toBe(201);
  });

  test("only the event's organizer adds codes; a code the event has is 409, in any case", async () => {
    const e = await newEvent(server(), org);
    const other = await signUp(server(), "organizer");
    expectError(await call(server(), "POST", `/events/${e.id}/discounts`, { code: "HELLO1", percentOff: 5 }), 401);
    expectError(await addCode(e.id, { code: "HELLO1", percentOff: 5 }, cust), 403);
    expectError(await addCode(e.id, { code: "HELLO1", percentOff: 5 }, other), 403);
    expectError(await addCode("no-such-event", { code: "HELLO1", percentOff: 5 }), 404);
    expect((await addCode(e.id, { code: "HELLO1", percentOff: 5 })).status).toBe(201);
    expectError(await addCode(e.id, { code: "hello1", amountOffCents: 100 }), 409);
    // another event may have the same code
    const e2 = await newEvent(server(), org);
    expect((await addCode(e2.id, { code: "HELLO1", percentOff: 5 })).status).toBe(201);
  });

  test("percentOff discounts are floored; codes match case-insensitively", async () => {
    const e = await newEvent(server(), org, { tiers: [{ name: "A", priceCents: 999, quantity: 50 }, { name: "B", priceCents: 2500, quantity: 50 }] });
    await addCode(e.id, { code: "SAVE15", percentOff: 15 });
    const buyer = await signUp(server(), "customer");
    const o = await held(server(), buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 1 }], "save15");
    expect(o).toMatchObject({ discountCode: "SAVE15", subtotalCents: 999, discountCents: 149, totalCents: 850 });
    const o2 = await held(server(), buyer, e.id, [{ tierId: tierOf(e, "A").id, quantity: 1 }, { tierId: tierOf(e, "B").id, quantity: 2 }], "Save15");
    // 999 + 5000 = 5999; 15% = 899.85
    expect(o2).toMatchObject({ discountCode: "SAVE15", subtotalCents: 5999, discountCents: 899, totalCents: 5100 });
  });

  test("amountOffCents discounts are capped at the subtotal", async () => {
    const e = await newEvent(server(), org, { tiers: [{ name: "A", priceCents: 1500, quantity: 50 }] });
    await addCode(e.id, { code: "FIVE00", amountOffCents: 500 });
    await addCode(e.id, { code: "HUGE", amountOffCents: 100000 });
    const buyer = await signUp(server(), "customer");
    const a = tierOf(e, "A").id;
    expect(await held(server(), buyer, e.id, [{ tierId: a, quantity: 1 }], "FIVE00")).toMatchObject({ subtotalCents: 1500, discountCents: 500, totalCents: 1000 });
    expect(await held(server(), buyer, e.id, [{ tierId: a, quantity: 2 }], "huge")).toMatchObject({ discountCode: "HUGE", subtotalCents: 3000, discountCents: 3000, totalCents: 0 });
  });

  test("a code the event does not have is 422 and holds nothing", async () => {
    const e = await newEvent(server(), org, { tiers: [{ name: "A", priceCents: 1000, quantity: 10 }] });
    const e2 = await newEvent(server(), org);
    await addCode(e2.id, { code: "OTHER1", percentOff: 10 });
    const buyer = await signUp(server(), "customer");
    const a = tierOf(e, "A").id;
    expectError(await placeOrder(server(), buyer, e.id, [{ tierId: a, quantity: 2 }], "NOPE123"), 422);
    expectError(await placeOrder(server(), buyer, e.id, [{ tierId: a, quantity: 2 }], "OTHER1"), 422);
    expect(await available(server(), e.id, "A")).toBe(10);
    expect(await myOrders(server(), buyer)).toEqual([]);
  });

  test("an expired code is 422", async () => {
    const e = await newEvent(server(), org);
    expect((await addCode(e.id, { code: "BRIEF1", percentOff: 10, expiresAt: at(1500) })).status).toBe(201);
    await sleep(2000);
    expectError(await placeOrder(server(), cust, e.id, [{ tierId: tierOf(e, "GA").id, quantity: 1 }], "BRIEF1"), 422);
  });

  test("a used-up code is 422; cancelled and refunded orders give their use back", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1000, quantity: 50 }] });
    const a = tierOf(e, "A").id;
    await addCode(e.id, { code: "TWICE", percentOff: 10, maxUses: 2 });
    const c1 = await signUp(s, "customer");
    const c2 = await signUp(s, "customer");
    const c3 = await signUp(s, "customer");
    const o1 = await held(s, c1, e.id, [{ tierId: a, quantity: 1 }], "TWICE");
    const o2 = await paid(s, c2, e.id, [{ tierId: a, quantity: 1 }], "TWICE");
    expectError(await placeOrder(s, c3, e.id, [{ tierId: a, quantity: 1 }], "TWICE"), 422);
    expect((await call(s, "POST", `/orders/${o1.id}/cancel`, undefined, c1.h)).status).toBe(200);
    const o3 = await held(s, c3, e.id, [{ tierId: a, quantity: 1 }], "TWICE");
    expect(o3.discountCode).toBe("TWICE");
    expectError(await placeOrder(s, c1, e.id, [{ tierId: a, quantity: 1 }], "TWICE"), 422);
    expect((await call(s, "POST", `/orders/${o2.id}/cancel`, undefined, c2.h)).json.status).toBe("refunded");
    expect((await placeOrder(s, c1, e.id, [{ tierId: a, quantity: 1 }], "twice")).status).toBe(201);
  });
});

describe("waitlist", () => {
  const server = serverPerSuite(301);
  let org: Actor;
  beforeAll(async () => {
    org = await signUp(server(), "organizer");
  });

  test("joining gives 201 with the entry and its position; GET /me/waitlist lists it", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1000, quantity: 3 }] });
    const a = tierOf(e, "A").id;
    const buyer = await signUp(s, "customer");
    const w1 = await signUp(s, "customer");
    const w2 = await signUp(s, "customer");
    await held(s, buyer, e.id, [{ tierId: a, quantity: 2 }]);
    expectError(await joinWaitlist(s, w1, e.id, a, 1), 409);
    const r1 = await joinWaitlist(s, w1, e.id, a, 2);
    expect(r1.status).toBe(201);
    expect(r1.json).toEqual({ id: expect.any(String), eventId: e.id, tierId: a, quantity: 2, position: 1 });
    const r2 = await joinWaitlist(s, w2, e.id, a, 6);
    expect(r2.status).toBe(201);
    expect(r2.json).toEqual({ id: expect.any(String), eventId: e.id, tierId: a, quantity: 6, position: 2 });
    expect(await myWaitlist(s, w1)).toEqual([r1.json]);
    expect(await myWaitlist(s, w2)).toEqual([r2.json]);
  });

  test("bad quantity is 400, waiting twice is 409, organizers 403, unknown event 404", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1000, quantity: 1 }] });
    const a = tierOf(e, "A").id;
    const buyer = await signUp(s, "customer");
    const w = await signUp(s, "customer");
    await held(s, buyer, e.id, [{ tierId: a, quantity: 1 }]);
    for (const quantity of [0, 7, 1.5, -1]) expectError(await joinWaitlist(s, w, e.id, a, quantity), 400);
    expectError(await call(s, "POST", `/events/${e.id}/waitlist`, { tierId: a, quantity: 1 }), 401);
    expectError(await joinWaitlist(s, org, e.id, a, 1), 403);
    expectError(await joinWaitlist(s, w, "no-such-event", a, 1), 404);
    expect((await joinWaitlist(s, w, e.id, a, 1)).status).toBe(201);
    expectError(await joinWaitlist(s, w, e.id, a, 2), 409);
    expect(await myWaitlist(s, w)).toHaveLength(1);
    expectError(await call(s, "GET", "/me/waitlist", undefined, org.h), 403);
    expectError(await call(s, "GET", "/me/waitlist"), 401);
  });

  test("released tickets serve the waitlist strictly in order", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "Floor", priceCents: 1000, quantity: 5 }] });
    const f = tierOf(e, "Floor").id;
    const holder = await signUp(s, "customer");
    const w1 = await signUp(s, "customer");
    const w2 = await signUp(s, "customer");
    const o1 = await held(s, holder, e.id, [{ tierId: f, quantity: 2 }]);
    const o2 = await held(s, holder, e.id, [{ tierId: f, quantity: 3 }]);
    expect((await joinWaitlist(s, w1, e.id, f, 3)).json.position).toBe(1);
    expect((await joinWaitlist(s, w2, e.id, f, 1)).json.position).toBe(2);

    // 2 free: the first entry (3) does not fit, so nobody behind it is served
    expect((await call(s, "POST", `/orders/${o1.id}/cancel`, undefined, holder.h)).status).toBe(200);
    expect(await available(s, e.id, "Floor")).toBe(2);
    expect(await myOrders(s, w1)).toEqual([]);
    expect(await myOrders(s, w2)).toEqual([]);
    expect((await myWaitlist(s, w2))[0].position).toBe(2);

    // 5 free: both are served, in order
    expect((await call(s, "POST", `/orders/${o2.id}/cancel`, undefined, holder.h)).status).toBe(200);
    const [a1] = await myOrders(s, w1);
    const [a2] = await myOrders(s, w2);
    expect(a1).toMatchObject({ eventId: e.id, customerId: w1.user.id, status: "held", items: [{ tierId: f, quantity: 3, unitPriceCents: 1000 }], subtotalCents: 3000, discountCode: null, discountCents: 0, totalCents: 3000, paidAt: null });
    expect(a2).toMatchObject({ customerId: w2.user.id, status: "held", items: [{ tierId: f, quantity: 1, unitPriceCents: 1000 }], discountCode: null });
    expect(Date.parse(a1.expiresAt) - Date.parse(a1.createdAt)).toBe(301 * 1000);
    expect(await myWaitlist(s, w1)).toEqual([]);
    expect(await myWaitlist(s, w2)).toEqual([]);
    expect(await available(s, e.id, "Floor")).toBe(1);
  });

  test("positions move up once the people ahead are served", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 500, quantity: 3 }] });
    const a = tierOf(e, "A").id;
    const h1 = await signUp(s, "customer");
    const h2 = await signUp(s, "customer");
    const w1 = await signUp(s, "customer");
    const w2 = await signUp(s, "customer");
    const small = await held(s, h1, e.id, [{ tierId: a, quantity: 1 }]);
    await held(s, h2, e.id, [{ tierId: a, quantity: 2 }]);
    await joinWaitlist(s, w1, e.id, a, 1);
    await joinWaitlist(s, w2, e.id, a, 3);
    expect((await call(s, "POST", `/orders/${small.id}/cancel`, undefined, h1.h)).status).toBe(200);
    expect((await myOrders(s, w1)).map((o) => o.status)).toEqual(["held"]);
    const [entry] = await myWaitlist(s, w2);
    expect(entry).toMatchObject({ eventId: e.id, tierId: a, quantity: 3, position: 1 });
    expect(await available(s, e.id, "A")).toBe(0);
  });

  test("an entry that would take its customer over 6 tickets is removed without an order, and serving continues", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "X", priceCents: 800, quantity: 2 }, { name: "Y", priceCents: 100, quantity: 20 }] });
    const x = tierOf(e, "X").id;
    const y = tierOf(e, "Y").id;
    const holder = await signUp(s, "customer");
    const w1 = await signUp(s, "customer");
    const w2 = await signUp(s, "customer");
    const block = await held(s, holder, e.id, [{ tierId: x, quantity: 2 }]);
    const own = await paid(s, w1, e.id, [{ tierId: y, quantity: 5 }]);
    expect((await joinWaitlist(s, w1, e.id, x, 2)).status).toBe(201);
    expect((await joinWaitlist(s, w2, e.id, x, 1)).status).toBe(201);
    expect((await call(s, "POST", `/orders/${block.id}/cancel`, undefined, holder.h)).status).toBe(200);
    expect(await myWaitlist(s, w1)).toEqual([]);
    expect((await myOrders(s, w1)).map((o) => o.id)).toEqual([own.id]);
    const w2orders = await myOrders(s, w2);
    expect(w2orders).toHaveLength(1);
    expect(w2orders[0]).toMatchObject({ status: "held", items: [{ tierId: x, quantity: 1, unitPriceCents: 800 }] });
    expect(await myWaitlist(s, w2)).toEqual([]);
    expect(await available(s, e.id, "X")).toBe(1);
  });

  test("a refunded order serves the waitlist", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 2000, quantity: 2 }] });
    const a = tierOf(e, "A").id;
    const buyer = await signUp(s, "customer");
    const w = await signUp(s, "customer");
    const p = await paid(s, buyer, e.id, [{ tierId: a, quantity: 2 }]);
    await joinWaitlist(s, w, e.id, a, 2);
    expect((await call(s, "POST", `/orders/${p.id}/cancel`, undefined, buyer.h)).json.status).toBe("refunded");
    const orders = await myOrders(s, w);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: "held", items: [{ tierId: a, quantity: 2, unitPriceCents: 2000 }], totalCents: 4000 });
    expect(await available(s, e.id, "A")).toBe(0);
  });

  test("the waitlist is per tier", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 100, quantity: 1 }, { name: "B", priceCents: 100, quantity: 1 }] });
    const a = tierOf(e, "A").id;
    const b = tierOf(e, "B").id;
    const buyer = await signUp(s, "customer");
    const w1 = await signUp(s, "customer");
    const w2 = await signUp(s, "customer");
    await held(s, buyer, e.id, [{ tierId: a, quantity: 1 }, { tierId: b, quantity: 1 }]);
    expect((await joinWaitlist(s, w1, e.id, a, 1)).json.position).toBe(1);
    expect((await joinWaitlist(s, w2, e.id, b, 1)).json.position).toBe(1);
    expect((await joinWaitlist(s, w1, e.id, b, 1)).json.position).toBe(2);
    expect((await myWaitlist(s, w1)).map((w) => [w.tierId, w.position]).sort()).toEqual([[a, 1], [b, 2]].sort());
  });
});

describe("sales report", () => {
  const server = serverPerSuite(302);

  test("GET /events/:id/report sums paid, held and refunded orders", async () => {
    const s = server();
    const org = await signUp(s, "organizer");
    const e = await newEvent(s, org, { tiers: [{ name: "GA", priceCents: 1000, quantity: 10 }, { name: "VIP", priceCents: 5000, quantity: 5 }] });
    const ga = tierOf(e, "GA").id;
    const vip = tierOf(e, "VIP").id;
    expect((await call(s, "POST", `/events/${e.id}/discounts`, { code: "TEN10", percentOff: 10 }, org.h)).status).toBe(201);
    const [c1, c2, c3, c4, c5] = await Promise.all([1, 2, 3, 4, 5].map(() => signUp(s, "customer")));
    await paid(s, c1, e.id, [{ tierId: ga, quantity: 2 }], "TEN10"); // 2000 - 200
    await paid(s, c2, e.id, [{ tierId: vip, quantity: 1 }]); // 5000
    await held(s, c3, e.id, [{ tierId: ga, quantity: 3 }]);
    const refund = await paid(s, c4, e.id, [{ tierId: vip, quantity: 1 }]);
    expect((await call(s, "POST", `/orders/${refund.id}/cancel`, undefined, c4.h)).json.status).toBe("refunded");
    const gone = await held(s, c5, e.id, [{ tierId: ga, quantity: 1 }]);
    expect((await call(s, "POST", `/orders/${gone.id}/cancel`, undefined, c5.h)).json.status).toBe("cancelled");

    const r = await call(s, "GET", `/events/${e.id}/report`, undefined, org.h);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      eventId: e.id,
      tiers: expect.any(Array),
      grossCents: 7000,
      discountCents: 200,
      refundedCents: 5000,
      netCents: 6800,
    });
    expect(r.json.tiers).toHaveLength(2);
    expect(r.json.tiers.find((t: any) => t.tierId === ga)).toEqual({ tierId: ga, name: "GA", sold: 2, held: 3, available: 5 });
    expect(r.json.tiers.find((t: any) => t.tierId === vip)).toEqual({ tierId: vip, name: "VIP", sold: 1, held: 0, available: 4 });
  });

  test("an event with no orders reports zeros", async () => {
    const s = server();
    const org = await signUp(s, "organizer");
    const e = await newEvent(s, org, { tiers: [{ name: "GA", priceCents: 1000, quantity: 10 }] });
    const r = await call(s, "GET", `/events/${e.id}/report`, undefined, org.h);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      eventId: e.id,
      tiers: [{ tierId: tierOf(e, "GA").id, name: "GA", sold: 0, held: 0, available: 10 }],
      grossCents: 0,
      discountCents: 0,
      refundedCents: 0,
      netCents: 0,
    });
  });

  test("only the event's organizer sees the report", async () => {
    const s = server();
    const org = await signUp(s, "organizer");
    const other = await signUp(s, "organizer");
    const cust = await signUp(s, "customer");
    const e = await newEvent(s, org);
    expectError(await call(s, "GET", `/events/${e.id}/report`), 401);
    expectError(await call(s, "GET", `/events/${e.id}/report`, undefined, cust.h), 403);
    expectError(await call(s, "GET", `/events/${e.id}/report`, undefined, other.h), 403);
    expectError(await call(s, "GET", "/events/no-such-event/report", undefined, org.h), 404);
    // role is checked before the event is looked up
    expectError(await call(s, "GET", "/events/no-such-event/report", undefined, cust.h), 403);
  });
});

describe("check order: 401, 403, 400, 404, 403, 409, 422", () => {
  const server = serverPerSuite(303);
  let org: Actor;
  let other: Actor;
  let cust: Actor;
  let ev: any;
  beforeAll(async () => {
    org = await signUp(server(), "organizer");
    other = await signUp(server(), "organizer");
    cust = await signUp(server(), "customer");
    ev = await newEvent(server(), org, { tiers: [{ name: "A", priceCents: 1000, quantity: 2 }] });
  });

  test("the token comes before the role and the input", async () => {
    expectError(await call(server(), "POST", "/events", {}), 401);
    expectError(await call(server(), "POST", "/events", "{broken"), 401);
    expectError(await call(server(), "POST", "/events", {}, { authorization: "Bearer bogus" }), 401);
    expectError(await call(server(), "POST", "/orders", { items: [] }), 401);
  });

  test("the role comes before the input and the things it names", async () => {
    expectError(await call(server(), "POST", "/events", {}, cust.h), 403);
    expectError(await call(server(), "POST", "/events", "{broken", cust.h), 403);
    expectError(await call(server(), "POST", "/orders", { items: [] }, org.h), 403);
    expectError(await call(server(), "POST", "/events/no-such-event/discounts", {}, cust.h), 403);
    expectError(await call(server(), "POST", "/events/no-such-event/cancel", undefined, cust.h), 403);
    expectError(await call(server(), "POST", "/events/no-such-event/waitlist", { tierId: "x", quantity: 99 }, org.h), 403);
  });

  test("the input comes before the things it names and ownership", async () => {
    expectError(await call(server(), "POST", "/events/no-such-event/discounts", { code: "X" }, org.h), 400);
    expectError(await call(server(), "POST", `/events/${ev.id}/discounts`, { code: "X" }, other.h), 400);
    expectError(await call(server(), "POST", "/events/no-such-event/waitlist", { tierId: tierOf(ev, "A").id, quantity: 7 }, cust.h), 400);
  });

  test("the things it names come before ownership, ownership before state", async () => {
    expectError(await call(server(), "POST", "/events/no-such-event/discounts", { code: "GOOD1", percentOff: 5 }, other.h), 404);
    expect((await call(server(), "POST", `/events/${ev.id}/discounts`, { code: "TAKEN1", percentOff: 5 }, org.h)).status).toBe(201);
    expectError(await call(server(), "POST", `/events/${ev.id}/discounts`, { code: "TAKEN1", percentOff: 5 }, other.h), 403);
    expectError(await call(server(), "POST", `/events/${ev.id}/discounts`, { code: "taken1", percentOff: 5 }, org.h), 409);
  });

  test("state comes before limits", async () => {
    const s = server();
    const e = await newEvent(s, org, { tiers: [{ name: "A", priceCents: 1000, quantity: 10 }] });
    expect((await call(s, "POST", `/events/${e.id}/cancel`, undefined, org.h)).status).toBe(200);
    // over the 6-ticket limit and with an unusable code, but the event is cancelled
    expectError(await placeOrder(s, cust, e.id, [{ tierId: tierOf(e, "A").id, quantity: 8 }], "NOSUCH1"), 409);
  });
});
