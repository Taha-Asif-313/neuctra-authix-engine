/**
 * Moving an app between Neuctra Authix installs: the hosted cloud and any
 * self-hosted engine, in either direction.
 *
 * The hosted service and the engine each hold a copy of this file. Keep them
 * identical, because a bundle written by one must always load in the other.
 *
 * A bundle is newline-delimited JSON, one object per line:
 *
 *   {"kind":"header","format":"neuctra-authix-bundle","version":1,...}
 *   {"kind":"app",...}
 *   {"kind":"user",...}  {"kind":"user-data",...}  {"kind":"app-data",...}
 *   {"kind":"end","counts":{...}}
 *
 * The end line is what proves a file was not cut off in transit.
 *
 * Everything in a bundle is untrusted input. It may have been edited by hand,
 * and on the cloud it comes from a customer. So nothing here takes a row's word
 * for anything the server can work out itself: sizes and search text are
 * recomputed, ownership comes from the caller, and an id that already belongs
 * to another app stops the import instead of touching that row.
 */

import {
  adjustAppDataStorage,
  adjustUserDataStorage,
  buildSearchText,
  calculateJsonSize,
} from "./storageCalculator.js";

export const BUNDLE_FORMAT = "neuctra-authix-bundle";
export const BUNDLE_VERSION = 1;

/** Rows per write. Each write is one transaction. */
export const MAX_BATCH_ROWS = 200;

/** Export pages stop here, well inside a serverless response limit. */
const MAX_PAGE_BYTES = 3 * 1024 * 1024;

export const KINDS = Object.freeze({
  USERS: "user",
  USER_DATA: "user-data",
  APP_DATA: "app-data",
  /** Parent links, written once every record exists. See writeLinks. */
  LINKS: "user-data-link",
});

export class TransferError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message) => new TransferError(400, "INVALID_BUNDLE", message);

/* ============================================================
   Validation
   ============================================================ */

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT = 1000;
const MAX_LONG_TEXT = 5000;

const asId = (value, label) => {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw invalid(`${label} is not a valid id.`);
  }
  return value;
};

const asText = (value, label, max = MAX_TEXT) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw invalid(`${label} is missing or too long.`);
  }
  return value;
};

const asOptionalText = (value, label, max = MAX_TEXT) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) {
    throw invalid(`${label} is too long.`);
  }
  return value;
};

const asDate = (value, label) => {
  const date = new Date(value);
  if (typeof value !== "string" || Number.isNaN(date.getTime())) {
    throw invalid(`${label} is not a valid date.`);
  }
  return date;
};

const asObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object.`);
  }
  return value;
};

const asStringList = (value) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.length <= 300).slice(0, 100)
    : [];

const optionalJson = (row, field) =>
  row[field] === undefined || row[field] === null ? {} : { [field]: row[field] };

export function assertHeader(header) {
  if (header?.kind !== "header" || header.format !== BUNDLE_FORMAT) {
    throw invalid("This is not a Neuctra Authix bundle.");
  }
  if (header.version !== BUNDLE_VERSION) {
    throw invalid(`Bundle version ${header.version} is not supported here.`);
  }
}

/** The parts of an app row both installs can use. */
export function parseAppRow(row) {
  return {
    id: asId(row?.id, "App id"),
    applicationName: asText(row.applicationName, "App name"),
    category: asOptionalText(row.category, "App category") || "other",
    description: asOptionalText(row.description, "App description", MAX_LONG_TEXT) || "",
    platform: asOptionalText(row.platform, "App platform") || "web",
    allowedOrigins: asStringList(row.allowedOrigins),
    allowedIps: asStringList(row.allowedIps),
    createdAt: asDate(row.createdAt, "App createdAt"),
  };
}

const parseUserRow = (row) => {
  const email = asText(row?.email, "User email", 320).trim().toLowerCase();

  if (typeof row.password !== "string" || !BCRYPT_HASH.test(row.password)) {
    throw invalid(`User ${email} has no valid password hash.`);
  }

  return {
    id: asId(row.id, "User id"),
    email,
    name: asText(row.name, "User name"),
    password: row.password,
    username: asOptionalText(row.username, "Username"),
    phone: asOptionalText(row.phone, "User phone"),
    address: asOptionalText(row.address, "User address"),
    avatarUrl: asOptionalText(row.avatarUrl, "User avatarUrl", MAX_LONG_TEXT),
    isVerified: row.isVerified === true,
    isActive: row.isActive !== false,
    role: asOptionalText(row.role, "User role", 50) || "user",
    createdAt: asDate(row.createdAt, "User createdAt"),
    updatedAt: asDate(row.updatedAt, "User updatedAt"),
    ...optionalJson(row, "settings"),
    ...optionalJson(row, "packageInfo"),
    ...optionalJson(row, "notifications"),
    ...optionalJson(row, "extraInfo"),
  };
};

const parseItemRow = (row) => {
  const payload = asObject(row?.payload, "Record payload");

  return {
    id: asId(row.id, "Record id"),
    dataCategory: asText(row.dataCategory, "Record dataCategory").toLowerCase(),
    payload,
    searchText: buildSearchText(payload),
    sizeBytes: calculateJsonSize(payload),
    version: Number.isInteger(row.version) && row.version >= 0 ? row.version : 0,
    createdAt: asDate(row.createdAt, "Record createdAt"),
    updatedAt: asDate(row.updatedAt, "Record updatedAt"),
  };
};

/* ============================================================
   Writing
   ============================================================ */

/**
 * Split rows into ones still to write and ones already here.
 *
 * Rows already in this app are skipped, so a batch can be sent again after a
 * dropped connection. A row with the same id in any other app stops the import:
 * skipping it would lose the row silently, and that row is not ours to change.
 */
async function pendingRows(delegate, rows, appId, label) {
  const existing = await delegate.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
    select: { id: true, appId: true },
  });

  const foreign = existing.find((row) => row.appId !== appId);
  if (foreign) {
    throw new TransferError(
      409,
      "ID_CONFLICT",
      `${label} ${foreign.id} already exists outside this app, so it was not imported.`,
    );
  }

  const present = new Set(existing.map((row) => row.id));
  return rows.filter((row) => !present.has(row.id));
}

async function writeUsers(db, parsed, { appId, adminId, limits, userDefaults }) {
  const fresh = await pendingRows(db.user, parsed, appId, "User");
  if (!fresh.length) return 0;

  const total = await db.user.count({ where: { appId } });
  if (total + fresh.length > limits.maxUsersPerApp) {
    throw new TransferError(
      403,
      "MAX_USERS_PER_APP_REACHED",
      `This plan allows ${limits.maxUsersPerApp} users per app.`,
    );
  }

  try {
    await db.user.createMany({
      data: fresh.map((row) => ({ ...userDefaults, ...row, appId, adminId })),
    });
  } catch (err) {
    if (err.code === "P2002") {
      throw new TransferError(409, "EMAIL_CONFLICT", "Two users in this bundle share an email.");
    }
    throw err;
  }

  return fresh.length;
}

async function writeUserData(db, parsed, { appId, adminId, limits }) {
  const fresh = await pendingRows(db.userDataItem, parsed, appId, "Record");
  if (!fresh.length) return 0;

  const userIds = [...new Set(fresh.map((row) => row.userId))];
  const owners = await db.user.findMany({
    where: { id: { in: userIds }, appId },
    select: { id: true },
  });

  if (owners.length !== userIds.length) {
    throw invalid("A record belongs to a user who is not in this app.");
  }

  const stored = await db.userDataItem.groupBy({
    by: ["userId"],
    where: { userId: { in: userIds } },
    _sum: { sizeBytes: true },
  });
  const totals = new Map(stored.map((row) => [row.userId, row._sum.sizeBytes || 0]));

  for (const row of fresh) {
    const total = (totals.get(row.userId) || 0) + row.sizeBytes;
    totals.set(row.userId, total);

    if (total > limits.maxUserDataPerUser) {
      throw new TransferError(
        403,
        "USER_DATA_LIMIT_REACHED",
        `User ${row.userId} has more data than this plan allows per user.`,
      );
    }
  }

  await db.userDataItem.createMany({
    data: fresh.map((row) => ({ ...row, appId, adminId })),
  });

  const bytes = fresh.reduce((sum, row) => sum + row.sizeBytes, 0);
  await adjustUserDataStorage(db, appId, bytes);

  return fresh.length;
}

async function writeAppData(db, parsed, { appId, adminId, limits }) {
  const fresh = await pendingRows(db.appDataItem, parsed, appId, "Record");
  if (!fresh.length) return 0;

  const bytes = fresh.reduce((sum, row) => sum + row.sizeBytes, 0);
  const { appDataStorageUsed } = await db.app.findUnique({
    where: { id: appId },
    select: { appDataStorageUsed: true },
  });

  if (appDataStorageUsed + bytes > limits.maxAppDataStorage) {
    throw new TransferError(
      403,
      "APP_DATA_LIMIT_REACHED",
      "This app has more shared data than this plan allows.",
    );
  }

  await db.appDataItem.createMany({
    data: fresh.map((row) => ({ ...row, appId, adminId })),
  });
  await adjustAppDataStorage(db, appId, bytes);

  return fresh.length;
}

/**
 * Parent links go in last, in their own step, so a bundle's rows can arrive in
 * any order. Both ends of a link must be in this app and owned by one user:
 * the foreign key alone would accept a parent in someone else's app.
 */
async function writeLinks(db, links, { appId }) {
  const ids = [...new Set(links.flatMap((link) => [link.id, link.parentId]))];
  const rows = await db.userDataItem.findMany({
    where: { id: { in: ids }, appId },
    select: { id: true, userId: true, updatedAt: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const { id, parentId } of links) {
    const child = byId.get(id);
    const parent = byId.get(parentId);

    if (!child || !parent || child.userId !== parent.userId || id === parentId) {
      throw invalid(`Record ${id} points at a parent outside its owner's records.`);
    }

    // updatedAt is passed back so moving an app does not look like an edit.
    await db.userDataItem.update({
      where: { id },
      data: { parentId, updatedAt: child.updatedAt },
    });
  }

  return links.length;
}

/**
 * Write one batch in one transaction.
 *
 * @param prisma  Prisma client.
 * @param kind    One of KINDS.
 * @param rows    At most MAX_BATCH_ROWS rows of that kind.
 * @param ctx     { appId, adminId, limits, userDefaults }. appId and adminId
 *                come from the caller, and any in the row are ignored.
 *                userDefaults fills columns only one install has.
 * @returns the number of rows newly written.
 */
export async function writeBatch(prisma, kind, rows, ctx) {
  if (!Array.isArray(rows) || rows.length > MAX_BATCH_ROWS) {
    throw invalid(`Send between 0 and ${MAX_BATCH_ROWS} rows at a time.`);
  }
  if (!rows.length) return 0;

  switch (kind) {
    case KINDS.USERS: {
      const parsed = rows.map(parseUserRow);
      return prisma.$transaction((tx) => writeUsers(tx, parsed, ctx));
    }
    case KINDS.USER_DATA: {
      const parsed = rows.map((row) => ({
        ...parseItemRow(row),
        userId: asId(row?.userId, "Record userId"),
      }));
      return prisma.$transaction((tx) => writeUserData(tx, parsed, ctx));
    }
    case KINDS.APP_DATA: {
      const parsed = rows.map(parseItemRow);
      return prisma.$transaction((tx) => writeAppData(tx, parsed, ctx));
    }
    case KINDS.LINKS: {
      const links = rows.map((row) => ({
        id: asId(row?.id, "Record id"),
        parentId: asId(row?.parentId, "Record parentId"),
      }));
      return prisma.$transaction((tx) => writeLinks(tx, links, ctx));
    }
    default:
      throw invalid(`Unknown row kind: ${kind}.`);
  }
}

/** What an import ended up with, to compare against the bundle's end line. */
export async function countApp(prisma, appId) {
  const [users, userData, appData] = await Promise.all([
    prisma.user.count({ where: { appId } }),
    prisma.userDataItem.count({ where: { appId } }),
    prisma.appDataItem.count({ where: { appId } }),
  ]);

  return { [KINDS.USERS]: users, [KINDS.USER_DATA]: userData, [KINDS.APP_DATA]: appData };
}

/** @throws TransferError when the app holds fewer or more rows than expected. */
export function assertCounts(actual, expected) {
  for (const kind of [KINDS.USERS, KINDS.USER_DATA, KINDS.APP_DATA]) {
    if (actual[kind] !== expected?.[kind]) {
      throw new TransferError(
        409,
        "INCOMPLETE_IMPORT",
        `Expected ${expected?.[kind]} ${kind} rows but found ${actual[kind]}.`,
      );
    }
  }
}

/* ============================================================
   Reading
   ============================================================ */

const USER_FIELDS = {
  id: true,
  email: true,
  name: true,
  password: true,
  username: true,
  phone: true,
  address: true,
  avatarUrl: true,
  isVerified: true,
  isActive: true,
  role: true,
  settings: true,
  packageInfo: true,
  notifications: true,
  extraInfo: true,
  createdAt: true,
  updatedAt: true,
};

const ITEM_FIELDS = {
  id: true,
  dataCategory: true,
  payload: true,
  version: true,
  sizeBytes: true,
  createdAt: true,
  updatedAt: true,
};

const readers = (prisma) => ({
  [KINDS.USERS]: { delegate: prisma.user, select: USER_FIELDS },
  [KINDS.USER_DATA]: {
    delegate: prisma.userDataItem,
    select: { ...ITEM_FIELDS, userId: true, parentId: true },
  },
  [KINDS.APP_DATA]: { delegate: prisma.appDataItem, select: ITEM_FIELDS },
});

/**
 * One page of an app's rows, ordered by id so a page never moves under the
 * caller. Pages stop early on bytes, so no response outgrows its host's limit.
 *
 * @returns {{ rows: object[], nextCursor: string|null }}
 */
export async function readPage(prisma, kind, appId, cursor = null) {
  const reader = readers(prisma)[kind];
  if (!reader) throw invalid(`Unknown row kind: ${kind}.`);

  const found = await reader.delegate.findMany({
    where: { appId, ...(cursor ? { id: { gt: cursor } } : {}) },
    select: reader.select,
    orderBy: { id: "asc" },
    take: MAX_BATCH_ROWS,
  });

  const rows = [];
  let bytes = 0;

  for (const { sizeBytes, ...row } of found) {
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8");
    if (rows.length && bytes > MAX_PAGE_BYTES) break;
    rows.push({ kind, ...row });
  }

  const more = rows.length < found.length || found.length === MAX_BATCH_ROWS;
  return { rows, nextCursor: more ? rows[rows.length - 1].id : null };
}

export const appRowForBundle = (app) => ({
  kind: "app",
  id: app.id,
  applicationName: app.applicationName,
  category: app.category,
  description: app.description,
  platform: app.platform,
  allowedOrigins: app.allowedOrigins ?? [],
  allowedIps: app.allowedIps ?? [],
  createdAt: app.createdAt,
});

export const bundleHeader = (source, app, counts) => ({
  kind: "header",
  format: BUNDLE_FORMAT,
  version: BUNDLE_VERSION,
  source,
  exportedAt: new Date().toISOString(),
  applicationName: app.applicationName,
  counts,
});
