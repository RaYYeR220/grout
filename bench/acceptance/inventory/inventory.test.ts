import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { call, startServer, tempDir, type Server } from "../helpers.js";

const START = ["npm", "start"];

const MSG = {
  sku: "sku must be 3-20 characters of A-Z, 0-9 or -",
  name: "name must be a non-empty string",
  quantity: "quantity must be a non-negative integer",
  priceCents: "priceCents must be a non-negative integer",
};
const NOT_FOUND = { errors: ["item not found"] };

type Item = { sku: string; name: string; quantity: number; priceCents: number };

function boot(file: string): Promise<Server> {
  return startServer(START, { portEnv: "INVENTORY_PORT", env: { INVENTORY_FILE: file } });
}

function serverPerSuite(): () => Server {
  let server: Server | undefined;
  beforeAll(async () => {
    server = await boot(join(tempDir(), "inventory.json"));
  });
  afterAll(async () => {
    await server?.stop();
  });
  return () => server!;
}

describe("items", () => {
  const server = serverPerSuite();
  const create = (body: unknown) => call(server(), "POST", "/items", body);

  test("POST /items gives 201, a Location header and the item with a trimmed name", async () => {
    const r = await create({ sku: "MUG-01", name: "  Enamel mug ", quantity: 12, priceCents: 1450 });
    expect(r.status).toBe(201);
    expect(r.headers.get("location")).toBe("/items/MUG-01");
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.json).toEqual({ sku: "MUG-01", name: "Enamel mug", quantity: 12, priceCents: 1450 });
  });

  test("GET /items/:sku returns the item, or 404", async () => {
    await create({ sku: "PEN-7", name: "Pen", quantity: 0, priceCents: 0 });
    const r = await call(server(), "GET", "/items/PEN-7");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ sku: "PEN-7", name: "Pen", quantity: 0, priceCents: 0 });
    const missing = await call(server(), "GET", "/items/NOPE-1");
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual(NOT_FOUND);
  });

  test("a sku that is already taken is a 409", async () => {
    await create({ sku: "DUP-1", name: "First", quantity: 1, priceCents: 100 });
    const r = await create({ sku: "DUP-1", name: "Second", quantity: 2, priceCents: 200 });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ errors: ["sku already exists"] });
    expect((await call(server(), "GET", "/items/DUP-1")).json.name).toBe("First");
  });

  test("every broken rule is reported, in table order", async () => {
    const r = await create({ priceCents: 9.5, quantity: -1, name: "   ", sku: "ab" });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ errors: [MSG.sku, MSG.name, MSG.quantity, MSG.priceCents] });
  });

  test("missing fields break their rules", async () => {
    const empty = await create({});
    expect(empty.status).toBe(400);
    expect(empty.json).toEqual({ errors: [MSG.sku, MSG.name, MSG.quantity, MSG.priceCents] });
    const partial = await create({ sku: "HALF-1", name: "Half" });
    expect(partial.status).toBe(400);
    expect(partial.json).toEqual({ errors: [MSG.quantity, MSG.priceCents] });
    expect((await call(server(), "GET", "/items/HALF-1")).status).toBe(404);
  });

  test("sku must be 3 to 20 of A-Z, 0-9 and -", async () => {
    for (const sku of ["mug-02", "AB", "A".repeat(21), "AB_1", "AB 1", 123]) {
      const r = await create({ sku, name: "Thing", quantity: 1, priceCents: 1 });
      expect(r.status, String(sku)).toBe(400);
      expect(r.json).toEqual({ errors: [MSG.sku] });
    }
    for (const sku of ["ABC", "9".repeat(20), "---"]) {
      expect((await create({ sku, name: "Thing", quantity: 1, priceCents: 1 })).status, sku).toBe(201);
    }
  });

  test("quantity and priceCents must be non-negative integers", async () => {
    const r = await create({ sku: "NUM-1", name: "Thing", quantity: "5", priceCents: -1 });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ errors: [MSG.quantity, MSG.priceCents] });
    const name = await create({ sku: "NUM-2", name: 7, quantity: 1, priceCents: 1 });
    expect(name.json).toEqual({ errors: [MSG.name] });
  });

  test("a body that is not a JSON object is a 400", async () => {
    for (const body of ["nope", "[]", "null", "42"]) {
      const r = await create(body);
      expect(r.status, body).toBe(400);
      expect(r.json).toEqual({ errors: ["body must be a JSON object"] });
    }
  });

  test("PATCH replaces only the fields given and ignores others", async () => {
    await create({ sku: "LAMP-1", name: "Lamp", quantity: 4, priceCents: 2500 });
    const r = await call(server(), "PATCH", "/items/LAMP-1", { name: " Desk lamp ", priceCents: 1999, sku: "OTHER-1", color: "red" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ sku: "LAMP-1", name: "Desk lamp", quantity: 4, priceCents: 1999 });
    expect((await call(server(), "GET", "/items/LAMP-1")).json).toEqual(r.json);
    expect((await call(server(), "GET", "/items/OTHER-1")).status).toBe(404);
  });

  test("PATCH checks the fields given; an unknown sku is a 404 even with a bad body", async () => {
    await create({ sku: "BOWL-1", name: "Bowl", quantity: 3, priceCents: 800 });
    const r = await call(server(), "PATCH", "/items/BOWL-1", { quantity: -5, name: "" });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ errors: [MSG.name, MSG.quantity] });
    expect((await call(server(), "GET", "/items/BOWL-1")).json).toEqual({ sku: "BOWL-1", name: "Bowl", quantity: 3, priceCents: 800 });
    const missing = await call(server(), "PATCH", "/items/NOPE-2", { quantity: -5 });
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual(NOT_FOUND);
  });

  test("adjust adds delta to the quantity", async () => {
    await create({ sku: "TEA-1", name: "Tea", quantity: 5, priceCents: 300 });
    const up = await call(server(), "POST", "/items/TEA-1/adjust", { delta: 3 });
    expect(up.status).toBe(200);
    expect(up.json).toEqual({ sku: "TEA-1", name: "Tea", quantity: 8, priceCents: 300 });
    const down = await call(server(), "POST", "/items/TEA-1/adjust", { delta: -8 });
    expect(down.status).toBe(200);
    expect(down.json.quantity).toBe(0);
  });

  test("adjust refuses to go below zero and rejects a bad delta", async () => {
    await create({ sku: "JAM-1", name: "Jam", quantity: 2, priceCents: 450 });
    const short = await call(server(), "POST", "/items/JAM-1/adjust", { delta: -3 });
    expect(short.status).toBe(409);
    expect(short.json).toEqual({ errors: ["insufficient stock"] });
    for (const body of [{ delta: 0 }, { delta: 1.5 }, { delta: "2" }, {}]) {
      const r = await call(server(), "POST", "/items/JAM-1/adjust", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json).toEqual({ errors: ["delta must be a non-zero integer"] });
    }
    expect((await call(server(), "GET", "/items/JAM-1")).json.quantity).toBe(2);
    const missing = await call(server(), "POST", "/items/NOPE-3/adjust", { delta: 1 });
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual(NOT_FOUND);
  });

  test("DELETE gives 204, then the item is gone", async () => {
    await create({ sku: "OLD-1", name: "Old", quantity: 1, priceCents: 1 });
    const r = await call(server(), "DELETE", "/items/OLD-1");
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
    expect((await call(server(), "GET", "/items/OLD-1")).status).toBe(404);
    const again = await call(server(), "DELETE", "/items/OLD-1");
    expect(again.status).toBe(404);
    expect(again.json).toEqual(NOT_FOUND);
  });

  test("other methods and paths are 404", async () => {
    const cases: [string, string][] = [
      ["GET", "/"],
      ["GET", "/products"],
      ["PUT", "/items/MUG-01"],
      ["DELETE", "/items"],
    ];
    for (const [method, path] of cases) {
      const r = await call(server(), method, path);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json).toEqual({ errors: ["not found"] });
    }
  });
});

const CATALOGUE: Item[] = [
  { sku: "E-100", name: "theta", quantity: 3, priceCents: 75 },
  { sku: "A-200", name: "Zeta", quantity: 5, priceCents: 100 },
  { sku: "C-200", name: "delta", quantity: 2, priceCents: 999 },
  { sku: "F-200", name: "lambda", quantity: 4, priceCents: 120 },
  { sku: "B-100", name: "beta", quantity: 0, priceCents: 300 },
  { sku: "D-100", name: "epsilon", quantity: 9, priceCents: 50 },
  { sku: "A-100", name: "alpha", quantity: 5, priceCents: 300 },
  { sku: "E-200", name: "iota", quantity: 0, priceCents: 400 },
  { sku: "C-100", name: "gamma", quantity: 5, priceCents: 100 },
  { sku: "F-100", name: "Kappa", quantity: 7, priceCents: 100 },
  { sku: "B-200", name: "Beta", quantity: 9, priceCents: 250 },
  { sku: "D-200", name: "Eta", quantity: 1, priceCents: 300 },
];
const BY_SKU = ["A-100", "A-200", "B-100", "B-200", "C-100", "C-200", "D-100", "D-200", "E-100", "E-200", "F-100", "F-200"];

describe("listing", () => {
  const server = serverPerSuite();
  const list = async (query = "") => {
    const r = await call(server(), "GET", `/items${query}`);
    expect(r.status, `${query}: ${r.text}`).toBe(200);
    return r.json as { items: Item[]; page: number; pageSize: number; total: number; totalPages: number };
  };
  const skus = (page: { items: Item[] }) => page.items.map((i) => i.sku);

  beforeAll(async () => {
    for (const item of CATALOGUE) {
      const r = await call(server(), "POST", "/items", item);
      if (r.status !== 201) throw new Error(`seeding ${item.sku} failed: ${r.status} ${r.text}`);
    }
  });

  test("defaults to page 1 of 10 items, sorted by sku", async () => {
    const page = await list();
    expect(page).toMatchObject({ page: 1, pageSize: 10, total: 12, totalPages: 2 });
    expect(skus(page)).toEqual(BY_SKU.slice(0, 10));
    expect(page.items[0]).toEqual({ sku: "A-100", name: "alpha", quantity: 5, priceCents: 300 });
  });

  test("page and pageSize pick a slice; totalPages rounds up", async () => {
    const second = await list("?page=2");
    expect(skus(second)).toEqual(BY_SKU.slice(10));
    expect(second).toMatchObject({ page: 2, pageSize: 10, total: 12, totalPages: 2 });
    const third = await list("?page=3&pageSize=5");
    expect(skus(third)).toEqual(BY_SKU.slice(10));
    expect(third).toMatchObject({ page: 3, pageSize: 5, total: 12, totalPages: 3 });
    const whole = await list("?pageSize=50");
    expect(skus(whole)).toEqual(BY_SKU);
    expect(whole.totalPages).toBe(1);
    const exact = await list("?pageSize=4");
    expect(exact.totalPages).toBe(3);
  });

  test("a page past the end is empty, not an error", async () => {
    const page = await list("?page=4&pageSize=5");
    expect(page).toEqual({ items: [], page: 4, pageSize: 5, total: 12, totalPages: 3 });
  });

  test("names sort by plain character code", async () => {
    const page = await list("?sort=name&pageSize=50");
    expect(page.items.map((i) => i.name)).toEqual(["Beta", "Eta", "Kappa", "Zeta", "alpha", "beta", "delta", "epsilon", "gamma", "iota", "lambda", "theta"]);
  });

  test("ties are broken by sku ascending, also when sorting descending", async () => {
    const desc = await list("?sort=-quantity&pageSize=50");
    expect(skus(desc)).toEqual(["B-200", "D-100", "F-100", "A-100", "A-200", "C-100", "F-200", "E-100", "C-200", "D-200", "B-100", "E-200"]);
    const asc = await list("?sort=priceCents&pageSize=50");
    expect(skus(asc)).toEqual(["D-100", "E-100", "A-200", "C-100", "F-100", "F-200", "B-200", "A-100", "B-100", "D-200", "E-200", "C-200"]);
  });

  test("-sku sorts descending and sorting applies before paging", async () => {
    const page = await list("?sort=-sku&pageSize=3&page=2");
    expect(skus(page)).toEqual(["E-100", "D-200", "D-100"]);
  });

  test("bad query parameters are a 400 naming the first bad one", async () => {
    const cases: [string, string][] = [
      ["?page=0", "invalid page"],
      ["?page=-1", "invalid page"],
      ["?page=abc", "invalid page"],
      ["?page=1.5", "invalid page"],
      ["?pageSize=0", "invalid pageSize"],
      ["?pageSize=51", "invalid pageSize"],
      ["?pageSize=ten", "invalid pageSize"],
      ["?sort=color", "invalid sort"],
      ["?sort=--sku", "invalid sort"],
      ["?sort=Name", "invalid sort"],
      ["?sort=bad&pageSize=0&page=0", "invalid page"],
      ["?sort=bad&pageSize=0", "invalid pageSize"],
    ];
    for (const [query, error] of cases) {
      const r = await call(server(), "GET", `/items${query}`);
      expect(r.status, query).toBe(400);
      expect(r.json, query).toEqual({ errors: [error] });
    }
  });
});

describe("an empty inventory", () => {
  const server = serverPerSuite();

  test("lists no items and zero pages", async () => {
    const r = await call(server(), "GET", "/items");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ items: [], page: 1, pageSize: 10, total: 0, totalPages: 0 });
  });
});

describe("persistence", () => {
  test("the file is written on change and a restarted server sees the same items", async () => {
    const file = join(tempDir(), "stock.json");
    const first = await boot(file);
    try {
      expect((await call(first, "GET", "/items")).json.total).toBe(0);
      await call(first, "POST", "/items", { sku: "KEEP-1", name: "Kept", quantity: 3, priceCents: 500 });
      await call(first, "POST", "/items", { sku: "DROP-1", name: "Dropped", quantity: 1, priceCents: 1 });
      await call(first, "POST", "/items/KEEP-1/adjust", { delta: 4 });
      await call(first, "PATCH", "/items/KEEP-1", { name: "Still kept" });
      await call(first, "DELETE", "/items/DROP-1");
      expect(existsSync(file)).toBe(true);
      expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
    } finally {
      await first.stop();
    }

    const second = await boot(file);
    try {
      const r = await call(second, "GET", "/items");
      expect(r.json).toEqual({
        items: [{ sku: "KEEP-1", name: "Still kept", quantity: 7, priceCents: 500 }],
        page: 1,
        pageSize: 10,
        total: 1,
        totalPages: 1,
      });
      expect((await call(second, "GET", "/items/DROP-1")).status).toBe(404);
    } finally {
      await second.stop();
    }
  });

  test("a missing file means an empty inventory and is not needed to start", async () => {
    const file = join(tempDir(), "absent.json");
    const server = await boot(file);
    try {
      expect((await call(server, "GET", "/items")).json).toMatchObject({ items: [], total: 0 });
    } finally {
      await server.stop();
    }
  });
});
