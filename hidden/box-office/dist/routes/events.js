import { HttpError } from "../types.js";
import { requireRole } from "../auth.js";
import { badRequest, bodyObject, isInt, isStrLen, parseTime } from "../util.js";
import { cancelEventCascade, discountToJson, eventToJson, findDiscount, tierAvailable, tierCount, } from "../domain.js";
function getEvent(ctx, id) {
    const ev = ctx.store.events.get(id);
    if (!ev)
        throw new HttpError(404, "event not found");
    return ev;
}
function parsePositiveIntParam(v, name, max) {
    if (v === null)
        return null;
    if (!/^\+?\d+$/.test(v.trim()))
        badRequest(`invalid ${name}`);
    const n = Number(v.trim());
    if (!Number.isSafeInteger(n) || n < 1 || (max !== undefined && n > max))
        badRequest(`invalid ${name}`);
    return n;
}
function given(v) {
    return v !== undefined && v !== null;
}
/**
 * Routes: POST /events, GET /events, GET /events/:id, POST /events/:id/cancel,
 * POST /events/:id/discounts, GET /events/:id/report
 */
export function eventRoutes() {
    return [
        {
            method: "POST",
            pattern: "/events",
            handler: (ctx, req) => {
                const user = requireRole(ctx, req, "organizer");
                const body = bodyObject(req.body);
                const { title, venue, startsAt, tiers } = body;
                if (!isStrLen(title, 1, 100))
                    badRequest("title must be 1-100 characters");
                if (!isStrLen(venue, 1, 100))
                    badRequest("venue must be 1-100 characters");
                const start = parseTime(startsAt);
                if (start === null || start <= ctx.config.now())
                    badRequest("startsAt must be in the future");
                if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 5)
                    badRequest("there must be 1-5 tiers");
                const names = new Set();
                const newTiers = [];
                for (const t of tiers) {
                    if (typeof t !== "object" || t === null || Array.isArray(t))
                        badRequest("invalid tier");
                    const tr = t;
                    if (typeof tr.name !== "string" || tr.name.length < 1)
                        badRequest("tier name required");
                    if (names.has(tr.name))
                        badRequest("tier names must be unique");
                    names.add(tr.name);
                    if (!isInt(tr.priceCents) || tr.priceCents < 0)
                        badRequest("priceCents must be an integer >= 0");
                    if (!isInt(tr.quantity) || tr.quantity < 1 || tr.quantity > 10000)
                        badRequest("quantity must be an integer from 1 to 10000");
                    newTiers.push({ id: "", name: tr.name, priceCents: tr.priceCents, quantity: tr.quantity });
                }
                const id = ctx.store.nextId();
                for (const t of newTiers)
                    t.id = ctx.store.nextId();
                const ev = {
                    id,
                    title,
                    venue,
                    startsAt: start,
                    status: "on_sale",
                    organizerId: user.id,
                    tiers: newTiers,
                    createdSeq: ctx.store.nextSeq(),
                };
                ctx.store.events.set(id, ev);
                return { status: 201, body: eventToJson(ctx, ev) };
            },
        },
        {
            method: "GET",
            pattern: "/events",
            handler: (ctx, req) => {
                const q = req.query;
                let from = null;
                let to = null;
                const fromS = q.get("from");
                if (fromS !== null) {
                    from = parseTime(fromS);
                    if (from === null)
                        badRequest("invalid from");
                }
                const toS = q.get("to");
                if (toS !== null) {
                    to = parseTime(toS);
                    if (to === null)
                        badRequest("invalid to");
                }
                const page = parsePositiveIntParam(q.get("page"), "page") ?? 1;
                const pageSize = parsePositiveIntParam(q.get("pageSize"), "pageSize", 50) ?? 10;
                const search = q.get("q");
                const needle = search !== null && search !== "" ? search.toLowerCase() : null;
                const matches = [...ctx.store.events.values()].filter((e) => {
                    if (e.status !== "on_sale")
                        return false;
                    if (from !== null && e.startsAt < from)
                        return false;
                    if (to !== null && e.startsAt > to)
                        return false;
                    if (needle !== null && !e.title.toLowerCase().includes(needle) && !e.venue.toLowerCase().includes(needle))
                        return false;
                    return true;
                });
                matches.sort((a, b) => {
                    if (a.startsAt !== b.startsAt)
                        return a.startsAt - b.startsAt;
                    if (a.title < b.title)
                        return -1;
                    if (a.title > b.title)
                        return 1;
                    return a.createdSeq - b.createdSeq;
                });
                const startIdx = (page - 1) * pageSize;
                const items = matches.slice(startIdx, startIdx + pageSize).map((e) => eventToJson(ctx, e));
                return { status: 200, body: { items, page, pageSize, total: matches.length } };
            },
        },
        {
            method: "GET",
            pattern: "/events/:id",
            handler: (ctx, req) => {
                const ev = getEvent(ctx, req.params.id ?? "");
                return { status: 200, body: eventToJson(ctx, ev) };
            },
        },
        {
            method: "POST",
            pattern: "/events/:id/cancel",
            handler: (ctx, req) => {
                const user = requireRole(ctx, req, "organizer");
                const ev = getEvent(ctx, req.params.id ?? "");
                if (ev.organizerId !== user.id)
                    throw new HttpError(403, "not your event");
                if (ev.status === "cancelled")
                    throw new HttpError(409, "event already cancelled");
                cancelEventCascade(ctx, ev);
                ev.status = "cancelled";
                return { status: 200, body: eventToJson(ctx, ev) };
            },
        },
        {
            method: "POST",
            pattern: "/events/:id/discounts",
            handler: (ctx, req) => {
                const user = requireRole(ctx, req, "organizer");
                const body = bodyObject(req.body);
                const { code, percentOff, amountOffCents, maxUses, expiresAt } = body;
                if (typeof code !== "string" || !/^[A-Za-z0-9]{3,20}$/.test(code))
                    badRequest("code must be 3-20 letters and digits");
                const hasPct = given(percentOff);
                const hasAmt = given(amountOffCents);
                if (hasPct === hasAmt)
                    badRequest("exactly one of percentOff and amountOffCents is required");
                if (hasPct && (!isInt(percentOff) || percentOff < 1 || percentOff > 100))
                    badRequest("percentOff must be an integer 1-100");
                if (hasAmt && (!isInt(amountOffCents) || amountOffCents < 1))
                    badRequest("amountOffCents must be an integer >= 1");
                if (given(maxUses) && (!isInt(maxUses) || maxUses < 1))
                    badRequest("maxUses must be an integer >= 1");
                let exp = null;
                if (given(expiresAt)) {
                    exp = parseTime(expiresAt);
                    if (exp === null)
                        badRequest("invalid expiresAt");
                }
                const ev = getEvent(ctx, req.params.id ?? "");
                if (ev.organizerId !== user.id)
                    throw new HttpError(403, "not your event");
                const upper = code.toUpperCase();
                if (findDiscount(ctx, ev.id, upper))
                    throw new HttpError(409, "code already exists");
                const discount = {
                    eventId: ev.id,
                    code: upper,
                    percentOff: hasPct ? percentOff : null,
                    amountOffCents: hasAmt ? amountOffCents : null,
                    maxUses: given(maxUses) ? maxUses : null,
                    expiresAt: exp,
                };
                let m = ctx.store.discounts.get(ev.id);
                if (!m) {
                    m = new Map();
                    ctx.store.discounts.set(ev.id, m);
                }
                m.set(upper, discount);
                return { status: 201, body: discountToJson(ctx, discount) };
            },
        },
        {
            method: "GET",
            pattern: "/events/:id/report",
            handler: (ctx, req) => {
                const user = requireRole(ctx, req, "organizer");
                const ev = getEvent(ctx, req.params.id ?? "");
                if (ev.organizerId !== user.id)
                    throw new HttpError(403, "not your event");
                const tiers = ev.tiers.map((t) => ({
                    tierId: t.id,
                    name: t.name,
                    sold: tierCount(ctx, ev.id, t.id, "paid"),
                    held: tierCount(ctx, ev.id, t.id, "held"),
                    available: tierAvailable(ctx, ev, t.id),
                }));
                let grossCents = 0;
                let discountCents = 0;
                let netCents = 0;
                let refundedCents = 0;
                for (const o of ctx.store.orders.values()) {
                    if (o.eventId !== ev.id)
                        continue;
                    if (o.status === "paid") {
                        grossCents += o.subtotalCents;
                        discountCents += o.discountCents;
                        netCents += o.totalCents;
                    }
                    else if (o.status === "refunded") {
                        refundedCents += o.totalCents;
                    }
                }
                return {
                    status: 200,
                    body: { eventId: ev.id, tiers, grossCents, discountCents, refundedCents, netCents },
                };
            },
        },
    ];
}
