// Orkestrator pesan Warta Warga (tipis). LLM agentic (brain.think) yang menyetir percakapan & tool;
// handler cuma: guard keamanan (deterministik) → think → output guard → log + memori obrolan.
// Alur bisnis lapor (approval→broadcast) dipicu LLM lewat tool catat_laporan di dalam brain.

import { think } from './brain.js';
import { logInteraksi } from '../db/index.js';
import { getHistory, pushTurn } from './convo.js';
import { isInjection, isOffTopicTask, looksLikeCode, REFUSAL_REPLY } from './guard.js';

export const GREETING = `👋 Halo! Saya *Warta Warga*, asisten info bansos & waspada penipuan.

Saya bisa bantu kamu:
1️⃣ *Tanya info bansos* — mis. "syarat PKH apa?" atau "ada bansos di daerahku?"
2️⃣ *Cek kabar/klaim* — kirim kabar yang kamu ragukan, mis. "ini benar nggak: ada bantuan 600rb klik link..."
3️⃣ *Lapor penipuan* — kirim modus yang lagi marak (ngaku petugas/bank/CS, link & undian palsu, minta OTP/transfer, lowongan/investasi bodong, dll). Kalau valid & banyak laporan serupa, saya sebar peringatan ke grup daerahmu (setelah ditinjau pengurus).

Semua jawaban saya bersumber dari info resmi (.go.id/Kemensos) dan selalu saya cantumkan sumbernya. Saya *tidak* menyimpan data pribadimu. 🙏`;

// Ringkasan respons bot untuk analytics (bot bicara PII-free) — buang baris meta & potong.
function ringkasResp(reply) {
  if (!reply) return null;
  const inti = String(reply)
    .split('\n')
    .filter((l) => !/^(sumber\s*:|_\(info diperbarui|⚠️|ℹ️)/i.test(l.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return inti.slice(0, 180) || null;
}

/**
 * Proses satu pesan berkonten (sudah lolos filter kanal di layer WA).
 * @param {object} p
 * @param {string} p.text
 * @param {'grup'|'japri'} p.konteks
 * @param {string[]|null} p.scopeTags  tag wilayah berlaku (null = tanpa filter)
 * @param {string|null} [p.wilayahTag] wilayah grup (dipakai brain utk laporan tanpa tanya) & log
 * @returns {Promise<{reply:string|null, jenis:string, aksi:string, label:string|null, grounded:boolean}>}
 */
export async function respondToMessage({ text, konteks, scopeTags = null, wilayahTag = null, justGreeted = false, sessionId = null }) {
  // LAPIS 1+2 (security, deterministik pra-LLM): tangkal prompt-injection & tugas off-topic.
  // Ini SARINGAN KEAMANAN, bukan klasifikasi maksud — jawaban tetap/hardcoded agar tak bisa "dibujuk".
  if (isInjection(text) || isOffTopicTask(text)) {
    logInteraksi({ konteks, jenis: 'tolak', aksi: 'tolak', label: 'ditolak', wilayahTag });
    return { reply: REFUSAL_REPLY, jenis: 'tolak', aksi: 'tolak', label: 'ditolak', grounded: false };
  }

  const history = getHistory(sessionId); // ingatan obrolan efemeral (RAM) → multi-turn natural
  const r = await think(text, { history, scopeTags, wilayahTag });

  // LAPIS 4 (output guard): balasan tak boleh memuat kode (jaring akhir bila injeksi lolos).
  let reply = r.reply;
  let aksi = r.aksi;
  if (reply && looksLikeCode(reply)) {
    reply = REFUSAL_REPLY;
    aksi = 'tolak';
  }

  // 'ngobrol' tepat setelah disapa pembuka → jangan menimpali sapaan lagi (anti-spam "halo").
  if (aksi === 'ngobrol' && justGreeted) {
    return { reply: null, jenis: aksi, aksi, label: null, grounded: false };
  }

  logInteraksi({ konteks, jenis: aksi, aksi, label: r.label, wilayahTag, ringkasResp: ringkasResp(reply) });

  // Catat giliran ke memori efemeral (RAM, per-sesi, TTL) supaya follow-up nyambung.
  // Teks mentah (bisa ber-PII) hanya tinggal di RAM sesaat; yang masuk DB hanya ringkasan no-PII via tool.
  if (sessionId && reply) {
    pushTurn(sessionId, 'user', text);
    pushTurn(sessionId, 'assistant', reply);
  }

  return { reply, jenis: aksi, aksi, label: r.label, grounded: r.grounded };
}
