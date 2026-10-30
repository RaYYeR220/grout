import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

const PORT = Number(process.env.INVENTORY_PORT || 4000);
const FILE = resolve(process.env.INVENTORY_FILE || "inventory.json");

const items = new Map();
if (existsSync(FILE)) for (const item of JSON.parse(readFileSync(FILE, "utf8")).items) items.set(item.sku, item);

const persist = () => writeFileSync(FILE, `${JSON.stringify({ items: [...items.values()] }, null, 2)}\n`);

const isCount = (v) => Number.isInteger(v) && v >= 0;
const RULES = {
  sku: [(v) => typeof v === "string" && /^[A-Z0-9-]{3,20}$/.test(v), "sku must be 3-20 characters of A-Z, 0-9 or -"],
  name: [(v) => typeof v === "string" && v.trim() !== "", "name must be a non-empty string"],
  quantity: [isCount, "quantity must be a non-negative integer"],
  priceCents: [isCount, "priceCents must be a non-negative integer"],
};

function check(body, fields) {
  return fields.filter((f) => !RULES[f][0](body[f])).map((f) => RULES[f][1]);
}

class HttpError extends Error {
  constructor(status, ...errors) {
    super(errors[0]);
    this.status = status;
    this.errors = errors;
  }
}

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

async function readObject(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // falls through to the error below
  }
  throw new HttpError(400, "body must be a JSON object");
}

function existing(sku) {
  const item = items.get(sku);
  if (!item) throw new HttpError(404, "item not found");
  return item;
}

const FIELDS = ["sku", "name", "quantity", "priceCents"];
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function list(query) {
  const int = (name, fallback, min, max) => {
    const raw = query.get(name);
    if (raw === null) return fallback;
    if (!/^[0-9]+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new HttpError(400, `invalid ${name}`);
    return Number(raw);
  };
  const page = int("page", 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = int("pageSize", 10, 1, 50);
  const sort = query.get("sort") ?? "sku";
  const field = sort.startsWith("-") ? sort.slice(1) : sort;
  if (!FIELDS.includes(field)) throw new HttpError(400, "invalid sort");
  const direction = sort.startsWith("-") ? -1 : 1;
  const sorted = [...items.values()].sort((a, b) => direction * compare(a[field], b[field]) || compare(a.sku, b.sku));
  const total = sorted.length;
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  };
}

async function route(req, url) {
  const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  const method = req.method;

  if (parts.length === 1 && parts[0] === "items") {
    if (method === "GET") return [200, list(url.searchParams)];
    if (method === "POST") {
      const body = await readObject(req);
      const errors = check(body, FIELDS);
      if (errors.length) throw new HttpError(400, ...errors);
      if (items.has(body.sku)) throw new HttpError(409, "sku already exists");
      const item = { sku: body.sku, name: body.name.trim(), quantity: body.quantity, priceCents: body.priceCents };
      items.set(item.sku, item);
      persist();
      return [201, item, { location: `/items/${item.sku}` }];
    }
  }

  if (parts.length === 2 && parts[0] === "items") {
    const sku = parts[1];
    if (method === "GET") return [200, existing(sku)];
    if (method === "PATCH") {
      const item = existing(sku);
      const body = await readObject(req);
      const given = ["name", "quantity", "priceCents"].filter((f) => f in body);
      const errors = check(body, given);
      if (errors.length) throw new HttpError(400, ...errors);
      for (const f of given) item[f] = f === "name" ? body.name.trim() : body[f];
      persist();
      return [200, item];
    }
    if (method === "DELETE") {
      existing(sku);
      items.delete(sku);
      persist();
      return [204];
    }
  }

  if (parts.length === 3 && parts[0] === "items" && parts[2] === "adjust" && method === "POST") {
    const item = existing(parts[1]);
    const { delta } = await readObject(req);
    if (!Number.isInteger(delta) || delta === 0) throw new HttpError(400, "delta must be a non-zero integer");
    if (item.quantity + delta < 0) throw new HttpError(409, "insufficient stock");
    item.quantity += delta;
    persist();
    return [200, item];
  }

  throw new HttpError(404, "not found");
}

createServer(async (req, res) => {
  try {
    const [status, body, headers] = await route(req, new URL(req.url, "http://localhost"));
    send(res, status, body, headers);
  } catch (err) {
    if (err instanceof HttpError) send(res, err.status, { errors: err.errors });
    else send(res, 500, { errors: ["internal error"] });
  }
}).listen(PORT);
