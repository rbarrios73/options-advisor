// What makes a password acceptable here.
//
// In domain/ so the browser can read the same rule the server enforces: the sign-up form tells you
// the minimum before you type, and the server refuses below it. Two numbers that could drift apart
// is how a form happily accepts something the API then rejects.
//
// The hashing itself is NOT here — that is users.js, and it needs node:crypto. This file is only
// the rule, which is pure.

/**
 * Ten, not eight, and no requirement for a symbol or a digit.
 *
 * Length is what actually costs an attacker; composition rules mostly cost the person choosing,
 * and push them towards "Passw0rd!" — short, predictable, and technically compliant.
 */
export const MIN_PASSWORD_LENGTH = 10;

const MAX_PASSWORD_LENGTH = 200;

/** What is wrong with this password, in words, or null if nothing is. */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  // An upper bound because scrypt hashes whatever it is given, and a megabyte of "a" is a way to
  // make the server do a megabyte of work per request.
  if (password.length > MAX_PASSWORD_LENGTH) return 'Password is too long.';
  if (password.trim().length === 0) return 'Password cannot be only spaces.';
  return null;
}
