import prisma from "../prisma.js";
import { AUTH_TYPE, PRIVILEGED_AUTH_TYPES } from "./authMiddleware.js";

/* ============================================================
   Authorization

   authMiddleware establishes *who* is calling; this decides *what they may do*.

   Scopes are deny-by-default: a route without an explicit scope grants nothing.

     admin     — full authority: a secret key.
     endUser   — end-user auth surface (signup/login/verify/reset). Any key.
     ownData   — the signed-in end user's OWN records. Secret keys may act on
                 any user. A publishable key needs a live end-user session, and
                 the target user and app are pinned to that session, never
                 taken from the request.
     appRead   — read app-wide data (catalogues, config). Secret or
                 publishable key. Writing app data needs admin.
   ============================================================ */

export const SCOPE = {
  ADMIN: "admin",
  END_USER: "endUser",
  OWN_DATA: "ownData",
  APP_READ: "appRead",
};

export const isPrivileged = (req) => PRIVILEGED_AUTH_TYPES.has(req.auth?.type);

const forbid = (res, message, hint) =>
  res.status(403).json({
    success: false,
    message,
    ...(hint ? { hint } : {}),
    code: "INSUFFICIENT_SCOPE",
  });

const PUBLISHABLE_HINT =
  "Publishable keys only reach sign-in flows and the signed-in user's own data. Call this from your server with a secret key.";

const noSession = (res, message = "You must be signed in to access this resource.") =>
  res.status(401).json({ success: false, message, code: "NO_USER_SESSION" });

/**
 * Pin a publishable-key request to its end-user session.
 *
 * The session JWT is otherwise checked statelessly (see resolveUserSession).
 * Here it is the caller's only credential, so it is checked against the user
 * row: a password reset, logout-all or deactivation then takes effect at once,
 * and a session from another account's app is rejected.
 */
async function pinToSession(req, res, next) {
  const session = req.endUser;
  if (!session) return noSession(res);

  const user = await prisma.user.findFirst({
    where: { id: session.id, adminId: req.admin.id, isActive: true },
    select: { id: true, appId: true, tokenVersion: true },
  });

  if (!user || user.tokenVersion !== session.tokenVersion) {
    return noSession(res, "Your session has ended. Please sign in again.");
  }

  // Anything in the URL or body naming a user or app is ignored from here on.
  req.targetUserId = user.id;
  req.targetAppId = user.appId;
  req.body = { ...(req.body ?? {}), appId: user.appId };

  return next();
}

/**
 * Guard a route with one or more scopes. Passing several means "any of these".
 *
 *   router.get("/allapps", authMiddleware, requireScope(SCOPE.ADMIN), getApps)
 */
export const requireScope = (...scopes) => {
  if (!scopes.length) {
    throw new Error("requireScope() needs at least one scope");
  }

  return async (req, res, next) => {
    const auth = req.auth;

    if (!auth) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: authMiddleware did not run for this route.",
      });
    }

    const privileged = isPrivileged(req);
    const publishable = auth.type === AUTH_TYPE.PUBLISHABLE_KEY;

    try {
      for (const scope of scopes) {
        if (scope === SCOPE.ADMIN && privileged) return next();

        // Any key may sign users in.
        if (scope === SCOPE.END_USER) return next();

        if (scope === SCOPE.APP_READ && (privileged || publishable)) {
          return next();
        }

        if (scope === SCOPE.OWN_DATA) {
          if (privileged) return next();
          if (publishable) return await pinToSession(req, res, next);
        }
      }
    } catch (err) {
      console.error("RequireScope Error:", err);
      return res.status(500).json({
        success: false,
        message: "Server error while checking permissions.",
      });
    }

    /* ---------- denied ---------- */
    return forbid(
      res,
      "You do not have permission to perform this action.",
      publishable ? PUBLISHABLE_HINT : undefined,
    );
  };
};

/**
 * Shorthand for the common case: a route that only privileged callers may reach.
 */
export const adminOnly = requireScope(SCOPE.ADMIN);

/**
 * Gate a route on the calling admin's email being verified. Kept separate
 * from authMiddleware so routes that exist specifically to *get* an admin
 * verified (e.g. send-verify-otp) can skip it.
 */
export const requireVerified = (req, res, next) => {
  if (!req.admin?.isVerified) {
    return res.status(403).json({
      success: false,
      message: "This account is not verified.",
    });
  }
  return next();
};
