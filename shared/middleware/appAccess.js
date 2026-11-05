import prisma from "../prisma.js";
import { checkAppAccess } from "../utils/appAccess.js";
import { AUTH_TYPE } from "./authMiddleware.js";

/* ============================================================
   App access enforcement

   Applies an app's allowedOrigins / allowedIps (managed with the CLI,
   see `npm run authix -- origin:add`) to the SDK surface: /api/users, /api/app and
   /api/app/global. Runs after userAuthMiddleware, so req.admin is the key's
   account.

   Also enforces two rules that depend on the app:
   - A key scoped to one app (ApiKey.appId) only works for that app.
   - A publishable key used from a browser needs the app's allowed origins
     set. Its end-user session cookie is sent cross-site (SameSite=None), so
     without an origin list any other website could make requests as the
     signed-in user.
   ============================================================ */

const asId = (value) => (typeof value === "string" && value ? value : null);

/**
 * Which app this request acts on.
 *
 * A route that names a user acts on that user's app, whatever appId the body
 * claims — so the user's real app is looked up rather than trusting the
 * request to name it. Otherwise the path, body, query, then the end-user
 * session, in that order: the same places the controllers read it from.
 */
export async function resolveRequestAppId(req) {
  // Pinned to the end-user session by requireScope(OWN_DATA).
  if (req.targetAppId) return req.targetAppId;

  const fromPath = asId(req.params?.appId);
  if (fromPath) return fromPath;

  const userId = asId(req.params?.id) ?? asId(req.params?.userId);
  if (userId) {
    const user = await prisma.user.findFirst({
      where: { id: userId, adminId: req.admin.id },
      select: { appId: true },
    });
    if (user) return user.appId;
  }

  return (
    asId(req.body?.appId) ??
    asId(req.query?.appId) ??
    asId(req.endUser?.appId)
  );
}

/**
 * @param resolve How to find the app id. Defaults to resolveRequestAppId;
 *   routers that guard everything with router.use() have no req.params yet
 *   and pass a resolver that reads the path instead.
 */
export const enforceAppAccess =
  (resolve = resolveRequestAppId) =>
  async (req, res, next) => {
    try {
      const appId = await resolve(req);
      const scopedTo = req.auth?.appId;

      if (scopedTo && appId && appId !== scopedTo) {
        return res.status(403).json({
          success: false,
          message: "This API key is limited to a different app.",
          code: "KEY_APP_MISMATCH",
        });
      }

      // No app to check against: the controller rejects the request itself.
      if (!appId) return next();

      const app = await prisma.app.findFirst({
        where: { id: appId, adminId: req.admin.id },
        select: { allowedOrigins: true, allowedIps: true },
      });
      if (!app) return next();

      const decision = checkAppAccess(app, {
        origin: req.headers.origin,
        ip: req.ip,
      });

      if (
        decision.allowed &&
        req.auth?.type === AUTH_TYPE.PUBLISHABLE_KEY &&
        req.headers.origin !== undefined &&
        (app.allowedOrigins ?? []).length === 0
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Add this site to the app's allowed origins (npm run authix -- origin:add) before using a publishable key from a browser.",
          code: "ORIGINS_NOT_CONFIGURED",
        });
      }

      if (!decision.allowed) {
        return res.status(403).json({
          success: false,
          message: decision.message,
          code: decision.code,
        });
      }

      return next();
    } catch (err) {
      console.error("EnforceAppAccess Error:", err);
      return res.status(500).json({
        success: false,
        message: "Server error while checking app access.",
      });
    }
  };

/**
 * An end-user session cookie is sent to every site that asks, so before acting
 * on one, check that this caller could reach the session's own app. The app is
 * taken from the session, never the request: naming an unknown appId would
 * otherwise skip enforceAppAccess, which has no app to check against.
 */
export async function callerMayUseApp(req, appId) {
  if (req.auth?.appId && req.auth.appId !== appId) return false;

  const app = await prisma.app.findFirst({
    where: { id: appId, adminId: req.admin.id },
    select: { allowedOrigins: true, allowedIps: true },
  });
  if (!app) return false;

  const { origin } = req.headers;
  if (!checkAppAccess(app, { origin, ip: req.ip }).allowed) return false;

  const browserWithoutOrigins =
    req.auth?.type === AUTH_TYPE.PUBLISHABLE_KEY &&
    origin !== undefined &&
    (app.allowedOrigins ?? []).length === 0;

  return !browserWithoutOrigins;
}

const isNonStringValue = (value) =>
  value !== undefined && value !== null && typeof value !== "string";

/**
 * Account routes pass appId straight into Prisma filters, where an object such
 * as { "not": "" } is a query rather than a value, and enforceAppAccess would
 * find no app id to check. Not used on the data routes, whose request bodies
 * are the developer's own records and may hold any field called appId.
 */
export const requireStringAppId = (req, res, next) => {
  if (isNonStringValue(req.body?.appId) || isNonStringValue(req.query?.appId)) {
    return res.status(400).json({
      success: false,
      message: "appId must be a string.",
      code: "INVALID_APP_ID",
    });
  }
  return next();
};

/** For router.use() guards, where the app id is the first path segment. */
export const appIdFromPath = (req) => asId(req.path.split("/")[1]);
