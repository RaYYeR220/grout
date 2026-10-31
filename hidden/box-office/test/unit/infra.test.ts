import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createStore } from "../../src/store.js";
import { matchPattern } from "../../src/http.js";
import { hashPassword, verifyPassword } from "../../src/auth.js";
import { isInt, isStrLen, parseTime, bodyObject } from "../../src/util.js";

describe("infra", () => {
  it("config defaults and env", () => {
    const d = loadConfig({});
    expect(d.port).toBe(3000);
    expect(d.holdSeconds).toBe(600);
    const c = loadConfig({ PORT: "4123", HOLD_SECONDS: "3" });
    expect(c.port).toBe(4123);
    expect(c.holdSeconds).toBe(3);
  });
  it("store ids unique", () => {
    const s = createStore();
    expect(s.nextId()).not.toBe(s.nextId());
    expect(s.nextSeq()).toBeLessThan(s.nextSeq());
  });
  it("matchPattern", () => {
    expect(matchPattern("/events/:id/cancel", "/events/abc/cancel")).toEqual({ id: "abc" });
    expect(matchPattern("/events/:id", "/events/abc/cancel")).toBeNull();
    expect(matchPattern("/me", "/me")).toEqual({});
  });
  it("passwords", () => {
    const h = hashPassword("password1");
    expect(verifyPassword("password1", h)).toBe(true);
    expect(verifyPassword("password2", h)).toBe(false);
  });
  it("util", () => {
    expect(isInt(3)).toBe(true);
    expect(isInt(3.5)).toBe(false);
    expect(isStrLen("", 1, 2)).toBe(false);
    expect(parseTime("nope")).toBeNull();
    expect(() => bodyObject([])).toThrow();
  });
});
