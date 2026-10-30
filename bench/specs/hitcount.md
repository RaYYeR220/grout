# hitcount

Named counters over HTTP, with a per-client rate limit on increments. We use it to count page views from a few internal tools without letting one of them flood it.

## Running

Start it with `node dist/index.js`. It listens on the port in the `HTTP_PORT` environment variable (default `8000`). Two more environment variables set the limit: `RATE_LIMIT`, the number of increments a client may make per window (default `5`), and `RATE_WINDOW_MS`, the window length in milliseconds (default `1000`). State is kept in memory.

Every response with a body is JSON with `Content-Type: application/json`. Errors have the body `{"error": "<message>"}`.

## Counters

A counter name is 1 to 64 characters from `a`-`z`, `0`-`9` and `-`. A path with any other name gives `400 {"error": "invalid counter name"}`. Every counter starts at 0; there is nothing to create first.

- `POST /counters/:name` adds 1 to the counter: `200 {"name": "<name>", "value": <new value>}`. Rate limited, see below.
- `GET /counters/:name`: `200 {"name": "<name>", "value": <value>}`; a counter that was never incremented has the value `0`.
- `DELETE /counters/:name` sets the counter back to 0: `204` with an empty body.
- `GET /counters`: `200 {"counters": [{"name": "<name>", "value": <value>}, ...]}` with every counter whose value is above 0, highest value first; counters with equal values are ordered by name.

Any other method or path gives `404 {"error": "not found"}`.

## Rate limit

Only `POST /counters/:name` is limited. Such a request goes through these steps in order:

1. The client is identified by the `X-Client-Id` request header. A missing or empty header gives `400 {"error": "missing X-Client-Id"}`.
2. An invalid counter name gives `400` as described above.
3. Each client may make `RATE_LIMIT` increments per window, counted across all counters. A client's window opens with its first request that reaches this step and lasts `RATE_WINDOW_MS` milliseconds; the first request after the window has closed opens a new one. A request over the limit gets `429 {"error": "rate limit exceeded"}` and the counter does not change. Rejected requests neither count towards the limit nor extend the window.

Requests that end in steps 1 or 2 do not use up any of the client's allowance.

Every response to a request that reached step 3, whether `200` or `429`, carries two headers: `X-RateLimit-Limit` with the value of `RATE_LIMIT`, and `X-RateLimit-Remaining` with the number of increments the client has left in the current window after this request (`0` on a `429`). A `429` also carries `Retry-After`: the number of seconds until the window closes, rounded up to a whole number, and at least `1`.

## Example

With the defaults, one client's sixth increment within a second:

```
$ curl -si -X POST localhost:8000/counters/home -H 'X-Client-Id: docs-site'
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
Retry-After: 1
Content-Type: application/json

{"error":"rate limit exceeded"}
```
