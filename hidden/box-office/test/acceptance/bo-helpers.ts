import { expect } from "vitest";

let counter = 0;
export const uniq = (): string => `${Date.now().toString(36)}z${(counter++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const futureIso = (days = 30, offsetMs = 0): string => new Date(Date.now() + days * 86400_000 + offsetMs).toISOString();

export type R = { status: number; body: any; text: string };

export function api(baseUrl: () => string) {
  async function req(method: string, path: string, body?: unknown, token?: string, raw?: string): Promise<R> {
    const headers: Record<string, string> = {};
    if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
    if (token) headers["authorization"] = `Bearer ${token}`;
    const r = await fetch(baseUrl() + path, {
      method,
      headers,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: any = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: r.status, body: parsed, text };
  }

  async function user(role: "customer" | "organizer"): Promise<{ id: string; token: string; email: string; password: string }> {
    const email = `u${uniq()}@example.com`;
    const password = "password1";
    const c = await req("POST", "/users", { email, password, name: "User", role });
    if (c.status !== 201) throw new Error("register failed " + c.status + " " + c.text);
    const s = await req("POST", "/sessions", { email, password });
    if (s.status !== 200) throw new Error("login failed " + s.status + " " + s.text);
    return { id: c.body.id, token: s.body.token, email, password };
  }

  async function event(
    token: string,
    opts: { title?: string; venue?: string; startsAt?: string; tiers?: { name: string; priceCents: number; quantity: number }[] } = {},
  ): Promise<any> {
    const r = await req(
      "POST",
      "/events",
      {
        title: opts.title ?? "Show " + uniq(),
        venue: opts.venue ?? "Hall",
        startsAt: opts.startsAt ?? futureIso(),
        tiers: opts.tiers ?? [{ name: "GA", priceCents: 1000, quantity: 10 }],
      },
      token,
    );
    if (r.status !== 201) throw new Error("create event failed " + r.status + " " + r.text);
    return r.body;
  }

  async function order(token: string, eventId: string, items: { tierId: string; quantity: number }[], discountCode?: string): Promise<R> {
    const body: any = { eventId, items };
    if (discountCode !== undefined) body.discountCode = discountCode;
    return req("POST", "/orders", body, token);
  }

  async function available(eventId: string, tierId: string): Promise<number> {
    const r = await req("GET", `/events/${eventId}`);
    return r.body.tiers.find((t: any) => t.id === tierId).available;
  }

  return { req, user, event, order, available };
}

export function expectError(r: R, status: number) {
  expect(r.status, r.text).toBe(status);
  expect(r.body).toBeTypeOf("object");
  expect(r.body).not.toBeNull();
  expect(typeof r.body.error).toBe("string");
}
