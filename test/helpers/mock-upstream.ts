// mock-upstream.ts — テスト用の擬似 Anthropic Messages API サーバー（node:http）。
// 実 API キー不要でテストをオフライン実行するためのモック。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface MockUpstream {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

export async function startMockUpstream(handler: MockHandler): Promise<MockUpstream> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** 非ストリームの正常応答（usage 込み）を返すモック。 */
export function jsonMessagesHandler(opts: { inputTokens: number; outputTokens: number; text?: string }): MockHandler {
  return (req, res) => {
    void readBody(req).then(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: opts.text ?? "hello" }],
          model: "test-model",
          stop_reason: "end_turn",
          usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
        }),
      );
    });
  };
}

/** usage フィールドを欠落させた（壊れた）非ストリーム応答を返すモック。 */
export function jsonMessagesHandlerWithoutUsage(opts: { text?: string } = {}): MockHandler {
  return (req, res) => {
    void readBody(req).then(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: opts.text ?? "hello" }],
          model: "test-model",
          stop_reason: "end_turn",
          // usage フィールドなし
        }),
      );
    });
  };
}

/** リクエストボディを capture に格納しつつ、通常の JSON 応答を返すモック。 */
export function capturingJsonMessagesHandler(
  capture: { body?: unknown },
  opts: { inputTokens: number; outputTokens: number },
): MockHandler {
  return (req, res) => {
    void readBody(req).then((raw) => {
      capture.body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          model: "test-model",
          stop_reason: "end_turn",
          usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
        }),
      );
    });
  };
}

interface SseEvent {
  event: string;
  data: unknown;
}

function buildSseEvents(opts: { inputTokens: number; outputTokens: number }): SseEvent[] {
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_stream",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [],
          usage: { input_tokens: opts.inputTokens, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: opts.outputTokens } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

/** SSE の完全なテキスト（テストの期待値比較用）。 */
export function buildSseBody(opts: { inputTokens: number; outputTokens: number }): string {
  return buildSseEvents(opts)
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
}

/** ストリーム応答（SSE）を返すモック。 */
export function sseMessagesHandler(opts: { inputTokens: number; outputTokens: number }): MockHandler {
  return (req, res) => {
    void readBody(req).then(() => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.end(buildSseBody(opts));
    });
  };
}
