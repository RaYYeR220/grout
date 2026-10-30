import { describe, expect, test } from "vitest";
import { Workspace } from "../../src/state/workspace.js";

describe("Workspace", () => {
  test("creating a new file needs no prior read", () => {
    const ws = new Workspace();
    const r = ws.commit("A", "src/a.ts", "x");
    expect(r).toEqual({ ok: true, path: "src/a.ts", version: 1, rev: 1 });
    expect(ws.peek("src/a.ts")?.author).toBe("A");
  });

  test("a write based on a stale read is rejected with the current state", () => {
    const ws = new Workspace();
    ws.commit("seed", "src/routes.ts", "// routes\n");
    ws.read("A", "src/routes.ts");
    ws.read("B", "src/routes.ts");
    expect(ws.commit("A", "src/routes.ts", "// routes\nusers\n")).toMatchObject({ ok: true, version: 2 });
    const r = ws.commit("B", "src/routes.ts", "// routes\norders\n");
    expect(r).toEqual({
      ok: false,
      reason: "stale",
      path: "src/routes.ts",
      current: 2,
      seen: 1,
      currentAuthor: "A",
      currentContent: "// routes\nusers\n",
    });
    expect(ws.peek("src/routes.ts")?.content).toBe("// routes\nusers\n");
  });

  test("overwriting a file you never read is stale with seen=null", () => {
    const ws = new Workspace();
    ws.commit("seed", "a.ts", "1");
    expect(ws.commit("B", "a.ts", "2")).toMatchObject({ ok: false, reason: "stale", seen: null, current: 1 });
  });

  test("the committer's read-set moves to the version it wrote", () => {
    const ws = new Workspace();
    ws.commit("A", "a.ts", "1");
    expect(ws.commit("A", "a.ts", "2")).toMatchObject({ ok: true, version: 2 });
    expect(ws.commit("A", "a.ts", "3")).toMatchObject({ ok: true, version: 3 });
  });

  test("naive mode (cas off) lets a stale write through and counts the lost update", () => {
    const ws = new Workspace({ cas: false });
    ws.commit("seed", "r.ts", "");
    ws.read("A", "r.ts");
    ws.read("B", "r.ts");
    ws.commit("A", "r.ts", "users");
    expect(ws.commit("B", "r.ts", "orders")).toMatchObject({ ok: true, version: 3 });
    expect(ws.lostUpdates()).toBe(1);
    expect(ws.log.at(-1)).toMatchObject({ author: "B", baseVersion: 1, newVersion: 3, overwroteUnseen: true });
  });

  test("edit replaces exactly one occurrence", () => {
    const ws = new Workspace();
    ws.commit("A", "a.ts", "foo bar foo");
    expect(ws.edit("A", "a.ts", "baz", "x")).toEqual({ ok: false, reason: "no-match", path: "a.ts" });
    expect(ws.edit("A", "a.ts", "foo", "x")).toEqual({ ok: false, reason: "ambiguous", path: "a.ts" });
    expect(ws.edit("A", "a.ts", "bar", "qux")).toMatchObject({ ok: true, version: 2 });
    expect(ws.peek("a.ts")?.content).toBe("foo qux foo");
  });

  test("edit on a stale read is rejected like a write", () => {
    const ws = new Workspace();
    ws.commit("A", "a.ts", "one two");
    ws.read("B", "a.ts");
    ws.commit("A", "a.ts", "one two three");
    expect(ws.edit("B", "a.ts", "two", "2")).toMatchObject({ ok: false, reason: "stale", current: 2, seen: 1 });
  });

  test("paths are normalised, so Windows and POSIX spellings are one file", () => {
    const ws = new Workspace();
    ws.commit("A", "src\\a.ts", "1");
    expect(ws.read("B", "src/a.ts")?.version).toBe(1);
    expect(ws.list()).toEqual(["src/a.ts"]);
  });

  test("list filters by prefix and is sorted; snapshot copies current content", () => {
    const ws = new Workspace();
    ws.commit("A", "src/b.ts", "b");
    ws.commit("A", "src/a.ts", "a");
    ws.commit("A", "test/x.test.ts", "t");
    expect(ws.list("src/")).toEqual(["src/a.ts", "src/b.ts"]);
    const snap = ws.snapshot();
    ws.commit("A", "src/a.ts", "a2");
    expect(snap.get("src/a.ts")).toBe("a");
    expect(ws.rev).toBe(4);
  });
});
