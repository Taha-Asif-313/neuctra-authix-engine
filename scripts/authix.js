#!/usr/bin/env node
/**
 * The engine's command line. The hosted service has a dashboard for these
 * jobs; a self-hosted engine has this.
 *
 *   npm run authix -- help
 */
import "dotenv/config";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import prisma from "../shared/prisma.js";
import { createApiKey } from "../shared/utils/crypto.js";
import { normalizeOrigin } from "../shared/utils/appAccess.js";
import {
  appRowForBundle,
  assertCounts,
  assertHeader,
  bundleHeader,
  countApp,
  KINDS,
  MAX_BATCH_ROWS,
  parseAppRow,
  readPage,
  TransferError,
  writeBatch,
} from "../shared/utils/appTransfer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A self-hosted engine has no plans, so nothing here limits an import. */
const NO_LIMITS = {
  maxUsersPerApp: Infinity,
  maxUserDataPerUser: Infinity,
  maxAppDataStorage: Infinity,
};

class UsageError extends Error {}

const parseFlags = (args) => {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      const value = args[i + 1];
      const hasValue = value !== undefined && !value.startsWith("--");
      flags[args[i].slice(2)] = hasValue ? value : true;
      if (hasValue) i += 1;
    } else {
      flags._.push(args[i]);
    }
  }
  return flags;
};

const getOwner = async () => {
  const owner = await prisma.adminUser.findFirst({ orderBy: { createdAt: "asc" } });
  if (!owner) throw new UsageError("Run `npm run setup` first.");
  return owner;
};

const getApp = async (flags) => {
  if (typeof flags.app === "string") {
    const app = await prisma.app.findUnique({ where: { id: flags.app } });
    if (!app) throw new UsageError(`No app with id ${flags.app}. See \`app:list\`.`);
    return app;
  }

  const apps = await prisma.app.findMany({ take: 2 });
  if (apps.length === 1) return apps[0];
  throw new UsageError("Choose an app with --app <id>. See `app:list`.");
};

const issueKey = async (owner, appId, kind) => {
  const key = createApiKey(kind);
  await prisma.apiKey.create({
    data: {
      adminId: owner.id,
      appId,
      kind,
      prefix: key.prefix,
      hash: key.hash,
      lastFour: key.lastFour,
      label: `CLI ${kind}`,
    },
  });
  return key.plaintext;
};

const printConnection = (app, keys) => {
  console.log(`
App:         ${app.applicationName}
appId:       ${app.id}
baseUrl:     http://localhost:${process.env.PORT || 5000}/api
Publishable: ${keys.publishable}
Secret:      ${keys.secret}

Copy these keys now. They are stored hashed and cannot be shown again.
The publishable key goes in browser or mobile code. Keep the secret key on a server.
`);
};

const createAppWithKeys = async (owner, name, origins) => {
  const app = await prisma.app.create({
    data: {
      applicationName: name,
      category: "other",
      description: "",
      platform: "web",
      allowedOrigins: origins,
      adminId: owner.id,
    },
  });

  printConnection(app, {
    publishable: await issueKey(owner, app.id, "publishable"),
    secret: await issueKey(owner, app.id, "secret"),
  });
};

/* ---------- search indexes ---------- */

const applySearchIndexes = async () => {
  if (!/^postgres/i.test(process.env.DATABASE_URL ?? "")) return;

  try {
    await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    const [{ schema }] = await prisma.$queryRawUnsafe(
      `SELECT n.nspname AS schema FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pg_trgm'`,
    );

    const statements = readFileSync(path.join(root, "prisma/postgresql/indexes.sql"), "utf8")
      .replace(/^\s*--.*$/gm, "")
      .replaceAll("__TRGM_OPS__", `"${schema}".gin_trgm_ops`)
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }
  } catch (err) {
    console.warn(`Search indexes were not created, so search will be slower: ${err.message.split("\n")[0]}`);
  }
};

/* ---------- commands ---------- */

const init = async (flags) => {
  await applySearchIndexes();

  const owner =
    (await prisma.adminUser.findFirst()) ??
    (await prisma.adminUser.create({
      data: { name: "Owner", email: "owner@localhost" },
    }));

  const hasApps = await prisma.app.count();
  if (hasApps) {
    console.log("Already set up. Run `npm run authix -- app:list` to see your apps.");
    return;
  }

  const name = typeof flags.app === "string" ? flags.app : "My App";
  const origin = typeof flags.origin === "string" ? flags.origin : "http://localhost:3000";
  await createAppWithKeys(owner, name, [origin]);
};

const appList = async () => {
  const apps = await prisma.app.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { users: true } } },
  });

  if (!apps.length) console.log("No apps yet.");
  for (const app of apps) {
    console.log(`${app.id}  ${app.applicationName}  (${app._count.users} users)`);
  }
};

const appCreate = async (flags) => {
  const name = flags._[0];
  if (!name) throw new UsageError('Usage: app:create "Notes" [--origin https://example.com]');

  const owner = await getOwner();
  const origin = typeof flags.origin === "string" ? flags.origin : "http://localhost:3000";
  await createAppWithKeys(owner, name, [origin]);
};

const originAdd = async (flags) => {
  const { value, error } = normalizeOrigin(flags._[0] ?? "");
  if (!value) throw new UsageError(error || "Usage: origin:add https://example.com [--app <id>]");

  const app = await getApp(flags);
  const origins = new Set(app.allowedOrigins ?? []);
  origins.add(value);

  await prisma.app.update({
    where: { id: app.id },
    data: { allowedOrigins: [...origins] },
  });
  console.log(`Allowed origins for ${app.applicationName}: ${[...origins].join(", ")}`);
};

const keyCreate = async (flags) => {
  const kind = flags._[0];
  if (kind !== "secret" && kind !== "publishable") {
    throw new UsageError("Usage: key:create secret|publishable [--app <id>]");
  }

  const app = await getApp(flags);
  const key = await issueKey(await getOwner(), app.id, kind);
  console.log(`${key}\n\nCopy this key now. It cannot be shown again.`);
};

const keyRevoke = async (flags) => {
  const prefix = flags._[0];
  if (!prefix) throw new UsageError("Usage: key:revoke <key or its prefix, e.g. sk_live_a1b2c3d4>");

  const handle = prefix.split("_").slice(0, 3).join("_");
  const { count } = await prisma.apiKey.updateMany({
    where: { prefix: handle, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  console.log(count ? `Revoked ${handle}.` : `No active key ${handle}.`);
};

/** Bundles hold password hashes, so the file is readable by its owner only. */
const exportApp = async (flags) => {
  const app = await getApp(flags);
  const safeName = app.applicationName.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
  const file = typeof flags.out === "string" ? flags.out : `${safeName}.authix`;

  const out = createWriteStream(file, { mode: 0o600 });
  const write = async (row) => {
    if (!out.write(`${JSON.stringify(row)}\n`)) await once(out, "drain");
  };

  const counts = await countApp(prisma, app.id);
  await write(bundleHeader("engine", app, counts));
  await write(appRowForBundle(app));

  // Users first: an import checks each record's owner already exists.
  const written = {};
  for (const kind of [KINDS.USERS, KINDS.USER_DATA, KINDS.APP_DATA]) {
    written[kind] = 0;
    let cursor = null;

    do {
      const page = await readPage(prisma, kind, app.id, cursor);
      for (const row of page.rows) await write(row);
      written[kind] += page.rows.length;
      cursor = page.nextCursor;
    } while (cursor);
  }

  await write({ kind: "end", counts: written });
  out.end();
  await once(out, "finish");

  console.log(`Exported ${app.applicationName} to ${file}
  ${written[KINDS.USERS]} users, ${written[KINDS.USER_DATA]} user records, ${written[KINDS.APP_DATA]} app records

This file contains password hashes and all user data. Treat it like a database backup.
To go live: open the Neuctra Authix dashboard, go to Apps and choose Import app.`);
};

const removeApp = async (appId) => {
  await prisma.$transaction(async (tx) => {
    await tx.userDataItem.deleteMany({ where: { appId } });
    await tx.appDataItem.deleteMany({ where: { appId } });
    await tx.user.deleteMany({ where: { appId } });
    await tx.app.delete({ where: { id: appId } });
  });
};

const importApp = async (flags) => {
  const file = flags._[0];
  if (!file) throw new UsageError("Usage: import <file.authix>");
  if (!existsSync(file)) throw new UsageError(`No such file: ${file}`);

  const owner = await getOwner();
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  const context = { adminId: owner.id, limits: NO_LIMITS };
  const batch = { kind: null, rows: [] };
  const links = [];
  let expected = null;
  let lineNumber = 0;

  const flush = async () => {
    if (batch.rows.length) {
      await writeBatch(prisma, batch.kind, batch.rows, context);
    }
    batch.rows = [];
  };

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      lineNumber += 1;

      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw new TransferError(400, "INVALID_BUNDLE", "This file is not a bundle, or it is damaged.");
      }

      if (lineNumber === 1) {
        assertHeader(row);
      } else if (row.kind === "app") {
        const { id, createdAt, ...fields } = parseAppRow(row);

        if (await prisma.app.findUnique({ where: { id }, select: { id: true } })) {
          throw new TransferError(409, "APP_EXISTS", `App ${id} is already on this engine.`);
        }

        await prisma.app.create({
          data: { id, createdAt, ...fields, isActive: false, adminId: owner.id },
        });
        context.appId = id;
        context.applicationName = fields.applicationName;
      } else if (row.kind === "end") {
        expected = row.counts;
      } else {
        if (!context.appId) throw new TransferError(400, "INVALID_BUNDLE", "The bundle has no app line.");

        if (batch.kind !== row.kind || batch.rows.length >= MAX_BATCH_ROWS) {
          await flush();
          batch.kind = row.kind;
        }
        batch.rows.push(row);

        if (row.kind === KINDS.USER_DATA && row.parentId) {
          links.push({ id: row.id, parentId: row.parentId });
        }
      }
    }

    await flush();

    if (!expected) {
      throw new TransferError(400, "INVALID_BUNDLE", "The file is incomplete: it has no end line.");
    }

    for (let i = 0; i < links.length; i += MAX_BATCH_ROWS) {
      await writeBatch(prisma, KINDS.LINKS, links.slice(i, i + MAX_BATCH_ROWS), context);
    }

    assertCounts(await countApp(prisma, context.appId), expected);
    await prisma.app.update({ where: { id: context.appId }, data: { isActive: true } });
  } catch (err) {
    // Only an app this run created: on APP_EXISTS appId was never set.
    if (context.appId) await removeApp(context.appId);
    throw err;
  }

  console.log(`Imported ${context.applicationName}. Existing users keep their passwords.`);
  printConnection(
    { id: context.appId, applicationName: context.applicationName },
    {
      publishable: await issueKey(owner, context.appId, "publishable"),
      secret: await issueKey(owner, context.appId, "secret"),
    },
  );
};

const HELP = `Neuctra Authix Engine

  app:list                                 List apps
  app:create "Notes" [--origin <url>]      Create an app and its keys
  origin:add <url> [--app <id>]            Allow a website to use an app
  key:create secret|publishable [--app <id>]
  key:revoke <key or prefix>
  export [--app <id>] [--out notes.authix] Save an app to a bundle file
  import <file.authix>                     Load a bundle into this engine

Example:  npm run authix -- export --out notes.authix`;

const commands = {
  init,
  "app:list": appList,
  "app:create": appCreate,
  "origin:add": originAdd,
  "key:create": keyCreate,
  "key:revoke": keyRevoke,
  export: exportApp,
  import: importApp,
};

const [name, ...rest] = process.argv.slice(2);

if (!commands[name]) {
  console.log(HELP);
  process.exit(name && name !== "help" ? 1 : 0);
}

try {
  await commands[name](parseFlags(rest));
} catch (err) {
  const expected = err instanceof UsageError || err instanceof TransferError;
  console.error(expected ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
