-- Skema Postgres (Supabase) Warta Warga — mirror schema.sql (SQLite) untuk backend deploy.
-- Catatan: id pakai SERIAL (int4 → balik sbg number di driver), timestamp disimpan sbg TEXT (ISO string)
-- biar shape baris identik dgn SQLite, syarat/embedding sbg JSONB. Idempoten (CREATE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS grup (
  id_grup       TEXT PRIMARY KEY,
  daerah        TEXT,
  wilayah_tag   TEXT,
  provinsi_tag  TEXT,
  status_start  SMALLINT NOT NULL DEFAULT 0,
  tgl_start     TEXT
);

CREATE TABLE IF NOT EXISTS info_bansos (
  id              SERIAL PRIMARY KEY,
  program         TEXT NOT NULL,
  ringkasan       TEXT NOT NULL,
  syarat          JSONB,
  tanggal_penting TEXT,
  batas_daftar    TEXT,
  cara_daftar     TEXT,
  wilayah_tag     TEXT NOT NULL,
  sumber_url      TEXT NOT NULL,
  tanggal_ambil   TEXT NOT NULL,
  image_id        TEXT,
  image_path      TEXT
);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id            SERIAL PRIMARY KEY,
  info_id       INTEGER REFERENCES info_bansos(id) ON DELETE CASCADE,
  program       TEXT,
  content       TEXT NOT NULL,
  embedding     JSONB NOT NULL,
  dim           INTEGER NOT NULL,
  sumber_url    TEXT NOT NULL,
  wilayah_tag   TEXT NOT NULL,
  tanggal_ambil TEXT NOT NULL,
  batas_daftar  TEXT
);

CREATE TABLE IF NOT EXISTS broadcast_log (
  fingerprint TEXT PRIMARY KEY,
  program     TEXT,
  wilayah_tag TEXT,
  grup_count  INTEGER,
  ts          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS laporan (
  id               SERIAL PRIMARY KEY,
  isi_ringkas      TEXT NOT NULL,
  modus_key        TEXT,
  wilayah_tag      TEXT NOT NULL,
  status           TEXT NOT NULL,
  jumlah_serupa    INTEGER NOT NULL DEFAULT 1,
  status_approval  TEXT NOT NULL DEFAULT 'menunggu',
  dasar_verifikasi TEXT,
  sumber_urls      TEXT,
  teks_peringatan  TEXT,
  timestamp        TEXT NOT NULL,
  updated_ts       TEXT,
  embedding        JSONB,                      -- float[] (L2-normalized) untuk cosine clustering
  cluster_reason   TEXT                        -- 'modus_key' | 'cosine' | 'similar_text' | NULL (baris baru)
);

CREATE TABLE IF NOT EXISTS peringatan_terkirim (
  id          SERIAL PRIMARY KEY,
  laporan_id  INTEGER REFERENCES laporan(id) ON DELETE CASCADE,
  wilayah_tag TEXT,
  grup_count  INTEGER,
  timestamp   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources_whitelist (
  id      SERIAL PRIMARY KEY,
  pattern TEXT NOT NULL UNIQUE,
  aktif   SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sumber_crawl (
  id      SERIAL PRIMARY KEY,
  url     TEXT NOT NULL UNIQUE,
  wilayah TEXT,
  crawl   SMALLINT NOT NULL DEFAULT 0,
  aktif   SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS laporan_layanan (
  id               SERIAL PRIMARY KEY,
  kategori         TEXT NOT NULL,
  deskripsi        TEXT NOT NULL,
  lokasi_detail    TEXT NOT NULL,
  wilayah_tag      TEXT,
  foto_path        TEXT,
  foto_ocr         TEXT,
  portal_target    TEXT NOT NULL DEFAULT 'laporgub',
  status           TEXT NOT NULL DEFAULT 'draft',
  nomor_ticket     TEXT,
  message_id       TEXT,
  session_id       TEXT,
  timestamp        TEXT NOT NULL,
  submitted_at     TEXT,
  last_status_check TEXT,
  last_status_notified_at TEXT,
  notes            TEXT
);

CREATE TABLE IF NOT EXISTS laporan_layanan_submit_log (
  id          SERIAL PRIMARY KEY,
  laporan_id  INTEGER REFERENCES laporan_layanan(id) ON DELETE CASCADE,
  portal      TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  error_msg   TEXT,
  timestamp   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS log_interaksi (
  id            SERIAL PRIMARY KEY,
  konteks       TEXT,
  jenis         TEXT,
  aksi          TEXT,
  label         TEXT,
  wilayah_tag   TEXT,
  ringkas_pesan TEXT,
  ringkas_resp  TEXT,
  timestamp     TEXT NOT NULL
);
