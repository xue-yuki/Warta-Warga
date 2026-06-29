// Migrasi data SQLite lokal → Supabase (Postgres). Sekali jalan, idempoten (TRUNCATE dulu).
// Prasyarat: SUPABASE_DB_URL diset di .env (connection string pooler dari Supabase Dashboard).
// Jalankan: npm run migrate:supabase
import Database from 'better-sqlite3';
import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, hasSupabase } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!hasSupabase()) {
  console.error('❌ SUPABASE_DB_URL belum diset di .env — tak ada target migrasi.');
  process.exit(1);
}

const lite = new Database(config.dbPath, { readonly: true });
const sql = postgres(config.supabase.dbUrl, { ssl: 'require', prepare: false, max: 4 });

const parseJson = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const rows = (t) => {
  try {
    return lite.prepare(`SELECT * FROM ${t}`).all();
  } catch (err) {
    return [];
  }
};

async function main() {
  console.log(`Sumber: ${config.dbPath} → Supabase Postgres`);

  // Pastikan skema tabel di Supabase terbuat
  const ddlPath = path.join(__dirname, '../src/db/schema.pg.sql');
  if (fs.existsSync(ddlPath)) {
    console.log('Menjalankan DDL skema di Supabase...');
    const ddl = fs.readFileSync(ddlPath, 'utf8');
    await sql.unsafe(ddl);
  }

  // Kosongkan semua untuk migrasi bersih (slate fresh sebelum deploy).
  await sql`TRUNCATE info_bansos, kb_chunks, grup, broadcast_log, laporan, peringatan_terkirim, log_interaksi, sources_whitelist, sumber_crawl RESTART IDENTITY CASCADE`;

  // grup
  let nGrup = 0;
  for (const g of rows('grup')) {
    await sql`INSERT INTO grup (id_grup, daerah, wilayah_tag, provinsi_tag, status_start, tgl_start)
      VALUES (${g.id_grup}, ${g.daerah}, ${g.wilayah_tag}, ${g.provinsi_tag}, ${g.status_start}, ${g.tgl_start})`;
    nGrup++;
  }

  // info_bansos (pertahankan id agar FK kb_chunks.info_id tetap cocok)
  let nInfo = 0;
  for (const i of rows('info_bansos')) {
    await sql`INSERT INTO info_bansos (id, program, ringkasan, syarat, tanggal_penting, batas_daftar, cara_daftar, wilayah_tag, sumber_url, tanggal_ambil, image_id, image_path)
      VALUES (${i.id}, ${i.program}, ${i.ringkasan}, ${sql.json(parseJson(i.syarat) || [])}, ${i.tanggal_penting}, ${i.batas_daftar}, ${i.cara_daftar}, ${i.wilayah_tag}, ${i.sumber_url}, ${i.tanggal_ambil}, ${i.image_id || null}, ${i.image_path || null})`;
    nInfo++;
  }
  // Sinkronkan sequence id setelah insert id eksplisit.
  await sql`SELECT setval(pg_get_serial_sequence('info_bansos','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM info_bansos), 1))`;

  // kb_chunks (embedding TEXT JSON → JSONB)
  let nChunk = 0;
  for (const c of rows('kb_chunks')) {
    await sql`INSERT INTO kb_chunks (info_id, program, content, embedding, dim, sumber_url, wilayah_tag, tanggal_ambil, batas_daftar)
      VALUES (${c.info_id}, ${c.program}, ${c.content}, ${sql.json(parseJson(c.embedding))}, ${c.dim}, ${c.sumber_url}, ${c.wilayah_tag}, ${c.tanggal_ambil}, ${c.batas_daftar})`;
    nChunk++;
  }

  // broadcast_log (dedup history; aman dilewati tapi cegah re-broadcast)
  let nBc = 0;
  for (const b of rows('broadcast_log')) {
    await sql`INSERT INTO broadcast_log (fingerprint, program, wilayah_tag, grup_count, ts)
      VALUES (${b.fingerprint}, ${b.program}, ${b.wilayah_tag}, ${b.grup_count}, ${b.ts}) ON CONFLICT (fingerprint) DO NOTHING`;
    nBc++;
  }

  // laporan
  let nLaporan = 0;
  for (const l of rows('laporan')) {
    await sql`INSERT INTO laporan (id, isi_ringkas, modus_key, wilayah_tag, status, jumlah_serupa, status_approval, dasar_verifikasi, sumber_urls, teks_peringatan, timestamp, updated_ts)
      VALUES (${l.id}, ${l.isi_ringkas}, ${l.modus_key}, ${l.wilayah_tag}, ${l.status}, ${l.jumlah_serupa}, ${l.status_approval}, ${l.dasar_verifikasi}, ${l.sumber_urls || null}, ${l.teks_peringatan}, ${l.timestamp}, ${l.updated_ts || null})`;
    nLaporan++;
  }
  await sql`SELECT setval(pg_get_serial_sequence('laporan','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM laporan), 1))`;

  // peringatan_terkirim
  let nPeringatan = 0;
  for (const p of rows('peringatan_terkirim')) {
    await sql`INSERT INTO peringatan_terkirim (id, laporan_id, wilayah_tag, grup_count, timestamp)
      VALUES (${p.id}, ${p.laporan_id}, ${p.wilayah_tag}, ${p.grup_count}, ${p.timestamp})`;
    nPeringatan++;
  }
  await sql`SELECT setval(pg_get_serial_sequence('peringatan_terkirim','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM peringatan_terkirim), 1))`;

  // sources_whitelist
  let nWhitelist = 0;
  for (const w of rows('sources_whitelist')) {
    await sql`INSERT INTO sources_whitelist (id, pattern, aktif)
      VALUES (${w.id}, ${w.pattern}, ${w.aktif})`;
    nWhitelist++;
  }
  await sql`SELECT setval(pg_get_serial_sequence('sources_whitelist','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM sources_whitelist), 1))`;

  // sumber_crawl
  let nCrawl = 0;
  for (const s of rows('sumber_crawl')) {
    await sql`INSERT INTO sumber_crawl (id, url, wilayah, crawl, aktif)
      VALUES (${s.id}, ${s.url}, ${s.wilayah}, ${s.crawl}, ${s.aktif})`;
    nCrawl++;
  }
  await sql`SELECT setval(pg_get_serial_sequence('sumber_crawl','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM sumber_crawl), 1))`;

  console.log(`✅ Migrasi selesai: ${nInfo} info, ${nChunk} chunk, ${nGrup} grup, ${nBc} broadcast_log, ${nLaporan} laporan, ${nPeringatan} peringatan, ${nWhitelist} whitelist, ${nCrawl} crawl.`);
  console.log('   (log_interaksi sengaja TIDAK dimigrasi — analytics anonim, regenerasi sendiri.)');
  await sql.end();
  lite.close();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('❌ Migrasi gagal:', e.message);
  await sql.end().catch(() => { });
  process.exit(1);
});
