import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/* ============================================================
   Rate limiting

   Credential and email-sending endpoints are the abuse surface: password
   spraying, OTP brute force, and using someone else's account to send mail.

   Limits are keyed by IP *and* the targeted email where one is present, so a
   single attacker cannot burn through one account's budget from many IPs, and
   a shared corporate IP does not lock out unrelated users.
   ============================================================ */

const emailOf = (req) =>
  typeof req.body?.email === "string" ? req.body.email.toLowerCase() : null;

// ipKeyGenerator normalises IPv6 to a /56 subnet, so a single client cannot
// sidestep the limit by rotating through addresses it already controls.
const keyByIpAndEmail = (req) => {
  const ip = ipKeyGenerator(req.ip ?? "");
  const email = emailOf(req);
  return email ? `${ip}:${email}` : ip;
};

const tooMany = (message) => (req, res) =>
  res.status(429).json({
    success: false,
    message,
    code: "RATE_LIMITED",
  });

/**
 * Login / signup / password change / OTP issuance.
 * Successful requests still count — that is deliberate, since a working
 * credential being replayed rapidly is itself a signal worth throttling.
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: keyByIpAndEmail,
  handler: tooMany(
    "Too many attempts. Please wait a few minutes and try again.",
  ),
});

/**
 * Broad ceiling applied to the whole API as a backstop against scripted abuse.
 * Generous enough that legitimate SDK traffic never notices it.
 */
export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooMany("Too many requests. Please slow down."),
});
