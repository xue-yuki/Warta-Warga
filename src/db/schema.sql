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
  tanggal_ambil   TEXT NOT NULL,             -- F1.2 WAJIB
  image_id        TEXT,                       -- stable asset id: info_<info_bansos.id>
  image_path      TEXT                        -- PATH poster hasil chatgpt
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

-- Laporan penipuan/hoaks dari warga (Fitur Lapor & Peringatan Dini).
-- NO-PII: TIDAK ada kolom nama/nomor/identitas pelapor. Hanya isi modus + wilayah.
CREATE TABLE IF NOT EXISTS laporan (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  isi_ringkas      TEXT NOT NULL,             -- ringkasan modus, tanpa data pribadi pelapor
  modus_key        TEXT,                       -- label modus singkat untuk clustering (mis. "biaya_pencairan")
  wilayah_tag      TEXT NOT NULL,
  status           TEXT NOT NULL,             -- jelas_penipuan | belum_pasti | bukan_penipuan
  jumlah_serupa    INTEGER NOT NULL DEFAULT 1, -- counter laporan sejenis sewilayah
  status_approval  TEXT NOT NULL DEFAULT 'menunggu', -- menunggu | disetujui | ditolak
  dasar_verifikasi TEXT,                       -- ringkas hasil cek AI (opsional)
  sumber_urls      TEXT,                       -- JSON array URL sumber resmi yang mendukung/menyanggah
  teks_peringatan  TEXT,                       -- teks siap-sebar (boleh diedit pengurus sebelum approve)
  timestamp        TEXT NOT NULL,
  updated_ts       TEXT,
  embedding        TEXT,                        -- JSON float[] (L2-normalized) untuk cosine clustering
  cluster_reason   TEXT                         -- 'modus_key' | 'cosine' | 'similar_text' | NULL (baris baru)
);

-- Jejak peringatan yang sudah disebar (dedup, konsisten dengan pola broadcast_log).
CREATE TABLE IF NOT EXISTS peringatan_terkirim (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  laporan_id   INTEGER REFERENCES laporan(id) ON DELETE CASCADE,
  wilayah_tag  TEXT,
  grup_count   INTEGER,
  timestamp    TEXT NOT NULL
);

-- Pola regex host yang diizinkan Agent 1 (menggantikan data/sources_whitelist.json).
-- Dikelola dinamis via dashboard/website.
CREATE TABLE IF NOT EXISTS sources_whitelist (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,
  aktif   INTEGER NOT NULL DEFAULT 1
);

-- Daftar URL yang dipindai otomatis Agent 1 (menggantikan data/sources.json).
-- Dikelola dinamis via dashboard/website.
CREATE TABLE IF NOT EXISTS sumber_crawl (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  url     TEXT NOT NULL UNIQUE,
  wilayah TEXT,
  crawl   INTEGER NOT NULL DEFAULT 0,
  aktif   INTEGER NOT NULL DEFAULT 1
);

-- Laporan layanan publik / aduan per platform (contoh: LaporGub).
CREATE TABLE IF NOT EXISTS laporan_layanan (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kategori        TEXT NOT NULL,
  deskripsi       TEXT NOT NULL,
  lokasi_detail   TEXT NOT NULL,
  wilayah_tag     TEXT,
  foto_path       TEXT,
  foto_ocr        TEXT,
  portal_target   TEXT NOT NULL DEFAULT 'laporgub',
  status          TEXT NOT NULL DEFAULT 'draft',
  nomor_ticket    TEXT,
  message_id      TEXT,
  session_id      TEXT,
  timestamp       TEXT NOT NULL,
  submitted_at    TEXT,
  last_status_check TEXT,
  last_status_notified_at TEXT,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS laporan_layanan_submit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  laporan_id  INTEGER REFERENCES laporan_layanan(id) ON DELETE CASCADE,
  portal      TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  status      TEXT NOT NULL,
  error_msg   TEXT,
  timestamp   TEXT NOT NULL
);

-- Log interaksi ANONIM — hanya untuk tren kebutuhan, tanpa identitas pribadi
CREATE TABLE IF NOT EXISTS log_interaksi (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  konteks       TEXT,                          -- grup | japri
  jenis         TEXT,                          -- = aksi brain: info|verifikasi|lapor|tanya_balik|ngobrol|tolak
  aksi          TEXT,                          -- aksi brain (eksplisit; jenis dipertahankan utk kompat lama)
  label         TEXT,                          -- verifikasi: bukan_penipuan | belum_pasti | jelas_penipuan
  wilayah_tag   TEXT,
  ringkas_pesan TEXT,                          -- ringkasan maksud warga (NO-PII) utk analytics
  ringkas_resp  TEXT,                          -- ringkasan respons bot (NO-PII)
  timestamp     TEXT NOT NULL
);
