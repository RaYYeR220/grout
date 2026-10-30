# inventory

An HTTP API for a small shop's stock list, saved to a JSON file.

## Running

Start it with `npm start` from the project directory. It listens on the port in the `INVENTORY_PORT` environment variable (default `4000`) and keeps its data in the file named by `INVENTORY_FILE` (default `inventory.json` in the working directory). The file is read at startup, and a missing file means an empty inventory. After every successful change the file is rewritten before the response is sent, so a restarted server sees the same items.

Every response with a body is JSON with `Content-Type: application/json`. Errors have the body `{"errors": ["<message>", ...]}`.

## Item

```
{"sku": "MUG-01", "name": "Enamel mug", "quantity": 12, "priceCents": 1450}
```

| field | rule | message when the rule is broken |
|---|---|---|
| `sku` | a string of 3 to 20 characters from `A`-`Z`, `0`-`9` and `-` | `sku must be 3-20 characters of A-Z, 0-9 or -` |
| `name` | a string that is not empty after trimming; it is stored trimmed | `name must be a non-empty string` |
| `quantity` | an integer, 0 or more | `quantity must be a non-negative integer` |
| `priceCents` | an integer, 0 or more | `priceCents must be a non-negative integer` |

A missing field breaks its rule. When several fields are wrong, all their messages are returned, in the order of this table. A body that is not a JSON object gives `400 {"errors": ["body must be a JSON object"]}`.

## Endpoints

- `POST /items` with a full item: `201` with the stored item and the header `Location: /items/<sku>`. Broken rules give `400`. A sku that is already taken gives `409 {"errors": ["sku already exists"]}`.
- `GET /items/:sku`: `200` with the item. An unknown sku gives `404 {"errors": ["item not found"]}`, here and in the endpoints below.
- `PATCH /items/:sku`: the body may hold any of `name`, `quantity` and `priceCents`; other fields are ignored. The fields given are checked with the rules above and then replaced. `200` with the updated item. The sku is looked up before the body is checked.
- `POST /items/:sku/adjust` with `{"delta": <integer other than 0>}`: adds `delta` to the quantity, `200` with the updated item. A missing or bad `delta` gives `400 {"errors": ["delta must be a non-zero integer"]}`. If the quantity would drop below 0, nothing changes and the response is `409 {"errors": ["insufficient stock"]}`.
- `DELETE /items/:sku`: `204` with an empty body.
- `GET /items`: one page of items, as

  ```
  {"items": [...], "page": 1, "pageSize": 10, "total": 23, "totalPages": 3}
  ```

  Query parameters:

  - `page`: an integer, 1 or more; default `1`.
  - `pageSize`: an integer from 1 to 50; default `10`.
  - `sort`: `sku`, `name`, `quantity` or `priceCents`, optionally prefixed with `-` for descending order; default `sku`. Strings compare by plain character code (`Zeta` sorts before `alpha`). Items with equal values are ordered by `sku` ascending, whichever direction was asked for.

  `total` is the number of items in the inventory and `totalPages` is `total / pageSize` rounded up (`0` when there are no items). A page past the end is `200` with an empty `items` array. A bad parameter gives `400` with `["invalid page"]`, `["invalid pageSize"]` or `["invalid sort"]`; when several are bad, only the first in the order `page`, `pageSize`, `sort` is reported.

Any other method or path gives `404 {"errors": ["not found"]}`.

## Example

```
$ curl -si localhost:4000/items -H 'content-type: application/json' \
    -d '{"sku":"MUG-01","name":" Enamel mug ","quantity":12,"priceCents":1450}'
HTTP/1.1 201 Created
Location: /items/MUG-01
Content-Type: application/json

{"sku":"MUG-01","name":"Enamel mug","quantity":12,"priceCents":1450}
$ curl -s localhost:4000/items/MUG-01/adjust -H 'content-type: application/json' -d '{"delta":-20}'
{"errors":["insufficient stock"]}
```
