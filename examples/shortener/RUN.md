# shortener

Built by grout, run `2026-10-30T11-29-09-shortener`, candidate A, mode interlocked.

- **Status: GREEN**: all requirements covered by passing tests; clean-room check passed
- Wall time: 488.7 s · model cost: $0.3346 · agents spawned: 13
- Human steps: 0 (see HUMAN_STEPS.md)

## Requirements

| id | requirement | tests | status |
|---|---|---|---|
| R1 | Server started with `node dist/server.js` listens on PORT env var, default 3000. State in memory. | 3 | pass |
| R2 | Every response with a body is JSON with Content-Type application/json; errors have body {"error": "<message>"}. | 5 | pass |
| R3 | Link object has fields code (string), url (string), hits (integer count of redirects), createdAt (ISO 8601 UTC with milliseconds from toISOString). | 2 | pass |
| R4 | POST /links: body must be a JSON object (not array, null, string, number, or invalid JSON), else 400 {"error":"body must be a JSON object"}. Checked first. | 7 | pass |
| R5 | POST /links: url must be a string that is an absolute URL with scheme http or https, else 400 {"error":"url must be an absolute http(s) URL"}. Checked second (after body check, before code check). | 5 | pass |
| R6 | POST /links: code, when present, must be a string of 4-32 chars from A-Z a-z 0-9 _ -, and not equal to 'links'; else 400 {"error":"invalid code"}. Checked third. | 12 | pass |
| R7 | POST /links with unused code creates link (hits 0) and returns 201 with the link. | 1 | pass |
| R8 | POST /links with existing code and same url: no change, 200 with existing link. | 2 | pass |
| R9 | POST /links with existing code and different url: 409 {"error":"code already in use"}. | 1 | pass |
| R10 | POST /links without code: if a link with exactly this url exists, 200 with the oldest such link; otherwise create with random 6-char alphanumeric code and return 201. | 4 | pass |
| R11 | URLs compared as exact strings with no normalisation; https://a.example and https://a.example/ are different (stored url is returned as given). | 2 | pass |
| R12 | GET /links/:code returns 200 with the link or 404 {"error":"not found"}; does not increment hits. | 3 | pass |
| R13 | GET /:code returns 302 with Location header equal to link url and increments hits by one; unknown code gives 404 {"error":"not found"}. | 2 | pass |
| R14 | DELETE /links/:code returns 204 with empty body and frees the code for reuse; unknown code gives 404 {"error":"not found"}. | 4 | pass |
| R15 | Any other method or path gives 404 {"error":"not found"} (e.g. GET /links, PUT /links/x, POST /x, nested paths). | 4 | pass |

## Run it

```
npm ci
npm run build
npm test
```

The program is invoked as: `node dist/server.js` (tests run `node dist/server.js`).

The full trace of the run is in `grout-run/trace.jsonl`, the report in `grout-run/report.html`.
