import { authenticate, createSession, hashPassword, toPublicUser, verifyPassword } from "../auth.js";
import { HttpError } from "../types.js";
import { badRequest, bodyObject, isStrLen } from "../util.js";
function validEmail(v) {
    if (typeof v !== "string")
        return false;
    const at = v.indexOf("@");
    return at >= 0 && v.indexOf(".", at + 1) > at;
}
/** Routes: POST /users, POST /sessions, GET /me */
export function userRoutes() {
    return [
        {
            method: "POST",
            pattern: "/users",
            handler: (ctx, req) => {
                const b = bodyObject(req.body);
                const { email, password, name, role } = b;
                if (!validEmail(email))
                    badRequest("invalid email");
                if (typeof password !== "string" || password.length < 8)
                    badRequest("password must have at least 8 characters");
                if (!isStrLen(name, 1, 100))
                    badRequest("name must be 1-100 characters");
                if (role !== "organizer" && role !== "customer")
                    badRequest("role must be organizer or customer");
                const emailLower = email.toLowerCase();
                if (ctx.store.usersByEmail.has(emailLower))
                    throw new HttpError(409, "email already registered");
                const user = {
                    id: ctx.store.nextId(),
                    email,
                    emailLower,
                    passwordHash: hashPassword(password),
                    name,
                    role,
                };
                ctx.store.users.set(user.id, user);
                ctx.store.usersByEmail.set(emailLower, user);
                return { status: 201, body: toPublicUser(user) };
            },
        },
        {
            method: "POST",
            pattern: "/sessions",
            handler: (ctx, req) => {
                const b = bodyObject(req.body);
                const { email, password } = b;
                if (typeof email !== "string" || typeof password !== "string")
                    badRequest("email and password are required");
                const user = ctx.store.usersByEmail.get(email.toLowerCase());
                if (!user || !verifyPassword(password, user.passwordHash))
                    throw new HttpError(401, "wrong email or password");
                return { status: 200, body: { token: createSession(ctx, user.id) } };
            },
        },
        {
            method: "GET",
            pattern: "/me",
            handler: (ctx, req) => ({ status: 200, body: toPublicUser(authenticate(ctx, req)) }),
        },
    ];
}
