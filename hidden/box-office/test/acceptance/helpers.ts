let counter = 0;

export type Res = { status: number; body: any; contentType: string | null };

export function makeApi(baseUrl: () => string) {
  async function req(method: string, path: string, body?: unknown, token?: string, raw?: string): Promise<Res> {
    const headers: Record<string, string> = {};
    if (body !== undefined || raw !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const r = await fetch(baseUrl() + path, {
      method,
      headers,
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let parsed: any = undefined;
    try {
      parsed = text.length ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: r.status, body: parsed, contentType: r.headers.get("content-type") };
  }

  async function makeUser(role: "organizer" | "customer") {
    counter++;
    const email = `u${Date.now()}_${counter}_${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = "password123";
    const reg = await req("POST", "/users", { email, password, name: "User " + counter, role });
    if (reg.status !== 201) throw new Error("register failed: " + reg.status + " " + JSON.stringify(reg.body));
    const s = await req("POST", "/sessions", { email, password });
    if (s.status !== 200) throw new Error("login failed: " + s.status);
    return { id: reg.body.id as string, email, token: s.body.token as string };
  }

  async function createEvent(token: string, overrides: Record<string, unknown> = {}) {
    counter++;
    const body = {
      title: "Event " + counter,
      venue: "Main Hall",
      startsAt: inDays(30),
      tiers: [{ name: "GA", priceCents: 1000, quantity: 100 }],
      ...overrides,
    };
    const r = await req("POST", "/events", body, token);
    if (r.status !== 201) throw new Error("create event failed: " + r.status + " " + JSON.stringify(r.body));
    return r.body;
  }

  async function tierAvailable(eventId: string, tierId: string): Promise<number> {
    const r = await req("GET", `/events/${eventId}`);
    return r.body.tiers.find((t: any) => t.id === tierId).available;
  }

  return { req, makeUser, createEvent, tierAvailable };
}

export function inDays(d: number): string {
  return new Date(Date.now() + d * 86400000).toISOString();
}
export function inHours(h: number): string {
  return new Date(Date.now() + h * 3600000).toISOString();
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
