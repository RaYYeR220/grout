import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { createStore } from "./store.js";
import { createHttpServer } from "./http.js";
import { userRoutes } from "./routes/users.js";
import { eventRoutes } from "./routes/events.js";
import { orderRoutes } from "./routes/orders.js";
import type { AppContext, Route } from "./types.js";

export function allRoutes(): Route[] {
  return [...userRoutes(), ...eventRoutes(), ...orderRoutes()];
}

/** Builds a context (fresh store, env config unless given) and an un-started HTTP server. */
export function createApp(ctx?: AppContext): { ctx: AppContext; server: Server } {
  const context: AppContext = ctx ?? { store: createStore(), config: loadConfig() };
  return { ctx: context, server: createHttpServer(context, allRoutes()) };
}
