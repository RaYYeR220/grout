import { HttpError } from "./types.js";

/** Throws HttpError(400, message). */
export function badRequest(message: string): never {
  throw new HttpError(400, message);
}

/** True if v is a number that is an integer (Number.isInteger). */
export function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** True if v is a string whose length is within [min, max]. */
export function isStrLen(v: unknown, min: number, max: number): v is string {
  return typeof v === "string" && v.length >= min && v.length <= max;
}

/** Parses a request time with Date.parse. Returns epoch ms, or null if v is not a string or not parseable. */
export function parseTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch ms → toISOString(). */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Sentinel placed in req.body when the request body was non-empty but not valid JSON. */
export const INVALID_JSON: unique symbol = Symbol("INVALID_JSON");

/** Returns body as a plain object, or throws 400 if it is not a non-null, non-array object (or invalid JSON). */
export function bodyObject(body: unknown): Record<string, unknown> {
  if (body === INVALID_JSON) badRequest("invalid JSON body");
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    badRequest("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
