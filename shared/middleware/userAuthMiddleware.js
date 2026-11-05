import { authenticateApiKey, sendAuthFailure } from "./authMiddleware.js";

/* ============================================================
   User-facing authentication (SDK / app-integration surface)

   Used on modules/user, modules/userdata, and modules/appdata — the routes a
   third-party app's SDK calls on behalf of an admin's app. Accepts ONLY an
   `x-api-key` header, secret or publishable, and sets req.auth, req.admin and
   req.endUser for requireScope.js and the controllers.
   ============================================================ */

const unauthorized = (res, message) =>
  res.status(401).json({ success: false, message });

export const userAuthMiddleware = async (req, res, next) => {
  try {
    const rawKey = req.headers["x-api-key"];

    if (!rawKey) {
      return unauthorized(res, "Unauthorized: an x-api-key header is required.");
    }

    const failure = await authenticateApiKey(req, rawKey);
    if (failure) return sendAuthFailure(res, failure);

    return next();
  } catch (err) {
    console.error("UserAuthMiddleware Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error during authentication.",
    });
  }
};
