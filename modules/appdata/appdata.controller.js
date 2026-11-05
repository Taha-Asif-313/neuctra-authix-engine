import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma.js";
import { beforeCursor, col, payloadContains } from "../../shared/utils/dbDialect.js";
import {
  calculateJsonSize,
  buildSearchText,
  adjustAppDataStorage,
} from "../../shared/utils/storageCalculator.js";

/* ============================================================
   Shared helpers

   App-wide data used to live in a single `App.appData` JSON array, so every
   read had to load the whole blob and filter it in Node. It is now one row per
   item, indexed the same way user data is.
   ============================================================ */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const resolveLimit = (raw) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

const serializeItem = (row) => ({
  id: row.id,
  dataCategory: row.dataCategory,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: row.version,
  ...(row.payload || {}),
});

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

/** Confirm the app belongs to the calling account. */
const findOwnedApp = (appId, adminId) =>
  prisma.app.findFirst({
    where: { id: appId, adminId },
    select: { id: true, adminId: true },
  });

/* ============================================================
   CREATE
   ============================================================ */

export const addAppDataItem = async (req, res) => {
  try {
    const { appId, dataCategory } = req.params;
    const payload = req.body;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.status(400).json({
        success: false,
        message: "Please send valid data in JSON format.",
      });
    }

    const app = await findOwnedApp(appId, req.admin.id);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or unauthorized",
      });
    }

    const sizeBytes = calculateJsonSize(payload);


    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.appDataItem.create({
        data: {
          appId,
          adminId: req.admin.id,
          dataCategory: String(dataCategory).toLowerCase(),
          payload,
          searchText: buildSearchText(payload),
          sizeBytes,
        },
      });

      await adjustAppDataStorage(tx, appId, sizeBytes);

      return row;
    });

    return res.status(201).json({
      success: true,
      message: "App data added successfully",
      data: serializeItem(created),
    });
  } catch (error) {
    console.error("❌ addAppDataItem Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while saving the app data.",
    });
  }
};

/* ============================================================
   READ
   ============================================================ */

export const getAppData = async (req, res) => {
  try {
    const { appId } = req.params;
    const limit = resolveLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const app = await findOwnedApp(appId, req.admin.id);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or unauthorized",
      });
    }

    const rows = await prisma.appDataItem.findMany({
      where: {
        appId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
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
  } catch (error) {
    console.error("❌ getAppData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while fetching app data.",
    });
  }
};

export const getAppDataByCategory = async (req, res) => {
  try {
    const { appId, category } = req.params;
    const limit = resolveLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const app = await findOwnedApp(appId, req.admin.id);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or unauthorized",
      });
    }

    const rows = await prisma.appDataItem.findMany({
      where: {
        appId,
        dataCategory: String(category).toLowerCase(),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
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
  } catch (error) {
    console.error("❌ getAppDataByCategory Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while fetching app data.",
    });
  }
};

export const getSingleAppDataItem = async (req, res) => {
  try {
    const { appId, itemId } = req.params;

    const row = await prisma.appDataItem.findFirst({
      where: { id: itemId, appId, adminId: req.admin.id },
    });

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "App data item not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: serializeItem(row),
    });
  } catch (error) {
    console.error("❌ getSingleAppDataItem Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while fetching the app data item.",
    });
  }
};

/* ============================================================
   SEARCH — executed in Postgres
   ============================================================ */

export const searchAppData = async (req, res) => {
  try {
    const { appId } = req.params;
    const { q, category, keys = {} } = req.body || {};
    const limit = resolveLimit(req.body?.limit);
    const cursor = decodeCursor(req.body?.cursor);

    const app = await findOwnedApp(appId, req.admin.id);

    if (!app) {
      return res.status(404).json({
        success: false,
        message: "App not found or unauthorized",
      });
    }

    const conditions = [Prisma.sql`${col("appId")} = ${appId}`];

    if (category) {
      conditions.push(
        Prisma.sql`${col("dataCategory")} = ${String(category).toLowerCase()}`,
      );
    }

    if (keys && Object.keys(keys).length > 0) {
      conditions.push(payloadContains(keys));
    }

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
      SELECT id, ${col("dataCategory")}, payload, version, ${col("createdAt")}, ${col("updatedAt")}
      FROM ${col("AppDataItem")}
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
    console.error("❌ searchAppData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while searching app data.",
    });
  }
};

/* ============================================================
   UPDATE / DELETE
   ============================================================ */

export const updateAppDataItem = async (req, res) => {
  try {
    const { appId, itemId } = req.params;
    const { version: expectedVersion, dataCategory, ...updates } = req.body || {};

    const existing = await prisma.appDataItem.findFirst({
      where: { id: itemId, appId, adminId: req.admin.id },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "App data item not found",
      });
    }

    if (
      expectedVersion !== undefined &&
      Number(expectedVersion) !== existing.version
    ) {
      return res.status(409).json({
        success: false,
        code: "VERSION_CONFLICT",
        message:
          "This record changed since you last read it. Re-read it and retry.",
        expectedVersion: Number(expectedVersion),
        currentVersion: existing.version,
      });
    }

    const nextPayload = { ...(existing.payload || {}), ...updates };
    const nextSize = calculateJsonSize(nextPayload);
    const delta = nextSize - existing.sizeBytes;

    if (delta > 0) {
    }

    const updated = await prisma.$transaction(async (tx) => {
      const { count } = await tx.appDataItem.updateMany({
        where: { id: itemId, version: existing.version },
        data: {
          payload: nextPayload,
          searchText: buildSearchText(nextPayload),
          sizeBytes: nextSize,
          version: { increment: 1 },
          ...(dataCategory
            ? { dataCategory: String(dataCategory).toLowerCase() }
            : {}),
        },
      });

      if (count === 0) {
        throw Object.assign(new Error("VERSION_CONFLICT"), {
          isVersionConflict: true,
        });
      }

      await adjustAppDataStorage(tx, appId, delta);

      return tx.appDataItem.findUnique({ where: { id: itemId } });
    });

    return res.status(200).json({
      success: true,
      message: "App data updated successfully",
      data: serializeItem(updated),
    });
  } catch (error) {
    if (error.isVersionConflict) {
      return res.status(409).json({
        success: false,
        code: "VERSION_CONFLICT",
        message: "This record was modified concurrently. Re-read it and retry.",
      });
    }

    console.error("❌ updateAppDataItem Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while updating app data.",
    });
  }
};

export const deleteAppDataItem = async (req, res) => {
  try {
    const { appId, itemId } = req.params;

    const existing = await prisma.appDataItem.findFirst({
      where: { id: itemId, appId, adminId: req.admin.id },
      select: { id: true, sizeBytes: true },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "App data item not found",
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.appDataItem.delete({ where: { id: existing.id } });
      await adjustAppDataStorage(tx, appId, -existing.sizeBytes);
    });

    return res.status(200).json({
      success: true,
      message: "App data deleted successfully",
    });
  } catch (error) {
    console.error("❌ deleteAppDataItem Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while deleting app data.",
    });
  }
};
