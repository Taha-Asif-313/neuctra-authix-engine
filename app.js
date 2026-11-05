import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";

import { assertJwtConfig } from "./shared/utils/jwt.js";
import { globalRateLimit } from "./shared/middleware/rateLimit.js";
import prisma from "./shared/prisma.js";

import userRoutes from "./modules/user/user.routes.js";
import userDataRoutes from "./modules/userdata/userdata.routes.js";
import appDataRoutes from "./modules/appdata/appdata.routes.js";
import globalAppSearchRoutes from "./modules/app/appSearch.routes.js";

// Fail at boot, not at the first login attempt. There is no fallback secret.
assertJwtConfig();

const app = express();

// Only trust X-Forwarded-For when a proxy really sets it. Otherwise any client
// could forge its IP, and with it the rate limits and allowed IP lists.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || false);

app.use(helmet());
app.use(globalRateLimit);
app.use(cookieParser());
app.use(express.json());

// Every SDK route checks the app's own allowed origins (see appAccess.js), so
// CORS itself admits any origin and cookies are allowed.
const sdkCors = cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
});

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "database unavailable" });
  }
});

// The same paths as the hosted service, so the SDKs need only a new baseUrl.
// Mounted before /api/app on purpose: appDataRoutes guards itself with
// router.use(), which would also run for /api/app/global/* if it came first.
app.use("/api/app/global", sdkCors, globalAppSearchRoutes);
app.use("/api/app", sdkCors, appDataRoutes);
app.use("/api/users", sdkCors, userRoutes);
app.use("/api/users", sdkCors, userDataRoutes);

export default app;
