// proxy.ts - forwarding to the upstream (Anthropic Messages API, or Amazon
// Bedrock's InvokeModel endpoint) and usage extraction
//
// - Client headers are never passed through as-is; the server builds
//   x-api-key / anthropic-version / content-type itself (section 6), or for
//   Bedrock, Authorization: Bearer + content-type only.
// - Non-streaming responses are returned as JSON, unmodified.
// - Streaming responses use one backpressure-aware relay that parses each
//   byte chunk before enqueuing that same chunk. There is no tee with an
//   independently drained branch, so a slow client cannot create an unbounded
//   queue. Bedrock has no streaming path
//   here - app.ts rejects "stream": true against a bedrock upstream before
//   any of this module is reached (fail-closed, no budget consumed).
// - The two upstream types are handled by entirely separate functions below
//   (forwardToAnthropic / forwardToBedrock) so the anthropic path is
//   byte-for-byte unchanged by the bedrock addition.

export interface UpstreamTarget {
  baseUrl: string;
  apiKey: string;
  type: "anthropic" | "bedrock";
  /** Bounded wait for upstream response headers; response streams may continue after that. */
  timeoutMs: number;
}

export interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ForwardResult {
  status: number;
  contentType: string | null;
  isStream: boolean;
  /** Set only for non-streaming responses: the raw upstream response body text, returned as-is. */
  bodyText?: string;
  /** Set only for streaming responses: the ReadableStream relayed to the client unmodified. */
  stream?: ReadableStream<Uint8Array>;
  /** Result of usage extraction. null if it couldn't be determined (the caller falls back to worstCost). */
  usagePromise: Promise<ExtractedUsage | null>;
}

const ANTHROPIC_VERSION = "2023-06-01";
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * A non-streaming upstream response is buffered so it can be relayed without
 * changing its bytes. Bound that buffer independently of request size: an
 * unhealthy or malicious upstream must not be able to exhaust gateway memory.
 */
export const MAX_NON_STREAM_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * One unterminated SSE `data:` line must not turn accounting into an
 * unbounded string buffer. This applies per line, not per transport chunk:
 * one large chunk containing many small, valid events remains accountable.
 */
export const MAX_BUFFERED_SSE_LINE_BYTES = 256 * 1024;

export class UpstreamResponseTooLargeError extends Error {
  constructor() {
    super(`upstream response exceeds ${MAX_NON_STREAM_RESPONSE_BYTES} bytes`);
    this.name = "UpstreamResponseTooLargeError";
  }
}

/**
 * Bound the time spent waiting for upstream response headers. A request that
 * has not produced headers is ambiguous (it may have reached the provider),
 * so app.ts keeps the worst-case reservation after this throws. The timer is
 * cleared as soon as headers arrive, allowing legitimate SSE streams to run
 * without an arbitrary total-duration cutoff.
 */
async function fetchWithHeaderTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow an upstream redirect while holding a provider credential.
    // Fetch preserves non-standard credential headers such as x-api-key across
    // redirects, including cross-origin redirects. A compromised or mistaken
    // upstream URL must not be able to exfiltrate the key that way.
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("upstream redirects are refused");
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a non-streaming response with a strict in-memory bound. */
async function readResponseTextWithLimit(res: Response, timeoutMs: number): Promise<string> {
  const advertisedLength = res.headers.get("content-length");
  if (advertisedLength && /^\d+$/.test(advertisedLength) && Number(advertisedLength) > MAX_NON_STREAM_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamResponseTooLargeError();
  }
  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("upstream response body timed out");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("upstream response body timed out")), remainingMs);
      });
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await Promise.race([reader.read(), timedOut]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const { done, value } = result;
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_NON_STREAM_RESPONSE_BYTES) {
        await reader.cancel();
        throw new UpstreamResponseTooLargeError();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (err) {
    await reader.cancel(err).catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/** Forwards a request to the configured upstream. Dispatches by
 * `upstream.type`; the anthropic branch is the original, unmodified
 * implementation. */
export async function forwardMessages(
  upstream: UpstreamTarget,
  payload: unknown,
  isStreamRequested: boolean,
): Promise<ForwardResult> {
  if (upstream.type === "bedrock") {
    return forwardToBedrock(upstream, payload);
  }
  return forwardToAnthropic(upstream, payload, isStreamRequested);
}

/** Anthropic Messages API path - unchanged from before Bedrock support was added. */
async function forwardToAnthropic(
  upstream: UpstreamTarget,
  payload: unknown,
  isStreamRequested: boolean,
): Promise<ForwardResult> {
  const res = await fetchWithHeaderTimeout(`${upstream.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": upstream.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  }, upstream.timeoutMs);

  const contentType = res.headers.get("content-type");
  const isEventStream = !!contentType && contentType.toLowerCase().includes("text/event-stream");

  // Never attach a relay to an error response. The app normalizes every
  // provider error to a local 502; leaving an unconsumed SSE reader behind on
  // that path would leak the upstream connection.
  if (res.ok && isStreamRequested && isEventStream && res.body) {
    const relay = createSseRelay(res.body, upstream.timeoutMs);
    return { status: res.status, contentType, isStream: true, stream: relay.stream, usagePromise: relay.usagePromise };
  }

  const bodyText = await readResponseTextWithLimit(res, upstream.timeoutMs);
  const usage = res.ok ? extractUsageFromJson(bodyText) : null;
  return {
    status: res.status,
    contentType,
    isStream: false,
    bodyText,
    usagePromise: Promise.resolve(usage),
  };
}

/**
 * Amazon Bedrock InvokeModel path (issue #17). Non-streaming only - callers
 * must reject "stream": true before reaching this function (app.ts does,
 * fail-closed, before any budget is consumed).
 *
 * - URL: POST {baseUrl}/model/{encodeURIComponent(model)}/invoke
 * - Headers built server-side: Authorization: Bearer <apiKey>,
 *   content-type: application/json. No x-api-key, no anthropic-version
 *   header (Bedrock uses a body field for that instead - see below).
 * - Body transform, starting from `payload` (already past the pinned-system
 *   replacement in app.ts): delete `model` and `stream` (Bedrock takes the
 *   model from the URL and does not accept either field in the body), add
 *   `anthropic_version: "bedrock-2023-05-31"`. Everything else passes
 *   through untouched.
 * - Response: Bedrock returns Anthropic-shaped JSON for Claude, so the
 *   status/body are relayed as-is and usage is extracted with the exact
 *   same `extractUsageFromJson` the anthropic path uses.
 */
async function forwardToBedrock(upstream: UpstreamTarget, payload: unknown): Promise<ForwardResult> {
  const body = (payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const model = typeof body.model === "string" ? body.model : "";

  const transformed: Record<string, unknown> = { ...body };
  delete transformed.model;
  delete transformed.stream;
  transformed.anthropic_version = BEDROCK_ANTHROPIC_VERSION;

  const url = `${upstream.baseUrl}/model/${encodeURIComponent(model)}/invoke`;
  const res = await fetchWithHeaderTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${upstream.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(transformed),
  }, upstream.timeoutMs);

  const contentType = res.headers.get("content-type");
  const bodyText = await readResponseTextWithLimit(res, upstream.timeoutMs);
  const usage = res.ok ? extractUsageFromJson(bodyText) : null;
  return {
    status: res.status,
    contentType,
    isStream: false,
    bodyText,
    usagePromise: Promise.resolve(usage),
  };
}

function extractUsageFromJson(bodyText: string): ExtractedUsage | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && "usage" in parsed) {
      const usage = (parsed as { usage?: unknown }).usage;
      if (
        usage &&
        typeof usage === "object" &&
        isTokenCount((usage as Record<string, unknown>).input_tokens) &&
        isTokenCount((usage as Record<string, unknown>).output_tokens)
      ) {
        return {
          inputTokens: (usage as Record<string, number>).input_tokens,
          outputTokens: (usage as Record<string, number>).output_tokens,
        };
      }
    }
  } catch {
    // If the body isn't valid JSON, treat usage as unavailable (worstCost is charged instead).
  }
  return null;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

interface SseUsageParser {
  push(chunk: Uint8Array): void;
  finish(): ExtractedUsage | null;
  invalidate(): void;
}

/**
 * Incremental, bounded SSE usage parser. Usage is trustworthy only after a
 * natural EOF with all three critical events: message_start (input usage), a
 * final message_delta (output usage), and message_stop. A truncated stream,
 * malformed critical event, invalid UTF-8, or oversized line returns null so
 * the caller keeps the conservative reservation.
 */
function createSseUsageParser(): SseUsageParser {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let residual = "";
  let inputTokens: number | undefined;
  let finalOutputTokens: number | undefined;
  let sawMessageStop = false;
  let safe = true;

  const invalidate = (): void => {
    safe = false;
    residual = "";
  };

  const handleLine = (rawLine: string): void => {
    if (!safe) return;
    if (Buffer.byteLength(rawLine, "utf8") > MAX_BUFFERED_SSE_LINE_BYTES) {
      invalidate();
      return;
    }
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const jsonText = line.slice("data:".length).trim();
    if (!jsonText) return;
    if (jsonText === "[DONE]") {
      // Some compatible relays append this marker after message_stop. It does
      // not carry accounting data, so accept it only at the terminal boundary.
      if (!sawMessageStop) invalidate();
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(jsonText);
    } catch {
      invalidate();
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      invalidate();
      return;
    }
    const object = event as Record<string, unknown>;

    const eventType = object.type;
    if (
      typeof eventType !== "string" ||
      ![
        "ping",
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
        "error",
      ].includes(eventType)
    ) {
      invalidate();
      return;
    }
    if (sawMessageStop) {
      // message_stop is terminal. Any later JSON event makes the transcript
      // ambiguous, even if it happens to repeat otherwise-valid usage.
      invalidate();
      return;
    }
    if (eventType === "ping") return;
    if (inputTokens === undefined && eventType !== "message_start" && eventType !== "error") {
      invalidate();
      return;
    }
    if (finalOutputTokens !== undefined && eventType !== "message_stop") {
      // The Messages protocol's message_delta is the terminal cumulative
      // usage event. More content or another delta afterwards could make that
      // count an undercharge, so the transcript is no longer trustworthy.
      invalidate();
      return;
    }

    if (eventType === "message_start") {
      const message = object.message;
      const usage = message && typeof message === "object" && !Array.isArray(message)
        ? (message as Record<string, unknown>).usage
        : undefined;
      const input = usage && typeof usage === "object" && !Array.isArray(usage)
        ? (usage as Record<string, unknown>).input_tokens
        : undefined;
      if (inputTokens !== undefined || !isTokenCount(input)) {
        invalidate();
        return;
      }
      inputTokens = input;
    } else if (eventType === "message_delta") {
      if (inputTokens === undefined || sawMessageStop) {
        invalidate();
        return;
      }
      const usage = object.usage;
      const output = usage && typeof usage === "object" && !Array.isArray(usage)
        ? (usage as Record<string, unknown>).output_tokens
        : undefined;
      if (!isTokenCount(output)) {
        invalidate();
        return;
      }
      finalOutputTokens = output;
    } else if (eventType === "message_stop") {
      if (inputTokens === undefined || finalOutputTokens === undefined || sawMessageStop) {
        invalidate();
        return;
      }
      sawMessageStop = true;
    } else if (eventType === "error") {
      // A provider can emit an error inside an HTTP-200 SSE response. Treat it
      // as an unsafe/truncated completion and retain the conservative charge.
      invalidate();
    } else if (
      typeof eventType === "string" &&
      ["content_block_start", "content_block_delta", "content_block_stop"].includes(eventType) &&
      inputTokens === undefined
    ) {
      // Content cannot precede message_start in a valid Messages stream.
      invalidate();
    }
  };

  const consumeText = (text: string): void => {
    if (!safe || text.length === 0) return;
    let cursor = 0;
    for (;;) {
      const newlineIndex = text.indexOf("\n", cursor);
      if (newlineIndex < 0) {
        residual += text.slice(cursor);
        if (Buffer.byteLength(residual, "utf8") > MAX_BUFFERED_SSE_LINE_BYTES) invalidate();
        return;
      }
      const line = residual + text.slice(cursor, newlineIndex);
      residual = "";
      handleLine(line);
      if (!safe) return;
      cursor = newlineIndex + 1;
    }
  };

  return {
    push(chunk) {
      if (!safe) return;
      try {
        consumeText(decoder.decode(chunk, { stream: true }));
      } catch {
        invalidate();
      }
    },
    finish() {
      if (!safe) return null;
      try {
        consumeText(decoder.decode());
      } catch {
        invalidate();
      }
      if (safe && residual.length > 0) {
        const finalLine = residual;
        residual = "";
        handleLine(finalLine);
      }
      if (!safe || !sawMessageStop || inputTokens === undefined || finalOutputTokens === undefined) return null;
      return { inputTokens, outputTokens: finalOutputTokens };
    },
    invalidate,
  };
}

/**
 * Relays one upstream stream with downstream backpressure. The parser sees the
 * exact bytes that are enqueued, but never drains a separate tee branch. A
 * downstream cancellation cancels the provider body and resolves usage to
 * null, allowing the request reservation to settle at its worst-case amount.
 */
export function createSseRelay(upstreamStream: ReadableStream<Uint8Array>, idleTimeoutMs = 120_000): {
  stream: ReadableStream<Uint8Array>;
  usagePromise: Promise<ExtractedUsage | null>;
} {
  const reader = upstreamStream.getReader();
  const parser = createSseUsageParser();
  let resolveUsage: (usage: ExtractedUsage | null) => void = () => undefined;
  const usagePromise = new Promise<ExtractedUsage | null>((resolve) => {
    resolveUsage = resolve;
  });
  let finished = false;
  let released = false;
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let relayController: { error(reason?: unknown): void } | undefined;

  const settleUsage = (usage: ExtractedUsage | null): void => {
    if (finished) return;
    finished = true;
    resolveUsage(usage);
  };
  const releaseReader = (): void => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // A cancellation/read already owns cleanup; usage has still settled.
    }
  };
  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdleTimer = (): void => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      timedOut = true;
      parser.invalidate();
      settleUsage(null);
      void reader.cancel(new Error("upstream SSE stream timed out")).catch(() => undefined).finally(releaseReader);
      try {
        relayController?.error(new Error("upstream SSE stream timed out"));
      } catch {
        // A simultaneous downstream cancellation may already own the stream.
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      relayController = controller;
      armIdleTimer();
    },
    async pull(controller) {
      if (timedOut) return;
      try {
        const { done, value } = await reader.read();
        if (timedOut) return;
        if (done) {
          clearIdleTimer();
          settleUsage(parser.finish());
          releaseReader();
          controller.close();
          return;
        }
        parser.push(value);
        controller.enqueue(value);
        armIdleTimer();
      } catch (err) {
        clearIdleTimer();
        if (timedOut) return;
        parser.invalidate();
        settleUsage(null);
        await reader.cancel(err).catch(() => undefined);
        releaseReader();
        controller.error(err);
      }
    },
    async cancel(reason) {
      clearIdleTimer();
      parser.invalidate();
      settleUsage(null);
      await reader.cancel(reason).catch(() => undefined);
      releaseReader();
    },
  });

  return { stream, usagePromise };
}
