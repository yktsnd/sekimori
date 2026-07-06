// tokens.ts — 招待トークンの発行・検証（ハッシュ保存）
//
// 平文トークンはこのモジュールが生成した直後（発行レスポンス）にしか存在しない。
// 永続化されるのは SHA-256 ハッシュのみ。

import { createHash, randomBytes, randomUUID } from "node:crypto";

const TOKEN_PREFIX = "smk_";
const TOKEN_RANDOM_BYTES = 32;

export interface GeneratedToken {
  /** 平文トークン。呼び出し元はこれを一度だけレスポンスで返し、保存しないこと。 */
  token: string;
  /** ストアに保存する SHA-256 ハッシュ（16進数文字列）。 */
  tokenHash: string;
}

/** 新しい招待トークンを生成する。`smk_` + ランダム32バイトの base64url。 */
export function generateInviteToken(): GeneratedToken {
  const random = randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  const token = `${TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashToken(token) };
}

/** トークン文字列の SHA-256 ハッシュ（16進数）を返す。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** トークンレコードの id を新規発行する。 */
export function generateTokenId(): string {
  return randomUUID();
}
