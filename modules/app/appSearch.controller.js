import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma.js";
import { beforeCursor, col, insensitive, payloadContains } from "../../shared/utils/dbDialect.js";

/**
 * Fields a caller may filter or search on.
 *
 * This is an allowlist, not a denylist. Previously the `keys` object was spread
 * straight into the Prisma `where` clause, which let a caller filter on
 * `password`, `token`, or `otp` and recover those values one character at a
 * time via `contains`. Only columns named here are ever reachable.
 */
const SEARCHABLE_USER_FIELDS = new Set([
  "id",
  "username",
  "name",
  "email",
  "phone",
  "address",
  "role",
  "isVerified",
  "isActive",
]);

/** Columns that must never appear in a filter, response, or error message. */
const NEVER_SEARCHABLE = new Set(["password", "token", "otp", "otpExpiry"]);

/** Safe projection for user rows. Never widen this to `include`/`select: true`. */
const PUBLIC_USER_FIELDS = {
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
};

/* ============================================================
   Pagination

   Every endpoint here is bounded. Previously, omitting `limit` meant "return
   everything", which at the advertised max tier meant loading 50k users and
   their entire JSON payloads into Node on a single request.
   ============================================================ */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const resolveLimit = (raw) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

const encodeCursor = (row) =>
  Buffer.from(`${new Date(row.createdAt).toISOString()}|${row.id}`).toString(
    "base64url",
  );

const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString().split("|");
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
};

/** Keyset predicate shared by the Prisma-based endpoints. */
const keysetWhere = (cursor) =>
  cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};

const serializeItem = (row) => ({
  id: row.id,
  userId: row.userId,
  dataCategory: row.dataCategory,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: row.version,
  ...(row.payload || {}),
});

const findOwnedApp = (appId, adminId) =>
  prisma.app.findFirst({
    where: { id: appId, adminId, isActive: true },
    select: { id: true },
  });

/**
 * =========================================================
 * SEARCH ACROSS ALL USERS' DATA IN AN APP
 *
 * Runs entirely in Postgres against the GIN indexes on
 * UserDataItem.payload (jsonb_path_ops) and .searchText (trgm).
 * =========================================================
 */
export const searchInAllAppUsersData = async (req, res) => {
  try {
    const { appId } = req.params;
    const { category, q, keys = {} } = req.body || {};
    const limit = resolveLimit(req.body?.limit);
    const cursor = decodeCursor(req.body?.cursor);

    const app = await findOwnedApp(appId, req.admin.id);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or unauthorized",
      });
    }

    const conditions = [
      Prisma.sql`${col("appId")} = ${appId}`,
      Prisma.sql`${col("adminId")} = ${req.admin.id}`,
    ];

    if (category) {
      conditions.push(
        Prisma.sql`${col("dataCategory")} = ${String(category).toLowerCase()}`,
      );
    }

    // Containment query — served by the jsonb_path_ops GIN index.
    if (keys && Object.keys(keys).length > 0) {
      conditions.push(payloadContains(keys));
    }

    // Substring query — served by the pg_trgm GIN index on searchText.
    if (q) {
      conditions.push(
        Prisma.sql`${col("searchText")} LIKE ${"%" + String(q).toLowerCase() + "%"}`,
      );
    }

    if (cursor) {
      conditions.push(
        beforeCursor(cursor),
      );
    }

    const rows = await prisma.$queryRaw`
      SELECT id, ${col("userId")}, ${col("dataCategory")}, payload, version,
             ${col("createdAt")}, ${col("updatedAt")}
      FROM ${col("UserDataItem")}
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY ${col("createdAt")} DESC, id DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return res.status(200).json({
      success: true,
      totalItems: page.length,
      hasMore,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      data: page.map(serializeItem),
    });
  } catch (error) {
    console.error("searchInAllAppUsersData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

/**
 * =========================================================
 * LIST ALL USERS' DATA IN AN APP
 * =========================================================
 */
export const getAllUsersDataFromApp = async (req, res) => {
  try {
    const { appId } = req.params;
    const { category } = req.body || {};
    const limit = resolveLimit(req.body?.limit);
    const cursor = decodeCursor(req.body?.cursor);

    const app = await findOwnedApp(appId, req.admin.id);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or unauthorized",
      });
    }

    const rows = await prisma.userDataItem.findMany({
      where: {
        appId,
        adminId: req.admin.id,
        ...(category ? { dataCategory: String(category).toLowerCase() } : {}),
        ...keysetWhere(cursor),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return res.status(200).json({
      success: true,
      totalFetched: page.length,
      hasMore,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      data: page.map(serializeItem),
    });
  } catch (err) {
    console.error("GetAppUsersData Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

/**
 * =========================================================
 * SEARCH USERS (database-level filtering)
 * =========================================================
 */
export const searchInAllAppUsers = async (req, res) => {
  try {
    const { appId } = req.params;
    const { q, keys = {} } = req.body || {};
    const limit = resolveLimit(req.body?.limit);
    const cursor = decodeCursor(req.body?.cursor);

    if (!appId) {
      return res.status(400).json({
        success: false,
        message: "appId is required",
      });
    }

    /**
     * Validate the requested filter fields BEFORE touching the database.
     * Malformed input should not cost a query, and rejecting here keeps the
     * allowlist enforcement independent of ownership-check ordering.
     */
    const rejectedKeys = Object.keys(keys || {}).filter(
      (key) => !SEARCHABLE_USER_FIELDS.has(key),
    );

    if (rejectedKeys.length > 0) {
      const sensitive = rejectedKeys.filter((key) => NEVER_SEARCHABLE.has(key));

      return res.status(400).json({
        success: false,
        message: sensitive.length
          ? `These fields can never be searched: ${sensitive.join(", ")}.`
          : `Unknown search field(s): ${rejectedKeys.join(", ")}.`,
        allowedFields: [...SEARCHABLE_USER_FIELDS],
        code: "INVALID_SEARCH_FIELD",
      });
    }

    const app = await findOwnedApp(appId, req.admin.id);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or unauthorized",
      });
    }

    const where = { appId };

    /**
     * Both the keyset cursor and the free-text query are OR groups, so they are
     * collected into an AND list rather than assigned to `where.OR`.
     *
     * Assigning both to `where.OR` made the second overwrite the first: with a
     * query present the cursor predicate vanished, every request returned page
     * one, and paging looped forever.
     */
    const and = [];

    if (cursor) {
      and.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    }

    if (q) {
      and.push({
        OR: [
          { username: insensitive(q) },
          { name: insensitive(q) },
          { email: insensitive(q) },
          { phone: insensitive(q) },
          { address: insensitive(q) },
        ],
      });
    }

    // Every key here already passed the allowlist above.
    Object.entries(keys).forEach(([key, value]) => {
      if (value === undefined || value === null) return;

      if (typeof value === "boolean" || typeof value === "number") {
        where[key] = value;
        return;
      }

      if (key === "id") {
        where[key] = value;
        return;
      }

      where[key] = insensitive(String(value));
    });

    if (and.length > 0) where.AND = and;

    const users = await prisma.user.findMany({
      where,
      select: PUBLIC_USER_FIELDS,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;

    return res.status(200).json({
      success: true,
      totalItems: page.length,
      hasMore,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      data: page,
    });
  } catch (error) {
    console.error("SearchUsersFromApp Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

/**
 * =========================================================
 * LIST ALL USERS IN AN APP
 * =========================================================
 */
export const getAllUsersFromApp = async (req, res) => {
  try {
    const { appId } = req.params;
    const limit = resolveLimit(req.body?.limit);
    const cursor = decodeCursor(req.body?.cursor);

    if (!appId) {
      return res.status(400).json({
        success: false,
        message: "appId is required",
      });
    }

    const app = await findOwnedApp(appId, req.admin.id);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or unauthorized",
      });
    }

    // Query users directly rather than nesting under the app, so the page size
    // is applied by the database instead of after loading the relation.
    const users = await prisma.user.findMany({
      where: { appId, ...keysetWhere(cursor) },
      select: PUBLIC_USER_FIELDS,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;

    return res.status(200).json({
      success: true,
      totalFetched: page.length,
      hasMore,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      data: page,
    });
  } catch (err) {
    console.error("GetAllAppUsers Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};
