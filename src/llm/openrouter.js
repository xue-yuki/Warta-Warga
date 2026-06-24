import { config, hasLLM } from '../config.js';

/**
 * Panggil chat completion via OpenRouter (OpenAI-compatible).
 * @param {object} opts
 * @param {'fast'|'deep'} [opts.tier] pilih model cepat atau dalam
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {boolean} [opts.json] minta output JSON object
 * @param {number} [opts.temperature]
 * @returns {Promise<string>} konten teks balasan
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RETRY = 3;

// Kirim 1 request chat-completion (dengan retry transien) → kembalikan message LLM utuh.
async function completion({ tier = 'fast', messages, json = false, tools = null, toolChoice = null, temperature = 0.2, maxTokens = 1024 }) {
  if (!hasLLM()) {
    throw new Error('OPENROUTER_API_KEY belum diset — LLM tidak tersedia.');
  }
  const model = tier === 'deep' ? config.openrouter.deepModel : config.openrouter.fastModel;
  const payload = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens, // batasi agar muat di kredit & lebih murah
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  });

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    let res;
    try {
      res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.openrouter.appUrl,
          'X-Title': config.openrouter.appName,
        },
        body: payload,
      });
    } catch (netErr) {
      // error jaringan → retry
      lastErr = netErr;
      if (attempt < MAX_RETRY) {
        await sleep(backoff(attempt));
        continue;
      }
      throw netErr;
    }

    if (res.ok) {
      const data = await res.json();
      return data?.choices?.[0]?.message ?? { content: '' };
    }

    const body = await res.text().catch(() => '');
    lastErr = new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
    // Hanya retry untuk error transien (rate-limit / server sibuk).
    if (RETRYABLE.has(res.status) && attempt < MAX_RETRY) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : backoff(attempt));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

/** Chat biasa → kembalikan konten teks. */
export async function chat(opts) {
  const msg = await completion(opts);
  return msg?.content ?? '';
}

/**
 * Chat dengan TOOLS (function calling) → kembalikan message LLM utuh ({content, tool_calls}).
 * Pemanggil menjalankan tool lalu memanggil lagi dengan hasilnya (agentic loop).
 */
export async function chatWithTools({ tier = 'deep', messages, tools, toolChoice = 'auto', temperature = 0.3, maxTokens = 900 }) {
  return completion({ tier, messages, tools, toolChoice, temperature, maxTokens });
}

/** Backoff eksponensial + jitter: ~0.8s, 2s, 4s. */
function backoff(attempt) {
  return Math.round((0.8 * 2 ** attempt + Math.random() * 0.4) * 1000);
}

/** Panggil LLM dan parse JSON dengan toleran (mengupas code fence bila ada). */
export async function chatJson(opts) {
  const msg = await completion({ ...opts, json: true });
  return parseJsonLoose(msg?.content ?? '');
}

export function parseJsonLoose(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // buang ```json ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // ambil objek/array pertama
    const m = s.match(/[{[][\s\S]*[}\]]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
