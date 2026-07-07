// budget.ts — コスト見積もり・会計・上限判定
//
// このモジュールは意図的に I/O を持たない純粋関数の集まりにしている（§5）。
// ストアからの読み書きは呼び出し側（app.ts）の責務。

export interface ModelPricing {
  /** USD / 100万入力トークン */
  inputPerMTok: number;
  /** USD / 100万出力トークン */
  outputPerMTok: number;
}

export interface UpstreamUsage {
  input_tokens: number;
  output_tokens: number;
}

const MICROS_PER_MILLION = 1_000_000;

/**
 * リクエストの推定入力トークン数（粗い見積もり。目的は桁の防御であって精密さではない）。
 * `ceil(utf8ByteLength(JSON.stringify(messages) + system) / 4)`
 */
export function estimateInputTokens(messages: unknown, system: string | null | undefined): number {
  const serialized = `${JSON.stringify(messages ?? [])}${system ?? ""}`;
  const byteLength = Buffer.byteLength(serialized, "utf8");
  return Math.ceil(byteLength / 4);
}

/** ワーストケースのコスト（プリチェック用）。入力は見積もり、出力は max_tokens を満杯とみなす。 */
export function estimateWorstCost(params: {
  messages: unknown;
  system?: string | null;
  maxTokens: number;
  pricing: ModelPricing;
}): number {
  const inputTokens = estimateInputTokens(params.messages, params.system);
  const inputCost = (inputTokens / MICROS_PER_MILLION) * params.pricing.inputPerMTok;
  const outputCost = (params.maxTokens / MICROS_PER_MILLION) * params.pricing.outputPerMTok;
  return inputCost + outputCost;
}

/** 上流の usage から実コストを計算する。 */
export function computeActualCost(usage: UpstreamUsage, pricing: ModelPricing): number {
  const inputCost = (usage.input_tokens / MICROS_PER_MILLION) * pricing.inputPerMTok;
  const outputCost = (usage.output_tokens / MICROS_PER_MILLION) * pricing.outputPerMTok;
  return inputCost + outputCost;
}

export type BudgetRejectReason = "monthly_limit" | "daily_limit";

export interface BudgetDecision {
  allowed: boolean;
  reason?: BudgetRejectReason;
}

export interface PrecheckBudgetParams {
  worstCost: number;
  /** そのトークンの当日実績（USD） */
  tokenTodayUsd: number;
  /** そのトークンの日次上限（USD） */
  tokenDailyUsd: number;
  /** 全体の当月実績（USD） */
  globalMonthUsd: number;
  /** 全体の月次上限（USD、キルスイッチ） */
  globalMonthlyUsd: number;
}

/**
 * 予算プリチェック。月次キルスイッチを先に見て、次にトークンの日次上限を見る。
 * どちらか一方でも超過見込みなら遮断する（fail-closed）。
 */
export function precheckBudget(params: PrecheckBudgetParams): BudgetDecision {
  if (params.globalMonthUsd + params.worstCost > params.globalMonthlyUsd) {
    return { allowed: false, reason: "monthly_limit" };
  }
  if (params.tokenTodayUsd + params.worstCost > params.tokenDailyUsd) {
    return { allowed: false, reason: "daily_limit" };
  }
  return { allowed: true };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** UTC 基準の日付キー（YYYY-MM-DD）。 */
export function dateKeyUTC(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** UTC 基準の月キー（YYYY-MM）。 */
export function monthKeyUTC(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

// --- Retry-After 計算（DX レビュー A-6）------------------------------------
//
// 日次上限は UTC 深夜（次の日の 00:00:00 UTC）に必ず解除される。月次上限は
// 翌月 1 日 00:00:00 UTC に解除される。どちらも「いつ再開できるか」を機械可読に
// 伝えるための純粋関数として実装し、app.ts からは `Date` を渡すだけで使えるようにする。

/** 次の UTC 深夜（翌日 00:00:00 UTC）までの秒数（切り上げ、最小 1）。 */
export function secondsUntilNextUTCMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** 翌月 1 日 00:00:00 UTC までの秒数（切り上げ、最小 1）。年またぎも `Date.UTC` の桁溢れ正規化に任せる。 */
export function secondsUntilNextUTCMonth(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** 予算超過理由から Retry-After 秒数を求める（日次 → 次の UTC 深夜、月次 → 翌月 1 日 UTC）。 */
export function retryAfterSecondsForReason(reason: BudgetRejectReason, now: Date = new Date()): number {
  return reason === "monthly_limit" ? secondsUntilNextUTCMonth(now) : secondsUntilNextUTCMidnight(now);
}
