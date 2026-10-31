import { createServer } from "node:http";
import { refreshExpired } from "./domain.js";
import { HttpError } from "./types.js";
import { INVALID_JSON } from "./util.js";
/**
 * Matches a path against a route pattern like "/events/:id/cancel".
 * Returns params on match, or null.
 */
export function matchPattern(pattern, path) {
    const norm = (s) => (s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s);
    const pp = norm(pattern).split("/");
    const sp = norm(path).split("/");
    if (pp.length !== sp.length)
        return null;
    const params = {};
    for (let i = 0; i < pp.length; i++) {
        const p = pp[i];
        const s = sp[i];
        if (p.startsWith(":")) {
            if (s === "")
                return null;
            let v;
            try {
                v = decodeURIComponent(s);
            }
            catch {
                v = s;
            }
            params[p.slice(1)] = v;
        }
        else if (p !== s) {
            return null;
        }
    }
    return params;
}
function errorRes(err) {
    if (err instanceof HttpError)
        return { status: err.status, body: { error: err.message } };
    return { status: 500, body: { error: "internal server error" } };
}
/**
 * Dispatches a parsed request to the matching route and returns the response.
 * - No matching route (path or method) → 404 { error }.
 * - Before calling the handler, calls refreshExpired(ctx) from ./domain.js so every response reflects expiry.
 * - HttpError thrown → { status, body: { error: message } }; any other error → 500 { error }.
 */
export async function dispatch(ctx, routes, req) {
    let found = null;
    for (const route of routes) {
        if (route.method !== req.method)
            continue;
        const params = matchPattern(route.pattern, req.path);
        if (params) {
            found = { route, params };
            break;
        }
    }
    if (!found)
        return { status: 404, body: { error: "not found" } };
    try {
        refreshExpired(ctx);
        return await found.route.handler(ctx, { ...req, params: found.params });
    }
    catch (err) {
        if (!(err instanceof HttpError))
            console.error(err);
        return errorRes(err);
    }
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
function send(res, r) {
    const payload = r.body === undefined ? "" : JSON.stringify(r.body);
    res.writeHead(r.status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
}
/**
 * Creates (does not listen) a node:http server. Reads the body; empty body → req.body undefined;
 * non-empty invalid JSON → req.body = INVALID_JSON sentinel (bodyObject() turns it into 400 after auth checks). Writes JSON responses with content-type application/json.
 */
export function createHttpServer(ctx, routes) {
    return createServer((req, res) => {
        void (async () => {
            try {
                const raw = await readBody(req);
                const url = new URL(req.url ?? "/", "http://localhost");
                let body = undefined;
                if (raw.trim() !== "") {
                    try {
                        body = JSON.parse(raw);
                    }
                    catch {
                        // Do not answer early: handlers run auth checks (401/403) first, then
                        // bodyObject() turns this sentinel into a 400.
                        body = INVALID_JSON;
                    }
                }
                const r = await dispatch(ctx, routes, {
                    method: (req.method ?? "GET").toUpperCase(),
                    path: url.pathname,
                    params: {},
                    query: url.searchParams,
                    headers: req.headers,
                    body,
                });
                send(res, r);
            }
            catch (err) {
                console.error(err);
                if (!res.headersSent)
                    send(res, errorRes(err));
                else
                    res.end();
            }
        })();
    });
}
