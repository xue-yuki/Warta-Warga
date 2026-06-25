import { allChunks, insertChunk } from '../db/index.js';
import { embed, embedMany, cosine } from '../embeddings/index.js';
import { infoMatchesScope } from '../util/wilayah.js';

/** Pecah teks panjang jadi chunk ~maxChars dengan sedikit overlap. */
export function chunkText(text, maxChars = 700, overlap = 120) {
  const clean = String(text).replace(/\r/g, '').trim();
  if (clean.length <= maxChars) return [clean];
  const paras = clean.split(/\n\s*\n/);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > maxChars && buf) {
      chunks.push(buf.trim());
      buf = buf.slice(-overlap) + '\n\n' + p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

/** Bentuk teks yang kaya konteks dari satu entri info_bansos untuk diembed. */
export function infoToDocument(info) {
  const syarat = Array.isArray(info.syarat) ? info.syarat : [];
  return [
    `Program: ${info.program}`,
    `Ringkasan: ${info.ringkasan}`,
    syarat.length ? `Syarat: ${syarat.map((s) => `- ${s}`).join('\n')}` : '',
    info.tanggal_penting ? `Tanggal penting: ${info.tanggal_penting}` : '',
    info.cara_daftar ? `Cara daftar: ${info.cara_daftar}` : '',
    `Wilayah: ${info.wilayah_tag}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Embed sebuah entri info_bansos dan simpan chunk-nya ke vector store. */
export async function indexInfo(infoId, info) {
  const doc = infoToDocument(info);
  const chunks = chunkText(doc);
  const vectors = await embedMany(chunks);
  for (let i = 0; i < chunks.length; i++) {
    await insertChunk({
      info_id: infoId,
      program: info.program,
      content: chunks[i],
      embedding: vectors[i],
      sumber_url: info.sumber_url,
      wilayah_tag: info.wilayah_tag,
      tanggal_ambil: info.tanggal_ambil,
      batas_daftar: info.batas_daftar || null,
    });
  }
  return chunks.length;
}

const tokenize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

/** Bonus leksikal: warga sering mengetik nama/akronim program (PKH, BPNT, PIP). */
function lexicalBonus(qTokens, chunk) {
  if (qTokens.length === 0) return 0;
  const hay = new Set(tokenize(`${chunk.program} ${chunk.content}`));
  let hit = 0;
  for (const t of qTokens) if (hay.has(t)) hit++;
  return hit / qTokens.length; // 0..1
}

const LEX_WEIGHT = 0.4;

/**
 * Cari top-k chunk relevan (hybrid: embedding semantik + bonus leksikal).
 * @param {string} query
 * @param {object} [opts]
 * @param {string[]|null} [opts.scopeTags] bila diisi, hanya chunk yang cocok wilayah grup
 * @param {number} [opts.k]
 */
export async function search(query, { scopeTags = null, k = 4 } = {}) {
  const chunks = await allChunks();
  if (chunks.length === 0) return [];
  const qVec = await embed(query);
  const qTokens = tokenize(query);

  let candidates = chunks;
  if (scopeTags) candidates = chunks.filter((c) => infoMatchesScope(c.wilayah_tag, scopeTags));
  // Bila filter wilayah mengosongkan hasil, mundur ke seluruh chunk (lebih baik info nasional)
  if (candidates.length === 0) candidates = chunks;

  return candidates
    .map((c) => {
      // Dimensi beda (mis. data lama dari provider embedding lain) → cosine tak sahih, abaikan semantik.
      const sem = c.embedding.length === qVec.length ? cosine(qVec, c.embedding) : 0;
      const lex = lexicalBonus(qTokens, c);
      return { ...c, sem, lex, score: sem + LEX_WEIGHT * lex };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
