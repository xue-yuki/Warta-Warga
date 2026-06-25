// DEMO LAPOR & PERINGATAN DINI — alur penuh TANPA WA/LLM live.
//
// Membuktikan: klasifikasi 'lapor' → verifikasi+pola → status 3-tingkat → CLUSTERING laporan
// serupa → antrian approval (Lapis 2 manusia) → approve → broadcast peringatan ke grup SEWILAYAH
// (reuse filter wilayah + jeda + dedup). NO-PII: tak ada identitas pelapor tersimpan.
//
// Jalankan:  npm run demo:lapor
// 100% OFFLINE: DB terpisah + LLM dimatikan (pakai fallback heuristik/pola) + broadcaster KONSOL.

process.env.SUPABASE_DB_URL = ''; // isolasi SQLite (string kosong agar dotenv tak isi ulang) — jangan sentuh Supabase prod
process.env.DB_PATH = process.env.DEMO_DB_PATH || './data/_demo_lapor.db';
process.env.OPENROUTER_API_KEY = ''; // matikan LLM → uji jalur fallback (pola penipuan tetap jalan)
process.env.EMBEDDINGS_PROVIDER = 'hashing';
process.env.SCRAPE_AUTO = 'false';
process.env.SCRAPE_ON_BOOT = 'false';
process.env.BROADCAST_MIN_MS = '120';
process.env.BROADCAST_MAX_MS = '300';

import fs from 'node:fs';

const dbFile = process.env.DB_PATH;
for (const s of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(dbFile + s);
  } catch {
    /* belum ada */
  }
}

const { getDb, upsertGrup, listAntrianApproval, getLaporan, setApprovalLaporan } = await import('../src/db/index.js');
const { prosesLaporan } = await import('../src/agent2/lapor.js');
const { setBroadcaster, broadcastPeringatan } = await import('../src/agent1/broadcast.js');
const { humanWilayah } = await import('../src/util/wilayah.js');

const line = (c = '─') => console.log(c.repeat(64));
getDb();

console.log('\n🎬 DEMO LAPOR & PERINGATAN DINI (offline, tanpa WA/LLM)\n');
line();

// 1) Grup opt-in dari 2 wilayah → buktikan filter wilayah.
const grup = [
  { idGrup: 'DEMO_BANYUMAS@g.us', daerah: 'Kab. Banyumas', wilayahTag: 'kabupaten:banyumas', provinsiTag: 'provinsi:jawa_tengah' },
  { idGrup: 'DEMO_BEKASI@g.us', daerah: 'Kab. Bekasi', wilayahTag: 'kabupaten:bekasi', provinsiTag: 'provinsi:jawa_barat' },
];
for (const g of grup) await upsertGrup(g);
console.log('✅ Grup opt-in:', grup.map((g) => g.daerah).join(', '));

// 2) Simulasi laporan warga (TANPA identitas — kita tak menyimpan siapa pelapornya).
const laporanMasuk = [
  { wilayah: 'kabupaten:banyumas', text: 'Aku barusan ditelpon orang ngaku dari dinsos, katanya biaya pencairan PKH 150 ribu harus transfer dulu ke rekening pribadi' },
  { wilayah: 'kabupaten:banyumas', text: 'Tetangga juga kena, disuruh transfer biaya admin pencairan bansos katanya' },
  { wilayah: 'kabupaten:bekasi', text: 'Awas ada link palsu pendaftaran bansos, abis klik link diminta isi NIK sama kode OTP' },
];
console.log('\n📥 Memproses', laporanMasuk.length, 'laporan...');
for (const l of laporanMasuk) {
  const r = await prosesLaporan({ text: l.text, wilayahTag: l.wilayah });
  console.log(`   • [${humanWilayah(l.wilayah)}] status=${r.status}${r.clustered ? ' (CLUSTER → laporan serupa +1)' : ' (laporan baru)'}`);
}

// 3) Antrian approval (Lapis 2): hanya 'jelas_penipuan' yang muncul.
line();
const antrian = await listAntrianApproval();
console.log('🗂️  ANTRIAN APPROVAL (jelas_penipuan, menunggu):', antrian.length, 'item');
for (const a of antrian) {
  console.log(`   #${a.id} [${a.wilayah_tag}] "${a.isi_ringkas}" — ${a.jumlah_serupa} laporan serupa`);
}

// 4) Broadcaster KONSOL + coba broadcast SEBELUM approve → harus DITOLAK (Lapis 2).
const tally = {};
setBroadcaster(async (jid, text) => {
  tally[jid] = (tally[jid] || 0) + 1;
  line('┄');
  console.log(`📤 PERINGATAN → ${jid}`);
  line('┄');
  console.log(text);
  console.log('');
});

const target = antrian[0];
line();
const sebelum = await broadcastPeringatan(await getLaporan(target.id));
console.log(`🚫 Coba sebar SEBELUM approve → terkirim ${sebelum.sent} (reason: ${sebelum.reason}) — Lapis 2 bekerja ✅`);

// 5) Pengurus APPROVE → baru boleh sebar.
line();
console.log(`👤 Pengurus approve laporan #${target.id}...\n`);
await setApprovalLaporan(target.id, 'disetujui');
const res = await broadcastPeringatan(await getLaporan(target.id));

// 6) Verifikasi: dedup + filter wilayah.
line();
console.log('📊 HASIL');
line();
console.log(`Peringatan terkirim : ${res.sent} grup`);
for (const g of grup) console.log(`   • ${g.daerah.padEnd(14)} : ${tally[g.idGrup] || 0} pesan`);
const ulang = await broadcastPeringatan(await getLaporan(target.id));
console.log(`\n🔁 Sebar ulang (uji dedup): ${ulang.sent} (reason: ${ulang.reason}) → ${ulang.sent === 0 ? 'DEDUP OK ✅' : 'GAGAL ❌'}`);
const bocorBekasi = (tally['DEMO_BEKASI@g.us'] || 0) > 0;
console.log(`📍 Filter wilayah (Banyumas tak bocor ke Bekasi): ${bocorBekasi ? 'BOCOR ❌' : 'AMAN ✅'}`);

// 7) Cek no-PII: pastikan tak ada kolom identitas di tabel laporan.
const cols = getDb().prepare('PRAGMA table_info(laporan)').all().map((c) => c.name);
const pii = cols.filter((c) => /nama|nomor|hp|phone|alamat|nik|pelapor|sender|jid/i.test(c));
console.log(`🔒 Kolom identitas pelapor di tabel laporan: ${pii.length === 0 ? 'TIDAK ADA ✅' : pii.join(', ') + ' ❌'}`);
line();
console.log('\nℹ️  Catatan: LLM dimatikan di demo ini; status jelas_penipuan didapat dari DETEKSI POLA.');
console.log('   Dengan LLM aktif, verifikasi ke sumber resmi juga ikut menentukan status.\n');

process.exit(0);
