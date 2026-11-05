import express from "express";
import { userAuthMiddleware } from "../../shared/middleware/userAuthMiddleware.js";
import { requireScope, SCOPE, requireVerified } from "../../shared/middleware/requireScope.js";
import { enforceAppAccess, appIdFromPath } from "../../shared/middleware/appAccess.js";
import {
  getAllUsersDataFromApp,
  getAllUsersFromApp,
  searchInAllAppUsers,
  searchInAllAppUsersData,
} from "./appSearch.controller.js";

const router = express.Router();

/**
 * =========================================================
 * GLOBAL APP DATA ROUTES
 *
 * Authenticated via userAuthMiddleware (x-api-key only) with SCOPE.ADMIN:
 * these read every user of an app, so they need a secret key.
 * =========================================================
 */
// Every route here starts with /:appId, but router.use() runs before route
// matching, so the app id is read from the path.
router.use(
  userAuthMiddleware,
  requireScope(SCOPE.ADMIN),
  requireVerified,
  enforceAppAccess(appIdFromPath),
);

/**
 * =========================================================
 * APP USERS ROUTES
 * =========================================================
 */

/**
 * Search users across the entire app
 * POST /:appId/all-app-users/search
 */
router.post("/:appId/all-app-users/search", searchInAllAppUsers);

/**
 * Get all users of a specific app
 * GET /:appId/all-app-users
 */
router.post("/:appId/all-app-users", getAllUsersFromApp);

/**
 * =========================================================
 * APP USERS DATA ROUTES
 * =========================================================
 */

/**
 * Search inside all users' data within an app
 * (search by keys / fields / metadata)
 * GET /:appId/all-app-users-data/search
 */
router.post("/:appId/all-app-users-data/search", searchInAllAppUsersData);

/**
 * Get all users' data for a specific app
 * GET /:appId/all-app-users-data
 */
router.post("/:appId/all-app-users-data", getAllUsersDataFromApp);

export default router;
