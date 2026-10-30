import { describe, expect, test } from "vitest";
import { Board } from "../../src/state/board.js";
import type { TaskSpec } from "../../src/state/blueprint.js";

const t = (id: string, surface: string[], dependsOn: string[] = []): TaskSpec => ({
  id,
  title: id,
  writeSurface: surface,
  requirements: [],
  dependsOn,
  notes: "",
});

describe("Board", () => {
  test("tasks with unmet dependencies are not ready", () => {
    const b = new Board([t("T1", ["a.ts"]), t("T2", ["b.ts"], ["T1"])]);
    expect(b.ready().map((x) => x.id)).toEqual(["T1"]);
    const l = b.lease("T1", "builder-1");
    b.complete(l, "done");
    expect(b.ready().map((x) => x.id)).toEqual(["T2"]);
  });

  test("leased tasks are not offered again", () => {
    const b = new Board([t("T1", ["a.ts"])]);
    b.lease("T1", "builder-1");
    expect(b.ready()).toEqual([]);
    expect(b.status("T1")).toBe("leased");
  });

  test("re-leasing bumps the generation and invalidates the old lease", () => {
    const b = new Board([t("T1", ["a.ts"])]);
    const first = b.lease("T1", "builder-1");
    b.reopen("T1", "stalled");
    const second = b.lease("T1", "builder-2");
    expect(second.generation).toBe(first.generation + 1);
    expect(b.isCurrent(first)).toBe(false);
    expect(b.complete(first, "late")).toBe(false);
    expect(b.complete(second, "ok")).toBe(true);
    expect(b.status("T1")).toBe("done");
  });

  test("reopen keeps feedback history and counts attempts", () => {
    const b = new Board([t("T1", ["a.ts"])]);
    b.complete(b.lease("T1", "w"), "x");
    b.reopen("T1", "test [R2] fails");
    b.complete(b.lease("T1", "w"), "y");
    b.reopen("T1", "still fails");
    expect(b.feedback("T1")).toEqual(["test [R2] fails", "still fails"]);
    expect(b.attempts("T1")).toBe(2);
    expect(b.status("T1")).toBe("ready");
  });

  test("ownerOf resolves single owners and marks shared files", () => {
    const b = new Board([t("T1", ["src/a.ts", "src/routes.ts"]), t("T2", ["src/b.ts", "src/routes.ts"])]);
    expect(b.ownerOf("src/a.ts")).toBe("T1");
    expect(b.ownerOf("src\\b.ts")).toBe("T2");
    expect(b.ownerOf("src/routes.ts")).toBe("shared");
    expect(b.ownerOf("src/zzz.ts")).toBeUndefined();
  });

  test("allApproved only when every task is approved", () => {
    const b = new Board([t("T1", ["a.ts"]), t("T2", ["b.ts"])]);
    b.complete(b.lease("T1", "w"), "x");
    b.approve("T1");
    expect(b.allApproved()).toBe(false);
    b.complete(b.lease("T2", "w"), "x");
    b.approve("T2");
    expect(b.allApproved()).toBe(true);
  });

  test("lease of a task that is not ready throws", () => {
    const b = new Board([t("T1", ["a.ts"]), t("T2", ["b.ts"], ["T1"])]);
    expect(() => b.lease("T2", "w")).toThrow();
  });
});
