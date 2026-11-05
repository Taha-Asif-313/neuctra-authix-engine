import express from "express";
import {
  getUserData,
  addUserData,
  updateUserData,
  deleteUserData,
  deleteMultipleUserData,
  getSingleUserData,
  searchUserData,
  batchUserData,
} from "./userdata.controller.js";

import { userAuthMiddleware } from "../../shared/middleware/userAuthMiddleware.js";
import { requireScope, SCOPE, requireVerified } from "../../shared/middleware/requireScope.js";
import { enforceAppAccess } from "../../shared/middleware/appAccess.js";

const router = express.Router();

/**
 * All user-data routes are authenticated via userAuthMiddleware (x-api-key
 * only) and use SCOPE.OWN_DATA. A secret key may act on any user via the `:id`
 * in the URL. A publishable key needs the user's session cookie, and the
 * `:id` is then ignored: the target is pinned to the session.
 */
const ownData = [
  userAuthMiddleware,
  requireScope(SCOPE.OWN_DATA),
  requireVerified,
  // Resolves the app from the user in the URL, not from the request body.
  enforceAppAccess(),
];

// 🔹 Get all extra data of a user
router.get("/:id/data", ...ownData, getUserData);

// 🔹 Get a single object from a user's data array by dataId
router.get("/:id/data/:dataId", ...ownData, getSingleUserData);

// 🔹 Add a new object to a user's data array
router.post("/:id/data", ...ownData, addUserData);

// 🔹 Update a data object in a user's array
router.put("/:id/data/:dataId", ...ownData, updateUserData);

// 🔹 Delete a data object from a user's array
router.delete("/:id/data/:dataId", ...ownData, deleteUserData);

// 🔹 Search a specific user's data
router.post("/:userId/data/search", ...ownData, searchUserData);

// 🔹 Apply several create/update/delete operations atomically.
//    Declared before "/:id/data/:dataId" would be ambiguous, so it is mounted
//    on its own distinct path segment.
router.post("/:id/data-batch", ...ownData, batchUserData);

// 🔹 Delete several items in one transaction
router.post("/:id/data-bulk-delete", ...ownData, deleteMultipleUserData);

export default router;
