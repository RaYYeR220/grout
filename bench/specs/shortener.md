# shortener

An HTTP API that turns long URLs into short codes and redirects visitors who open a code.

## Running

Start the server with `node dist/server.js`. It listens on the port in the `PORT` environment variable (default `3000`). State is kept in memory. Every response with a body is JSON with `Content-Type: application/json`. Errors have the body `{"error": "<message>"}`.

## Link

```
{"code": "docs", "url": "https://example.com/docs", "hits": 0, "createdAt": "2026-10-30T09:12:44.512Z"}
```

`createdAt` is the creation time in ISO 8601 UTC with milliseconds, as produced by `Date.prototype.toISOString`. `hits` counts the redirects served for the code.

## Endpoints

### `POST /links`

Body: `{"url": "<string>", "code": "<string, optional>"}`. Checked in this order; the first failure is the response:

1. The body must be a JSON object, otherwise `400 {"error": "body must be a JSON object"}`.
2. `url` must be a string holding an absolute URL whose scheme is `http` or `https`, otherwise `400 {"error": "url must be an absolute http(s) URL"}`.
3. `code`, when present, must be a string of 4 to 32 characters from `A`-`Z`, `a`-`z`, `0`-`9`, `_` and `-`, and must not be `links`; otherwise `400 {"error": "invalid code"}`.

Then:

- A `code` nobody uses: the link is created, `201` with the link.
- A `code` that already exists with the same `url`: nothing changes, `200` with the existing link.
- A `code` that already exists with a different `url`: `409 {"error": "code already in use"}`.
- No `code`: if a link with exactly this `url` already exists, `200` with the oldest such link. Otherwise a link is created with a new random code of 6 characters from `A`-`Z`, `a`-`z` and `0`-`9`, `201` with the link.

URLs are compared as exact strings, without normalisation: `https://a.example` and `https://a.example/` are different URLs.

### `GET /links/:code`

`200` with the link, or `404 {"error": "not found"}`. This is not a hit.

### `GET /:code`

`302` with the `Location` header set to the link's `url`, and the link's `hits` goes up by one. An unknown code gives `404 {"error": "not found"}`.

### `DELETE /links/:code`

`204` with an empty body; the code is free to be used again. An unknown code gives `404 {"error": "not found"}`.

### Everything else

Any other method or path gives `404 {"error": "not found"}`.

## Example

```
$ curl -s localhost:3000/links -H 'content-type: application/json' \
    -d '{"url":"https://example.com/docs?page=2","code":"docs"}'
{"code":"docs","url":"https://example.com/docs?page=2","hits":0,"createdAt":"2026-10-30T09:12:44.512Z"}
$ curl -si localhost:3000/docs | head -n 1
HTTP/1.1 302 Found
$ curl -s localhost:3000/links/docs
{"code":"docs","url":"https://example.com/docs?page=2","hits":1,"createdAt":"2026-10-30T09:12:44.512Z"}
```
