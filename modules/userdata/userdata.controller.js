import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma.js";
import { beforeCursor, col, payloadContains } from "../../shared/utils/dbDialect.js";
import { resolveTargetUserId } from "../user/user.controller.js";
import {
  calculateJsonSize,
  buildSearchText,
  adjustUserDataStorage,
} from "../../shared/utils/storageCalculator.js";

/* ============================================================
   Shared helpers
   ============================================================ */

/** Page sizes are always bounded. Omitting `limit` no longer means "everything". */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const resolveLimit = (raw) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
};

/**
 * Present a row in the flat shape callers already expect:
 * identity fields alongside the payload, as it was when data was a JSON array.
 */
const serializeItem = (row) => ({
  id: row.id,
  dataCategory: row.dataCategory,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: row.version,
  ...(row.parentId ? { parentId: row.parentId } : {}),
  ...(row.payload || {}),
});

/** Cursor is the opaque encoding of the keyset we paginate on. */
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

/** Look up the target user, scoped to the calling account. */
const findOwnedUser = (userId, adminId) =>
  prisma.user.findFirst({
    where: { id: userId, adminId },
    select: { id: true, appId: true, isVerified: true },
  });

/* ============================================================
   CREATE
   ============================================================ */

export const addUserData = async (req, res) => {
  try {
    const id = resolveTargetUserId(req, req.params.id);
    const { dataCategory, parentId, ...payload } = req.body;

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.status(400).json({
        success: false,
        message: "Please send valid data in JSON format.",
      });
    }

    if (!dataCategory || typeof dataCategory !== "string") {
      return res.status(400).json({
        success: false,
        message: "dataCategory is required and must be a string.",
      });
    }

    const user = await findOwnedUser(id, req.admin.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "We couldn’t find this user under your account.",
      });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        message: "Please verify the account from profile",
      });
    }

    const sizeBytes = calculateJsonSize(payload);


    // The row and the app's storage counter must move together, or the total
    // silently drifts away from reality.
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.userDataItem.create({
        data: {
          userId: user.id,
          appId: user.appId,
          adminId: req.admin.id,
          dataCategory: dataCategory.toLowerCase(),
          payload,
          searchText: buildSearchText(payload),
          sizeBytes,
          parentId: parentId || null,
        },
      });

      await adjustUserDataStorage(tx, user.appId, sizeBytes);

      return row;
    });

    return res.status(201).json({
      success: true,
      message: "Your data was added successfully!",
      data: serializeItem(created),
    });
  } catch (error) {
    console.error("❌ addUserData Error:", error);

    if (error.code === "P2025") {
      return res.status(404).json({
        success: false,
        message: "The user you are trying to update does not exist.",
      });
    }

    if (error.code === "P2003") {
      return res.status(400).json({
        success: false,
        message: "parentId does not reference an existing record.",
      });
    }

    return res.status(500).json({
      success: false,
      message:
        "Something went wrong while saving the data. Please try again later.",
    });
  }
};

/* ============================================================
   READ — list
   ============================================================ */

export const getUserData = async (req, res) => {
  try {
    const id = resolveTargetUserId(req, req.params.id);
    const { category, parentId } = req.query;
    const limit = resolveLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const user = await findOwnedUser(id, req.admin.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found or unauthorized",
      });
    }

    const where = {
      userId: user.id,
      ...(category ? { dataCategory: String(category).toLowerCase() } : {}),
      ...(parentId ? { parentId: String(parentId) } : {}),
      // Keyset pagination: strictly "older than the cursor", ordered by the
      // same (createdAt, id) pair the index is built on.
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    const rows = await prisma.userDataItem.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1, // one extra row tells us whether more exist
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
    console.error("❌ getUserData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while fetching the data.",
    });
  }
};

/* ============================================================
   READ — single
   ============================================================ */

export const getSingleUserData = async (req, res) => {
  try {
    const { dataId } = req.params;
    const id = resolveTargetUserId(req, req.params.id);

    const row = await prisma.userDataItem.findFirst({
      where: { id: dataId, userId: id, adminId: req.admin.id },
    });

    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Data item not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: serializeItem(row),
    });
  } catch (error) {
    console.error("❌ getSingleUserData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while fetching the data.",
    });
  }
};

/* ============================================================
   SEARCH — executed in Postgres, not in Node
   ============================================================ */

export const searchUserData = async (req, res) => {
  try {
    const userId = resolveTargetUserId(req, req.params.userId);
    const { q, category, keys = {} } = req.body || {};
    const limit = resolveLimit(req.body?.limit);
    const cursor = decodeCursor(req.body?.cursor);

    const user = await findOwnedUser(userId, req.admin.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found or unauthorized",
      });
    }

    const conditions = [Prisma.sql`${col("userId")} = ${user.id}`];

    if (category) {
      conditions.push(
        Prisma.sql`${col("dataCategory")} = ${String(category).toLowerCase()}`,
      );
    }

    // Containment against the jsonb_path_ops GIN index.
    if (keys && Object.keys(keys).length > 0) {
      conditions.push(
        payloadContains(keys),
      );
    }

    // Substring match against the pg_trgm GIN index on searchText.
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
      SELECT id, ${col("dataCategory")}, payload, ${col("parentId")}, version,
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
    console.error("❌ searchUserData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while searching the data.",
    });
  }
};

/* ============================================================
   UPDATE
   ============================================================ */

export const updateUserData = async (req, res) => {
  try {
    const { dataId } = req.params;
    const id = resolveTargetUserId(req, req.params.id);
    const { version: expectedVersion, dataCategory, ...updates } = req.body || {};

    const existing = await prisma.userDataItem.findFirst({
      where: { id: dataId, userId: id, adminId: req.admin.id },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Data item not found",
      });
    }

    // Optimistic concurrency. Callers that pass a version get a conflict instead
    // of silently clobbering a change made since they last read.
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
      // Guarding on version inside the write closes the race between the check
      // above and the update itself.
      const { count } = await tx.userDataItem.updateMany({
        where: { id: dataId, version: existing.version },
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

      await adjustUserDataStorage(tx, existing.appId, delta);

      return tx.userDataItem.findUnique({ where: { id: dataId } });
    });

    return res.status(200).json({
      success: true,
      message: "Data updated successfully",
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

    console.error("❌ updateUserData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while updating the data.",
    });
  }
};

/* ============================================================
   DELETE
   ============================================================ */

export const deleteUserData = async (req, res) => {
  try {
    const { dataId } = req.params;
    const id = resolveTargetUserId(req, req.params.id);

    const existing = await prisma.userDataItem.findFirst({
      where: { id: dataId, userId: id, adminId: req.admin.id },
      select: { id: true, appId: true, sizeBytes: true },
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Data item not found",
      });
    }

    await prisma.$transaction(async (tx) => {
      // Children cascade at the database level (onDelete: Cascade), so reclaim
      // their bytes too rather than leaving the counter overstated.
      const { _sum } = await tx.userDataItem.aggregate({
        where: { parentId: existing.id },
        _sum: { sizeBytes: true },
      });

      await tx.userDataItem.delete({ where: { id: existing.id } });

      await adjustUserDataStorage(
        tx,
        existing.appId,
        -(existing.sizeBytes + (_sum.sizeBytes || 0)),
      );
    });

    return res.status(200).json({
      success: true,
      message: "Data deleted successfully",
    });
  } catch (error) {
    console.error("❌ deleteUserData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while deleting the data.",
    });
  }
};

export const deleteMultipleUserData = async (req, res) => {
  try {
    const id = resolveTargetUserId(req, req.params.id);
    const { dataIds } = req.body;

    if (!Array.isArray(dataIds) || dataIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "dataIds must be a non-empty array",
      });
    }

    if (dataIds.length > MAX_LIMIT) {
      return res.status(400).json({
        success: false,
        message: `Delete at most ${MAX_LIMIT} items per request.`,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.userDataItem.findMany({
        where: { id: { in: dataIds }, userId: id, adminId: req.admin.id },
        select: { id: true, appId: true, sizeBytes: true },
      });

      if (rows.length === 0) return { deleted: 0 };

      const ids = rows.map((r) => r.id);
      const appId = rows[0].appId;

      const { _sum } = await tx.userDataItem.aggregate({
        where: { parentId: { in: ids } },
        _sum: { sizeBytes: true },
      });

      const freed =
        rows.reduce((sum, r) => sum + r.sizeBytes, 0) + (_sum.sizeBytes || 0);

      await tx.userDataItem.deleteMany({ where: { id: { in: ids } } });
      await adjustUserDataStorage(tx, appId, -freed);

      return { deleted: rows.length, freed };
    });

    return res.status(200).json({
      success: true,
      message: `Deleted ${result.deleted} item(s)`,
      ...result,
    });
  } catch (error) {
    console.error("❌ deleteMultipleUserData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while deleting the data.",
    });
  }
};

/* ============================================================
   BATCH — several operations, all-or-nothing
   ============================================================ */

const MAX_BATCH_OPS = 50;

/**
 * Apply a list of create/update/delete operations atomically.
 *
 * This is the answer to "update two records together" — the point where a
 * schemaless store usually forces developers to move off it.
 */
export const batchUserData = async (req, res) => {
  try {
    const id = resolveTargetUserId(req, req.params.id);
    const { operations } = req.body || {};

    if (!Array.isArray(operations) || operations.length === 0) {
      return res.status(400).json({
        success: false,
        message: "operations must be a non-empty array",
      });
    }

    if (operations.length > MAX_BATCH_OPS) {
      return res.status(400).json({
        success: false,
        message: `A batch may contain at most ${MAX_BATCH_OPS} operations.`,
      });
    }

    const user = await findOwnedUser(id, req.admin.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found or unauthorized",
      });
    }

    // Same gate as addUserData. Without it, batch was a way to write records
    // for an unverified account that the single-item endpoint rejects.
    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        message: "Please verify the account from profile",
      });
    }

    // Size the whole batch before committing anything, so a batch cannot be
    // used to slip past the per-user ceiling one operation at a time.
    const addedBytes = operations
      .filter((op) => op.type === "create")
      .reduce((sum, op) => {
        const { dataCategory, parentId, type, ...payload } = op;
        return sum + calculateJsonSize(payload);
      }, 0);

    if (addedBytes > 0) {
    }

    const results = await prisma.$transaction(async (tx) => {
      const out = [];
      let delta = 0;

      for (const [index, op] of operations.entries()) {
        if (op.type === "create") {
          const { type, dataCategory, parentId, ...payload } = op;

          if (!dataCategory) {
            throw Object.assign(
              new Error(`operations[${index}]: dataCategory is required`),
              { isBadRequest: true },
            );
          }

          const sizeBytes = calculateJsonSize(payload);

          const row = await tx.userDataItem.create({
            data: {
              userId: user.id,
              appId: user.appId,
              adminId: req.admin.id,
              dataCategory: String(dataCategory).toLowerCase(),
              payload,
              searchText: buildSearchText(payload),
              sizeBytes,
              parentId: parentId || null,
            },
          });

          delta += sizeBytes;
          out.push({ type: "create", id: row.id, data: serializeItem(row) });
          continue;
        }

        if (op.type === "update") {
          const { type, id: itemId, version, dataCategory, ...updates } = op;

          const existing = await tx.userDataItem.findFirst({
            where: { id: itemId, userId: user.id },
          });

          if (!existing) {
            throw Object.assign(
              new Error(`operations[${index}]: item ${itemId} not found`),
              { isNotFound: true },
            );
          }

          if (version !== undefined && Number(version) !== existing.version) {
            throw Object.assign(
              new Error(`operations[${index}]: version conflict`),
              { isVersionConflict: true, currentVersion: existing.version },
            );
          }

          const nextPayload = { ...(existing.payload || {}), ...updates };
          const nextSize = calculateJsonSize(nextPayload);

          const row = await tx.userDataItem.update({
            where: { id: itemId },
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

          delta += nextSize - existing.sizeBytes;
          out.push({ type: "update", id: row.id, data: serializeItem(row) });
          continue;
        }

        if (op.type === "delete") {
          const existing = await tx.userDataItem.findFirst({
            where: { id: op.id, userId: user.id },
            select: { id: true, sizeBytes: true },
          });

          if (!existing) {
            throw Object.assign(
              new Error(`operations[${index}]: item ${op.id} not found`),
              { isNotFound: true },
            );
          }

          await tx.userDataItem.delete({ where: { id: existing.id } });

          delta -= existing.sizeBytes;
          out.push({ type: "delete", id: existing.id });
          continue;
        }

        throw Object.assign(
          new Error(
            `operations[${index}]: unknown type "${op.type}" (expected create, update, or delete)`,
          ),
          { isBadRequest: true },
        );
      }

      await adjustUserDataStorage(tx, user.appId, delta);

      return out;
    });

    return res.status(200).json({
      success: true,
      message: `Applied ${results.length} operation(s)`,
      results,
    });
  } catch (error) {
    if (error.isBadRequest) {
      return res.status(400).json({ success: false, message: error.message });
    }

    if (error.isNotFound) {
      return res.status(404).json({
        success: false,
        message: `${error.message}. No changes were applied.`,
      });
    }

    if (error.isVersionConflict) {
      return res.status(409).json({
        success: false,
        code: "VERSION_CONFLICT",
        message: `${error.message}. No changes were applied.`,
        currentVersion: error.currentVersion,
      });
    }

    console.error("❌ batchUserData Error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong while applying the batch.",
    });
  }
};
