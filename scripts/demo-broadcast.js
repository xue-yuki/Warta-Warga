// DEMO BROADCAST — alur PENUH sampai broadcast, TANPA LLM & TANPA scrape live.
//
// Caranya: alih-alih scrape situs lalu strukturin via LLM (langkah yang butuh credit),
// kita SEED data bansos yang SUDAH terstruktur (data/synthetic/info_bansos.json) langsung
// lewat storeStructured → simpan + index embedding LOKAL → lalu broadcastNewInfos.
//
// Jalankan:  npm run demo:broadcast
// 100% OFFLINE: DB terpisah (./data/_demo.db) + embeddings 'hashing' (tanpa download) +
// broadcaster KONSOL (tidak mengirim WhatsApp asli, tidak perlu QR/nomor).
//
// >>> Bagian yang TETAP butuh LLM (DITANDAI, TIDAK dipakai di demo ini):
//     - structureContent() : ubah HTML mentah sumber → JSON terstruktur (hanya saat scrape live).
//       Di demo, langkah ini DILEWATI karena datanya sudah terstruktur (synthetic).
//     Selain itu (simpan, index, filter wilayah, dedup, format, broadcast) TIDAK butuh LLM.

// Diset SEBELUM import apa pun (config membaca env saat di-import).
process.env.SUPABASE_DB_URL = ''; // isolasi SQLite (string kosong agar dotenv tak isi ulang) — jangan sentuh Supabase prod
process.env.DB_PATH = process.env.DEMO_DB_PATH || './data/_demo.db';
process.env.EMBEDDINGS_PROVIDER = process.env.EMBEDDINGS_PROVIDER || 'hashing'; // offline, instan
process.env.SCRAPE_AUTO = 'false';
process.env.SCRAPE_ON_BOOT = 'false';
process.env.BROADCAST_MIN_MS = process.env.BROADCAST_MIN_MS || '150'; // percepat demo (asli 3-8 dtk)
process.env.BROADCAST_MAX_MS = process.env.BROADCAST_MAX_MS || '400';

import fs from 'node:fs';
import path from 'node:path';

const dbFile = process.env.DB_PATH;
if (!process.env.DEMO_KEEP) {
  for (const s of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbFile + s);
    } catch {
      /* belum ada */
    }
  }
}

const { ROOT } = await import('../src/config.js');
const { getDb, initDb, resetKnowledge, upsertGrup, countInfoBansos, countChunks } = await import('../src/db/index.js');
const { storeStructured } = await import('../src/agent1/index.js');
const { setBroadcaster, broadcastNewInfos } = await import('../src/agent1/broadcast.js');

const line = (c = '─') => console.log(c.repeat(64));

console.log('\n🎬 DEMO BROADCAST — seed terstruktur → simpan → broadcast (TANPA LLM/scrape)\n');
line();
console.log('DB demo     :', dbFile, '(terpisah dari produksi)');
console.log('Embeddings  : hashing (offline, tanpa download)');
console.log('Broadcaster : KONSOL (tanpa kirim WA asli)');
line();

await initDb();
await resetKnowledge();

// 1) Grup CONTOH dari wilayah berbeda → buktikan filter wilayah §6.3.
const grupContoh = [
  { idGrup: 'DEMO_BANYUMAS@g.us', daerah: 'Kab. Banyumas', wilayahTag: 'kabupaten:banyumas', provinsiTag: 'provinsi:jawa_tengah' },
  { idGrup: 'DEMO_BOGOR@g.us', daerah: 'Kab. Bogor', wilayahTag: 'kabupaten:bogor', provinsiTag: 'provinsi:jawa_barat' },
];
for (const g of grupContoh) await upsertGrup(g);
console.log('\n✅ Grup contoh terdaftar (/start):');
for (const g of grupContoh) console.log(`   • ${g.daerah}  [${g.wilayahTag}]`);

// 2) SEED info terstruktur (PENGGANTI langkah scrape+LLM). storeStructured tidak butuh OpenRouter.
const file = path.join(ROOT, 'data', 'synthetic', 'info_bansos.json');
const items = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`\n🌱 Seed ${items.length} info terstruktur (tanpa LLM)...`);
const records = [];
for (const it of items) {
  const r = await storeStructured(it);
  if (r.ok && r.record) {
    records.push(r.record);
    console.log(`   OK  ${r.record.program}  [${r.record.wilayah_tag}]`);
  } else {
    console.warn(`   SKIP ${it.program}: ${r.error}`);
  }
}
console.log(`KB sekarang: ${await countInfoBansos()} info, ${await countChunks()} chunk.`);

// 3) Broadcaster KONSOL + penghitung per-grup → tunjukkan filter wilayah bekerja.
const tally = {};
setBroadcaster(async (jid, text, imagePath = null) => {
  tally[jid] = (tally[jid] || 0) + 1;
  line('┄');
  console.log(`📤 BROADCAST → ${jid}`);
  if (imagePath) {
    console.log(`🖼️ [IMAGE ATTACHED]: ${imagePath}`);
  }
  line('┄');
  console.log(text);
  console.log('');
});

// 4) Sebar semua info baru (dedup + filter wilayah otomatis di dalam).
console.log('\n📢 Menyebar info ke grup yang cocok wilayah...\n');
const res = await broadcastNewInfos(records);

// 5) Ringkasan + verifikasi filter wilayah.
line();
console.log('📊 HASIL DEMO');
line();
console.log(`Info di-broadcast : ${res.infos}`);
console.log(`Total pesan kirim : ${res.sent}`);
console.log('\nPesan per grup:');
for (const g of grupContoh) console.log(`   • ${g.daerah.padEnd(14)} : ${tally[g.idGrup] || 0} pesan`);

const logRows = getDb().prepare('SELECT program, wilayah_tag, grup_count FROM broadcast_log ORDER BY ts').all();
console.log('\nRincian info yang disebar:');
for (const x of logRows) console.log(`   • "${x.program}" (${x.wilayah_tag}) → ${x.grup_count} grup`);

// 6) Tes DEDUP: jalankan lagi → harus 0 (tidak menyepam ulang).
const again = await broadcastNewInfos(records);
line();
console.log(`🔁 Broadcast ulang (uji dedup): ${again.sent} pesan → ${again.sent === 0 ? 'DEDUP OK ✅ (tidak menyepam)' : 'GAGAL ❌'}`);

// Verifikasi wilayah: Banyumas TIDAK boleh dapat info Bogor & sebaliknya.
const okFilter =
  logRows.every((x) => {
    if (x.wilayah_tag === 'kabupaten:banyumas') return x.grup_count === 1;
    if (x.wilayah_tag === 'kabupaten:bogor') return x.grup_count === 1;
    if (x.wilayah_tag === 'nasional') return x.grup_count === grupContoh.length;
    return true;
  });
console.log(`📍 Filter wilayah benar (daerah A tak bocor ke daerah B): ${okFilter ? 'YA ✅' : 'TIDAK ❌'}`);
line();
console.log('\nℹ️  TANDA: satu-satunya langkah yang butuh LLM di alur asli adalah structureContent()');
console.log('   (ubah HTML sumber → JSON). Demo ini melewatinya dgn data terstruktur. Sisanya nyata.\n');

process.exit(0);
