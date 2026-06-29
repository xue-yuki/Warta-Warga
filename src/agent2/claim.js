import { chatJson } from '../llm/openrouter.js';
import { hasLLM } from '../config.js';
import { search } from '../kb/vectorStore.js';
import { latestTanggal } from '../util/tanggal.js';

// Sistem 3-Label (Bagian 5.5 PRD).
//   verified   ✅ cocok dengan sumber resmi
//   unverified ⚠️ tidak ditemukan di sumber terkurasi
//   contradict ❌ berlawanan dengan sumber resmi
// ATURAN KERAS: ketidakhadiran di sumber = unverified, BUKAN contradict.

const MIN_SCORE = 0.25;

export const LABELS = {
  verified: { emoji: '✅', judul: 'Terverifikasi' },
  unverified: { emoji: '⚠️', judul: 'Belum bisa dipastikan' },
  contradict: { emoji: '❌', judul: 'Bertentangan dengan sumber resmi' },
};

const SYSTEM = `Kamu memverifikasi KLAIM warga dengan membandingkannya ke KONTEKS dari sumber resmi.
 
TUGAS: keluarkan SATU label + alasan singkat.
 
LABEL:
- "verified"    : klaim DIDUKUNG secara eksplisit oleh konteks sumber resmi.
- "contradict"  : konteks sumber resmi SECARA EKSPLISIT menyatakan kebalikan dari klaim.
- "unverified"  : klaim tidak ditemukan / tidak cukup bukti di konteks.
 
ATURAN KERAS:
- Kalau informasi klaim tidak ada di konteks → WAJIB "unverified", BUKAN "contradict".
- JANGAN mencap hoaks pada bantuan yang mungkin asli hanya karena tidak ada di konteks.
- JANGAN menambah fakta di luar konteks yang diberikan.
- "alasan" → bahasa santai seperti tetangga, 1-2 kalimat, pakai "kamu", tanpa bahasa kaku.
- "versi_benar" → isi kalau ada koreksi dari konteks, null kalau tidak ada.
 
Output WAJIB JSON valid:
{"label":"verified|unverified|contradict","alasan":"string","versi_benar":"string|null"}`;

const UNVERIFIED_FALLBACK = {
  label: 'unverified',
  alasan:
    'Klaim ini belum bisa dipastikan dari sumber resmi terkurasi. Jangan transfer uang atau memberi data pribadi dulu — konfirmasikan ke RT/instansi terkait.',
};

function normalizeFactText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/rp\s*200[.\s]*000|200\s*ribu|rp\s*200\s*ribu/g, 'rp200000')
    .replace(/kartu keluarga sejahtera/g, 'kks');
}

function deterministicVerified(claim, context) {
  const q = normalizeFactText(claim);
  const c = normalizeFactText(context);

  // BPNT/Sembako facts are short and explicit in the official chunk. Verify only when
  // the user's claim and the source context both contain the core facts together.
  const asksBpnt =
    /\b(bpnt|sembako|bantuan pangan|e-?warong|kks)\b/i.test(q) &&
    q.includes('rp200000') &&
    /e-?warong/i.test(q) &&
    q.includes('kks');
  const sourceSupportsBpnt =
    /\b(bpnt|sembako|bantuan pangan)\b/i.test(c) &&
    c.includes('rp200000') &&
    /e-?warong/i.test(c) &&
    c.includes('kks');

  if (asksBpnt && sourceSupportsBpnt) {
    return 'BPNT/Sembako adalah bantuan senilai Rp200.000 per bulan lewat KKS untuk belanja bahan pangan di e-warong.';
  }
  return null;
}

/**
 * Periksa sebuah klaim → satu label + alasan + sumber.
 * @returns {Promise<{label:string, emoji:string, judul:string, alasan:string, sources:string[], text:string}>}
 */
export async function checkClaim(claim, { scopeTags = null, history = [] } = {}) {
  const hits = (await search(claim, { scopeTags, k: 4 })).filter((h) => h.score >= MIN_SCORE);

  // Tidak ada bukti sama sekali → ⚠️ (aturan keras).
  if (hits.length === 0) return format(UNVERIFIED_FALLBACK, []);

  const sources = [...new Set(hits.map((h) => h.sumber_url))];
  const updated = latestTanggal(hits);
  const context = hits.map((h, i) => `[${i + 1}] (sumber: ${h.sumber_url})\n${h.content}`).join('\n\n');
  const deterministic = deterministicVerified(claim, context);
  if (deterministic) {
    return format(
      {
        label: 'verified',
        alasan: 'Klaim ini cocok dengan info bansos resmi yang ada di sumber terkurasi.',
      },
      sources,
      deterministic,
      updated,
    );
  }

  if (!hasLLM()) {
    // Tanpa LLM tidak boleh menebak contradiction → konservatif ⚠️ tapi sajikan info terkait.
    return format(
      {
        label: 'unverified',
        alasan:
          'Ada info terkait di sumber resmi, namun verifikasi otomatis perlu LLM. Mohon cek info berikut & konfirmasi ke pengurus.',
      },
      sources,
      hits[0].content,
      updated,
    );
  }

  let r;
  try {
    r = await chatJson({
      tier: 'deep',
      temperature: 0,
      maxTokens: 400, // label + alasan singkat + versi_benar
      messages: [
        { role: 'system', content: SYSTEM },
        ...history,
        { role: 'user', content: `KONTEKS:\n${context}\n\nKLAIM WARGA:\n${claim}` },
      ],
    });
  } catch {
    // LLM gagal (mis. rate-limit) → ⚠️ tanpa melampirkan sumber acak yang belum tentu relevan.
    return format(UNVERIFIED_FALLBACK, []);
  }

  if (!r || !LABELS[r.label]) return format(UNVERIFIED_FALLBACK, []);
  // unverified tetap tampil tanpa mengklaim bersumber pasti
  const showSources = r.label === 'unverified' ? [] : sources;
  return format(r, showSources, r.versi_benar, showSources.length ? updated : null);
}

function format({ label, alasan }, sources, extra, updated) {
  const meta = LABELS[label];
  let text = `${meta.emoji} *${meta.judul}*\n\n${alasan}`;
  if (extra) text += `\n\nInfo dari sumber resmi:\n${extra}`;
  if (sources.length) text += `\n\nSumber: ${sources.join(', ')}`;
  if (updated) text += `\n_(Info diperbarui: ${updated})_`;
  return { label, emoji: meta.emoji, judul: meta.judul, alasan, sources, text };
}
