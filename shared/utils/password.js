// server/utils/password.js
import bcrypt from "bcrypt";

export const MIN_PASSWORD_LENGTH = 8;

/** Applies to passwords being set. Existing passwords still sign in as before. */
export const isAcceptablePassword = (password) =>
  typeof password === "string" && password.trim().length >= MIN_PASSWORD_LENGTH;

export const PASSWORD_TOO_SHORT = {
  success: false,
  message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
  code: "PASSWORD_TOO_SHORT",
};

export const hashPassword = async (password) => {
  const saltRounds = 10;
  return bcrypt.hash(password, saltRounds);
};

export const comparePassword = async (password, hashedPassword) => {
  return bcrypt.compare(password, hashedPassword);
};
