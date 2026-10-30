#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const USAGE = "usage: todo <command> [arguments]";

class Failure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const dataFile = () => resolve(process.env.TODO_FILE || "todo.json");

function load(file) {
  if (!existsSync(file)) return { lastId: 0, items: [] };
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || !Array.isArray(data.items) || !Number.isInteger(data.lastId)) throw new Error("bad shape");
    return data;
  } catch {
    throw new Failure(1, "error: cannot read data file");
  }
}

const save = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

function parseId(arg) {
  const digits = arg?.startsWith("#") ? arg.slice(1) : arg;
  if (digits === undefined || !/^[0-9]+$/.test(digits) || Number(digits) < 1) throw new Failure(2, "error: invalid id");
  return Number(digits);
}

function find(data, id) {
  const item = data.items.find((i) => i.id === id);
  if (!item) throw new Failure(1, `error: no item #${id}`);
  return item;
}

function run(argv) {
  const [command, ...rest] = argv;
  const file = dataFile();
  switch (command) {
    case "add": {
      const text = rest.join(" ").trim();
      if (!text) throw new Failure(2, "error: text is required");
      const data = load(file);
      const id = data.lastId + 1;
      data.lastId = id;
      data.items.push({ id, text, done: false });
      save(file, data);
      return [`added #${id}`];
    }
    case "list": {
      if (rest.some((a) => a !== "--open" && a !== "--done")) throw new Failure(2, USAGE);
      const open = rest.includes("--open");
      const done = rest.includes("--done");
      const items = load(file)
        .items.filter((i) => (!open && !done) || (open && !i.done) || (done && i.done))
        .sort((a, b) => a.id - b.id);
      return items.length ? items.map((i) => `[${i.done ? "x" : " "}] #${i.id} ${i.text}`) : ["no items"];
    }
    case "done": {
      const id = parseId(rest[0]);
      const data = load(file);
      find(data, id).done = true;
      save(file, data);
      return [`done #${id}`];
    }
    case "remove": {
      const id = parseId(rest[0]);
      const data = load(file);
      const item = find(data, id);
      data.items = data.items.filter((i) => i !== item);
      save(file, data);
      return [`removed #${id}`];
    }
    case "clear": {
      const data = load(file);
      const before = data.items.length;
      data.items = data.items.filter((i) => !i.done);
      save(file, data);
      return [`cleared ${before - data.items.length}`];
    }
    default:
      throw new Failure(2, USAGE);
  }
}

try {
  process.stdout.write(`${run(process.argv.slice(2)).join("\n")}\n`);
} catch (err) {
  if (!(err instanceof Failure)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exitCode = err.code;
}
