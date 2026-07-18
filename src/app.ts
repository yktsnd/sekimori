// app.ts - assembling the Hono app
//
// Kept separate from server startup so both main.ts and tests can use it directly.

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { SekimoriConfig } from "./config.js";
import type { ReserveUsageResult, Store, TokenRecord } from "./store.js";
import { RateLimiter } from "./ratelimit.js";
import { forwardMessages, UpstreamResponseTooLargeError, type ExtractedUsage } from "./proxy.js";
import { generateInviteToken, generateTokenId, hashToken } from "./tokens.js";
import {
  computeActualCost,
  dateKeyUTC,
  estimateRequestTokens,
  estimateWorstCost,
  MAX_ACCOUNTABLE_REQUEST_BYTES,
  MAX_USD_AMOUNT,
  monthKeyUTC,
  retryAfterSecondsForReason,
} from "./budget.js";

export interface AppDeps {
  config: SekimoriConfig;
  store: Store;
  /** Upstream Anthropic API key (already read from the env var named by config.upstream.apiKeyEnv). */
  upstreamApiKey: string;
  /** Admin key (the value of the SEKIMORI_ADMIN_KEY environment variable). */
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
  upstreamStatus?: number;
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

/** Constant-time-ish comparison (including the length-mismatch early return) - more resistant to timing attacks than a naive comparison. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * The configured price table only models ordinary input/output tokens. Reject
 * Anthropic features that can add a separate provider charge (or whose token
 * cost cannot be bounded from the request bytes) instead of claiming a hard
 * cap while silently under-accounting them.
 */
const ALLOWED_REQUEST_FIELDS = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "stream",
  "metadata",
  "stop_sequences",
  "temperature",
  "top_p",
  "top_k",
]);
const MAX_REQUEST_NESTING_DEPTH = 64;

type RequestRestriction = "unsupported_feature" | "too_deep";

function isRequestNestingTooDeep(value: unknown): boolean {
  // This walks iteratively rather than recursively. JSON bodies are capped at
  // 64 KiB, but a small body can still contain thousands of nested arrays;
  // recursion would let such a request overflow the JavaScript call stack
  // before it reached the budget gate or its audit log.
  const visited = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.depth > MAX_REQUEST_NESTING_DEPTH) return true;
    if (!Array.isArray(current.value) && !isRecord(current.value)) continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);

    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

function findRequestRestriction(value: unknown): RequestRestriction | null {
  if (!isRecord(value)) return "unsupported_feature";
  // Reject unknown top-level fields (including service tiers, fast mode, and
  // inference geography) rather than forwarding a new provider-priced feature
  // through a two-column, flat-price budget model.
  if (Object.keys(value).some((key) => !ALLOWED_REQUEST_FIELDS.has(key))) return "unsupported_feature";
  if (isRequestNestingTooDeep(value)) return "too_deep";

  const visited = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!Array.isArray(current) && !isRecord(current)) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (isRecord(current)) {
      if (Object.hasOwn(current, "cache_control")) return "unsupported_feature";

      const type = current.type;
      if (typeof type === "string") {
        if (["image", "document", "audio", "video"].includes(type)) return "unsupported_feature";
        if (
          ["web_search", "web_fetch", "code_execution", "computer", "bash", "text_editor"].some((prefix) =>
            type.startsWith(prefix),
          )
        ) {
          return "unsupported_feature";
        }
      }
    }

    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) {
      stack.push(child);
    }
  }
  return null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

/** Validate the deliberately small, ordinary-text Messages subset that the
 * flat input/output price table can account for. Provider-side validation is
 * too late: a provider 400 is still an ambiguous billable outcome and must
 * conservatively retain the reservation. */
function validateMessagesShape(body: Record<string, unknown>): string | null {
  const isTextContent = (value: unknown): boolean => {
    if (typeof value === "string") return true;
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (block) =>
          isRecord(block) &&
          hasOnlyKeys(block, ["type", "text"]) &&
          block.type === "text" &&
          typeof block.text === "string",
      )
    );
  };

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return "messages must be a non-empty array";
  }
  for (const message of body.messages) {
    if (!isRecord(message) || !hasOnlyKeys(message, ["role", "content"])) {
      return "each message must contain only role and content";
    }
    if (message.role !== "user" && message.role !== "assistant") {
      return 'message role must be "user" or "assistant"';
    }
    if (!isTextContent(message.content)) {
      return "message content must be text or a non-empty array of text blocks";
    }
  }

  if (body.system !== undefined && !isTextContent(body.system)) {
    return "system must be text or a non-empty array of text blocks";
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return "stream must be a boolean";
  }
  if (
    body.stop_sequences !== undefined &&
    (!Array.isArray(body.stop_sequences) ||
      !body.stop_sequences.every((value) => typeof value === "string" && value.length > 0))
  ) {
    return "stop_sequences must be an array of non-empty strings";
  }
  if (
    body.temperature !== undefined &&
    (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 1)
  ) {
    return "temperature must be a finite number from 0 to 1";
  }
  if (
    body.top_p !== undefined &&
    (typeof body.top_p !== "number" || !Number.isFinite(body.top_p) || body.top_p < 0 || body.top_p > 1)
  ) {
    return "top_p must be a finite number from 0 to 1";
  }
  if (
    body.top_k !== undefined &&
    (typeof body.top_k !== "number" || !Number.isSafeInteger(body.top_k) || body.top_k <= 0)
  ) {
    return "top_k must be a positive integer";
  }
  if (body.metadata !== undefined) {
    if (
      !isRecord(body.metadata) ||
      !hasOnlyKeys(body.metadata, ["user_id"]) ||
      (body.metadata.user_id !== undefined &&
        (typeof body.metadata.user_id !== "string" || body.metadata.user_id.length === 0 || body.metadata.user_id.length > 256))
    ) {
      return "metadata must contain only an optional user_id string of 1 to 256 characters";
    }
  }
  return null;
}

export function createApp(deps: AppDeps): Hono {
  const { config, store, upstreamApiKey, adminKey } = deps;
  if (!/^[\x21-\x7e]+$/.test(upstreamApiKey)) {
    throw new Error("upstream API key must contain visible ASCII characters only");
  }
  if (adminKey.length < 32 || !/^[\x21-\x7e]+$/.test(adminKey)) {
    throw new Error("admin key must contain at least 32 visible ASCII characters");
  }
  if (upstreamApiKey === adminKey) throw new Error("upstream and admin credentials must be different");
  const rateLimiter = new RateLimiter(config.rateLimit.requestsPerMinute);
  const app = new Hono();
  const warnedOrigins = new Set<string>();
  let accountingHealthy = true;

  function availabilityError(c: Context): Response | null {
    if (!store.isHealthy()) {
      return c.json(
        errorBody(
          "storage_unavailable_error",
          "internal storage is unavailable; requests are blocked until the operator restarts sekimori",
        ),
        503,
      );
    }
    if (!accountingHealthy) {
      return c.json(
        errorBody(
          "accounting_unavailable_error",
          "usage accounting became unsafe; requests are blocked until the operator restarts sekimori and verifies pricing",
        ),
        503,
      );
    }
    return null;
  }

  // Responses can contain model output, usage, token metadata, or the one-time
  // plaintext invite token. Do not let a browser/proxy cache any route,
  // including errors that may echo an upstream body in opt-in operator logs.
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // A storage write can fail in the small interval after the health middleware
  // runs (for example while an admin token is being persisted). Convert that
  // race into the same documented fail-closed response instead of leaking a
  // framework-default 500. Other unexpected errors stay structured too.
  app.onError((err, c) => {
    const unavailable = availabilityError(c);
    if (unavailable) return unavailable;
    // Do not print an arbitrary exception message: a dependency or future
    // request parser could embed untrusted request content in it.
    const category = err instanceof Error && err.name ? err.name : "unknown";
    console.error(`[sekimori] internal error (${category})`);
    return c.json(errorBody("internal_error", "an unexpected internal error occurred"), 500);
  });

  // Log each unexpected Origin at most once (and cap the set) so untrusted
  // Origin headers cannot flood logs or grow memory without bound. This does
  // not change the actual blocking behavior: no CORS headers are emitted.
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && !config.cors.allowedOrigins.includes(origin) && !warnedOrigins.has(origin) && warnedOrigins.size < 100) {
      warnedOrigins.add(origin);
      const safeOrigin = origin.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512);
      console.warn(`[sekimori] blocked origin: ${safeOrigin} (you may need to add it to cors.allowedOrigins)`);
    }
    await next();
  });

  // Hono's CORS middleware completes preflight requests itself. Check the
  // fail-closed availability gate first so OPTIONS cannot bypass it.
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS" && c.req.path !== "/healthz") {
      const unavailable = availabilityError(c);
      if (unavailable) return unavailable;
    }
    await next();
  });

  // CORS is installed only on real routes and only when at least one origin
  // is configured. This keeps an empty allowlist header-free and prevents a
  // preflight to an unknown route from being turned into a framework 204.
  if (config.cors.allowedOrigins.length > 0) {
    const corsMiddleware = cors({
      origin: (origin) => (origin && config.cors.allowedOrigins.includes(origin) ? origin : ""),
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      exposeHeaders: ["Retry-After"],
    });
    for (const path of [
      "/healthz",
      "/v1/messages",
      "/v1/usage",
      "/admin/tokens",
      "/admin/tokens/:id",
      "/admin/usage",
    ]) {
      app.use(path, corsMiddleware);
    }
  }

  // Store fail-closed gate: if the most recent persist failed, everything
  // except /healthz returns 503 (section 5).
  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz") {
      await next();
      return;
    }
    const unavailable = availabilityError(c);
    if (unavailable) return unavailable;
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

  const messagesBodyLimit = bodyLimit({
    maxSize: MAX_ACCOUNTABLE_REQUEST_BYTES,
    onError: (c) =>
      c.json(
        errorBody(
          "invalid_request_error",
          `request body is too large for the configured flat price table (maximum ${MAX_ACCOUNTABLE_REQUEST_BYTES} bytes)`,
        ),
        413,
      ),
  });

  const adminBodyLimit = bodyLimit({
    maxSize: 8 * 1024,
    onError: (c) => c.json(errorBody("invalid_request_error", "admin request body is too large (maximum 8192 bytes)"), 413),
  });

  app.post("/v1/messages", messagesBodyLimit, async (c) => {
    const startedAt = Date.now();
    let tokenId: string | null = null;
    let model: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let costUsd = 0;
    let requestBody: unknown;
    let responseBodyForLog: string | undefined;
    let upstreamStatus: number | undefined;
    let activeRateLimitTokenId: string | null = null;
    let finished = false;

    const finish = (status: number): void => {
      if (finished) return;
      finished = true;
      if (activeRateLimitTokenId !== null) rateLimiter.release(activeRateLimitTokenId);
      logRequest({
        ts: new Date().toISOString(),
        tokenId,
        model,
        inputTokens,
        outputTokens,
        costUsd,
        status,
        ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
        ms: Date.now() - startedAt,
        requestBody,
        responseBody: responseBodyForLog,
      });
    };

    // 1. Verify the bearer token
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

    // 2. Rate limit
    const rl = rateLimiter.check(tokenRecord.id);
    if (!rl.allowed) {
      c.header("Retry-After", String(rl.retryAfterSeconds));
      finish(429);
      return c.json(errorBody("rate_limit_error", "rate limit exceeded"), 429);
    }
    activeRateLimitTokenId = tokenRecord.id;

    // Parse body
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
    // Validate the submitted tree before a pinned system prompt can replace a
    // deep client value. Otherwise logBodies could later stringify the raw
    // request and overflow the JavaScript stack even though the forwarded
    // payload is shallow.
    if (isRequestNestingTooDeep(parsedBody)) {
      finish(400);
      return c.json(
        errorBody(
          "invalid_request_error",
          `request nesting is too deep (maximum ${MAX_REQUEST_NESTING_DEPTH} levels)`,
        ),
        400,
      );
    }
    // 3. Check the model allow list
    const requestedModel = parsedBody.model;
    if (typeof requestedModel !== "string" || !Object.hasOwn(config.models, requestedModel)) {
      finish(403);
      return c.json(errorBody("permission_error", "model is not in the allow list"), 403);
    }
    model = requestedModel;
    const pricing = config.models[requestedModel];
    if (!pricing) {
      // Already confirmed to exist via Object.hasOwn, but TypeScript can't
      // narrow through that, so this stays as a defensive check.
      finish(403);
      return c.json(errorBody("permission_error", "model is not in the allow list"), 403);
    }

    // max_tokens must be a positive integer
    const maxTokens = parsedBody.max_tokens;
    if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
      finish(400);
      return c.json(errorBody("invalid_request_error", "max_tokens must be a positive integer"), 400);
    }

    const restriction = findRequestRestriction(parsedBody);
    if (restriction === "too_deep") {
      finish(400);
      return c.json(
        errorBody(
          "invalid_request_error",
          `request nesting is too deep (maximum ${MAX_REQUEST_NESTING_DEPTH} levels)`,
        ),
        400,
      );
    }
    if (restriction === "unsupported_feature") {
      finish(400);
      return c.json(
        errorBody(
          "invalid_request_error",
          "tools, prompt caching, multimodal content, unknown request fields, and provider-managed features are not supported because their charges are not represented by this gateway's price table",
        ),
        400,
      );
    }

    const shapeError = validateMessagesShape(parsedBody);
    if (shapeError !== null) {
      finish(400);
      return c.json(errorBody("invalid_request_error", shapeError), 400);
    }

    // Bedrock upstream: streaming is not implemented yet (eventstream -> SSE
    // transcoding is a ROADMAP "Later" item). Reject here - same body
    // validation stage as max_tokens above - so this fails BEFORE the budget
    // precheck and BEFORE any upstream call: no budget is consumed for a
    // request that was never going to be forwarded.
    if (config.upstream.type === "bedrock" && parsedBody.stream === true) {
      finish(400);
      return c.json(
        errorBody(
          "invalid_request_error",
          'streaming is not yet supported with upstream.type "bedrock" - set "stream": false (see ROADMAP.md)',
        ),
        400,
      );
    }

    // 4. Force-replace system when pinnedSystemPrompt is configured
    const payload: Record<string, unknown> = { ...parsedBody };
    if (config.pinnedSystemPrompt !== null) {
      payload.system = config.pinnedSystemPrompt;
    }
    const effectiveSystem = typeof payload.system === "string" ? payload.system : undefined;

    if (estimateRequestTokens(payload) > MAX_ACCOUNTABLE_REQUEST_BYTES) {
      finish(400);
      return c.json(
        errorBody(
          "invalid_request_error",
          `request is too large for the configured flat price table (maximum ${MAX_ACCOUNTABLE_REQUEST_BYTES} UTF-8 bytes)`,
        ),
        400,
      );
    }
    // Defer body logging until size/depth validation succeeds: JSON.stringify
    // is used by logRequest when logBodies is enabled and must never receive a
    // deliberately stack-overflowing request tree.
    requestBody = parsedBody;

    // 5. Atomically reserve the worst-case budget before any upstream I/O.
    // Reservations are persisted and included in usage while an upstream call
    // (especially an SSE stream) is in flight, so concurrent requests cannot
    // all observe the same remaining balance and overrun the cap.
    const worstCost = estimateWorstCost({
      request: payload,
      messages: parsedBody.messages,
      system: effectiveSystem,
      maxTokens,
      pricing,
    });
    if (!Number.isFinite(worstCost) || worstCost <= 0 || worstCost > MAX_USD_AMOUNT) {
      finish(400);
      return c.json(
        errorBody("invalid_request_error", "the request's estimated worst-case cost exceeds the accounting safety range"),
        400,
      );
    }
    const budgetNow = new Date();
    const todayKey = dateKeyUTC(budgetNow);
    const monthKey = monthKeyUTC(budgetNow);
    let reservation: ReserveUsageResult;
    try {
      reservation = await store.reserveUsage({
        tokenId: tokenRecord.id,
        dateKey: todayKey,
        monthKey,
        worstCostUsd: worstCost,
        tokenDailyUsd: tokenRecord.dailyUsd,
        globalMonthlyUsd: config.budget.monthlyUsd,
      });
    } catch {
      finish(503);
      return c.json(
        errorBody(
          "storage_unavailable_error",
          "internal storage is unavailable; requests are blocked until the operator restarts sekimori",
        ),
        503,
      );
    }
    if (!reservation.allowed) {
      const reason = reservation.reason;
      const message =
        reason === "monthly_limit" ? "monthly budget limit exceeded" : "daily budget limit exceeded for this token";
      // A-6: tell the caller machine-readably when they can retry. Daily ->
      // next UTC midnight, monthly -> the 1st of next month UTC.
      c.header("Retry-After", String(retryAfterSecondsForReason(reason, budgetNow)));
      finish(429);
      return c.json(errorBody("budget_exceeded_error", message), 429);
    }

    // Another in-flight request may have discovered that provider-reported
    // usage exceeded the conservative reservation while this request waited
    // for its atomic reservation. Do not send a new provider request after
    // that accounting circuit breaker has opened.
    if (!accountingHealthy) {
      costUsd = worstCost;
      try {
        await store.settleUsage(reservation.reservationId, worstCost);
      } catch {
        // Store health is handled by the same fail-closed middleware.
      }
      finish(503);
      return c.json(
        errorBody(
          "accounting_unavailable_error",
          "usage accounting became unsafe; requests are blocked until the operator restarts sekimori and verifies pricing",
        ),
        503,
      );
    }

    // 6. Forward upstream
    const isStreamRequested = payload.stream === true;
    let forwardResult;
    try {
      forwardResult = await forwardMessages(
        {
          baseUrl: config.upstream.baseUrl,
          apiKey: upstreamApiKey,
          type: config.upstream.type,
          timeoutMs: config.upstream.timeoutMs,
        },
        payload,
        isStreamRequested,
      );
    } catch (err) {
      // A network failure is ambiguous: the provider may have received and
      // billed the request even though no response reached us. Keep the
      // persisted worst-case reservation rather than releasing spend on an
      // uncertain outcome.
      costUsd = worstCost;
      try {
        // The debit is already present. Settling to the identical amount only
        // removes the now-finished reservation record, so restart compaction
        // cannot retain it forever.
        await store.settleUsage(reservation.reservationId, worstCost);
      } catch {
        // A persist failure makes the store unhealthy and blocks later calls.
      }
      finish(502);
      if (err instanceof UpstreamResponseTooLargeError) {
        return c.json(
          errorBody("upstream_error", "upstream response exceeded the gateway safety limit"),
          502,
        );
      }
      return c.json(errorBody("upstream_error", "failed to reach upstream"), 502);
    }

    const recordCost = async (status: number, usage: ExtractedUsage | null): Promise<boolean> => {
      // An upstream status alone cannot prove that a provider did not begin a
      // billable execution (for example, Bedrock can return 424 after a model
      // processing error). Preserve the worst-case reservation for every
      // non-success response. A future release may add a narrowly documented
      // provider-specific no-charge allowlist, but ambiguity fails closed.
      const succeeded = status >= 200 && status < 300;
      const cost = succeeded
        ? usage
          ? computeActualCost({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, pricing)
          : worstCost
        : worstCost;
      const accountingTolerance = Math.max(1e-12, worstCost * 1e-9);
      const reservationExceeded = succeeded && usage !== null && cost > worstCost + accountingTolerance;
      if (reservationExceeded) {
        accountingHealthy = false;
        console.error("[sekimori] accounting invariant violated (provider usage exceeded the reserved worst-case cost)");
      }
      inputTokens = succeeded ? (usage?.inputTokens ?? null) : null;
      outputTokens = succeeded ? (usage?.outputTokens ?? null) : null;
      costUsd = cost;
      try {
        await store.settleUsage(reservation.reservationId, cost);
      } catch {
        // fail-closed: the reservation remains in the persisted state and
        // store.isHealthy() goes false, so subsequent requests get 503.
      }
      return reservationExceeded;
    };

    if (forwardResult.status < 200 || forwardResult.status >= 300) {
      upstreamStatus = forwardResult.status;
      responseBodyForLog = forwardResult.bodyText;
      await recordCost(forwardResult.status, null);
      finish(502);
      return c.json(errorBody("upstream_error", "the upstream provider rejected the request"), 502);
    }

    if (forwardResult.isStream && forwardResult.stream) {
      const headers = new Headers();
      headers.set("content-type", forwardResult.contentType ?? "text/event-stream");
      headers.set("cache-control", "no-cache, no-store, no-transform");
      const status = forwardResult.status;
      c.header("Cache-Control", "no-cache, no-store, no-transform");
      // Relay SSE unmodified while accounting finishes in the background.
      // usagePromise is designed to resolve null on every unsafe path, but the
      // terminal catch is deliberate defense against future parser changes.
      void forwardResult.usagePromise
        .then((usage) => recordCost(status, usage))
        .catch(() => recordCost(status, null))
        .finally(() => finish(status));
      return new Response(forwardResult.stream, { status, headers });
    }

    const usage = await forwardResult.usagePromise;
    const reservationExceeded = await recordCost(forwardResult.status, usage);
    responseBodyForLog = forwardResult.bodyText;
    if (reservationExceeded) {
      finish(503);
      return c.json(
        errorBody(
          "accounting_unavailable_error",
          "provider usage exceeded the reserved worst case; requests are blocked until the operator verifies pricing",
        ),
        503,
      );
    }
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
    const todayUsd = await store.getUsageForDate(tokenRecord.id, todayKey);
    return c.json({
      todayUsd,
      dailyLimitUsd: tokenRecord.dailyUsd,
    });
  });

  function requireAdmin(authorizationHeader: string | undefined | null): boolean {
    const bearer = extractBearer(authorizationHeader);
    if (!bearer) return false;
    return safeEqual(bearer, adminKey);
  }

  app.post("/admin/tokens", adminBodyLimit, async (c) => {
    if (!requireAdmin(c.req.header("Authorization"))) {
      return c.json(errorBody("authentication_error", "invalid admin key"), 401);
    }
    let body: unknown;
    try {
      // An empty body means "use configured defaults" regardless of whether a
      // client happened to send Content-Type: application/json.
      const rawBody = await c.req.text();
      body = rawBody.length === 0 ? {} : JSON.parse(rawBody);
    } catch {
      return c.json(errorBody("invalid_request_error", "request body must be valid JSON"), 400);
    }
    if (!isRecord(body)) return c.json(errorBody("invalid_request_error", "request body must be a JSON object"), 400);
    const record = body;
    const unknownFields = Object.keys(record).filter((key) => key !== "name" && key !== "dailyUsd");
    if (unknownFields.length > 0) {
      return c.json(
        errorBody("invalid_request_error", `unknown admin token field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.sort().join(", ")}`),
        400,
      );
    }
    if (record.name !== undefined && (typeof record.name !== "string" || record.name.length > 256)) {
      return c.json(errorBody("invalid_request_error", "name must be a string of at most 256 characters"), 400);
    }
    const name = record.name;
    if (
      record.dailyUsd !== undefined &&
      (typeof record.dailyUsd !== "number" ||
        !Number.isFinite(record.dailyUsd) ||
        record.dailyUsd <= 0 ||
        record.dailyUsd > MAX_USD_AMOUNT)
    ) {
      return c.json(
        errorBody("invalid_request_error", `dailyUsd must be a positive finite number no greater than ${MAX_USD_AMOUNT}`),
        400,
      );
    }
    const dailyUsd = record.dailyUsd ?? config.budget.defaultDailyPerTokenUsd;

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
    const now = new Date();
    const monthKey = monthKeyUTC(now);
    const todayKey = dateKeyUTC(now);
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

  app.notFound((c) => c.json(errorBody("not_found_error", "route not found"), 404));

  return app;
}
