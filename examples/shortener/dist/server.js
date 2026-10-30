#!/usr/bin/env node
import { createApp } from "./app.js";
import { createStore } from "./store.js";
const raw = process.env.PORT;
const parsed = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3000;
const server = createApp(createStore());
server.on("error", (err) => {
    console.error(err);
    process.exit(1);
});
server.listen(port, "0.0.0.0");
