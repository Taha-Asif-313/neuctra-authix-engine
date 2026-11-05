#!/usr/bin/env node
/**
 * npm run setup
 *
 * Safe to run again. Prepares the database named by DATABASE_URL, then creates
 * the owner, a first app and its API keys if there are none yet.
 *
 * Tables are only ever created with `prisma migrate deploy`, which refuses a
 * database that already holds other tables. Never `prisma db push`: that can
 * drop tables it does not recognise, and this may be someone's real database.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  return result.status === 0;
};

// Hosting platforms and containers set real environment variables, which win
// over .env, so the file is only needed when they are not set.
dotenv.config({ path: envPath, override: false, quiet: true });

if (!process.env.DATABASE_URL && !fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(root, ".env.example"), envPath);
  fail("Created .env from .env.example. Set DATABASE_URL in it, then run `npm run setup` again.");
}

// Each engine gets its own signing secret, written once. Changing it later
// signs every user out.
if (!process.env.USER_JWT_SECRET) {
  const line = `USER_JWT_SECRET=${randomBytes(32).toString("hex")}`;
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

  fs.writeFileSync(
    envPath,
    /^USER_JWT_SECRET=.*$/m.test(envText)
      ? envText.replace(/^USER_JWT_SECRET=.*$/m, line)
      : `${envText.trimEnd()}\n${line}\n`.trimStart(),
  );
  dotenv.config({ path: envPath, override: true, quiet: true });
  console.log("Generated USER_JWT_SECRET in .env");
}

const url = process.env.DATABASE_URL ?? "";
const provider = /^postgres(ql)?:/i.test(url)
  ? "postgresql"
  : /^(mysql|mariadb):/i.test(url)
    ? "mysql"
    : null;

if (!provider) {
  fail("DATABASE_URL must start with postgresql:// or mysql://. Set it in .env.");
}

const schema = `prisma/${provider}/schema.prisma`;
console.log(`Using ${provider}`);

if (!run("npx", ["prisma", "generate", "--schema", schema])) {
  fail("Could not generate the database client.");
}

if (!run("npx", ["prisma", "migrate", "deploy", "--schema", schema])) {
  fail(
    "Could not create the tables. If the error says the database is not empty, " +
      "nothing was changed: Authix needs a place of its own. On PostgreSQL add " +
      "?schema=authix to DATABASE_URL. On MySQL create a new database for it.",
  );
}

// A new process: the client generated above must be the one that gets loaded.
const init = ["scripts/authix.js", "init", ...process.argv.slice(2)];
if (!run(process.execPath, init)) fail("Setup did not finish.");
