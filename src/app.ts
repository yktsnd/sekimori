// app.ts — Hono アプリの組み立て
//
// main.ts からも test からも直接使えるように、サーバー起動処理とは分離してある。

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { SekimoriConfig } from "./config.js";
import type { Store, TokenRecord } from "./store.js";
import { RateLimiter } from "./ratelimit.js";
import { forwardMessages, type ExtractedUsage } from "./proxy.js";
import { generateInviteToken, generateTokenId, hashToken } from "./tokens.js";
import {
  computeActualCost,
  dateKeyUTC,
  estimateWorstCost,
  monthKeyUTC,
  precheckBudget,
  retryAfterSecondsForReason,
} from "./budget.js";

export interface AppDeps {
  config: SekimoriConfig;
  store: Store;
  /** 上流 Anthropic API キー（config.upstream.apiKeyEnv が指す環境変数から読み取り済みの値）。 */
  upstreamApiKey: string;
  /** 管理者キー（環境変数 SEKIMORI_ADMIN_KEY の値）。 */
  adminKey: string;
}

interface LogEntry {
  ts: string;
  tokenId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  status: number;
  ms: number;
  requestBody?: unknown;
  responseBody?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorBody(type: string, message: string): { error: { type: string; message: string } } {
  return { error: { type, message } };
}

function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? (match[1] as string) : null;
}

/** 文字数の違いによる早期リターンも含め、雑な比較よりはタイミング攻撃に強い比較。 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createApp(deps: AppDeps): Hono {
  const { config, store, upstreamApiKey, adminKey } = deps;
  const rateLimiter = new RateLimiter(config.rateLimit.requestsPerMinute);
  const app = new Hono();

  // A-5: 許可されていない Origin からのリクエストを受けた際、運営者に気づかせるための
  // 1 行警告を stdout に出す。遮断そのもの（CORS ヘッダを出さないこと）は変えない。
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && !config.cors.allowedOrigins.includes(origin)) {
      console.warn(`[sekimori] blocked origin: ${origin} (cors.allowedOrigins に追加が必要かもしれない)`);
    }
    await next();
  });

  // CORS: allowedOrigins が空なら CORS ヘッダを一切出さない（§7）。
  app.use(
    "*",
    cors({
      origin: (origin) => (origin && config.cors.allowedOrigins.includes(origin) ? origin : ""),
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
    }),
  );

  // ストア fail-closed ゲート: 直近の永続化に失敗していたら /healthz 以外は 503(§5)。
  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz") {
      await next();
      return;
    }
    if (!store.isHealthy()) {
      return c.json(
        errorBody(
          "storage_unavailable_error",
          "internal storage is unavailable; requests are blocked until the operator restarts sekimori",
        ),
        503,
      );
    }
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  function logRequest(entry: LogEntry): void {
    const output: LogEntry = { ...entry };
    if (!config.logging.logBodies) {
      delete output.requestBody;
      delete output.responseBody;
    }
    console.log(JSON.stringify(output));
  }

  app.post("/v1/messages", async (c) => {
    const startedAt = Date.now();
    let tokenId: string | null = null;
    let model: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let costUsd = 0;
    let requestBody: unknown;
    let responseBodyForLog: string | undefined;

    const finish = (status: number): void => {
      logRequest({
        ts: new Date().toISOString(),
        tokenId,
        model,
        inputTokens,
        outputTokens,
        costUsd,
        status,
        ms: Date.now() - startedAt,
        requestBody,
        responseBody: responseBodyForLog,
      });
    };

    // 1. Bearer トークン検証
    const bearer = extractBearer(c.req.header("Authorization"));
    if (!bearer) {
      finish(401);
      return c.json(errorBody("authentication_error", "missing bearer token"), 401);
    }
    const tokenRecord = await store.findTokenByHash(hashToken(bearer));
    if (!tokenRecord || tokenRecord.revokedAt) {
      finish(401);
      return c.json(errorBody("authentication_error", "invalid or revoked token"), 401);
    }
    tokenId = tokenRecord.id;

    // 2. レート制限
    const rl = rateLimiter.check(tokenRecord.id);
    if (!rl.allowed) {
      c.header("Retry-After", String(rl.retryAfterSeconds));
      finish(429);
      return c.json(errorBody("rate_limit_error", "rate limit exceeded"), 429);
    }

    // ボディ解析
    let parsedBody: unknown;
    try {
      parsedBody = await c.req.json();
    } catch {
      finish(400);
      return c.json(errorBody("invalid_request_error", "request body must be valid JSON"), 400);
    }
    if (!isRecord(parsedBody)) {
      finish(400);
      return c.json(errorBody("invalid_request_error", "request body must be a JSON object"), 400);
    }
    requestBody = parsedBody;

    // 3. model 許可リスト確認
    const requestedModel = parsedBody.model;
    if (typeof requestedModel !== "string" || !Object.hasOwn(config.models, requestedModel)) {
      finish(403);
      return c.json(errorBody("permission_error", "model is not in the allow list"), 403);
    }
    model = requestedModel;
    const pricing = config.models[requestedModel];
    if (!pricing) {
      // Object.hasOwn で存在確認済みだが TypeScript の型上は narrow できないため防御的に。
      finish(403);
      return c.json(errorBody("permission_error", "model is not in the allow list"), 403);
    }

    // max_tokens が正整数か
    const maxTokens = parsedBody.max_tokens;
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      finish(400);
      return c.json(errorBody("invalid_request_error", "max_tokens must be a positive integer"), 400);
    }

    // 4. pinnedSystemPrompt 設定時は system を強制置換
    const payload: Record<string, unknown> = { ...parsedBody };
    if (config.pinnedSystemPrompt !== null) {
      payload.system = config.pinnedSystemPrompt;
    }
    const effectiveSystem = typeof payload.system === "string" ? payload.system : undefined;

    // 5. 予算プリチェック
    const worstCost = estimateWorstCost({
      messages: parsedBody.messages,
      system: effectiveSystem,
      maxTokens,
      pricing,
    });
    const todayKey = dateKeyUTC();
    const monthKey = monthKeyUTC();
    const tokenTodayUsd = await store.getUsageForDate(tokenRecord.id, todayKey);
    const globalMonthUsd = await store.getGlobalMonthlyUsage(monthKey);
    const decision = precheckBudget({
      worstCost,
      tokenTodayUsd,
      tokenDailyUsd: tokenRecord.dailyUsd,
      globalMonthUsd,
      globalMonthlyUsd: config.budget.monthlyUsd,
    });
    if (!decision.allowed) {
      // reason は precheckBudget が allowed: false を返す際は必ず設定される（budget.ts §PrecheckBudgetParams 参照）。
      const reason = decision.reason ?? "daily_limit";
      const message =
        reason === "monthly_limit" ? "monthly budget limit exceeded" : "daily budget limit exceeded for this token";
      // A-6: いつ再開できるかを機械可読に伝える。日次 → 次の UTC 深夜、月次 → 翌月 1 日 UTC。
      c.header("Retry-After", String(retryAfterSecondsForReason(reason)));
      finish(429);
      return c.json(errorBody("budget_exceeded_error", message), 429);
    }

    // 6. 上流へ転送
    const isStreamRequested = payload.stream === true;
    let forwardResult;
    try {
      forwardResult = await forwardMessages(
        { baseUrl: config.upstream.baseUrl, apiKey: upstreamApiKey },
        payload,
        isStreamRequested,
      );
    } catch (err) {
      finish(502);
      return c.json(
        errorBody("upstream_error", `failed to reach upstream: ${(err as Error).message}`),
        502,
      );
    }

    const recordCost = async (usage: ExtractedUsage | null): Promise<void> => {
      const cost = usage ? computeActualCost({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, pricing) : worstCost;
      inputTokens = usage?.inputTokens ?? null;
      outputTokens = usage?.outputTokens ?? null;
      costUsd = cost;
      try {
        await store.addUsage(tokenRecord.id, todayKey, cost);
      } catch {
        // fail-closed: store.isHealthy() が false になり、以後のリクエストが 503 になる。
      }
    };

    if (forwardResult.isStream && forwardResult.stream) {
      const headers = new Headers();
      headers.set("content-type", forwardResult.contentType ?? "text/event-stream");
      const status = forwardResult.status;
      // SSE は無加工で中継しつつ、usage 記録はバックグラウンドで完了を待つ。
      forwardResult.usagePromise.then(recordCost).finally(() => finish(status));
      return new Response(forwardResult.stream, { status, headers });
    }

    const usage = await forwardResult.usagePromise;
    await recordCost(usage);
    responseBodyForLog = forwardResult.bodyText;
    finish(forwardResult.status);
    const headers = new Headers();
    headers.set("content-type", forwardResult.contentType ?? "application/json");
    return new Response(forwardResult.bodyText ?? "", { status: forwardResult.status, headers });
  });

  app.get("/v1/usage", async (c) => {
    const bearer = extractBearer(c.req.header("Authorization"));
    if (!bearer) {
      return c.json(errorBody("authentication_error", "missing bearer token"), 401);
    }
    const tokenRecord = await store.findTokenByHash(hashToken(bearer));
    if (!tokenRecord || tokenRecord.revokedAt) {
      return c.json(errorBody("authentication_error", "invalid or revoked token"), 401);
    }
    const todayKey = dateKeyUTC();
    const monthKey = monthKeyUTC();
    const todayUsd = await store.getUsageForDate(tokenRecord.id, todayKey);
    const monthUsd = await store.getGlobalMonthlyUsage(monthKey);
    return c.json({
      todayUsd,
      dailyLimitUsd: tokenRecord.dailyUsd,
      monthUsd,
      monthlyLimitUsd: config.budget.monthlyUsd,
    });
  });

  function requireAdmin(authorizationHeader: string | undefined | null): boolean {
    const bearer = extractBearer(authorizationHeader);
    if (!bearer) return false;
    return safeEqual(bearer, adminKey);
  }

  app.post("/admin/tokens", async (c) => {
    if (!requireAdmin(c.req.header("Authorization"))) {
      return c.json(errorBody("authentication_error", "invalid admin key"), 401);
    }
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const record = isRecord(body) ? body : {};
    const name = typeof record.name === "string" ? record.name : undefined;
    const dailyUsd =
      typeof record.dailyUsd === "number" && record.dailyUsd > 0
        ? record.dailyUsd
        : config.budget.defaultDailyPerTokenUsd;

    const { token, tokenHash } = generateInviteToken();
    const tokenRecord: TokenRecord = {
      id: generateTokenId(),
      ...(name !== undefined ? { name } : {}),
      tokenHash,
      dailyUsd,
      createdAt: new Date().toISOString(),
    };
    await store.createToken(tokenRecord);
    return c.json({ id: tokenRecord.id, token }, 201);
  });

  app.get("/admin/tokens", async (c) => {
    if (!requireAdmin(c.req.header("Authorization"))) {
      return c.json(errorBody("authentication_error", "invalid admin key"), 401);
    }
    const tokens = await store.listTokens();
    return c.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        dailyUsd: t.dailyUsd,
        createdAt: t.createdAt,
        revokedAt: t.revokedAt,
      })),
    });
  });

  app.delete("/admin/tokens/:id", async (c) => {
    if (!requireAdmin(c.req.header("Authorization"))) {
      return c.json(errorBody("authentication_error", "invalid admin key"), 401);
    }
    const id = c.req.param("id");
    const record = await store.revokeToken(id);
    if (!record) {
      return c.json(errorBody("not_found_error", "token not found"), 404);
    }
    return c.json({ id: record.id, revokedAt: record.revokedAt });
  });

  app.get("/admin/usage", async (c) => {
    if (!requireAdmin(c.req.header("Authorization"))) {
      return c.json(errorBody("authentication_error", "invalid admin key"), 401);
    }
    const monthKey = monthKeyUTC();
    const todayKey = dateKeyUTC();
    const monthUsd = await store.getGlobalMonthlyUsage(monthKey);
    const tokens = await store.listTokens();
    const tokenUsages = await Promise.all(
      tokens.map(async (t) => ({
        id: t.id,
        name: t.name,
        todayUsd: await store.getUsageForDate(t.id, todayKey),
        dailyUsd: t.dailyUsd,
      })),
    );
    return c.json({ monthUsd, monthlyLimitUsd: config.budget.monthlyUsd, tokens: tokenUsages });
  });

  return app;
}
