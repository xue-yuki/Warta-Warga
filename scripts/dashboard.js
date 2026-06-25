// PREVIEW dashboard pengurus tanpa WhatsApp — buat lihat & uji alur approve di browser.
// Pakai DB demo (_demo_lapor.db) + broadcaster KONSOL (approve → peringatan dicetak ke terminal).
// Jalankan:  npm run dashboard:demo  → buka http://127.0.0.1:3210
//
// Untuk PRODUKSI (kirim WA beneran), dashboard sudah otomatis nyala saat `npm run bot`.

process.env.SUPABASE_DB_URL = ''; // isolasi SQLite (string kosong agar dotenv tak isi ulang) — preview pakai DB demo lokal
process.env.DB_PATH = process.env.DB_PATH || './data/_demo_lapor.db';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
process.env.EMBEDDINGS_PROVIDER = process.env.EMBEDDINGS_PROVIDER || 'hashing';

const { getDb, upsertGrup, listAntrianApproval } = await import('../src/db/index.js');
const { prosesLaporan } = await import('../src/agent2/lapor.js');
const { setBroadcaster } = await import('../src/agent1/broadcast.js');
const { startDashboard } = await import('../src/dashboard/server.js');

getDb();

// Broadcaster KONSOL → approve di browser akan mencetak peringatan ke terminal ini.
setBroadcaster(async (jid, text) => {
  console.log(`\n📤 PERINGATAN → ${jid}\n${'┄'.repeat(50)}\n${text}\n`);
});

// Kalau antrian kosong, seed beberapa laporan contoh biar ada yang ditinjau.
if ((await listAntrianApproval()).length === 0) {
  for (const g of [
    { idGrup: 'DEMO_BANYUMAS@g.us', daerah: 'Kab. Banyumas', wilayahTag: 'kabupaten:banyumas', provinsiTag: 'provinsi:jawa_tengah' },
    { idGrup: 'DEMO_BEKASI@g.us', daerah: 'Kab. Bekasi', wilayahTag: 'kabupaten:bekasi', provinsiTag: 'provinsi:jawa_barat' },
  ]) await upsertGrup(g);
  await prosesLaporan({ text: 'Ditelpon ngaku dinsos, biaya pencairan PKH 150rb harus transfer dulu', wilayahTag: 'kabupaten:banyumas' });
  await prosesLaporan({ text: 'Ada link palsu pendaftaran bansos, diminta isi NIK dan OTP', wilayahTag: 'kabupaten:bekasi' });
  console.log('🌱 Seed laporan contoh dibuat (antrian tadinya kosong).');
}

startDashboard();
console.log('Broadcaster: KONSOL (approve akan mencetak peringatan di terminal ini).');
