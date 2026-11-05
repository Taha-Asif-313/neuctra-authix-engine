import express from "express";
import {
  addAppDataItem,
  getAppData,
  getAppDataByCategory,
  getSingleAppDataItem,
  updateAppDataItem,
  deleteAppDataItem,
  searchAppData,
} from "./appdata.controller.js";

import { userAuthMiddleware } from "../../shared/middleware/userAuthMiddleware.js";
import { requireScope, SCOPE, requireVerified } from "../../shared/middleware/requireScope.js";
import { enforceAppAccess, appIdFromPath } from "../../shared/middleware/appAccess.js";

const router = express.Router();

// Authenticated via userAuthMiddleware (x-api-key only). Reading app data
// (catalogues, config) works with a publishable key; writing it needs a
// secret key, or any visitor could rewrite what every user sees.
// Every route here starts with /:appId, but router.use() runs before route
// matching, so the app id is read from the path.
router.use(
  userAuthMiddleware,
  requireVerified,
  enforceAppAccess(appIdFromPath),
);

const read = [requireScope(SCOPE.APP_READ)];
const write = [requireScope(SCOPE.ADMIN)];

/* Get ALL appData */
router.get("/:appId/app-data", ...read, getAppData);

/* Get appData by category */
router.get("/:appId/app-data/:category", ...read, getAppDataByCategory);

/* Add new appData item */
router.post("/:appId/data/:dataCategory", ...write, addAppDataItem);

/* Get single appData item */
router.get("/:appId/data/:itemId", ...read, getSingleAppDataItem);

/* Update appData item */
router.patch("/:appId/data/:itemId", ...write, updateAppDataItem);

/* Delete appData item */
router.delete("/:appId/data/:itemId", ...write, deleteAppDataItem);

/* Search AppData By DataCategory, Query, Keys */
router.post("/:appId/app-data/search", ...read, searchAppData);

export default router;
