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
  // Migrasi ringan untuk DB lama: tambah kolom yang belum ada (CREATE IF NOT EXISTS tak menambah kolom).
  ensureColumn(_db, 'info_bansos', 'batas_daftar', 'TEXT');
  ensureColumn(_db, 'kb_chunks', 'batas_daftar', 'TEXT');
  return _db;
}

/** Tambah kolom bila belum ada (idempoten) — untuk migrasi skema tanpa kehilangan data. */
function ensureColumn(db, table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// ---------- Grup ----------

export function getGrup(idGrup) {
  return getDb().prepare('SELECT * FROM grup WHERE id_grup = ?').get(idGrup);
}

/** Semua grup yang sudah /start (status_start=1) — target broadcast. */
export function listActiveGrups() {
  return getDb().prepare('SELECT * FROM grup WHERE status_start = 1').all();
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
        (program, ringkasan, syarat, tanggal_penting, batas_daftar, cara_daftar, wilayah_tag, sumber_url, tanggal_ambil)
       VALUES (@program, @ringkasan, @syarat, @tanggal_penting, @batas_daftar, @cara_daftar, @wilayah_tag, @sumber_url, @tanggal_ambil)`,
    )
    .run({
      program: info.program,
      ringkasan: info.ringkasan,
      syarat: JSON.stringify(info.syarat || []),
      tanggal_penting: info.tanggal_penting || null,
      batas_daftar: info.batas_daftar || null,
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

// ---------- broadcast_log (dedup siaran) ----------

/** Apakah info dengan fingerprint ini sudah pernah di-broadcast? */
export function wasBroadcast(fingerprint) {
  return Boolean(getDb().prepare('SELECT 1 FROM broadcast_log WHERE fingerprint = ?').get(fingerprint));
}

/** Catat bahwa sebuah info sudah di-broadcast (idempoten via PK fingerprint). */
export function markBroadcast({ fingerprint, program, wilayahTag, grupCount }) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO broadcast_log (fingerprint, program, wilayah_tag, grup_count, ts)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(fingerprint, program || null, wilayahTag || null, grupCount ?? 0, new Date().toISOString());
}

// ---------- kb_chunks (vector store) ----------

export function insertChunk(c) {
  getDb()
    .prepare(
      `INSERT INTO kb_chunks (info_id, program, content, embedding, dim, sumber_url, wilayah_tag, tanggal_ambil, batas_daftar)
       VALUES (@info_id, @program, @content, @embedding, @dim, @sumber_url, @wilayah_tag, @tanggal_ambil, @batas_daftar)`,
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
      batas_daftar: c.batas_daftar || null,
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
