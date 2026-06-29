// Seed 10 laporan aduan warga khusus Kabupaten Banyumas.
// Mix penipuan (jelas_penipuan) + misinformasi (belum_pasti), semua PENDING.
// Modus yang sama di-cluster otomatis di dashboard web.
//
// Jalankan: node scripts/seed-banyumas.js

import postgres from 'postgres';
import { initDb, insertLaporan, getDb } from '../src/db/index.js';
import { hasSupabase, config } from '../src/config.js';

const SEED_MARKER = 'Seed Banyumas:';
const WILAYAH = 'kabupaten:banyumas';

const laporan = [
  // --- minta_transfer (3 warga) → dikelompokkan jadi 1 cluster ---
  {
    isiRingkas: 'Warga Kalibagor, Banyumas menerima pesan mengatasnamakan petugas bansos PKH yang meminta transfer Rp150.000 sebagai biaya administrasi sebelum bantuan dicairkan.',
    modusKey: 'minta_transfer',
    status: 'jelas_penipuan',
    teksPeringatan: 'Waspada penipuan bansos di Banyumas. Bantuan PKH tidak memerlukan biaya administrasi atau transfer apa pun. Laporkan ke RT/RW atau Dinsos setempat.',
  },
  {
    isiRingkas: 'Warga Sokaraja, Banyumas menerima WhatsApp dari nomor tidak dikenal mengaku staf kelurahan, meminta transfer uang jaminan agar masuk daftar penerima BLT.',
    modusKey: 'minta_transfer',
    status: 'jelas_penipuan',
    teksPeringatan: 'Waspada penipuan bansos di Banyumas. Bantuan PKH tidak memerlukan biaya administrasi atau transfer apa pun. Laporkan ke RT/RW atau Dinsos setempat.',
  },
  {
    isiRingkas: 'Warga Purwokerto Timur, Banyumas diminta membayar Rp200.000 via transfer ke rekening pribadi agar namanya terdaftar sebagai penerima bantuan sosial 2025.',
    modusKey: 'minta_transfer',
    status: 'jelas_penipuan',
    teksPeringatan: 'Waspada penipuan bansos di Banyumas. Bantuan PKH tidak memerlukan biaya administrasi atau transfer apa pun. Laporkan ke RT/RW atau Dinsos setempat.',
  },

  // --- link_palsu (3 warga) → dikelompokkan jadi 1 cluster ---
  {
    isiRingkas: 'Beredar tautan pendaftaran bansos palsu menyerupai situs Kemensos yang menyebar di grup WhatsApp warga Ajibarang, Banyumas dan meminta data KK serta foto KTP.',
    modusKey: 'link_palsu',
    status: 'jelas_penipuan',
    teksPeringatan: 'Ada link pendaftaran bansos palsu beredar di Banyumas. Jangan klik atau isi data di tautan tidak resmi. Pendaftaran bansos hanya di cekbansos.kemensos.go.id.',
  },
  {
    isiRingkas: 'Warga Baturaden, Banyumas menerima kiriman link "cek status bansos 2025" yang mengarah ke situs palsu dan meminta nomor NIK, KK, serta kode OTP.',
    modusKey: 'link_palsu',
    status: 'jelas_penipuan',
    teksPeringatan: 'Ada link pendaftaran bansos palsu beredar di Banyumas. Jangan klik atau isi data di tautan tidak resmi. Pendaftaran bansos hanya di cekbansos.kemensos.go.id.',
  },
  {
    isiRingkas: 'Di grup RT Lumbir, Banyumas ada pesan berantai berisi link "verifikasi penerima bansos" yang ketika dibuka langsung meminta akses kontak dan data pribadi.',
    modusKey: 'link_palsu',
    status: 'jelas_penipuan',
    teksPeringatan: 'Ada link pendaftaran bansos palsu beredar di Banyumas. Jangan klik atau isi data di tautan tidak resmi. Pendaftaran bansos hanya di cekbansos.kemensos.go.id.',
  },

  // --- ngaku_petugas (2 warga) → dikelompokkan jadi 1 cluster ---
  {
    isiRingkas: 'Seseorang mengaku petugas Dinsos mendatangi rumah warga Jatilawang, Banyumas menawarkan percepatan pencairan bansos dengan syarat menyerahkan buku tabungan dan PIN ATM.',
    modusKey: 'ngaku_petugas',
    status: 'jelas_penipuan',
    teksPeringatan: 'Waspada oknum yang mengaku petugas bansos di Banyumas. Petugas resmi tidak pernah meminta buku tabungan, PIN, atau biaya apa pun saat kunjungan.',
  },
  {
    isiRingkas: 'Warga Karanglewas, Banyumas didatangi orang yang mengaku konsultan bansos dan menawarkan jasa pendaftaran ulang bansos 2025 dengan memungut biaya Rp100.000.',
    modusKey: 'ngaku_petugas',
    status: 'jelas_penipuan',
    teksPeringatan: 'Waspada oknum yang mengaku petugas bansos di Banyumas. Petugas resmi tidak pernah meminta buku tabungan, PIN, atau biaya apa pun saat kunjungan.',
  },

  // --- hoaks_bansos (1 misinformasi) ---
  {
    isiRingkas: 'Beredar informasi di grup WhatsApp warga Banyumas bahwa pemerintah akan membagikan bantuan sembako gratis senilai Rp500.000 untuk semua KK tanpa syarat mulai bulan depan.',
    modusKey: 'hoaks_bansos',
    status: 'belum_pasti',
    teksPeringatan: 'Informasi bantuan sembako gratis tanpa syarat untuk semua KK di Banyumas belum terkonfirmasi. Tunggu pengumuman resmi dari Dinsos atau kelurahan setempat.',
  },

  // --- undian_hadiah_palsu (1 penipuan) ---
  {
    isiRingkas: 'Warga Purwojati, Banyumas menerima SMS yang menyatakan menang undian bansos berhadiah Rp10 juta dan diminta membayar pajak hadiah Rp500.000 ke rekening pribadi.',
    modusKey: 'undian_hadiah_palsu',
    status: 'jelas_penipuan',
    teksPeringatan: 'Penipuan undian berhadiah mengatasnamakan bansos terdeteksi di Banyumas. Bansos bukan undian dan tidak ada pajak hadiah. Abaikan dan blokir nomor pengirim.',
  },
];

async function clearOldSeedRows() {
  if (hasSupabase()) {
    const sql = postgres(config.supabase.dbUrl, { ssl: 'require', prepare: false, max: 1 });
    try {
      const result = await sql`DELETE FROM laporan WHERE dasar_verifikasi LIKE ${`${SEED_MARKER}%`}`;
      return result.count || 0;
    } finally {
      await sql.end();
    }
  }
  return getDb()
    .prepare('DELETE FROM laporan WHERE dasar_verifikasi LIKE ?')
    .run(`${SEED_MARKER}%`).changes;
}

async function main() {
  await initDb();
  console.log(`Seed 10 laporan Banyumas → ${hasSupabase() ? 'Supabase/Postgres' : `SQLite ${config.dbPath}`}`);

  const deleted = await clearOldSeedRows();
  if (deleted) console.log(`Bersihkan seed lama: ${deleted} laporan dihapus.`);

  let ok = 0;
  for (const l of laporan) {
    await insertLaporan({
      isiRingkas: l.isiRingkas,
      modusKey: l.modusKey,
      wilayahTag: WILAYAH,
      status: l.status,
      dasarVerifikasi: `${SEED_MARKER} ${l.modusKey} — laporan warga Banyumas.`,
      teksPeringatan: l.teksPeringatan,
    });
    ok++;
    console.log(`  ✓ [${l.status === 'belum_pasti' ? 'MISINFORMASI' : 'PENIPUAN'}] ${l.modusKey} — ${l.isiRingkas.slice(0, 60)}...`);
  }

  console.log(`\n${ok}/${laporan.length} laporan tersimpan untuk Kabupaten Banyumas.`);
  console.log('\nKlaster yang terbentuk di dashboard:');
  console.log('  • minta_transfer   → 3 laporan');
  console.log('  • link_palsu       → 3 laporan');
  console.log('  • ngaku_petugas    → 2 laporan');
  console.log('  • hoaks_bansos     → 1 laporan (misinformasi)');
  console.log('  • undian_hadiah    → 1 laporan');
}

main().catch((err) => {
  console.error('Seed Banyumas gagal:', err);
  process.exit(1);
});
