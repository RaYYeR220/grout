# Box Office API

Built by grout, run `2026-10-31T17-04-28-box-office-api`, candidate B, mode interlocked.

- **Status: GREEN**: all requirements covered by passing tests; clean-room check passed
- Wall time: 906.6 s · model cost: $9.5965 · agents spawned: 35
- Human steps: 0 (see HUMAN_STEPS.md)

## Requirements

| id | requirement | tests | status |
|---|---|---|---|
| R1 | The server listens on the TCP port given by the PORT environment variable. | 1 | pass |
| R2 | HOLD_SECONDS sets how many seconds a held order lasts. The default is 600 seconds. Tests set it to a few seconds. | 2 | pass |
| R3 | All state is kept in memory. There is no database server and no network calls. | 0 | not testable |
| R4 | A request body that is not valid JSON gets 400 with {"error": <string>}. Responses are JSON (application/json). | 2 | pass |
| R5 | Every error response has a non-2xx status code and a JSON body {"error": "<message>"}. The message can be any string. | 1 | pass |
| R6 | A request to a route that does not exist (unknown path or method) gets 404 with an error body. | 2 | pass |
| R7 | Every money amount (priceCents, unitPriceCents, subtotalCents, discountCents, totalCents, amountOffCents, grossCents, refundedCents, netCents) is an integer number of cents. | 2 | pass |
| R8 | Request times (startsAt, from, to, discount expiresAt) accept any string that Date.parse can read. Every time in a response is formatted with Date.prototype.toISOString() in UTC, e.g. 2026-11-02T18:00:00.000Z. | 3 | pass |
| R9 | Every id (user, event, tier, order, waitlist entry) is a string. No id appears twice anywhere in the API, across all entity types. | 1 | pass |
| R10 | Checks run in a fixed order, and the first one that fails sets the status: missing/invalid token 401, wrong role 403, invalid input 400, named resource not found 404, caller not allowed to touch the resource 403, wrong state 409, limits 422. | 7 | pass |
| R11 | POST /users with {email, password, name, role} creates a user and returns 201 {id, email, name, role}. No auth is needed. | 1 | pass |
| R12 | role must be exactly "organizer" or "customer". Any other value, or a missing role, gets 400. | 3 | pass |
| R13 | email must be a string that contains an '@' with a '.' somewhere after it. Otherwise 400. | 1 | pass |
| R14 | password must be a string of at least 8 characters. Otherwise 400. | 2 | pass |
| R15 | name must be a string of 1 to 100 characters. Otherwise (empty, longer than 100, missing, not a string) 400. | 1 | pass |
| R16 | Registering an email that is already registered gets 409. Emails are compared case-insensitively. | 1 | pass |
| R17 | No response from any endpoint contains the password, or a password field of any kind. | 1 | pass |
| R18 | POST /sessions with {email, password} for a registered user returns 200 {token}, where token is a string. | 1 | pass |
| R19 | POST /sessions with an unknown email or a wrong password gets 401. | 1 | pass |
| R20 | 🔒 endpoints need the header 'Authorization: Bearer <token>'. A missing, malformed or invalid token gets 401. | 3 | pass |
| R21 | Calling a role-restricted 🔒 endpoint with the other role's valid token gets 403. For example, a customer calling POST /events, or an organizer calling POST /orders. | 1 | pass |
| R22 | 🔒 GET /me returns 200 with the caller's user {id, email, name, role}. Any role may call it. | 1 | pass |
| R23 | An event is {id, title, venue, startsAt, status, organizerId, tiers:[{id, name, priceCents, quantity, available}]}. status is "on_sale" or "cancelled". | 2 | pass |
| R24 | A tier's available = quantity minus the tickets for that tier in held (unexpired) and paid orders. | 1 | pass |
| R25 | 🔒 organizer POST /events {title, venue, startsAt, tiers:[{name, priceCents, quantity}]} returns 201 with the created event. status is "on_sale", organizerId is the caller's id, every tier gets an id, and each tier's available equals its quantity. | 1 | pass |
| R26 | POST /events: title and venue must each be strings of 1 to 100 characters. Otherwise 400. | 3 | pass |
| R27 | POST /events: startsAt must be parseable by Date.parse and later than now. A past time or an unparseable value gets 400. | 1 | pass |
| R28 | POST /events: tiers must be an array of 1 to 5 tiers. Zero tiers, more than 5 tiers, or a missing array gets 400. | 3 | pass |
| R29 | POST /events: tier names must be unique within the event. A repeated name gets 400. | 1 | pass |
| R30 | POST /events: each tier's priceCents must be an integer ≥ 0. Negatives, non-integers and non-numbers get 400. 0 is allowed. | 1 | pass |
| R31 | POST /events: each tier's quantity must be an integer from 1 to 10000 inclusive. Otherwise 400. | 1 | pass |
| R32 | GET /events is public (no token) and returns 200 {items, page, pageSize, total}. items is an array of event objects. | 1 | pass |
| R33 | GET /events lists only events with status on_sale. Items are sorted by startsAt ascending, then by title ascending. | 1 | pass |
| R34 | GET /events optional query params from and to keep only events whose startsAt is within [from, to], inclusive at both ends. Either one may be given alone. | 1 | pass |
| R35 | GET /events optional query param q keeps only events whose title or venue contains q as a substring, compared case-insensitively. | 1 | pass |
| R36 | GET /events pagination: page defaults to 1 and pageSize defaults to 10, with a maximum of 50. The response echoes page and pageSize, and items holds that page's slice of the sorted results. | 3 | pass |
| R37 | GET /events: an invalid query value gets 400. Invalid means: from/to not parseable as dates, page not an integer ≥ 1, pageSize not an integer from 1 to 50 (e.g. 51). | 1 | pass |
| R38 | total is the number of all events matching the filters, not just the ones on the current page. | 1 | pass |
| R39 | GET /events/:id is public and returns 200 with the event, including cancelled events. An unknown id gets 404. | 1 | pass |
| R40 | 🔒 organizer POST /events/:id/cancel returns 200 with the event, whose status is now "cancelled". An unknown event gets 404. A customer gets 403. | 2 | pass |
| R41 | Only the organizer who created the event may cancel it. Any other organizer gets 403. An already cancelled event gets 409. | 1 | pass |
| R42 | Cancelling an event turns every paid order for it into refunded and every held order into cancelled, and empties the event's waitlist (those entries no longer appear in GET /me/waitlist). | 1 | pass |
| R43 | An order is {id, eventId, customerId, status, items:[{tierId, quantity, unitPriceCents}], subtotalCents, discountCode, discountCents, totalCents, createdAt, expiresAt, paidAt}. status is one of held, paid, expired, cancelled, refunded. discountCode is null when no code is used. paidAt is null until the order is paid. unitPriceCents is the tier's priceCents. subtotalCents = sum of quantity × unitPriceCents. | 1 | pass |
| R44 | 🔒 customer POST /orders {eventId, items:[{tierId, quantity}], discountCode?} returns 201 with the order: status held, customerId = the caller. The order's tickets stop counting as available. | 1 | pass |
| R45 | POST /orders gets 400 unless items is a non-empty array, no tierId appears twice, and every quantity is an integer ≥ 1. | 1 | pass |
| R46 | POST /orders for an unknown eventId gets 404. A tierId that does not belong to that event gets 400. | 1 | pass |
| R47 | POST /orders gets 409 if the event is cancelled or its startsAt has already passed. | 2 | pass |
| R48 | If any requested tier has fewer available tickets than the requested quantity, POST /orders gets 409 and nothing is held: availability is unchanged for all tiers. | 1 | pass |
| R49 | A customer may hold or own at most 6 tickets per event, counting tickets in their held and paid orders plus the new order. An order that would go over 6 gets 422. | 1 | pass |
| R50 | POST /orders with a discountCode that cannot be used (see R65) gets 422. | 2 | pass |
| R51 | An order's createdAt is its creation time, and expiresAt = createdAt + HOLD_SECONDS seconds. | 3 | pass |
| R52 | A held order whose expiresAt has passed has status expired in every response. Its tickets count as available again, and expiry triggers waitlist serving (R72). Expiry may be computed lazily, but every response must reflect it. | 2 | pass |
| R53 | 🔒 customer POST /orders/:id/pay returns 200 with the order: status paid and paidAt set to the payment time (ISO string). | 1 | pass |
| R54 | POST /orders/:id/pay on an order owned by another customer, or an unknown order, gets 404. An order that is not held (including one that has expired) gets 409. | 1 | pass |
| R55 | 🔒 customer POST /orders/:id/cancel returns 200 with the order. A held order becomes cancelled, and its tickets are released and its discount use given back. | 2 | pass |
| R56 | Cancelling a paid order makes it refunded (200), but only if the event's startsAt is more than 24 hours from now. If startsAt is 24 hours away or less, the response is 409. | 2 | pass |
| R57 | POST /orders/:id/cancel on an order with any other status (expired, cancelled, refunded) gets 409. Someone else's order, or an unknown order, gets 404. | 2 | pass |
| R58 | 🔒 GET /orders/:id returns 200 with the order to the customer who placed it or to the organizer of the order's event. Anyone else, and an unknown id, gets 404. | 1 | pass |
| R59 | 🔒 customer GET /me/orders returns 200 with an array of all the caller's orders, newest (by createdAt) first. This includes orders created from the waitlist. | 2 | pass |
| R60 | 🔒 organizer POST /events/:id/discounts {code, percentOff?, amountOffCents?, maxUses?, expiresAt?} returns 201 {code, percentOff, amountOffCents, maxUses, expiresAt, uses}. Fields not given are null, code is upper case, uses starts at 0, and expiresAt is an ISO string. An unknown event gets 404. | 2 | pass |
| R61 | Only the event's organizer may create discount codes. Another organizer gets 403. | 1 | pass |
| R62 | Discount creation gets 400 unless exactly one of percentOff (integer 1–100) and amountOffCents (integer ≥ 1) is given. Both given, neither given, or out of range gets 400. | 1 | pass |
| R63 | Discount code must be 3–20 characters, letters and digits only. Otherwise 400. | 1 | pass |
| R64 | maxUses, if given, must be an integer ≥ 1. Otherwise 400. An invalid expiresAt (not parseable) gets 400. | 1 | pass |
| R65 | Codes are stored upper case and matched case-insensitively. Creating a code the event already has, in any case, gets 409. | 1 | pass |
| R66 | At checkout a code gets 422 if the event does not have it (including codes that belong to another event), its expiresAt has passed, or its uses have reached maxUses. | 3 | pass |
| R67 | A code's uses = the number of the event's orders with that code whose status is held or paid. When an order expires or is cancelled it gives its use back, which frees up maxUses. | 2 | pass |
| R68 | discountCents = floor(subtotalCents × percentOff / 100) for a percent code, or min(amountOffCents, subtotalCents) for an amount code. totalCents = subtotalCents − discountCents. With no code, discountCents = 0 and totalCents = subtotalCents. | 1 | pass |
| R69 | 🔒 customer POST /events/:id/waitlist {tierId, quantity} returns 201 {id, eventId, tierId, quantity, position}. An unknown event gets 404. | 1 | pass |
| R70 | Waitlist quantity must be an integer from 1 to 6. Otherwise 400. | 1 | pass |
| R71 | Joining a waitlist is allowed only when the tier's available count is less than quantity. Otherwise 409. If the same customer is already waiting for that tier, 409. | 1 | pass |
| R72 | position is the entry's 1-based place in line for that tier. The first entry is 1, the next 2, and so on. | 1 | pass |
| R73 | When tickets in a tier become available again (an order expires, is cancelled or refunded), the tier's waitlist is served strictly in order. While the first entry's quantity ≤ available, its customer gets a new held order for that tier and quantity (no discount code, normal expiresAt) and the entry leaves the list. If the first entry doesn't fit, nobody behind it is served. | 3 | pass |
| R74 | If serving an entry would take its customer over 6 tickets for the event (held + paid), the entry is removed without creating an order and serving continues with the next entry. | 1 | pass |
| R75 | 🔒 customer GET /me/waitlist returns 200 with an array of the caller's current waitlist entries {id, eventId, tierId, quantity, position}, each showing its current position, which updates as earlier entries leave. | 2 | pass |
| R76 | 🔒 organizer GET /events/:id/report returns 200 {eventId, tiers:[{tierId, name, sold, held, available}], grossCents, discountCents, refundedCents, netCents}. An unknown event gets 404. | 2 | pass |
| R77 | Only the event's organizer may see its report. Another organizer gets 403, and a customer gets 403 (role). | 1 | pass |
| R78 | Report tier sold = tickets of that tier in paid orders. held = tickets in held, non-expired orders. available matches the event's tier available. | 1 | pass |
| R79 | grossCents = sum of subtotalCents over paid orders. discountCents = sum of discountCents over paid orders. netCents = sum of totalCents over paid orders. refundedCents = sum of totalCents over refunded orders. | 1 | pass |

## Run it

```
npm ci
npm run build
npm test
```

The program is invoked as: `npm start` (tests run `npm start --silent --`).

The full trace of the run is in `grout-run/trace.jsonl`, the report in `grout-run/report.html`.
