import {
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import bcrypt from "bcrypt";

/* ============================================================
   Random identifiers
   ============================================================ */

/**
 * Random 32-char hex id.
 * Backed by node:crypto rather than CryptoJS — WordArray.random has shipped
 * weak-entropy implementations, which is unacceptable for anything credential-like.
 */
export function generateId() {
  return randomBytes(16).toString("hex");
}

/* ============================================================
   API keys
   ============================================================

   Format:  <code>_<env>_<prefix>_<secret>
   Example: sk_live_a1b2c3d4_9f8e...   (48 hex chars of secret)

   code is sk (secret), pk (publishable) or ak (keys minted before the split,
   all secret). It only helps people tell keys apart: the kind stored on the
   ApiKey row is what authorization reads.

   `prefix` is the public, indexed lookup handle stored in the DB.
   `secret` is never stored — only its SHA-256 hash is.
   ============================================================ */

const KEY_PATTERN = /^(ak|pk|sk)_(live|test)_([0-9a-f]{8})_([0-9a-f]{48})$/;

/** SHA-256 of a plaintext key. Fast by design — keys are already high-entropy, */
/** so a slow KDF would only add per-request latency without adding security. */
export function hashApiKey(plaintext) {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

const KEY_CODE = { secret: "sk", publishable: "pk" };

/**
 * Mint a new API key.
 * @param {"secret"|"publishable"} kind
 * @param {"live"|"test"} env
 * @returns {{plaintext:string, prefix:string, hash:string, lastFour:string}}
 *   `plaintext` is the only time the full key exists — show it once, never persist it.
 */
export function createApiKey(kind = "secret", env = "live") {
  const code = KEY_CODE[kind];
  if (!code) throw new Error(`Unknown API key kind: ${kind}`);

  const prefixId = randomBytes(4).toString("hex"); // 8 hex chars
  const secret = randomBytes(24).toString("hex"); // 48 hex chars

  const prefix = `${code}_${env}_${prefixId}`;
  const plaintext = `${prefix}_${secret}`;

  return {
    plaintext,
    prefix,
    hash: hashApiKey(plaintext),
    lastFour: plaintext.slice(-4),
  };
}

/**
 * Parse a presented key without touching the database.
 * Returns null for anything malformed, so callers can reject early.
 * @returns {{env:string, prefix:string}|null}
 */
export function parseApiKey(raw) {
  if (typeof raw !== "string") return null;

  const match = KEY_PATTERN.exec(raw.trim());
  if (!match) return null;

  const [, code, env, prefixId] = match;

  return {
    env,
    prefix: `${code}_${env}_${prefixId}`,
  };
}

/**
 * Timing-safe comparison of a presented key against a stored hash.
 * Both sides are fixed-length hex digests, so lengths always match.
 */
export function verifyApiKey(plaintext, storedHash) {
  if (typeof storedHash !== "string" || storedHash.length !== 64) return false;

  const presented = Buffer.from(hashApiKey(plaintext), "hex");
  const stored = Buffer.from(storedHash, "hex");

  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

/* ============================================================
   OTPs
   ============================================================ */

/** Hash an OTP before saving. Applies to admin and end-user flows alike. */
export const hashOTP = async (otp) => {
  return await bcrypt.hash(String(otp), 10);
};

export const verifyHashedOTP = async (plainOtp, hashedOtp) => {
  if (!plainOtp || !hashedOtp) return false;
  return await bcrypt.compare(String(plainOtp), hashedOtp);
};
