import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db = null;

/** Ambil koneksi DB (singleton). Membuat file + skema bila belum ada. */
export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);
  return _db;
}

// ---------- Grup ----------

export function getGrup(idGrup) {
  return getDb().prepare('SELECT * FROM grup WHERE id_grup = ?').get(idGrup);
}

export function upsertGrup({ idGrup, daerah, wilayahTag, provinsiTag }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO grup (id_grup, daerah, wilayah_tag, provinsi_tag, status_start, tgl_start)
     VALUES (@idGrup, @daerah, @wilayahTag, @provinsiTag, 1, @ts)
     ON CONFLICT(id_grup) DO UPDATE SET
       daerah = excluded.daerah,
       wilayah_tag = excluded.wilayah_tag,
       provinsi_tag = excluded.provinsi_tag,
       status_start = 1,
       tgl_start = excluded.tgl_start`,
  ).run({ idGrup, daerah, wilayahTag, provinsiTag: provinsiTag || null, ts: new Date().toISOString() });
  return getGrup(idGrup);
}

// ---------- info_bansos ----------

export function insertInfoBansos(info) {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO info_bansos
        (program, ringkasan, syarat, tanggal_penting, cara_daftar, wilayah_tag, sumber_url, tanggal_ambil)
       VALUES (@program, @ringkasan, @syarat, @tanggal_penting, @cara_daftar, @wilayah_tag, @sumber_url, @tanggal_ambil)`,
    )
    .run({
      program: info.program,
      ringkasan: info.ringkasan,
      syarat: JSON.stringify(info.syarat || []),
      tanggal_penting: info.tanggal_penting || null,
      cara_daftar: info.cara_daftar || null,
      wilayah_tag: info.wilayah_tag,
      sumber_url: info.sumber_url,
      tanggal_ambil: info.tanggal_ambil,
    });
  return res.lastInsertRowid;
}

export function countInfoBansos() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM info_bansos').get().n;
}

/** Berapa entri info untuk wilayah tertentu (untuk cek apakah daerah sudah tercakup). */
export function countInfoByWilayah(wilayahTag) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM info_bansos WHERE wilayah_tag = ?').get(wilayahTag).n;
}

/**
 * Hapus info (+chunk via cascade) dari satu sumber_url.
 * Dipakai auto-scrape agar re-scrape me-REFRESH, bukan menumpuk duplikat.
 * @returns {number} jumlah baris info_bansos yang dihapus
 */
export function deleteInfoBySource(sumberUrl) {
  const db = getDb();
  // kb_chunks tidak selalu ter-cascade (info_id lama) → bersihkan eksplisit by sumber_url juga.
  db.prepare('DELETE FROM kb_chunks WHERE sumber_url = ?').run(sumberUrl);
  return db.prepare('DELETE FROM info_bansos WHERE sumber_url = ?').run(sumberUrl).changes;
}

// ---------- kb_chunks (vector store) ----------

export function insertChunk(c) {
  getDb()
    .prepare(
      `INSERT INTO kb_chunks (info_id, program, content, embedding, dim, sumber_url, wilayah_tag, tanggal_ambil)
       VALUES (@info_id, @program, @content, @embedding, @dim, @sumber_url, @wilayah_tag, @tanggal_ambil)`,
    )
    .run({
      info_id: c.info_id,
      program: c.program,
      content: c.content,
      embedding: JSON.stringify(c.embedding),
      dim: c.embedding.length,
      sumber_url: c.sumber_url,
      wilayah_tag: c.wilayah_tag,
      tanggal_ambil: c.tanggal_ambil,
    });
}

export function allChunks() {
  return getDb()
    .prepare('SELECT * FROM kb_chunks')
    .all()
    .map((r) => ({ ...r, embedding: JSON.parse(r.embedding) }));
}

export function countChunks() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM kb_chunks').get().n;
}

// ---------- log_interaksi (anonim) ----------

export function logInteraksi({ konteks, jenis, label, wilayahTag }) {
  getDb()
    .prepare(
      `INSERT INTO log_interaksi (konteks, jenis, label, wilayah_tag, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(konteks || null, jenis || null, label || null, wilayahTag || null, new Date().toISOString());
}

export function resetKnowledge() {
  const db = getDb();
  db.exec('DELETE FROM kb_chunks; DELETE FROM info_bansos;');
}
