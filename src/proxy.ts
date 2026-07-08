// proxy.ts - forwarding to the upstream (Anthropic Messages API, or Amazon
// Bedrock's InvokeModel endpoint) and usage extraction
//
// - Client headers are never passed through as-is; the server builds
//   x-api-key / anthropic-version / content-type itself (section 6), or for
//   Bedrock, Authorization: Bearer + content-type only.
// - Non-streaming responses are returned as JSON, unmodified.
// - Streaming responses relay the raw SSE bytes unmodified while a duplicate
//   is parsed line-by-line to extract usage. Bedrock has no streaming path
//   here - app.ts rejects "stream": true against a bedrock upstream before
//   any of this module is reached (fail-closed, no budget consumed).
// - The two upstream types are handled by entirely separate functions below
//   (forwardToAnthropic / forwardToBedrock) so the anthropic path is
//   byte-for-byte unchanged by the bedrock addition.

export interface UpstreamTarget {
  baseUrl: string;
  apiKey: string;
  type: "anthropic" | "bedrock";
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
  const res = await fetch(`${upstream.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": upstream.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const contentType = res.headers.get("content-type");
  const isEventStream = !!contentType && contentType.includes("text/event-stream");

  if (isStreamRequested && isEventStream && res.body) {
    const [clientStream, parseStream] = res.body.tee();
    const usagePromise = extractUsageFromSSE(parseStream);
    return { status: res.status, contentType, isStream: true, stream: clientStream, usagePromise };
  }

  const bodyText = await res.text();
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
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${upstream.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(transformed),
  });

  const contentType = res.headers.get("content-type");
  const bodyText = await res.text();
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
        typeof (usage as Record<string, unknown>).input_tokens === "number" &&
        typeof (usage as Record<string, unknown>).output_tokens === "number"
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

/**
 * Parses an SSE stream line by line and assembles usage from the
 * `message_start` input_tokens and the last `message_delta` output_tokens.
 */
async function extractUsageFromSSE(stream: ReadableStream<Uint8Array>): Promise<ExtractedUsage | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const jsonStr = line.slice("data:".length).trim();
    if (!jsonStr || jsonStr === "[DONE]") return;
    let evt: unknown;
    try {
      evt = JSON.parse(jsonStr);
    } catch {
      return;
    }
    if (!evt || typeof evt !== "object") return;
    const obj = evt as Record<string, unknown>;

    if (obj.type === "message_start") {
      const message = obj.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.input_tokens === "number") {
        inputTokens = usage.input_tokens;
      }
      if (usage && typeof usage.output_tokens === "number") {
        outputTokens = usage.output_tokens;
      }
    } else if (obj.type === "message_delta") {
      const usage = obj.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.output_tokens === "number") {
        outputTokens = usage.output_tokens;
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    }
    if (buffer.length > 0) handleLine(buffer);
  } catch {
    // Give up on read errors here. usage stays null, and the caller falls
    // back to charging worstCost (fail-closed).
  }

  if (inputTokens === undefined || outputTokens === undefined) return null;
  return { inputTokens, outputTokens };
}
