import prisma from "../prisma.js";
import { parseApiKey, verifyApiKey } from "../utils/crypto.js";
import { COOKIE, verifyUserToken } from "../utils/jwt.js";

/* ============================================================
   Authentication

   Resolves the caller onto `req.auth`:

     api_key          → sk_live_… secret key      (full authority,
                                                   server-side only)
     publishable_key  → pk_live_… publishable key (sign-in flows, plus the
                                                   signed-in user's own data)

   Any API key may carry an end-user session cookie alongside it
   (req.endUser, see resolveUserSession below).

   Authorization is NOT decided here — see requireScope.js. This middleware only
   establishes *who is calling*.
   ============================================================ */

export const AUTH_TYPE = {
  /** A secret key. Named api_key for compatibility with existing checks. */
  API_KEY: "api_key",
  PUBLISHABLE_KEY: "publishable_key",
};

/** Callers with full account authority. */
export const PRIVILEGED_AUTH_TYPES = new Set([
  AUTH_TYPE.API_KEY,
]);

/**
 * Secret keys are refused from browsers. Browsers always send an Origin header
 * on cross-origin requests and page scripts cannot remove it, so a secret key
 * arriving with one was shipped in a frontend bundle and is readable by every
 * visitor. Server runtimes do not send Origin.
 *
 * AUTHIX_ALLOW_BROWSER_SECRET_KEYS=true turns this off while existing apps
 * move to publishable keys. Never leave it on.
 */
const allowBrowserSecretKeys = () =>
  process.env.AUTHIX_ALLOW_BROWSER_SECRET_KEYS === "true";

/** Look up and validate an `x-api-key` header.  */
export async function resolveApiKey(rawKey) {
  const parsed = parseApiKey(rawKey);
  if (!parsed) return { error: "Malformed API key." };

  const record = await prisma.apiKey.findUnique({
    where: { prefix: parsed.prefix },
    include: {
      admin: {
        select: {
          id: true,
          email: true,
          name: true,
          isVerified: true,
          isActive: true,
        },
      },
    },
  });

  if (!record) return { error: "Invalid API key." };
  if (record.revokedAt) return { error: "This API key has been revoked." };
  if (!verifyApiKey(rawKey, record.hash)) return { error: "Invalid API key." };
  if (!record.admin) return { error: "Invalid API key." };
  if (record.admin.isActive === false) {
    return { error: "This account has been disabled.", status: 403 };
  }

  if (!record.admin.isVerified) {
    return {
      error: "Account email is not verified. Verify it to use the API.",
      status: 403,
    };
  }

  return { record };
}

/**
 * Optional end-user session — never fatal, since many routes don't need one.
 *
 * Deliberately stateless: no DB lookup. This runs on every API-key
 * request across every app on the platform, and Authix has no way to know in
 * advance how many apps or how many end users that is — a per-request
 * "is this session still valid" round trip against the User table does not
 * scale to that, unlike the admin dashboard's own session (one row, checked
 * for a comparatively tiny number of admins). So this trusts the JWT's
 * signature and expiry alone, the same way the admin/API key
 * checks already end at "is the credential itself valid."
 *
 * So this says only that the token is genuine. tokenVersion and isVerified are
 * snapshots taken at login, and the token does not name the account it belongs
 * to. Anything that relies on a session must check it against the user row:
 * pinToSession for data access, getSession in user.controller.js for session
 * checks. 
 */
export function resolveUserSession(req) {
  const token = req.cookies?.[COOKIE.USER];
  if (!token) return null;

  try {
    const decoded = verifyUserToken(token);
    return {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      appId: decoded.appId,
      isVerified: decoded.isVerified,
      tokenVersion: decoded.tv,
    };
  } catch {
    return null; // expired or forged → simply "not signed in"
  }
}

/**
 * Validate an `x-api-key` header and set req.auth / req.admin / req.endUser.
 * Used by userAuthMiddleware.
 * @returns {Promise<null | { status: number, message: string, code?: string }>}
 *   null on success.
 */
export async function authenticateApiKey(req, rawKey) {
  const { record, error, status } = await resolveApiKey(rawKey);
  if (error) return { status: status || 401, message: error };

  const publishable = record.kind === "publishable";

  if (!publishable && req.headers.origin !== undefined) {
    if (!allowBrowserSecretKeys()) {
      return {
        status: 403,
        code: "SECRET_KEY_IN_BROWSER",
        message:
          "Secret keys cannot be used from a browser: anyone visiting the site can read them. Use a publishable key in frontend code, and keep the secret key on your server.",
      };
    }
    console.warn(
      `Secret API key ${record.prefix} used from browser origin ${req.headers.origin}. Move this app to a publishable key.`,
    );
  }

  // Touch lastUsedAt without blocking the request.
  prisma.apiKey
    .update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    })
    .catch((err) => console.error("apiKey.lastUsedAt update failed:", err));

  req.auth = {
    type: publishable ? AUTH_TYPE.PUBLISHABLE_KEY : AUTH_TYPE.API_KEY,
    adminId: record.admin.id,
    appId: record.appId ?? null,
    keyId: record.id,
  };
  req.admin = record.admin;

  // API-key requests may carry an end-user session alongside them.
  // Stateless — no DB call, see resolveUserSession above.
  req.endUser = resolveUserSession(req);

  return null;
}

export const sendAuthFailure = (res, { status, message, code }) =>
  res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
