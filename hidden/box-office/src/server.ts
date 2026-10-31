#!/usr/bin/env node
import { createApp } from "./app.js";

const { ctx, server } = createApp();
server.listen(ctx.config.port, () => {
  console.log(`Box Office API listening on port ${ctx.config.port}`);
});
