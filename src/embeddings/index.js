import { config } from '../config.js';

// Lapisan embedding yang bisa di-swap.
//   provider=local   -> Xenova/all-MiniLM-L6-v2 (semantik, jalan lokal via WASM)
//   provider=hashing -> bag-of-words hashing (tanpa download, deterministik)
// Semua vektor dinormalisasi L2 agar dot-product == cosine similarity.

let _extractor = null;
let _warnedFallback = false;

async function getLocalExtractor() {
  if (_extractor) return _extractor;
  const { pipeline, env } = await import('@xenova/transformers');
  env.allowLocalModels = false; // ambil dari hub, cache otomatis
  _extractor = await pipeline('feature-extraction', config.embeddings.model);
  return _extractor;
}

const HASH_DIM = 384; // selaras EMBEDDING_DIM di db/index.js (Xenova/all-MiniLM-L6-v2)

function hashingEmbed(text) {
  const vec = new Float32Array(HASH_DIM);
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % HASH_DIM;
    vec[idx] += 1;
  }
  return normalize([...vec]);
}

function normalize(arr) {
  let norm = 0;
  for (const x of arr) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return arr.map((x) => x / norm);
}

/** Embed satu teks → number[] (L2-normalized). */
export async function embed(text) {
  const provider = config.embeddings.provider;
  if (provider === 'hashing') return hashingEmbed(text);
  try {
    const extractor = await getLocalExtractor();
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (err) {
    if (!_warnedFallback) {
      _warnedFallback = true;
      console.warn(
        `[embeddings] gagal memuat model lokal (${err.message}). Beralih ke fallback 'hashing'.`,
      );
    }
    return hashingEmbed(text);
  }
}

export async function embedMany(texts) {
  const out = [];
  for (const t of texts) out.push(await embed(t));
  return out;
}

export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
