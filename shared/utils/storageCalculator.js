/**
 * Storage accounting.
 *
 * Totals are maintained INCREMENTALLY. When a record is written we adjust the
 * app's counter by the byte delta, inside the same transaction as the write, so
 * the cost of a write does not depend on how much data the app already holds.
 *
 * The previous implementation recomputed a total by loading every user's entire
 * data blob and summing in JavaScript — on every write, from six call sites. At
 * the `max` tier (50k users) that read gigabytes into memory to append one row.
 *
 * The full recomputation still exists (`repairAppStorageTotals`) but is a repair
 * tool: a SQL aggregate, run deliberately, never on the request path.
 */

import prisma from "../prisma.js";

/**
 * Byte size of a JSON-serialisable value.
 * Used to stamp `sizeBytes` on each row at write time.
 */
export const calculateJsonSize = (data) => {
  if (!data) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(data), "utf8");
  } catch (error) {
    console.error("Error calculating JSON size:", error);
    return 0;
  }
};

/**
 * Flatten a payload into searchable text.
 *
 * Stored in `searchText` and indexed with pg_trgm so a substring query runs in
 * Postgres instead of `JSON.stringify(item).includes(q)` across every row.
 */
export const buildSearchText = (payload) => {
  const parts = [];

  const walk = (value) => {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        parts.push(key);
        walk(child);
      }
      return;
    }

    parts.push(String(value));
  };

  walk(payload);

  // Cap the indexed text. Trigram indexes degrade on very large values, and a
  // multi-megabyte record is not something substring search should serve.
  return parts.join(" ").toLowerCase().slice(0, 8000);
};

/* ============================================================
   Incremental adjustment — the write path
   ============================================================ */

/**
 * Apply a byte delta to an app's user-data total.
 *
 * @param {object} tx     Prisma client OR transaction client. Pass the tx so the
 *                        counter and the row commit together.
 * @param {string} appId
 * @param {number} delta  May be negative (updates that shrink, deletes).
 */
export const adjustUserDataStorage = (tx, appId, delta) => {
  if (!delta) return Promise.resolve(null);

  return tx.app.update({
    where: { id: appId },
    data: { userDataStorageUsed: { increment: delta } },
    select: { userDataStorageUsed: true },
  });
};

/** Same, for app-wide data. */
export const adjustAppDataStorage = (tx, appId, delta) => {
  if (!delta) return Promise.resolve(null);

  return tx.app.update({
    where: { id: appId },
    data: { appDataStorageUsed: { increment: delta } },
    select: { appDataStorageUsed: true },
  });
};

/* ============================================================
   Reads
   ============================================================ */

/** Current stored size of one user's records. Indexed aggregate, not a scan. */
export const calculateUserDataSize = async (userId) => {
  const { _sum } = await prisma.userDataItem.aggregate({
    where: { userId },
    _sum: { sizeBytes: true },
  });

  return _sum.sizeBytes || 0;
};

/** Current stored size of an app's shared data. */
export const calculateAppDataSize = async (appId) => {
  const { _sum } = await prisma.appDataItem.aggregate({
    where: { appId },
    _sum: { sizeBytes: true },
  });

  return _sum.sizeBytes || 0;
};

/* ============================================================
   Repair — deliberate, never on the request path
   ============================================================ */

/**
 * Recompute an app's counters from the rows and correct any drift.
 *
 * This is a SQL aggregate over indexed integers, not a JSON scan, so it is cheap
 * relative to the old version — but it is still O(rows) and belongs in an admin
 * action or a cron job, not in a request handler.
 */
export const repairAppStorageTotals = async (appId) => {
  const [userData, appData] = await Promise.all([
    prisma.userDataItem.aggregate({
      where: { appId },
      _sum: { sizeBytes: true },
    }),
    prisma.appDataItem.aggregate({
      where: { appId },
      _sum: { sizeBytes: true },
    }),
  ]);

  const userDataStorage = userData._sum.sizeBytes || 0;
  const appDataStorage = appData._sum.sizeBytes || 0;

  await prisma.app.update({
    where: { id: appId },
    data: {
      userDataStorageUsed: userDataStorage,
      appDataStorageUsed: appDataStorage,
    },
  });

  return {
    userDataStorage,
    appDataStorage,
    totalStorage: userDataStorage + appDataStorage,
  };
};
