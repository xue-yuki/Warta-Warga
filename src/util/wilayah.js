// Filter wilayah hierarkis (Bagian 6.3 PRD).
// Info dipakai untuk sebuah grup jika wilayah_tag info termasuk:
//   "nasional" ATAU provinsi grup ATAU kabupaten grup.

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
