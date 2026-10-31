import { MAX_TICKETS_PER_EVENT } from "./types.js";
function iso(ms) {
    return new Date(ms).toISOString();
}
/** A held order counts as active only while unexpired. */
function isActive(ctx, o) {
    if (o.status === "paid")
        return true;
    if (o.status === "held")
        return o.expiresAt > ctx.config.now();
    return false;
}
/**
 * Lazily expires every held order whose expiresAt <= now (in expiresAt order),
 * setting status "expired", then serves the waitlist of each affected tier.
 * Called by the HTTP dispatcher before every handler; safe to call any time.
 */
export function refreshExpired(ctx) {
    const now = ctx.config.now();
    const due = [...ctx.store.orders.values()]
        .filter((o) => o.status === "held" && o.expiresAt <= now)
        .sort((a, b) => a.expiresAt - b.expiresAt || a.createdSeq - b.createdSeq);
    for (const o of due) {
        if (o.status === "held")
            releaseOrder(ctx, o, "expired");
    }
}
/** quantity minus tickets for that tier in held and paid orders. */
export function tierAvailable(ctx, event, tierId) {
    const tier = event.tiers.find((t) => t.id === tierId);
    if (!tier)
        return 0;
    let used = 0;
    for (const o of ctx.store.orders.values()) {
        if (o.eventId !== event.id || !isActive(ctx, o))
            continue;
        for (const it of o.items)
            if (it.tierId === tierId)
                used += it.quantity;
    }
    return Math.max(0, tier.quantity - used);
}
/** Tickets of a tier in orders with the given status. */
export function tierCount(ctx, eventId, tierId, status) {
    let n = 0;
    for (const o of ctx.store.orders.values()) {
        if (o.eventId !== eventId || o.status !== status)
            continue;
        for (const it of o.items)
            if (it.tierId === tierId)
                n += it.quantity;
    }
    return n;
}
export function eventToJson(ctx, event) {
    return {
        id: event.id,
        title: event.title,
        venue: event.venue,
        startsAt: iso(event.startsAt),
        status: event.status,
        organizerId: event.organizerId,
        tiers: event.tiers.map((t) => ({
            id: t.id,
            name: t.name,
            priceCents: t.priceCents,
            quantity: t.quantity,
            available: tierAvailable(ctx, event, t.id),
        })),
    };
}
export function orderToJson(order) {
    return {
        id: order.id,
        eventId: order.eventId,
        customerId: order.customerId,
        status: order.status,
        items: order.items.map((i) => ({ tierId: i.tierId, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
        subtotalCents: order.subtotalCents,
        discountCode: order.discountCode,
        discountCents: order.discountCents,
        totalCents: order.totalCents,
        createdAt: iso(order.createdAt),
        expiresAt: iso(order.expiresAt),
        paidAt: order.paidAt === null ? null : iso(order.paidAt),
    };
}
/** Tickets the customer has in held + paid orders for the event. */
export function customerTicketCount(ctx, customerId, eventId) {
    let n = 0;
    for (const o of ctx.store.orders.values()) {
        if (o.eventId !== eventId || o.customerId !== customerId || !isActive(ctx, o))
            continue;
        for (const it of o.items)
            n += it.quantity;
    }
    return n;
}
/** Looks up a discount for the event, case-insensitively. */
export function findDiscount(ctx, eventId, code) {
    return ctx.store.discounts.get(eventId)?.get(code.toUpperCase());
}
/** Number of the event's held or paid orders using this code. */
export function discountUses(ctx, discount) {
    let n = 0;
    const code = discount.code.toUpperCase();
    for (const o of ctx.store.orders.values()) {
        if (o.eventId !== discount.eventId || !isActive(ctx, o))
            continue;
        if (o.discountCode !== null && o.discountCode.toUpperCase() === code)
            n++;
    }
    return n;
}
/** True if not expired (expiresAt null or > now) and uses < maxUses (or maxUses null). */
export function discountUsable(ctx, discount) {
    if (discount.expiresAt !== null && discount.expiresAt <= ctx.config.now())
        return false;
    if (discount.maxUses !== null && discountUses(ctx, discount) >= discount.maxUses)
        return false;
    return true;
}
export function discountToJson(ctx, discount) {
    return {
        code: discount.code,
        percentOff: discount.percentOff,
        amountOffCents: discount.amountOffCents,
        maxUses: discount.maxUses,
        expiresAt: discount.expiresAt === null ? null : iso(discount.expiresAt),
        uses: discountUses(ctx, discount),
    };
}
/** floor(subtotal*percentOff/100) or min(amountOffCents, subtotal); 0 when discount is null. */
export function computeDiscountCents(subtotalCents, discount) {
    if (!discount)
        return 0;
    if (discount.percentOff !== null && discount.percentOff !== undefined) {
        return Math.min(subtotalCents, Math.floor((subtotalCents * discount.percentOff) / 100));
    }
    if (discount.amountOffCents !== null && discount.amountOffCents !== undefined) {
        return Math.min(discount.amountOffCents, subtotalCents);
    }
    return 0;
}
/**
 * Creates and stores a new held order WITHOUT validation (callers validate first).
 * unitPriceCents from tiers, createdAt = now, expiresAt = now + holdSeconds*1000.
 */
export function createHeldOrder(ctx, event, customerId, items, discount) {
    const now = ctx.config.now();
    const orderItems = items.map((i) => {
        const tier = event.tiers.find((t) => t.id === i.tierId);
        return { tierId: i.tierId, quantity: i.quantity, unitPriceCents: tier ? tier.priceCents : 0 };
    });
    const subtotalCents = orderItems.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0);
    const discountCents = computeDiscountCents(subtotalCents, discount);
    const order = {
        id: ctx.store.nextId(),
        eventId: event.id,
        customerId,
        status: "held",
        items: orderItems,
        subtotalCents,
        discountCode: discount ? discount.code : null,
        discountCents,
        totalCents: subtotalCents - discountCents,
        createdAt: now,
        expiresAt: now + ctx.config.holdSeconds * 1000,
        paidAt: null,
        createdSeq: ctx.store.nextSeq(),
    };
    ctx.store.orders.set(order.id, order);
    return order;
}
/**
 * Sets a held/paid order to a releasing status ("cancelled" | "refunded" | "expired")
 * and then serves the waitlist of each of its tiers (unless serveWaitlist is false).
 */
export function releaseOrder(ctx, order, status, serveWaitlist) {
    order.status = status;
    if (serveWaitlist === false)
        return;
    const tierIds = [...new Set(order.items.map((i) => i.tierId))];
    for (const t of tierIds)
        serveWaitlistFn(ctx, order.eventId, t);
}
/**
 * Serves the tier's waitlist strictly in order: while the first entry fits in available,
 * create a held order (no discount) and remove the entry; an entry that would take its
 * customer over 6 tickets for the event is removed without an order. Stops at the first
 * entry that does not fit. Does nothing if the event is not on_sale.
 */
export function serveWaitlist(ctx, eventId, tierId) {
    const event = ctx.store.events.get(eventId);
    if (!event || event.status !== "on_sale")
        return;
    for (;;) {
        const entry = ctx.store.waitlist.find((e) => e.eventId === eventId && e.tierId === tierId);
        if (!entry)
            return;
        if (customerTicketCount(ctx, entry.customerId, eventId) + entry.quantity > MAX_TICKETS_PER_EVENT) {
            removeEntry(ctx, entry);
            continue;
        }
        if (entry.quantity > tierAvailable(ctx, event, tierId))
            return;
        removeEntry(ctx, entry);
        createHeldOrder(ctx, event, entry.customerId, [{ tierId, quantity: entry.quantity }], null);
    }
}
const serveWaitlistFn = serveWaitlist;
function removeEntry(ctx, entry) {
    const idx = ctx.store.waitlist.indexOf(entry);
    if (idx >= 0)
        ctx.store.waitlist.splice(idx, 1);
}
/**
 * Cancels an event: status "cancelled", paid orders → refunded, held → cancelled
 * (without serving waitlists), and removes all its waitlist entries.
 */
export function cancelEventCascade(ctx, event) {
    refreshExpired(ctx);
    event.status = "cancelled";
    for (const o of ctx.store.orders.values()) {
        if (o.eventId !== event.id)
            continue;
        if (o.status === "paid")
            releaseOrder(ctx, o, "refunded", false);
        else if (o.status === "held")
            releaseOrder(ctx, o, "cancelled", false);
    }
    const remaining = ctx.store.waitlist.filter((e) => e.eventId !== event.id);
    ctx.store.waitlist.length = 0;
    ctx.store.waitlist.push(...remaining);
}
/** 1-based position of the entry among entries for the same event+tier. */
export function waitlistPosition(ctx, entry) {
    let pos = 0;
    for (const e of ctx.store.waitlist) {
        if (e.eventId === entry.eventId && e.tierId === entry.tierId) {
            pos++;
            if (e === entry || e.id === entry.id)
                return pos;
        }
    }
    return pos + 1;
}
export function waitlistToJson(ctx, entry) {
    return {
        id: entry.id,
        eventId: entry.eventId,
        tierId: entry.tierId,
        quantity: entry.quantity,
        position: waitlistPosition(ctx, entry),
    };
}
