import { randomUUID } from "node:crypto";
import type { Store } from "./types.js";

/** Creates an empty in-memory store. nextId() returns globally unique strings (e.g. randomUUID or prefixed counter). */
export function createStore(): Store {
  let seq = 0;
  return {
    users: new Map(),
    usersByEmail: new Map(),
    sessions: new Map(),
    events: new Map(),
    orders: new Map(),
    discounts: new Map(),
    waitlist: [],
    nextId: () => randomUUID(),
    nextSeq: () => ++seq,
  };
}
