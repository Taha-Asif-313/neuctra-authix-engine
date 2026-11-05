import { PrismaClient } from "@prisma/client";

/**
 * Prisma client.
 *
 *  • maxWait — how long a transaction may queue for a free connection. Prisma's
 *    default is 2s, which a burst of writes to a remote database can exceed
 *    even though nothing is actually wrong. Raised to 15s.
 *
 *  • timeout — how long a transaction may run before being rolled back. The
 *    batch endpoint can issue dozens of statements, so the 5s default is raised
 *    to 20s. It is still bounded: a stuck transaction must not hold a connection
 *    indefinitely.
 *
 * Pool size is set on the connection string, for example
 * DATABASE_URL="postgresql://…/mydb?schema=authix&connection_limit=5".
 */

const globalForPrisma = globalThis;

const createClient = () =>
  new PrismaClient({
    transactionOptions: {
      maxWait: 15_000,
      timeout: 20_000,
    },
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

// Reuse a single client across hot reloads, so each reload does not open
// another connection pool.
const prisma = globalForPrisma.__authixPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__authixPrisma = prisma;
}

export default prisma;
