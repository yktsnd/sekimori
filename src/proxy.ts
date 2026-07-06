// proxy.ts — 上流（Anthropic Messages API）への転送と usage 抽出
//
// - ヘッダはクライアントのものを素通ししない。サーバー側で x-api-key / anthropic-version /
//   content-type を構築する（§6）。
// - 非ストリームは JSON をそのまま返す。
// - ストリームは SSE バイト列を無加工で中継しつつ、複製を行単位でパースして usage を抽出する。

export interface UpstreamTarget {
  baseUrl: string;
  apiKey: string;
}

export interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ForwardResult {
  status: number;
  contentType: string | null;
  isStream: boolean;
  /** 非ストリーム時のみ設定。上流のレスポンスボディをそのまま返すための生テキスト。 */
  bodyText?: string;
  /** ストリーム時のみ設定。クライアントへ無加工で中継するための ReadableStream。 */
  stream?: ReadableStream<Uint8Array>;
  /** usage 抽出の結果。取得できなかった場合は null（呼び出し側は worstCost を代わりに計上する）。 */
  usagePromise: Promise<ExtractedUsage | null>;
}

const ANTHROPIC_VERSION = "2023-06-01";

/** 上流の Anthropic Messages API へ転送する。 */
export async function forwardMessages(
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
    // JSON として読めない場合は usage なしとして扱う（worstCost が計上される）。
  }
  return null;
}

/**
 * SSE ストリームを行単位でパースし、`message_start` の input_tokens と
 * 最後の `message_delta` の output_tokens から usage を組み立てる。
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
    // 読み取り中のエラーはここで諦める。usage は null のまま返し、
    // 呼び出し側が worstCost を代わりに計上する（fail-closed）。
  }

  if (inputTokens === undefined || outputTokens === undefined) return null;
  return { inputTokens, outputTokens };
}
