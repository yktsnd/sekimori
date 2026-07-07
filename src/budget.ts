// budget.ts - cost estimation, accounting, and limit decisions
//
// This module is deliberately a collection of pure functions with no I/O
// (section 5). Reading from / writing to the store is the caller's (app.ts)
// responsibility.

export interface ModelPricing {
  /** USD per million input tokens */
  inputPerMTok: number;
  /** USD per million output tokens */
  outputPerMTok: number;
}

export interface UpstreamUsage {
  input_tokens: number;
  output_tokens: number;
}

const MICROS_PER_MILLION = 1_000_000;

/**
 * Rough estimate of the request's input tokens (the goal is order-of-magnitude
 * protection, not precision):
 * `ceil(utf8ByteLength(JSON.stringify(messages) + system) / 4)`
 */
export function estimateInputTokens(messages: unknown, system: string | null | undefined): number {
  const serialized = `${JSON.stringify(messages ?? [])}${system ?? ""}`;
  const byteLength = Buffer.byteLength(serialized, "utf8");
  return Math.ceil(byteLength / 4);
}

/** Worst-case cost (for the precheck): estimated input plus output at full max_tokens. */
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

/** Computes the actual cost from upstream-reported usage. */
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
  /** This token's spend today (USD) */
  tokenTodayUsd: number;
  /** This token's daily limit (USD) */
  tokenDailyUsd: number;
  /** Global spend this month (USD) */
  globalMonthUsd: number;
  /** Global monthly limit (USD, the kill switch) */
  globalMonthlyUsd: number;
}

/**
 * Budget precheck. Checks the monthly kill switch first, then the token's
 * daily limit. If either would be exceeded, the request is blocked
 * (fail-closed).
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

/** Date key in UTC (YYYY-MM-DD). */
export function dateKeyUTC(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Month key in UTC (YYYY-MM). */
export function monthKeyUTC(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

// --- Retry-After computation (DX review A-6) --------------------------------
//
// The daily limit always resets at UTC midnight (00:00:00 UTC the next day);
// the monthly limit resets at 00:00:00 UTC on the 1st of the next month.
// Both are pure functions that tell the caller machine-readably when it can
// retry; app.ts just passes in a `Date`.

/** Seconds until the next UTC midnight (00:00:00 UTC the next day), rounded up, minimum 1. */
export function secondsUntilNextUTCMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** Seconds until 00:00:00 UTC on the 1st of the next month, rounded up, minimum 1. Year rollover is left to `Date.UTC`'s overflow normalization. */
export function secondsUntilNextUTCMonth(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** Maps a budget-rejection reason to Retry-After seconds (daily -> next UTC midnight, monthly -> 1st of next month UTC). */
export function retryAfterSecondsForReason(reason: BudgetRejectReason, now: Date = new Date()): number {
  return reason === "monthly_limit" ? secondsUntilNextUTCMonth(now) : secondsUntilNextUTCMidnight(now);
}
