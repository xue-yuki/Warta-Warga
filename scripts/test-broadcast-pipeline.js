// Test pipeline broadcast peringatan: admin approve → bot kirim ke grup WA yang terdaftar.
// Jalankan: node scripts/test-broadcast-pipeline.js
//
// Menggunakan SQLite terpisah + broadcaster mock (tanpa koneksi WA asli).
// Mencakup: alur normal, fallback teks saat gambar gagal, deteksi no-sender, tak-ada-grup.

process.env.SUPABASE_DB_URL = '';
process.env.DB_PATH = './data/_test_broadcast.db';
process.env.EMBEDDINGS_PROVIDER = 'hashing';

import fs from 'node:fs';
import path from 'node:path';

// Bersihkan DB tes sebelumnya
for (const s of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + s); } catch {}
}

const { initDb, upsertGrup, insertLaporan, getLaporan, setApprovalLaporan, wasPeringatanSent } = await import('../src/db/index.js');
const { setBroadcaster, broadcastPeringatan, broadcastPendingPeringatan, grupsForWilayah } = await import('../src/agent1/broadcast.js');

await initDb();

// ---------- helpers ----------
let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n📋 ${title}`);
}

// Seed grup terdaftar
await upsertGrup({ idGrup: 'TEST_BANYUMAS@g.us', daerah: 'Kab. Banyumas', wilayahTag: 'kabupaten:banyumas', provinsiTag: 'provinsi:jawa_tengah' });
await upsertGrup({ idGrup: 'TEST_BEKASI@g.us', daerah: 'Kab. Bekasi', wilayahTag: 'kabupaten:bekasi', provinsiTag: 'provinsi:jawa_barat' });

// Seed laporan
const idBanyumas = await insertLaporan({ isiRingkas: 'Penipuan transfer PKH Banyumas', modusKey: 'minta_transfer', wilayahTag: 'kabupaten:banyumas', status: 'jelas_penipuan' });
const idBekasi   = await insertLaporan({ isiRingkas: 'Link palsu Bekasi', modusKey: 'link_palsu', wilayahTag: 'kabupaten:bekasi', status: 'jelas_penipuan' });
const idNasional = await insertLaporan({ isiRingkas: 'Hoaks bansos nasional', modusKey: 'link_palsu', wilayahTag: 'nasional', status: 'jelas_penipuan' });

// ---------- TEST 1: grupsForWilayah ----------
section('TEST 1 — grupsForWilayah filter wilayah');
{
  const banyumasGrups = await grupsForWilayah('kabupaten:banyumas');
  ok('Banyumas → 1 grup', banyumasGrups.length === 1, `dapat ${banyumasGrups.length}`);
  ok('Banyumas JID benar', banyumasGrups[0]?.id_grup === 'TEST_BANYUMAS@g.us');

  const bekasiGrups = await grupsForWilayah('kabupaten:bekasi');
  ok('Bekasi → 1 grup', bekasiGrups.length === 1, `dapat ${bekasiGrups.length}`);

  const nasionalGrups = await grupsForWilayah('nasional');
  ok('Nasional → semua grup (2)', nasionalGrups.length === 2, `dapat ${nasionalGrups.length}`);

  const kosong = await grupsForWilayah('kabupaten:kupang');
  ok('Wilayah tidak terdaftar → 0 grup', kosong.length === 0);
}

// ---------- TEST 2: broadcastPeringatan — no-sender ----------
section('TEST 2 — broadcastPeringatan tanpa sender (bot offline)');
{
  setBroadcaster(null);
  await setApprovalLaporan(idBanyumas, 'disetujui', 'waspada penipuan');
  const laporan = await getLaporan(idBanyumas);
  const r = await broadcastPeringatan(laporan);
  ok('Reason = no-sender', r.reason === 'no-sender', `reason=${r.reason}`);
  ok('Sent = 0', r.sent === 0);
}

// ---------- TEST 3: broadcastPeringatan — belum disetujui ----------
section('TEST 3 — broadcastPeringatan laporan belum disetujui');
{
  const calls = [];
  setBroadcaster(async (jid, text) => calls.push({ jid, text }));

  const lapMenunggu = await getLaporan(idBekasi); // masih menunggu
  const r = await broadcastPeringatan(lapMenunggu);
  ok('Reason = belum-disetujui', r.reason === 'belum-disetujui', `reason=${r.reason}`);
  ok('Sender tidak dipanggil', calls.length === 0);
}

// ---------- TEST 4: broadcastPeringatan — alur normal ----------
section('TEST 4 — broadcastPeringatan alur normal (pesan teks berhasil)');
{
  const calls = [];
  setBroadcaster(async (jid, text, imagePath) => {
    calls.push({ jid, text, imagePath });
  });

  await setApprovalLaporan(idBekasi, 'disetujui', 'waspada link palsu');
  const laporan = await getLaporan(idBekasi);
  const r = await broadcastPeringatan(laporan);

  ok('Sent = 1 (ke Bekasi)', r.sent === 1, `sent=${r.sent}`);
  ok('Sender dipanggil 1x', calls.length === 1, `calls=${calls.length}`);
  ok('Dikirim ke grup Bekasi', calls[0]?.jid === 'TEST_BEKASI@g.us');
  ok('Tidak ada imagePath (teks saja)', calls[0]?.imagePath == null);

  const sudahDikirim = await wasPeringatanSent(idBekasi);
  ok('Laporan tercatat sudah terkirim', sudahDikirim === true);
}

// ---------- TEST 5: broadcastPeringatan — sudah terkirim (dedup) ----------
section('TEST 5 — broadcastPeringatan dedup (sudah dikirim sebelumnya)');
{
  const calls = [];
  setBroadcaster(async (jid, text) => calls.push(jid));

  const laporan = await getLaporan(idBekasi);
  const r = await broadcastPeringatan(laporan);
  ok('Reason = sudah-dikirim', r.reason === 'sudah-dikirim', `reason=${r.reason}`);
  ok('Sender tidak dipanggil ulang', calls.length === 0);
}

// ---------- TEST 6: broadcastPeringatan — tak-ada-grup ----------
section('TEST 6 — broadcastPeringatan tak ada grup untuk wilayah');
{
  const calls = [];
  setBroadcaster(async (jid, text) => calls.push(jid));

  // idNasional belum disetujui — set dulu
  await setApprovalLaporan(idNasional, 'disetujui', 'waspada nasional');
  // Hapus sementara semua grup untuk wilayah nasional → nasional sebenarnya match semua grup
  // Buat laporan wilayah yang tidak ada grupnya
  const idTanpaGrup = await insertLaporan({ isiRingkas: 'Penipuan Kupang', modusKey: 'minta_transfer', wilayahTag: 'kabupaten:kupang', status: 'jelas_penipuan' });
  await setApprovalLaporan(idTanpaGrup, 'disetujui', 'waspada');
  const laporan = await getLaporan(idTanpaGrup);
  const r = await broadcastPeringatan(laporan);
  ok('Reason = tak-ada-grup', r.reason === 'tak-ada-grup', `reason=${r.reason}`);
  ok('Sent = 0', r.sent === 0);
  ok('Sender tidak dipanggil', calls.length === 0);
}

// ---------- TEST 7: fallback teks saat gambar gagal ----------
section('TEST 7 — fallback teks saat image send gagal');
{
  const textOnlyCalls = [];
  const imageCalls = [];

  setBroadcaster(async (jid, text, imagePath) => {
    if (imagePath) {
      imageCalls.push(jid);
      throw new Error('Simulasi: Baileys gagal kirim gambar');
    }
    textOnlyCalls.push(jid);
  });

  // Buat laporan baru untuk tes ini (idBanyumas sudah terkirim, pakai yang baru)
  const idBaruBanyumas = await insertLaporan({ isiRingkas: 'Modus baru Banyumas', modusKey: 'ngaku_petugas', wilayahTag: 'kabupaten:banyumas', status: 'jelas_penipuan' });
  await setApprovalLaporan(idBaruBanyumas, 'disetujui', 'waspada');
  const laporan = await getLaporan(idBaruBanyumas);

  // Sediakan path gambar palsu (ada di disk) agar broadcastPeringatan meneruskan imagePath ke sendToGrups
  const dummyImagePath = path.join('./data', '_test_dummy.png');
  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(dummyImagePath, Buffer.from('PNGFAKE'));

  const r = await broadcastPeringatan(laporan, { imagePath: dummyImagePath });

  ok('Gambar dicoba kirim', imageCalls.length === 1, `imageCalls=${imageCalls.length}`);
  ok('Fallback teks berhasil', textOnlyCalls.length === 1, `textOnlyCalls=${textOnlyCalls.length}`);
  ok('Dikirim ke Banyumas', textOnlyCalls[0] === 'TEST_BANYUMAS@g.us');
  ok('Sent = 1 (fallback berhasil)', r.sent === 1, `sent=${r.sent}`);

  fs.unlinkSync(dummyImagePath);
}

// ---------- TEST 8: fallback teks saat KEDUA cara gagal → kirim-gagal ----------
section('TEST 8 — broadcastPeringatan reason=kirim-gagal saat semua cara gagal');
{
  setBroadcaster(async (jid, text, imagePath) => {
    throw new Error('Simulasi: WA server error');
  });

  const idGagal = await insertLaporan({ isiRingkas: 'Laporan kirim gagal', modusKey: 'link_palsu', wilayahTag: 'kabupaten:banyumas', status: 'jelas_penipuan' });
  await setApprovalLaporan(idGagal, 'disetujui', 'waspada');
  const laporan = await getLaporan(idGagal);

  const r = await broadcastPeringatan(laporan);
  ok('Reason = kirim-gagal', r.reason === 'kirim-gagal', `reason=${r.reason}`);
  ok('Sent = 0', r.sent === 0);
  // Laporan TIDAK boleh ditandai terkirim sehingga bisa dicoba ulang
  const marked = await wasPeringatanSent(idGagal);
  ok('Laporan belum ditandai terkirim (bisa retry)', marked === false);
}

// ---------- TEST 9: broadcastPendingPeringatan ----------
section('TEST 9 — broadcastPendingPeringatan batch semua approved-pending');
{
  const calls = [];
  setBroadcaster(async (jid, text) => calls.push(jid));

  // Buat 2 laporan baru yang belum terkirim, approved, wilayah berbeda
  const idP1 = await insertLaporan({ isiRingkas: 'Pending 1 Banyumas', modusKey: 'minta_transfer', wilayahTag: 'kabupaten:banyumas', status: 'jelas_penipuan' });
  const idP2 = await insertLaporan({ isiRingkas: 'Pending 2 Bekasi', modusKey: 'link_palsu', wilayahTag: 'kabupaten:bekasi', status: 'jelas_penipuan' });
  await setApprovalLaporan(idP1, 'disetujui', 'waspada');
  await setApprovalLaporan(idP2, 'disetujui', 'waspada');

  const r = await broadcastPendingPeringatan();
  ok('Setidaknya 2 grup menerima pesan', r.sent >= 2, `sent=${r.sent}`);
  ok('Setidaknya 2 laporan dibroadcast', r.infos >= 2, `infos=${r.infos}`);
  ok('Sender dipanggil ≥2x', calls.length >= 2, `calls=${calls.length}`);

  const p1Sent = await wasPeringatanSent(idP1);
  const p2Sent = await wasPeringatanSent(idP2);
  ok('Laporan 1 tercatat terkirim', p1Sent === true);
  ok('Laporan 2 tercatat terkirim', p2Sent === true);

  // Jalankan lagi — harus skip (sudah terkirim)
  calls.length = 0;
  const r2 = await broadcastPendingPeringatan();
  ok('Re-run: tidak ada kirim ulang', r2.sent === 0, `sent=${r2.sent}`);
}

// ---------- HASIL ----------
console.log(`\n${'─'.repeat(50)}`);
console.log(`📊 Hasil: ${passed} lulus, ${failed} gagal (dari ${passed + failed} test)`);
console.log('─'.repeat(50));

// Cleanup
for (const s of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(process.env.DB_PATH + s); } catch {}
}

process.exit(failed > 0 ? 1 : 0);
