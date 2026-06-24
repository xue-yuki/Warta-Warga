import { chat } from '../llm/openrouter.js';
import { hasLLM } from '../config.js';
import { search } from '../kb/vectorStore.js';
import { latestTanggal, masaBerlakuNotice } from '../util/tanggal.js';

const MIN_SCORE = 0.25; // ambang relevansi minimum

const SYSTEM = `Kamu "Warta Warga", teman warga yang bantu info bantuan sosial lewat chat WhatsApp.

GAYA BICARA (penting):
- Ngobrol santai & hangat seperti tetangga yang ramah, BUKAN dokumen resmi.
- Singkat dan to the point — 2-4 kalimat untuk hal sederhana. Pakai "kamu", bukan "Anda".
- Hindari heading tebal, poin bernomor kaku, atau bahasa birokrasi. Boleh emoji secukupnya (jangan lebay).
- Kalau perlu menyebut beberapa syarat, tulis mengalir atau bullet "•" singkat — jangan seperti formulir.

ATURAN ISI (keras):
- Jawab HANYA dari KONTEKS sumber resmi yang diberikan. Dilarang menebak/menambah fakta.
- SELALU akhiri dengan baris sumber: "Sumber: <url>".
- Untuk kelayakan pribadi ("apakah saya dapat?"): bilang ini tergantung data DTKS, sarankan cek sendiri di cekbansos.kemensos.go.id atau tanya RT/pengurus. Jangan memvonis pasti dapat/tidak.
- Kalau konteks tidak menjawab, jujur bilang belum punya infonya dari sumber resmi.`;

// Follow-up yang "nempel ke konteks": pakai kata ganti atau sangat pendek → perlu di-resolve
// dulu pakai riwayat sebelum dicari (kalau tidak, pencarian jadi buta konteks).
function needsContext(question) {
  const q = String(question).toLowerCase();
  if (/\b(itu|ini|nya|tsb|tersebut|td|tadi|yg td|yang tadi|gimana|tadi)\b/.test(q)) return true;
  return q.trim().split(/\s+/).length <= 4; // pertanyaan singkat: "syaratnya?", "jadwalnya kapan?"
}

/**
 * Ubah pertanyaan lanjutan menjadi kueri pencarian MANDIRI memakai riwayat obrolan.
 * Mis. history menyebut BANPIN, lalu "itu syaratnya apa" → "syarat program BANPIN".
 * Tanpa LLM / tanpa history / pertanyaan sudah jelas → kembalikan apa adanya.
 */
export async function standaloneQuery(question, history) {
  if (!hasLLM() || !history?.length || !needsContext(question)) return question;
  try {
    const convo = history
      .slice(-6)
      .map((h) => `${h.role === 'user' ? 'Warga' : 'Bot'}: ${h.content}`)
      .join('\n');
    const out = await chat({
      tier: 'fast',
      temperature: 0,
      maxTokens: 50,
      messages: [
        {
          role: 'system',
          content:
            'Ubah pertanyaan lanjutan warga menjadi SATU kalimat kueri pencarian yang berdiri sendiri untuk mencari info bansos. ' +
            'Ganti kata ganti ("itu", "ini", "nya", "tersebut") dengan nama program/topik yang dimaksud dari percakapan. ' +
            'Jawab HANYA kueri singkatnya, tanpa tanda kutip, tanpa penjelasan.',
        },
        { role: 'user', content: `Percakapan:\n${convo}\n\nPertanyaan lanjutan: "${question}"\n\nKueri mandiri:` },
      ],
    });
    const q = String(out || '').trim().replace(/^["']|["']$/g, '');
    return q.length >= 3 ? q : question;
  } catch {
    return question; // gagal rewrite → pakai pertanyaan asli (aman)
  }
}

/**
 * Jawab pertanyaan info via RAG.
 * @returns {Promise<{text:string, sources:string[], grounded:boolean}>}
 */
export async function answerInfo(question, { scopeTags = null, history = [] } = {}) {
  // Retrieval pakai kueri yang SUDAH sadar konteks; jawaban tetap memakai pertanyaan asli + history.
  const searchQuery = await standaloneQuery(question, history);
  const hits = (await search(searchQuery, { scopeTags, k: 4 })).filter((h) => h.score >= MIN_SCORE);

  if (hits.length === 0) {
    // 5.4.3: tidak ada dokumen relevan → jangan menebak.
    return {
      grounded: false,
      sources: [],
      text:
        'Maaf, saya belum punya info ini dari sumber resmi yang terkurasi. ' +
        'Untuk memastikan, silakan cek di cekbansos.kemensos.go.id atau tanyakan ke RT/pengurus setempat.',
    };
  }

  const sources = [...new Set(hits.map((h) => h.sumber_url))];
  const updated = latestTanggal(hits); // tanggal_ambil terbaru → ditampilkan ke user
  // Peringatan masa berlaku: batas daftar lewat / data basi (ambil yang pertama relevan).
  const notice = hits.map((h) => masaBerlakuNotice(h)).find(Boolean) || null;
  const context = hits
    .map((h, i) => `[${i + 1}] (sumber: ${h.sumber_url})\n${h.content}`)
    .join('\n\n');

  if (!hasLLM()) {
    // Mode tanpa LLM (sengaja): sajikan info teratas dengan rapi.
    return { grounded: true, sources, updated, text: withMeta(prettyChunk(hits[0].content), sources, updated, notice) };
  }

  try {
    const text = await chat({
      tier: 'fast',
      temperature: 0.2,
      maxTokens: 500, // jawaban warga singkat (2-4 kalimat) — hemat token & sesuai gaya WA
      messages: [
        { role: 'system', content: SYSTEM },
        ...history,
        { role: 'user', content: `KONTEKS:\n${context}\n\nPERTANYAAN WARGA:\n${question}` },
      ],
    });
    return { grounded: true, sources, updated, text: withMeta(text, sources, updated, notice) };
  } catch (err) {
    // LLM gagal walau sudah retry (mis. rate-limit parah). Jangan dump mentah — beri info rapi + tetap jujur.
    return {
      grounded: true,
      sources,
      updated,
      text: withMeta(prettyChunk(hits[0].content), sources, updated, notice),
    };
  }
}

/** Rapikan isi chunk untuk fallback: buang baris meta "Wilayah: ...". */
function prettyChunk(content) {
  return String(content)
    .split('\n')
    .filter((l) => !/^wilayah\s*:/i.test(l.trim()))
    .join('\n')
    .trim();
}

/** Pastikan ada baris sumber + tanggal update info + peringatan masa berlaku di akhir jawaban. */
export function withMeta(text, sources, updated, notice = null) {
  // Buang baris "(Info diperbarui ...)" bila LLM terlanjur meniru dari riwayat → cegah dobel.
  let out = text
    .split('\n')
    .filter((line) => !/info diperbarui/i.test(line))
    .join('\n')
    .trim();
  if (!/sumber\s*:/i.test(out)) out += `\n\nSumber: ${sources.join(', ')}`;
  if (updated) out += `\n_(Info diperbarui: ${updated})_`;
  if (notice) out += `\n${notice}`;
  return out;
}
