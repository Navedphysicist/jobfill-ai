// src/ai/client.js
export class BadResponseError extends Error {
  constructor(message) {
    super(`The model returned something unusable: ${message}`);
    this.name = "BadResponseError";
  }
}

export class TruncatedResponseError extends Error {
  constructor() {
    super(
      "The model's reply was cut off because it hit the output limit - " +
      "try filling fewer fields at once."
    );
    this.name = "TruncatedResponseError";
    this.truncated = true;
  }
}

const MAX_DETAIL_CHARS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_ID_RE = /^(?:req|request|trace)[_-]/i;

// Strip anything shaped like a credential before text leaves this module.
// Identifier shapes (UUIDs, req_/request_/trace ids) are kept: users need them
// to quote to provider support.
export function redactSecrets(text, apiKey) {
  let out = String(text);
  if (apiKey && String(apiKey).length >= 4) out = out.split(String(apiKey)).join("[redacted]");
  return out
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{3,}/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, (m) =>
      UUID_RE.test(m) || TRACE_ID_RE.test(m) ? m : "[redacted]");
}

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseAnswers(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  if (!cleaned) throw new BadResponseError("the response was empty");

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new BadResponseError(`it was not valid JSON (${e.message})`);
  }

  if (!parsed || !Array.isArray(parsed.answers)) {
    throw new BadResponseError('it had no "answers" array');
  }
  return { answers: parsed.answers };
}

function backoffDelay(attempt) {
  const expo = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(expo * (0.5 + Math.random() * 0.5));
}

// Only the reasoning families accept reasoning_effort; others 400 on it.
export function supportsReasoning(model) {
  return /^(gpt-5|o[1-9])/i.test(String(model || ""));
}

export async function callModel({
  settings, model, messages, jsonMode, maxTokens, reasoningEffort,
  fetchImpl = (...a) => fetch(...a), sleepImpl = realSleep
}) {
  const body = { model, messages };
  if (jsonMode) body.response_format = { type: "json_object" };
  if (maxTokens) body.max_completion_tokens = maxTokens;
  if (reasoningEffort && supportsReasoning(model)) body.reasoning_effort = reasoningEffort;

  const url = `${String(settings.baseUrl).replace(/\/$/, "")}/chat/completions`;
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      let data;
      try {
        data = await res.json();
      } catch {
        throw new BadResponseError(`the server returned ${res.status} but the body was not JSON`);
      }
      if (data.choices?.[0]?.finish_reason === "length") {
        throw new TruncatedResponseError();
      }
      const u = data.usage || {};
      return {
        content: data.choices?.[0]?.message?.content || "",
        usage: {
          promptTokens: u.prompt_tokens || 0,
          cachedTokens: u.prompt_tokens_details?.cached_tokens || 0,
          completionTokens: u.completion_tokens || 0,
          // Invisible, but billed and counted against max_completion_tokens.
          reasoningTokens: u.completion_tokens_details?.reasoning_tokens || 0
        }
      };
    }

    const detail = redactSecrets(await res.text().catch(() => ""), settings.apiKey).slice(0, MAX_DETAIL_CHARS);
    lastError = new Error(`API ${res.status}: ${detail}`);
    if (!RETRY_STATUS.has(res.status)) throw lastError;
    if (attempt < MAX_ATTEMPTS - 1) await sleepImpl(backoffDelay(attempt));
  }

  throw lastError;
}
