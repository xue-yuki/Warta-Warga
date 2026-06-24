// Vision (gambar→teks): warga sering ngirim poster/screenshot/struk penipuan. Modul ini cuma "membaca"
// gambar jadi TEKS (OCR + deskripsi netral); penilaian penipuan tetap dikerjakan brain agentic (yang
// bisa cek_url, verifikasi, catat_laporan). Model vision terpisah (default Gemini Flash, OpenAI-compat).

import { config, hasVision } from '../config.js';

const SYSTEM = `Kamu pembaca gambar untuk bot anti-penipuan "Warta Warga". Tugasmu HANYA melaporkan ISI
gambar apa adanya — JANGAN menyimpulkan apakah ini penipuan (itu tugas sistem lain).
Laporkan dalam Bahasa Indonesia, ringkas & terstruktur:
- TEKS (OCR): tuliskan semua tulisan yang terlihat, apa adanya.
- LINK/URL, nomor rekening, nomor HP/WA, atau kode (mis. OTP, kode referral) bila ada — tulis lengkap.
- INSTANSI/MEREK yang diklaim (logo/nama, mis. "Kemensos", "DANA", nama bank), bila ada.
- AJAKAN/TOMBOL (mis. "klik di sini", "daftar", "transfer", "login") bila ada.
- JENIS gambar singkat (poster, screenshot chat WhatsApp, struk transfer, formulir, dll).
Kalau gambar tidak memuat teks/informasi relevan, katakan singkat apa yang terlihat.`;

/**
 * Baca gambar → teks (OCR + deskripsi). @returns {Promise<string|null>} null bila vision nonaktif/gagal.
 */
export async function describeImage(buffer, mimetype = 'image/jpeg', caption = '') {
  if (!hasVision() || !buffer?.length) return null;
  const b64 = buffer.toString('base64');
  const body = {
    model: config.vision.model,
    temperature: 0,
    max_tokens: 800,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: caption ? `Caption dari warga: "${caption}". Laporkan isi gambarnya:` : 'Laporkan isi gambar ini:' },
          { type: 'image_url', image_url: { url: `data:${mimetype};base64,${b64}` } },
        ],
      },
    ],
  };

  const res = await fetch(`${config.vision.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.vision.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`vision ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim() || null;
}
