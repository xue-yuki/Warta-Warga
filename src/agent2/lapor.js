// Alur LAPOR penipuan/hoaks (addendum PRD Lapor & Peringatan Dini).
// Prinsip: NO-PII (tak menyimpan identitas pelapor), respons instan, sebar TERTUNDA (nunggu approval).
// Numpang verifikasi 3-label (claim.js) + filter wilayah + broadcast yang sudah ada.

import { chatJson } from '../llm/openrouter.js';
import { hasLLM } from '../config.js';
import { checkClaim } from './claim.js';
import { detectWilayahFromText, normalizeWilayahTag, humanWilayah, isKabKota } from '../util/wilayah.js';
import { insertLaporan, findSimilarClusterLaporan, bumpLaporanSerupa } from '../db/index.js';
import { notifyPengurusUrgent, URGENT_THRESHOLD } from '../agent1/broadcast.js';

// Pola modus penipuan UMUM (bukan cuma bansos) → eskalasi ke "jelas_penipuan" walau tak
// bertentangan sumber (PRD: "cocok pola"). Daftar ini sengaja luas; modus baru yang belum
// tertangkap pola tetap ditangani fallback reasoning (lihat prosesLaporan → belum_pasti).
const SCAM_PATTERNS = [
  { key: 'biaya_pencairan', re: /\b(biaya (pencairan|admin|administrasi)|bayar dulu|uang muka|tebus|tebusan|pelunasan)\b/i },
  { key: 'minta_transfer', re: /\b(transfer|kirim uang|setor|via dana|via ovo|via gopay|ke rekening|nomor rekening|m-?banking)\b/i },
  { key: 'minta_pulsa', re: /\b(pulsa|isi pulsa|beli pulsa|voucher)\b/i },
  { key: 'link_palsu', re: /\b(klik link|link pendaftaran|daftar di link|http|bit\.ly|wa\.me|t\.me|aplikasi apk|install apk|\.apk|link mencurigakan|situs palsu|web palsu)\b/i },
  { key: 'minta_data_pribadi', re: /\b(otp|kode otp|pin|password|kata sandi|nik|nomor kk|data pribadi|kode verifikasi|m-?pin)\b/i },
  { key: 'undian_hadiah_palsu', re: /\b(menang|pemenang|hadiah|undian|giveaway|kuis berhadiah|grand prize|klaim hadiah)\b/i },
  { key: 'lowongan_palsu', re: /\b(lowongan|loker|kerja|gaji)\b[\s\S]{0,40}\b(bayar|biaya|transfer|deposit|seragam|jaminan)\b/i },
  { key: 'investasi_bodong', re: /\b(investasi|trading|robot trading|crypto|kripto|saham|forex|binary)\b[\s\S]{0,40}\b(untung pasti|profit pasti|cepat kaya|bunga tinggi|pasti cuan)\b|\b(skema ponzi|money game|arisan online|mlm bodong)\b/i },
  { key: 'pinjol_ilegal', re: /\b(pinjol|pinjaman online|pinjaman cepat)\b[\s\S]{0,30}\b(ilegal|tanpa bi ?checking|cair cepat|tanpa jaminan|teror|ancam)\b/i },
  {
    // Gap sempit (≤25) supaya peran yang diklaim harus DEKAT kata "ngaku" — hindari false-positive
    // seperti "ngaku relawan ... data keluarga satu RT" (RT-nya jauh & bukan yang diaku).
    key: 'ngaku_petugas',
    re: /\b(ngaku|mengaku|atas nama|mengatasnamakan)\b[\s\S]{0,25}\b(dinsos|kemensos|petugas|pemerintah|rt|rw|desa|kelurahan|bank|cs|customer service|admin|polisi|pajak|leasing|bea ?cukai|shopee|tokopedia|lazada|marketplace|kurir|ekspedisi)\b/i,
  },
];

export function matchScamPattern(text) {
  for (const p of SCAM_PATTERNS) if (p.re.test(text)) return p.key;
  return null;
}

/**
 * Saring PII yang masih bisa lolos dari ringkasan/peringatan LLM (jaring pengaman, BUKAN andalan tunggal).
 * Buang nomor panjang (HP/rekening/NIK), NIK eksplisit, & email — yang nyangkut ke DB + broadcast.
 * Nama orang tak bisa diandalkan via regex → ditahan di prompt ("tanpa identitas").
 */
export function scrubPII(s) {
  if (!s) return s;
  return String(s)
    .replace(/\bnik\s*:?\s*\d[\d\s.\-]*\d/gi, '[data disensor]')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[data disensor]')
    .replace(/\b\d[\d .\-]{7,}\d\b/g, '[data disensor]') // rangkaian digit panjang (≥9)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Label manusiawi untuk modus_key (dipakai digest "lagi marak" & dashboard).
const MODUS_LABEL = {
  biaya_pencairan: 'minta biaya pencairan/administrasi',
  minta_transfer: 'minta transfer/kirim uang',
  minta_pulsa: 'minta pulsa/voucher',
  link_palsu: 'link/aplikasi (APK) palsu',
  minta_data_pribadi: 'minta OTP/PIN/data pribadi',
  undian_hadiah_palsu: 'undian/hadiah palsu',
  lowongan_palsu: 'lowongan kerja palsu',
  investasi_bodong: 'investasi/trading bodong',
  pinjol_ilegal: 'pinjol ilegal',
  ngaku_petugas: 'ngaku petugas/bank/instansi',
  lainnya: 'modus lainnya',
};
export function humanModus(key) {
  return MODUS_LABEL[key] || String(key || 'modus lainnya').replace(/_/g, ' ');
}

// Petakan label verifikasi (claim.js) → status laporan (PRD §2).
function labelToStatus(label, scamKey) {
  if (label === 'contradict') return 'jelas_penipuan'; // bertentangan sumber resmi
  if (label === 'verified') return 'bukan_penipuan'; // ternyata cocok sumber (program asli)
  // unverified: tak ada di sumber → belum_pasti, KECUALI cocok pola penipuan → jelas_penipuan.
  return scamKey ? 'jelas_penipuan' : 'belum_pasti';
}

const SUMMARIZE_SYSTEM = `Kamu meringkas laporan penipuan/modus dari warga untuk arsip dan peringatan komunitas.

ATURAN KERAS:
- BUANG semua identitas & data pribadi (nama, nomor HP, alamat, NIK) — jangan disertakan sama sekali.
- Ringkas MODUSNYA secara umum & netral, bukan kasusnya secara spesifik.
- Nilai apakah laporan mencurigakan sebagai penipuan meski belum tentu pasti.

Output WAJIB JSON valid:
{
  "isi_ringkas": "string",      // 1 kalimat modus tanpa data pribadi
  "modus_key": "string",        // snake_case: "ngaku_petugas" | "link_palsu" | "undian_hadiah_palsu" | "investasi_bodong" | "lainnya"
  "teks_peringatan": "string",  // 1-2 kalimat peringatan umum untuk warga, tanpa identitas
  "mencurigakan": true|false,   // true bila berpotensi penipuan
  "penilaian": "string"         // 1 kalimat alasan singkat
}`;
const FALLBACK_PERINGATAN = 'Ada laporan modus penipuan yang beredar. ' +
  'Jangan transfer uang/pulsa, klik link mencurigakan, atau beri data pribadi (OTP/PIN/NIK).';


  
async function summarizeLaporan(text, scamKey) {
  if (!hasLLM()) {
    return {
      isi_ringkas: String(text).slice(0, 200),
      modus_key: scamKey || 'lainnya',
      teks_peringatan: FALLBACK_PERINGATAN,
      mencurigakan: Boolean(scamKey),
      penilaian: scamKey ? 'Cocok pola modus penipuan yang dikenal.' : null,
    };
  }
  try {
    const r = await chatJson({
      tier: 'fast',
      temperature: 0.2,
      maxTokens: 260,
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: `LAPORAN WARGA:\n"""${String(text).slice(0, 1500)}"""` },
      ],
    });
    return {
      isi_ringkas: r?.isi_ringkas?.trim() || String(text).slice(0, 200),
      modus_key: (r?.modus_key || scamKey || 'lainnya').toString().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
      teks_peringatan: r?.teks_peringatan?.trim() || FALLBACK_PERINGATAN,
      mencurigakan: r?.mencurigakan !== false, // default anggap mencurigakan (jangan menolak modus baru)
      penilaian: r?.penilaian?.trim() || null,
    };
  } catch {
    return {
      isi_ringkas: String(text).slice(0, 200),
      modus_key: scamKey || 'lainnya',
      teks_peringatan: FALLBACK_PERINGATAN,
      mencurigakan: true,
      penilaian: null,
    };
  }
}

/** Balasan instan ke pelapor — diterima & ditinjau (AI tak tidur), broadcast nunggu approval. */
const ACK =
  '✅ Laporan kamu *diterima* dan lagi kami tinjau ya. Makasih udah bantu jagain warga lain dari penipuan 🙏\n\n' +
  '⚠️ Hati-hati: kalau ada yang minta *transfer uang, pulsa, atau data pribadi (OTP/PIN/NIK)*, ngajak *klik link*, ' +
  'atau *ngaku petugas/bank/CS* — itu tanda penipuan. Jangan dituruti dulu, dan jangan kasih kode apa pun.\n\n' +
  '_(Kalau terbukti, peringatan akan disebar ke grup daerahmu setelah ditinjau pengurus — tanpa menyebut identitasmu.)_';

function formatLaporanReply({ status, ringkas, wilayahTag }) {
  const danger = status === 'jelas_penipuan';
  const safe = status === 'bukan_penipuan';
  const conclusion = danger
    ? '🚨 INI PENIPUAN. Jangan dilanjutkan.'
    : safe
      ? '✅ Ini belum terlihat sebagai penipuan dari sumber resmi.'
      : '⚠️ HATI-HATI. Ini belum bisa dipastikan aman.';
  const modus = scrubPII(ringkas?.isi_ringkas) || 'Ada modus mencurigakan yang dilaporkan warga.';
  const warning = scrubPII(ringkas?.teks_peringatan) || FALLBACK_PERINGATAN;
  const wilayah = wilayahTag ? ` untuk wilayah *${humanWilayah(wilayahTag)}*` : '';

  if (safe) {
    return `${conclusion}

Yang perlu diketahui:
• ${modus}
• Tetap cek lewat kanal resmi atau tanya RT/kelurahan sebelum mengikuti arahan apa pun.

🔢 Yang aman Bapak/Ibu lakukan:
1. Cek status bantuan lewat cekbansos.kemensos.go.id atau petugas setempat.
2. Jangan bayar biaya apa pun.
3. Jangan kirim OTP, PIN, password, NIK, atau data pribadi ke orang yang menghubungi duluan.

💡 Ingat: ${warning}

✅ Laporan Bapak/Ibu sudah saya catat${wilayah}. Nanti ditinjau pengurus dulu sebelum peringatan disebar ke warga lain.`;
  }

  return `${conclusion}

${danger ? 'Kenapa bahaya:' : 'Kenapa perlu hati-hati:'}
• ${modus}
• Modus seperti ini bisa dipakai untuk mencuri uang, data pribadi, atau isi HP Bapak/Ibu.

🔢 Yang harus Bapak/Ibu lakukan SEKARANG:
1. Jangan klik link, file APK, atau tombol apa pun dari pesan itu.
2. Jangan kirim OTP, PIN, password, NIK, atau uang.
3. Blokir pengirimnya.
4. Kalau sudah terlanjur klik/install/kirim data, 📞 hubungi keluarga sekarang dan segera telepon bank.

💡 Ingat: ${warning}

✅ Laporan Bapak/Ibu sudah saya catat${wilayah}. Nanti ditinjau pengurus dulu sebelum peringatan disebar ke warga lain.`;
}

/**
 * Proses sebuah laporan yang wilayahnya SUDAH diketahui.
 * Verifikasi → status → ringkas → simpan/cluster. TIDAK broadcast (nunggu approval).
 * @returns {Promise<{reply:string, laporan:object, status:string, clustered:boolean}>}
 */
export async function prosesLaporan({ text, wilayahTag, scopeTags = null }) {
  const verify = await checkClaim(text, { scopeTags }).catch(() => null);
  const label = verify?.label || 'unverified';
  const scamKey = matchScamPattern(text);
  const status = labelToStatus(label, scamKey);
  const sourceUrls = verify?.sources || [];

  const ringkas = await summarizeLaporan(text, scamKey);
  // Dasar tinjauan: kalau ada hasil cek sumber pakai itu. Untuk laporan yang TIDAK cocok pola
  // & tak ada di sumber (status belum_pasti, sering = modus baru), pakai PENILAIAN LLM sebagai
  // dasar — jangan ditolak, biar tetap masuk antrian tinjau & ikut clustering kalau makin rame.
  let dasar = verify?.alasan || null;
  if (scamKey && label === 'unverified') {
    dasar = `Cocok pola ${humanModus(scamKey)}. Belum ada sumber resmi yang mengonfirmasi klaim ini, jadi perlu tinjauan pengurus sebelum disebar.`;
  }
  if (status === 'belum_pasti' && !scamKey) {
    dasar =
      ringkas.penilaian ||
      'Belum ada di sumber resmi & belum cocok pola yang dikenal — kemungkinan modus baru, perlu ditinjau pengurus.';
  }

  // Clustering (L5): laporan sejenis (modus + wilayah + status sama) → tambah counter,
  // bukan baris baru. Exact modus_key dicoba dulu, lalu fallback kemiripan ringkasan agar
  // hoaks/penipuan yang sama tapi diringkas agak beda tetap masuk satu grup.
  const existing = await findSimilarClusterLaporan({
    modusKey: ringkas.modus_key,
    wilayahTag,
    status,
    isiRingkas: ringkas.isi_ringkas,
  });
  let laporan;
  let clustered = false;
  if (existing) {
    laporan = await bumpLaporanSerupa(existing.id, {
      sourceUrls,
      dasarVerifikasi: dasar,
      teksPeringatan: ringkas.teks_peringatan,
      clusterReason: existing.cluster_reason,
    });
    clustered = true;
    if (laporan.jumlah_serupa === URGENT_THRESHOLD) notifyPengurusUrgent(laporan).catch(() => { });
  } else {
    const id = await insertLaporan({
      isiRingkas: ringkas.isi_ringkas,
      modusKey: ringkas.modus_key,
      wilayahTag,
      status,
      dasarVerifikasi: dasar,
      sourceUrls,
      teksPeringatan: ringkas.teks_peringatan,
    });
    laporan = { id, status, wilayah_tag: wilayahTag, modus_key: ringkas.modus_key, isi_ringkas: ringkas.isi_ringkas };
  }
  return { reply: formatLaporanReply({ status, ringkas, wilayahTag }) || ACK, laporan, status, clustered };
}

/**
 * TOOL untuk brain agentic: catat laporan yang SUDAH dinilai LLM (ringkasan no-PII + wilayah + status
 * + teks peringatan) ke pipeline lapor (cluster → simpan → antri approval). LLM yang menilai; fungsi ini
 * cuma eksekusi efek + dedup/cluster. TIDAK broadcast (nunggu approval pengurus).
 * @returns {{ok:boolean, alasan?:string, pesan?:string, status?:string, clustered?:boolean, wilayah?:string, jumlah_serupa?:number}}
 */
export async function simpanLaporanTool({ ringkasan_modus, wilayah_kabkota, tingkat_bahaya, teks_peringatan, wilayahTagGrup = null }) {
  // Wilayah: utamakan tag grup (sudah valid saat /start); japri → normalisasi input LLM, wajib kab/kota.
  let wilayahTag = wilayahTagGrup && isKabKota(wilayahTagGrup) ? wilayahTagGrup : null;
  if (!wilayahTag && wilayah_kabkota) {
    const norm = normalizeWilayahTag(wilayah_kabkota);
    if (isKabKota(norm)) wilayahTag = norm;
  }
  if (!wilayahTag) {
    return { ok: false, alasan: 'wilayah_belum_spesifik', pesan: 'Wilayah belum spesifik kabupaten/kota. Tanya warga dulu kab/kota kejadiannya, jangan catat dulu.' };
  }

  const status = ['jelas_penipuan', 'belum_pasti', 'bukan_penipuan'].includes(tingkat_bahaya) ? tingkat_bahaya : 'belum_pasti';
  // Saring PII SEBELUM disimpan/disebar (jaring pengaman; modus_key dideteksi dari teks yang sudah bersih).
  const isiRingkas = scrubPII(String(ringkasan_modus || '').slice(0, 300)) || 'Laporan modus penipuan dari warga.';
  const teksPeringatan = scrubPII(String(teks_peringatan || '').trim()) || FALLBACK_PERINGATAN;
  const modusKey = matchScamPattern(isiRingkas) || 'lainnya';

  // Cluster by exact modus first, then similar text. Tool reports do not carry source URLs,
  // so they stay in the "perlu verifikasi" dashboard section until reviewed.
  const existing = await findSimilarClusterLaporan({ modusKey, wilayahTag, status, isiRingkas });
  let laporan;
  let clustered = false;
  if (existing) {
    laporan = await bumpLaporanSerupa(existing.id, { clusterReason: existing.cluster_reason });
    clustered = true;
    // Fast-track: pas nyentuh ambang (sekali), ping pengurus untuk segera tinjau. Bukan auto-sebar.
    if (laporan.jumlah_serupa === URGENT_THRESHOLD) notifyPengurusUrgent(laporan).catch(() => { });
  } else {
    const id = await insertLaporan({
      isiRingkas,
      modusKey,
      wilayahTag,
      status,
      dasarVerifikasi: 'Dilaporkan warga; dinilai asisten Warta Warga.',
      teksPeringatan,
    });
    laporan = { id, jumlah_serupa: 1 };
  }
  return { ok: true, status, clustered, wilayah: humanWilayah(wilayahTag), jumlah_serupa: laporan.jumlah_serupa || 1 };
}

// ---------- State percakapan lapor (efemeral, RAM, TANPA identitas) ----------
// Dua tahap: (1) kumpulkan ISI laporan, lalu (2) wilayah (kalau japri & belum diketahui).
const pendingLapor = new Map(); // sessionId -> { stage:'content'|'wilayah', text, wilayahTag, ts }
const PENDING_TTL = 10 * 60 * 1000; // 10 menit

function getPending(sessionId) {
  const e = pendingLapor.get(sessionId);
  if (!e) return null;
  if (Date.now() - e.ts > PENDING_TTL) {
    pendingLapor.delete(sessionId);
    return null;
  }
  return e;
}

export function hasPendingLapor(sessionId) {
  return Boolean(getPending(sessionId));
}

const ASK_CONTENT =
  '🙏 Boleh, ceritakan kejadiannya ya — *modus penipuannya gimana?* ' +
  'Misal: "ada yang nelpon ngaku petugas, minta transfer biaya pencairan bansos". ' +
  '_(Nggak perlu sebut nama/nomor siapa pun.)_';

// Bug 1: klarifikasi ke-2 yang LEBIH memandu (bukan ngulang template) saat warga bingung/"gk tw".
const ASK_CONTENT_GUIDED =
  'Gapapa belum detail 🙏 Singkat aja — ada salah satu ini nggak:\n' +
  '• minta *uang/transfer*?\n• minta *OTP/PIN/data pribadi*?\n• ngajak *klik link*?\n• *ngaku* petugas/bank/CS?\n' +
  'Ceritain yang kamu inget aja, sepotong juga nggak apa-apa.';

// Bug 1: kalau tetap belum bisa cerita → tutup sopan & lepas pending (jangan muter selamanya).
const CONTENT_GIVEUP =
  'Oke, nggak apa-apa 🙏 Kalau nanti udah inget detail kejadiannya, chat aku lagi ya — nanti aku catat & tinjau. ' +
  'Tetap hati-hati: jangan transfer uang/kasih data pribadi ke pihak yang mencurigakan.';

const ASK_WILAYAH =
  '🙏 Oke, dicatat. Biar peringatannya tepat sasaran, *di daerah mana kejadiannya?* ' +
  '(sebut kabupaten/kota aja, mis. "Kab. Banyumas"). Aku nggak butuh nama/identitasmu kok.';

// Bug 2: wilayah kebaca tapi terlalu luas (provinsi/pulau/negara).
const ASK_WILAYAH_SPESIFIK =
  '🙏 Itu kelihatannya terlalu luas (provinsi/pulau). Sebut *kabupaten/kota*-nya ya, ' +
  'mis. "Kab. Bekasi" atau "Kota Bandung".';

// Apakah pesan SUDAH berisi deskripsi kejadian (bukan sekadar "mau lapor")?
function hasReportSubstance(text) {
  if (matchScamPattern(text)) return true; // ada indikasi modus → jelas ada isi
  const stripped = String(text)
    .toLowerCase()
    .replace(
      /\b(halo|hai|hi|pagi|siang|sore|malam|assalamualaikum|kak|min|bang|pak|bu|mas|mbak|aku|saya|mau|pengen|pingin|ingin|tolong|ada|nih|dong|ya|deh|lapor|laporan|laporkan|laporin|melaporkan|ngelapor|ngelaporin|ngadu|gak|ga|nggak|tidak|tdk|engga|enggak|tau|tahu|tw|gatau|lupa|bingung|kurang|paham|ngerti|juga|lagi|kok|sih|aja)\b/g,
      ' ',
    )
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const kata = stripped.split(/\s+/).filter((w) => w.length >= 3);
  return kata.length >= 3; // perlu beberapa kata bermakna yang mendeskripsikan kejadian
}

// Bug 2: validasi wilayah pakai LLM (tahu geografi Indonesia) — bukan daftar hardcoded.
// @returns {Promise<{spesifik:boolean, wilayah_tag:string|null}>}
const WILAYAH_SYSTEM = `Kamu validator wilayah Indonesia. Dari pesan warga, tentukan apakah menyebut KABUPATEN/KOTA yang SPESIFIK (bukan provinsi, pulau, atau negara).
Jawab JSON: {"spesifik": boolean, "level": "kabupaten"|"kota"|"provinsi"|"pulau"|"negara"|"tidak_ada", "wilayah": string|null}
Aturan:
- spesifik=true HANYA untuk kabupaten/kota nyata (mis. "Kab. Bekasi", "Kota Bandung", "Banyumas", "Sleman").
- "Jawa","Sumatra","Kalimantan","Sulawesi","Papua" = pulau → spesifik=false.
- "Jawa Barat","Jawa Tengah","DKI Jakarta","Banten" = provinsi → spesifik=false.
- "Indonesia"/"se-Indonesia" = negara → spesifik=false.
- wilayah = nama kab/kota bersih (tanpa kata "Kabupaten/Kab/Kota") bila spesifik, selain itu null.`;

async function validateWilayah(text) {
  if (!hasLLM()) {
    // Fallback tanpa LLM: parser sederhana, terima apa adanya (tanpa daftar hardcoded yang harus dirawat).
    const tag = detectWilayahFromText(text) || detectWilayahFromText(`kabupaten ${text}`);
    return { spesifik: Boolean(tag), wilayah_tag: tag };
  }
  try {
    const r = await chatJson({
      tier: 'fast',
      temperature: 0,
      maxTokens: 80,
      messages: [
        { role: 'system', content: WILAYAH_SYSTEM },
        { role: 'user', content: `PESAN: """${String(text).slice(0, 300)}"""` },
      ],
    });
    if (r?.spesifik && r.wilayah) {
      const prefix = r.level === 'kota' ? 'kota' : 'kabupaten';
      return { spesifik: true, wilayah_tag: normalizeWilayahTag(`${prefix} ${r.wilayah}`) };
    }
    return { spesifik: false, wilayah_tag: null };
  } catch {
    const tag = detectWilayahFromText(text) || detectWilayahFromText(`kabupaten ${text}`);
    return { spesifik: Boolean(tag), wilayah_tag: tag };
  }
}

// Lanjutkan setelah ISI laporan lengkap: tentukan wilayah → proses, atau tanya wilayah (japri).
async function lanjutkanLapor({ reportText, wilayahTag, scopeTags, sessionId }) {
  // Wilayah dari tag grup sudah valid (saat /start) → langsung proses.
  if (wilayahTag) {
    const { reply } = await prosesLaporan({ text: reportText, wilayahTag, scopeTags });
    return { reply };
  }
  // Japri: coba ambil + VALIDASI wilayah dari teks laporan.
  const v = await validateWilayah(reportText);
  if (v.spesifik && v.wilayah_tag) {
    const { reply } = await prosesLaporan({ text: reportText, wilayahTag: v.wilayah_tag, scopeTags });
    return { reply };
  }
  if (sessionId) pendingLapor.set(sessionId, { stage: 'wilayah', text: reportText, ts: Date.now() });
  return { reply: ASK_WILAYAH };
}

/**
 * Tangani pesan berjenis "lapor".
 * - Kalau belum ada ISI laporan ("mau lapor" doang) → tanya isinya dulu.
 * - Kalau sudah ada isi: grup → pakai tag grup; japri → tanya daerah bila belum disebut.
 * @returns {Promise<{reply:string}>}
 */
export async function handleLapor({ text, wilayahTag, scopeTags = null, sessionId = null }) {
  if (!hasReportSubstance(text)) {
    if (sessionId) pendingLapor.set(sessionId, { stage: 'content', wilayahTag: wilayahTag || null, tries: 1, ts: Date.now() });
    return { reply: ASK_CONTENT };
  }
  return lanjutkanLapor({ reportText: text, wilayahTag, scopeTags, sessionId });
}

/**
 * Pesan lanjutan saat ada percakapan lapor yang tertunda → tahap 'content' atau 'wilayah'.
 * @returns {Promise<{reply:string}|null>} null bila tak ada pending
 */
export async function consumeLaporReply({ sessionId, text, wilayahTag = null, scopeTags = null }) {
  const e = getPending(sessionId);
  if (!e) return null;

  if (e.stage === 'content') {
    if (hasReportSubstance(text)) {
      pendingLapor.delete(sessionId);
      return lanjutkanLapor({ reportText: text, wilayahTag: e.wilayahTag || wilayahTag, scopeTags, sessionId });
    }
    // Bug 1: belum ada isi → eskalasi (jangan ngulang template sama), lalu nyerah sopan.
    const tries = (e.tries || 1) + 1;
    if (tries >= 3) {
      pendingLapor.delete(sessionId);
      return { reply: CONTENT_GIVEUP };
    }
    pendingLapor.set(sessionId, { stage: 'content', wilayahTag: e.wilayahTag, tries, ts: Date.now() });
    return { reply: ASK_CONTENT_GUIDED };
  }

  // stage 'wilayah' → teks ini jawaban "daerah mana". Validasi via LLM (Bug 2).
  const v = await validateWilayah(text);
  if (!v.spesifik || !v.wilayah_tag) {
    return { reply: ASK_WILAYAH_SPESIFIK };
  }
  pendingLapor.delete(sessionId);
  const { reply } = await prosesLaporan({ text: e.text, wilayahTag: v.wilayah_tag, scopeTags });
  return { reply };
}

export { humanWilayah };
