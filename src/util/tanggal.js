// Format tanggal ringkas berbahasa Indonesia untuk ditampilkan di jawaban/broadcast.

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** "2026-06-19" / "31-08-2026" / ISO → "19 Jun 2026". Kembalikan apa adanya bila tak terbaca. */
export function formatTanggalID(iso) {
  if (!iso) return null;
  const d = parseLooseDate(iso) || new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
}

/** Ambil tanggal_ambil paling baru dari sekumpulan hit/record → string ID. */
export function latestTanggal(items) {
  const dates = (items || []).map((i) => i.tanggal_ambil).filter(Boolean).sort();
  return dates.length ? formatTanggalID(dates[dates.length - 1]) : null;
}

const BULAN_NAMA = {
  jan: 0, januari: 0, feb: 1, februari: 1, mar: 2, maret: 2, apr: 3, april: 3,
  mei: 4, jun: 5, juni: 5, jul: 6, juli: 6, agu: 7, agt: 7, agustus: 7,
  sep: 8, sept: 8, september: 8, okt: 9, oktober: 9, nov: 10, november: 10, des: 11, desember: 11,
};

function buatTanggal(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/**
 * Parse string yang ISINYA HANYA sebuah tanggal tunggal (anchored) → Date, atau null.
 * Sengaja ketat: teks jadwal bebas ("Disalurkan per tahap", "tiap awal triwulan") TIDAK cocok
 * → tidak dianggap tanggal, jadi tidak ikut tersaring sebagai "kedaluwarsa".
 */
export function parseLooseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m;
  if ((m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return buatTanggal(+m[1], +m[2], +m[3]); // ISO
  if ((m = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return buatTanggal(+m[3], +m[2], +m[1]); // DD-MM-YYYY
  if ((m = str.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/))) {
    const mo = BULAN_NAMA[m[2].toLowerCase()];
    if (mo != null) return buatTanggal(+m[3], mo + 1, +m[1]); // "19 Desember 2024"
  }
  return null;
}

/** True bila string adalah tanggal TUNGGAL yang sudah lewat (sebelum hari ini). */
export function isExpiredDate(s, now = new Date()) {
  const d = parseLooseDate(s);
  if (!d) return false; // bukan tanggal tunggal (mis. teks jadwal berulang) → biarkan tampil
  const hariIni = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime() < hariIni.getTime();
}

const STALE_DAYS = 60; // data yang lebih tua dari ini diberi catatan "mungkin sudah berubah"

/** Umur data dalam hari dari tanggal_ambil ke sekarang, atau null bila tak terbaca. */
function umurHari(iso, now) {
  if (!iso) return null;
  const d = parseLooseDate(iso) || new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (!d || Number.isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86400000);
}

/**
 * Catatan masa berlaku untuk SATU info/hit. Kembalikan string peringatan atau null.
 * Prioritas: batas pendaftaran yang sudah lewat > data yang sudah lama (basi).
 */
export function masaBerlakuNotice({ batas_daftar, tanggal_ambil } = {}, now = new Date()) {
  if (isExpiredDate(batas_daftar, now)) {
    return `⚠️ _Batas pendaftaran yang tertera (${formatTanggalID(batas_daftar)}) kemungkinan sudah lewat. Cek info terbaru di sumber atau tanya RT/pengurus._`;
  }
  const umur = umurHari(tanggal_ambil, now);
  if (umur != null && umur >= STALE_DAYS) {
    return `ℹ️ _Info ini terakhir diperbarui ${formatTanggalID(tanggal_ambil)} (sekitar ${umur} hari lalu), bisa jadi sudah berubah — cek sumber untuk versi terbaru._`;
  }
  return null;
}
