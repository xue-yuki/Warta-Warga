-- Skema DB Warta Warga (Bagian 6.2 PRD)
-- Prinsip: stateless bot, stateful database. Konteks selalu di-fetch dari sini.
-- Privasi: TIDAK ada tabel identitas warga. log_interaksi anonim.

-- Grup WhatsApp yang sudah /start + wilayah-nya
CREATE TABLE IF NOT EXISTS grup (
  id_grup       TEXT PRIMARY KEY,           -- JID grup (@g.us)
  daerah        TEXT,                        -- mis. "Kab. Banyumas"
  wilayah_tag   TEXT,                        -- mis. "kabupaten:banyumas"
  provinsi_tag  TEXT,                        -- mis. "provinsi:jawa_tengah" (untuk filter hierarkis)
  status_start  INTEGER NOT NULL DEFAULT 0,  -- boolean
  tgl_start     TEXT
);

-- Info bansos terstruktur hasil Agent 1
CREATE TABLE IF NOT EXISTS info_bansos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  program         TEXT NOT NULL,
  ringkasan       TEXT NOT NULL,             -- ringkasan_bahasa_sederhana
  syarat          TEXT,                       -- JSON array
  tanggal_penting TEXT,                        -- jadwal/penyaluran (teks, boleh berulang)
  batas_daftar    TEXT,                        -- tenggat pendaftaran eksplisit (untuk cek masa berlaku)
  cara_daftar     TEXT,
  wilayah_tag     TEXT NOT NULL,             -- F1.3 WAJIB
  sumber_url      TEXT NOT NULL,             -- F1.2 WAJIB
  tanggal_ambil   TEXT NOT NULL              -- F1.2 WAJIB
);

-- Vector store (RAG). Local-first: embedding disimpan sebagai JSON float[].
-- Setiap chunk membawa metadata untuk grounding + filter wilayah.
CREATE TABLE IF NOT EXISTS kb_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  info_id       INTEGER REFERENCES info_bansos(id) ON DELETE CASCADE,
  program       TEXT,
  content       TEXT NOT NULL,
  embedding     TEXT NOT NULL,               -- JSON float[]
  dim           INTEGER NOT NULL,
  sumber_url    TEXT NOT NULL,
  wilayah_tag   TEXT NOT NULL,
  tanggal_ambil TEXT NOT NULL,
  batas_daftar  TEXT                          -- tenggat pendaftaran (metadata; tidak di-embed) untuk peringatan masa berlaku
);

-- Jejak broadcast: cegah info yang sama dikirim ulang ke grup (dedup by fingerprint isi,
-- bukan id, karena re-scrape menghapus+menyisipkan ulang baris info → id berubah).
CREATE TABLE IF NOT EXISTS broadcast_log (
  fingerprint TEXT PRIMARY KEY,          -- hash dari program+wilayah+ringkasan+tanggal_penting
  program     TEXT,
  wilayah_tag TEXT,
  grup_count  INTEGER,                   -- berapa grup yang menerima
  ts          TEXT NOT NULL
);

-- Log interaksi ANONIM — hanya untuk tren kebutuhan, tanpa identitas pribadi
CREATE TABLE IF NOT EXISTS log_interaksi (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  konteks     TEXT,                          -- grup | japri
  jenis       TEXT,                          -- info | klaim | lain
  label       TEXT,                          -- klaim: verified | unverified | contradict
  wilayah_tag TEXT,
  timestamp   TEXT NOT NULL
);
