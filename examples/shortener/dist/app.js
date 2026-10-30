import { createServer } from "node:http";
const CODE_RE = /^[A-Za-z0-9_-]{4,32}$/;
/** Validate a parsed POST /links body, in spec order. */
export function validateCreate(body) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { ok: false, error: "body must be a JSON object" };
    }
    const obj = body;
    const url = obj.url;
    if (typeof url !== "string") {
        return { ok: false, error: "url must be an absolute http(s) URL" };
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return { ok: false, error: "url must be an absolute http(s) URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "url must be an absolute http(s) URL" };
    }
    if (obj.code !== undefined) {
        const code = obj.code;
        if (typeof code !== "string" ||
            !CODE_RE.test(code) ||
            code === "links") {
            return { ok: false, error: "invalid code" };
        }
        return { ok: true, url, code };
    }
    return { ok: true, url };
}
function sendJson(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
}
function sendError(res, status, message) {
    sendJson(res, status, { error: message });
}
function sendEmpty(res, status) {
    res.writeHead(status);
    res.end();
}
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}
function decodeSegment(raw) {
    try {
        return decodeURIComponent(raw);
    }
    catch {
        return undefined;
    }
}
/** Build the http server handling all routes. */
export function createApp(store) {
    async function handleCreate(req, res) {
        const raw = await readBody(req);
        let body;
        try {
            body = JSON.parse(raw);
        }
        catch {
            sendError(res, 400, "body must be a JSON object");
            return;
        }
        const input = validateCreate(body);
        if (!input.ok) {
            sendError(res, 400, input.error);
            return;
        }
        const { url, code } = input;
        if (code === undefined) {
            const existing = store.findByUrl(url);
            if (existing) {
                sendJson(res, 200, existing);
                return;
            }
            const created = store.create(store.generateCode(), url);
            sendJson(res, 201, created);
            return;
        }
        const existing = store.get(code);
        if (existing) {
            if (existing.url === url) {
                sendJson(res, 200, existing);
            }
            else {
                sendError(res, 409, "code already in use");
            }
            return;
        }
        sendJson(res, 201, store.create(code, url));
    }
    return createServer((req, res) => {
        const method = req.method ?? "";
        const path = (req.url ?? "/").split("?")[0] ?? "/";
        const segments = path.split("/");
        // path starts with "/", so segments[0] === ""
        const notFound = () => sendError(res, 404, "not found");
        const run = async () => {
            if (segments.length === 2 && segments[1] === "links") {
                if (method === "POST") {
                    await handleCreate(req, res);
                    return;
                }
                notFound();
                return;
            }
            if (segments.length === 3 && segments[1] === "links" && segments[2] !== "") {
                const code = decodeSegment(segments[2]);
                if (code === undefined || code === "") {
                    notFound();
                    return;
                }
                if (method === "GET") {
                    const link = store.get(code);
                    if (link)
                        sendJson(res, 200, link);
                    else
                        sendError(res, 404, "not found");
                    return;
                }
                if (method === "DELETE") {
                    if (store.delete(code))
                        sendEmpty(res, 204);
                    else
                        sendError(res, 404, "not found");
                    return;
                }
                notFound();
                return;
            }
            if (segments.length === 2 && segments[1] !== "" && segments[1] !== "links") {
                if (method !== "GET") {
                    notFound();
                    return;
                }
                const code = decodeSegment(segments[1]);
                if (code === undefined || code === "") {
                    notFound();
                    return;
                }
                const hit = store.hit(code);
                if (hit) {
                    res.writeHead(302, { Location: hit.url, "Content-Length": 0 });
                    res.end();
                }
                else {
                    sendError(res, 404, "not found");
                }
                return;
            }
            notFound();
        };
        run().catch(() => {
            if (!res.headersSent)
                sendError(res, 500, "internal error");
            else
                res.end();
        });
    });
}
