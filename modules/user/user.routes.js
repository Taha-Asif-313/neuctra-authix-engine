import express from "express";
import {
  getUsers,
  updateUser,
  deleteUser,
  loginUser,
  signupUser,
  getProfile,
  sendUserVerifyOTP,
  verifyUserEmail,
  userForgotPassword,
  userResetPassword,
  changeUserPassword,
  checkUser,
  getSession,
  logoutUser,
  getUser,
} from "./user.controller.js";

import { userAuthMiddleware } from "../../shared/middleware/userAuthMiddleware.js";
import { requireScope, SCOPE, requireVerified } from "../../shared/middleware/requireScope.js";
import { enforceAppAccess, requireStringAppId } from "../../shared/middleware/appAccess.js";
import { authRateLimit } from "../../shared/middleware/rateLimit.js";

const router = express.Router();

/**
 * Every route here is authenticated via userAuthMiddleware (x-api-key only —
 * only).
 *
 *   endUser — sign-in flows. Any key, including a publishable one.
 *   ownData — one user's own account. A secret key may name any user; a
 *             publishable key is pinned to the signed-in user's session.
 *   admin   — reading or listing arbitrary users. Secret key only.
 */
// enforceAppAccess applies the app's allowed origins / IPs.
const endUser = [userAuthMiddleware, requireScope(SCOPE.END_USER), requireStringAppId, enforceAppAccess()];
const ownData = [userAuthMiddleware, requireScope(SCOPE.OWN_DATA), requireVerified, requireStringAppId, enforceAppAccess()];
const admin = [userAuthMiddleware, requireScope(SCOPE.ADMIN), requireVerified, requireStringAppId, enforceAppAccess()];

/* ===================================================
   👤 END-USER AUTH SURFACE (browser-safe)
   =================================================== */

router.post("/signup", authRateLimit, ...endUser, signupUser);
router.post("/login", authRateLimit, ...endUser, loginUser);
router.post("/logout", ...endUser, logoutUser);

// Returns { authenticated: false } rather than 401 when no session exists.
router.get("/session", ...endUser, getSession);

/* ===================================================
   🙋 THE SIGNED-IN USER'S OWN RECORD
   =================================================== */

router.post("/profile", ...ownData, getProfile);
router.put("/update/:id", ...ownData, updateUser);
router.put("/change-password/:id", authRateLimit, ...ownData, changeUserPassword);
router.delete("/delete/:userId", ...ownData, deleteUser);

/* ===================================================
   ✉️ VERIFICATION & PASSWORD RESET
   These previously required no credential at all, which left them open to
   anonymous email flooding. They require an API key (publishable is
   enough), are rate limited, and each code allows MAX_OTP_ATTEMPTS guesses.
   =================================================== */

router.post("/send-verify-otp/:id", authRateLimit, ...endUser, sendUserVerifyOTP);
router.post("/verify-email", authRateLimit, ...endUser, verifyUserEmail);
router.post("/forgot-password", authRateLimit, ...endUser, userForgotPassword);
router.post("/reset-password", authRateLimit, ...endUser, userResetPassword);

/* ===================================================
   🛡️ ACCOUNT-LEVEL USER MANAGEMENT
   Enumerating or inspecting arbitrary users requires a secret key.
   =================================================== */

router.get("/:appId/user", ...admin, getUser);
router.get("/list/:appId", ...admin, getUsers);
router.get("/check-user/:id", ...admin, checkUser);

export default router;
