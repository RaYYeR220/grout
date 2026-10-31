import type { AppContext, Discount, Order, Req, Route, WaitlistEntry } from "../types.js";
import { HttpError, MAX_TICKETS_PER_EVENT } from "../types.js";
import { authenticate, requireRole } from "../auth.js";
import {
  createHeldOrder,
  customerTicketCount,
  discountUsable,
  findDiscount,
  orderToJson,
  refreshExpired,
  releaseOrder,
  tierAvailable,
  waitlistToJson,
} from "../domain.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIntVal(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function ownOrder(ctx: AppContext, req: Req, customerId: string): Order {
  const order = ctx.store.orders.get(req.params.id ?? "");
  if (!order || order.customerId !== customerId) throw new HttpError(404, "order not found");
  return order;
}

/**
 * Routes: POST /orders, POST /orders/:id/pay, POST /orders/:id/cancel, GET /orders/:id,
 * GET /me/orders, POST /events/:id/waitlist, GET /me/waitlist
 */
export function orderRoutes(): Route[] {
  return [
    {
      method: "POST",
      pattern: "/orders",
      handler: (ctx, req) => {
        const user = requireRole(ctx, req, "customer");
        refreshExpired(ctx);
        const body = req.body;
        if (!isPlainObject(body)) throw new HttpError(400, "body must be an object");
        const { eventId, items, discountCode } = body;
        if (typeof eventId !== "string") throw new HttpError(400, "eventId is required");
        if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, "items must be a non-empty array");
        const parsed: { tierId: string; quantity: number }[] = [];
        const seen = new Set<string>();
        for (const it of items) {
          if (!isPlainObject(it)) throw new HttpError(400, "invalid item");
          const { tierId, quantity } = it;
          if (typeof tierId !== "string") throw new HttpError(400, "tierId is required");
          if (!isIntVal(quantity) || quantity < 1) throw new HttpError(400, "quantity must be an integer >= 1");
          if (seen.has(tierId)) throw new HttpError(400, "duplicate tierId");
          seen.add(tierId);
          parsed.push({ tierId, quantity });
        }
        if (discountCode !== undefined && discountCode !== null && typeof discountCode !== "string") {
          throw new HttpError(400, "discountCode must be a string");
        }
        const event = ctx.store.events.get(eventId);
        if (!event) throw new HttpError(404, "event not found");
        for (const it of parsed) {
          if (!event.tiers.some((t) => t.id === it.tierId)) throw new HttpError(400, "tier does not belong to event");
        }
        const now = ctx.config.now();
        if (event.status !== "on_sale" || event.startsAt <= now) {
          throw new HttpError(409, "event is not on sale");
        }
        for (const it of parsed) {
          if (tierAvailable(ctx, event, it.tierId) < it.quantity) {
            throw new HttpError(409, "not enough tickets available");
          }
        }
        const total = parsed.reduce((s, i) => s + i.quantity, 0);
        if (customerTicketCount(ctx, user.id, event.id) + total > MAX_TICKETS_PER_EVENT) {
          throw new HttpError(422, `at most ${MAX_TICKETS_PER_EVENT} tickets per event`);
        }
        let discount: Discount | null = null;
        if (typeof discountCode === "string") {
          const d = findDiscount(ctx, event.id, discountCode);
          if (!d || !discountUsable(ctx, d)) throw new HttpError(422, "discount code cannot be used");
          discount = d;
        }
        const order = createHeldOrder(ctx, event, user.id, parsed, discount);
        return { status: 201, body: orderToJson(order) };
      },
    },
    {
      method: "POST",
      pattern: "/orders/:id/pay",
      handler: (ctx, req) => {
        const user = requireRole(ctx, req, "customer");
        refreshExpired(ctx);
        const order = ownOrder(ctx, req, user.id);
        const now = ctx.config.now();
        if (order.status !== "held" || order.expiresAt <= now) throw new HttpError(409, "order is not held");
        order.status = "paid";
        order.paidAt = now;
        return { status: 200, body: orderToJson(order) };
      },
    },
    {
      method: "POST",
      pattern: "/orders/:id/cancel",
      handler: (ctx, req) => {
        const user = requireRole(ctx, req, "customer");
        refreshExpired(ctx);
        const order = ownOrder(ctx, req, user.id);
        const now = ctx.config.now();
        if (order.status === "held" && order.expiresAt > now) {
          releaseOrder(ctx, order, "cancelled");
        } else if (order.status === "paid") {
          const event = ctx.store.events.get(order.eventId);
          if (!event || event.startsAt - now <= 24 * 60 * 60 * 1000) {
            throw new HttpError(409, "too late to refund");
          }
          releaseOrder(ctx, order, "refunded");
        } else {
          throw new HttpError(409, "order cannot be cancelled");
        }
        return { status: 200, body: orderToJson(order) };
      },
    },
    {
      method: "GET",
      pattern: "/orders/:id",
      handler: (ctx, req) => {
        const user = authenticate(ctx, req);
        refreshExpired(ctx);
        const order = ctx.store.orders.get(req.params.id ?? "");
        if (!order) throw new HttpError(404, "order not found");
        const event = ctx.store.events.get(order.eventId);
        const allowed = order.customerId === user.id || (event !== undefined && event.organizerId === user.id);
        if (!allowed) throw new HttpError(404, "order not found");
        return { status: 200, body: orderToJson(order) };
      },
    },
    {
      method: "GET",
      pattern: "/me/orders",
      handler: (ctx, req) => {
        const user = requireRole(ctx, req, "customer");
        refreshExpired(ctx);
        const list = [...ctx.store.orders.values()]
          .filter((o) => o.customerId === user.id)
          .sort((a, b) => b.createdAt - a.createdAt || b.createdSeq - a.createdSeq);
        return { status: 200, body: list.map(orderToJson) };
      },
    },
    {
      method: "POST",
      pattern: "/events/:id/waitlist",
      handler: (ctx, req) => {
        const user = requireRole(ctx, req, "customer");
        refreshExpired(ctx);
        const body = req.body;
        if (!isPlainObject(body)) throw new HttpError(400, "body must be an object");
        const { tierId, quantity } = body;
        if (typeof tierId !== "string") throw new HttpError(400, "tierId is required");
        if (!isIntVal(quantity) || quantity < 1 || quantity > MAX_TICKETS_PER_EVENT) {
          throw new HttpError(400, "quantity must be an integer from 1 to 6");
        }
        const event = ctx.store.events.get(req.params.id ?? "");
        if (!event) throw new HttpError(404, "event not found");
        if (!event.tiers.some((t) => t.id === tierId)) throw new HttpError(404, "tier not found");
        if (event.status !== "on_sale" || event.startsAt <= ctx.config.now()) {
          throw new HttpError(409, "event is not on sale");
        }
        if (tierAvailable(ctx, event, tierId) >= quantity) {
          throw new HttpError(409, "tickets are available");
        }
        if (ctx.store.waitlist.some((e) => e.eventId === event.id && e.tierId === tierId && e.customerId === user.id)) {
          throw new HttpError(409, "already waiting for this tier");
        }
        const entry: WaitlistEntry = {
          id: ctx.store.nextId(),
          eventId: event.id,
          tierId,
          customerId: user.id,
          quantity,
          createdSeq: ctx.store.nextSeq(),
        };
        ctx.store.waitlist.push(entry);
        return { status: 201, body: waitlistToJson(ctx, entry) };
      },
    },
    {
      method: "GET",
      pattern: "/me/waitlist",
      handler: (ctx, req) => {
        const user = requireRole(ctx, req, "customer");
        refreshExpired(ctx);
        const list = ctx.store.waitlist.filter((e) => e.customerId === user.id);
        return { status: 200, body: list.map((e) => waitlistToJson(ctx, e)) };
      },
    },
  ];
}
