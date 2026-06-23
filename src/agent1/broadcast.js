import crypto from 'node:crypto';
import { listActiveGrups, wasBroadcast, markBroadcast } from '../db/index.js';
import { groupScopeTags, infoMatchesScope, humanWilayah } from '../util/wilayah.js';
import { formatTanggalID, isExpiredDate, masaBerlakuNotice } from '../util/tanggal.js';

// Broadcast proaktif: saat Agent 1 menemukan info bansos BARU, sebarkan otomatis ke
// grup terdaftar yang wilayahnya cocok (filter hierarkis §6.3). Dedup via fingerprint isi
// supaya re-scrape rutin tidak menyepam info lama.

// Pengirim disuntik dari bot.js saat WA terhubung: async (jid, text) => sock.sendMessage(...).
// Bila null (mis. `npm run scrape` standalone / bot belum connect) → broadcast dilewati
// dan TIDAK ditandai terkirim, sehingga putaran berikutnya (saat bot hidup) tetap mengabarkan.
let _sender = null;
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

/** Grup terdaftar yang relevan untuk info ini (filter hierarkis §6.3). */
function targetGrups(rec) {
  return listActiveGrups().filter((g) => infoMatchesScope(rec.wilayah_tag, groupScopeTags(g)));
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
    if (wasBroadcast(fp)) continue; // sudah pernah disebar → jangan ulang

    const targets = targetGrups(rec);
    if (targets.length === 0) continue; // belum ada grup cocok → JANGAN tandai, biar dapat saat grup join nanti

    const text = formatBroadcast(rec);
    let okGrup = 0;
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      try {
        await _sender(g.id_grup, text);
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
      markBroadcast({ fingerprint: fp, program: rec.program, wilayahTag: rec.wilayah_tag, grupCount: okGrup });
      infos++;
      console.log(`[Broadcast] 📢 "${rec.program}" (${rec.wilayah_tag}) → ${okGrup} grup.`);
    }
  }
  return { sent, infos };
}
