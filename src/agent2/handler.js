import { classifyIntent } from './classify.js';
import { answerInfo } from './rag.js';
import { checkClaim } from './claim.js';
import { chat } from '../llm/openrouter.js';
import { hasLLM } from '../config.js';
import { logInteraksi } from '../db/index.js';
import { getHistory, pushTurn } from './convo.js';

export const GREETING = `👋 Halo! Saya *Warta Warga*, asisten info bantuan sosial.

Saya bisa bantu kamu:
1️⃣ *Tanya info bansos* — mis. "syarat PKH apa?" atau "ada bansos di daerahku?"
2️⃣ *Cek kabar/klaim* — kirim kabar yang kamu ragukan, mis. "ini benar nggak: ada bantuan 600rb klik link..."

Semua jawaban saya bersumber dari info resmi (.go.id/Kemensos) dan selalu saya cantumkan sumbernya. Saya *tidak* menyimpan data pribadimu. 🙏`;

const SMALLTALK_SYSTEM = `Kamu "Warta Warga", asisten info bantuan sosial yang ramah di WhatsApp.
Pesan dari user ini BUKAN pertanyaan info bansos dan bukan klaim untuk dicek — biasanya sapaan, ucapan terima kasih, basa-basi, atau ngobrol di luar topik.

Tugasmu: balas dengan NATURAL dan nyambung ke apa yang dia tulis, seperti teman ngobrol di WA.
- Singkat (1-2 kalimat), santai, pakai "kamu", boleh emoji secukupnya. Jangan kaku/formal.
- Tanggapi dulu isinya (mis. dibilang makasih → balas hangat; ditanya kabar → jawab ringan).
- Setelah itu, kalau pas, ajak halus untuk tanya info bansos atau cek kabar — JANGAN promosi kaku tiap kali.
- Kalau dia tanya hal di luar topik bansos (mis. berita, resep, soal pribadi), jangan dijawab faktual dan jangan mengarang — akui dengan ramah lalu arahkan balik ke fungsimu (info bansos & cek kabar).
- JANGAN pernah mengarang angka/program/syarat bansos di sini.`;

const THANKS = ['makasih', 'terima kasih', 'terimakasih', 'makasi', 'thanks', 'thank', 'thx', 'suwun', 'nuhun'];

/**
 * Balasan untuk pesan "lain-lain" — digenerate LLM (persona Warta Warga) agar selalu nyambung.
 * @returns {Promise<string|null>} null = tidak perlu balas (sapaan padahal baru saja disapa)
 */
async function lainReply(text, justGreeted, history = []) {
  // Baru saja dikirimi sapaan pembuka → jangan menimpali sapaan lagi (anti-spam "halo").
  if (justGreeted) return null;

  if (hasLLM()) {
    try {
      const reply = await chat({
        tier: 'fast',
        temperature: 0.7,
        maxTokens: 200,
        messages: [
          { role: 'system', content: SMALLTALK_SYSTEM },
          ...history,
          { role: 'user', content: text },
        ],
      });
      if (reply && reply.trim()) return reply.trim();
    } catch {
      /* jatuh ke fallback di bawah */
    }
  }

  // Fallback tanpa LLM.
  const s = text.toLowerCase();
  if (THANKS.some((w) => s.includes(w))) return 'Sama-sama! 🙏 Kalau mau tanya info bansos atau cek kabar lagi, chat aku aja ya.';
  return 'Hai! 🙂 Aku bisa bantu info bansos (syarat, jadwal, cara daftar) atau cek kabar/klaim yang kamu ragukan. Mau yang mana?';
}

/**
 * Proses satu pesan berisi konten (sudah lolos filter kanal di layer WA).
 * @param {object} p
 * @param {string} p.text            isi pesan
 * @param {'grup'|'japri'} p.konteks
 * @param {string[]|null} p.scopeTags tag wilayah yang berlaku (null = tanpa filter)
 * @param {string|null} [p.wilayahTag] untuk log
 * @returns {Promise<{reply:string, jenis:string, label:string|null}>}
 */
export async function respondToMessage({ text, konteks, scopeTags = null, wilayahTag = null, justGreeted = false, sessionId = null, jenis: jenisIn = null }) {
  const history = getHistory(sessionId); // konteks chat efemeral (RAM), untuk follow-up
  // Pakai klasifikasi yang sudah dihitung pemanggil bila ada (hindari klasifikasi dobel).
  const jenis = jenisIn || (await classifyIntent(text)).jenis;

  let reply;
  let label = null;
  let grounded = false; // info: apakah jawaban benar-benar bersumber (ada hit relevan)?

  if (jenis === 'klaim') {
    const res = await checkClaim(text, { scopeTags, history });
    reply = res.text;
    label = res.label;
  } else if (jenis === 'info') {
    const res = await answerInfo(text, { scopeTags, history });
    reply = res.text;
    grounded = res.grounded;
  } else {
    reply = await lainReply(text, justGreeted, history);
  }

  // Log anonim (tanpa identitas/isi pribadi) — hanya tren kebutuhan.
  logInteraksi({ konteks, jenis, label, wilayahTag });

  // Catat giliran ke memori efemeral (raw text, bukan prompt yang sudah dibumbui).
  if (sessionId && reply) {
    pushTurn(sessionId, 'user', text);
    pushTurn(sessionId, 'assistant', reply);
  }

  return { reply, jenis, label, grounded };
}
