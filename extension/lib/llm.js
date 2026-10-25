// One structured-output model call, straight from the extension to the provider, with the user's own key.
// No SDKs: plain fetch, so the same code runs in the side panel and under `node --test`.
// Extension pages with host permissions aren't subject to CORS; Anthropic also wants its direct-browser header.

import { check } from "./schema.js";

export const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    models: { fast: "gemini-3.8-flash", strong: "gemini-4-argon" },
  },
  anthropic: {
    label: "Anthropic Claude",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: { fast: "claude-haiku-5-5", strong: "claude-sonnet-5-5" },
  },
};

// Which tier and effort each job uses. Cheap and fast for the per-page calls; stronger where writing quality or
// strict checking matters.
export const ROLES = {
  fill: { tier: "fast", effort: "medium" },
  assess: { tier: "fast", effort: "medium" },
  searches: { tier: "fast", effort: "low" },
  memory: { tier: "fast", effort: "low" },
  profile: { tier: "strong", effort: "medium" },
  cv: { tier: "strong", effort: "medium" },
  fact_check: { tier: "strong", effort: "low" },
};

// $ per 1M tokens: input, output, cached input.
const PRICES = {
  "claude-opus-5-5": [4.0, 20.0, 0.2],
  "claude-sonnet-5-5": [2.0, 10.0, 0.2],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "gemini-4-argon": [4.0, 20.0, 0.2],
  "gemini-3.8-flash": [1.5, 7.5, 0.15],
};
// Introductory prices, until (exclusive) the date given.
const INTRO = {
  "gemini-4-argon": ["2026-12-01", [2.0, 10.0, 0.1]],
  "gemini-3.8-flash": ["2027-01-01", [0.75, 3.75, 0.075]],
};

export function price(model, today = new Date().toISOString().slice(0, 10)) {
  const intro = INTRO[model];
  if (intro && today < intro[0]) return intro[1];
  return PRICES[model] || PRICES["claude-opus-5-5"];
}

export function cost(model, usage) {
  const [i, o, c] = price(model);
  return (usage.input * i + usage.output * o + usage.cached * c) / 1e6;
}

export class LlmError extends Error {}

const GEMINI_MAX_OUTPUT = 32768;
const TIMEOUT_MS = 300_000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);

/**
 * settings: { provider, apiKey, models?: {fast, strong} }
 * role: a key of ROLES. schema: a strict JSON Schema (see schema.js).
 * files: [{ mimeType: "application/pdf", data: <base64> }] attached before the prompt.
 * Returns { data, model, usage, cost_usd }.
 */
export async function structured(settings, role, { system = "", prompt, schema, files = [] }, { fetchImpl = fetch } = {}) {
  const r = ROLES[role];
  if (!r) throw new LlmError(`unknown role ${role}`);
  const p = PROVIDERS[settings.provider];
  if (!p) throw new LlmError(`unknown provider ${settings.provider}`);
  if (!settings.apiKey) throw new LlmError("no API key set (Settings)");
  const model = settings.models?.[r.tier] || p.models[r.tier];
  const call = settings.provider === "gemini" ? gemini : anthropic;
  const { text, usage, stop } = await withRetries(() => call(fetchImpl, settings.apiKey, model, r.effort, system, prompt, schema, files));
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlmError(`${role}: the model's answer wasn't valid JSON (stop: ${stop})`);
  }
  try {
    check(schema, data);
  } catch (e) {
    throw new LlmError(`${role}: the model's answer didn't have the expected shape (${e.message})`);
  }
  return { data, model, usage, cost_usd: cost(model, usage) };
}

async function withRetries(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 2 || !(e.retry)) throw e;
      await new Promise((res) => setTimeout(res, 2000 * 3 ** attempt));
    }
  }
}

async function post(fetchImpl, url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    const err = new LlmError(e.name === "AbortError" ? "the model took too long to answer" : `can't reach the model provider (${e.message})`);
    err.retry = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json.error?.message || r.statusText;
    const err = new LlmError(r.status === 401 || r.status === 403 ? `the API key was rejected (${msg})` : `${r.status}: ${msg}`);
    err.retry = RETRY_STATUS.has(r.status);
    throw err;
  }
  return json;
}

const GEMINI_THINKING = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

async function gemini(fetchImpl, key, model, effort, system, prompt, schema, files) {
  const parts = [...files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } })), { text: prompt }];
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      maxOutputTokens: GEMINI_MAX_OUTPUT,
      thinkingConfig: { thinkingLevel: GEMINI_THINKING[effort] || "medium" },
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const json = await post(fetchImpl, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": key }, body);
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((x) => !x.thought && x.text).map((x) => x.text).join("");
  const m = json.usageMetadata || {};
  const cached = m.cachedContentTokenCount || 0;
  const usage = {
    input: Math.max((m.promptTokenCount || 0) + (m.toolUsePromptTokenCount || 0) - cached, 0),
    cached,
    output: (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0),
  };
  if (!text) throw new LlmError(`the model returned nothing (${cand?.finishReason || json.promptFeedback?.blockReason || "no candidate"})`);
  return { text, usage, stop: cand?.finishReason };
}

async function anthropic(fetchImpl, key, model, effort, system, prompt, schema, files) {
  const content = [
    ...files.map((f) => ({ type: "document", source: { type: "base64", media_type: f.mimeType, data: f.data } })),
    { type: "text", text: prompt },
  ];
  const body = {
    model,
    max_tokens: 16000,
    messages: [{ role: "user", content }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  if (system) body.system = system;
  const json = await post(fetchImpl, "https://api.anthropic.com/v1/messages", {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  }, body);
  const u = json.usage || {};
  const usage = {
    input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25,
    cached: u.cache_read_input_tokens || 0,
    output: u.output_tokens || 0,
  };
  if (json.stop_reason === "refusal") throw new LlmError("the model declined to answer");
  if (json.stop_reason === "max_tokens") throw new LlmError("the model's answer was cut off (too long)");
  const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text) throw new LlmError(`the model returned nothing (${json.stop_reason})`);
  return { text, usage, stop: json.stop_reason };
}
