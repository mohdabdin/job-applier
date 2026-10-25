// lib/llm.js against a fake fetch: request shape per provider, usage → cost, retries, shape checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { structured, cost, price } from "../extension/lib/llm.js";
import { obj, str, oneOf } from "../extension/lib/schema.js";

const schema = obj({ fit: oneOf(["strong", "poor"]), why: str() });

function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const [status, json] = responses.shift();
    return { ok: status < 400, status, statusText: "x", json: async () => json };
  };
  return { fn, calls };
}

test("gemini: schema, system, file parts, thoughts skipped, cost", async () => {
  const { fn, calls } = fakeFetch([200, {
    candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: '{"fit":"strong","why":"ok"}' }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50, cachedContentTokenCount: 200 },
  }]);
  const r = await structured({ provider: "gemini", apiKey: "k" }, "fill", { system: "sys", prompt: "p", schema, files: [{ mimeType: "application/pdf", data: "QQ==" }] }, { fetchImpl: fn });
  assert.deepEqual(r.data, { fit: "strong", why: "ok" });
  assert.equal(r.model, "gemini-3.8-flash");
  assert.deepEqual(r.usage, { input: 800, cached: 200, output: 150 });
  assert.equal(calls[0].init.headers["x-goog-api-key"], "k");
  assert.match(calls[0].url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.deepEqual(calls[0].body.generationConfig.responseJsonSchema, schema);
  assert.equal(calls[0].body.contents[0].parts[0].inlineData.mimeType, "application/pdf");
  assert.equal(calls[0].body.systemInstruction.parts[0].text, "sys");
  assert.ok(Math.abs(r.cost_usd - cost("gemini-3.8-flash", r.usage)) < 1e-12);
});

test("anthropic: direct-browser header, output_config format, document blocks, model override", async () => {
  const { fn, calls } = fakeFetch([200, { content: [{ type: "text", text: '{"fit":"poor","why":"no"}' }], stop_reason: "end_turn",
    usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }]);
  const r = await structured({ provider: "anthropic", apiKey: "k", models: { strong: "claude-opus-5-5" } }, "cv",
    { prompt: "p", schema, files: [{ mimeType: "application/pdf", data: "QQ==" }] }, { fetchImpl: fn });
  assert.equal(r.model, "claude-opus-5-5");
  const h = calls[0].init.headers;
  assert.equal(h["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(h["x-api-key"], "k");
  assert.deepEqual(calls[0].body.output_config, { effort: "medium", format: { type: "json_schema", schema } });
  assert.equal(calls[0].body.messages[0].content[0].type, "document");
  assert.equal(calls[0].body.system, undefined);
});

test("retries overloads, not bad keys; checks the answer's shape", async () => {
  const ok = [200, { content: [{ type: "text", text: '{"fit":"poor","why":"x"}' }], stop_reason: "end_turn", usage: {} }];
  const a = fakeFetch([529, { error: { message: "overloaded" } }], ok);
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (f) => orig(f, 0); // no real backoff in tests
  try {
    assert.equal((await structured({ provider: "anthropic", apiKey: "k" }, "fill", { prompt: "p", schema }, { fetchImpl: a.fn })).data.fit, "poor");
    assert.equal(a.calls.length, 2);
    const b = fakeFetch([401, { error: { message: "invalid x-api-key" } }]);
    await assert.rejects(structured({ provider: "anthropic", apiKey: "k" }, "fill", { prompt: "p", schema }, { fetchImpl: b.fn }), /API key was rejected/);
    assert.equal(b.calls.length, 1);
    const c = fakeFetch([200, { content: [{ type: "text", text: '{"fit":"meh","why":"x"}' }], stop_reason: "end_turn", usage: {} }]);
    await assert.rejects(structured({ provider: "anthropic", apiKey: "k" }, "fill", { prompt: "p", schema }, { fetchImpl: c.fn }), /expected shape/);
    await assert.rejects(structured({ provider: "anthropic", apiKey: "" }, "fill", { prompt: "p", schema }), /no API key/);
  } finally {
    globalThis.setTimeout = orig;
  }
});

test("introductory prices end on their date", () => {
  assert.deepEqual(price("gemini-4-argon", "2026-11-30"), [2.0, 10.0, 0.1]);
  assert.deepEqual(price("gemini-4-argon", "2026-12-01"), [4.0, 20.0, 0.2]);
});
