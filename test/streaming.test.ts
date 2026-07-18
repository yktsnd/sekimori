// Design doc 8-4: streaming - SSE reaches the client unmodified, and usage is accounted

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, sseMessagesHandler, buildSseBody } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, getUsage, issueToken, messagesRequest, waitFor } from "./helpers/test-app.js";
import { createSseRelay, MAX_BUFFERED_SSE_LINE_BYTES } from "../src/proxy.js";

test("streaming: SSE bytes are relayed byte-for-byte and usage is accounted afterwards", async (t) => {
  const usageOpts = { inputTokens: 50, outputTokens: 20 };
  const upstream = await startMockUpstream(sseMessagesHandler(usageOpts));
  t.after(() => upstream.close());
  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1 } },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));
  const cacheControl = res.headers.get("cache-control") ?? "";
  for (const directive of ["no-cache", "no-store", "no-transform"]) assert.match(cacheControl, new RegExp(`\\b${directive}\\b`));

  const text = await res.text();
  assert.equal(text, buildSseBody(usageOpts), "SSE body must be relayed unmodified");

  const expectedCost = (usageOpts.inputTokens / 1_000_000) * 1 + (usageOpts.outputTokens / 1_000_000) * 1;
  await waitFor(async () => {
    const usage = await getUsage(app, issued.token);
    return Math.abs(usage.todayUsd - expectedCost) < 1e-9;
  });
});

test("streaming: an oversized unterminated event is relayed, while accounting safely retains the reservation", async (t) => {
  let upstreamCalls = 0;
  const body = `data: ${"x".repeat(MAX_BUFFERED_SSE_LINE_BYTES + 1)}`;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(body);
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1_000_000 } },
    budget: { monthlyUsd: 100, defaultDailyPerTokenUsd: 1.5 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 1.5 });
  const request = { model: "test-model", max_tokens: 1, stream: true, messages: [{ role: "user", content: "hi" }] };

  const first = await app.fetch(messagesRequest(issued.token, request));
  assert.equal(first.status, 200);
  assert.equal(await first.text(), body, "the client relay must stay byte-for-byte intact");

  await waitFor(async () => (await getUsage(app, issued.token)).todayUsd > 1);
  const second = await app.fetch(messagesRequest(issued.token, request));
  assert.equal(second.status, 429);
  assert.equal(upstreamCalls, 1);
});

test("streaming: a truncated stream cannot settle from message_start's initial output count", async (t) => {
  let upstreamCalls = 0;
  const truncatedBody = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 1, output_tokens: 0 } },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "partial" },
    })}\n\n`,
  ].join("");
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(truncatedBody); // no final message_delta or message_stop
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1_000_000 } },
    budget: { monthlyUsd: 100, defaultDailyPerTokenUsd: 1.5 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 1.5 });
  const request = { model: "test-model", max_tokens: 1, stream: true, messages: [{ role: "user", content: "hi" }] };

  const first = await app.fetch(messagesRequest(issued.token, request));
  assert.equal(first.status, 200);
  assert.equal(await first.text(), truncatedBody);
  await waitFor(async () => (await getUsage(app, issued.token)).todayUsd > 1);

  const second = await app.fetch(messagesRequest(issued.token, request));
  assert.equal(second.status, 429);
  assert.equal(upstreamCalls, 1);
});

test("streaming: one large transport chunk with many small lines remains accountable", async () => {
  const usageOpts = { inputTokens: 7, outputTokens: 9 };
  const padding = ": keepalive\n".repeat(Math.ceil(MAX_BUFFERED_SSE_LINE_BYTES / 5));
  const body = `${padding}${buildSseBody(usageOpts)}`;
  assert.ok(Buffer.byteLength(body) > MAX_BUFFERED_SSE_LINE_BYTES);

  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  const relay = createSseRelay(upstream);
  assert.equal(await new Response(relay.stream).text(), body);
  assert.deepEqual(await relay.usagePromise, usageOpts);
});

test("streaming: downstream cancellation cancels upstream and makes usage unsafe", async () => {
  let upstreamCancelled = false;
  const partial = new TextEncoder().encode(
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`,
  );
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(partial);
    },
    cancel() {
      upstreamCancelled = true;
      throw new Error("simulated cancel failure");
    },
  });
  const relay = createSseRelay(upstream);
  const reader = relay.stream.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel("client disconnected");

  assert.equal(upstreamCancelled, true);
  assert.equal(await relay.usagePromise, null);
});

test("streaming: impossible event order or decreasing cumulative usage fails accounting closed", async () => {
  const cases = [
    [
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "message_delta", usage: { output_tokens: 5 } },
      { type: "message_delta", usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ],
    [
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "message_delta", usage: { output_tokens: 1 } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "late" } },
      { type: "message_stop" },
    ],
    [
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { malformed: true },
      { type: "message_delta", usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
    [
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "message_delta", usage: { output_tokens: 5 } },
      { type: "message_stop" },
      { type: "ping" },
    ],
    [
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "error", error: { type: "overloaded_error" } },
    ],
  ];

  for (const events of cases) {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const relay = createSseRelay(upstream);
    assert.equal(await new Response(relay.stream).text(), body);
    assert.equal(await relay.usagePromise, null);
  }
});

test("streaming: an idle upstream is cancelled and usage remains conservative", async () => {
  let upstreamCancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    cancel() {
      upstreamCancelled = true;
      throw new Error("simulated idle cancel failure");
    },
  });
  const relay = createSseRelay(upstream, 25);
  const reader = relay.stream.getReader();

  await assert.rejects(() => reader.read(), /timed out/);
  assert.equal(await relay.usagePromise, null);
  assert.equal(upstreamCancelled, true);
});
