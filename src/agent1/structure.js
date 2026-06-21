import { chatJson } from '../llm/openrouter.js';
import { normalizeWilayahTag } from '../util/wilayah.js';

const SYSTEM = `Kamu adalah Verifikator Sumber untuk asisten info bansos di Indonesia.
Tugasmu: mengubah teks pengumuman birokrasi menjadi objek JSON terstruktur dalam bahasa Indonesia yang sangat sederhana (mudah dipahami warga awam).
ATURAN KERAS:
- Hanya gunakan informasi yang ADA di teks. JANGAN menambah/menebak fakta.
- Jika sebuah field tidak ada di teks, isi null (atau [] untuk syarat).
- Bahasa ringkasan: santun, singkat, tanpa istilah birokrasi.`;

function userPrompt(text, hintWilayah) {
  return `Strukturkan pengumuman berikut menjadi JSON dengan skema PERSIS ini:
{
  "program": string,                       // nama program bansos
  "ringkasan_bahasa_sederhana": string,    // 1-3 kalimat, bahasa awam
  "syarat": string[],                      // daftar syarat; [] jika tidak ada
  "tanggal_penting": string|null,          // tenggat/jadwal jika disebut
  "cara_daftar": string|null,              // langkah daftar jika disebut
  "wilayah_tag": string,                   // "nasional" | "provinsi:<x>" | "kabupaten:<x>"
  "valid": boolean                         // false jika teks bukan pengumuman bansos yang bisa distrukturkan
}
${hintWilayah ? `Petunjuk wilayah (pakai jika teks tidak menyebut wilayah lain): ${hintWilayah}\n` : ''}
TEKS:
"""
${text.slice(0, 6000)}
"""`;
}

/**
 * Strukturkan teks menjadi objek info bansos via LLM (model deep).
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
export async function structureContent(text, { hintWilayah, sumberUrl } = {}) {
  let parsed;
  try {
    parsed = await chatJson({
      tier: 'deep',
      temperature: 0.1,
      maxTokens: 700, // cukup untuk objek JSON (program, ringkasan, syarat[], dst)
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(text, hintWilayah) },
      ],
    });
  } catch (err) {
    return { ok: false, error: `LLM gagal: ${err.message}` };
  }

  if (!parsed || parsed.valid === false || !parsed.program) {
    // F1.4: jangan menebak isi — skip.
    return { ok: false, error: 'Konten tidak dapat distrukturkan sebagai info bansos.' };
  }

  const wilayah = normalizeWilayahTag(parsed.wilayah_tag || hintWilayah) || 'nasional';
  return {
    ok: true,
    data: {
      program: parsed.program,
      ringkasan: parsed.ringkasan_bahasa_sederhana || '',
      syarat: Array.isArray(parsed.syarat) ? parsed.syarat : [],
      tanggal_penting: parsed.tanggal_penting || null,
      cara_daftar: parsed.cara_daftar || null,
      wilayah_tag: wilayah,
      sumber_url: sumberUrl || null,
    },
  };
}
