import { config } from "../config.js";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function clean(value) {
  return String(value || "").trim();
}

function endpointFromBaseUrl(baseUrl) {
  const base = clean(baseUrl).replace(/\/+$/, "");
  if (!base) return "";
  return base.includes("/chat/completions") ? base : `${base}/chat/completions`;
}

function captchaPrompts() {
  return {
    system:
      process.env.VISION_PROMPT_SYSTEM ||
      process.env.CAPTCHA_PROMPT_SYSTEM ||
      "You are an OCR assistant. Extract only the characters in the captcha image. Reply with the captcha text only, no explanation, no punctuation, no extra words.",
    user:
      process.env.VISION_PROMPT_USER ||
      process.env.CAPTCHA_PROMPT_USER ||
      "Read the captcha text in this image. Reply with ONLY the captcha text, nothing else. No spaces, no punctuation.",
  };
}

function buildCaptchaProviders() {
  const mode = clean(process.env.CAPTCHA_SOLVER_PROVIDER || "auto").toLowerCase();
  const providers = [];

  const gemini = {
    name: "gemini",
    baseUrl: clean(process.env.CAPTCHA_GEMINI_BASE_URL || process.env.VISION_BASE_URL || config.vision.baseUrl || DEFAULT_GEMINI_BASE_URL),
    apiKey: clean(process.env.CAPTCHA_GEMINI_API_KEY || process.env.VISION_API_KEY || process.env.VISION_API || config.vision.apiKey),
    model: clean(process.env.CAPTCHA_GEMINI_MODEL || process.env.VISION_MODEL || config.vision.model || "gemini-flash-lite-latest"),
    headers: {},
  };

  if (gemini.apiKey && gemini.model) providers.push(gemini);

  const openrouter = {
    name: "openrouter",
    baseUrl: clean(process.env.CAPTCHA_OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL || config.openrouter.baseUrl || DEFAULT_OPENROUTER_BASE_URL),
    apiKey: clean(process.env.CAPTCHA_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || config.openrouter.apiKey),
    model: clean(process.env.CAPTCHA_OPENROUTER_MODEL || process.env.OPENROUTER_VISION_MODEL),
    headers: {
      "HTTP-Referer": config.openrouter.appUrl,
      "X-Title": config.openrouter.appName,
    },
  };

  if (openrouter.apiKey && openrouter.model) providers.push(openrouter);

  if (mode === "gemini" || mode === "openrouter") {
    return providers.filter((provider) => provider.name === mode);
  }

  return providers;
}

export function getCaptchaSolverProviders() {
  return buildCaptchaProviders().map((provider) => ({
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    configured: Boolean(provider.apiKey && provider.model && provider.baseUrl),
  }));
}

function parseCaptchaText(raw) {
  const text = clean(raw).replace(/```/g, "").replace(/\s+/g, " ").trim();
  if (!text) {
    throw new Error("Captcha solver returned empty text");
  }

  const matches = text.match(/[A-Za-z0-9]+/g);
  if (!matches) {
    throw new Error("Captcha solver returned no alphanumeric characters");
  }

  return matches.join("").slice(0, 20);
}

async function solveWithProvider(provider, buffer, mimetype) {
  const endpoint = endpointFromBaseUrl(provider.baseUrl);
  if (!endpoint || !provider.apiKey || !provider.model) {
    throw new Error(`${provider.name} captcha provider is incomplete`);
  }

  const temperature = Number(process.env.CAPTCHA_TEMPERATURE ?? process.env.VISION_TEMPERATURE ?? "0");
  const maxTokens = Number(process.env.CAPTCHA_MAX_TOKENS ?? process.env.VISION_MAX_TOKENS ?? "20");
  const prompts = captchaPrompts();

  const body = {
    model: provider.model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: prompts.system },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimetype};base64,${buffer.toString("base64")}` } },
          { type: "text", text: prompts.user },
        ],
      },
    ],
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`${provider.name} vision ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = (data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "").trim();
  return parseCaptchaText(raw);
}

export async function solveCaptchaImage(buffer, mimetype = "image/png") {
  if (!buffer?.length) {
    throw new Error("Captcha image is empty");
  }

  const providers = buildCaptchaProviders();
  if (!providers.length) {
    throw new Error(
      "Captcha OCR is not configured. Set VISION_API_KEY for Gemini, or set OPENROUTER_API_KEY plus CAPTCHA_OPENROUTER_MODEL for OpenRouter.",
    );
  }

  const errors = [];
  for (const provider of providers) {
    try {
      return await solveWithProvider(provider, buffer, mimetype);
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  throw new Error(`Captcha OCR failed with all configured providers: ${errors.join(" | ")}`);
}
