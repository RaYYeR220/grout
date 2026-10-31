function num(v, def) {
    if (v === undefined || v.trim() === "")
        return def;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : def;
}
/** Reads PORT (default 3000) and HOLD_SECONDS (default 600) from env. now() returns Date.now(). */
export function loadConfig(env = process.env) {
    return {
        port: num(env.PORT, 3000),
        holdSeconds: num(env.HOLD_SECONDS, 600),
        now: () => Date.now(),
    };
}
