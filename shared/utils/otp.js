import { verifyHashedOTP } from "./crypto.js";

/* ============================================================
   One-time codes

   A 6-digit code has a million values, so the code itself must be thrown
   away after a few wrong guesses — rate limits keyed by IP alone do not stop
   an attacker spreading guesses across many addresses.
   ============================================================ */

export const MAX_OTP_ATTEMPTS = 5;

/** Fields to write when a new code is issued. */
export const freshOtpFields = (otpHash, otpExpiry) => ({
  otp: otpHash,
  otpExpiry,
  otpAttempts: 0,
});

/** Fields to write once a code has been used. */
export const clearedOtpFields = () => ({
  otp: null,
  otpExpiry: null,
  otpAttempts: 0,
});

/**
 * Check a presented code against a user or admin row, counting wrong guesses.
 *
 * @param delegate prisma.user or prisma.adminUser
 * @param record   the row, with id, otp, otpExpiry and otpAttempts
 * @returns {Promise<boolean>} true when the code is valid and unexpired.
 *   The caller clears it (clearedOtpFields) in the same write that acts on it.
 */
export async function checkOtp(delegate, record, otp) {
  if (!record?.otp || !record.otpExpiry || new Date() > record.otpExpiry) {
    return false;
  }
  if ((record.otpAttempts ?? 0) >= MAX_OTP_ATTEMPTS) return false;

  if (typeof otp === "string" && (await verifyHashedOTP(otp, record.otp))) {
    return true;
  }

  const attempts = (record.otpAttempts ?? 0) + 1;
  await delegate.update({
    where: { id: record.id },
    data:
      attempts >= MAX_OTP_ATTEMPTS
        ? clearedOtpFields()
        : { otpAttempts: attempts },
  });
  return false;
}
