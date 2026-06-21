import { chatJson } from '../llm/openrouter.js';
import { hasLLM } from '../config.js';

// Klasifikasi maksud (Bagian 5.3 PRD):
//   A = tanya info, B = ajukan klaim, C = lain-lain

const SYSTEM = `Klasifikasikan pesan warga (Bahasa Indonesia) ke salah satu maksud:
- "info"  : warga bertanya tentang bansos (syarat, jadwal, apakah ada bantuan, cara daftar).
- "klaim" : warga MEMINTA verifikasi sebuah kabar/klaim ("ini benar nggak...", "ada link bantuan 600rb", "katanya...").
- "lain"  : sapaan, terima kasih, di luar topik bansos.
Jawab JSON: {"jenis":"info|klaim|lain","alasan":string}`;

const KLAIM_HINTS = [
  'bener', 'benar', 'beneran', 'asli', 'hoaks', 'hoax', 'penipuan', 'katanya',
  'klik link', 'http', 'transfer', 'dapat bantuan', 'dapet bantuan', 'viral', 'beredar',
];
const INFO_HINTS = ['syarat', 'daftar', 'cara', 'kapan', 'jadwal', 'pkh', 'bpnt', 'bansos', 'pip', 'kis', 'apakah ada', 'ada bantuan'];
const SAPAAN = ['halo', 'hai', 'hi', 'assalamualaikum', 'pagi', 'siang', 'sore', 'malam', 'terima kasih', 'makasih', 'thanks'];

function heuristic(text) {
  const t = text.toLowerCase();
  if (KLAIM_HINTS.some((w) => t.includes(w))) return { jenis: 'klaim', alasan: 'heuristik kata kunci klaim' };
  if (INFO_HINTS.some((w) => t.includes(w))) return { jenis: 'info', alasan: 'heuristik kata kunci info' };
  if (t.trim().split(/\s+/).length <= 3 && SAPAAN.some((w) => t.includes(w)))
    return { jenis: 'lain', alasan: 'heuristik sapaan' };
  return { jenis: 'info', alasan: 'default ke info' };
}

/** Tentukan jenis pesan: info | klaim | lain. Pakai LLM cepat, fallback heuristik. */
export async function classifyIntent(text) {
  if (!hasLLM()) return heuristic(text);
  try {
    const r = await chatJson({
      tier: 'fast',
      temperature: 0,
      maxTokens: 60, // cuma butuh JSON pendek {"jenis":...}
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text },
      ],
    });
    if (r && ['info', 'klaim', 'lain'].includes(r.jenis)) return r;
    return heuristic(text);
  } catch {
    return heuristic(text);
  }
}
