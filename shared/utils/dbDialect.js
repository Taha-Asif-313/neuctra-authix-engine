import { Prisma } from "@prisma/client";

/**
 * The few places where PostgreSQL and MySQL differ. Everything else goes
 * through Prisma, which hides the difference.
 */
const isMysql = /^(mysql|mariadb):/i.test(process.env.DATABASE_URL ?? "");

/** A quoted column or table name for raw SQL. Only ever pass a fixed name. */
export const col = (name) => Prisma.raw(isMysql ? `\`${name}\`` : `"${name}"`);

/** Records whose JSON payload contains these key/value pairs. */
export const payloadContains = (keys) => {
  const json = JSON.stringify(keys);
  return isMysql
    ? Prisma.sql`JSON_CONTAINS(payload, CAST(${json} AS JSON))`
    : Prisma.sql`payload @> ${json}::jsonb`;
};

/**
 * Rows older than a keyset cursor, newest first.
 *
 * Timestamps are stored in UTC with no zone. A Date parameter would be compared
 * in the database session's time zone, so on any server not set to UTC the
 * cursor lands hours away and every page repeats. Plain text has no zone.
 */
export const beforeCursor = ({ createdAt, id }) => {
  const utc = createdAt.toISOString().replace("T", " ").replace("Z", "");
  return isMysql
    ? Prisma.sql`(\`createdAt\`, id) < (CAST(${utc} AS DATETIME(3)), ${id})`
    : Prisma.sql`("createdAt", id) < (CAST(${utc}::text AS timestamp(3)), ${id})`;
};

/** Case-insensitive substring filter. MySQL's default collation already is. */
export const insensitive = (value) =>
  isMysql ? { contains: value } : { contains: value, mode: "insensitive" };
