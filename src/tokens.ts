// tokens.ts - invite token issuance and verification (stored as hashes only)
//
// The plaintext token exists only for the instant this module generates it
// (the issuance response). Only its SHA-256 hash is ever persisted.

import { createHash, randomBytes, randomUUID } from "node:crypto";

const TOKEN_PREFIX = "smk_";
const TOKEN_RANDOM_BYTES = 32;

export interface GeneratedToken {
  /** Plaintext token. The caller must return this exactly once in the response and never store it. */
  token: string;
  /** SHA-256 hash (hex string) to persist in the store. */
  tokenHash: string;
}

/** Generates a new invite token: `smk_` + 32 random bytes, base64url-encoded. */
export function generateInviteToken(): GeneratedToken {
  const random = randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  const token = `${TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashToken(token) };
}

/** Returns the SHA-256 hash (hex) of a token string. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Issues a new id for a token record. */
export function generateTokenId(): string {
  return randomUUID();
}
