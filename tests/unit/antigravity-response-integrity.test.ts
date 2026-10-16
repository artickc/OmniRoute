import test from "node:test";
import assert from "node:assert/strict";

const { processAntigravitySSEPayload } =
  await import("../../open-sse/executors/antigravity/sseCollect.ts");
const { parseSSEToGeminiResponse } =
  await import("../../open-sse/handlers/sseParser/geminiResponse.ts");
const { sanitizeOpenAIResponse, sanitizeStreamingChunk } =
  await import("../../open-sse/handlers/responseSanitizer.ts");
const { __test_applyAntigravityGenerationDefaults, MAX_ANTIGRAVITY_OUTPUT_TOKENS } =
  await import("../../open-sse/executors/antigravity.ts");
const { takeRequestToolIdentityMap } =
  await import("../../open-sse/handlers/chatCore/passthroughToolNames.ts");
const { translateNonStreamingResponse } =
  await import("../../open-sse/handlers/responseTranslator.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

type GenerationConfig = { maxOutputTokens: number; thinkingConfig: { thinkingBudget: number } };

// Gemini signs the first visible part after thinking; `thought: true` marks reasoning.
const SIGNED_TEXT_FRAME = JSON.stringify({
  response: {
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: "Let x be the ball..." },
            { text: "The ball costs 5 cents.", thoughtSignature: "c2lnbmF0dXJl" },
            { text: "", thoughtSignature: "c2lnbmF0dXJl" },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 115,
      candidatesTokenCount: 7,
      thoughtsTokenCount: 260,
      totalTokenCount: 382,
    },
  },
});

function newCollected() {
  return {
    textContent: "",
    finishReason: "stop",
    toolCalls: [],
    usage: null,
    remainingCredits: null,
  };
}

test("non-stream collector keeps signed visible text and drops only thoughts", () => {
  const collected = newCollected();
  processAntigravitySSEPayload(SIGNED_TEXT_FRAME, collected);
  assert.equal(collected.textContent, "The ball costs 5 cents.");
});

test("non-stream collector counts thinking tokens as completion tokens", () => {
  const collected = newCollected();
  processAntigravitySSEPayload(SIGNED_TEXT_FRAME, collected);
  assert.equal(collected.usage.completion_tokens, 267);
  assert.equal(collected.usage.total_tokens, 382);
  assert.deepEqual(collected.usage.completion_tokens_details, { reasoning_tokens: 260 });
});

test("buffered Gemini SSE keeps signed visible text and reports thinking usage", () => {
  const result = parseSSEToGeminiResponse(
    `data: ${SIGNED_TEXT_FRAME}\n\n`,
    "gemini-3.8-flash-high"
  );
  assert.ok(result);
  assert.equal(result.choices[0].message.content, "The ball costs 5 cents.");
  assert.equal(result.usage.completion_tokens, 267);
});

test("an empty signature-only part is not content", () => {
  const frame = JSON.stringify({
    response: { candidates: [{ content: { parts: [{ text: "", thoughtSignature: "x" }] } }] },
  });
  assert.equal(parseSSEToGeminiResponse(`data: ${frame}\n\n`, "m"), null);
});

function sanitizeContent(content: string) {
  const sanitized = sanitizeOpenAIResponse({
    id: "chatcmpl_t",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.00042 },
  }) as { choices: Array<{ message: { content: string } }>; usage: Record<string, unknown> };
  return sanitized;
}

test("URL query params containing `to=` survive sanitizing", () => {
  const content = "Image: https://cdn.example.com/x?photo=abc123&u=1 and https://a.b/?to=home";
  assert.equal(sanitizeContent(content).choices[0].message.content, content);
});

test("a later unbalanced brace never truncates a reply after a `to=` lookalike", () => {
  const content = "See ?photo=abc123&u=1 for the picture.\nThen call f({ with care.";
  assert.equal(sanitizeContent(content).choices[0].message.content, content);
});

test("plain prose `to=word` without a JSON payload is left alone", () => {
  const content = "Set the redirect to=home in the config file.";
  assert.equal(sanitizeContent(content).choices[0].message.content, content);
});

test("leaked to=functions envelopes are still stripped", () => {
  const content =
    'Checking.\n\nto=functions.run_in_terminal  tokenjson\n{"command":"pwd"}\n\nDone.';
  assert.equal(sanitizeContent(content).choices[0].message.content, "Checking.\n\nDone.");
});

test("emoji ZWJ sequences survive while obfuscating zero-width joiners are stripped", () => {
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  const heartOnFire = "❤️‍\u{1F525}";
  const technologist = "\u{1F469}\u{1F3FD}‍\u{1F4BB}";
  const out = sanitizeContent(`Hi ${family} ${heartOnFire} ${technologist} o‍pencode`).choices[0]
    .message.content;
  assert.equal(out, `Hi ${family} ${heartOnFire} ${technologist} opencode`);
});

test("a ZWJ split across streamed deltas next to an emoji is kept", () => {
  const first = sanitizeStreamingChunk({
    choices: [{ index: 0, delta: { content: "family \u{1F468}‍" } }],
  }) as { choices: Array<{ delta: { content: string } }> };
  const second = sanitizeStreamingChunk({
    choices: [{ index: 0, delta: { content: "‍\u{1F467} done" } }],
  }) as { choices: Array<{ delta: { content: string } }> };
  assert.equal(first.choices[0].delta.content, "family \u{1F468}‍");
  assert.equal(second.choices[0].delta.content, "‍\u{1F467} done");
});

test("usage.cost from the upstream is preserved", () => {
  assert.equal(sanitizeContent("ok").usage.cost, 0.00042);
});

test("a thinking budget above the output cap leaves room for the answer", () => {
  const request: Record<string, unknown> = {
    generationConfig: { maxOutputTokens: 40, thinkingConfig: { thinkingBudget: 24576 } },
  };
  __test_applyAntigravityGenerationDefaults(request);
  const gc = request.generationConfig as GenerationConfig;
  assert.equal(gc.maxOutputTokens, MAX_ANTIGRAVITY_OUTPUT_TOKENS);
  assert.ok(gc.thinkingConfig.thinkingBudget > 0);
  assert.ok(gc.maxOutputTokens - gc.thinkingConfig.thinkingBudget >= 1024);
});

test("a thinking budget that already fits is left unchanged", () => {
  const request: Record<string, unknown> = {
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 4096 } },
  };
  __test_applyAntigravityGenerationDefaults(request);
  const gc = request.generationConfig as GenerationConfig;
  assert.equal(gc.maxOutputTokens, 8192);
  assert.equal(gc.thinkingConfig.thinkingBudget, 4096);
});

test("sanitized-name maps stay on the request; namespace identity maps are taken", () => {
  const nameMapBody: Record<string, unknown> = {
    _toolNameMap: new Map([["weather_lookup_v2", "weather.lookup-v2"]]),
  };
  assert.equal(takeRequestToolIdentityMap(nameMapBody), null);
  assert.ok(nameMapBody._toolNameMap instanceof Map);

  const identity = new Map([["read", { namespace: "fs", name: "read" }]]);
  const identityBody: Record<string, unknown> = { _toolNameMap: identity };
  assert.equal(takeRequestToolIdentityMap(identityBody), identity);
  assert.equal(identityBody._toolNameMap, undefined);
});

test("non-stream OpenAI-shaped Gemini results get the client's tool names back", () => {
  const body = {
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "weather_lookup_v2", arguments: '{"city":"Paris"}' },
            },
          ],
        },
      },
    ],
  };
  const out = translateNonStreamingResponse(
    body,
    FORMATS.ANTIGRAVITY,
    FORMATS.OPENAI,
    new Map([["weather_lookup_v2", "weather.lookup-v2"]])
  ) as typeof body;
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "weather.lookup-v2");
});
