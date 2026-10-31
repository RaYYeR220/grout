# Box Office API

An HTTP JSON API for selling tickets to events: accounts, events with ticket tiers, orders that hold tickets for a while before they're paid, discount codes, a waitlist for sold-out tiers, and a sales report.

## Running it

- Your factory's output goes in `hidden/box-office/` in your repo: a standalone TypeScript project.
- We run, in that folder, on Node 22: `npm install`, then `npm run build` if there is one, then `npm start`.
- The server listens on the port in the `PORT` environment variable.
- `HOLD_SECONDS` (default `600`) is how long a held order lasts. Our tests set it to a few seconds.
- Keep everything in memory. No database server, no network calls.

## Conventions

- Request and response bodies are JSON. A body that isn't valid JSON is `400`.
- Every error is a status code with a body `{"error": "<any message>"}`. An unknown route is `404`.
- Money is always an integer number of cents.
- Times are ISO 8601 in UTC. In requests, anything `Date.parse` reads is accepted; responses always use `toISOString()` (`2026-11-02T18:00:00.000Z`).
- Ids are strings, unique across the whole API.
- Checks run in this order, and the first that fails decides the status: the token (`401`), the caller's role (`403`), the request's input (`400`), the things it names (`404`), whether the caller may touch them (`403`), their state (`409`), limits (`422`).

## 1. Accounts

- `POST /users` `{ email, password, name, role }` → `201` `{ id, email, name, role }`
  - `role` is `"organizer"` or `"customer"`. `email` must contain an `@` with a `.` somewhere after it. `password` has at least 8 characters. `name` is 1–100 characters. Anything else is `400`.
  - An email already registered (compared case-insensitively) is `409`.
  - A password is never returned, by any endpoint.
- `POST /sessions` `{ email, password }` → `200` `{ token }`. Wrong email or password is `401`.
- Endpoints marked 🔒 need `Authorization: Bearer <token>`; without a valid token they are `401`. One for a role the caller doesn't have is `403`.
- 🔒 `GET /me` → `200` the caller's user.

## 2. Events

An event: `{ id, title, venue, startsAt, status, organizerId, tiers: [{ id, name, priceCents, quantity, available }] }`. `status` is `"on_sale"` or `"cancelled"`. `available` is the tier's quantity minus its tickets in held and paid orders.

- 🔒 organizer `POST /events` `{ title, venue, startsAt, tiers: [{ name, priceCents, quantity }] }` → `201` the event, `on_sale`.
  - `400` unless: `title` and `venue` are 1–100 characters; `startsAt` is in the future; there are 1–5 tiers; tier names are unique within the event; `priceCents` is an integer ≥ 0; `quantity` is an integer from 1 to 10000.
- `GET /events` (public) → `200` `{ items, page, pageSize, total }`
  - Only events on sale. Sorted by `startsAt`, then `title`.
  - Optional query: `from` and `to` (only events with `startsAt` within them, inclusive), `q` (case-insensitive substring of the title or the venue), `page` (default 1), `pageSize` (default 10, at most 50). A value that isn't valid is `400`.
  - `total` counts all matching events, not just this page.
- `GET /events/:id` (public) → `200` the event, cancelled ones too. Unknown: `404`.
- 🔒 organizer `POST /events/:id/cancel` → `200` the event, now `cancelled`.
  - Only the organizer who created it (`403` for any other organizer). Already cancelled: `409`.
  - Every paid order for it becomes `refunded`, every held one `cancelled`, and its waitlist is emptied.

## 3. Orders

An order: `{ id, eventId, customerId, status, items: [{ tierId, quantity, unitPriceCents }], subtotalCents, discountCode, discountCents, totalCents, createdAt, expiresAt, paidAt }`. `status` is `"held"`, `"paid"`, `"expired"`, `"cancelled"` or `"refunded"`. `discountCode` and `paidAt` are `null` until they apply.

- 🔒 customer `POST /orders` `{ eventId, items: [{ tierId, quantity }], discountCode? }` → `201` the order, `held`.
  - `400` unless there is at least one item, no tier appears twice, and every quantity is an integer ≥ 1.
  - Unknown event: `404`. A tier that isn't the event's: `400`.
  - The event isn't on sale or has already started: `409`. Not enough tickets left in any one tier: `409`, and nothing is held.
  - One customer holds or owns at most **6 tickets per event**, counting held and paid orders: more is `422`.
  - A discount code that can't be used (section 4): `422`.
  - `expiresAt` is `createdAt` plus `HOLD_SECONDS`.
- A held order past its `expiresAt` is `expired`, and its tickets are available again. It's fine to work this out lazily, as long as every response reflects it.
- 🔒 customer `POST /orders/:id/pay` → `200` the order, `paid`, with `paidAt`.
  - Someone else's order: `404`. Not `held` (including expired): `409`.
- 🔒 customer `POST /orders/:id/cancel` → `200` the order.
  - `held` becomes `cancelled`. `paid` becomes `refunded`, but only while the event starts more than 24 hours from now; later it's `409`. Any other status: `409`. Someone else's order: `404`.
- 🔒 `GET /orders/:id` → `200` the order, for the customer who placed it or the event's organizer. Anyone else: `404`.
- 🔒 customer `GET /me/orders` → `200` an array of the caller's orders, newest first.

## 4. Discount codes

- 🔒 organizer `POST /events/:id/discounts` `{ code, percentOff?, amountOffCents?, maxUses?, expiresAt? }` → `201` `{ code, percentOff, amountOffCents, maxUses, expiresAt, uses }` (absent ones are `null`).
  - Only the event's organizer (`403`). `400` unless: exactly one of `percentOff` (integer 1–100) and `amountOffCents` (integer ≥ 1) is given; `code` is 3–20 letters and digits; `maxUses`, if given, is an integer ≥ 1.
  - Codes are stored in upper case and matched case-insensitively. A code the event already has: `409`.
- At checkout a code is unusable (`422`) if the event doesn't have it, it has expired, or it's used up.
- `uses` counts the event's orders with that code that are `held` or `paid`; an order that expires or is cancelled gives its use back.
- `discountCents` is `floor(subtotalCents × percentOff / 100)`, or `min(amountOffCents, subtotalCents)`. `totalCents = subtotalCents − discountCents`.

## 5. Waitlist

- 🔒 customer `POST /events/:id/waitlist` `{ tierId, quantity }` → `201` `{ id, eventId, tierId, quantity, position }`
  - `quantity` is 1–6 (`400`). Only when the tier has fewer than `quantity` tickets available: otherwise `409`. The same customer already waiting for that tier: `409`.
  - `position` is 1 for the first in line for that tier.
- Whenever tickets in a tier become available again (an order expires, is cancelled or refunded), its waitlist is served **strictly in order**: while the first entry's quantity fits, that customer gets a new `held` order for it (no discount code) and leaves the list. If the first entry doesn't fit, nobody behind it is served.
  - If serving an entry would take its customer over 6 tickets for the event, that entry is removed without an order, and serving continues.
- 🔒 customer `GET /me/waitlist` → `200` an array of the caller's entries, each with its current `position`.

## 6. Report

- 🔒 organizer `GET /events/:id/report` → `200` `{ eventId, tiers: [{ tierId, name, sold, held, available }], grossCents, discountCents, refundedCents, netCents }`
  - Only the event's organizer (`403`).
  - `sold` counts tickets in paid orders, `held` in held ones.
  - `grossCents` and `discountCents` sum `subtotalCents` and `discountCents` over paid orders; `netCents` sums their `totalCents`; `refundedCents` sums `totalCents` over refunded orders.
