import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  listActiveGrups,
  wasBroadcast,
  markBroadcast,
  wasPeringatanSent,
  markPeringatanTerkirim,
  updateInfoBansosImage,
  listLaporanApprovedPendingBroadcast,
} from '../db/index.js';
import { generateAndSavePoster, generatePeringatanPoster } from '../llm/imageGen.js';
import { groupScopeTags, infoMatchesScope, humanWilayah } from '../util/wilayah.js';
import { formatTanggalID, isExpiredDate, masaBerlakuNotice } from '../util/tanggal.js';

// Broadcast proaktif: saat Agent 1 menemukan info bansos BARU, sebarkan otomatis ke
// grup terdaftar yang wilayahnya cocok (filter hierarkis §6.3). Dedup via fingerprint isi
// supaya re-scrape rutin tidak menyepam info lama.

// Pengirim disuntik dari bot.js saat WA terhubung: async (jid, text) => sock.sendMessage(...).
// Bila null (mis. `npm run scrape` standalone / bot belum connect) → broadcast dilewati
// dan TIDAK ditandai terkirim, sehingga putaran berikutnya (saat bot hidup) tetap mengabarkan.
let _sender = null;
const _peringatanInFlight = new Set();
export function setBroadcaster(fn) {
  _sender = typeof fn === 'function' ? fn : null;
}
export function hasBroadcaster() {
  return Boolean(_sender);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Jeda ACAK antar pengiriman ke grup. Broadcast beruntun tanpa jeda memicu deteksi spam
// WhatsApp dan berisiko nomor ke-banned. Acak (bukan tetap) agar pola tak terlihat robotik.
const BROADCAST_MIN_MS = Number(process.env.BROADCAST_MIN_MS) || 3000; // 3 dtk
const BROADCAST_MAX_MS = Number(process.env.BROADCAST_MAX_MS) || 8000; // 8 dtk
function randomGap() {
  return Math.floor(BROADCAST_MIN_MS + Math.random() * (BROADCAST_MAX_MS - BROADCAST_MIN_MS));
}

/** Sidik jari isi info — stabil walau id berubah karena re-scrape (refresh delete+insert). */
export function fingerprintInfo(rec) {
  const basis = [rec.program, rec.wilayah_tag, rec.ringkasan, rec.tanggal_penting || '', rec.batas_daftar || '']
    .map((s) => String(s || '').trim().toLowerCase())
    .join('||');
  return crypto.createHash('sha1').update(basis).digest('hex');
}

/** Susun kartu pesan broadcast: bahasa sudah disederhanakan Agent 1 + WAJIB cantumkan sumber (F2.4). */
export function formatBroadcast(rec) {
  const lines = [`📢 *Info Bansos Baru — ${humanWilayah(rec.wilayah_tag)}*`, ''];
  lines.push(`*${rec.program}*`);
  if (rec.ringkasan) lines.push(rec.ringkasan);

  const syarat = Array.isArray(rec.syarat)
    ? rec.syarat
    : safeParseArray(rec.syarat);
  if (syarat.length) {
    lines.push('', '*Syarat:*');
    for (const s of syarat.slice(0, 6)) lines.push(`• ${s}`);
  }
  // Jangan tampilkan jadwal yang berupa tanggal tunggal & sudah lewat (sering kali itu
  // tanggal TERBIT artikel yang salah terambil) → menyesatkan warga.
  if (rec.tanggal_penting && !isExpiredDate(rec.tanggal_penting)) {
    lines.push('', `🗓️ *Jadwal:* ${rec.tanggal_penting}`);
  }
  // Batas pendaftaran yang MASIH berlaku ditampilkan; yang sudah lewat ditangani peringatan di bawah.
  if (rec.batas_daftar && !isExpiredDate(rec.batas_daftar)) {
    lines.push('', `⏳ *Batas daftar:* ${formatTanggalID(rec.batas_daftar)}`);
  }
  if (rec.cara_daftar) lines.push('', `📝 *Cara daftar:* ${rec.cara_daftar}`);

  // F2.4: info WAJIB menyertakan sumber.
  if (rec.sumber_url) lines.push('', `Sumber: ${rec.sumber_url}`);
  const tgl = formatTanggalID(rec.tanggal_ambil);
  if (tgl) lines.push(`_(Info diperbarui: ${tgl})_`);

  // Peringatan masa berlaku (batas daftar lewat / data sudah lama).
  const notice = masaBerlakuNotice(rec);
  if (notice) lines.push('', notice);

  lines.push('', '_Pesan otomatis Warta Warga. Untuk kepastian kelayakan, cek cekbansos.kemensos.go.id atau tanya RT/pengurus._');
  return lines.join('\n');
}

function safeParseArray(v) {
  if (!v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

/** Grup terdaftar (opt-in) yang relevan untuk sebuah wilayah_tag (filter hierarkis §6.3). */
export async function grupsForWilayah(wilayahTag) {
  return (await listActiveGrups()).filter((g) => infoMatchesScope(wilayahTag, groupScopeTags(g)));
}

/** Grup terdaftar yang relevan untuk info ini (filter hierarkis §6.3). */
function targetGrups(rec) {
  return grupsForWilayah(rec.wilayah_tag);
}

/** Kirim satu teks ke daftar grup dengan jeda acak anti-spam. @returns {Promise<number>} grup berhasil */
async function sendToGrups(targets, text, imagePath = null) {
  let okGrup = 0;
  for (let i = 0; i < targets.length; i++) {
    const g = targets[i];
    let sent = false;
    if (imagePath) {
      try {
        await _sender(g.id_grup, text, imagePath);
        sent = true;
      } catch (imgErr) {
        // Gambar gagal → fallback teks saja agar pesan tetap terkirim
        console.warn(`[Broadcast] gambar gagal ke ${g.id_grup} (${imgErr?.message}), coba teks saja…`);
        try {
          await _sender(g.id_grup, text, null);
          sent = true;
        } catch (e) {
          console.warn(`[Broadcast] gagal kirim ke ${g.id_grup}: ${e?.message}`);
        }
      }
    } else {
      try {
        await _sender(g.id_grup, text, null);
        sent = true;
      } catch (e) {
        console.warn(`[Broadcast] gagal kirim ke ${g.id_grup}: ${e?.message}`);
      }
    }
    if (sent) okGrup++;
    if (i < targets.length - 1) await delay(randomGap());
  }
  return okGrup;
}

/**
 * Broadcast daftar info BARU ke grup yang cocok. Aman dipanggil dengan data campuran;
 * yang sudah pernah dikirim (fingerprint) atau tanpa grup target di-skip.
 * @param {Array<object>} records record info dari storeStructured (punya program, ringkasan, syarat, wilayah_tag, sumber_url, tanggal_ambil)
 * @returns {Promise<{sent:number, infos:number}>}
 */
export async function broadcastNewInfos(records) {
  if (!_sender) return { sent: 0, infos: 0 }; // tak ada koneksi WA → tunda diam-diam
  const list = (records || []).filter((r) => r && r.program && r.wilayah_tag);
  if (list.length === 0) return { sent: 0, infos: 0 };

  let infos = 0;
  let sent = 0;
  for (const rec of list) {
    const fp = fingerprintInfo(rec);
    if (await wasBroadcast(fp)) continue; // sudah pernah disebar → jangan ulang

    const targets = await targetGrups(rec);
    if (targets.length === 0) continue; // belum ada grup cocok → JANGAN tandai, biar dapat saat grup join nanti

    const text = formatBroadcast(rec);
    let imagePath = rec.image_path || null;
    // Generate poster sekarang (saat broadcast) jika belum ada.
    if (!imagePath && rec.image_id) {
      try {
        imagePath = await generateAndSavePoster(rec, { imageId: rec.image_id });
        if (imagePath && rec.id) {
          await updateInfoBansosImage(rec.id, { imageId: rec.image_id, imagePath });
        }
      } catch (e) {
        console.warn(`[Broadcast] poster generation failed for "${rec.program}": ${e.message}`);
      }
    }
    if (imagePath && !fs.existsSync(imagePath)) {
      console.warn(`[Broadcast] ⚠️ Image file not found: ${imagePath}. Falling back to text-only.`);
      imagePath = null;
    }

    let okGrup = 0;
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      try {
        await _sender(g.id_grup, text, imagePath);
        okGrup++;
        sent++;
      } catch (e) {
        console.warn(`[Broadcast] gagal kirim ke ${g.id_grup}: ${e?.message}`);
      }
      // Jeda acak 3-8 dtk SEBELUM grup berikutnya (lewati setelah grup terakhir).
      if (i < targets.length - 1) await delay(randomGap());
    }

    if (okGrup > 0) {
      // Tandai terkirim HANYA bila minimal 1 grup berhasil → kegagalan total bisa dicoba lagi nanti.
      await markBroadcast({ fingerprint: fp, program: rec.program, wilayahTag: rec.wilayah_tag, grupCount: okGrup });
      infos++;
      console.log(`[Broadcast] 📢 "${rec.program}" (${rec.wilayah_tag}) → ${okGrup} grup.`);
    }
  }
  return { sent, infos };
}

// ===================== PERINGATAN DINI (Fitur Lapor) =====================

// Ambang "fast-track": laporan serupa sebanyak ini → ditandai URGENT + pengurus dinotif.
// Tetap WAJIB approval manusia (Lapis 2) — notif hanya mempercepat peninjauan, bukan auto-sebar.
export const URGENT_THRESHOLD = Number(process.env.LAPOR_URGENT_THRESHOLD) || 3;

const PENGURUS_JID = process.env.PENGURUS_JID || null; // nomor/grup admin (mis. "628xx@s.whatsapp.net" / "xxx@g.us")
const DASHBOARD_URL = `http://127.0.0.1:${Number(process.env.DASHBOARD_PORT) || 3210}`;

/**
 * Notifikasi ke pengurus saat laporan serupa menumpuk (≥ URGENT_THRESHOLD). TIDAK menyebar
 * peringatan — cuma "ping" agar pengurus segera meninjau & approve di dashboard.
 * @returns {Promise<boolean>} true bila notif WA terkirim ke pengurus
 */
export async function notifyPengurusUrgent(laporan) {
  const judul = `🚨 *URGENT* — ${laporan.jumlah_serupa} laporan serupa di ${humanWilayah(laporan.wilayah_tag)}`;
  const body =
    `${judul}\n\n` +
    `*Modus:* ${laporan.isi_ringkas || laporan.modus_key}\n` +
    `*Status:* ${laporan.status}\n\n` +
    `Segera tinjau & approve (atau tolak) di dashboard:\n${DASHBOARD_URL}`;
  if (_sender && PENGURUS_JID) {
    try {
      await _sender(PENGURUS_JID, body);
      console.log(`[Peringatan] 🚨 notif URGENT → pengurus (laporan #${laporan.id}).`);
      return true;
    } catch (e) {
      console.warn(`[Peringatan] gagal notif pengurus: ${e?.message}`);
    }
  }
  // Fallback bila PENGURUS_JID belum diset / bot offline → tetap kelihatan di log + badge dashboard.
  console.warn(`[Peringatan] 🚨 URGENT (set PENGURUS_JID utk notif WA): ${judul} — tinjau di ${DASHBOARD_URL}`);
  return false;
}

function peringatanPublicContext(laporan) {
  return [
    laporan?.isi_ringkas,
    laporan?.teks_peringatan,
  ].map((v) => String(v || '').toLowerCase()).join(' ');
}

function isBansosContext(text) {
  return /\b(bansos|bantuan sosial|pkh|blt|bpnt|kemensos|cekbansos|dinsos)\b/i.test(text);
}

function tipsAmanPeringatan(laporan) {
  const text = peringatanPublicContext(laporan);
  const tips = [];

  if (/\b(otp|pin|password|kata sandi|kode sms|sms|kode rahasia|verifikasi)\b/i.test(text)) {
    tips.push('• Jangan beri OTP/PIN/password/kode SMS kepada siapa pun.');
  }
  if (/\b(nik|kk|ktp|data pribadi|foto ktp|dokumen pribadi)\b/i.test(text)) {
    tips.push('• Jangan kirim NIK, KK, foto KTP, atau data pribadi lewat chat/link tidak resmi.');
  }
  if (/\b(link|tautan|url|situs|formulir|apk|klik)\b/i.test(text)) {
    tips.push('• Jangan klik tautan mencurigakan atau mengisi formulir dari pengirim tidak dikenal.');
  }
  if (/\b(transfer|rekening|biaya|admin|administrasi|jaminan|pajak|uang|bayar|pulsa|voucher)\b/i.test(text)) {
    tips.push('• Jangan transfer uang, pulsa, voucher, atau biaya apa pun ke rekening/nomor pribadi.');
  }
  if (/\b(ngaku|mengaku|petugas|cs|customer service|bank|toko|kurir|dinsos|kelurahan)\b/i.test(text)) {
    tips.push('• Verifikasi langsung ke kanal resmi instansi, bank, toko, atau pengurus setempat.');
  }

  if (isBansosContext(text)) {
    tips.unshift('• Untuk bansos, cek hanya kanal resmi seperti cekbansos.kemensos.go.id atau Dinsos setempat.');
  }

  const fallback = tips.length
    ? [
        '• Simpan bukti chat, nomor, tautan, atau rekening untuk dilaporkan.',
        '• Beri tahu keluarga/tetangga sekitar agar tidak mengikuti instruksi pelaku.',
      ]
    : [
        '• Jangan beri OTP/PIN/password, data pribadi, uang, pulsa, atau voucher kepada pengirim tidak dikenal.',
        '• Verifikasi klaim lewat kanal resmi sebelum mengikuti instruksi apa pun.',
        '• Simpan bukti chat/nomor/rekening dan laporkan ke pengurus atau kanal pengaduan resmi.',
      ];

  for (const tip of fallback) {
    if (tips.length >= 3) break;
    tips.push(tip);
  }

  return [...new Set(tips)].slice(0, 3);
}

/** Susun kartu peringatan dini. UMUM & tanpa identitas pelapor (Rambu 2 PRD). */
export function formatPeringatan(laporan) {
  const lines = [`⚠️ *Peringatan Dini Penipuan — ${humanWilayah(laporan.wilayah_tag)}*`, ''];
  // teks_peringatan = ringkasan modus yang sudah dibersihkan dari PII (oleh Agent saat lapor).
  lines.push(laporan.teks_peringatan || laporan.isi_ringkas || 'Ada laporan modus penipuan di daerah ini.');
  if (laporan.jumlah_serupa > 1) lines.push('', `📈 _${laporan.jumlah_serupa} laporan serupa diterima di daerah ini._`);
  lines.push('', '*Tips aman:*', ...tipsAmanPeringatan(laporan));
  if (laporan.dasar_verifikasi) lines.push('', `_Dasar tinjauan: ${laporan.dasar_verifikasi}_`);
  lines.push('', '_Peringatan Warta Warga — disebar setelah ditinjau pengurus. Identitas pelapor tidak disimpan._');
  return lines.join('\n');
}

/**
 * Sebar peringatan dini untuk satu laporan yang SUDAH di-approve pengurus.
 * Reuse: filter wilayah (§6.3), opt-in (/start), jeda acak anti-spam, dedup (peringatan_terkirim).
 * @returns {Promise<{sent:number, grupCount:number, reason?:string}>}
 */
/** Kartu digest "lagi marak" (nasional/regional). items = [{label, total}] sudah berlabel manusiawi. */
export function formatTrenDigest(items, { scope = 'Nasional', days = 30 } = {}) {
  const lines = [`📊 *Waspada Penipuan — ${scope}*`, '', `Modus yang lagi marak (laporan warga, ${days} hari terakhir):`];
  items.forEach((it, i) => lines.push(`${i + 1}. *${it.label}* — ${it.total} laporan`));
  lines.push(
    '',
    'Ingat: jangan transfer uang/pulsa, kasih OTP/PIN/data pribadi, atau klik link ke pihak yang mencurigakan. Cek dulu ke sumber resmi atau tanya RT/pengurus.',
    '',
    '_Rekap otomatis Warta Warga dari laporan warga._',
  );
  return lines.join('\n');
}

/** Sebar digest "lagi marak" ke SEMUA grup terdaftar. Dipicu pengurus (bukan auto). */
export async function broadcastTrenNasional(items, opts = {}) {
  if (!_sender) return { sent: 0, reason: 'no-sender' };
  if (!items?.length) return { sent: 0, reason: 'tak-ada-data' };
  const targets = await listActiveGrups();
  if (!targets.length) return { sent: 0, reason: 'tak-ada-grup' };
  const okGrup = await sendToGrups(targets, formatTrenDigest(items, opts));
  if (okGrup > 0) console.log(`[Tren] 📊 digest "lagi marak" → ${okGrup} grup.`);
  return { sent: okGrup };
}

// Guard: cegah concurrent run (mis. dipicu reconnect berulang dalam detik yang sama)
let _pendingBroadcastRunning = false;

/**
 * Poll Supabase tiap interval: broadcast laporan yang sudah di-approve web dashboard
 * tapi belum pernah dikirim. Generate poster dulu, lalu kirim ke grup wilayah.
 */
export async function broadcastPendingPeringatan() {
  if (!_sender) return { sent: 0, infos: 0 };
  if (_pendingBroadcastRunning) {
    console.log('[PendingBroadcast] Masih berjalan, skip trigger ini.');
    return { sent: 0, infos: 0 };
  }
  _pendingBroadcastRunning = true;
  try {
    const pending = await listLaporanApprovedPendingBroadcast().catch(() => []);
    if (pending.length === 0) return { sent: 0, infos: 0 };

    console.log(`[PendingBroadcast] ${pending.length} laporan approved menunggu broadcast...`);
    let sent = 0;
    let infos = 0;

    for (const l of pending) {
      if (!_sender) {
        console.warn('[PendingBroadcast] Bot disconnect di tengah batch, hentikan.');
        break;
      }
      let imagePath = null;
      try {
        imagePath = await generatePeringatanPoster({
          kategori: l.status === 'jelas_penipuan' ? 'Penipuan' : 'Misinformasi',
          wilayah: humanWilayah(l.wilayah_tag),
          total: l.jumlah_serupa || 1,
          deskripsi: l.isi_ringkas,
          imageId: `peringatan_${l.wilayah_tag}_${l.id}`.replace(/[^a-z0-9_]/gi, '_'),
        });
      } catch (e) {
        console.warn(`[PendingBroadcast] poster gagal #${l.id}: ${e.message}`);
      }
      const r = await broadcastPeringatan(l, { imagePath }).catch((e) => ({ sent: 0, grupCount: 0, reason: e.message }));
      sent += r.sent || 0;
      if ((r.sent || 0) > 0) infos++;
    }

    if (sent > 0) console.log(`[PendingBroadcast] ✅ ${infos} peringatan → ${sent} grup.`);
    return { sent, infos };
  } finally {
    _pendingBroadcastRunning = false;
  }
}

export async function broadcastPeringatan(laporan, { imagePath = null } = {}) {
  if (!_sender) {
    console.warn(`[Peringatan] laporan #${laporan?.id} → no-sender (bot offline saat broadcast dipanggil).`);
    return { sent: 0, grupCount: 0, reason: 'no-sender' };
  }
  if (!laporan || laporan.status_approval !== 'disetujui') {
    console.warn(`[Peringatan] laporan #${laporan?.id} → belum-disetujui (status_approval='${laporan?.status_approval}').`);
    return { sent: 0, grupCount: 0, reason: 'belum-disetujui' };
  }
  const key = String(laporan.id || '');
  if (key && _peringatanInFlight.has(key)) {
    console.warn(`[Peringatan] laporan #${laporan.id} → sedang-dikirim (request duplikat, abaikan).`);
    return { sent: 0, grupCount: 0, reason: 'sedang-dikirim' };
  }
  if (key) _peringatanInFlight.add(key);
  try {
    if (await wasPeringatanSent(laporan.id)) {
      console.log(`[Peringatan] laporan #${laporan.id} → sudah-dikirim sebelumnya, skip.`);
      return { sent: 0, grupCount: 0, reason: 'sudah-dikirim' };
    }

    const targets = await grupsForWilayah(laporan.wilayah_tag);
    if (targets.length === 0) {
      console.warn(`[Peringatan] laporan #${laporan.id} (${laporan.wilayah_tag}) → tak-ada-grup terdaftar untuk wilayah ini.`);
      return { sent: 0, grupCount: 0, reason: 'tak-ada-grup' };
    }
    console.log(`[Peringatan] laporan #${laporan.id} (${laporan.wilayah_tag}) → ${targets.length} grup ditemukan, mengirim...`);

    const text = formatPeringatan(laporan);
    const resolvedImage = imagePath && fs.existsSync(imagePath) ? imagePath : null;
    const okGrup = await sendToGrups(targets, text, resolvedImage);
    if (okGrup > 0) {
      await markPeringatanTerkirim({ laporanId: laporan.id, wilayahTag: laporan.wilayah_tag, grupCount: okGrup });
      console.log(`[Peringatan] ⚠️ laporan #${laporan.id} (${laporan.wilayah_tag}) → ${okGrup} grup${resolvedImage ? ' + poster' : ''}.`);
    } else {
      console.warn(`[Peringatan] laporan #${laporan.id} (${laporan.wilayah_tag}) → 0/${targets.length} grup berhasil (semua gagal kirim).`);
    }
    return { sent: okGrup, grupCount: okGrup, ...(okGrup === 0 && targets.length > 0 ? { reason: 'kirim-gagal' } : {}) };
  } finally {
    if (key) _peringatanInFlight.delete(key);
  }
}
