// Filter wilayah hierarkis (Bagian 6.3 PRD).
// Info dipakai untuk sebuah grup jika wilayah_tag info termasuk:
//   "nasional" ATAU provinsi grup ATAU kabupaten grup.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** Normalisasi tag wilayah bebas → bentuk baku. */
export function normalizeWilayahTag(input) {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase();
  if (raw === 'nasional' || raw === 'national') return 'nasional';
  // Tangkap prefiks level walau pakai titik/titik dua/spasi: "kab.", "kab:", "kabupaten ", dst.
  const m = raw.match(/^(kabupaten|provinsi|kota|kab|prov)\b\.?\s*:?\s*(.+)$/);
  if (m) {
    const level = m[1].startsWith('prov') ? 'provinsi' : 'kabupaten';
    return `${level}:${slug(m[2])}`;
  }
  // Tanpa prefiks level → anggap nama daerah kabupaten/kota
  return `kabupaten:${slug(raw)}`;
}

// ---------- Validasi wilayah nyata (cegah /start ke daerah yang tak ada, mis. typo) ----------
// Daftar 479 kabupaten/kota + 34 provinsi resmi (sumber BPS Indonesia 2024, sinkron dengan
// warta-warga-web/src/app/lib/indonesia-coordinates.json). Tanpa ini, /start menerima APA SAJA
// (cuma di-slug-kan, tak pernah divalidasi) → grup bisa ke-daftar ke daerah fiktif (typo "Jomokerto"
// alih-alih "Mojokerto") dan diam-diam tak akan pernah dapat info wilayah/broadcast selamanya.
let _wilayahData = null;
function loadWilayahData() {
  if (_wilayahData) return _wilayahData;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '../../data/wilayah_valid.json'), 'utf8');
    const parsed = JSON.parse(raw);
    _wilayahData = {
      kabKota: new Set(parsed.kabupaten_kota || []),
      provinsi: new Set(parsed.provinsi || []),
    };
  } catch (e) {
    console.warn('[wilayah] Gagal baca data/wilayah_valid.json — validasi /start dilewati:', e.message);
    _wilayahData = { kabKota: new Set(), provinsi: new Set() };
  }
  return _wilayahData;
}

/** Jarak edit (Levenshtein) sederhana — dipakai untuk saran "maksud Anda ...?" saat typo. */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/** Cari nama daerah terdekat di daftar resmi (untuk saran typo). null bila tak ada yang cukup dekat. */
function closestMatch(target, candidates) {
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  // Ambang toleransi typo relatif thd panjang nama (nama pendek → toleransi lebih ketat).
  const tolerance = Math.max(1, Math.floor(target.length * 0.3));
  return best && bestDist <= tolerance ? { name: best, distance: bestDist } : null;
}

const humanizeSlug = (s) => s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Validasi APAKAH wilayah_tag hasil normalizeWilayahTag() itu daerah yang BENAR-BENAR ADA
 * (kabupaten/kota/provinsi resmi Indonesia, atau "nasional"). Dipakai saat /start supaya tak ada
 * grup ter-registrasi ke daerah fiktif/typo.
 * @returns {{ok: boolean, suggestion: string|null}} suggestion = label manusiawi kandidat terdekat bila typo terdeteksi
 */
export function validateWilayahExists(wilayahTag) {
  if (!wilayahTag || wilayahTag === 'nasional') return { ok: true, suggestion: null };
  const data = loadWilayahData();
  // Data belum berhasil dimuat (mis. file hilang) → jangan blokir registrasi, cukup lewati validasi.
  if (data.kabKota.size === 0 && data.provinsi.size === 0) return { ok: true, suggestion: null };

  const [level, name] = wilayahTag.split(':');
  if (level === 'provinsi') {
    if (data.provinsi.has(name)) return { ok: true, suggestion: null };
    const match = closestMatch(name, data.provinsi);
    return { ok: false, suggestion: match ? `Prov. ${humanizeSlug(match.name)}` : null };
  }
  // level === 'kabupaten' (satu-satunya level non-provinsi yang dihasilkan normalizeWilayahTag)
  if (data.kabKota.has(name)) return { ok: true, suggestion: null };
  const match = closestMatch(name, data.kabKota);
  return { ok: false, suggestion: match ? humanizeSlug(match.name) : null };
}

/**
 * Bangun daftar tag yang relevan untuk sebuah grup.
 * Digunakan untuk filter chunk RAG & broadcast.
 */
export function groupScopeTags(grup) {
  const tags = new Set(['nasional']);
  if (grup?.wilayah_tag) tags.add(grup.wilayah_tag);
  if (grup?.provinsi_tag) tags.add(grup.provinsi_tag);
  return [...tags];
}

/** Apakah info dengan tag tertentu berlaku untuk scope grup ini? */
export function infoMatchesScope(infoTag, scopeTags) {
  if (!infoTag) return true;
  if (infoTag === 'nasional') return true;
  return scopeTags.includes(infoTag);
}

/** Tebak provinsi dari sebuah tag kabupaten/kota (peta terkurasi; tetap parsial untuk daerah lain). */
const KAB_TO_PROV = {
  // Jawa Barat
  'kabupaten:bogor': 'provinsi:jawa_barat',
  'kabupaten:bekasi': 'provinsi:jawa_barat',
  'kabupaten:bandung': 'provinsi:jawa_barat',
  'kabupaten:bandung_barat': 'provinsi:jawa_barat',
  'kabupaten:depok': 'provinsi:jawa_barat',
  'kabupaten:cianjur': 'provinsi:jawa_barat',
  'kabupaten:sukabumi': 'provinsi:jawa_barat',
  'kabupaten:garut': 'provinsi:jawa_barat',
  'kabupaten:tasikmalaya': 'provinsi:jawa_barat',
  'kabupaten:cirebon': 'provinsi:jawa_barat',
  'kabupaten:karawang': 'provinsi:jawa_barat',
  'kabupaten:subang': 'provinsi:jawa_barat',
  'kabupaten:purwakarta': 'provinsi:jawa_barat',
  'kabupaten:indramayu': 'provinsi:jawa_barat',
  // Jawa Tengah
  'kabupaten:banyumas': 'provinsi:jawa_tengah',
  'kabupaten:cilacap': 'provinsi:jawa_tengah',
  'kabupaten:purbalingga': 'provinsi:jawa_tengah',
  'kabupaten:banjarnegara': 'provinsi:jawa_tengah',
  'kabupaten:semarang': 'provinsi:jawa_tengah',
  'kabupaten:magelang': 'provinsi:jawa_tengah',
  'kabupaten:solo': 'provinsi:jawa_tengah',
  'kabupaten:surakarta': 'provinsi:jawa_tengah',
  // Jawa Timur
  'kabupaten:surabaya': 'provinsi:jawa_timur',
  'kabupaten:malang': 'provinsi:jawa_timur',
  'kabupaten:sidoarjo': 'provinsi:jawa_timur',
  'kabupaten:gresik': 'provinsi:jawa_timur',
  // DIY / DKI / Banten
  'kabupaten:sleman': 'provinsi:di_yogyakarta',
  'kabupaten:bantul': 'provinsi:di_yogyakarta',
  'kabupaten:tangerang': 'provinsi:banten',
  'kabupaten:serang': 'provinsi:banten',
};

export function inferProvinsiTag(wilayahTag) {
  if (!wilayahTag) return null;
  if (wilayahTag.startsWith('provinsi:')) return wilayahTag;
  return KAB_TO_PROV[wilayahTag] || null;
}

/** Apakah tag menunjuk kabupaten/kota tertentu (bukan nasional/provinsi)? */
export function isKabKota(tag) {
  return typeof tag === 'string' && tag.startsWith('kabupaten:');
}

/** Label manusiawi: "kabupaten:bogor" → "Kab. Bogor", "provinsi:jawa_barat" → "Prov. Jawa Barat". */
export function humanWilayah(tag) {
  if (!tag || tag === 'nasional') return 'Nasional';
  const [level, name] = tag.split(':');
  const title = (name || '').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  if (level === 'provinsi') return `Prov. ${title}`;
  return `Kab./Kota ${title}`;
}

/**
 * Tebak wilayah yang DISEBUT user di teks, mis. "ada bansos di kab bogor?" → "kabupaten:bogor".
 * Hanya menangkap bila ada kata kunci level (kabupaten/kab/kota) agar tidak salah tebak.
 * @returns {string|null} wilayah_tag atau null
 */
const STOP_DAERAH = new Set([
  'dong', 'ya', 'yah', 'kak', 'sih', 'nih', 'deh', 'dgn', 'dan', 'atau', 'apa', 'apakah', 'ada', 'gak', 'ga',
  'nggak', 'engga', 'enggak', 'kah', 'info', 'tentang', 'bansos', 'bantuan', 'sosial', 'di', 'itu', 'tuh', 'min',
  'kak', 'pak', 'bu', 'mas', 'mbak', 'tau', 'tahu', 'cek', 'gimana', 'bagaimana', 'berapa', 'kapan',
  // kata ganti/penunjuk → bukan nama daerah ("kabupaten saya", "kota ini")
  'saya', 'aku', 'kami', 'kita', 'sini', 'sana', 'ini', 'situ', 'daerahku', 'daerah', 'tempatku', 'tempat',
  // kata WAKTU & filler umum → sering salah tertangkap ("kota saat ini", "kota sekarang")
  'saat', 'sekarang', 'skrg', 'kini', 'kemarin', 'besok', 'nanti', 'tadi', 'barusan',
  'ku', 'mu', 'nya', 'dia', 'mereka', 'kamu', 'mana', 'yang', 'sekitar', 'wilayah', 'kotaku', 'kotamu',
]);

export function detectWilayahFromText(text) {
  if (!text) return null;
  // Tangkap "kab.bandung", "kab. bandung", "kab bandung", "kabupaten bandung", "kota ...", dst.
  const m = String(text).match(/\b(kabupaten|provinsi|kota|kab|prov)\b\.?\s*:?\s*([a-zA-Z][a-zA-Z\s]*)/i);
  if (!m) return null;
  // Ambil kata-kata nama daerah, buang filler ("dong", "ya", "ada", dst). Maks 2 kata.
  const words = [];
  for (const w of m[2].trim().split(/\s+/)) {
    if (STOP_DAERAH.has(w.toLowerCase())) break;
    words.push(w);
    if (words.length === 2) break;
  }
  if (words.length === 0) return null;
  const level = /^prov/i.test(m[1]) ? 'provinsi' : 'kabupaten';
  return normalizeWilayahTag(`${level} ${words.join(' ')}`);
}

export { slug };
