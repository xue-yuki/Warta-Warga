// Format tanggal ringkas berbahasa Indonesia untuk ditampilkan di jawaban/broadcast.

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** "2026-06-19" / ISO → "19 Jun 2026". Kembalikan apa adanya bila tak terbaca. */
export function formatTanggalID(iso) {
  if (!iso) return null;
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getDate()} ${BULAN[d.getMonth()]} ${d.getFullYear()}`;
}

/** Ambil tanggal_ambil paling baru dari sekumpulan hit/record → string ID. */
export function latestTanggal(items) {
  const dates = (items || []).map((i) => i.tanggal_ambil).filter(Boolean).sort();
  return dates.length ? formatTanggalID(dates[dates.length - 1]) : null;
}
