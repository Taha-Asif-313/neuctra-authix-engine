import jwt from "jsonwebtoken";

/* ============================================================
   End-user sessions.

   There is deliberately NO fallback secret. A missing secret is a fatal
   misconfiguration, not something to paper over with a default.
   ============================================================ */

const AUDIENCE = "authix:user";

export const COOKIE = { USER: "authix_user_session" };

const secret = () => {
  const value = process.env.USER_JWT_SECRET;
  if (!value) throw new Error("USER_JWT_SECRET is not set.");
  return value;
};

/** Fail at boot rather than at the first login. */
export function assertJwtConfig() {
  secret();
}

/** @param {object} payload must include `tv` (the user's tokenVersion) */
export const signUserToken = (payload) =>
  jwt.sign(payload, secret(), {
    audience: AUDIENCE,
    expiresIn: "1d",
    algorithm: "HS256",
  });

export const verifyUserToken = (token) =>
  jwt.verify(token, secret(), { audience: AUDIENCE, algorithms: ["HS256"] });
