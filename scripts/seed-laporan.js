// Seed 30 laporan aduan warga (penipuan/hoaks bansos) di level kabupaten/kota.
// Tiga laporan tambahan digabung ke baris seed lewat cosine similarity agar dashboard
// punya contoh cluster_reason='cosine' dan jumlah_serupa > 1.
// Data anonim: tidak ada nama, nomor HP, NIK, alamat detail, atau identitas pelapor.
//
// Kenapa kabupaten/kota, bukan provinsi:
// - Peta/geocoder lebih mudah menampilkan lokasi spesifik seperti Banyumas, Cilacap, Medan.
// - Tag tetap mengikuti konvensi app saat ini: "kabupaten:<slug>" juga dipakai untuk kota.
//
// Jalankan:
//   npm run seed:laporan

import postgres from 'postgres';
import {
  initDb,
  insertLaporan,
  bumpLaporanSerupa,
  getLaporan,
  trendingModus,
  listAntrianApproval,
  getDb,
} from '../src/db/index.js';
import { embed, cosine } from '../src/embeddings/index.js';
import { hasSupabase, config } from '../src/config.js';

const SEED_MARKER = 'Seed demo laporan kabupaten/kota';

const templates = {
  biaya_pencairan: {
    isi: (wilayah) => `Warga ${wilayah} menerima pesan mengatasnamakan petugas bansos yang meminta biaya administrasi sebelum bantuan dicairkan.`,
    peringatan: 'Waspada pesan yang meminta biaya administrasi untuk pencairan bansos. Bansos resmi tidak meminta transfer atau biaya apa pun.',
  },
  link_palsu: {
    isi: (wilayah) => `Beredar tautan pendaftaran bansos di ${wilayah} yang meminta warga mengisi data keluarga dan kode OTP.`,
    peringatan: 'Jangan isi data pribadi atau OTP melalui tautan pendaftaran bansos yang tidak jelas. Cek hanya kanal resmi pemerintah.',
  },
  ngaku_petugas: {
    isi: (wilayah) => `Ada pihak di ${wilayah} mengaku petugas pendamping bantuan dan menawarkan percepatan pencairan dengan meminta dokumen pribadi.`,
    peringatan: 'Verifikasi identitas petugas lewat RT/RW, kelurahan, atau dinas sosial sebelum menyerahkan dokumen pribadi.',
  },
  minta_transfer: {
    isi: (wilayah) => `Warga ${wilayah} diminta transfer uang jaminan supaya namanya dimasukkan ke daftar penerima bantuan tunai.`,
    peringatan: 'Penetapan penerima bansos tidak memakai uang jaminan. Tolak permintaan transfer dan laporkan ke pengurus setempat.',
  },
  minta_data_pribadi: {
    isi: (wilayah) => `Beredar formulir digital di ${wilayah} mengatasnamakan bantuan sosial yang meminta PIN, OTP, dan foto kartu keluarga.`,
    peringatan: 'PIN dan OTP tidak pernah dibutuhkan untuk pendaftaran bansos. Jangan bagikan data sensitif lewat formulir tidak resmi.',
  },
  undian_hadiah_palsu: {
    isi: (wilayah) => `Warga ${wilayah} diberi kabar menang undian bantuan sosial dan diminta membayar pajak hadiah terlebih dahulu.`,
    peringatan: 'Bansos bukan undian berhadiah. Jangan bayar pajak, admin, atau ongkos apa pun untuk klaim bantuan.',
  },
  minta_pulsa: {
    isi: (wilayah) => `Ada pesan di ${wilayah} mengatasnamakan panitia bantuan pendidikan yang meminta voucher pulsa untuk aktivasi bantuan.`,
    peringatan: 'Aktivasi bantuan resmi tidak menggunakan pulsa atau voucher. Abaikan permintaan pulsa yang mengatasnamakan bansos.',
  },
  investasi_bodong: {
    isi: (wilayah) => `Beredar tawaran di ${wilayah} untuk menggandakan dana bantuan lewat skema investasi cepat dengan imbal hasil harian.`,
    peringatan: 'Dana bantuan tidak perlu diinvestasikan ke skema cepat kaya. Waspadai janji imbal hasil tinggi dan cepat.',
  },
};

const wilayahSeed = [
  { label: 'Kota Banda Aceh', tag: 'kabupaten:banda_aceh', modusKey: 'biaya_pencairan' },
  { label: 'Kota Medan', tag: 'kabupaten:medan', modusKey: 'link_palsu' },
  { label: 'Kota Padang', tag: 'kabupaten:padang', modusKey: 'ngaku_petugas' },
  { label: 'Kota Pekanbaru', tag: 'kabupaten:pekanbaru', modusKey: 'minta_transfer' },
  { label: 'Kota Palembang', tag: 'kabupaten:palembang', modusKey: 'minta_data_pribadi' },
  { label: 'Kota Bandar Lampung', tag: 'kabupaten:bandar_lampung', modusKey: 'link_palsu' },
  { label: 'Kota Jakarta Selatan', tag: 'kabupaten:jakarta_selatan', modusKey: 'minta_transfer' },
  { label: 'Kota Tangerang', tag: 'kabupaten:tangerang', modusKey: 'undian_hadiah_palsu' },
  { label: 'Kabupaten Bogor', tag: 'kabupaten:bogor', modusKey: 'ngaku_petugas' },
  { label: 'Kabupaten Bekasi', tag: 'kabupaten:bekasi', modusKey: 'link_palsu' },
  { label: 'Kota Bandung', tag: 'kabupaten:bandung', modusKey: 'minta_data_pribadi' },
  { label: 'Kota Cirebon', tag: 'kabupaten:cirebon', modusKey: 'biaya_pencairan' },
  { label: 'Kabupaten Banyumas', tag: 'kabupaten:banyumas', modusKey: 'minta_transfer' },
  { label: 'Kabupaten Cilacap', tag: 'kabupaten:cilacap', modusKey: 'ngaku_petugas' },
  { label: 'Kota Semarang', tag: 'kabupaten:semarang', modusKey: 'link_palsu' },
  { label: 'Kota Surakarta', tag: 'kabupaten:surakarta', modusKey: 'minta_pulsa' },
  { label: 'Kabupaten Sleman', tag: 'kabupaten:sleman', modusKey: 'minta_data_pribadi' },
  { label: 'Kota Yogyakarta', tag: 'kabupaten:yogyakarta', modusKey: 'undian_hadiah_palsu' },
  { label: 'Kota Surabaya', tag: 'kabupaten:surabaya', modusKey: 'minta_transfer' },
  { label: 'Kota Malang', tag: 'kabupaten:malang', modusKey: 'link_palsu' },
  { label: 'Kabupaten Sidoarjo', tag: 'kabupaten:sidoarjo', modusKey: 'ngaku_petugas' },
  { label: 'Kota Denpasar', tag: 'kabupaten:denpasar', modusKey: 'minta_data_pribadi' },
  { label: 'Kabupaten Lombok Timur', tag: 'kabupaten:lombok_timur', modusKey: 'link_palsu' },
  { label: 'Kota Kupang', tag: 'kabupaten:kupang', modusKey: 'biaya_pencairan' },
  { label: 'Kota Pontianak', tag: 'kabupaten:pontianak', modusKey: 'ngaku_petugas' },
  { label: 'Kota Banjarmasin', tag: 'kabupaten:banjarmasin', modusKey: 'minta_transfer' },
  { label: 'Kota Balikpapan', tag: 'kabupaten:balikpapan', modusKey: 'investasi_bodong' },
  { label: 'Kota Makassar', tag: 'kabupaten:makassar', modusKey: 'link_palsu' },
  { label: 'Kota Manado', tag: 'kabupaten:manado', modusKey: 'undian_hadiah_palsu' },
  { label: 'Kota Jayapura', tag: 'kabupaten:jayapura', modusKey: 'ngaku_petugas' },
];

const cosineSeedReports = [
  {
    label: 'Kota Medan',
    wilayahTag: 'kabupaten:medan',
    isiRingkas:
      'Beredar tautan pendaftaran bansos di Kota Medan yang meminta warga mengisi data keluarga dan kode OTP untuk verifikasi penerima bantuan.',
    teksPeringatan:
      'Jangan isi data keluarga atau OTP melalui tautan pendaftaran bansos yang tidak jelas. Cek hanya kanal resmi pemerintah.',
  },
  {
    label: 'Kabupaten Banyumas',
    wilayahTag: 'kabupaten:banyumas',
    isiRingkas:
      'Warga Kabupaten Banyumas diminta transfer uang jaminan supaya namanya masuk daftar penerima bantuan tunai sosial.',
    teksPeringatan:
      'Penetapan penerima bansos tidak memakai uang jaminan. Tolak permintaan transfer dan laporkan ke pengurus setempat.',
  },
  {
    label: 'Kota Padang',
    wilayahTag: 'kabupaten:padang',
    isiRingkas:
      'Ada pihak di Kota Padang mengaku petugas pendamping bantuan, menawarkan percepatan pencairan, dan meminta dokumen pribadi warga.',
    teksPeringatan:
      'Verifikasi identitas petugas lewat RT/RW, kelurahan, atau dinas sosial sebelum menyerahkan dokumen pribadi.',
  },
];

async function clearOldSeedRows() {
  if (hasSupabase()) {
    const sql = postgres(config.supabase.dbUrl, { ssl: 'require', prepare: false, max: 1 });
    try {
      const result = await sql`
        DELETE FROM laporan
        WHERE dasar_verifikasi LIKE 'Seed demo:%'
           OR dasar_verifikasi LIKE ${`${SEED_MARKER}%`}`;
      return result.count || 0;
    } finally {
      await sql.end();
    }
  }

  return getDb()
    .prepare("DELETE FROM laporan WHERE dasar_verifikasi LIKE 'Seed demo:%' OR dasar_verifikasi LIKE ?")
    .run(`${SEED_MARKER}%`).changes;
}

async function seedCosineClusterReport(report, targetId) {
  const target = await getLaporan(targetId);
  const targetVec = target?.embedding
    ? (typeof target.embedding === 'string' ? JSON.parse(target.embedding) : target.embedding)
    : null;
  const reportVec = await embed(report.isiRingkas);
  const score = targetVec ? cosine(reportVec, targetVec) : 0;

  if (score < 0.75) {
    throw new Error(`Seed cosine gagal: skor ${report.label} hanya ${score.toFixed(3)}.`);
  }

  const updated = await bumpLaporanSerupa(targetId, {
    dasarVerifikasi: `${SEED_MARKER}: laporan tambahan sengaja dibuat mirip secara semantik untuk demo cosine similarity.`,
    teksPeringatan: report.teksPeringatan,
    clusterReason: 'cosine',
  });

  return {
    id: updated.id,
    label: report.label,
    score,
    jumlahSerupa: updated.jumlah_serupa,
  };
}

async function main() {
  await initDb();
  console.log(`Seed laporan aduan warga level kabupaten/kota -> ${hasSupabase() ? 'Supabase/Postgres' : `SQLite ${config.dbPath}`}`);

  const deleted = await clearOldSeedRows();
  if (deleted) console.log(`Bersihkan seed demo lama: ${deleted} laporan dihapus.`);

  let ok = 0;
  const seededIdsByTag = new Map();
  for (const item of wilayahSeed) {
    const template = templates[item.modusKey];
    const id = await insertLaporan({
      isiRingkas: template.isi(item.label),
      modusKey: item.modusKey,
      wilayahTag: item.tag,
      status: 'jelas_penipuan',
      dasarVerifikasi: `${SEED_MARKER}: pola laporan warga mengandung ciri penipuan bansos (biaya/transfer/OTP/link tidak resmi).`,
      teksPeringatan: template.peringatan,
    });
    seededIdsByTag.set(item.tag, id);
    ok += 1;
  }

  const cosineClusters = [];
  for (const report of cosineSeedReports) {
    cosineClusters.push(await seedCosineClusterReport(report, seededIdsByTag.get(report.wilayahTag)));
  }

  const antrian = await listAntrianApproval();
  const tren = await trendingModus({ days: 30, limit: 8 });

  console.log(`${ok}/${wilayahSeed.length} laporan tersimpan.`);
  console.log(`${cosineClusters.length} laporan tambahan digabung via cosine similarity:`);
  for (const cluster of cosineClusters) {
    console.log(
      `- ${cluster.label} -> laporan #${cluster.id}, score=${cluster.score.toFixed(3)}, jumlah_serupa=${cluster.jumlahSerupa}`,
    );
  }
  console.log(`Antrian approval jelas_penipuan: ${antrian.length} laporan.`);
  console.log('Wilayah seed:');
  for (const item of wilayahSeed) {
    console.log(`- ${item.label} -> ${item.tag}`);
  }
  console.log('Top modus 30 hari:');
  for (const row of tren) {
    console.log(`- ${row.modus_key}: ${row.total} laporan (${row.klaster} klaster)`);
  }
}

main().catch((err) => {
  console.error('Seed laporan gagal:', err);
  process.exit(1);
});
