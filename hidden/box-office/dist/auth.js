import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { HttpError } from "./types.js";
/** Hash a password (node:crypto scrypt/sha256 with salt). Never returned anywhere. */
export function hashPassword(password) {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 32).toString("hex");
    return `${salt}:${hash}`;
}
export function verifyPassword(password, hash) {
    const [salt, expected] = hash.split(":");
    if (!salt || !expected)
        return false;
    const actual = scryptSync(password, salt, 32);
    const exp = Buffer.from(expected, "hex");
    return exp.length === actual.length && timingSafeEqual(actual, exp);
}
/** Create a new random session token for the user and store it in ctx.store.sessions. */
export function createSession(ctx, userId) {
    const token = randomBytes(32).toString("hex");
    ctx.store.sessions.set(token, userId);
    return token;
}
/** Reads "Authorization: Bearer <token>". Missing/malformed/unknown → throws HttpError(401). */
export function authenticate(ctx, req) {
    let header = req.headers["authorization"];
    if (Array.isArray(header))
        header = header[0];
    if (typeof header !== "string")
        throw new HttpError(401, "missing token");
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!m)
        throw new HttpError(401, "malformed token");
    const userId = ctx.store.sessions.get(m[1]);
    const user = userId === undefined ? undefined : ctx.store.users.get(userId);
    if (!user)
        throw new HttpError(401, "invalid token");
    return user;
}
/** authenticate() then, if role given and user.role !== role, throws HttpError(403). */
export function requireRole(ctx, req, role) {
    const user = authenticate(ctx, req);
    if (role && user.role !== role)
        throw new HttpError(403, `requires role ${role}`);
    return user;
}
export function toPublicUser(user) {
    return { id: user.id, email: user.email, name: user.name, role: user.role };
}
