// CAS-1228: Cascade accounts are passwordless — the only account this project ever sets a password
// for is appreview@codynamics.com.au (the App Store / Play review account, CAS-1073), and that
// password is never derived from the account's email. This guards both invariants statically over
// app_template.html:
//   1. signUp( or signInWithPassword( may only appear inside the existing review-address branch —
//      a call guarded by an isReviewEmail( check within a few lines above it. Any other occurrence
//      (there is currently none) means a password-based path has been reintroduced for a normal
//      account and must fail the build.
//   2. crypto.subtle or digest( must never appear near a sign-in call (signInWithOtp(,
//      signInWithPassword(, verifyOtp(, signUp() — that shape is exactly how CAS-387 derived a
//      password from the user's email client-side, which CAS-1056 removed and CAS-1228 is erasing
//      the data trail of.
//
// Run with `node tests/lint/password-signin-guard.mjs`. Exits non-zero on any violation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "..", "app_template.html");

const REVIEW_GUARD_WINDOW = 5; // lines to look back for isReviewEmail(
const DERIVED_PASSWORD_WINDOW = 10; // lines of proximity counted as "near" a sign-in call

const SIGNIN_CALL_RE = /\b(?:signInWithOtp|signInWithPassword|verifyOtp|signUp)\s*\(/g;

function linesOf(src) {
  return src.split("\n");
}

function hasReviewGuardAbove(lines, lineIdx) {
  const start = Math.max(0, lineIdx - REVIEW_GUARD_WINDOW);
  for (let i = start; i <= lineIdx; i++) {
    if (/isReviewEmail\s*\(/.test(lines[i])) return true;
  }
  return false;
}

function run() {
  const html = readFileSync(TEMPLATE_PATH, "utf8");
  const lines = linesOf(html);
  const violations = [];

  const passwordCallRe = /\b(?:signUp|signInWithPassword)\s*\(/g;
  let m;
  while ((m = passwordCallRe.exec(html))) {
    const lineIdx = (html.slice(0, m.index).match(/\n/g) || []).length;
    const callName = m[0].replace(/\s*\($/, "");
    if (callName === "signUp") {
      violations.push(`${lineIdx + 1}: ${callName}( — Cascade accounts are passwordless; no sign-up path may set a password`);
      continue;
    }
    // signInWithPassword( — allowed only inside the review-address branch.
    if (!hasReviewGuardAbove(lines, lineIdx)) {
      violations.push(`${lineIdx + 1}: ${callName}( — not guarded by an isReviewEmail( check within ${REVIEW_GUARD_WINDOW} lines above; only the review account may sign in with a password`);
    }
  }

  const derivedRe = /\bcrypto\.subtle\b|\bdigest\s*\(/g;
  const signinLineIdxs = [];
  SIGNIN_CALL_RE.lastIndex = 0;
  while ((m = SIGNIN_CALL_RE.exec(html))) {
    signinLineIdxs.push((html.slice(0, m.index).match(/\n/g) || []).length);
  }
  while ((m = derivedRe.exec(html))) {
    const lineIdx = (html.slice(0, m.index).match(/\n/g) || []).length;
    const near = signinLineIdxs.some(s => Math.abs(s - lineIdx) <= DERIVED_PASSWORD_WINDOW);
    if (near) {
      violations.push(`${lineIdx + 1}: ${m[0]} found within ${DERIVED_PASSWORD_WINDOW} lines of a sign-in call — a password must never be derived from the account's email`);
    }
  }

  for (const v of violations) console.error(`[password-signin-guard] app_template.html:${v}`);
  console.log(`\npassword-signin-guard: ${violations.length} violation(s)`);
  if (violations.length) process.exit(1);
}

run();
