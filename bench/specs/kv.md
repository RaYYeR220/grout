# kv

An in-memory key-value store over HTTP. Values are strings; keys can be given a time to live.

## Running

Start it with `node dist/kv.js`. It listens on the port in the `APP_PORT` environment variable (default `8080`). Every response with a body is JSON with `Content-Type: application/json`. Errors have the body `{"error": "<message>"}`.

## Keys

A key is 1 to 128 characters from `A`-`Z`, `a`-`z`, `0`-`9`, `.`, `_`, `:` and `-`. In paths it is percent-encoded (`/keys/user%3A42` is the key `user:42`); the server decodes it before checking it. A path with any other key gives `400 {"error": "invalid key"}`, and the key is checked before anything else in the request.

## Entry

```
{"key": "session:42", "value": "alice", "expiresAt": "2026-10-30T12:00:05.000Z"}
```

`expiresAt` is `null` for a key without a time to live, otherwise the moment it expires, in ISO 8601 UTC with milliseconds (as produced by `Date.prototype.toISOString`). Once that moment is reached the key is expired, and an expired key behaves exactly like a key that was never set.

## Endpoints

### `PUT /keys/:key`

Body: `{"value": "<string>", "ttl": <milliseconds, optional>}`. Checked in this order; the first failure is the response:

1. The body must be a JSON object, otherwise `400 {"error": "invalid JSON body"}`.
2. `value` must be a string, otherwise `400 {"error": "value must be a string"}`.
3. `ttl`, when present, must be an integer of at least 1, otherwise `400 {"error": "ttl must be a positive integer"}`.

Stores the value. With `ttl` the key expires `ttl` milliseconds from now; without `ttl` it never expires, even if it had an expiry before. The response is `201` with the entry when the key did not exist, `200` with the entry when it replaced a value.

### `GET /keys/:key`

`200` with the entry, or `404 {"error": "key not found"}`.

### `DELETE /keys/:key`

`204` with an empty body, whether or not the key existed.

### `POST /keys/:key/incr`

Adds to a value that holds an integer. The body is optional: no body means add `1`, and `{"by": <integer>}` adds `by`, which may be negative. A key that does not exist counts as `"0"`. The result is stored as a base-10 string, keeping any expiry the key had, and the response is `200` with the entry.

- A body that is not a JSON object: `400 {"error": "invalid JSON body"}`.
- `by` that is not an integer: `400 {"error": "by must be an integer"}`.
- A current value that is not an integer (an optional `-` followed by one or more digits `0`-`9`): `409 {"error": "value is not an integer"}`, and the value is left alone.

### `GET /keys`

`200 {"keys": [...]}` with every live key, sorted by plain character-code order. The optional query parameter `prefix` keeps only the keys that start with it (case-sensitive): `GET /keys?prefix=user%3A`.

### Everything else

Any other method or path gives `404 {"error": "not found"}`.

## Example

```
$ curl -s -X PUT localhost:8080/keys/session%3A42 -H 'content-type: application/json' \
    -d '{"value":"alice","ttl":5000}'
{"key":"session:42","value":"alice","expiresAt":"2026-10-30T12:00:05.000Z"}
$ curl -s -X POST localhost:8080/keys/visits/incr
{"key":"visits","value":"1","expiresAt":null}
$ curl -s 'localhost:8080/keys?prefix=s'
{"keys":["session:42"]}
```
