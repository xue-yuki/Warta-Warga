// E2E: alur PENUH Warta Warga → scrape sumber → Agent 1 strukturin via LLM → broadcast
// otomatis ke grup yang cocok wilayah. Aman: pakai DB terpisah + grup CONTOH + broadcaster
// KONSOL (tidak mengirim WhatsApp asli, tidak butuh QR / nomor).
//
// Jalankan:  npm run e2e:broadcast
// Butuh:     API key LLM aktif di .env (DeepSeek/OpenRouter) — kalau credit habis akan 402.
// Opsi env:  E2E_DB_PATH (default ./data/_e2e.db), E2E_KEEP=1 (jangan hapus DB e2e di awal).

// WAJIB diset SEBELUM import apa pun yang menyentuh config (DB_PATH dibaca saat import).
process.env.SUPABASE_DB_URL = ''; // isolasi SQLite (string kosong agar dotenv tak isi ulang) — jangan sentuh Supabase prod
process.env.DB_PATH = process.env.E2E_DB_PATH || './data/_e2e.db';
process.env.SCRAPE_ON_BOOT = 'false'; // kita panggil scrape manual di sini
process.env.SCRAPE_AUTO = 'false';
process.env.BROADCAST_MIN_MS = process.env.BROADCAST_MIN_MS || '200'; // percepat tes (asli 3-8 dtk)
process.env.BROADCAST_MAX_MS = process.env.BROADCAST_MAX_MS || '500';

import fs from 'node:fs';

const dbFile = process.env.DB_PATH;
if (!process.env.E2E_KEEP) {
  for (const s of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbFile + s);
    } catch {
      /* belum ada */
    }
  }
}

// Dynamic import agar process.env di atas pasti sudah terpasang sebelum config dibaca.
const { getDb, upsertGrup, countInfoBansos } = await import('../src/db/index.js');
const { hasLLM, config } = await import('../src/config.js');
const { setBroadcaster } = await import('../src/agent1/broadcast.js');
const { scrapeAllSources } = await import('../src/agent1/scheduler.js');

const line = (c = '─') => console.log(c.repeat(60));

console.log('\n🧪 E2E Warta Warga — scrape → strukturin (LLM) → broadcast\n');
line();
console.log('DB e2e   :', dbFile, '(terpisah dari data produksi)');
console.log('LLM model:', config.openrouter.fastModel, '/', config.openrouter.deepModel);
console.log('LLM base :', config.openrouter.baseUrl);
line();

getDb();

if (!hasLLM()) {
  console.error('\n❌ Belum ada API key LLM. Isi OPENROUTER_API_KEY (+ LLM_BASE_URL untuk DeepSeek) di .env dulu.\n');
  process.exit(1);
}

// 1) Grup CONTOH dari wilayah berbeda → buat ngebuktiin filter wilayah pas broadcast.
const grupContoh = [
  { idGrup: 'E2E_BANYUMAS@g.us', daerah: 'Kab. Banyumas', wilayahTag: 'kabupaten:banyumas', provinsiTag: 'provinsi:jawa_tengah' },
  { idGrup: 'E2E_BOGOR@g.us', daerah: 'Kab. Bogor', wilayahTag: 'kabupaten:bogor', provinsiTag: 'provinsi:jawa_barat' },
];
for (const g of grupContoh) await upsertGrup(g);
console.log(`\n✅ ${grupContoh.length} grup contoh terdaftar (/start):`);
for (const g of grupContoh) console.log(`   • ${g.daerah}  [${g.wilayahTag}]`);

// 2) Broadcaster KONSOL — gantikan WhatsApp asli. Tiap "kiriman" dicetak utuh.
let kiriman = 0;
setBroadcaster(async (jid, text) => {
  kiriman++;
  line('┄');
  console.log(`📤 BROADCAST → ${jid}`);
  line('┄');
  console.log(text);
  console.log('');
});

// 3) Jalankan pipeline penuh: fetch sumber → parse → LLM strukturin → simpan → broadcast.
console.log('\n🔄 Menjalankan scrapeAllSources (fetch → LLM → broadcast)...\n');
const t0 = Date.now();
const r = await scrapeAllSources({ reason: 'e2e' });
const dur = ((Date.now() - t0) / 1000).toFixed(1);

// 4) Ringkasan.
line();
console.log('📊 HASIL E2E');
line();
console.log(`Sumber dipindai  : ${r.total}`);
console.log(`Tersimpan (OK)   : ${r.ok}`);
console.log(`Dilewati (skip)  : ${r.skip}`);
console.log(`Total info di KB : ${await countInfoBansos()}`);
console.log(`Pesan broadcast  : ${kiriman}`);
console.log(`Durasi           : ${dur}s`);

const log = getDb().prepare('SELECT program, wilayah_tag, grup_count FROM broadcast_log ORDER BY ts').all();
if (log.length) {
  console.log('\n📢 Info yang disebar:');
  for (const x of log) console.log(`   • "${x.program}" (${x.wilayah_tag}) → ${x.grup_count} grup`);
} else {
  console.log('\n(Tidak ada info baru yang di-broadcast — cek apakah scrape menghasilkan info & ada grup yang cocok wilayah.)');
}
line();
console.log('\nℹ️  Ini broadcaster KONSOL (tanpa kirim WA asli). Untuk tes WA sungguhan:');
console.log('    npm run bot  →  /start <daerah> di grup  →  npm run scrape (terminal lain).\n');

process.exit(0);
