import prisma from "../../shared/prisma.js";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { hashOTP } from "../../shared/utils/crypto.js";
import { checkOtp, clearedOtpFields, freshOtpFields } from "../../shared/utils/otp.js";
import { signUserToken, COOKIE } from "../../shared/utils/jwt.js";
import { PRIVILEGED_AUTH_TYPES } from "../../shared/middleware/authMiddleware.js";
import { sendOtpEmail } from "../../shared/utils/mailer.js";
import {
  comparePassword,
  hashPassword,
  isAcceptablePassword,
  PASSWORD_TOO_SHORT,
} from "../../shared/utils/password.js";
import { callerMayUseApp } from "../../shared/middleware/appAccess.js";
import { adjustUserDataStorage } from "../../shared/utils/storageCalculator.js";

/** Cookie flags for the end-user session. Shared by login and logout so the
 *  two can never disagree — mismatched flags leave an uncleared cookie. */
const userCookieOptions = () => {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
  };
};

/**
 * Resolve which user a request may act on.
 *
 * Publishable-key requests are pinned to the signed-in user by
 * requireScope(OWN_DATA), which sets req.targetUserId. Secret keys may name
 * any user of the account.
 */
export const resolveTargetUserId = (req, requestedId) =>
  req.targetUserId ?? requestedId;

// ------------------------------------------------------------
// @desc    Register a new user for a specific app
// @route   POST /api/users/signup
// @access  Private (App-level, Admin-level)
const PRIVILEGED_CALLERS = PRIVILEGED_AUTH_TYPES;

/** Roles are free-form labels the app defines; only shape is checked. */
const MAX_ROLE_LENGTH = 50;

/**
 * @returns {{ role?: string, error?: string }}
 *   `role` undefined means "not provided, leave as is".
 */
const parseRole = (role) => {
  if (role === undefined || role === null) return {};
  if (typeof role !== "string") return { error: "Role must be a string." };

  const trimmed = role.trim();
  if (!trimmed) return {};
  if (trimmed.length > MAX_ROLE_LENGTH) {
    return { error: `Role must be ${MAX_ROLE_LENGTH} characters or fewer.` };
  }
  return { role: trimmed };
};

// ------------------------------------------------------------
export const signupUser = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      appId,
      phone,
      address,
      avatarUrl,
      username,
      role,
    } = req.body;

    // --------------------------------------------------------
    // 1. Basic validation
    // --------------------------------------------------------
    if (!name || !email || !password || !appId) {
      return res.status(400).json({
        success: false,
        message: "Name, email, password, and appId are required.",
      });
    }

    if (!isAcceptablePassword(password)) {
      return res.status(400).json(PASSWORD_TOO_SHORT);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = name.trim();
    const normalizedUsername = username?.trim() || null;

    if (!normalizedName) {
      return res.status(400).json({
        success: false,
        message: "Name cannot be empty.",
      });
    }

    // --------------------------------------------------------
    // 2. Find and validate app
    // --------------------------------------------------------
    const app = await prisma.app.findFirst({
      where: req.admin
        ? {
            id: appId,
            adminId: req.admin.id,
            isActive: true,
          }
        : {
            id: appId,
            isActive: true,
          },
      select: {
        id: true,
        adminId: true,
        isActive: true,
      },
    });

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or inactive.",
      });
    }

    // --------------------------------------------------------
    // 3. Resolve admin ID
    // --------------------------------------------------------
    const adminId = req.admin?.id || app.adminId;

    if (!adminId) {
      return res.status(500).json({
        success: false,
        message: "Unable to determine app administrator.",
      });
    }

    // --------------------------------------------------------
    // 5. Check duplicate email
    // --------------------------------------------------------
    const existingUser = await prisma.user.findUnique({
      where: {
        email_appId: {
          email: normalizedEmail,
          appId,
        },
      },
      select: {
        id: true,
      },
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered for this app.",
        code: "USER_ALREADY_EXISTS",
      });
    }

    // --------------------------------------------------------
    // 6. Hash password
    // --------------------------------------------------------
    const hashedPassword = await bcrypt.hash(password, 12);

    // --------------------------------------------------------
    // 7. Resolve role
    // --------------------------------------------------------
    // Public signup always creates a normal user, so an end user can never
    // grant themselves a role. Only the account owner's route
    // (POST /api/apps/:appId/users) sets allowRoleAssignment.
    let userRole = "user";

    if (req.allowRoleAssignment) {
      const parsed = parseRole(role);
      if (parsed.error) {
        return res.status(400).json({
          success: false,
          message: parsed.error,
          code: "INVALID_ROLE",
        });
      }
      if (parsed.role) userRole = parsed.role;
    }

    // --------------------------------------------------------
    // 8. Create user
    // --------------------------------------------------------
    const user = await prisma.user.create({
      data: {
        name: normalizedName,
        email: normalizedEmail,
        password: hashedPassword,

        username: normalizedUsername,

        phone: phone?.trim() || null,
        address: address?.trim() || null,
        avatarUrl: avatarUrl?.trim() || null,

        isActive: true,
        isVerified: false,

        otp: null,
        otpExpiry: null,

        role: userRole,

        appId,
        adminId,

        // Records live in UserDataItem now; there is no `data` column.
        settings: null,
        packageInfo: null,
        notifications: null,
        extraInfo: null,
      },

      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        phone: true,
        address: true,
        avatarUrl: true,
        isVerified: true,
        isActive: true,
        role: true,
        appId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // --------------------------------------------------------
    // 10. Response
    // --------------------------------------------------------
    return res.status(201).json({
      success: true,
      message: "Signup successful.",
      user,
    });
  } catch (err) {
    console.error("SignupUser Error:", err);

    // Prisma unique constraint
    if (err.code === "P2002") {
      if (err.meta?.target?.includes("email")) {
        return res.status(409).json({
          success: false,
          message: "Email is already registered for this app.",
          code: "EMAIL_ALREADY_EXISTS",
        });
      }

      return res.status(409).json({
        success: false,
        message: "A user with the provided information already exists.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "An unexpected error occurred. Please try again later.",
      ...(process.env.NODE_ENV === "development" && {
        error: err.message,
      }),
    });
  }
};

/**
 * @desc    User login for a specific app
 * @route   POST /api/users/login
 * @access  Private (App-level, Admin-level)
 */
export const loginUser = async (req, res) => {
  try {
    const { email, password, appId } = req.body;

    if (!email || !password || !appId) {
      return res.status(400).json({
        success: false,
        message: "Email, password, and appId are required",
      });
    }

    // 1️⃣ Verify app — it must belong to the key's account.
    const app = await prisma.app.findFirst({
      where: { id: appId, adminId: req.admin.id, isActive: true },
      select: { id: true },
    });

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "Invalid or inactive app",
      });
    }

    // 2️⃣ Find user
    const user = await prisma.user.findFirst({
      where: {
        email: email.toLowerCase(),
        appId,
        isActive: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // 3️⃣ Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // 4️⃣ Create the session JWT.
    // Signed with USER_JWT_SECRET and carrying aud "authix:user", so it is
    // structurally unusable against admin routes. End-user sessions are
    // resolved statelessly (signature + expiry only — see resolveUserSession
    // in authMiddleware.js), so `tv` and `isVerified` are snapshots as of
    // login. Whatever relies on a session compares them with the user row:
    // pinToSession for data access, getSession for session checks.
    const token = signUserToken({
      id: user.id,
      email: user.email,
      role: user.role,
      appId: user.appId,
      isVerified: user.isVerified,
      tv: user.tokenVersion,
    });

    res.cookie(COOKIE.USER, token, {
      ...userCookieOptions(),
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    // 7️⃣ Return SAFE user data
    return res.status(200).json({
      success: true,
      message: "Login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
        appId: user.appId,
        avatarUrl: user.avatarUrl,
        username: user.username,
        isActive: user.isActive,
      },
    });
  } catch (err) {
    console.error("UserLogin Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

/**
 * @desc    User logout
 * @route   POST /api/users/logout
 * @access  Private (User must be logged in)
 */
export const logoutUser = async (req, res) => {
  try {
    // Revoke the token as well as the cookie, so a copy of it stops working.
    // tokenVersion is per user, so this signs out every device. Never fatal:
    // the user is still signed out of this browser if the write fails.
    const session = req.endUser;
    if (Number.isInteger(session?.tokenVersion)) {
      try {
        if (await callerMayUseApp(req, session.appId)) {
          await prisma.user.updateMany({
            where: {
              id: session.id,
              adminId: req.admin.id,
              tokenVersion: session.tokenVersion,
            },
            data: { tokenVersion: { increment: 1 } },
          });
        }
      } catch (err) {
        console.error("UserLogout revoke failed:", err);
      }
    }

    // Clear the cookie. Flags must match those used at login.
    res.cookie(COOKIE.USER, "", {
      ...userCookieOptions(),
      expires: new Date(0), // Expire immediately
    });

    return res.status(200).json({
      success: true,
      message: "Logout successful",
    });
  } catch (err) {
    console.error("UserLogout Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

/**
 * 🔐 Check current authentication session (cookie-based)
 **/
export const getSession = async (req, res) => {
  try {
    // A null value here simply means "not signed in" — never an error.
    const session = req.endUser;

    if (!session) {
      return res.status(200).json({ authenticated: false });
    }

    // The cookie only proves the token was issued once. Apps use this answer
    // to decide who is signed in, so it is checked against the live user row,
    // and only reported to a caller that belongs to that user's app.
    const user = await prisma.user.findFirst({
      where: { id: session.id, adminId: req.admin.id, isActive: true },
      select: {
        id: true,
        email: true,
        role: true,
        appId: true,
        isVerified: true,
        tokenVersion: true,
      },
    });

    if (
      !user ||
      user.tokenVersion !== session.tokenVersion ||
      !(await callerMayUseApp(req, user.appId))
    ) {
      return res.status(200).json({ authenticated: false });
    }

    return res.status(200).json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        appId: user.appId,
        isVerified: user.isVerified,
      },
    });
  } catch (err) {
    console.error("getSession error:", err);
    return res.status(500).json({ authenticated: false });
  }
};

/* =====================================================
   👤 GET USER BY ID OR USERNAME
   @route   GET /api/users/:appId/user
   @access  Private (Admin / App)
   @query   ?id=USER_ID
   @query   ?username=USERNAME
===================================================== */
export const getUser = async (req, res) => {
  try {
    const { appId } = req.params;
    const { id, username } = req.query;

    // ✅ Validate input
    if (!appId) {
      return res.status(400).json({
        success: false,
        message: "appId is required",
      });
    }

    if (!id && !username) {
      return res.status(400).json({
        success: false,
        message: "Either 'id' or 'username' is required",
      });
    }

    // ✅ Verify app ownership
    const app = await prisma.app.findFirst({
      where: {
        id: appId,
        ...(req.admin && { adminId: req.admin.id }),
        isActive: true,
      },
      select: {
        id: true,
      },
    });

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or unauthorized",
      });
    }

    // ✅ Find user
    const user = await prisma.user.findFirst({
      where: {
        appId,
        isActive: true,
        OR: [
          ...(id ? [{ id: String(id) }] : []),
          ...(username ? [{ username: String(username) }] : []),
        ],
      },
      select: {
        id: true,
        username: true,
        name: true,
        email: true,

        phone: true,
        address: true,
        avatarUrl: true,

        role: true,
        isVerified: true,
        isActive: true,

        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: user,
    });
  } catch (err) {
    console.error("GetUser Error:", err);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

/**
 * @desc    Update user details
 * @route   PUT /api/users/:id
 * @access  Private (Admin only)
 */
export const updateUser = async (req, res) => {
  try {
    // --------------------------------------------------------
    // 1. Get user ID from the verified session in trusted server integrations.
    // --------------------------------------------------------
    const userId = resolveTargetUserId(req, req.params.id);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required.",
      });
    }

    // --------------------------------------------------------
    // 2. Get request data
    // --------------------------------------------------------
    const {
      name,
      email,
      password,
      appId,
      phone,
      address,
      avatarUrl,
      isActive,
      role,
      username,
      currentPassword,

      // data
      settings,
      packageInfo,
      notifications,
      extraInfo,
    } = req.body;

    // --------------------------------------------------------
    // 3. Validate app ID
    // --------------------------------------------------------
    if (!appId) {
      return res.status(400).json({
        success: false,
        message: "App ID is required.",
      });
    }

    // --------------------------------------------------------
    // 4. Verify app belongs to logged-in admin
    // --------------------------------------------------------
    const app = await prisma.app.findFirst({
      where: {
        id: appId,
        adminId: req.admin.id,
      },
      select: {
        id: true,
        adminId: true,
        isActive: true,
        applicationName: true,
      },
    });

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or does not belong to you.",
        code: "APP_NOT_FOUND",
      });
    }

    // --------------------------------------------------------
    // 5. Check app status
    // --------------------------------------------------------
    if (!app.isActive) {
      return res.status(400).json({
        success: false,
        message: "Cannot update a user under an inactive app.",
        code: "APP_INACTIVE",
      });
    }

    // --------------------------------------------------------
    // 6. Find user
    // --------------------------------------------------------
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        appId: app.id,
        adminId: req.admin.id,
      },
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        isVerified: true,
        isActive: true,
        role: true,
        phone: true,
        address: true,
        avatarUrl: true,
        appId: true,
        adminId: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
        code: "USER_NOT_FOUND",
      });
    }

    // --------------------------------------------------------
    // 7. Normalize email
    // --------------------------------------------------------
    const normalizedEmail =
      typeof email === "string" && email.trim()
        ? email.trim().toLowerCase()
        : null;

    const emailChanged =
      normalizedEmail && normalizedEmail !== user.email.toLowerCase();

    // --------------------------------------------------------
    // 7b. Limits for the signed-in user editing themselves
    //
    // A publishable key acts with the user's session alone. A stolen session
    // must not be able to lock the owner out, so passwords change only via
    // /change-password and an email change needs the current password. Status
    // and packageInfo (plans, entitlements) are the app's to set, from a server.
    // --------------------------------------------------------
    if (!PRIVILEGED_CALLERS.has(req.auth?.type)) {
      if (password !== undefined) {
        return res.status(400).json({
          success: false,
          message: "Use change-password to set a new password.",
          code: "USE_CHANGE_PASSWORD",
        });
      }

      if (isActive !== undefined || packageInfo !== undefined) {
        return res.status(403).json({
          success: false,
          message:
            "isActive and packageInfo can only be changed from your server with a secret key.",
          code: "INSUFFICIENT_SCOPE",
        });
      }

      if (emailChanged) {
        const { password: hash } = await prisma.user.findUnique({
          where: { id: user.id },
          select: { password: true },
        });
        const ok =
          typeof currentPassword === "string" &&
          (await comparePassword(currentPassword, hash));
        if (!ok) {
          return res.status(401).json({
            success: false,
            message: "Enter your current password to change your email.",
            code: "CURRENT_PASSWORD_REQUIRED",
          });
        }
      }
    }

    // --------------------------------------------------------
    // 8. Check email uniqueness
    // --------------------------------------------------------
    if (emailChanged) {
      const existingUser = await prisma.user.findUnique({
        where: {
          email_appId: {
            email: normalizedEmail,
            appId: app.id,
          },
        },
        select: {
          id: true,
        },
      });

      if (existingUser && existingUser.id !== user.id) {
        return res.status(409).json({
          success: false,
          message: "Email is already registered for this app.",
          code: "EMAIL_ALREADY_EXISTS",
        });
      }
    }

    // --------------------------------------------------------
    // 9. Build update object
    // --------------------------------------------------------
    const updateData = {};

    // --------------------------------------------------------
    // Basic profile
    // --------------------------------------------------------
    if (typeof name === "string" && name.trim()) {
      updateData.name = name.trim();
    }

    if (typeof username === "string") {
      updateData.username = username.trim() || null;
    }

    if (typeof phone === "string") {
      updateData.phone = phone.trim() || null;
    }

    if (typeof address === "string") {
      updateData.address = address.trim() || null;
    }

    if (typeof avatarUrl === "string") {
      updateData.avatarUrl = avatarUrl.trim() || null;
    }

    // --------------------------------------------------------
    // Account status
    // --------------------------------------------------------
    if (typeof isActive === "boolean") {
      updateData.isActive = isActive;
    }

    // --------------------------------------------------------
    // Role
    // --------------------------------------------------------
    // Any label the app wants ("editor", "billing-admin", ...). Every caller
    // here holds a secret API key, i.e. it is the
    // developer's own backend, which decides who may change roles (for
    // example, only CRM admins). Authix only checks the value's shape.
    const parsedRole = PRIVILEGED_CALLERS.has(req.auth?.type) ? parseRole(role) : {};

    if (parsedRole.error) {
      return res.status(400).json({
        success: false,
        message: parsedRole.error,
        code: "INVALID_ROLE",
      });
    }

    if (parsedRole.role) {
      updateData.role = parsedRole.role;
    }

    // --------------------------------------------------------
    // Password
    // --------------------------------------------------------
    if (typeof password === "string" && password.trim()) {
      if (password.trim().length < 8) {
        return res.status(400).json({
          success: false,
          message: "Password must be at least 8 characters long.",
          code: "PASSWORD_TOO_SHORT",
        });
      }

      updateData.password = await bcrypt.hash(password.trim(), 12);

      // Sign out every existing session.
      updateData.tokenVersion = { increment: 1 };
    }

    // --------------------------------------------------------
    // Email
    // --------------------------------------------------------
    if (emailChanged) {
      updateData.email = normalizedEmail;

      // Email change requires verification again.
      updateData.isVerified = false;
      updateData.otp = null;
      updateData.otpExpiry = null;

      // Sign out every existing session. The caller's own one is reissued
      // below, so a user finishing verification on this device stays signed in.
      updateData.tokenVersion = { increment: 1 };
    }

    // --------------------------------------------------------
    // Application data
    // --------------------------------------------------------

    if (settings !== undefined) {
      updateData.settings = settings;
    }

    if (packageInfo !== undefined) {
      updateData.packageInfo = packageInfo;
    }

    if (notifications !== undefined) {
      updateData.notifications = notifications;
    }

    if (extraInfo !== undefined) {
      updateData.extraInfo = extraInfo;
    }

    // --------------------------------------------------------
    // 10. Don't run empty update
    // --------------------------------------------------------
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields provided for update.",
        code: "NO_UPDATE_FIELDS",
      });
    }

    // --------------------------------------------------------
    // 11. Update user
    // --------------------------------------------------------
    const { tokenVersion, ...updatedUser } = await prisma.user.update({
      where: {
        id: user.id,
      },

      data: updateData,

      select: {
        // Identity
        id: true,
        username: true,
        name: true,
        email: true,

        // Profile
        phone: true,
        address: true,
        avatarUrl: true,

        // Account
        isActive: true,
        isVerified: true,
        role: true,
        tokenVersion: true,

        // Ownership
        appId: true,
        adminId: true,

        // Application data
        settings: true,
        packageInfo: true,
        notifications: true,
        extraInfo: true,

        // Metadata
        createdAt: true,
        updatedAt: true,
      },
    });

    if (emailChanged && !updateData.password && req.endUser?.id === user.id) {
      const token = signUserToken({
        id: updatedUser.id,
        email: updatedUser.email,
        role: updatedUser.role,
        appId: updatedUser.appId,
        isVerified: updatedUser.isVerified,
        tv: tokenVersion,
      });

      res.cookie(COOKIE.USER, token, {
        ...userCookieOptions(),
        maxAge: 24 * 60 * 60 * 1000, // 1 day
      });
    }

    // --------------------------------------------------------
    // 12. Response message
    // --------------------------------------------------------
    let message = "User updated successfully.";

    if (emailChanged) {
      message = "User updated successfully. Email verification has been reset.";
    }

    if (password && password.trim()) {
      message = emailChanged
        ? "User updated successfully. Email verification has been reset and existing sessions have been invalidated."
        : "User updated successfully. Existing sessions have been invalidated.";
    }

    // --------------------------------------------------------
    // 13. Return updated user
    // --------------------------------------------------------
    return res.status(200).json({
      success: true,
      message,
      user: updatedUser,
    });
  } catch (err) {
    console.error("UpdateUser Error:", err);

    // Prisma unique constraint
    if (err.code === "P2002") {
      if (err.meta?.target?.includes("email")) {
        return res.status(409).json({
          success: false,
          message: "Email is already registered for this app.",
          code: "EMAIL_ALREADY_EXISTS",
        });
      }

      return res.status(409).json({
        success: false,
        message: "A unique field already exists.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      ...(process.env.NODE_ENV === "development" && {
        error: err.message,
      }),
    });
  }
};

/**
 * @desc    Delete user (only if belongs to logged-in admin & app)
 * @route   DELETE /api/users/:id
 * @access  Private (Admin only)
 */
export const deleteUser = async (req, res) => {
  try {
    // Derived from the verified session by the trusted server integration, so an end user can
    // only ever delete their own account.
    const userId = resolveTargetUserId(req, req.params.userId);
    const appId = req.body?.appId;

    if (!appId) {
      return res.status(400).json({
        success: false,
        message: "App ID is required",
      });
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, adminId: req.admin.id, appId },
    });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found or not authorized to delete",
      });
    }

    // Deleting the user cascades to their data rows, so reclaim those bytes in
    // the same transaction rather than leaving the app total overstated.
    await prisma.$transaction(async (tx) => {
      const { _sum } = await tx.userDataItem.aggregate({
        where: { userId: user.id },
        _sum: { sizeBytes: true },
      });

      await tx.user.delete({ where: { id: user.id } });

      await adjustUserDataStorage(tx, user.appId, -(_sum.sizeBytes || 0));
    });

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (err) {
    console.error("DeleteUser Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/**
 * @desc    Check if a user exists (and belongs to the logged-in admin & app)
 * @route   GET /api/users/:id/check
 * @access  Private (Admin only)
 */
export const checkUser = async (req, res) => {
  try {
    const userId = req.params.id;
    const { appId } = req.query;

    // 1️⃣ Ensure admin context
    const adminId = req.admin?.id;
    if (!adminId) {
      return res.status(401).json({
        success: false,
        exists: false,
        message: "Unauthorized",
      });
    }

    // 2️⃣ Validate appId
    if (!appId) {
      return res.status(400).json({
        success: false,
        exists: false,
        message: "App ID is required",
      });
    }

    // 3️⃣ Verify app ownership
    const appExists = await prisma.app.findFirst({
      where: { id: appId, adminId },
      select: { id: true },
    });

    if (!appExists) {
      return res.status(404).json({
        success: false,
        exists: false,
        message: "App not found or access denied",
      });
    }

    // 4️⃣ Ultra-light existence check
    const exists = await prisma.user.count({
      where: {
        id: userId,
        adminId,
        appId,
      },
    });

    // 5️⃣ Return boolean ONLY
    return res.status(200).json({
      success: true,
      exists: Boolean(exists),
    });
  } catch (err) {
    console.error("CheckUser Error:", err);
    return res.status(500).json({
      success: false,
      exists: false,
      message: "Internal server error",
    });
  }
};

/**
 * @desc Send email verification OTP for user
 * @route POST /api/users/send-verify-otp
 * @access Public (requires email + appId)
 */
export const sendUserVerifyOTP = async (req, res) => {
  try {
    const { email, appId } = req.body;
    const userId = req.params.id;

    if (!email || !appId) {
      return res.status(400).json({
        success: false,
        message: "'email' and 'appId' are required in request body",
      });
    }

    // ✅ Check the app exists on this key's account
    const app = await prisma.app.findFirst({
      where: { id: appId, adminId: req.admin.id },
      select: { id: true, applicationName: true },
    });

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found",
      });
    }

    // ✅ Check if user exists and is active
    const user = await prisma.user.findFirst({
      where: { id: userId, email: email.toLowerCase(), appId, isActive: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found or inactive in this app",
      });
    }

    // ✅ Check if already verified
    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        message: "Email is already verified",
      });
    }

    // ✅ Generate OTP + hash + expiry
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpHash = await hashOTP(otp);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: freshOtpFields(otpHash, otpExpiry),
    });

    // ✅ Send OTP email
    const emailSent = await sendOtpEmail(
      user.email,
      otp,
      app.applicationName,
      "verification",
    );

    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to send OTP email. Try again later.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent to your registered email",
    });
  } catch (err) {
    console.error("SendUserVerifyOTP Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/**
 * @desc Verify user email with OTP
 * @route POST /api/users/verify-email
 * @access Public (OTP-based)
 */
export const verifyUserEmail = async (req, res) => {
  try {
    const { email, otp, appId } = req.body;
    if (!email || !otp || !appId) {
      return res.status(400).json({
        success: false,
        message: "Email, OTP and appId are required",
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        email: email.toLowerCase(),
        appId,
        adminId: req.admin.id,
        isActive: true,
      },
    });

    // Codes are shared with password reset; an already-verified user has
    // nothing to verify, so a reset code is never consumed here.
    if (!user || user.isVerified) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP. Request a new one.",
      });
    }

    if (!(await checkOtp(prisma.user, user, otp))) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP. Request a new one.",
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true, ...clearedOtpFields() },
    });

    return res.status(200).json({
      success: true,
      message: "Email verified successfully",
    });
  } catch (err) {
    console.error("VerifyUserEmail Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

/**
 * @desc Send reset password OTP for user
 * @route POST /api/users/forgot-password
 * @access Public
 */
export const userForgotPassword = async (req, res) => {
  try {
    const { email, appId } = req.body;
    if (!email || !appId) {
      return res.status(400).json({
        success: false,
        message: "Email and appId are required",
      });
    }

    // 1. Check the app exists on this key's account
    const app = await prisma.app.findFirst({
      where: { id: appId, adminId: req.admin.id },
      select: { id: true, applicationName: true },
    });

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found",
      });
    }

    // The same answer whether or not the email is registered, so this
    // cannot be used to find out who has an account.
    const sentResponse = {
      success: true,
      message: "If an account exists for that email, a reset code has been sent.",
    };

    // 2. Check if user exists and is active
    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase(), appId, isActive: true },
    });

    if (!user) {
      return res.status(200).json(sentResponse);
    }

    // 3. Generate OTP + hash + expiry
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpHash = await hashOTP(otp);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await prisma.user.update({
      where: { id: user.id },
      data: freshOtpFields(otpHash, otpExpiry),
    });

    // 4. Send OTP email using unified mailer
    const emailSent = await sendOtpEmail(
      user.email,
      otp,
      app.applicationName,
      "reset",
    );

    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to send OTP email. Try again later.",
      });
    }

    return res.status(200).json(sentResponse);
  } catch (err) {
    console.error("UserForgotPassword Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/**
 * @desc    Reset user password using OTP (after forgotPassword)
 * @route   POST /api/users/reset-password
 * @access  Public
 */
export const userResetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword, appId } = req.body;

    if (!email || !otp || !newPassword || !appId) {
      return res.status(400).json({
        success: false,
        message: "Email, OTP, new password, and appId are required",
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        email: email.toLowerCase(),
        appId,
        adminId: req.admin.id,
        isActive: true,
      },
    });

    // One answer for unknown users and wrong codes, so neither leaks.
    if (!user || !(await checkOtp(prisma.user, user, otp))) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP. Request a new one.",
      });
    }

    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters long.",
        code: "PASSWORD_TOO_SHORT",
      });
    }

    // ✅ Hash new password
    const hashedPassword = await hashPassword(newPassword);

    // ✅ Update password, clear OTP, and revoke every existing session.
    // A reset must invalidate whatever an attacker may already be holding.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        ...clearedOtpFields(),
        tokenVersion: { increment: 1 },
      },
    });

    return res.status(200).json({
      success: true,
      message: "Password has been reset successfully",
    });
  } catch (err) {
    console.error("UserResetPassword Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

/**
 * @desc Change password (requires current password)
 * @route POST /api/users/change-password
 * @access Private (User only)
 */
export const changeUserPassword = async (req, res) => {
  try {
    const adminId = req.admin?.id;
    // Derive this from the verified session in the trusted server integration.
    const userId = resolveTargetUserId(req, req.params?.id);
    const { currentPassword, newPassword, appId } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: User ID missing",
      });
    }

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Both current and new passwords are required",
      });
    }

    if (!isAcceptablePassword(newPassword)) {
      return res.status(400).json(PASSWORD_TOO_SHORT);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId, adminId: adminId, appId: appId },
    });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // ✅ Verify old password
    const isMatch = await comparePassword(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    // ✅ Hash new password
    const hashedPassword = await hashPassword(newPassword);

    // Bumping tokenVersion signs out every session for this user.
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
      },
    });

    // The caller's own cookie is now stale too — clear it so the client is
    // forced to sign in again with the new password.
    res.cookie(COOKIE.USER, "", {
      ...userCookieOptions(),
      expires: new Date(0),
    });

    return res.status(200).json({
      success: true,
      message: "Password updated successfully. Please sign in again.",
    });
  } catch (err) {
    console.error("ChangeUserPassword Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

/**
 * @desc    Get all users under a specific app (must belong to logged-in admin)
 * @route   POST /api/users/list
 * @access  Private (Admin only)
 */
export const getUsers = async (req, res) => {
  try {
    const { appId } = req.params;

    if (!appId) {
      return res.status(400).json({
        success: false,
        message: "App ID is required",
      });
    }

    const app = await prisma.app.findFirst({
      where: { id: appId, adminId: req.admin.id },
    });
    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or does not belong to you",
      });
    }

    const users = await prisma.user.findMany({
      where: { adminId: req.admin.id, appId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        address: true,
        avatarUrl: true,
        isActive: true,
        role: true,
        appId: true,
        createdAt: true,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Users fetched successfully",
      data: users,
    });
  } catch (err) {
    console.error("GetUsers Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

/**
 * @desc    Get user profile for an app
 * @route   POST /api/users/profile
 * @access  App-level
 */
export const getProfile = async (req, res) => {
  try {
    // --------------------------------------------------------
    // 1. Get appId and userId
    //
    // The userId in the body is only honoured for privileged callers. An end
    // callers must derive the id from their verified session, so
    // they cannot read someone else's profile by changing the body.
    // --------------------------------------------------------
    const { appId } = req.body;
    const userId = resolveTargetUserId(req, req.body?.userId);

    // --------------------------------------------------------
    // 2. Validate required fields
    // --------------------------------------------------------
    if (!appId) {
      return res.status(400).json({
        success: false,
        message: "appId is required.",
        code: "APP_ID_REQUIRED",
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required.",
        code: "USER_ID_REQUIRED",
      });
    }

    // --------------------------------------------------------
    // 3. Find active app
    // --------------------------------------------------------
    const app = await prisma.app.findFirst({
      where: {
        id: appId,
        adminId: req.admin.id,
      },
      select: {
        id: true,
        applicationName: true,
        isActive: true,
        adminId: true,
      },
    });

    // --------------------------------------------------------
    // 4. App not found
    // --------------------------------------------------------
    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found.",
        code: "APP_NOT_FOUND",
      });
    }

    // --------------------------------------------------------
    // 5. Check app status
    // --------------------------------------------------------
    if (!app.isActive) {
      return res.status(403).json({
        success: false,
        message: "This app is currently inactive.",
        code: "APP_INACTIVE",
      });
    }

    // --------------------------------------------------------
    // 6. Find user belonging to this app
    // --------------------------------------------------------
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        appId: appId,
        adminId: req.admin.id,
      },

      select: {
        // Identity
        id: true,
        username: true,
        name: true,
        email: true,

        // Contact / profile
        phone: true,
        address: true,
        avatarUrl: true,

        // Account status
        isActive: true,
        isVerified: true,
        role: true,

        // Ownership
        appId: true,
        adminId: true,

        // Profile extras. Records live in UserDataItem and are fetched via the
        // paginated /api/users/:id/data endpoint, not inlined here.
        settings: true,
        packageInfo: true,
        notifications: true,
        extraInfo: true,

        // Dates
        createdAt: true,
        updatedAt: true,
      },
    });

    // --------------------------------------------------------
    // 7. User not found
    // --------------------------------------------------------
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found for this app.",
        code: "USER_NOT_FOUND",
      });
    }

    // --------------------------------------------------------
    // 8. Check user status
    // --------------------------------------------------------
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account is currently inactive.",
        code: "USER_INACTIVE",
      });
    }

    // --------------------------------------------------------
    // 9. Return profile
    // --------------------------------------------------------
    return res.status(200).json({
      success: true,
      message: "Profile fetched successfully.",
      user,
      app: {
        id: app.id,
        applicationName: app.applicationName,
      },
    });
  } catch (err) {
    console.error("GetProfile Error:", err);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      ...(process.env.NODE_ENV === "development" && {
        error: err.message,
      }),
    });
  }
};
