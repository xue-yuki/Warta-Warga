// Orkestrator pesan Warta Warga (tipis). LLM agentic (brain.think) yang menyetir percakapan & tool;
// handler cuma: guard keamanan (deterministik) → think → output guard → log + memori obrolan.
// Alur bisnis lapor (approval→broadcast) dipicu LLM lewat tool catat_laporan di dalam brain.

import { think } from './brain.js';
import { logInteraksi } from '../db/index.js';
import { getHistory, pushTurn } from './convo.js';
import { isInjection, isOffTopicTask, looksLikeCode, REFUSAL_REPLY } from './guard.js';
import { humanWilayah } from '../util/wilayah.js';
import { consumeLaporReply, handleLapor } from './lapor.js';
import { extractUrlFromText, inspectUrl } from './checkurl.js';
import { checkClaim } from './claim.js';
import { isVerificationIntent } from './intent.js';

async function prefetchUrlContext(text, scopeTags) {
  const url = extractUrlFromText(text);
  if (!url) return null;
  try {
    const inspection = await inspectUrl(url);
    const claimSrc = inspection.content_snippet || inspection.page_title || inspection.meta_description;
    let klaim_verifikasi = null;
    if (claimSrc && String(claimSrc).length >= 15) {
      const c = await checkClaim(String(claimSrc).slice(0, 500), { scopeTags });
      klaim_verifikasi = { label: c.label, judul: c.judul, alasan: c.alasan, sources: c.sources };
    }
    return { inspection, klaim_verifikasi };
  } catch {
    return null;
  }
}

async function prefetchVerificationContext(text, scopeTags) {
  const urlCtx = await prefetchUrlContext(text, scopeTags);
  if (urlCtx) return urlCtx;
  if (!isVerificationIntent(text) || String(text).length < 20) return null;
  try {
    const c = await checkClaim(String(text).slice(0, 500), { scopeTags });
    return { klaim_verifikasi: { label: c.label, judul: c.judul, alasan: c.alasan, sources: c.sources } };
  } catch {
    return null;
  }
}

export const GREETING = `👋 Halo, aku *WargaAI* dari TemanWarga.

Aku bisa bantuin kamu untuk:
1️⃣ *JagaWarga* — cek hoaks dan penipuan. Kirim kabar, link, atau foto yang kamu ragukan, nanti aku bantu cek aman/belum pasti/berbahaya.
2️⃣ *WartaWarga* — sebarin info bansos & program pemerintah terbaru. Contoh: "syarat PKH apa?" atau "ada bansos di daerahku?"
3️⃣ *LaporWarga* — laporin aduan kamu: penipuan yang lagi marak, layanan publik (jalan rusak, listrik mati, air PDAM, dll), sampai konten internet yang meresahkan.

Semua jawaban bersumber dari info resmi (.go.id/Kemensos) dan selalu aku cantumkan sumbernya. Aku *tidak* menyimpan data pribadimu. 🙏`;

// Nomor menu ini HARUS selaras dgn urutan di GREETING di atas (1=JagaWarga, 2=WartaWarga, 3=LaporWarga)
// — kalau salah satu diubah tanpa yang lain, angka yang ditekan warga tidak match penjelasan greeting.
const MENU_SELECTIONS = {
  '1': {
    aksi: 'info',
    reply: () =>
      'Silakan kirim kabar, link, foto, atau pesan yang ingin Bapak/Ibu cek.\n\n' +
      'Nanti saya bantu jelaskan apakah aman, belum pasti, atau berbahaya.',
  },
  '2': {
    aksi: 'info',
    reply: ({ wilayahLabel }) =>
      `Silakan, info bansos apa yang ingin Bapak/Ibu tanyakan${wilayahLabel ? ` untuk *${wilayahLabel}*` : ''}?\n\n` +
      'Contoh: "Syarat PKH apa?" atau "Ada bansos apa di Kab. Banyumas?"',
  },
  '3': {
    aksi: 'lapor',
    reply: ({ wilayahLabel }) =>
      `Silakan ceritakan aduan yang ingin Bapak/Ibu laporkan${wilayahLabel ? ` di *${wilayahLabel}*` : ''}.\n\n` +
      'Bisa berupa:\n' +
      '• *Penipuan* yang lagi marak (modusnya seperti apa)\n' +
      '• *Layanan publik* (jalan rusak, listrik mati, air PDAM, dll)\n' +
      '• *Konten internet* yang meresahkan (sertakan link-nya)\n\n' +
      'Tidak perlu sebut nama, nomor HP, NIK, atau alamat lengkap.',
  },
};

function menuSelection(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const symbol = raw.match(/^[\s.#]*(1|2|3)(?:[️⃣⃣\uFE0F]|\.)?(?:\s|$)/);
  if (!symbol) return null;
  return MENU_SELECTIONS[symbol[1]] || null;
}

function renderMenuReply(menu, wilayahTag) {
  const wilayahLabel = wilayahTag ? humanWilayah(wilayahTag) : '';
  return menu.reply({ wilayahLabel });
}

// Sinyal layanan publik fisik — kalau ada ini, biarkan brain.js yang handle (bukan pipeline penipuan)
const PUBLIC_SERVICE_BYPASS = /\b(jalan|listrik|pln|air|pdam|sampah|lampu|drainase|banjir|trotoar|saluran|fasilitas umum|layanan publik|infrastruktur|rusak|berlubang|mati|padam|bocor|mampet)\b/i;

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
  const pendingLapor = sessionId
    ? await consumeLaporReply({ sessionId, text, wilayahTag, scopeTags })
    : null;
  if (pendingLapor?.reply) {
    await logInteraksi({ konteks, jenis: 'lapor', aksi: 'lapor', label: 'lapor_pending', wilayahTag, ringkasResp: ringkasResp(pendingLapor.reply) });
    pushTurn(sessionId, 'user', text);
    pushTurn(sessionId, 'assistant', pendingLapor.reply);
    return { reply: pendingLapor.reply, jenis: 'lapor', aksi: 'lapor', label: 'lapor_pending', grounded: false };
  }

  const menu = menuSelection(text);
  if (menu) {
    const reply = renderMenuReply(menu, wilayahTag);
    if (menu.aksi === 'lapor' && sessionId) {
      await handleLapor({ text: 'mau lapor', wilayahTag, scopeTags, sessionId });
    }
    await logInteraksi({ konteks, jenis: menu.aksi, aksi: menu.aksi, label: 'menu', wilayahTag, ringkasResp: ringkasResp(reply) });
    if (sessionId) {
      pushTurn(sessionId, 'user', text);
      pushTurn(sessionId, 'assistant', reply);
    }
    return { reply, jenis: menu.aksi, aksi: menu.aksi, label: 'menu', grounded: false };
  }

  // LAPIS 1+2 (security, deterministik pra-LLM): tangkal prompt-injection & tugas off-topic.
  // Ini SARINGAN KEAMANAN, bukan klasifikasi maksud — jawaban tetap/hardcoded agar tak bisa "dibujuk".
  if (isInjection(text) || isOffTopicTask(text)) {
    await logInteraksi({ konteks, jenis: 'tolak', aksi: 'tolak', label: 'ditolak', wilayahTag });
    return { reply: REFUSAL_REPLY, jenis: 'tolak', aksi: 'tolak', label: 'ditolak', grounded: false };
  }

  // Semua intent "lapor" diserahkan ke brain.js (LLM) yang akan memutuskan
  // apakah ini laporan penipuan (catat_laporan) atau aduan layanan publik (kirim_aduan_layanan).
  // Tidak ada pre-filter deterministik di sini untuk menghindari false positive.

  const history = getHistory(sessionId);
  const urlContext = await prefetchVerificationContext(text, scopeTags);
  const r = await think(text, { history, scopeTags, wilayahTag, sessionId, urlContext });

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

  await logInteraksi({ konteks, jenis: aksi, aksi, label: r.label, wilayahTag, ringkasResp: ringkasResp(reply) });

  // Catat giliran ke memori efemeral (RAM, per-sesi, TTL) supaya follow-up nyambung.
  // Teks mentah (bisa ber-PII) hanya tinggal di RAM sesaat; yang masuk DB hanya ringkasan no-PII via tool.
  if (sessionId && reply) {
    pushTurn(sessionId, 'user', text);
    pushTurn(sessionId, 'assistant', reply);
  }

  return { reply, jenis: aksi, aksi, label: r.label, grounded: r.grounded };
}
