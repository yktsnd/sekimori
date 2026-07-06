#!/usr/bin/env node
// mock-upstream.mjs — オフラインデモ用の擬似 Anthropic Messages API サーバー(依存ゼロ)。
//
// 実際の Anthropic API キーがなくても sekimori のクイックスタートを試せるようにするための
// 最小限のスタブ。`POST /v1/messages` のみをサポートし、リクエストの `stream` フィールドに
// 応じて非ストリーム JSON か SSE を返す。
//
// 使い方: node examples/mock-upstream.mjs [port=9999]

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.PORT ?? 9999);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk.toString("utf8")));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/messages") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found_error", message: "mock upstream only implements POST /v1/messages" } }));
    return;
  }

  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "invalid JSON body" } }));
    return;
  }

  const lastUserMessage = Array.isArray(payload.messages)
    ? [...payload.messages].reverse().find((m) => m.role === "user")
    : undefined;
  const userText =
    typeof lastUserMessage?.content === "string"
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage?.content ?? "");
  const replyText = `[mock-upstream] echo: ${userText.slice(0, 200)}`;

  const inputTokens = estimateTokens(raw);
  const outputTokens = estimateTokens(replyText);

  if (payload.stream === true) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send("message_start", {
      type: "message_start",
      message: {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: payload.model,
        content: [],
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

    // 数チャンクに分けて少しずつ配信し、本物のストリーミングらしさを出す。
    const words = replyText.split(" ");
    for (const word of words) {
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${word} ` } });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } });
    send("message_stop", { type: "message_stop" });
    res.end();
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: payload.model,
      content: [{ type: "text", text: replyText }],
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
  );
});

server.listen(port, () => {
  console.log(`[mock-upstream] listening on http://localhost:${port} (Anthropic Messages API stub)`);
});
