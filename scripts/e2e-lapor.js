// E2E LAPOR — integrasi dengan LLM AKTIF (DeepSeek/OpenRouter).
// Tujuan: pastikan dengan LLM nyala, STATUS laporan keluar benar (verifikasi sumber + pola).
// Aman: DB terpisah + grup CONTOH + broadcaster KONSOL (tak kirim WA asli).
//
// Jalankan:  npm run e2e:lapor   (butuh OPENROUTER_API_KEY di .env)

process.env.SUPABASE_DB_URL = ''; // isolasi: tes selalu di SQLite lokal, JANGAN sentuh Supabase prod (string kosong, bukan delete, agar dotenv tak isi ulang)
process.env.DB_PATH = process.env.E2E_DB_PATH || './data/_e2e_lapor.db';
process.env.EMBEDDINGS_PROVIDER = process.env.EMBEDDINGS_PROVIDER || 'hashing'; // offline embeddings; LLM tetap aktif
process.env.SCRAPE_AUTO = 'false';
process.env.SCRAPE_ON_BOOT = 'false';
process.env.BROADCAST_MIN_MS = '120';
process.env.BROADCAST_MAX_MS = '300';

import fs from 'node:fs';
import path from 'node:path';

const dbFile = process.env.DB_PATH;
for (const s of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(dbFile + s);
  } catch {
    /* belum ada */
  }
}

const { ROOT, hasLLM, config } = await import('../src/config.js');
const { getDb, resetKnowledge, upsertGrup, listAntrianApproval, getLaporan, setApprovalLaporan } = await import('../src/db/index.js');
const { storeStructured } = await import('../src/agent1/index.js');
const { prosesLaporan } = await import('../src/agent2/lapor.js');
const { setBroadcaster, broadcastPeringatan } = await import('../src/agent1/broadcast.js');
const { humanWilayah } = await import('../src/util/wilayah.js');

const line = (c = '─') => console.log(c.repeat(64));
getDb();

console.log('\n🧪 E2E LAPOR — LLM AKTIF (status harus keluar benar)\n');
line();
console.log('DB e2e   :', dbFile);
console.log('LLM      :', hasLLM() ? `${config.openrouter.fastModel} @ ${config.openrouter.baseUrl}` : 'TIDAK aktif');
line();
if (!hasLLM()) {
  console.error('\n❌ OPENROUTER_API_KEY belum diset. Isi .env dulu.\n');
  process.exit(1);
}

// 1) Seed KB nasional (agar verifikasi sumber punya bahan) — dari data sintetis, tanpa LLM.
await resetKnowledge();
const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'synthetic', 'info_bansos.json'), 'utf8'));
for (const it of items.filter((x) => x.wilayah_tag === 'nasional')) await storeStructured(it);
console.log('🌱 KB seed (nasional) siap untuk verifikasi.');

// 2) Grup opt-in.
await upsertGrup({ idGrup: 'E2E_BANYUMAS@g.us', daerah: 'Kab. Banyumas', wilayahTag: 'kabupaten:banyumas', provinsiTag: 'provinsi:jawa_tengah' });

// 3) Laporan uji + status yang DIHARAPKAN.
const kasus = [
  // bansos
  { text: 'Aku ditelpon orang ngaku dari dinsos, katanya biaya pencairan PKH 150 ribu harus transfer dulu ke rekening pribadi', expect: 'jelas_penipuan', wilayah: 'kabupaten:banyumas' },
  { text: 'Awas ada link pendaftaran bansos, abis diklik diminta isi NIK sama kode OTP', expect: 'jelas_penipuan', wilayah: 'kabupaten:banyumas' },
  // penipuan UMUM (bukan bansos) — harus tetap ketangkep
  { text: 'Ada yang nelpon ngaku dari kantor pajak, minta saya transfer denda pajak ke rekening pribadi', expect: 'jelas_penipuan', wilayah: 'kabupaten:banyumas' },
  { text: 'Dapat WA katanya menang undian mobil dari Shopee, disuruh klik link buat klaim hadiah', expect: 'jelas_penipuan', wilayah: 'kabupaten:banyumas' },
  { text: 'Ditawari kerja online gaji gede tapi disuruh bayar biaya pendaftaran sama beli seragam dulu', expect: 'jelas_penipuan', wilayah: 'kabupaten:banyumas' },
  // modus BARU tanpa pola kata kunci → fallback reasoning LLM → belum_pasti (jangan ditolak)
  { text: 'Ada orang asing keliling ngaku relawan, nyatetin data keluarga satu RT, gerak-geriknya aneh', expect: 'belum_pasti', wilayah: 'kabupaten:banyumas' },
  // ternyata program asli → bukan_penipuan
  { text: 'Katanya bansos sembako Rp200 ribu sebulan dibelanjakan di e-warong pakai Kartu Keluarga Sejahtera, itu beneran kan?', expect: 'bukan_penipuan', wilayah: 'kabupaten:banyumas' },
];

console.log('\n📥 Memproses laporan (LLM aktif)...\n');
let lolos = 0;
for (const k of kasus) {
  const r = await prosesLaporan({ text: k.text, wilayahTag: k.wilayah });
  const ok = r.status === k.expect;
  if (ok) lolos++;
  console.log(`${ok ? '✅' : '❌'} status=${r.status.padEnd(15)} (harap ${k.expect})`);
  console.log(`   modus_key=${r.laporan.modus_key || '-'} | "${(r.laporan.isi_ringkas || '').slice(0, 80)}"`);
}
line();
console.log(`Status benar: ${lolos}/${kasus.length}`);

// 4) Antrian → approve satu → broadcast.
const antrian = await listAntrianApproval();
console.log(`\n🗂️  Antrian approval (jelas_penipuan): ${antrian.length} item`);
let kirim = 0;
setBroadcaster(async (jid, text) => {
  kirim++;
  line('┄');
  console.log(`📤 PERINGATAN → ${jid}\n${text}`);
});
if (antrian.length) {
  const a = antrian[0];
  console.log(`\n👤 Approve #${a.id} lalu broadcast...\n`);
  await setApprovalLaporan(a.id, 'disetujui');
  const res = await broadcastPeringatan(await getLaporan(a.id));
  line();
  console.log(`Peringatan terkirim: ${res.sent} grup | dedup ulang: ${(await broadcastPeringatan(await getLaporan(a.id))).sent}`);
}
line();
console.log('\nℹ️  Verifikasi: jelas_penipuan dari pola/contradict, belum_pasti dari unverified tanpa pola,');
console.log('   bukan_penipuan dari klaim yang COCOK sumber resmi (verified).\n');
process.exit(0);
