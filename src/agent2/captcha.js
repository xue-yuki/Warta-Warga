import { config, hasVision } from "../config.js";

export async function solveCaptchaImage(buffer, mimetype = "image/png") {
  if (!hasVision() || !buffer?.length) {
    throw new Error("Vision API not configured or captcha image is empty");
  }

  const visionBaseUrl = process.env.VISION_BASE_URL || process.env.LLM_BASE_URL || config.vision.baseUrl;
  const baseUrl = visionBaseUrl.replace(/\/+$/, "");
  const parsed = new URL(baseUrl);
  const endpoint = /(^|\.)groq\.com$/i.test(parsed.hostname) ? `${parsed.origin}${parsed.pathname.replace(/\/$/, "") === "/v1" ? "/openai/v1" : parsed.pathname}/chat/completions` : `${baseUrl}/chat/completions`;
  const prompt = `Baca teks captcha ini dan kembalikan hanya teksnya tanpa penjelasan:\n\n` + `data:${mimetype};base64,${buffer.toString("base64")}`;
  // Use a strict system + user message pair to encourage OCR-only responses
  const body = {
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    temperature: 0,
    max_tokens: 20,
    messages: [
      { role: "system", content: "You are an OCR assistant. Extract only the characters in the captcha image. Reply with the captcha text only, no explanation, no punctuation, no extra words." },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimetype};base64,${buffer.toString("base64")}` } },
          { type: "text", text: "Read the captcha text in this image. Reply with ONLY the captcha text, nothing else. No spaces, no punctuation." },
        ],
      },
    ],
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.vision.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`vision ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = (data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "").trim();

  // If model returned a long descriptive sentence, consider it a failure to trigger retry
  if (!raw || raw.length > 40) {
    throw new Error("Captcha solver returned unexpected/empty text");
  }

  // sanitize to alphanumerics only (captchas typically are alphanumeric)
  const matches = raw.match(/[A-Za-z0-9]+/g);
  if (!matches) {
    throw new Error("Captcha solver returned no alphanumeric characters");
  }

  const text = matches.join("");
  return text;
}
