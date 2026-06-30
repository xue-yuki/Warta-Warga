import { config } from "../config.js";

export async function solveCaptchaImage(buffer, mimetype = "image/png") {
  if (!buffer?.length) {
    throw new Error("Captcha image is empty");
  }

  const hasVisionKey = Boolean((process.env.CAPTCHA_SOLVER_API_KEY || process.env.VISION_API_KEY || process.env.VISION_API || "").trim());
  const baseUrl = (
    process.env.CAPTCHA_SOLVER_BASE_URL ||
    process.env.VISION_BASE_URL ||
    process.env.LLM_BASE_URL ||
    process.env.OPENROUTER_BASE_URL ||
    (hasVisionKey ? config.vision.baseUrl : config.openrouter.baseUrl) ||
    ""
  ).trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("CAPTCHA_SOLVER_BASE_URL, VISION_BASE_URL, or LLM_BASE_URL must be set in the environment");
  }

  const endpoint = baseUrl.includes("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  const apiKey = (
    process.env.CAPTCHA_SOLVER_API_KEY ||
    process.env.VISION_API_KEY ||
    process.env.VISION_API ||
    process.env.LLM_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    config.vision.apiKey ||
    config.openrouter.apiKey ||
    ""
  ).trim();
  if (!apiKey) {
    throw new Error("CAPTCHA_SOLVER_API_KEY, VISION_API_KEY, LLM_API_KEY, or OPENROUTER_API_KEY must be set in the environment");
  }

  let model = (process.env.CAPTCHA_SOLVER_MODEL || process.env.VISION_MODEL || process.env.LLM_MODEL || (hasVisionKey ? config.vision.model : config.openrouter.fastModel) || "").trim();
  if (/openrouter\.ai/i.test(baseUrl) && /^gpt-/i.test(model)) {
    model = `openai/${model}`;
  }
  if (/generativelanguage\.googleapis\.com/i.test(baseUrl) && /^(?:openai\/)?gpt-/i.test(model)) {
    model = (process.env.VISION_MODEL || config.vision.model || "").trim();
  }
  if (!model) {
    throw new Error("CAPTCHA_SOLVER_MODEL, VISION_MODEL, or LLM_MODEL must be set in the environment");
  }

  const temperature = Number(process.env.VISION_TEMPERATURE ?? process.env.LLM_TEMPERATURE ?? "0");
  const maxTokens = Number(process.env.VISION_MAX_TOKENS ?? process.env.LLM_MAX_TOKENS ?? "20");
  const systemPrompt = process.env.VISION_PROMPT_SYSTEM || "You are an OCR assistant. Extract only the characters in the captcha image. Reply with the captcha text only, no explanation, no punctuation, no extra words.";
  const userPrompt = process.env.VISION_PROMPT_USER || "Read the captcha text in this image. Reply with ONLY the captcha text, nothing else. No spaces, no punctuation.";

  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimetype};base64,${buffer.toString("base64")}` } },
          { type: "text", text: userPrompt },
        ],
      },
    ],
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`vision ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = (data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "").trim();

  if (!raw) {
    throw new Error("Captcha solver returned empty text");
  }

  const cleaned = raw.replace(/```/g, "").replace(/\s+/g, " ").trim();

  const matches = cleaned.match(/[A-Za-z0-9]+/g);
  if (!matches) {
    throw new Error("Captcha solver returned no alphanumeric characters");
  }

  const text = matches.join("").slice(0, 20);
  return text;
}
